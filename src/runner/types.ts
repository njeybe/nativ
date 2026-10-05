import type { ChildProcess } from 'node:child_process';
import type Anthropic from '@anthropic-ai/sdk';
import type { ActualTokenUsage } from '../core/telemetry.js';
import type { MasterPlanTask } from '../scanner/types.js';

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
    /** Why it failed: a named phase, an unreadable config, or the code-shape block. */
    error?: string;
    phases?: Array<{ name: string; success: boolean; durationMs: number }>;
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

export const DEFAULT_NATIVE_ALLOWED_COMMANDS: readonly string[] = [
  'nativ', 'node', 'npm', 'npx', 'tsx', 'tsc', 'git',
  'cd', 'ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'diff', 'sort', 'uniq',
  'echo', 'printf', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'sed', 'awk', 'test', 'true', 'false',
];

export interface NativeRunState {
  client: Anthropic;
  model: string;
  thinking: RunnerThinking;
  controller: AbortController;
  /** Dispatch-supplied env for tool commands; secret-looking keys are still filtered out. */
  env?: Record<string, string>;
}

export interface ActiveRun {
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
