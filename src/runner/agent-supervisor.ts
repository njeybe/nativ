import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadMasterPlan, runTaskVerification, type VerificationResult } from '../core/verifier.js';
import {
  cacheHitRate,
  computeActualCostUsd,
  emptyActualUsage,
  mergeActualUsage,
  recordRunnerUsage,
  type ActualTokenUsage,
} from '../core/telemetry.js';
import { mergeAgentWorktree } from '../core/worktree-merge.js';
import {
  resolveProjectRoot,
  linkWorktreeAiDirectory,
  safeUnlinkWorktreeAiDirectory,
  linkWorktreeNodeModules,
  safeUnlinkWorktreeNodeModules,
} from '../core/root-resolver.js';
import type { MasterPlanTask } from '../scanner/types.js';
import { resolveSpecSlices } from '../core/spec-slices.js';
import { taskEscalationHistory } from '../governor/store.js';
import { learningsForTask } from '../core/learnings.js';
import { resolveWorkerModel, toNativeModelId } from '../core/model-routing.js';
import { buildDesiredConfig, cliString, configuredInvocation, resolveCliInvocation } from '../core/setup-assets.js';

/**
 * Lifecycle phases broadcast on the `runner_status` channel. These mirror the
 * phases declared in .ai/api_contracts.json (sseChannels → runner_status).
 */
export type RunnerStatus =
  | 'spawning_worktree'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'aborted';

export const ACTIVE_RUNNER_STATUSES: readonly RunnerStatus[] = [
  'spawning_worktree',
  'running',
  'verifying',
  'merging',
];

export function isActiveStatus(status: RunnerStatus): boolean {
  return (ACTIVE_RUNNER_STATUSES as readonly string[]).includes(status);
}

/**
 * `native` drives the Messages API in-process with local bash/editor tools;
 * `cli` spawns a runner command (Claude Code by default).
 */
export type RunnerEngine = 'native' | 'cli';

export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RunnerThinking {
  /** The dispatch's `thinkingBudget`, echoed back; null when unset. */
  budget: number | null;
  /** `output_config.effort` sent to adaptive-thinking models; null otherwise. */
  effort: ThinkingEffort | null;
  /** Literal `budget_tokens` (legacy models) or `MAX_THINKING_TOKENS` (cli); null otherwise. */
  budgetTokens: number | null;
}

/** Payload of the `runner_token_usage` channel, emitted after every native turn. */
export interface RunnerTokenUsageEvent {
  runId: string;
  taskId: string;
  /** Model that served this turn (differs from the requested one after a refusal fallback). */
  model: string;
  turn: number;
  delta: ActualTokenUsage;
  total: ActualTokenUsage & { cacheHitRate: number };
  at: string;
}

/** Persisted, serializable state of a single agent execution. */
export interface RunnerRecord {
  runId: string;
  taskId: string;
  status: RunnerStatus;
  engine: RunnerEngine;
  /** Requested model; null for cli runs that keep the runner's own default. */
  model: string | null;
  thinking: RunnerThinking | null;
  /** API-reported usage accumulated across turns; null for cli runs. */
  usage: ActualTokenUsage | null;
  /** PID of the spawned process-group leader; null before spawn and after exit. */
  pid: number | null;
  /** Branch backing the isolated worktree, or null when running in place. */
  branch: string | null;
  /** Absolute worktree path, or the project root when `useWorktree` is false. */
  worktreeDir: string;
  command: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  signal: string | null;
  timeoutSeconds: number;
  timedOut: boolean;
  logBytes: number;
  logFile: string;
  error: string | null;
  abortReason: string | null;
  verification: {
    command: string;
    success: boolean;
    exitCode: number;
    durationMs: number;
    skipped: boolean;
  } | null;
}

export interface DispatchOptions {
  taskId: string;
  /** Defaults to the supervisor's `defaultEngine` (`cli` unless configured). */
  runnerEngine?: RunnerEngine;
  /** Shell command that launches the agent (cli engine only). Defaults to `defaultRunnerCommand`. */
  runnerCommand?: string;
  /**
   * Reasoning budget in tokens. Adaptive-thinking models receive it as an
   * `effort` level (they reject `budget_tokens`); legacy models receive it
   * literally; the Claude Code CLI receives it as `MAX_THINKING_TOKENS`.
   */
  thinkingBudget?: number;
  /** Model ID. Native runs default to `defaultNativeModel`; cli runs pass it as `--model`. */
  model?: string;
  /** Killswitch budget in seconds. Defaults to the supervisor's `defaultTimeoutSeconds`. */
  timeoutSeconds?: number;
  /** Run inside `.worktrees/task-<id>` on branch `agent/task-<id>`. Default true. */
  useWorktree?: boolean;
  /** Run the task's `verificationCommand` after a clean exit. Default false. */
  verify?: boolean;
  /** Merge the agent branch back after a passing verification. Default false. */
  autoMerge?: boolean;
  /** Extra environment variables handed to the child (never logged or persisted). */
  env?: Record<string, string>;
  /** Extra permission rules for the default cli runner, e.g. `Bash(pnpm test *)`. Added to the per-task allowlist. */
  allowedTools?: string[];
}

export interface AbortResult {
  taskId: string;
  runId: string;
  status: 'aborted';
  message: string;
}

export interface LogSlice {
  taskId: string;
  runId: string | null;
  status: RunnerStatus | null;
  totalBytes: number;
  log: string;
  truncated: boolean;
}

export interface ListRunsQuery {
  taskId?: string;
  activeOnly?: boolean;
}

export interface AgentSupervisorOptions {
  /** Directory used to resolve the project root holding `.ai/`. Defaults to `process.cwd()`. */
  cwd?: string;
  defaultRunnerCommand?: string;
  defaultTimeoutSeconds?: number;
  /** Hard cap on the in-memory log ring buffer per run. */
  maxLogBufferBytes?: number;
  /** Grace period between SIGTERM and the forced kill during abort/timeout. */
  killGraceMs?: number;
  /**
   * Inactivity watchdog: terminate a run that emits no output for this many seconds. Defaults to
   * `NATIV_RUNNER_IDLE_TIMEOUT`, then `DEFAULT_IDLE_TIMEOUT_SECONDS`; 0 disables it.
   */
  idleTimeoutSeconds?: number;
  /** How many finished runs to keep in memory. */
  maxHistory?: number;
  /** Engine used when a dispatch omits `runnerEngine`. Defaults to `NATIV_RUNNER_ENGINE`, then `cli`. */
  defaultEngine?: RunnerEngine;
  /** Model used by native runs that omit `model`. Defaults to `NATIV_NATIVE_MODEL`, then `DEFAULT_NATIVE_MODEL`. */
  defaultNativeModel?: string;
  /** Hard cap on API round-trips per native run. */
  nativeMaxTurns?: number;
  /** Per-command budget for the native bash tool. */
  nativeToolTimeoutMs?: number;
  /** Executables the native bash tool may invoke. */
  nativeAllowedCommands?: readonly string[];
  /** Builds the Claude API client for native runs; injectable for tests. */
  anthropicClientFactory?: () => Anthropic;
  /**
   * Shell for the native bash tool: a path to bash, or `true` for the platform default shell.
   * Defaults to NATIV_BASH_PATH, then Git Bash on Windows, then /bin/bash.
   */
  nativeShell?: string | boolean;
}

/** Structured failure carrying the `{ code, message }` shape used by the pipeline API. */
export class SupervisorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'SupervisorError';
  }
}

export const DEFAULT_RUNNER_COMMAND = 'claude';
/** Hard cap per run. Real agent tasks routinely take tens of minutes; hung runs are caught by the idle watchdog. */
export const DEFAULT_TIMEOUT_SECONDS = 3600;
/** A run that produces no output (log lines, tool activity, API turns) for this long is treated as hung. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;
export const DEFAULT_MAX_LOG_BUFFER_BYTES = 512 * 1024;
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_MAX_HISTORY = 50;
export const DEFAULT_RUNNER_ENGINE: RunnerEngine = 'cli';
export const DEFAULT_NATIVE_MODEL = 'claude-opus-5-5';
export const DEFAULT_NATIVE_EFFORT: ThinkingEffort = 'high';
export const DEFAULT_NATIVE_MAX_TURNS = 150;
export const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 10 * 60 * 1000;
export const NATIVE_MAX_OUTPUT_TOKENS = 64_000;
/** Characters of tool output handed back to the model per call. */
export const NATIVE_TOOL_OUTPUT_LIMIT = 30_000;
const NATIVE_TOOL_CAPTURE_LIMIT = 1024 * 1024;
const ROLE_GUIDE_LIMIT = 20_000;
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const DEFAULT_NATIVE_ALLOWED_COMMANDS: readonly string[] = [
  'nativ', 'node', 'npm', 'npx', 'tsx', 'tsc', 'git',
  'cd', 'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'diff', 'sort', 'uniq',
  'echo', 'printf', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'sed', 'awk', 'test', 'true', 'false',
];

interface NativeRunState {
  client: Anthropic;
  model: string;
  thinking: RunnerThinking;
  controller: AbortController;
  /** Dispatch-supplied env for tool commands; secret-looking keys are still filtered out. */
  env?: Record<string, string>;
}

interface ActiveRun {
  record: RunnerRecord;
  task: MasterPlanTask;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  buffer: string;
  aborting: boolean;
  /** Set once the run reaches a terminal status; later exits and callbacks are ignored. */
  settled: boolean;
  native: NativeRunState | null;
  /** PID of the native bash tool's current command, if one is executing. */
  toolPid: number | null;
  /** Epoch ms of the last output; drives the inactivity watchdog. */
  lastActivity: number;
  idleTimer: NodeJS.Timeout | null;
  /** The runner prints Claude Code stream-json events, one JSON object per line. */
  streamJson: boolean;
  /** Incomplete trailing line of stream-json stdout. */
  lineBuffer: string;
  /** Model reported by the stream's init event (cli runs without an explicit model). */
  streamModel: string | null;
}

/**
 * Terminates a detached process *group*. Agent runners spawn shells that spawn
 * their own children, so killing only the leader leaves orphans holding the
 * worktree open.
 */
function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

function tailLines(text: string, count: number): string {
  if (count <= 0) return '';
  const lines = text.split('\n');
  if (lines.length <= count) return text;
  return lines.slice(lines.length - count).join('\n');
}

/** Extracts the executable binary or command name, handling quoted Windows paths. */
export function extractBinary(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.startsWith('"')) {
    const nextQuote = trimmed.indexOf('"', 1);
    if (nextQuote !== -1) return trimmed.slice(1, nextQuote);
  }
  if (trimmed.startsWith("'")) {
    const nextQuote = trimmed.indexOf("'", 1);
    if (nextQuote !== -1) return trimmed.slice(1, nextQuote);
  }
  return trimmed.split(/\s+/)[0] || '';
}

/** Pre-flight check verifying whether a command binary exists in PATH or on the filesystem. */
export function isExecutableInPath(cmd: string): boolean {
  const bin = extractBinary(cmd);
  if (!bin) return false;
  if (
    path.isAbsolute(bin) ||
    bin.startsWith('./') ||
    bin.startsWith('.\\') ||
    bin.startsWith('../') ||
    bin.startsWith('..\\')
  ) {
    return fs.existsSync(bin);
  }
  try {
    const checkCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const res = spawnSync(checkCmd, [bin], { stdio: 'ignore', windowsHide: true });
    if (res.status === 0) return true;
  } catch {}

  const pathEnv = process.env.PATH || '';
  const delimiter = path.delimiter;
  const dirs = pathEnv.split(delimiter);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = path.join(dir, bin + (ext.startsWith('.') ? ext : `.${ext}`));
      try {
        if (fs.existsSync(full)) return true;
      } catch {}
    }
  }
  return false;
}

/**
 * What a dispatched agent may run without asking. `claude -p` cannot prompt, so anything not listed here is
 * denied and the agent blocks or escalates instead of running it.
 */
const RUNNER_BASE_ALLOWED_TOOLS = [
  'Bash(nativ *)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git checkout -- *)',
];

/** The pieces of a compound command as Claude Code matches them: each must satisfy an allow rule on its own. */
export function splitCompoundCommand(command: string): string[] {
  return [...new Set(command.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean))];
}

/** Operator-supplied extra rules from NATIV_RUNNER_ALLOW, comma separated, e.g. `Bash(pnpm test *),Bash(cargo test *)`. */
export function parseRunnerAllowList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((rule) => rule.trim())
    .filter((rule) => /^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$/.test(rule));
}

export interface RunnerPermissions {
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  /** Omitted when the project's own settings already run the enforcement hook, so it never runs (and logs) twice. */
  hooks?: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }> };
}

/** True when `.claude/settings.json` already registers a nativ `hook check` command. */
function projectHasEnforcementHook(rootDir: string): boolean {
  try {
    const text = fs.readFileSync(path.join(rootDir, '.claude', 'settings.json'), 'utf8');
    return /"command"\s*:\s*"[^"]*\bhook check\b/.test(text);
  } catch {
    return false;
  }
}

/**
 * Settings handed to a dispatched agent with `--settings`. The deny and ask rules and the enforcement hook come
 * from the same source as `nativ setup`, so a dispatched agent is guarded even in a project where setup never ran.
 */
export function buildRunnerPermissions(
  task: Pick<MasterPlanTask, 'verificationCommand'>,
  rootDir: string,
  extraAllowed: readonly string[] = [],
): RunnerPermissions {
  const invocation = configuredInvocation(rootDir) ?? resolveCliInvocation({});
  const desired = buildDesiredConfig(invocation);
  const cli = cliString(invocation);

  const allow = [
    ...RUNNER_BASE_ALLOWED_TOOLS,
    ...(cli === 'nativ' ? [] : [`Bash(${cli} *)`]),
    ...splitCompoundCommand(task.verificationCommand ?? '').map((command) => `Bash(${command})`),
    ...extraAllowed,
  ];
  return {
    permissions: { allow: [...new Set(allow)], deny: desired.deny, ask: desired.ask },
    ...(projectHasEnforcementHook(rootDir)
      ? {}
      : { hooks: { PreToolUse: [{ matcher: desired.preToolUse.matcher, hooks: [{ type: 'command' as const, command: desired.preToolUse.command, timeout: desired.preToolUse.timeout }] }] } }),
  };
}

/** Where a task's runner settings live: a subdirectory, because run history parses every top-level .json in runs/. */
export function runnerSettingsPath(runsDir: string, taskId: string): string {
  return path.join(runsDir, 'permissions', `${taskId}.json`).replace(/\\/g, '/');
}

export function writeRunnerSettings(runsDir: string, taskId: string, settings: RunnerPermissions): string {
  const file = runnerSettingsPath(runsDir, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return file;
}

/** The instructions text handed to the agent on its standard input. */
export function buildRunnerPrompt(task: MasterPlanTask): string {
  return [
    `Execute task ${task.id} (${task.title}).`,
    task.description ? `Description: ${task.description}.` : '',
    task.verificationCommand ? `Verify your work using: ${task.verificationCommand}.` : '',
    `Start by running: nativ task start ${task.id}. When finished and verified, run: nativ task complete ${task.id}.`,
    `If blocked, follow the Human-Centric Communication Protocol in CLAUDE.md: explain the user experience symptom, root cause in plain English, and clear options without technical jargon.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Arguments for Claude Code CLI to run headless. The prompt goes on stdin, never in this string:
 * quotes or symbols in task text would break the shell.
 *
 * It runs in `acceptEdits` mode with the rules in `settingsFile` (see buildRunnerPermissions); it does not bypass
 * permissions. Without a settings file only the file-edit tools and read-only commands are pre-approved.
 */
export function buildDefaultClaudeCommand(_task: MasterPlanTask, model?: string | null, settingsFile?: string): string {
  const modelFlag = model ? ` --model ${model}` : '';
  // Plain `claude -p` prints nothing until it finishes; stream-json emits every message and tool call as it happens.
  const settingsFlag = settingsFile ? ` --settings "${settingsFile}"` : '';
  return `claude -p${modelFlag} --output-format stream-json --verbose --permission-mode acceptEdits${settingsFlag}`;
}

/** True when a runner command asks Claude Code for its line-delimited JSON event stream. */
export function usesClaudeStreamJson(command: string): boolean {
  return /--output-format(?:=|\s+)stream-json\b/.test(command);
}

/** Final `result` event of a Claude Code stream: grounded usage for cli runs. */
export interface ClaudeStreamResult {
  isError: boolean;
  turns: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ClaudeStreamLine {
  /** Human-readable log text (newline-terminated), or null when the event is not worth showing. */
  text: string | null;
  model?: string;
  result?: ClaudeStreamResult;
}

function firstLine(text: unknown, max = 200): string {
  const line = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}...` : line.trim();
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description;
  return typeof pick === 'string' ? firstLine(pick, 160) : firstLine(JSON.stringify(input), 160);
}

const finiteCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Turns one line of `claude -p --output-format stream-json` into a log line. Anything that is not
 * a recognised event (warnings, custom runners, future event types) passes through or is dropped,
 * never thrown on.
 */
export function formatClaudeStreamLine(line: string): ClaudeStreamLine {
  const trimmed = line.trim();
  if (!trimmed) return { text: null };
  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { text: `${line}\n` };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { text: `${line}\n` };

  switch (event.type) {
    case 'system': {
      if (event.subtype !== 'init') return { text: null };
      const model = typeof event.model === 'string' ? event.model : undefined;
      const tools = Array.isArray(event.tools) ? ` · ${event.tools.length} tools` : '';
      return { text: `[claude] session started · model ${model ?? 'default'}${tools}\n`, model };
    }
    case 'assistant': {
      const lines: string[] = [];
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type === 'text' && String(block.text ?? '').trim()) lines.push(String(block.text).trim());
        else if (block?.type === 'thinking' && String(block.thinking ?? '').trim()) lines.push(`[claude:thinking] ${firstLine(block.thinking, 300)}`);
        else if (block?.type === 'tool_use') lines.push(`[claude] ${block.name}: ${describeToolInput(block.input)}`);
      }
      return { text: lines.length ? `${lines.join('\n')}\n` : null };
    }
    case 'user': {
      const lines: string[] = [];
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type !== 'tool_result') continue;
        const body = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join('\n') : '';
        const summary = firstLine(body, 160);
        if (block.is_error) lines.push(`[claude]   error: ${summary || 'tool failed'}`);
        else if (summary) lines.push(`[claude]   ${summary}`);
      }
      return { text: lines.length ? `${lines.join('\n')}\n` : null };
    }
    case 'result': {
      const usage = event.usage ?? {};
      const cost = typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null;
      const turns = finiteCount(event.num_turns);
      const seconds = finiteCount(event.duration_ms) ? ` · ${Math.round(event.duration_ms / 1000)}s` : '';
      const kind = event.subtype && event.subtype !== 'success' ? ` (${event.subtype})` : '';
      const text =
        `[claude] ${event.is_error ? 'finished with an error' : 'finished'}${kind}` +
        (turns ? ` · ${turns} turns` : '') + (cost !== null ? ` · $${cost.toFixed(4)}` : '') + seconds + '\n';
      return {
        text,
        result: {
          isError: Boolean(event.is_error),
          turns,
          costUsd: cost,
          inputTokens: finiteCount(usage.input_tokens),
          outputTokens: finiteCount(usage.output_tokens),
          cacheCreationTokens: finiteCount(usage.cache_creation_input_tokens),
          cacheReadTokens: finiteCount(usage.cache_read_input_tokens),
        },
      };
    }
    default:
      return { text: null };
  }
}

// ─── Native engine: request shaping ─────────────────────────────────────────

/** Models that predate adaptive thinking and still take `thinking.budget_tokens`. */
export function usesLegacyThinkingBudget(model: string): boolean {
  return /^claude-(3-|haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|(sonnet|opus)-4-\d{8})/.test(model);
}

/**
 * Buckets a token budget into an effort level. Current models reject `budget_tokens`, so the
 * contract's numeric `thinkingBudget` maps onto effort. The buckets follow the Studio's budget
 * chips: 0 ("None, fast") is the least thinking a model allows, 2,048 ("Standard") is the
 * standard effort, 4,096 ("Deep") is high, and larger budgets reach xhigh and max.
 */
export function thinkingBudgetToEffort(budget: number): ThinkingEffort {
  if (budget <= 0) return 'low';
  if (budget <= 2_048) return 'medium';
  if (budget <= 8_192) return 'high';
  if (budget <= 32_768) return 'xhigh';
  return 'max';
}

export function resolveNativeThinking(model: string, budget: number | null): RunnerThinking {
  if (usesLegacyThinkingBudget(model)) {
    // budget_tokens must be >= 1024 and below max_tokens; no budget (or 0) means no thinking.
    const budgetTokens =
      budget === null || budget <= 0 ? null : Math.min(Math.max(Math.floor(budget), 1024), NATIVE_MAX_OUTPUT_TOKENS - 1);
    return { budget, effort: null, budgetTokens };
  }
  let effort = budget === null ? defaultNativeEffort(model) : thinkingBudgetToEffort(budget);
  // xhigh arrived with Opus 4.7; the 4.6 generation tops out below it.
  if (effort === 'xhigh' && /-4-6(\b|$)/.test(model)) effort = 'high';
  return { budget, effort, budgetTokens: null };
}

/**
 * Effort used when a dispatch sets no `thinkingBudget`. Claude Opus 5.5 at
 * `medium` outperforms Claude Opus 5 at `high` on coding work, so it starts lower.
 */
export function defaultNativeEffort(model: string): ThinkingEffort {
  return model === 'claude-opus-5-5' ? 'medium' : DEFAULT_NATIVE_EFFORT;
}

/** Models that opt into server-side refusal fallbacks by default. */
export function supportsServerFallback(model: string): boolean {
  // Disabled to prevent automatic re-routing to expensive models (like Fable) and protect user budget.
  return false;
}

// Frozen so the tools + system prefix stays byte-identical and cacheable across
// turns and runs: nothing per-task, per-run, or time-dependent belongs here.
const NATIVE_SYSTEM_PROMPT = `You are an autonomous engineering agent: a worker in the execution tier of a three-tier development pipeline, dispatched by nativ (the project-manager tier). You complete one task from .ai/master_plan.json on your own, with no human watching each step.

Your environment:
- The working directory is the task's workspace root. Each bash command runs in a fresh POSIX shell started there, so \`cd\` and exported variables do not persist between commands; chain with && when you need them.
- Use str_replace_based_edit_tool with paths relative to the workspace root. Files under .ai/, node_modules/ and .git/ are read-only.
- Commands are checked against an allowlist of executables. Command substitution, background jobs, absolute paths, parent-directory paths, secret files and publishing (git push, npm publish) are rejected with a reason; adjust and continue.

How to work:
1. Run \`nativ task start <taskId>\` before changing code.
2. Change only the files in the task's targetFiles. Follow the contracts in .ai/ exactly: table and column names, routes and schemas, and design tokens. Match the style of the surrounding code.
3. Run the task's verificationCommand. If it fails, fix the cause and run it again; you have at most three fix attempts. If it still fails, run \`git checkout -- <targetFiles>\`, then \`nativ task block <taskId> --reason "Verification failed after 3 attempts: <short error>"\`, and stop.
4. If a contract in .ai/ lacks something the task needs, do not edit it. Run \`nativ task escalate <taskId> --type schema_flaw --details "<the gap>"\` and stop.
5. When verification passes, run \`nativ task complete <taskId>\`.

Code style (the project's own formatter or linter config wins): lines 100 characters or fewer, hard max 120; functions about 40 lines, files about 300; split a growing UI file into components, one per file; comments at most 2 lines, say why not what, plain everyday words, no restating the code, no banner comments, no commented-out code; match the surrounding code.

Secrets: never open .env files (.env.example is fine), *.pem, *.key or .nativ/*.local.json, and never print environment variables. For database structure use \`nativ db status|inspect|diff --json\`; never read table data.

When you finish or get blocked, end with a short plain-English summary: what changed, the verification result, and anything the operator must decide. Do not call a tool in that final message.`;

const NATIVE_TOOLS: Anthropic.Beta.Messages.BetaToolUnion[] = [
  { type: 'bash_20250124', name: 'bash' },
  { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool', max_characters: NATIVE_TOOL_OUTPUT_LIMIT },
];

function buildSpecSlicesBlock(task: MasterPlanTask, rootDir: string | undefined): string {
  if (!rootDir || !task.specRefs?.length) return '';
  const { slices, warnings } = resolveSpecSlices(rootDir, task.specRefs);
  if (!slices.length && !warnings.length) return '';
  const parts = slices.map((s) => `<slice ref="${s.ref}" file="${s.file}"${s.truncated ? ' truncated="true"' : ''}>\n${s.text}\n</slice>`);
  if (warnings.length) parts.push(`<warnings>\n${warnings.join('\n')}\n</warnings>`);
  return `<spec_slices>\n${parts.join('\n')}\n</spec_slices>\nThe spec slices above are the parts of the contracts this task refers to. Read a whole contract only when a slice is missing, truncated or does not answer your question.`;
}

function buildPriorEscalationsBlock(task: MasterPlanTask, rootDir: string | undefined): string {
  if (!rootDir) return '';
  const history = taskEscalationHistory(rootDir, task.id);
  if (!history.length) return '';
  const lines = history.map((e) => {
    const outcome = e.resolutionNotes ? `\nOutcome: ${e.resolutionNotes}` : '';
    return `${e.id} (${e.type}, ${e.status}): ${e.summary}${outcome}`;
  });
  return `<prior_escalations>\n${lines.join('\n')}\n</prior_escalations>\nThis task was escalated before. Follow how each gap was settled; do not raise a settled gap again.`;
}

function buildLearningsBlock(task: MasterPlanTask, rootDir: string | undefined): string {
  if (!rootDir) return '';
  const learnings = learningsForTask(rootDir, task);
  if (!learnings.length) return '';
  const lines = learnings.map((l) => `${l.id}: ${l.insight}${l.details ? `\n${l.details}` : ''}`);
  return `<learnings>\n${lines.join('\n')}\n</learnings>\nThese are approved lessons from earlier work on this project. Follow them.`;
}

function buildNativeTaskPrompt(task: MasterPlanTask, roleGuide: string | null, useWorktree: boolean, rootDir?: string): string {
  const spec = {
    id: task.id,
    title: task.title,
    description: task.description,
    assignedSubagent: task.assignedSubagent,
    targetFiles: task.targetFiles,
    verificationCommand: task.verificationCommand,
    dependencies: task.dependencies,
    notes: task.notes,
  };
  return [
    `Execute task ${task.id}.`,
    `<task>\n${JSON.stringify(spec, null, 2)}\n</task>`,
    roleGuide ? `<role_guide path=".ai/subagents/${task.assignedSubagent}.md">\n${roleGuide}\n</role_guide>` : '',
    buildSpecSlicesBlock(task, rootDir),
    buildPriorEscalationsBlock(task, rootDir),
    buildLearningsBlock(task, rootDir),
    'Load only the contract slice your role needs (.ai/api_contracts.json, .ai/db_schema.json, .ai/ui_specs.md, .ai/context.md) with the editor view command.',
    useWorktree
      ? 'You are in an isolated git worktree on the agent branch. After `nativ task complete` succeeds, commit the target files there (`git add <targetFiles> && git commit -m "<type>(<scope>): <summary>"`) so the operator can merge the branch.'
      : 'You are working directly in the project checkout; do not commit.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function describeNativeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Claude API authentication failed. Set ANTHROPIC_API_KEY (or run `ant auth login`) in the environment that launches nativ.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) return `Claude API permission denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Claude API returned 404 (check the model ID): ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return `Claude API rate limit persisted after retries: ${err.message}`;
  if (err instanceof Anthropic.BadRequestError) return `Claude API rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ─── Native engine: local tools ─────────────────────────────────────────────

/** Rejection returned to the model as an `is_error` tool result so it can adjust. */
class ToolInputError extends Error {}

/** .env* (except .env.example), *.pem, *.key and .nativ|.agentj/*.local.json. */
const SECRET_PATH_PATTERN =
  /(^|[\\/\s'"=])(\.env(?!\.example\b)[\w.-]*|[\w.-]+\.(pem|key)|\.(nativ|agentj)[\\/][\w.-]*\.local\.json)(?=$|[\s'";|&)])/i;

/** Top-level directories of POSIX, macOS and Git Bash (/c/, /d/ drive mounts) filesystems. */
const FILESYSTEM_ROOT =
  /^\/(etc|usr|bin|sbin|lib|lib32|lib64|libx32|opt|var|tmp|home|root|proc|sys|dev|mnt|media|srv|boot|run|snap|private|System|Users|Volumes|Library|Applications|[A-Za-z])(\/|$)/;

/** Credentials never reach the model's shell: it could print them. */
const SECRET_ENV_PATTERN = /^ANTHROPIC_|^CLAUDE_CODE_OAUTH|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|DATABASE_URL|_DSN$|CREDENTIAL/i;

function buildToolEnv(...sources: Array<Record<string, string | undefined> | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined && !SECRET_ENV_PATTERN.test(key)) env[key] = value;
    }
  }
  return env;
}

/** Claude Code's own credentials and provider settings: the cli runner cannot start without them. */
const CLAUDE_CODE_AUTH_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|CUSTOM_HEADERS|BETAS|VERTEX_PROJECT_ID)|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+)$/;
const AWS_ENV = /^AWS_[A-Z0-9_]+$/;

/**
 * Environment for cli runners. The agent inside can run the commands its allowlist permits (and any custom
 * runner command runs unrestricted), so it can print anything it inherits: credential-looking variables are
 * withheld, except the ones Claude
 * Code itself authenticates with (and AWS credentials when it is configured for Bedrock).
 * NATIV_RUNNER_PASS_ENV="NAME1,NAME2" passes extra variables through deliberately; variables an
 * operator hands to dispatch() explicitly are also passed as-is.
 */
export function buildRunnerEnv(base: NodeJS.ProcessEnv, explicit?: Record<string, string>): NodeJS.ProcessEnv {
  const passThrough = new Set(
    String(base.NATIV_RUNNER_PASS_ENV ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const bedrock = Boolean(base.CLAUDE_CODE_USE_BEDROCK);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const allowed =
      !SECRET_ENV_PATTERN.test(key) || CLAUDE_CODE_AUTH_ENV.test(key) || passThrough.has(key) || (bedrock && AWS_ENV.test(key));
    if (allowed) env[key] = value;
  }
  return { ...env, ...explicit };
}

/**
 * Best-effort policy for model-authored shell commands. The worktree is the
 * real boundary (as with the cli engine); this blocks the obvious escapes and
 * keeps every executable on an allowlist. Returns the rejection reason, or null.
 */
export function checkNativeBashCommand(command: string, allowed: ReadonlySet<string>): string | null {
  if (/`|\$\(/.test(command)) return 'Command substitution (backticks or $(...)) is not allowed.';
  if (/(^|[^&>])&(?![&>])/.test(command)) return 'Background jobs (&) are not allowed.';
  if (SECRET_PATH_PATTERN.test(command)) {
    return 'Secret files (.env, *.pem, *.key, .nativ/*.local.json) are off-limits; only .env.example may be read.';
  }
  if (/\bgit\s+push\b|\bnpm\s+publish\b/.test(command)) {
    return 'Publishing actions (git push, npm publish) are reserved for the operator.';
  }

  for (const token of command.split(/\s+/)) {
    const raw = token.replace(/^\d*[<>]+&?/, '');
    // Quoting must not smuggle a path past the checks: look through one layer of quotes.
    const quoted = /^['"]/.test(raw);
    const bare = raw.replace(/^['"]+|['"]+$/g, '');
    if (!bare || bare === '/dev/null') continue;
    if (/^(~|\$\{?(HOME|USERPROFILE)\}?|%USERPROFILE%)/i.test(bare)) {
      return `Home-directory path '${bare}' points outside the workspace; use paths relative to the workspace root.`;
    }
    // Unquoted slash paths are always paths. A quoted one may be a search pattern ("/api/events"),
    // so it is refused only when it starts at a real filesystem root.
    if (/^[A-Za-z]:[\\/]/.test(bare) || (bare.startsWith('/') && (!quoted || FILESYSTEM_ROOT.test(bare)))) {
      return `Absolute path '${bare}' points outside the workspace; use paths relative to the workspace root.`;
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(bare)) return `Parent-directory path '${bare}' escapes the workspace.`;
  }

  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (!words.length) continue;
    const bin = path.basename(words[0].replace(/^['"]|['"]$/g, '')).replace(/\.(exe|cmd|bat)$/i, '');
    if (!allowed.has(bin)) {
      return `'${bin}' is not on the command allowlist (${[...allowed].join(', ')}).`;
    }
  }
  return null;
}

/** POSIX bash for the model's commands; Git Bash on Windows, else the platform shell. */
function resolveToolShell(): string | boolean {
  const override = process.env.NATIV_BASH_PATH;
  if (override && fs.existsSync(override)) return override;
  if (process.platform !== 'win32') return fs.existsSync('/bin/bash') ? '/bin/bash' : true;
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p)) ?? true;
}

function clipToolOutput(text: string, omitted = 0): string {
  const total = text.length + omitted;
  if (total <= NATIVE_TOOL_OUTPUT_LIMIT) return text;
  const head = Math.floor(NATIVE_TOOL_OUTPUT_LIMIT * 0.4);
  const tail = NATIVE_TOOL_OUTPUT_LIMIT - head;
  return `${text.slice(0, head)}\n\n[... ${total - NATIVE_TOOL_OUTPUT_LIMIT} characters omitted ...]\n\n${text.slice(-tail)}`;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolves symlinks/junctions on the nearest existing ancestor of a possibly new path. */
function canonicalize(target: string): string {
  let current = target;
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...rest);
  } catch {
    return target;
  }
}

/**
 * Confines a model-supplied editor path to the workspace. Reads may follow the
 * `.ai/` and `node_modules/` junctions the supervisor mounts into worktrees;
 * writes may not touch them at all.
 */
function resolveEditorPath(workspace: string, projectRoot: string, raw: unknown, mode: 'read' | 'write'): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ToolInputError('"path" is required.');
  if (/%2e|%2f|%5c/i.test(raw)) throw new ToolInputError('URL-encoded path segments are not allowed.');

  const root = path.resolve(workspace);
  const target = path.resolve(root, raw);
  if (!isWithin(root, target)) throw new ToolInputError(`Path '${raw}' is outside the workspace.`);

  const rel = path.relative(root, target);
  if (SECRET_PATH_PATTERN.test(` ${rel}`)) {
    throw new ToolInputError('Secret files (.env, *.pem, *.key, .nativ/*.local.json) are off-limits; only .env.example may be read.');
  }
  const top = rel.split(/[\\/]/)[0];
  if (mode === 'write' && (top === '.ai' || top === 'node_modules' || top === '.git')) {
    throw new ToolInputError(`'${top}/' is read-only; contract changes go through \`nativ task escalate\`.`);
  }

  const allowedRoots = [canonicalize(root)];
  if (mode === 'read') {
    allowedRoots.push(canonicalize(path.join(projectRoot, '.ai')), canonicalize(path.join(projectRoot, 'node_modules')));
  }
  if (!allowedRoots.some((r) => isWithin(r, canonicalize(target)))) {
    throw new ToolInputError(`Path '${raw}' resolves outside the workspace.`);
  }
  return target;
}

function requireString(input: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw new ToolInputError(`"${key}" must be a${allowEmpty ? '' : ' non-empty'} string.`);
  }
  return value;
}

/** Client-side implementation of the text_editor_20250728 commands. */
function runEditorCommand(workspace: string, projectRoot: string, input: Record<string, unknown>): string {
  const command = input.command;
  const rawPath = input.path;

  switch (command) {
    case 'view': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'read');
      if (!fs.existsSync(target)) throw new ToolInputError(`Path '${rawPath}' does not exist.`);
      if (fs.statSync(target).isDirectory()) {
        const entries = fs
          .readdirSync(target, { withFileTypes: true })
          .filter((e) => e.name !== '.git')
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return entries.join('\n') || '(empty directory)';
      }
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
      let start = 1;
      let end = lines.length;
      if (input.view_range !== undefined) {
        const range = input.view_range;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)) {
          throw new ToolInputError('"view_range" must be [startLine, endLine] (endLine -1 reads to the end).');
        }
        start = Math.max(1, range[0]);
        end = range[1] === -1 ? lines.length : Math.min(lines.length, range[1]);
        if (start > end) throw new ToolInputError(`Invalid view_range [${range.join(', ')}] for a ${lines.length}-line file.`);
      }
      const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`).join('\n');
      return clipToolOutput(numbered);
    }

    case 'create': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'write');
      const text = requireString(input, 'file_text', true);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
      return `File created successfully at: ${rawPath}`;
    }

    case 'str_replace': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'write');
      if (!fs.existsSync(target)) throw new ToolInputError(`File '${rawPath}' does not exist.`);
      const content = fs.readFileSync(target, 'utf8');
      let oldStr = requireString(input, 'old_str');
      let newStr = input.new_str === undefined ? '' : requireString(input, 'new_str', true);

      let count = content.split(oldStr).length - 1;
      if (count === 0 && content.includes('\r\n') && !oldStr.includes('\r\n')) {
        // The model writes LF; retry against CRLF files before reporting a miss.
        oldStr = oldStr.replace(/\n/g, '\r\n');
        newStr = newStr.replace(/\r?\n/g, '\r\n');
        count = content.split(oldStr).length - 1;
      }
      if (count === 0) {
        throw new ToolInputError('No match found for old_str. Check whitespace and indentation against a fresh view of the file.');
      }
      if (count > 1) {
        throw new ToolInputError(`Found ${count} matches for old_str; include more surrounding context so it is unique.`);
      }
      fs.writeFileSync(target, content.replace(oldStr, () => newStr), 'utf8');
      return 'Successfully replaced text at exactly one location.';
    }

    case 'insert': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'write');
      if (!fs.existsSync(target)) throw new ToolInputError(`File '${rawPath}' does not exist.`);
      const content = fs.readFileSync(target, 'utf8');
      const text = requireString(input, 'insert_text', true);
      const eol = content.includes('\r\n') ? '\r\n' : '\n';
      const lines = content.split(/\r?\n/);
      const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      const after = input.insert_line;
      if (typeof after !== 'number' || !Number.isInteger(after) || after < 0 || after > lineCount) {
        throw new ToolInputError(`"insert_line" must be an integer between 0 and ${lineCount}.`);
      }
      lines.splice(after, 0, ...text.split(/\r?\n/));
      fs.writeFileSync(target, lines.join(eol), 'utf8');
      return `Inserted text after line ${after}.`;
    }

    default:
      throw new ToolInputError(`Unsupported editor command '${String(command)}'. Use view, create, str_replace or insert.`);
  }
}

function normalizeEngine(value: unknown, fallback: RunnerEngine): RunnerEngine {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'native' || value === 'cli') return value;
  throw new SupervisorError('VALIDATION_ERROR', `"runnerEngine" must be 'native' or 'cli'`);
}

/** 0 is a valid budget: "as little thinking as the model allows". */
function normalizeThinkingBudget(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SupervisorError('VALIDATION_ERROR', '"thinkingBudget" must be a non-negative number');
  }
  return Math.floor(value);
}

function normalizeModel(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][\w.:@-]{0,127}$/.test(value.trim())) {
    throw new SupervisorError('VALIDATION_ERROR', '"model" must be a model ID such as claude-opus-5');
  }
  return value.trim();
}

/**
 * Supervises autonomous agent runs: detached spawn inside an isolated git
 * worktree, a timeout killswitch, a bounded streaming log buffer, and
 * local-first persistence under `.nativ/runs/` (structure only, never secrets).
 *
 * Emits `runner_status` and `runner_log` events for SSE fan-out.
 */
export class AgentSupervisor extends EventEmitter {
  private readonly rootDir: string;
  private readonly runsDir: string;
  private readonly defaultRunnerCommand: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxLogBufferBytes: number;
  private readonly killGraceMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxHistory: number;
  private readonly defaultEngine: RunnerEngine;
  private readonly defaultNativeModel: string;
  private readonly nativeMaxTurns: number;
  private readonly nativeToolTimeoutMs: number;
  private readonly nativeAllowedCommands: ReadonlySet<string>;
  private readonly anthropicClientFactory: () => Anthropic;
  private readonly toolShell: string | boolean;
  private readonly active = new Map<string, ActiveRun>();
  private history: RunnerRecord[] = [];
  private closed = false;

  constructor(options: AgentSupervisorOptions = {}) {
    super();
    this.rootDir = resolveProjectRoot(options.cwd);
    this.runsDir = path.join(this.rootDir, '.nativ', 'runs');
    this.defaultRunnerCommand =
      options.defaultRunnerCommand ?? process.env.NATIV_RUNNER_COMMAND ?? DEFAULT_RUNNER_COMMAND;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.maxLogBufferBytes = options.maxLogBufferBytes ?? DEFAULT_MAX_LOG_BUFFER_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const idleSeconds = options.idleTimeoutSeconds ?? Number(process.env.NATIV_RUNNER_IDLE_TIMEOUT ?? DEFAULT_IDLE_TIMEOUT_SECONDS);
    this.idleTimeoutMs = Number.isFinite(idleSeconds) && idleSeconds > 0 ? idleSeconds * 1000 : 0;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.defaultEngine = normalizeEngine(
      options.defaultEngine ?? process.env.NATIV_RUNNER_ENGINE,
      DEFAULT_RUNNER_ENGINE,
    );
    this.defaultNativeModel =
      normalizeModel(options.defaultNativeModel ?? process.env.NATIV_NATIVE_MODEL) ?? DEFAULT_NATIVE_MODEL;
    this.nativeMaxTurns = options.nativeMaxTurns ?? DEFAULT_NATIVE_MAX_TURNS;
    this.nativeToolTimeoutMs = options.nativeToolTimeoutMs ?? DEFAULT_NATIVE_TOOL_TIMEOUT_MS;
    this.nativeAllowedCommands = new Set(options.nativeAllowedCommands ?? DEFAULT_NATIVE_ALLOWED_COMMANDS);
    this.anthropicClientFactory = options.anthropicClientFactory ?? (() => new Anthropic());
    this.toolShell = options.nativeShell ?? resolveToolShell();
    this.restoreHistory();
  }

  get projectRoot(): string {
    return this.rootDir;
  }

  // ─── Dispatch ───────────────────────────────────────────────────────────────

  async dispatch(options: DispatchOptions): Promise<RunnerRecord> {
    if (this.closed) throw new SupervisorError('SHUTTING_DOWN', 'Supervisor is shutting down', 503);

    const taskId = (options.taskId || '').trim();
    if (!taskId) throw new SupervisorError('VALIDATION_ERROR', '"taskId" is required');
    if (this.active.has(taskId)) {
      throw new SupervisorError('TASK_ALREADY_RUNNING', `Task '${taskId}' already has a runner in flight`);
    }

    const task = this.requireTask(taskId);
    this.assertDependenciesMet(task);

    const engine = normalizeEngine(options.runnerEngine, this.defaultEngine);
    const thinkingBudget = normalizeThinkingBudget(options.thinkingBudget);
    const explicitModel = normalizeModel(options.model);
    const routedModel = explicitModel ? null : resolveWorkerModel(this.rootDir, task);
    const requestedModel = explicitModel ?? (routedModel && engine === 'cli' ? routedModel : null);
    const timeoutSeconds = this.normalizeTimeout(options.timeoutSeconds);
    const useWorktree = options.useWorktree !== false;
    const worktreeDir = useWorktree ? path.join(this.rootDir, '.worktrees', `task-${taskId}`) : this.rootDir;

    let command: string;
    let native: NativeRunState | null = null;
    let thinking: RunnerThinking | null = null;

    if (engine === 'native') {
      // The model writes POSIX shell; Windows' cmd.exe fallback would fail on nearly every command.
      if (process.platform === 'win32' && this.toolShell === true) {
        throw new SupervisorError(
          'BASH_NOT_FOUND',
          'The native engine runs the model\'s commands in bash, which was not found. Install Git for Windows (it ships Git Bash) or set NATIV_BASH_PATH to bash.exe.',
        );
      }
      const model =
        requestedModel ??
        (routedModel ? toNativeModelId(routedModel, DEFAULT_NATIVE_MODEL) : this.defaultNativeModel);
      thinking = resolveNativeThinking(model, thinkingBudget);
      native = {
        client: this.createAnthropicClient(),
        model,
        thinking,
        controller: new AbortController(),
        env: options.env,
      };
      command = `nativ native-engine --model ${model}`;
    } else {
      let rawCommand = (options.runnerCommand || '').trim() || this.defaultRunnerCommand;
      if (rawCommand === 'claude') {
        if (!isExecutableInPath('claude')) {
          throw new SupervisorError(
            'CLAUDE_NOT_FOUND',
            "The 'claude' CLI executable was not found in PATH. Install Claude Code (npm install -g @anthropic-ai/claude-code), configure runnerCommand / NATIV_RUNNER_COMMAND, or dispatch with runnerEngine 'native'.",
          );
        }
        const extraAllowed = [...parseRunnerAllowList(process.env.NATIV_RUNNER_ALLOW), ...(options.allowedTools ?? [])];
        const settingsFile = writeRunnerSettings(this.runsDir, taskId, buildRunnerPermissions(task, this.rootDir, extraAllowed));
        rawCommand = buildDefaultClaudeCommand(task, requestedModel, settingsFile);
      }
      command = rawCommand
        .replace(/\{taskId\}/g, taskId)
        .replace(/\{taskTitle\}/g, task.title)
        .replace(/\{worktreeDir\}/g, worktreeDir);
      // 0 ("no extra thinking") leaves Claude Code on its own default rather than exporting MAX_THINKING_TOKENS=0.
      if (thinkingBudget !== null) thinking = { budget: thinkingBudget, effort: null, budgetTokens: thinkingBudget > 0 ? thinkingBudget : null };
    }

    const record: RunnerRecord = {
      runId: randomUUID(),
      taskId,
      status: useWorktree ? 'spawning_worktree' : 'running',
      engine,
      model: native?.model ?? requestedModel,
      thinking,
      usage: native ? emptyActualUsage(native.model) : null,
      pid: null,
      branch: useWorktree ? `agent/task-${taskId}` : null,
      worktreeDir,
      command,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      exitCode: null,
      signal: null,
      timeoutSeconds,
      timedOut: false,
      logBytes: 0,
      logFile: path.join(this.runsDir, `${taskId}.log`),
      error: null,
      abortReason: null,
      verification: null,
    };

    const run: ActiveRun = {
      record,
      task,
      child: null,
      timer: null,
      killTimer: null,
      buffer: '',
      aborting: false,
      settled: false,
      native,
      toolPid: null,
      lastActivity: Date.now(),
      idleTimer: null,
      streamJson: !native && usesClaudeStreamJson(command),
      lineBuffer: '',
      streamModel: null,
    };
    this.active.set(taskId, run);
    this.resetLogFile(record);
    this.emitStatus(record);

    if (useWorktree) {
      try {
        this.provisionWorktree(record);
      } catch (err: any) {
        this.finalize(run, 'failed', { error: `Worktree provisioning failed: ${err.message}` });
        throw new SupervisorError('WORKTREE_FAILED', `Worktree provisioning failed: ${err.message}`);
      }
      record.status = 'running';
      this.emitStatus(record);
    }

    try {
      if (native) this.startNativeRun(run, options, useWorktree);
      else this.spawnRunner(run, task, options);
    } catch (err: any) {
      this.finalize(run, 'failed', { error: `Failed to spawn runner: ${err.message}` });
      throw new SupervisorError('SPAWN_FAILED', `Failed to spawn runner: ${err.message}`);
    }

    this.persist(record);
    return { ...record };
  }

  // ─── Abort ──────────────────────────────────────────────────────────────────

  async abort(taskId: string, reason?: string): Promise<AbortResult> {
    const run = this.active.get(taskId);
    if (!run) throw new SupervisorError('TASK_NOT_RUNNING', `No active runner for task '${taskId}'`);

    run.aborting = true;
    run.record.abortReason = reason ?? 'Aborted by operator';
    this.clearTimers(run);
    this.interruptNative(run);

    const pid = run.record.pid;
    if (pid !== null) {
      killProcessTree(pid, 'SIGTERM');
      run.killTimer = setTimeout(() => {
        if (this.active.has(taskId) && isPidAlive(pid)) killProcessTree(pid, 'SIGKILL');
      }, this.killGraceMs);
      run.killTimer.unref?.();
    } else {
      this.finalize(run, 'aborted', { error: run.record.abortReason });
    }

    return {
      taskId,
      runId: run.record.runId,
      status: 'aborted',
      message: `Runner for task '${taskId}' terminated: ${run.record.abortReason}`,
    };
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  getRun(taskId: string): RunnerRecord | null {
    const run = this.active.get(taskId);
    if (run) return { ...run.record };
    const past = this.history.find((r) => r.taskId === taskId);
    return past ? { ...past } : null;
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  listRuns(query: ListRunsQuery = {}): RunnerRecord[] {
    const live = [...this.active.values()].map((r) => ({ ...r.record }));
    const runs = query.activeOnly ? live : [...live, ...this.history.map((r) => ({ ...r }))];
    const filtered = query.taskId ? runs.filter((r) => r.taskId === query.taskId) : runs;
    return filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /**
   * Returns the tail of a run's log. Live runs are served from the in-memory
   * ring buffer; finished runs fall back to `.nativ/runs/<taskId>.log`.
   */
  getLogs(taskId: string, tail = 200): LogSlice {
    const run = this.active.get(taskId);
    const record = run?.record ?? this.history.find((r) => r.taskId === taskId) ?? null;

    let text = run?.buffer ?? '';
    let truncated = run ? run.record.logBytes > Buffer.byteLength(text, 'utf8') : false;

    if (!run) {
      const file = record?.logFile ?? path.join(this.runsDir, `${taskId}.log`);
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        text = '';
      }
    }

    const sliced = tailLines(text, tail);
    if (sliced.length < text.length) truncated = true;

    return {
      taskId,
      runId: record?.runId ?? null,
      status: record?.status ?? null,
      totalBytes: record?.logBytes ?? Buffer.byteLength(text, 'utf8'),
      log: sliced,
      truncated,
    };
  }

  /** Kills every in-flight runner and releases timers. Safe to call twice. */
  shutdown(reason = 'Supervisor shutdown'): void {
    this.closed = true;
    for (const [taskId, run] of [...this.active]) {
      this.clearTimers(run);
      this.interruptNative(run);
      if (run.record.pid !== null) killProcessTree(run.record.pid, 'SIGKILL');
      this.finalize(run, 'aborted', { error: reason });
      this.active.delete(taskId);
    }
    this.removeAllListeners();
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private normalizeTimeout(value: number | undefined): number {
    if (value === undefined || value === null) return this.defaultTimeoutSeconds;
    if (!Number.isFinite(value) || value <= 0) {
      throw new SupervisorError('VALIDATION_ERROR', '"timeoutSeconds" must be a positive number');
    }
    return Math.floor(value);
  }

  private requireTask(taskId: string): MasterPlanTask {
    const { plan, error } = loadMasterPlan(this.rootDir);
    if (!plan) throw new SupervisorError('PLAN_NOT_FOUND', error ?? 'No .ai/master_plan.json found');
    for (const milestone of plan.milestones) {
      const task = milestone.tasks.find((t) => t.id === taskId);
      if (task) return task;
    }
    throw new SupervisorError('TASK_NOT_FOUND', `Task '${taskId}' is not declared in .ai/master_plan.json`);
  }

  private assertDependenciesMet(task: MasterPlanTask): void {
    if (!task.dependencies?.length) return;
    const { plan } = loadMasterPlan(this.rootDir);
    if (!plan) return;

    const byId = new Map<string, MasterPlanTask>();
    for (const milestone of plan.milestones) for (const t of milestone.tasks) byId.set(t.id, t);

    const unmet = task.dependencies.filter((id) => byId.get(id)?.status !== 'completed');
    if (unmet.length) {
      throw new SupervisorError(
        'UNMET_DEPENDENCIES',
        `Task '${task.id}' has unmet dependencies: ${unmet.join(', ')}`,
      );
    }
  }

  /** Creates `.worktrees/task-<id>` on `agent/task-<id>`, reusing an existing one. */
  private provisionWorktree(record: RunnerRecord): void {
    const worktreeDir = record.worktreeDir;
    const branch = record.branch!;

    // Prune stale git worktrees so git doesn't refuse creation
    try {
      spawnSync('git', ['worktree', 'prune'], { cwd: this.rootDir, stdio: 'ignore', windowsHide: true });
    } catch {}

    if (fs.existsSync(worktreeDir)) {
      const gitRef = path.join(worktreeDir, '.git');
      if (fs.existsSync(gitRef)) {
        linkWorktreeAiDirectory(worktreeDir, this.rootDir);
        linkWorktreeNodeModules(worktreeDir, this.rootDir);
        return;
      }
      // Zombie directory without .git: clean it up so git worktree add doesn't fail
      try {
        safeUnlinkWorktreeAiDirectory(worktreeDir);
        safeUnlinkWorktreeNodeModules(worktreeDir);
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      } catch {}
    }

    fs.mkdirSync(path.join(this.rootDir, '.worktrees'), { recursive: true });

    // `-b` fails when the agent branch survived a previous run; reuse it instead.
    let res = spawnSync('git', ['worktree', 'add', worktreeDir, '-b', branch], {
      cwd: this.rootDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status !== 0) {
      res = spawnSync('git', ['worktree', 'add', worktreeDir, branch], {
        cwd: this.rootDir,
        encoding: 'utf8',
        windowsHide: true,
      });
    }
    if (res.status !== 0) {
      throw new Error(String(res.stderr || res.stdout || 'git worktree add failed').trim());
    }

    linkWorktreeAiDirectory(worktreeDir, this.rootDir);
    linkWorktreeNodeModules(worktreeDir, this.rootDir);
  }

  private spawnRunner(run: ActiveRun, task: MasterPlanTask, options: DispatchOptions): void {
    const { record } = run;

    const child = spawn(record.command, {
      cwd: record.worktreeDir,
      shell: true,
      // POSIX: a new process group so the killswitch can reap the whole agent
      // tree. Windows: detaching hands the child a fresh console and severs our
      // stdio pipes, so we stay attached and let `taskkill /T` walk the tree.
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...buildRunnerEnv(process.env, options.env),
        ...(record.thinking?.budgetTokens ? { MAX_THINKING_TOKENS: String(record.thinking.budgetTokens) } : {}),
        NATIV_RUN_ID: record.runId,
        NATIV_TASK_ID: record.taskId,
        NATIV_PROJECT_ROOT: this.rootDir,
      },
    });

    run.child = child;
    record.pid = child.pid ?? null;

    // A runner that exits without reading its input must not crash us or fail the run.
    child.stdin?.on('error', () => {});
    child.stdin?.end(buildRunnerPrompt(task), 'utf8');

    child.stdout?.on('data', (chunk: Buffer) => {
      if (run.streamJson) this.consumeStreamJson(run, chunk.toString());
      else this.appendLog(run, 'stdout', chunk.toString());
    });
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(run, 'stderr', chunk.toString()));
    child.on('error', (err) => {
      record.error = err.message;
      this.appendLog(run, 'stderr', `\n[supervisor] spawn error: ${err.message}\n`);
    });
    child.on('close', (code, signal) => {
      if (run.streamJson && run.lineBuffer) {
        // The final event may arrive without a trailing newline.
        const rest = run.lineBuffer;
        run.lineBuffer = '';
        this.handleStreamLine(run, rest);
      }
      void this.handleExit(run, task, options, code, signal);
    });

    // The parent (studio server / CLI) must stay free to exit on its own terms.
    child.unref();

    run.timer = setTimeout(() => this.handleTimeout(run), record.timeoutSeconds * 1000);
    run.timer.unref?.();
    this.startIdleWatchdog(run);
  }

  /** Terminates runs that go silent: a hung agent is caught long before the hard cap. */
  private startIdleWatchdog(run: ActiveRun): void {
    if (!this.idleTimeoutMs) return;
    run.lastActivity = Date.now();
    const every = Math.max(100, Math.min(this.idleTimeoutMs / 4, 15_000));
    run.idleTimer = setInterval(() => {
      if (Date.now() - run.lastActivity >= this.idleTimeoutMs) this.handleTimeout(run, 'idle');
    }, every);
    run.idleTimer.unref?.();
  }

  private handleTimeout(run: ActiveRun, kind: 'budget' | 'idle' = 'budget'): void {
    if (!this.active.has(run.record.taskId) || run.record.timedOut) return;
    if (run.idleTimer) clearInterval(run.idleTimer);
    run.idleTimer = null;
    run.record.timedOut = true;
    run.record.error =
      kind === 'idle'
        ? `Runner produced no output for ${Math.round(this.idleTimeoutMs / 1000)}s (inactivity watchdog)`
        : `Runner exceeded the ${run.record.timeoutSeconds}s timeout budget`;
    this.appendLog(run, 'stderr', `\n[supervisor] ${run.record.error} — terminating process tree\n`);
    this.interruptNative(run);

    const pid = run.record.pid;
    if (pid === null) {
      this.finalize(run, 'failed', {});
      return;
    }
    killProcessTree(pid, 'SIGTERM');
    run.killTimer = setTimeout(() => {
      if (isPidAlive(pid)) killProcessTree(pid, 'SIGKILL');
    }, this.killGraceMs);
    run.killTimer.unref?.();
  }

  private async handleExit(
    run: ActiveRun,
    task: MasterPlanTask,
    options: DispatchOptions,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const { record } = run;
    this.clearTimers(run);
    record.exitCode = code;
    record.signal = signal ?? null;

    if (run.aborting) {
      this.finalize(run, 'aborted', { error: record.abortReason });
      return;
    }
    if (record.timedOut) {
      this.finalize(run, 'failed', {});
      return;
    }
    if (code !== 0) {
      let errDetail = record.error;
      if (!errDetail) {
        const lastErrLine = run.buffer.trim().split('\n').filter(Boolean).pop()?.trim();
        const baseMsg = `Runner exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`;
        errDetail = lastErrLine && lastErrLine.length < 200 ? `${baseMsg}: ${lastErrLine}` : baseMsg;
      }
      this.finalize(run, 'failed', {
        error: errDetail,
      });
      return;
    }

    await this.completeSuccessfulRun(run, task, options);
  }

  /** Shared tail of a clean runner exit: optional verification, optional merge, then completion. */
  private async completeSuccessfulRun(run: ActiveRun, task: MasterPlanTask, options: DispatchOptions): Promise<void> {
    const { record } = run;
    if (options.verify) {
      const passed = await this.runVerification(run, task);
      if (!passed) {
        this.finalize(run, 'failed', { error: 'Verification command failed' });
        return;
      }
    }

    if (options.autoMerge && record.branch) {
      record.status = 'merging';
      this.emitStatus(record);
      try {
        this.mergeWorktree(run);
      } catch (err: any) {
        this.finalize(run, 'failed', { error: `Merge failed: ${err.message}` });
        return;
      }
    }

    this.finalize(run, 'completed', {});
  }

  // ─── Claude Code stream-json (cli engine) ──────────────────────────────────

  private consumeStreamJson(run: ActiveRun, chunk: string): void {
    run.lastActivity = Date.now();
    run.lineBuffer += chunk;
    let newline: number;
    while ((newline = run.lineBuffer.indexOf('\n')) !== -1) {
      const line = run.lineBuffer.slice(0, newline).replace(/\r$/, '');
      run.lineBuffer = run.lineBuffer.slice(newline + 1);
      this.handleStreamLine(run, line);
    }
    // A runaway line without newlines must not grow without bound; show it raw instead.
    if (run.lineBuffer.length > this.maxLogBufferBytes) {
      const raw = run.lineBuffer;
      run.lineBuffer = '';
      this.appendLog(run, 'stdout', `${raw}\n`);
    }
  }

  private handleStreamLine(run: ActiveRun, line: string): void {
    const parsed = formatClaudeStreamLine(line);
    if (parsed.model) run.streamModel = parsed.model;
    if (parsed.text) this.appendLog(run, 'stdout', parsed.text);
    if (parsed.result) this.recordStreamUsage(run, parsed.result);
  }

  /** Claude Code reports the run's total cost and tokens once, in its final result event. */
  private recordStreamUsage(run: ActiveRun, result: ClaudeStreamResult): void {
    const { record } = run;
    const model = record.model ?? run.streamModel ?? 'unknown';
    const slice = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheCreationTokens: result.cacheCreationTokens,
      cacheReadTokens: result.cacheReadTokens,
    };
    const usage: ActualTokenUsage = {
      model,
      turns: result.turns || 1,
      ...slice,
      thinkingTokens: 0,
      costUsd: result.costUsd ?? computeActualCostUsd(model, slice),
    };
    record.usage = usage;
    const event: RunnerTokenUsageEvent = {
      runId: record.runId,
      taskId: record.taskId,
      model,
      turn: usage.turns,
      delta: usage,
      total: { ...usage, cacheHitRate: cacheHitRate(usage) },
      at: new Date().toISOString(),
    };
    this.emit('runner_token_usage', event);
    this.persist(record);
  }

  // ─── Native engine ──────────────────────────────────────────────────────────

  private createAnthropicClient(): Anthropic {
    try {
      return this.anthropicClientFactory();
    } catch (err: any) {
      throw new SupervisorError(
        'ANTHROPIC_CREDENTIALS_MISSING',
        `Could not initialise the Claude API client (${err?.message ?? err}). Set ANTHROPIC_API_KEY (or run \`ant auth login\`) in the environment that launches nativ.`,
      );
    }
  }

  /** Cancels the in-flight API stream and reaps the running bash tool command, if any. */
  private interruptNative(run: ActiveRun): void {
    if (!run.native) return;
    run.native.controller.abort();
    if (run.toolPid !== null) {
      killProcessTree(run.toolPid, 'SIGKILL');
      run.toolPid = null;
    }
  }

  private startNativeRun(run: ActiveRun, options: DispatchOptions, useWorktree: boolean): void {
    const { record } = run;
    const native = run.native!;
    run.timer = setTimeout(() => this.handleTimeout(run), record.timeoutSeconds * 1000);
    run.timer.unref?.();
    this.startIdleWatchdog(run);

    const { effort, budgetTokens } = native.thinking;
    this.appendLog(
      run,
      'stdout',
      `[native] model=${native.model}` +
        (effort ? ` effort=${effort}` : '') +
        (budgetTokens ? ` budget_tokens=${budgetTokens}` : '') +
        ` fallbacks=${supportsServerFallback(native.model) ? 'default' : 'off'}\n`,
    );
    void this.driveNativeRun(run, options, useWorktree);
  }

  private async driveNativeRun(run: ActiveRun, options: DispatchOptions, useWorktree: boolean): Promise<void> {
    try {
      await this.runNativeLoop(run, useWorktree);
    } catch (err) {
      if (run.settled) return; // aborted or timed out: the stream rejection is expected
      const message = describeNativeError(err);
      this.appendLog(run, 'stderr', `\n[native] ${message}\n`);
      this.finalize(run, 'failed', { error: message });
      return;
    }
    if (run.settled) return;
    this.clearTimers(run);
    run.record.exitCode = 0;
    await this.completeSuccessfulRun(run, run.task, options);
  }

  /**
   * Manual agentic loop over the Messages API: stream a turn, capture usage,
   * execute the requested local tools, repeat until the model ends its turn.
   */
  private async runNativeLoop(run: ActiveRun, useWorktree: boolean): Promise<void> {
    const native = run.native!;
    const { thinking } = native;
    const fallback = supportsServerFallback(native.model);
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
      { role: 'user', content: buildNativeTaskPrompt(run.task, this.readRoleGuide(run.task), useWorktree, this.rootDir) },
    ];

    for (let turn = 1; ; turn++) {
      if (run.settled) return;
      if (turn > this.nativeMaxTurns) {
        throw new Error(`Native engine stopped after the ${this.nativeMaxTurns}-turn budget without finishing`);
      }

      const stream = native.client.beta.messages.stream(
        {
          model: native.model,
          max_tokens: NATIVE_MAX_OUTPUT_TOKENS,
          // Breakpoint 1 caches tools + the frozen system prompt; the top-level
          // breakpoint follows the growing conversation so each turn re-reads
          // everything before it from cache.
          system: [{ type: 'text', text: NATIVE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          cache_control: { type: 'ephemeral' },
          tools: NATIVE_TOOLS,
          messages,
          ...(thinking.budgetTokens
            ? { thinking: { type: 'enabled' as const, budget_tokens: thinking.budgetTokens } }
            : thinking.effort
              ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
              : {}),
          ...(thinking.effort ? { output_config: { effort: thinking.effort } } : {}),
          ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { signal: native.controller.signal },
      );

      // Newer models (Opus 5.5, Fable 5.1) put their between-tool progress notes
      // in thinking blocks, so both channels go to the log or long turns look idle.
      let streaming: 'text' | 'thinking' | null = null;
      const switchTo = (kind: 'text' | 'thinking') => {
        if (streaming === kind) return;
        this.appendLog(run, 'stdout', `${streaming ? '\n' : ''}${kind === 'thinking' ? '[native:thinking] ' : ''}`);
        streaming = kind;
      };
      stream.on('thinking', (delta) => {
        if (!delta) return;
        switchTo('thinking');
        this.appendLog(run, 'stdout', delta);
      });
      stream.on('text', (delta) => {
        switchTo('text');
        this.appendLog(run, 'stdout', delta);
      });

      const message = await stream.finalMessage();
      if (streaming) this.appendLog(run, 'stdout', '\n');
      if (run.settled) return;
      this.recordTurnUsage(run, message);

      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new Error(`Model declined the task (refusal${category ? `: ${category}` : ''})`);
      }
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use',
      );
      if (message.stop_reason === 'max_tokens') {
        // A tool input cut off here can still parse; never run it.
        throw new Error(`Model output hit max_tokens (${NATIVE_MAX_OUTPUT_TOKENS}) mid-turn`);
      }
      if (toolUses.length === 0) return;

      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const block of toolUses) {
        if (run.settled) return;
        results.push(await this.executeNativeTool(run, block));
      }
      // All results for one assistant turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }
  }

  private recordTurnUsage(run: ActiveRun, message: Anthropic.Beta.Messages.BetaMessage): void {
    const { record } = run;
    const usage = message.usage;
    // The served model differs from the requested one after a refusal fallback.
    const model = message.model || run.native!.model;
    const details = (usage as { output_tokens_details?: { thinking_tokens?: number } | null }).output_tokens_details;
    const slice = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    };
    const delta: ActualTokenUsage = {
      model,
      turns: 1,
      ...slice,
      thinkingTokens: details?.thinking_tokens ?? 0,
      costUsd: computeActualCostUsd(model, slice),
    };
    record.usage = mergeActualUsage(record.usage ?? emptyActualUsage(model), delta);

    this.appendLog(
      run,
      'stdout',
      `[native] turn ${record.usage.turns}: in ${delta.inputTokens} · out ${delta.outputTokens}` +
        ` · cache read ${delta.cacheReadTokens} / write ${delta.cacheCreationTokens} · $${delta.costUsd.toFixed(4)}\n`,
    );
    const event: RunnerTokenUsageEvent = {
      runId: record.runId,
      taskId: record.taskId,
      model,
      turn: record.usage.turns,
      delta,
      total: { ...record.usage, cacheHitRate: cacheHitRate(record.usage) },
      at: new Date().toISOString(),
    };
    this.emit('runner_token_usage', event);
    this.persist(record);
  }

  private async executeNativeTool(
    run: ActiveRun,
    block: Anthropic.Beta.Messages.BetaToolUseBlock,
  ): Promise<Anthropic.Beta.Messages.BetaToolResultBlockParam> {
    const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
    try {
      let content: string;
      if (block.name === 'bash') {
        content = await this.runBashTool(run, input);
      } else if (block.name === 'str_replace_based_edit_tool') {
        this.appendLog(run, 'stdout', `[native] edit ${String(input.command)} ${String(input.path)}\n`);
        content = runEditorCommand(run.record.worktreeDir, this.rootDir, input);
      } else {
        throw new ToolInputError(`Unknown tool '${block.name}'.`);
      }
      return { type: 'tool_result', tool_use_id: block.id, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendLog(run, 'stderr', `[native] ${block.name} error: ${message.split('\n')[0]}\n`);
      return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true };
    }
  }

  /** Runs one model-authored command in a fresh shell at the workspace root. */
  private async runBashTool(run: ActiveRun, input: Record<string, unknown>): Promise<string> {
    if (input.restart === true) return 'Shell restarted. Every command already starts in a fresh shell at the workspace root.';
    const command = requireString(input, 'command').trim();
    if (!command) throw new ToolInputError('"command" must be a non-empty string.');

    const rejection = checkNativeBashCommand(command, this.nativeAllowedCommands);
    if (rejection) throw new ToolInputError(`Command rejected: ${rejection}`);

    this.appendLog(run, 'stdout', `[native] $ ${command}\n`);
    const child = spawn(command, {
      cwd: run.record.worktreeDir,
      shell: this.toolShell,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...buildToolEnv(process.env, run.native?.env),
        NATIV_RUN_ID: run.record.runId,
        NATIV_TASK_ID: run.record.taskId,
        NATIV_PROJECT_ROOT: this.rootDir,
      },
    });
    run.toolPid = child.pid ?? null;

    let output = '';
    let omitted = 0;
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > NATIVE_TOOL_CAPTURE_LIMIT) {
        // Keep the head and the newest tail; the middle of huge logs is rarely useful.
        const head = Math.floor(NATIVE_TOOL_CAPTURE_LIMIT * 0.2);
        const excess = output.length - NATIVE_TOOL_CAPTURE_LIMIT;
        output = output.slice(0, head) + output.slice(head + excess);
        omitted += excess;
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid, 'SIGKILL');
    }, this.nativeToolTimeoutMs);
    timer.unref?.();

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        capture(Buffer.from(`\n${err.message}\n`));
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    clearTimeout(timer);
    run.toolPid = null;

    const clipped = clipToolOutput(output, omitted);
    if (clipped) this.appendLog(run, 'stdout', clipped.endsWith('\n') ? clipped : `${clipped}\n`);
    if (timedOut) {
      throw new ToolInputError(
        `Command exceeded the ${Math.round(this.nativeToolTimeoutMs / 1000)}s tool budget and was terminated.\n${clipped}`,
      );
    }
    const body = clipped || '(no output)';
    return exitCode === 0 ? body : `${body}\n[exit code ${exitCode ?? 'unknown'}]`;
  }

  private readRoleGuide(task: MasterPlanTask): string | null {
    if (!/^[\w-]+$/.test(task.assignedSubagent || '')) return null;
    try {
      const text = fs.readFileSync(path.join(this.rootDir, '.ai', 'subagents', `${task.assignedSubagent}.md`), 'utf8');
      return text.length > ROLE_GUIDE_LIMIT ? `${text.slice(0, ROLE_GUIDE_LIMIT)}\n[... truncated ...]` : text;
    } catch {
      return null;
    }
  }

  private async runVerification(run: ActiveRun, task: MasterPlanTask): Promise<boolean> {
    const { record } = run;
    record.status = 'verifying';
    this.emitStatus(record);

    const result: VerificationResult = await runTaskVerification(task, { cwd: record.worktreeDir, configDir: this.rootDir });
    record.verification = {
      command: result.command,
      success: result.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      skipped: Boolean(result.skipped),
    };

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (output) this.appendLog(run, 'stdout', `\n[supervisor] verification output:\n${output}\n`);
    return result.success;
  }

  /** Quiet counterpart to `nativ worktree merge`: same safe merge, no stdout noise inside a server. */
  private mergeWorktree(run: ActiveRun): void {
    const outcome = mergeAgentWorktree(this.rootDir, run.record.taskId);
    this.appendLog(run, 'stdout', `\n[supervisor] ${outcome.message}\n`);
  }

  // ─── Log buffer ─────────────────────────────────────────────────────────────

  private resetLogFile(record: RunnerRecord): void {
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
      fs.writeFileSync(record.logFile, '', 'utf8');
    } catch {
      // A read-only workspace must not abort the run; logs stay in memory.
    }
  }

  private appendLog(run: ActiveRun, stream: 'stdout' | 'stderr', chunk: string): void {
    if (!chunk) return;
    const { record } = run;
    run.lastActivity = Date.now();
    record.logBytes += Buffer.byteLength(chunk, 'utf8');

    run.buffer += chunk;
    if (Buffer.byteLength(run.buffer, 'utf8') > this.maxLogBufferBytes) {
      // Drop from the head, then realign to a line boundary so the oldest
      // retained entry is never a half-line.
      run.buffer = run.buffer.slice(run.buffer.length - this.maxLogBufferBytes);
      const nl = run.buffer.indexOf('\n');
      if (nl !== -1) run.buffer = run.buffer.slice(nl + 1);
    }

    try {
      fs.appendFileSync(record.logFile, chunk, 'utf8');
    } catch {
      // Best-effort persistence only.
    }

    this.emit('runner_log', {
      runId: record.runId,
      taskId: record.taskId,
      stream,
      chunk,
      at: new Date().toISOString(),
    });
  }

  // ─── State transitions & persistence ────────────────────────────────────────

  private clearTimers(run: ActiveRun): void {
    if (run.timer) clearTimeout(run.timer);
    if (run.killTimer) clearTimeout(run.killTimer);
    if (run.idleTimer) clearInterval(run.idleTimer);
    run.timer = null;
    run.killTimer = null;
    run.idleTimer = null;
  }

  private finalize(run: ActiveRun, status: RunnerStatus, patch: { error?: string | null }): void {
    // A process exit or aborted API stream can land after shutdown/abort already
    // settled the run; the first terminal status wins.
    if (run.settled) return;
    run.settled = true;
    const { record } = run;
    this.clearTimers(run);
    record.status = status;
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
    if (patch.error !== undefined) record.error = patch.error;
    record.pid = null;

    this.active.delete(record.taskId);
    this.history = [{ ...record }, ...this.history.filter((r) => r.runId !== record.runId)].slice(0, this.maxHistory);
    this.persist(record);
    this.emitStatus(record);

    if (record.usage && record.usage.turns > 0) {
      // Spend is recorded whatever the outcome: failed and aborted runs are billed too.
      recordRunnerUsage(this.rootDir, run.task, record.usage).catch(() => {
        // Telemetry is advisory; the run record keeps the authoritative usage.
      });
    }
  }

  private emitStatus(record: RunnerRecord): void {
    this.emit('runner_status', { ...record, at: new Date().toISOString() });
  }

  private persist(record: RunnerRecord): void {
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.runsDir, `${record.taskId}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Local-first persistence is advisory; in-memory state stays authoritative.
    }
  }

  /**
   * Rebuilds the recent-run list from `.nativ/runs/*.json` so a restarted
   * supervisor can still answer `/tasks/runs` and `/tasks/logs`. Records left
   * in an active phase by a crashed supervisor are reconciled to `failed`.
   */
  private restoreHistory(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.runsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }

    const restored: RunnerRecord[] = [];
    for (const file of entries) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(this.runsDir, file), 'utf8')) as RunnerRecord;
        if (!record?.runId || !record?.taskId) continue;
        // Records persisted before dual-mode dispatch carry no engine fields.
        record.engine = record.engine ?? 'cli';
        record.model = record.model ?? null;
        record.thinking = record.thinking ?? null;
        record.usage = record.usage ?? null;
        if (isActiveStatus(record.status) && !(record.pid !== null && isPidAlive(record.pid))) {
          record.status = 'failed';
          record.error = record.error ?? 'Supervisor restarted while the run was in flight';
          record.endedAt = record.endedAt ?? new Date().toISOString();
          record.pid = null;
        }
        restored.push(record);
      } catch {
        // Skip unreadable or corrupt run files.
      }
    }

    this.history = restored.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, this.maxHistory);
  }
}

export default AgentSupervisor;
