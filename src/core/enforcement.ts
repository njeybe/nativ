/**
 * nativ-cli · Role enforcement core.
 *
 * Decides whether a file write by an agent stays inside its role: the active task's `targetFiles`,
 * never a protected contract, never a secret. Claude Code calls this through the `nativ hook check`
 * PreToolUse hook, so the boundary is enforced on the tool call itself, not by prompt text.
 *
 * Modes (`enforcement` in .nativ/config.json): `warn` (default) allows the call and tells the agent,
 * `block` denies it, `off` disables the check. The check is advisory infrastructure: anything it
 * cannot understand is allowed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EXAMPLE_ENV_FILES } from '../db/env-parser.js';
import { resolveProjectRoot } from './root-resolver.js';

export type EnforcementMode = 'off' | 'warn' | 'block';
export type ViolationRule = 'protected_path' | 'secret_path' | 'out_of_scope';
export type EnforcementDecision = 'allow' | 'warn' | 'deny';

export const DEFAULT_ENFORCEMENT_MODE: EnforcementMode = 'warn';

/** Roles other than these are treated as ordinary workers. The architect is the only role that may edit contracts. */
export const ARCHITECT_ROLE = 'architect';
export const ROLE_ENV = 'NATIV_ROLE';

/**
 * Agents that ship in a plugin report agent_type as `<plugin>:<agent>`, so nativ's own plugin architect arrives
 * as `nativ:architect`. Exactly these two names count. Stripping arbitrary prefixes would hand contract access
 * to any other plugin's `x:architect`.
 */
const ARCHITECT_ROLES: ReadonlySet<string> = new Set([ARCHITECT_ROLE, `nativ:${ARCHITECT_ROLE}`]);

/** Parses JSON that may start with a byte-order mark, which Windows PowerShell and many editors write. */
export function parseJsonLoose<T = unknown>(text: string): T {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
}

const CONFIG_FILE = path.join('.nativ', 'config.json');
const UNLOCK_FILE = path.join('.nativ', 'unlocks.json');

export interface WriteCheckInput {
  /** Path the tool wants to write, absolute or relative to `cwd`. */
  filePath: string;
  toolName: string;
  /** Working directory of the agent; decides the project root and, in a worktree, which task it belongs to. */
  cwd: string;
  /** `architect` may edit `.ai/` contracts; everything else may not. Defaults to NATIV_ROLE. */
  role?: string;
  /** Overrides the configured mode (tests and `nativ hook check --mode`). */
  mode?: EnforcementMode;
}

export interface WriteCheckResult {
  decision: EnforcementDecision;
  mode: EnforcementMode;
  rule?: ViolationRule;
  /** Human-readable explanation, addressed to the agent. */
  reason?: string;
  root: string;
  /** Path relative to the project root, forward slashes; null when the file is outside the project. */
  relPath: string | null;
  /** In-progress task(s) the write was judged against. */
  taskIds: string[];
}

interface PlanTaskLite {
  id: string;
  status: string;
  targetFiles: string[];
}

// ─── Config and unlocks ────────────────────────────────────────────────────────────────────────────

export function loadEnforcementMode(root: string): EnforcementMode {
  try {
    const raw = parseJsonLoose<{ enforcement?: unknown }>(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    if (raw.enforcement === 'off' || raw.enforcement === 'warn' || raw.enforcement === 'block') return raw.enforcement;
  } catch {
    // Missing or corrupt config means the default.
  }
  return DEFAULT_ENFORCEMENT_MODE;
}

interface UnlockFile {
  unlocks: Array<{ taskId: string; at: string; reason?: string }>;
}

function readUnlocks(root: string): UnlockFile {
  try {
    const raw = parseJsonLoose<UnlockFile>(fs.readFileSync(path.join(root, UNLOCK_FILE), 'utf8'));
    if (raw && Array.isArray(raw.unlocks)) return raw;
  } catch {
    // Fall through to empty.
  }
  return { unlocks: [] };
}

function writeUnlocks(root: string, data: UnlockFile): void {
  const file = path.join(root, UNLOCK_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function isTaskUnlocked(root: string, taskId: string): boolean {
  return readUnlocks(root).unlocks.some((u) => u.taskId === taskId);
}

/** Lifts scope enforcement for one task until it is revoked or the task stops being in progress. */
export function addTaskUnlock(root: string, taskId: string, reason?: string): void {
  const data = readUnlocks(root);
  if (data.unlocks.some((u) => u.taskId === taskId)) return;
  data.unlocks.push({ taskId, at: new Date().toISOString(), ...(reason ? { reason } : {}) });
  writeUnlocks(root, data);
}

export function removeTaskUnlock(root: string, taskId: string): boolean {
  const data = readUnlocks(root);
  const next = data.unlocks.filter((u) => u.taskId !== taskId);
  if (next.length === data.unlocks.length) return false;
  writeUnlocks(root, { unlocks: next });
  return true;
}

// ─── Path handling ─────────────────────────────────────────────────────────────────────────────────

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function comparable(p: string): string {
  const n = normalizeSlashes(p);
  return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

/**
 * Path relative to the project root with forward slashes. A path inside `.worktrees/task-<id>/` maps
 * to the same relative path in the main tree, so a worktree agent is judged by the same target files.
 * Returns null for paths outside the project.
 */
export function toProjectRelative(root: string, filePath: string, cwd: string): string | null {
  const absolute = path.resolve(cwd, filePath);
  let rel = path.relative(path.resolve(root), absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  rel = normalizeSlashes(rel);
  const worktree = /^\.worktrees\/[^/]+\/(.+)$/.exec(rel);
  return worktree ? worktree[1] : rel;
}

/** The task a working directory belongs to when it is inside `.worktrees/task-<id>`, else null. */
function worktreeTaskId(root: string, cwd: string): string | null {
  const rel = normalizeSlashes(path.relative(path.resolve(root), path.resolve(cwd)));
  const match = /^\.worktrees\/task-([^/]+)/.exec(rel);
  return match ? match[1] : null;
}

function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, CASE_INSENSITIVE ? 'i' : '');
}

/** A target entry matches an exact file, a directory prefix (`src/x` or `src/x/`), or a glob. */
export function matchesTarget(relPath: string, target: string): boolean {
  const entry = normalizeSlashes(target.trim()).replace(/^\.\//, '');
  if (!entry) return false;
  const file = comparable(relPath);
  if (/[*?]/.test(entry)) return globToRegExp(entry).test(relPath);
  const dir = comparable(entry.replace(/\/$/, ''));
  return file === dir || (entry.endsWith('/') && file.startsWith(`${dir}/`));
}

// ─── Rules ─────────────────────────────────────────────────────────────────────────────────────────

const EXAMPLE_ENV = new Set(EXAMPLE_ENV_FILES.map((f) => f.toLowerCase()));

export function isSecretPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  if (base === '.env' || (base.startsWith('.env.') && !EXAMPLE_ENV.has(base))) return true;
  if (/^\.(nativ|agentj)\/[^/]*\.local\.json$/.test(lower)) return true;
  return base.endsWith('.pem') || base.endsWith('.key');
}

/** Everything under `.ai/` is written by nativ commands or the architect, never by a worker's file tools. */
export function isProtectedContractPath(relPath: string): boolean {
  return relPath === '.ai' || relPath.toLowerCase().startsWith('.ai/');
}

function loadInProgressTasks(root: string): PlanTaskLite[] {
  try {
    const plan = parseJsonLoose<{
      milestones?: Array<{ tasks?: Array<{ id?: unknown; status?: unknown; targetFiles?: unknown }> }>;
    }>(fs.readFileSync(path.join(root, '.ai', 'master_plan.json'), 'utf8'));
    const tasks: PlanTaskLite[] = [];
    for (const milestone of plan.milestones ?? []) {
      for (const task of milestone.tasks ?? []) {
        if (typeof task.id === 'string' && task.status === 'in_progress') {
          tasks.push({
            id: task.id,
            status: task.status,
            targetFiles: Array.isArray(task.targetFiles) ? task.targetFiles.filter((f): f is string => typeof f === 'string') : [],
          });
        }
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

function verdict(mode: EnforcementMode, root: string, relPath: string | null, taskIds: string[], rule: ViolationRule, reason: string): WriteCheckResult {
  return { decision: mode === 'block' ? 'deny' : 'warn', mode, rule, reason, root, relPath, taskIds };
}

/**
 * Judges one file write. Never throws: unreadable state means "allow".
 * Order: secrets (everyone), `.ai/` contracts (non-architects), then the active task's target files.
 */
export function checkWrite(input: WriteCheckInput): WriteCheckResult {
  const root = resolveProjectRoot(input.cwd);
  const mode = input.mode ?? loadEnforcementMode(root);
  const relPath = toProjectRelative(root, input.filePath, input.cwd);
  const allow: WriteCheckResult = { decision: 'allow', mode, root, relPath, taskIds: [] };

  if (mode === 'off' || relPath === null) return allow;

  if (isSecretPath(relPath)) {
    return verdict(
      mode,
      root,
      relPath,
      [],
      'secret_path',
      `${relPath} holds credentials. Agents must not write secret files; ask the user to edit it or use \`nativ db\` for structure-only access.`,
    );
  }

  const role = (input.role ?? process.env[ROLE_ENV] ?? '').toLowerCase();
  const isArchitect = ARCHITECT_ROLES.has(role);

  if (isProtectedContractPath(relPath)) {
    if (isArchitect) return allow;
    return verdict(
      mode,
      root,
      relPath,
      [],
      'protected_path',
      `${relPath} is a protected contract. Only the architect role edits .ai/. Propose a change with \`nativ task propose-patch\` or escalate with \`nativ task escalate <taskId> --type schema_flaw --details "..."\`.`,
    );
  }

  if (isArchitect) return allow;

  let tasks = loadInProgressTasks(root);
  if (!tasks.length) return allow;

  const fromWorktree = worktreeTaskId(root, input.cwd);
  if (fromWorktree) {
    const own = tasks.filter((t) => t.id === fromWorktree);
    if (own.length) tasks = own;
  }

  const taskIds = tasks.map((t) => t.id);
  if (tasks.some((t) => isTaskUnlocked(root, t.id))) return { ...allow, taskIds };
  if (tasks.some((t) => t.targetFiles.some((target) => matchesTarget(relPath, target)))) return { ...allow, taskIds };

  const label = taskIds.length === 1 ? `task ${taskIds[0]}` : `tasks ${taskIds.join(', ')}`;
  const scope = tasks.flatMap((t) => t.targetFiles);
  return verdict(
    mode,
    root,
    relPath,
    taskIds,
    'out_of_scope',
    `${relPath} is outside the target files of ${label}` +
      `${scope.length ? ` (${scope.join(', ')})` : ''}. ` +
      'Stay inside the task scope. If this file really needs to change, run `nativ task escalate <taskId> --type architectural_ambiguity --details "..."` instead of editing it.',
  );
}

// ─── Hook I/O ──────────────────────────────────────────────────────────────────────────────────────

/** Tools whose input names the file they write, per the payloads Claude Code delivers to PreToolUse. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface HookCheck {
  /** JSON to print on stdout, or null when there is nothing to say. */
  output: Record<string, unknown> | null;
  result: WriteCheckResult | null;
}

/** Reads the path a write tool targets. Real payloads use `file_path` (`notebook_path` for notebooks); `path` is tolerated. */
export function extractWritePath(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/**
 * Turns a PreToolUse payload into the hook's answer. Warn adds context for the model; block denies the call.
 * Malformed or unrecognized payloads yield no output, which Claude Code treats as "no opinion".
 */
export function evaluateHookPayload(payload: unknown, options: { mode?: EnforcementMode; role?: string; fallbackCwd?: string } = {}): HookCheck {
  if (!payload || typeof payload !== 'object') return { output: null, result: null };
  const p = payload as Record<string, unknown>;
  if (typeof p.tool_name !== 'string' || !WRITE_TOOLS.has(p.tool_name)) return { output: null, result: null };

  const filePath = extractWritePath(p.tool_input);
  if (!filePath) return { output: null, result: null };

  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : options.fallbackCwd ?? process.cwd();
  // Inside a subagent Claude Code adds agent_type (the agent's name) to the payload; the main session has none.
  // That identity outranks NATIV_ROLE, so a worker spawned from an architect session is still judged as a worker.
  const agentType = typeof p.agent_type === 'string' && p.agent_type.trim() ? p.agent_type.trim() : undefined;
  const result = checkWrite({ filePath, toolName: p.tool_name, cwd, role: options.role ?? agentType, mode: options.mode });
  if (result.decision === 'allow') return { output: null, result };

  const reason = `nativ role enforcement: ${result.reason}`;
  if (result.decision === 'deny') {
    return {
      output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } },
      result,
    };
  }
  return {
    output: { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `${reason} (warning only; enforcement is in warn mode)` } },
    result,
  };
}
