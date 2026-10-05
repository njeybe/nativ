import fs from 'node:fs';
import path from 'node:path';
import { withFileLock, withPlanLock } from '../../core/lock-manager.js';
import {
  CircuitBreaker,
  applySelfHealingProposal,
  type ProposalApplication,
  type SelfHealingEscalationRecord,
} from '../../governor/index.js';
import { finalizeTriage, triageBlocker, type TriagedEscalationRecord } from '../../commands/triage.js';
import { Tier1Liaison, type TriageEvaluation } from '../../core/tier1-liaison.js';
import type { EscalationFile } from '../../scanner/types.js';
import { HttpError } from '../http-utils.js';
import { AI_DIR, TASK_ID_PATTERN, findTask } from '../plan-utils.js';

export const ESCALATION_FILTERS = ['all', 'pending_review', 'resolved'] as const;
export type EscalationFilter = (typeof ESCALATION_FILTERS)[number];
const MAX_REASON_LENGTH = 1000;

/** Escalation records as the resolve endpoint leaves them. */
export interface ResolvedEscalationRecord extends SelfHealingEscalationRecord {
  resolvedAt?: string;
  resolution?: {
    decision: 'approve' | 'reject';
    proposalApplied: boolean;
    ruleId: string | null;
    unblockedTaskId: string | null;
  };
}

export function escalationFilePath(root: string): string {
  return path.join(root, AI_DIR, 'escalation.json');
}

/** Null when no escalation has ever been filed. */
export function readEscalationFile(root: string): EscalationFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(escalationFilePath(root), 'utf8');
  } catch {
    return null;
  }
  // withFileLock creates the file empty when it takes the first lock.
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as EscalationFile;
    if (!Array.isArray(parsed?.escalations)) parsed.escalations = [];
    return parsed;
  } catch {
    throw new HttpError(500, 'ESCALATION_FILE_CORRUPT', '.ai/escalation.json is not valid JSON');
  }
}

/** tmp-file + rename so the SSE watcher and concurrent readers never observe a half-written file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY')) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/** Moves a blocked task back to pending so it can be dispatched again. False when it was not blocked. */
export async function unblockTask(root: string, taskId: string, note: string): Promise<boolean> {
  const planPath = path.join(root, AI_DIR, 'master_plan.json');
  if (!fs.existsSync(planPath)) return false;
  const result = await withPlanLock(planPath, (plan, ctx) => {
    const task = findTask(plan, taskId);
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

/** Test restorations run where the task's files live: its agent worktree if one exists, else the project. */
export function taskWorkspace(root: string, taskId: string): string {
  const worktree = path.join(root, '.worktrees', `task-${taskId}`);
  return fs.existsSync(path.join(worktree, '.git')) ? worktree : root;
}

/**
 * GET /api/pipeline/escalations?status=pending_review|resolved|all: escalations newest first, each
 * with its optional self-healing `proposedPatch`. `resolved` covers every closed record (approved or rejected).
 */
export function handleEscalations(root: string, searchParams: URLSearchParams) {
  const rawFilter = searchParams.get('status') || 'all';
  if (!(ESCALATION_FILTERS as readonly string[]).includes(rawFilter)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"status" must be one of: ${ESCALATION_FILTERS.join(', ')}`);
  }
  const filter = rawFilter as EscalationFilter;
  const escalations = (readEscalationFile(root)?.escalations ?? [])
    .filter((e) => e && typeof e.id === 'string')
    .filter((e) => filter === 'all' || (filter === 'pending_review' ? e.status === 'pending_review' : e.status !== 'pending_review'))
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  return { ok: true, escalations };
}

/**
 * POST /api/pipeline/escalations/resolve: `approve` applies the self-healing proposal (re-checked
 * against the live contract), resets the circuit breaker and unblocks the task; `reject` dismisses
 * the escalation and leaves the task blocked. A proposal that no longer applies leaves the
 * escalation pending and returns 400.
 */
export async function handleEscalationResolve(root: string, body: Record<string, unknown>) {
  const escalationId = typeof body.escalationId === 'string' ? body.escalationId.trim() : '';
  if (!TASK_ID_PATTERN.test(escalationId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"escalationId" must be an escalation id such as esc-01');
  }
  const { decision } = body;
  if (decision !== 'approve' && decision !== 'reject') {
    throw new HttpError(400, 'VALIDATION_ERROR', `"decision" must be 'approve' or 'reject'`);
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"notes" must be a string');
  }
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"notes" must be at most ${MAX_REASON_LENGTH} characters`);
  }

  const file = escalationFilePath(root);
  if (!readEscalationFile(root)) throw new HttpError(400, 'ESCALATION_NOT_FOUND', `Escalation "${escalationId}" not found`);

  // One resolution at a time per project: a double-click must not apply a proposal twice.
  return withFileLock(file, async () => {
    const data = readEscalationFile(root);
    const record = data?.escalations.find((e) => e?.id === escalationId) as ResolvedEscalationRecord | undefined;
    if (!data || !record) throw new HttpError(400, 'ESCALATION_NOT_FOUND', `Escalation "${escalationId}" not found`);
    if (record.status !== 'pending_review') {
      throw new HttpError(400, 'ESCALATION_ALREADY_RESOLVED', `Escalation "${escalationId}" is already ${record.status}`);
    }

    const proposal = record.proposedPatch;
    const now = new Date().toISOString();
    let applied: ProposalApplication | null = null;
    let unblockedTaskId: string | null = null;
    let message: string;

    if (decision === 'approve') {
      if (proposal) {
        const workspace = proposal.kind === 'restore_tests' ? taskWorkspace(root, record.taskId) : root;
        applied = applySelfHealingProposal(workspace, record.taskId, proposal);
        if (!applied.applied) {
          throw new HttpError(400, applied.ruleId, `Proposal ${proposal.proposalId} was not applied: ${applied.message}`);
        }
      } else {
        CircuitBreaker.recordSuccess(root, record.taskId);
      }
      const unblocked = await unblockTask(root, record.taskId, `Unblocked by escalation ${escalationId}${notes ? `: ${notes}` : ''}`);
      unblockedTaskId = unblocked ? record.taskId : null;
      record.status = 'resolved';
      record.resolutionNotes = notes || applied?.message || 'Approved by operator';
      message = [
        applied ? `${applied.message}.` : `Escalation ${escalationId} approved.`,
        unblocked ? `Task ${record.taskId} is unblocked and pending.` : `Task ${record.taskId} was not blocked.`,
      ].join(' ');
    } else {
      record.status = 'dismissed';
      record.resolutionNotes = notes || (proposal ? `Proposal ${proposal.proposalId} rejected by operator` : 'Rejected by operator');
      message = `Escalation ${escalationId} rejected; task ${record.taskId} stays blocked.`;
    }

    record.resolvedAt = now;
    record.resolution = {
      decision,
      proposalApplied: Boolean(applied?.applied),
      ruleId: applied?.ruleId ?? null,
      unblockedTaskId,
    };
    data.lastUpdated = now;
    writeJsonAtomic(file, data);
    return { ok: true, message, unblockedTaskId };
  });
}

/** The contract's evaluate body; the full verdict (patch, proof, guardrails) is stored on the escalation. */
export function triageView(result: TriageEvaluation) {
  return {
    ok: true,
    escalationId: result.escalationId,
    provider: result.provider,
    model: result.model,
    source: result.source,
    latencyMs: result.latencyMs,
    classification: result.classification,
    reasoning: result.reasoning,
    autoPatchApplied: result.autoPatchApplied,
    ...(result.humanCard ? { humanCard: result.humanCard } : {}),
  };
}

/**
 * POST /api/pipeline/triage/evaluate: runs the Tier 1 strategist on one escalation. A proven additive
 * patch is written only while auto-triage is enabled, and then unblocks the task. Concurrent requests
 * for the same escalation share one evaluation, so a double-click cannot apply or count twice.
 */
export function handleTriageEvaluate(
  root: string,
  liaison: Tier1Liaison,
  inFlight: Map<string, Promise<ReturnType<typeof triageView>>>,
  body: Record<string, unknown>,
) {
  const escalationId = typeof body.escalationId === 'string' ? body.escalationId.trim() : '';
  if (!TASK_ID_PATTERN.test(escalationId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"escalationId" must be an escalation id such as esc-01');
  }
  const running = inFlight.get(escalationId);
  if (running) return running;

  const evaluation = (async () => {
    const blocker = triageBlocker(root, escalationId);
    if (blocker) throw new HttpError(400, 'TRIAGE_REJECTED', blocker);
    const result = await liaison.evaluate(escalationId);
    if (!result.ok) throw new HttpError(400, 'TRIAGE_REJECTED', result.error);
    await finalizeTriage(root, result);
    return triageView(result);
  })().finally(() => inFlight.delete(escalationId));
  inFlight.set(escalationId, evaluation);
  return evaluation;
}

export const RISK_THRESHOLDS = ['safe_contracts_only', 'all_non_destructive'];

/** POST /api/pipeline/triage/config: session-only auto-triage settings, validated before they reach the liaison. */
export function handleTriageConfig(liaison: Tier1Liaison, body: Record<string, unknown>, onToggle?: () => void) {
  if (typeof body.autoTriageEnabled !== 'boolean') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"autoTriageEnabled" must be a boolean');
  }
  if (body.riskThreshold !== undefined && !RISK_THRESHOLDS.includes(body.riskThreshold as string)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"riskThreshold" must be one of: ${RISK_THRESHOLDS.join(', ')}`);
  }
  const result = liaison.updateConfig({ autoTriageEnabled: body.autoTriageEnabled, riskThreshold: body.riskThreshold });
  if (!result.ok) throw new HttpError(400, 'VALIDATION_ERROR', result.error);
  if (body.autoTriageEnabled && onToggle) onToggle();
  return result;
}

/** Automatically triages pending escalations when autoTriage is enabled. */
export async function runAutoTriageQueue(
  root: string,
  liaison: Tier1Liaison,
  inFlight: Map<string, Promise<ReturnType<typeof triageView>>>,
): Promise<void> {
  const status = liaison.getStatus();
  if (!status.autoTriageEnabled) return;

  const data = readEscalationFile(root);
  if (!data?.escalations) return;

  const pending = (data.escalations as TriagedEscalationRecord[]).filter(
    (e) => e && e.status === 'pending_review' && !e.triage,
  );

  for (const esc of pending) {
    if (inFlight.has(esc.id)) continue;
    try {
      await handleTriageEvaluate(root, liaison, inFlight, { escalationId: esc.id });
    } catch {
      // Background auto-triage gracefully ignores individual failures
    }
  }
}
