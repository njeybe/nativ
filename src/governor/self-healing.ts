import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  ContractPatch,
  RuleEvaluationResult,
} from './types.js';
import { evaluateDbPatch } from './rules/db-rules.js';
import { evaluateApiPatch } from './rules/api-rules.js';
import {
  CircuitBreaker,
  type CandidatePatch,
  type ContractPatchProposal,
  type ProofCheck,
  type SelfHealingProposal,
  type SelfHealingStrategy,
  type VerificationProof,
} from './circuit-breaker.js';
import {
  getContractHash,
  appendAuditLog,
  atomicWriteJson,
  contractFileFor,
  applyPatch,
} from './patch-applier.js';

function runRules(patch: ContractPatch, contract: any): RuleEvaluationResult {
  return patch.target === 'db_schema' ? evaluateDbPatch(patch, contract) : evaluateApiPatch(patch, contract);
}

/** Hash of the contract's content, ignoring the timestamps every write refreshes. */
function semanticHash(data: any): string {
  const { updatedAt: _u, lastUpdated: _l, ...rest } = data ?? {};
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function toCandidate(patch: ContractPatch): CandidatePatch {
  const { taskId: _taskId, ...candidate } = patch;
  return candidate;
}

interface CandidateOption {
  strategy: SelfHealingStrategy;
  rationale: string;
  candidate: CandidatePatch;
}

/** Mirrors the rule modules' path parsing: `[tables.]<table>.columns.<column>`. */
function locateDbColumn(contract: any, patchPath: string): { table: any; column: any; columnName?: string } {
  const segments = patchPath.split('.').filter(Boolean);
  const lower = segments.map((s) => s.toLowerCase());
  const tableName = lower[0] === 'tables' ? lower[1] : lower[0];
  const columnName = segments.length > 2 ? segments[segments.length - 1] : undefined;
  const table = (contract?.tables || []).find((t: any) => t.name?.toLowerCase() === tableName);
  const column = table?.columns?.find((c: any) => c.name?.toLowerCase() === columnName?.toLowerCase());
  return { table, column, columnName };
}

function withLastSegment(patchPath: string, name: string): string {
  const segments = patchPath.split('.').filter(Boolean);
  segments[segments.length - 1] = name;
  return segments.join('.');
}

/**
 * Backward-compatible alternatives for a rejected patch, ordered by how
 * closely they preserve the agent's intent. Every candidate is still proven
 * in a sandbox before it is offered.
 */
function buildCandidates(
  patch: ContractPatch,
  rule: RuleEvaluationResult,
  contract: any,
  liveHash: string | null,
): CandidateOption[] {
  const base = toCandidate(patch);
  const note = (strategy: SelfHealingStrategy) => `${patch.reason} [self-healing: ${strategy}]`;
  const isColumn = /(^|\.)columns(\.|$)/i.test(patch.path);
  const firstViolation = rule.violations[0] || rule.message;
  const value = patch.value && typeof patch.value === 'object' ? patch.value : undefined;
  const options: CandidateOption[] = [];

  switch (rule.ruleId) {
    case 'CONCURRENT_MODIFICATION_DETECTED':
      options.push({
        strategy: 'rebase_on_current_contract',
        rationale: 'The contract changed after the agent read it; replay the same patch against the current revision.',
        candidate: { ...base, baseHash: liveHash ?? undefined, reason: note('rebase_on_current_contract') },
      });
      break;

    case 'TASK_PATCH_BUDGET_EXCEEDED':
      options.push({
        strategy: 'budget_override',
        rationale: 'The patch itself is safe; only the per-task budget stopped it. Approve to grant one more patch.',
        candidate: { ...base, reason: note('budget_override') },
      });
      break;

    case 'DB_ADD_NOT_NULL_FORBIDDEN':
    case 'DB_CIRCULAR_FK_FORBIDDEN':
      options.push({
        strategy: 'relax_to_nullable',
        rationale: 'Add the field as nullable so existing rows stay valid; tighten it later with a backfill and a default.',
        candidate: { ...base, value: { ...(value ?? {}), nullable: true }, reason: note('relax_to_nullable') },
      });
      break;

    case 'DB_DROP_FORBIDDEN':
      if (isColumn) {
        options.push({
          strategy: 'deprecate_instead_of_drop',
          rationale: 'Keep the column but mark it deprecated and nullable, so readers keep working while writers migrate off it.',
          candidate: {
            ...base,
            operation: 'ALTER',
            value: { nullable: true, deprecated: true },
            reason: note('deprecate_instead_of_drop'),
          },
        });
      }
      break;

    case 'DB_RENAME_FORBIDDEN': {
      const newName = typeof patch.value === 'string' ? patch.value : value?.name ?? value?.to;
      const { column } = locateDbColumn(contract, patch.path);
      if (isColumn && column && typeof newName === 'string' && newName) {
        options.push({
          strategy: 'expand_contract_rename',
          rationale: `Add '${newName}' alongside '${column.name}' (expand), backfill it, and retire the old column in a later reviewed migration (contract).`,
          candidate: {
            ...base,
            operation: 'ADD',
            path: withLastSegment(patch.path, newName),
            value: { ...column, name: newName, nullable: true, primaryKey: false },
            reason: note('expand_contract_rename'),
          },
        });
      }
      break;
    }

    case 'DB_ALTER_DESTRUCTIVE': {
      const { column } = locateDbColumn(contract, patch.path);
      if (isColumn && column && typeof value?.type === 'string') {
        const suffix = value.type.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'v2';
        const shadowName = `${column.name}_${suffix}`;
        options.push({
          strategy: 'shadow_column_for_type_change',
          rationale: `Add '${shadowName}' with the new type next to '${column.name}', backfill it, then switch readers over.`,
          candidate: {
            ...base,
            operation: 'ADD',
            path: withLastSegment(patch.path, shadowName),
            value: { ...column, ...value, name: shadowName, nullable: true, primaryKey: false },
            reason: note('shadow_column_for_type_change'),
          },
        });
      }
      break;
    }

    case 'DB_COLLISION_OR_TARGET_MISMATCH': {
      const { columnName } = locateDbColumn(contract, patch.path);
      if (isColumn && patch.operation === 'ADD' && firstViolation.startsWith('PATH_COLLISION')) {
        const { name: _name, ...changes } = value ?? {};
        options.push({
          strategy: 'alter_existing_instead_of_add',
          rationale: 'The column already exists; alter it in place instead of adding a duplicate.',
          candidate: { ...base, operation: 'ALTER', value: changes, reason: note('alter_existing_instead_of_add') },
        });
      } else if (isColumn && patch.operation === 'ALTER' && columnName && firstViolation.startsWith('TARGET_NOT_FOUND')) {
        options.push({
          strategy: 'add_missing_target',
          rationale: `Column '${columnName}' does not exist yet; add it as a nullable column instead of altering it.`,
          candidate: {
            ...base,
            operation: 'ADD',
            value: { name: columnName, type: 'TEXT', ...(value ?? {}), nullable: true },
            reason: note('add_missing_target'),
          },
        });
      }
      break;
    }

    case 'API_ADD_REQUIRED_FORBIDDEN': {
      const relaxed =
        typeof patch.value === 'string'
          ? patch.value.replace(/required/gi, 'optional')
          : { ...(value ?? {}), required: false, ...(value?.nullable === false ? { nullable: true } : {}) };
      options.push({
        strategy: 'relax_to_optional',
        rationale: 'Add the parameter as optional so existing clients keep working; make it required in a versioned endpoint later.',
        candidate: { ...base, value: relaxed, reason: note('relax_to_optional') },
      });
      break;
    }

    case 'API_RENAME_FORBIDDEN': {
      const segments = patch.path.split('.').filter(Boolean);
      const key = (segments[0]?.toLowerCase() === 'endpoints' ? segments[1] : segments[0])?.toLowerCase();
      const endpoint = (contract?.endpoints || []).find(
        (ep: any) => ep.id?.toLowerCase() === key || ep.path?.toLowerCase() === key,
      );
      const newPath = typeof patch.value === 'string' ? patch.value : value?.path;
      if (endpoint && typeof newPath === 'string' && newPath) {
        const newId = `${endpoint.id || 'endpoint'}-v2`;
        options.push({
          strategy: 'expand_contract_rename',
          rationale: `Serve '${newPath}' as a new endpoint beside '${endpoint.path}' and deprecate the old route once clients have moved.`,
          candidate: {
            ...base,
            operation: 'ADD',
            path: `endpoints.${newId}`,
            value: { ...JSON.parse(JSON.stringify(endpoint)), id: newId, path: newPath },
            reason: note('expand_contract_rename'),
          },
        });
      }
      break;
    }
  }

  return options;
}

/**
 * Replays a candidate against a throwaway copy of the contract in the OS temp
 * directory: governor rules, apply, re-parse, and proof that it changes
 * something while the live `.ai/` file stays byte-identical.
 */
export function verifyCandidateInSandbox(targetDir: string, taskId: string, candidate: CandidatePatch): VerificationProof {
  const started = Date.now();
  const fileName = contractFileFor(candidate.target);
  const livePath = path.join(targetDir, '.ai', fileName);
  const liveHashBefore = getContractHash(livePath);
  const checks: ProofCheck[] = [];
  let candidateHash: string | null = null;
  let verdict: VerificationProof['verdict'];

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-proof-'));
  try {
    const sandboxPath = path.join(sandbox, fileName);
    fs.copyFileSync(livePath, sandboxPath);
    checks.push({ name: 'sandbox_isolated', passed: true, detail: `Replayed against a copy of .ai/${fileName} outside the workspace` });

    const before = JSON.parse(fs.readFileSync(sandboxPath, 'utf8'));
    const patch: ContractPatch = { taskId, ...candidate };
    const result = runRules(patch, before);
    verdict = { approved: result.approved, blastRadius: result.blastRadius, ruleId: result.ruleId, message: result.message };
    const safe = result.approved && result.blastRadius === 'LOW_ADDITIVE';
    checks.push({ name: 'governor_rules', passed: safe, detail: `${result.ruleId}: ${result.message}` });

    if (safe) {
      const after = applyPatch(JSON.parse(JSON.stringify(before)), patch);
      const written = atomicWriteJson(sandboxPath, after);
      let reparsed: any = null;
      try {
        reparsed = JSON.parse(fs.readFileSync(sandboxPath, 'utf8'));
      } catch {
        // Reported by the check below.
      }
      const collection = candidate.target === 'db_schema' ? reparsed?.tables : reparsed?.endpoints;
      checks.push({
        name: 'contract_parses',
        passed: written && Array.isArray(collection),
        detail: written ? 'Patched contract round-trips as valid JSON' : 'Sandbox write failed',
      });

      const effective = reparsed !== null && semanticHash(reparsed) !== semanticHash(before);
      checks.push({
        name: 'patch_effective',
        passed: effective,
        detail: effective ? 'Candidate changes the contract' : 'Candidate would be a no-op for the governor applier',
      });
      candidateHash = getContractHash(sandboxPath);
    }
  } catch (err: any) {
    checks.push({ name: 'sandbox_replay', passed: false, detail: err?.message ?? String(err) });
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  const untouched = getContractHash(livePath) === liveHashBefore;
  checks.push({
    name: 'live_contract_untouched',
    passed: untouched,
    detail: untouched ? `.ai/${fileName} unchanged during the replay` : `.ai/${fileName} changed during the replay`,
  });

  return {
    isolated: true,
    method: 'sandbox_governor_replay',
    passed: checks.every((c) => c.passed),
    checks,
    baseContractHash: liveHashBefore,
    candidateContractHash: candidateHash,
    verdict,
    verifiedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  };
}

/**
 * Builds the first backward-compatible candidate that survives an isolated
 * replay. Returns null when no candidate can be proven (a human decides).
 */
export function generateSelfHealingProposal(
  targetDir: string,
  patch: ContractPatch,
  rule: RuleEvaluationResult,
): ContractPatchProposal | null {
  const livePath = path.join(targetDir, '.ai', contractFileFor(patch.target));
  let contract: any;
  try {
    contract = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  } catch {
    return null; // Missing or corrupt contracts need a human, not a patch.
  }

  const options = buildCandidates(patch, rule, contract, getContractHash(livePath));
  let evaluated = 0;
  for (const option of options) {
    evaluated++;
    const proof = verifyCandidateInSandbox(targetDir, patch.taskId, option.candidate);
    if (!proof.passed) continue;
    return {
      kind: 'contract_patch',
      proposalId: `heal-${crypto.randomUUID().slice(0, 8)}`,
      strategy: option.strategy,
      rationale: option.rationale,
      requiresHumanApproval: true,
      candidatesEvaluated: evaluated,
      verificationProof: proof,
      generatedAt: new Date().toISOString(),
      candidate: option.candidate,
      original: toCandidate(patch),
    };
  }
  return null;
}

export interface ProposalApplication {
  applied: boolean;
  ruleId: string;
  message: string;
}

/**
 * Applies an operator-approved proposal. Contract patches are re-checked
 * against the live contract and refused if it moved since the proof was taken.
 * Human-approved patches do not count against the task's patch budget.
 */
export function applySelfHealingProposal(
  targetDir: string,
  taskId: string,
  proposal: SelfHealingProposal,
): ProposalApplication {
  if (proposal.kind === 'restore_tests') {
    const res = spawnSync('git', ['checkout', proposal.baselineRef, '--', ...proposal.files], {
      cwd: targetDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status !== 0) {
      return { applied: false, ruleId: 'TEST_RESTORE_FAILED', message: String(res.stderr || res.stdout || 'git checkout failed').trim() };
    }
    CircuitBreaker.recordSuccess(targetDir, taskId);
    return { applied: true, ruleId: 'TEST_SUITE_RESTORED', message: `Restored ${proposal.files.length} test file(s) from ${proposal.baselineRef}` };
  }

  const candidate = proposal.candidate;
  const fileName = contractFileFor(candidate.target);
  const livePath = path.join(targetDir, '.ai', fileName);
  const liveHash = getContractHash(livePath);
  const provenAgainst = proposal.verificationProof.baseContractHash;
  if (provenAgainst && liveHash !== provenAgainst) {
    return {
      applied: false,
      ruleId: 'PROPOSAL_STALE',
      message: `.ai/${fileName} changed after proposal ${proposal.proposalId} was verified; regenerate it against the current contract.`,
    };
  }

  let contract: any;
  try {
    contract = JSON.parse(fs.readFileSync(livePath, 'utf8'));
  } catch (err: any) {
    return { applied: false, ruleId: 'CONTRACT_JSON_CORRUPT', message: `Failed to read .ai/${fileName}: ${err.message}` };
  }

  const patch: ContractPatch = { taskId, ...candidate };
  const result = runRules(patch, contract);
  if (!result.approved || result.blastRadius !== 'LOW_ADDITIVE') {
    return { applied: false, ruleId: result.ruleId, message: result.message };
  }

  const written = atomicWriteJson(livePath, applyPatch(contract, patch));
  appendAuditLog(targetDir, {
    timestamp: new Date().toISOString(),
    taskId,
    target: candidate.target,
    operation: candidate.operation,
    path: candidate.path,
    blastRadius: 'LOW_ADDITIVE',
    ruleId: 'SELF_HEALING_PROPOSAL_APPLIED',
    reason: `${proposal.proposalId} (${proposal.strategy}): ${candidate.reason}`,
    applied: written,
  });
  if (written) CircuitBreaker.recordSuccess(targetDir, taskId);
  return {
    applied: written,
    ruleId: written ? 'SELF_HEALING_PROPOSAL_APPLIED' : 'CONTRACT_WRITE_FAILED',
    message: written ? `Applied ${proposal.strategy} to .ai/${fileName}` : `Could not write .ai/${fileName}`,
  };
}
