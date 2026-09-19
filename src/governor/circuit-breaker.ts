import fs from 'node:fs';
import path from 'node:path';
import {
  CircuitBreakerState,
  ContractPatch,
  EscalationDiagnosticBundle,
  RuleEvaluationResult,
} from './types.js';
import { EscalationFile, EscalationRecord, MasterPlan } from '../scanner/types.js';
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
  };
}

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

  static recordFailure(
    targetDir: string,
    taskId: string,
    patch: ContractPatch,
    ruleResult: RuleEvaluationResult
  ): { state: CircuitBreakerState; diagnosticBundle?: EscalationDiagnosticBundle } {
    const ledger = loadLedger(targetDir);
    const entry = ledger[taskId] || { consecutiveFailures: 0, lastFailureTime: '', patchCount: 0 };

    entry.consecutiveFailures += 1;
    entry.lastFailureTime = new Date().toISOString();
    entry.lastRuleId = ruleResult.ruleId;
    entry.lastViolation = ruleResult.message;
    ledger[taskId] = entry;
    saveLedger(targetDir, ledger);

    const tripped = entry.consecutiveFailures >= MAX_FAILURE_THRESHOLD;
    const state: CircuitBreakerState = {
      active: true,
      consecutiveFailures: entry.consecutiveFailures,
      maxThreshold: MAX_FAILURE_THRESHOLD,
      tripped,
    };

    if (tripped) {
      const diagnosticBundle = this.tripAndEscalate(targetDir, taskId, patch, ruleResult, entry.consecutiveFailures);
      return { state, diagnosticBundle };
    }

    return { state };
  }

  private static tripAndEscalate(
    targetDir: string,
    taskId: string,
    patch: ContractPatch,
    ruleResult: RuleEvaluationResult,
    failures: number
  ): EscalationDiagnosticBundle {
    const escalationId = `esc-${Date.now().toString(36)}`;
    const contractFileName = patch.target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json';

    const diagnosticBundle: EscalationDiagnosticBundle = {
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
      recommendedActions: [
        `Review contract at .ai/${contractFileName} and either adjust schema or approve migration.`,
        `If the operation is required, have Tier 1 (Antigravity) apply the change and unblock ${taskId}.`,
        `If the operation is invalid, instruct the agent to use an alternative backward-compatible approach.`,
      ],
    };

    // 1. Write to .ai/escalation.json
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
        } catch {
          // fallback
        }
      }

      const newRecord: EscalationRecord = {
        id: escalationId,
        taskId,
        type: patch.target === 'db_schema' ? 'schema_flaw' : 'contract_drift',
        reportedBy: 'backend',
        timestamp: new Date().toISOString(),
        summary: `Circuit Breaker Tripped (${failures}/${MAX_FAILURE_THRESHOLD}): ${ruleResult.ruleId} on ${patch.path}`,
        details: `Autonomous agent failed ${failures} times attempting ${patch.operation} on ${patch.path}: ${ruleResult.message}`,
        affectedContracts: [`.ai/${contractFileName}`],
        recommendedAction: diagnosticBundle.recommendedActions[0],
        status: 'pending_review',
      };

      escalationFile.escalations.unshift(newRecord);
      escalationFile.lastUpdated = new Date().toISOString();
      fs.writeFileSync(escalationPath, JSON.stringify(escalationFile, null, 2) + '\n', 'utf8');
    } catch {
      // Non-fatal
    }

    // 2. Mark task as blocked in .ai/master_plan.json
    const planPath = path.join(targetDir, '.ai', 'master_plan.json');
    try {
      withPlanLockSync(planPath, (plan) => {
        for (const milestone of plan.milestones) {
          const task = milestone.tasks.find((t) => t.id === taskId);
          if (task) {
            task.status = 'blocked';
            task.notes = `Circuit breaker tripped by Governor: ${ruleResult.ruleId} (${escalationId})`;
            break;
          }
        }
      });
    } catch {
      // Non-fatal
    }

    recordCircuitBreakerTrip(targetDir, taskId).catch(() => {});

    return diagnosticBundle;
  }
}
