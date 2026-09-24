import fs from 'node:fs';
import path from 'node:path';
import {
  BlastRadius,
  CircuitBreakerState,
  ContractPatch,
  EscalationDiagnosticBundle,
  RuleEvaluationResult,
} from './types.js';
import { EscalationFile, EscalationRecord, EscalationType } from '../scanner/types.js';
import { withPlanLockSync } from '../core/lock-manager.js';
import { recordCircuitBreakerTrip } from '../core/telemetry.js';

const MAX_FAILURE_THRESHOLD = 3;

interface TaskFailureLedger {
  [taskId: string]: {
    consecutiveFailures: number;
    lastFailureTime: string;
    lastRuleId?: string;
    lastViolation?: string;
    patchCount: number;
    /** Commit recorded at `nativ task start`; the test-integrity guard diffs against it. */
    baselineRef?: string;
    baselineRecordedAt?: string;
  };
}

// ─── Self-healing proposal types ─────────────────────────────────────────────

/** A contract patch as proposed, without the task binding. */
export type CandidatePatch = Omit<ContractPatch, 'taskId'>;

export interface ProofCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Evidence that a proposal was exercised away from the live `.ai/` contracts
 * before a human is asked to approve it.
 */
export interface VerificationProof {
  isolated: true;
  method: 'sandbox_governor_replay' | 'baseline_blob_check';
  passed: boolean;
  checks: ProofCheck[];
  /** Hash of the live contract the candidate was replayed against. */
  baseContractHash?: string | null;
  /** Hash of the sandbox contract after the candidate was applied. */
  candidateContractHash?: string | null;
  verdict?: { approved: boolean; blastRadius: BlastRadius; ruleId: string; message: string };
  verifiedAt: string;
  durationMs: number;
}

export type SelfHealingStrategy =
  | 'relax_to_nullable'
  | 'relax_to_optional'
  | 'deprecate_instead_of_drop'
  | 'expand_contract_rename'
  | 'shadow_column_for_type_change'
  | 'alter_existing_instead_of_add'
  | 'add_missing_target'
  | 'rebase_on_current_contract'
  | 'budget_override'
  | 'restore_test_suite';

interface ProposalBase {
  proposalId: string;
  strategy: SelfHealingStrategy;
  rationale: string;
  /** Proposals are never applied automatically; Tier 1 or the operator approves them. */
  requiresHumanApproval: true;
  candidatesEvaluated: number;
  verificationProof: VerificationProof;
  generatedAt: string;
}

export interface ContractPatchProposal extends ProposalBase {
  kind: 'contract_patch';
  candidate: CandidatePatch;
  original: CandidatePatch;
}

export interface TestRestorationProposal extends ProposalBase {
  kind: 'restore_tests';
  baselineRef: string;
  files: string[];
  commands: string[];
}

export type SelfHealingProposal = ContractPatchProposal | TestRestorationProposal;

/** `.ai/escalation.json` record carrying the optional self-healing proposal. */
export interface SelfHealingEscalationRecord extends EscalationRecord {
  proposedPatch?: SelfHealingProposal;
}

export type ProposalFactory = () => SelfHealingProposal | null;

export interface GuardViolationContext {
  escalationType: EscalationType;
  /** Files or contracts the violation touches, listed on the escalation record. */
  affected: string[];
  intent: string;
}

// ─── Ledger persistence ──────────────────────────────────────────────────────

function getLedgerPath(targetDir: string): string {
  return path.join(targetDir, '.ai', '.governor_ledger.json');
}

function loadLedger(targetDir: string): TaskFailureLedger {
  const p = getLedgerPath(targetDir);
  if (!fs.existsSync(p)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveLedger(targetDir: string, ledger: TaskFailureLedger): void {
  const p = getLedgerPath(targetDir);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  } catch {
    // Ignore non-fatal ledger write error
  }
}

/** Proposal generation must never turn a trip into a crash; a failed factory means "no proposal". */
function buildProposal(factory?: ProposalFactory): SelfHealingProposal | null {
  if (!factory) return null;
  try {
    return factory();
  } catch {
    return null;
  }
}

function describeProposal(proposal: SelfHealingProposal): string {
  const verified = proposal.verificationProof.passed ? 'verified in an isolated sandbox' : 'NOT verified';
  return `Review self-healing proposal ${proposal.proposalId} (${proposal.strategy}, ${verified}): ${proposal.rationale}`;
}

export class CircuitBreaker {
  static getStatus(targetDir: string, taskId: string): CircuitBreakerState {
    const ledger = loadLedger(targetDir);
    const entry = ledger[taskId];
    const failures = entry?.consecutiveFailures || 0;
    return {
      active: failures > 0,
      consecutiveFailures: failures,
      maxThreshold: MAX_FAILURE_THRESHOLD,
      tripped: failures >= MAX_FAILURE_THRESHOLD,
    };
  }

  static getPatchCount(targetDir: string, taskId: string): number {
    const ledger = loadLedger(targetDir);
    return ledger[taskId]?.patchCount || 0;
  }

  static incrementPatchCount(targetDir: string, taskId: string): number {
    const ledger = loadLedger(targetDir);
    if (!ledger[taskId]) {
      ledger[taskId] = { consecutiveFailures: 0, lastFailureTime: new Date().toISOString(), patchCount: 1 };
    } else {
      ledger[taskId].patchCount = (ledger[taskId].patchCount || 0) + 1;
    }
    saveLedger(targetDir, ledger);
    return ledger[taskId].patchCount;
  }

  static recordSuccess(targetDir: string, taskId: string): void {
    const ledger = loadLedger(targetDir);
    if (ledger[taskId]) {
      ledger[taskId].consecutiveFailures = 0;
      saveLedger(targetDir, ledger);
    }
  }

  static reset(targetDir: string, taskId: string): void {
    const ledger = loadLedger(targetDir);
    if (ledger[taskId]) {
      delete ledger[taskId];
      saveLedger(targetDir, ledger);
    }
  }

  /**
   * Pins the commit a task started from. Restarting a blocked task keeps the
   * original baseline so deletions made before the block still count.
   */
  static recordBaseline(targetDir: string, taskId: string, ref: string): void {
    const ledger = loadLedger(targetDir);
    const entry = ledger[taskId] || { consecutiveFailures: 0, lastFailureTime: '', patchCount: 0 };
    if (entry.baselineRef) return;
    entry.baselineRef = ref;
    entry.baselineRecordedAt = new Date().toISOString();
    ledger[taskId] = entry;
    saveLedger(targetDir, ledger);
  }

  static getBaseline(targetDir: string, taskId: string): string | null {
    return loadLedger(targetDir)[taskId]?.baselineRef ?? null;
  }

  static clearBaseline(targetDir: string, taskId: string): void {
    const ledger = loadLedger(targetDir);
    if (ledger[taskId]?.baselineRef) {
      delete ledger[taskId].baselineRef;
      delete ledger[taskId].baselineRecordedAt;
      saveLedger(targetDir, ledger);
    }
  }

  static recordFailure(
    targetDir: string,
    taskId: string,
    patch: ContractPatch,
    ruleResult: RuleEvaluationResult,
    proposalFactory?: ProposalFactory,
  ): { state: CircuitBreakerState; diagnosticBundle?: EscalationDiagnosticBundle & { selfHealingProposal?: SelfHealingProposal | null } } {
    const state = this.bumpFailures(targetDir, taskId, ruleResult);

    if (state.tripped) {
      const diagnosticBundle = this.tripAndEscalate(targetDir, taskId, patch, ruleResult, state.consecutiveFailures, proposalFactory);
      return { state, diagnosticBundle };
    }

    return { state };
  }

  /**
   * Counts a non-contract guard violation (e.g. test integrity) toward the same
   * 3-strike budget. On the trip the task is blocked and escalated with the
   * factory's proposal attached.
   */
  static recordGuardViolation(
    targetDir: string,
    taskId: string,
    ruleResult: RuleEvaluationResult,
    context: GuardViolationContext,
    proposalFactory?: ProposalFactory,
  ): { state: CircuitBreakerState; escalationId?: string; proposal?: SelfHealingProposal | null } {
    const state = this.bumpFailures(targetDir, taskId, ruleResult);
    if (!state.tripped) return { state };

    const escalationId = `esc-${Date.now().toString(36)}`;
    const proposal = buildProposal(proposalFactory);
    const recommendedAction = proposal
      ? describeProposal(proposal)
      : `Review ${context.affected.join(', ')} and decide whether the change is intended; if so, have Tier 1 update the task and unblock ${taskId}.`;

    this.writeEscalation(targetDir, {
      id: escalationId,
      taskId,
      type: context.escalationType,
      reportedBy: 'backend',
      timestamp: new Date().toISOString(),
      summary: `Circuit Breaker Tripped (${state.consecutiveFailures}/${MAX_FAILURE_THRESHOLD}): ${ruleResult.ruleId}`,
      details: `${context.intent}: ${ruleResult.message}`,
      affectedContracts: context.affected,
      recommendedAction,
      status: 'pending_review',
      ...(proposal ? { proposedPatch: proposal } : {}),
    });
    this.blockTask(targetDir, taskId, `Circuit breaker tripped by Governor: ${ruleResult.ruleId} (${escalationId})`);
    recordCircuitBreakerTrip(targetDir, taskId).catch(() => {});

    return { state, escalationId, proposal };
  }

  private static bumpFailures(targetDir: string, taskId: string, ruleResult: RuleEvaluationResult): CircuitBreakerState {
    const ledger = loadLedger(targetDir);
    const entry = ledger[taskId] || { consecutiveFailures: 0, lastFailureTime: '', patchCount: 0 };

    entry.consecutiveFailures += 1;
    entry.lastFailureTime = new Date().toISOString();
    entry.lastRuleId = ruleResult.ruleId;
    entry.lastViolation = ruleResult.message;
    ledger[taskId] = entry;
    saveLedger(targetDir, ledger);

    return {
      active: true,
      consecutiveFailures: entry.consecutiveFailures,
      maxThreshold: MAX_FAILURE_THRESHOLD,
      tripped: entry.consecutiveFailures >= MAX_FAILURE_THRESHOLD,
    };
  }

  private static tripAndEscalate(
    targetDir: string,
    taskId: string,
    patch: ContractPatch,
    ruleResult: RuleEvaluationResult,
    failures: number,
    proposalFactory?: ProposalFactory,
  ): EscalationDiagnosticBundle & { selfHealingProposal?: SelfHealingProposal | null } {
    const escalationId = `esc-${Date.now().toString(36)}`;
    const contractFileName = patch.target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json';
    const proposal = buildProposal(proposalFactory);

    const recommendedActions = [
      `Review contract at .ai/${contractFileName} and either adjust schema or approve migration.`,
      `If the operation is required, have Tier 1 (Antigravity) apply the change and unblock ${taskId}.`,
      `If the operation is invalid, instruct the agent to use an alternative backward-compatible approach.`,
    ];
    if (proposal) recommendedActions.unshift(describeProposal(proposal));

    const diagnosticBundle = {
      escalationId,
      taskId,
      circuitBreakerTripped: true,
      consecutiveFailures: failures,
      intent: patch.reason || `Apply ${patch.operation} on ${patch.path}`,
      invariantCollision: ruleResult.message,
      proposedPatch: {
        target: patch.target,
        operation: patch.operation,
        path: patch.path,
        value: patch.value,
        reason: patch.reason,
      },
      recommendedActions,
      selfHealingProposal: proposal,
    };

    // 1. Write to .ai/escalation.json
    this.writeEscalation(targetDir, {
      id: escalationId,
      taskId,
      type: patch.target === 'db_schema' ? 'schema_flaw' : 'contract_drift',
      reportedBy: 'backend',
      timestamp: new Date().toISOString(),
      summary: `Circuit Breaker Tripped (${failures}/${MAX_FAILURE_THRESHOLD}): ${ruleResult.ruleId} on ${patch.path}`,
      details: `Autonomous agent failed ${failures} times attempting ${patch.operation} on ${patch.path}: ${ruleResult.message}`,
      affectedContracts: [`.ai/${contractFileName}`],
      recommendedAction: recommendedActions[0],
      status: 'pending_review',
      ...(proposal ? { proposedPatch: proposal } : {}),
    });

    // 2. Mark task as blocked in .ai/master_plan.json
    this.blockTask(targetDir, taskId, `Circuit breaker tripped by Governor: ${ruleResult.ruleId} (${escalationId})`);

    recordCircuitBreakerTrip(targetDir, taskId).catch(() => {});

    return diagnosticBundle;
  }

  private static writeEscalation(targetDir: string, record: SelfHealingEscalationRecord): void {
    const escalationPath = path.join(targetDir, '.ai', 'escalation.json');
    try {
      let escalationFile: EscalationFile = {
        version: '1.0.0',
        projectName: path.basename(targetDir),
        lastUpdated: new Date().toISOString(),
        escalations: [],
      };

      if (fs.existsSync(escalationPath)) {
        try {
          escalationFile = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
          if (!Array.isArray(escalationFile.escalations)) escalationFile.escalations = [];
        } catch {
          // fallback
        }
      }

      escalationFile.escalations.unshift(record);
      escalationFile.lastUpdated = new Date().toISOString();
      fs.writeFileSync(escalationPath, JSON.stringify(escalationFile, null, 2) + '\n', 'utf8');
    } catch {
      // Non-fatal
    }
  }

  private static blockTask(targetDir: string, taskId: string, note: string): void {
    const planPath = path.join(targetDir, '.ai', 'master_plan.json');
    try {
      withPlanLockSync(planPath, (plan) => {
        for (const milestone of plan.milestones) {
          const task = milestone.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'blocked';
            task.notes = note;
            break;
          }
        }
      });
    } catch {
      // Non-fatal
    }
  }
}
