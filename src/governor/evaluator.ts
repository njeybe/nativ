import fs from 'node:fs';
import path from 'node:path';
import {
  AuditLogEntry,
  ContractPatch,
  GovernorVerdict,
  RuleEvaluationResult,
} from './types.js';
import { evaluateDbPatch } from './rules/db-rules.js';
import { evaluateApiPatch } from './rules/api-rules.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  getContractHash,
  appendAuditLog,
  applyDbPatch,
  applyApiPatch,
  atomicWriteJson,
} from './patch-applier.js';
import { generateSelfHealingProposal } from './self-healing.js';

export * from './patch-applier.js';
export * from './self-healing.js';
export * from './test-integrity.js';

const MAX_TASK_PATCH_BUDGET = 3;

export class ContractGovernor {
  static evaluate(targetDir: string, patch: ContractPatch): GovernorVerdict {
    const heal = (result: RuleEvaluationResult) => () => generateSelfHealingProposal(targetDir, patch, result);
    const contractFileName = patch.target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json';
    const contractPath = path.join(targetDir, '.ai', contractFileName);

    // 1. Edge Case 2: Check concurrent hash if baseHash is provided
    if (patch.baseHash && fs.existsSync(contractPath)) {
      const currentHash = getContractHash(contractPath);
      if (currentHash && currentHash !== patch.baseHash) {
        const failureResult: RuleEvaluationResult = {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: 'CONCURRENT_MODIFICATION_DETECTED',
          message: `Contract .ai/${contractFileName} was modified by another task or agent. Rebase worktree and retry.`,
          violations: ['CONCURRENT_MODIFICATION_DETECTED'],
        };
        const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, failureResult, heal(failureResult));
        return {
          approved: false,
          blastRadius: 'HIGH_DESTRUCTIVE',
          ruleId: failureResult.ruleId,
          message: failureResult.message,
          violations: failureResult.violations,
          patchApplied: false,
          circuitBreaker: state,
          diagnosticBundle,
        };
      }
    }

    // 2. Edge Case 4: Patch Budget check (Max 3 patches per task)
    const currentPatchCount = CircuitBreaker.getPatchCount(targetDir, patch.taskId);
    if (currentPatchCount >= MAX_TASK_PATCH_BUDGET) {
      const budgetResult: RuleEvaluationResult = {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: 'TASK_PATCH_BUDGET_EXCEEDED',
        message: `Task '${patch.taskId}' exceeded its allowed budget of ${MAX_TASK_PATCH_BUDGET} contract patches. Architectural review required.`,
        violations: ['TASK_PATCH_BUDGET_EXCEEDED'],
      };
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, budgetResult, heal(budgetResult));
      return {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: budgetResult.ruleId,
        message: budgetResult.message,
        violations: budgetResult.violations,
        patchApplied: false,
        circuitBreaker: state,
        diagnosticBundle,
      };
    }

    // 3. Load contract content
    if (!fs.existsSync(contractPath)) {
      const notFoundResult: RuleEvaluationResult = {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: 'CONTRACT_FILE_MISSING',
        message: `Target contract file not found at: ${contractPath}`,
        violations: ['CONTRACT_FILE_MISSING'],
      };
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, notFoundResult, heal(notFoundResult));
      return {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: notFoundResult.ruleId,
        message: notFoundResult.message,
        violations: notFoundResult.violations,
        patchApplied: false,
        circuitBreaker: state,
        diagnosticBundle,
      };
    }

    let contractData: any;
    try {
      contractData = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    } catch (err: any) {
      const parseResult: RuleEvaluationResult = {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: 'CONTRACT_JSON_CORRUPT',
        message: `Failed to parse .ai/${contractFileName}: ${err.message}`,
        violations: ['CONTRACT_JSON_CORRUPT'],
      };
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, parseResult, heal(parseResult));
      return {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: parseResult.ruleId,
        message: parseResult.message,
        violations: parseResult.violations,
        patchApplied: false,
        circuitBreaker: state,
        diagnosticBundle,
      };
    }

    // 4. Run appropriate rule evaluator
    const evalResult =
      patch.target === 'db_schema'
        ? evaluateDbPatch(patch, contractData)
        : evaluateApiPatch(patch, contractData);

    // 5. Handle approval vs rejection
    if (evalResult.approved && evalResult.blastRadius === 'LOW_ADDITIVE') {
      // Apply patch
      const patchedData =
        patch.target === 'db_schema'
          ? applyDbPatch(contractData, patch)
          : applyApiPatch(contractData, patch);

      const writeSuccess = atomicWriteJson(contractPath, patchedData);
      CircuitBreaker.incrementPatchCount(targetDir, patch.taskId);
      CircuitBreaker.recordSuccess(targetDir, patch.taskId);

      const auditEntry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        taskId: patch.taskId,
        target: patch.target,
        operation: patch.operation,
        path: patch.path,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: evalResult.ruleId,
        reason: patch.reason,
        applied: writeSuccess,
      };
      appendAuditLog(targetDir, auditEntry);

      return {
        approved: true,
        blastRadius: 'LOW_ADDITIVE',
        ruleId: evalResult.ruleId,
        message: evalResult.message,
        violations: [],
        patchApplied: writeSuccess,
        circuitBreaker: CircuitBreaker.getStatus(targetDir, patch.taskId),
        auditEntry,
      };
    } else {
      // Rejection
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, evalResult, heal(evalResult));

      const auditEntry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        taskId: patch.taskId,
        target: patch.target,
        operation: patch.operation,
        path: patch.path,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: evalResult.ruleId,
        reason: patch.reason,
        applied: false,
      };
      appendAuditLog(targetDir, auditEntry);

      return {
        approved: false,
        blastRadius: 'HIGH_DESTRUCTIVE',
        ruleId: evalResult.ruleId,
        message: evalResult.message,
        violations: evalResult.violations,
        patchApplied: false,
        circuitBreaker: state,
        auditEntry,
        diagnosticBundle,
      };
    }
  }
}
