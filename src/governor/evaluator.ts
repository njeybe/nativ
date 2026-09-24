import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  AuditLogEntry,
  ContractPatch,
  GovernorVerdict,
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
  type TestRestorationProposal,
  type VerificationProof,
} from './circuit-breaker.js';

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

// ─── Self-healing: candidate generation & isolated proofs ──────────────────

function contractFileFor(target: ContractPatch['target']): string {
  return target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json';
}

function runRules(patch: ContractPatch, contract: any): RuleEvaluationResult {
  return patch.target === 'db_schema' ? evaluateDbPatch(patch, contract) : evaluateApiPatch(patch, contract);
}

function applyPatch(contract: any, patch: ContractPatch): any {
  return patch.target === 'db_schema' ? applyDbPatch(contract, patch) : applyApiPatch(contract, patch);
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

// ─── Test-integrity invariant ───────────────────────────────────────────────

export type TestIntegrityRule =
  | 'TEST_SUITE_DELETED'
  | 'TEST_ASSERTIONS_REMOVED'
  | 'TEST_CASES_REMOVED'
  | 'TESTS_SKIPPED'
  | 'TESTS_FOCUSED'
  | 'TEST_SCRIPT_WEAKENED';

export interface TestIntegrityFinding {
  rule: TestIntegrityRule;
  /** Path relative to the project root. */
  path: string;
  detail: string;
}

export interface TestIntegrityReport extends RuleEvaluationResult {
  /** Resolved commit the working tree was compared against; null when the check was skipped. */
  baselineRef: string | null;
  /** True when the baseline came from `nativ task start` rather than falling back to HEAD. */
  baselineRecorded: boolean;
  findings: TestIntegrityFinding[];
  skippedReason?: string;
}

export interface TestSuiteMetrics {
  assertions: number;
  testCases: number;
  skipped: number;
  focused: number;
}

const TEST_CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php)$/i;

export function isTestFile(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  if (!TEST_CODE_EXTENSION.test(p) || /(^|\/)node_modules\//.test(p)) return false;
  return (
    /(^|\/)(?:__tests__|tests?|specs?)\//i.test(p) ||
    /[._-](?:test|spec)\.[a-z]+$/i.test(p) ||
    /(^|\/)test[_-][^/]+$/i.test(p)
  );
}

/** Heuristic, language-agnostic counts; only deltas against the baseline matter. */
export function measureTestSuite(source: string): TestSuiteMetrics {
  const count = (re: RegExp) => (source.match(re) || []).length;
  return {
    assertions:
      count(/(?<![.\w])(?:assert(?:\.[A-Za-z]+)*|expect|self\.assert[A-Za-z]*|t\.(?:is|ok|not|truthy|falsy|equal|deepEqual|true|false|throws|throwsAsync|notThrows|regex|snapshot|like))\s*\(/g) +
      count(/^\s*assert\s+(?!\()/gm),
    testCases:
      count(/(?<![.\w])(?:it|test|describe|suite|context)(?:\.(?:each|concurrent|serial))?\s*\(/g) +
      count(/^\s*(?:async\s+)?def\s+test_/gm) +
      count(/^func\s+Test[A-Z_]/gm),
    skipped: count(
      /(?<![.\w])(?:it|test|describe|suite|context)\.(?:skip|todo)\s*\(|(?<![.\w])x(?:it|test|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip(?:Now|f)?\(/g,
    ),
    focused: count(/(?<![.\w])(?:it|test|describe|suite|context)\.only\s*\(|(?<![.\w])f(?:it|describe)\s*\(/g),
  };
}

function git(targetDir: string, args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync('git', args, {
    cwd: targetDir,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: res.status === 0, stdout: res.stdout ?? '' };
}

/** Current commit of the checkout at `targetDir`, or null outside git / before the first commit. */
export function resolveGitHead(targetDir: string): string | null {
  const res = git(targetDir, ['rev-parse', '--verify', 'HEAD']);
  return res.ok ? res.stdout.trim() || null : null;
}

/** Test files and test-named scripts referenced by `package.json` test scripts. */
function testScriptReferences(packageJson: string): { scripts: Set<string>; files: Set<string> } {
  const scripts = new Set<string>();
  const files = new Set<string>();
  try {
    const pkg = JSON.parse(packageJson);
    for (const [name, command] of Object.entries<string>(pkg?.scripts ?? {})) {
      if (!/^(?:pre|post)?test(?:[:_-]|$)/.test(name) || typeof command !== 'string') continue;
      scripts.add(name);
      for (const token of command.split(/[\s;&|'"]+/)) {
        if (token && isTestFile(token)) files.add(token.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
  } catch {
    // Unparseable package.json: nothing to compare.
  }
  return { scripts, files };
}

function quoteArg(value: string): string {
  return /^[\w./@:-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Enforces that a task never deletes or weakens the test suites that existed
 * when it started: no deleted test files, no fewer assertions or cases, no new
 * skip/only markers, and no test files dropped from package.json test scripts.
 */
export class TestIntegrityGuard {
  static evaluate(targetDir: string, taskId: string): TestIntegrityReport {
    const pass = (skippedReason?: string, baselineRef: string | null = null, baselineRecorded = false): TestIntegrityReport => ({
      approved: true,
      blastRadius: 'LOW_ADDITIVE',
      ruleId: skippedReason ? 'TEST_INTEGRITY_SKIPPED' : 'TEST_INTEGRITY_OK',
      message: skippedReason ?? 'Existing test suites are intact.',
      violations: [],
      baselineRef,
      baselineRecorded,
      findings: [],
      ...(skippedReason ? { skippedReason } : {}),
    });

    if (!git(targetDir, ['rev-parse', '--is-inside-work-tree']).ok) return pass('Not a git repository; test integrity cannot be checked.');

    const recorded = CircuitBreaker.getBaseline(targetDir, taskId);
    const recordedValid = recorded ? git(targetDir, ['cat-file', '-e', `${recorded}^{commit}`]).ok : false;
    const baseline = recordedValid ? recorded! : resolveGitHead(targetDir);
    if (!baseline) return pass('Repository has no commits yet; nothing to protect.');

    const diff = git(targetDir, ['diff', '--name-status', '-M', '--relative', baseline, '--']);
    if (!diff.ok) return pass(`Could not diff against ${baseline}.`, baseline, recordedValid);

    const findings: TestIntegrityFinding[] = [];
    const baselineSource = (file: string) => {
      const res = git(targetDir, ['show', `${baseline}:./${file}`]);
      return res.ok ? res.stdout : null;
    };

    for (const line of diff.stdout.split('\n')) {
      const [status, ...paths] = line.trim().split('\t');
      if (!status || !paths.length) continue;
      const kind = status[0];
      const from = paths[0];
      const to = paths[paths.length - 1];

      if (kind === 'D' && isTestFile(from)) {
        findings.push({ rule: 'TEST_SUITE_DELETED', path: from, detail: `Test file '${from}' was deleted.` });
        continue;
      }
      if (kind === 'R' && isTestFile(from) && !isTestFile(to)) {
        findings.push({ rule: 'TEST_SUITE_DELETED', path: from, detail: `Test file '${from}' was moved out of the suite to '${to}'.` });
        continue;
      }

      if ((kind === 'M' || kind === 'R') && isTestFile(to)) {
        const before = baselineSource(from);
        let after: string | null = null;
        try {
          after = fs.readFileSync(path.join(targetDir, to), 'utf8');
        } catch {
          // Unreadable now: treat like a deletion.
        }
        if (before === null) continue;
        if (after === null) {
          findings.push({ rule: 'TEST_SUITE_DELETED', path: to, detail: `Test file '${to}' can no longer be read.` });
          continue;
        }
        const was = measureTestSuite(before);
        const now = measureTestSuite(after);
        if (now.assertions < was.assertions) {
          findings.push({ rule: 'TEST_ASSERTIONS_REMOVED', path: to, detail: `'${to}' went from ${was.assertions} to ${now.assertions} assertions.` });
        }
        if (now.testCases < was.testCases) {
          findings.push({ rule: 'TEST_CASES_REMOVED', path: to, detail: `'${to}' went from ${was.testCases} to ${now.testCases} test cases.` });
        }
        if (now.skipped > was.skipped) {
          findings.push({ rule: 'TESTS_SKIPPED', path: to, detail: `'${to}' added ${now.skipped - was.skipped} skip/todo marker(s).` });
        }
        if (now.focused > was.focused) {
          findings.push({ rule: 'TESTS_FOCUSED', path: to, detail: `'${to}' added ${now.focused - was.focused} .only marker(s), silencing the rest of the suite.` });
        }
      }

      if (kind === 'M' && to === 'package.json') {
        const before = baselineSource('package.json');
        let after = '';
        try {
          after = fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8');
        } catch {
          // Treated as an empty package.json below.
        }
        if (before !== null) {
          const was = testScriptReferences(before);
          const now = testScriptReferences(after);
          const droppedScripts = [...was.scripts].filter((s) => !now.scripts.has(s));
          const droppedFiles = [...was.files].filter((f) => !now.files.has(f));
          if (droppedScripts.length || droppedFiles.length) {
            findings.push({
              rule: 'TEST_SCRIPT_WEAKENED',
              path: 'package.json',
              detail: `package.json test scripts dropped ${[...droppedScripts.map((s) => `script '${s}'`), ...droppedFiles].join(', ')}.`,
            });
          }
        }
      }
    }

    if (!findings.length) return pass(undefined, baseline, recordedValid);
    return {
      approved: false,
      blastRadius: 'HIGH_DESTRUCTIVE',
      ruleId: 'TEST_INTEGRITY_VIOLATION',
      message: `Task changes would delete or weaken ${findings.length === 1 ? 'an existing test suite' : `existing test suites (${findings.length} findings)`}.`,
      violations: findings.map((f) => `${f.rule}: ${f.detail}`),
      baselineRef: baseline,
      baselineRecorded: recordedValid,
      findings,
    };
  }

  /**
   * Proposal to restore every flagged file from the baseline, with proof that
   * each baseline blob exists and what the restored suite measures.
   */
  static proposeRestoration(targetDir: string, report: TestIntegrityReport): TestRestorationProposal | null {
    if (report.approved || !report.baselineRef) return null;
    const started = Date.now();
    const files = [...new Set(report.findings.map((f) => f.path))];
    const baseline = report.baselineRef;

    const checks: ProofCheck[] = files.map((file) => {
      const blob = git(targetDir, ['show', `${baseline}:./${file}`]);
      if (!blob.ok) return { name: `baseline:${file}`, passed: false, detail: `No copy of '${file}' at ${baseline.slice(0, 12)}` };
      if (!isTestFile(file)) return { name: `baseline:${file}`, passed: true, detail: `Baseline copy available (${blob.stdout.length} bytes)` };
      const m = measureTestSuite(blob.stdout);
      return {
        name: `baseline:${file}`,
        passed: true,
        detail: `Restores ${m.assertions} assertions and ${m.testCases} test cases (${m.skipped} skipped, ${m.focused} focused)`,
      };
    });

    return {
      kind: 'restore_tests',
      proposalId: `heal-${crypto.randomUUID().slice(0, 8)}`,
      strategy: 'restore_test_suite',
      rationale: 'Restore the flagged test files from the task baseline, then make the implementation pass the original suite.',
      requiresHumanApproval: true,
      candidatesEvaluated: 1,
      verificationProof: {
        isolated: true,
        method: 'baseline_blob_check',
        passed: checks.length > 0 && checks.every((c) => c.passed),
        checks,
        verifiedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      },
      generatedAt: new Date().toISOString(),
      baselineRef: baseline,
      files,
      commands: [`git checkout ${baseline} -- ${files.map(quoteArg).join(' ')}`],
    };
  }
}

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
