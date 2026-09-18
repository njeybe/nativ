import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AuditLogEntry,
  ContractPatch,
  GovernorVerdict,
  RuleEvaluationResult,
} from './types.js';
import { evaluateDbPatch } from './rules/db-rules.js';
import { evaluateApiPatch } from './rules/api-rules.js';
import { CircuitBreaker } from './circuit-breaker.js';

const MAX_TASK_PATCH_BUDGET = 3;

export function getContractHash(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}

function appendAuditLog(targetDir: string, entry: AuditLogEntry): void {
  const auditPath = path.join(targetDir, '.ai', 'audit_log.jsonl');
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Non-fatal
  }
}

function applyDbPatch(schema: any, patch: ContractPatch): any {
  const { operation, path: targetPath, value } = patch;
  const segments = targetPath.toLowerCase().split('.').filter(Boolean);
  const tableName = segments[0] === 'tables' ? segments[1] : segments[0];
  const targetType = segments.includes('columns')
    ? 'column'
    : (segments.includes('indexes') ? 'index' : (segments.includes('foreignkeys') ? 'foreignKey' : 'table'));
  const propertyName = segments.length > 2 ? segments[segments.length - 1] : undefined;

  schema.tables = schema.tables || [];

  if (operation === 'ADD') {
    if (targetType === 'table') {
      schema.tables.push(value || { name: tableName, columns: [], indexes: [], foreignKeys: [] });
    } else {
      const table = schema.tables.find((t: any) => t.name?.toLowerCase() === tableName.toLowerCase());
      if (table) {
        if (targetType === 'column') {
          table.columns = table.columns || [];
          table.columns.push(value || { name: propertyName, type: 'TEXT', nullable: true });
        } else if (targetType === 'index') {
          table.indexes = table.indexes || [];
          table.indexes.push(value);
        } else if (targetType === 'foreignKey') {
          table.foreignKeys = table.foreignKeys || [];
          table.foreignKeys.push(value);
        }
      }
    }
  } else if (operation === 'ALTER') {
    const table = schema.tables.find((t: any) => t.name?.toLowerCase() === tableName.toLowerCase());
    if (table && targetType === 'column' && propertyName) {
      const colIdx = table.columns?.findIndex((c: any) => c.name?.toLowerCase() === propertyName.toLowerCase());
      if (colIdx !== undefined && colIdx >= 0) {
        table.columns[colIdx] = { ...table.columns[colIdx], ...value };
      }
    }
  }

  schema.updatedAt = new Date().toISOString();
  return schema;
}

function applyApiPatch(contracts: any, patch: ContractPatch): any {
  const { operation, path: targetPath, value } = patch;
  const segments = targetPath.toLowerCase().split('.').filter(Boolean);
  const endpointIdOrPath = segments[0] === 'endpoints' ? segments[1] : segments[0];

  contracts.endpoints = contracts.endpoints || [];

  if (operation === 'ADD') {
    const isEndpoint = segments.length <= 2 && value?.path && value?.method;
    if (isEndpoint) {
      contracts.endpoints.push(value);
    } else {
      const ep = contracts.endpoints.find(
        (e: any) =>
          e.id?.toLowerCase() === endpointIdOrPath.toLowerCase() ||
          e.path?.toLowerCase() === endpointIdOrPath.toLowerCase()
      );
      if (ep) {
        if (segments.includes('queryparams')) {
          ep.request = ep.request || {};
          ep.request.queryParams = ep.request.queryParams || {};
          ep.request.queryParams[segments[segments.length - 1]] = value;
        } else if (segments.includes('responses') || segments.includes('response')) {
          ep.responses = ep.responses || {};
          const status = segments.find((s: string) => /^\d{3}$/.test(s)) || '200';
          ep.responses[status] = ep.responses[status] || { description: 'Success', body: {} };
          if (typeof value === 'object' && value !== null) {
            ep.responses[status].body = { ...ep.responses[status].body, ...value };
          }
        }
      }
    }
  }

  contracts.updatedAt = new Date().toISOString();
  return contracts;
}

function atomicWriteJson(filePath: string, data: any): boolean {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    return false;
  }
}

export class ContractGovernor {
  static evaluate(targetDir: string, patch: ContractPatch): GovernorVerdict {
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
        const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, failureResult);
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
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, budgetResult);
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
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, notFoundResult);
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
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, parseResult);
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
      const { state, diagnosticBundle } = CircuitBreaker.recordFailure(targetDir, patch.taskId, patch, evalResult);

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
