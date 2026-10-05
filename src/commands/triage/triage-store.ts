import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync, withPlanLock, writeJsonAtomicSync } from '../../core/lock-manager.js';
import { escalationPath, loadEscalationFile } from '../../governor/store.js';
import type { CandidatePatch, SelfHealingEscalationRecord } from '../../governor/circuit-breaker.js';
import type {
  HumanDecisionCard,
  TriageClassification,
  TriageEvaluation,
  TriageSource,
} from '../../core/tier1-liaison.js';

export const ESCALATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Latest Tier 1 verdict, stored on the escalation so Studio and the architect can show it after a reload. */
export interface TriageSnapshot {
  evaluatedAt: string;
  provider: string;
  model: string;
  source: TriageSource;
  latencyMs: number;
  classification: TriageClassification;
  reasoning: string;
  autoPatchApplied: boolean;
  unblockedTaskId: string | null;
  guardrails: string[];
  resolution?: { summary: string; patch: CandidatePatch; proofPassed: boolean; proposalId?: string };
  humanCard?: HumanDecisionCard;
}

/** The product owner's pick from a decision card. Acting on it stays with the approve/reject gate. */
export interface HumanDecision {
  optionId: string;
  label: string;
  outcome?: string;
  instructions?: string;
  decidedAt: string;
  decidedVia: 'cli';
}

export type TriagedEscalationRecord = SelfHealingEscalationRecord & {
  triage?: TriageSnapshot;
  humanDecision?: HumanDecision;
};

export interface TriageFinalization {
  taskId: string | null;
  unblockedTaskId: string | null;
  persisted: boolean;
}

export function mutateEscalation(root: string, escalationId: string, mutate: (record: TriagedEscalationRecord) => void): boolean {
  const file = escalationPath(root);
  return withFileLockSync(file, () => {
    const data = loadEscalationFile(root, path.basename(root));
    const record = data.escalations.find((e) => e?.id === escalationId) as TriagedEscalationRecord | undefined;
    if (!record) return false;
    mutate(record);
    data.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(file, data);
    return true;
  });
}

/** Moves a blocked task back to pending so it can be dispatched again. False when it was not blocked. */
export async function unblockTask(root: string, taskId: string, note: string): Promise<boolean> {
  const planPath = path.join(root, '.ai', 'master_plan.json');
  if (!fs.existsSync(planPath)) return false;
  const result = await withPlanLock(planPath, (plan, ctx) => {
    const task = plan.milestones.flatMap((m) => m.tasks ?? []).find((t) => t.id === taskId);
    if (!task || task.status !== 'blocked') {
      ctx.abort();
      return false;
    }
    task.status = 'pending';
    task.notes = note;
    return true;
  });
  return result === true;
}

/**
 * Only pending escalations may be triaged: re-running a resolved one could re-apply its proposal.
 * Returns an error message, or null when the escalation can be evaluated.
 */
export function triageBlocker(root: string, escalationId: string): string | null {
  const record = loadEscalationFile(root, path.basename(root)).escalations.find((e) => e?.id === escalationId);
  if (!record) return `Escalation "${escalationId}" not found in .ai/escalation.json`;
  if (record.status !== 'pending_review') return `Escalation "${escalationId}" is already ${record.status}`;
  return null;
}

/**
 * After an evaluation: unblocks the task and closes the escalation when a patch was auto-applied,
 * then stores the verdict on the escalation. Never throws; a bookkeeping failure must not hide an
 * applied patch.
 */
export async function finalizeTriage(root: string, evaluation: TriageEvaluation): Promise<TriageFinalization> {
  let taskId: string | null = null;
  let unblockedTaskId: string | null = null;
  let persisted = false;
  try {
    taskId = loadEscalationFile(root, path.basename(root)).escalations.find((e) => e?.id === evaluation.escalationId)?.taskId ?? null;
    if (evaluation.autoPatchApplied && taskId) {
      const reason = evaluation.resolution?.summary ?? 'contract patch applied';
      if (await unblockTask(root, taskId, `Unblocked by Tier 1 auto-resolution of ${evaluation.escalationId}: ${reason}`)) {
        unblockedTaskId = taskId;
      }
    }
    const snapshot: TriageSnapshot = {
      evaluatedAt: new Date().toISOString(),
      provider: evaluation.provider,
      model: evaluation.model,
      source: evaluation.source,
      latencyMs: evaluation.latencyMs,
      classification: evaluation.classification,
      reasoning: evaluation.reasoning,
      autoPatchApplied: evaluation.autoPatchApplied,
      unblockedTaskId,
      guardrails: evaluation.guardrails,
      ...(evaluation.resolution
        ? {
            resolution: {
              summary: evaluation.resolution.summary,
              patch: evaluation.resolution.patch,
              proofPassed: evaluation.resolution.proof.passed,
              ...(evaluation.resolution.proposalId ? { proposalId: evaluation.resolution.proposalId } : {}),
            },
          }
        : {}),
      ...(evaluation.humanCard ? { humanCard: evaluation.humanCard } : {}),
    };
    persisted = mutateEscalation(root, evaluation.escalationId, (record) => {
      record.triage = snapshot;
      if (evaluation.autoPatchApplied && record.status === 'pending_review') {
        const closed = record as TriagedEscalationRecord & { resolvedAt?: string; resolution?: unknown };
        closed.status = 'resolved';
        closed.resolutionNotes = `Auto-resolved by Tier 1 (${evaluation.model}): ${evaluation.resolution?.summary ?? 'contract patch applied'}`;
        closed.resolvedAt = snapshot.evaluatedAt;
        closed.resolution = { decision: 'approve', proposalApplied: true, ruleId: 'TIER1_AUTO_RESOLVED', unblockedTaskId };
      }
    });
  } catch {
    // Reported through `persisted: false`.
  }
  return { taskId, unblockedTaskId, persisted };
}

export function recordHumanDecision(root: string, escalationId: string, decision: HumanDecision): boolean {
  return mutateEscalation(root, escalationId, (record) => {
    record.humanDecision = decision;
  });
}
