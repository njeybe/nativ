import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadMasterPlan, executeVerification, type VerificationResult } from '../core/verifier.js';
import {
  resolveProjectRoot,
  linkWorktreeAiDirectory,
  safeUnlinkWorktreeAiDirectory,
} from '../core/root-resolver.js';
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

/** Persisted, serializable state of a single agent execution. */
export interface RunnerRecord {
  runId: string;
  taskId: string;
  status: RunnerStatus;
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
  /** Shell command that launches the agent. Defaults to the supervisor's `defaultRunnerCommand`. */
  runnerCommand?: string;
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
  /** How many finished runs to keep in memory. */
  maxHistory?: number;
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
export const DEFAULT_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_LOG_BUFFER_BYTES = 512 * 1024;
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const DEFAULT_MAX_HISTORY = 50;

interface ActiveRun {
  record: RunnerRecord;
  child: ChildProcess | null;
  timer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  buffer: string;
  aborting: boolean;
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
  private readonly maxHistory: number;
  private readonly active = new Map<string, ActiveRun>();
  private history: RunnerRecord[] = [];
  private closed = false;

  constructor(options: AgentSupervisorOptions = {}) {
    super();
    this.rootDir = resolveProjectRoot(options.cwd);
    this.runsDir = path.join(this.rootDir, '.nativ', 'runs');
    this.defaultRunnerCommand = options.defaultRunnerCommand ?? DEFAULT_RUNNER_COMMAND;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.maxLogBufferBytes = options.maxLogBufferBytes ?? DEFAULT_MAX_LOG_BUFFER_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
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

    const command = (options.runnerCommand || '').trim() || this.defaultRunnerCommand;
    const timeoutSeconds = this.normalizeTimeout(options.timeoutSeconds);
    const useWorktree = options.useWorktree !== false;

    const record: RunnerRecord = {
      runId: randomUUID(),
      taskId,
      status: useWorktree ? 'spawning_worktree' : 'running',
      pid: null,
      branch: useWorktree ? `agent/task-${taskId}` : null,
      worktreeDir: useWorktree ? path.join(this.rootDir, '.worktrees', `task-${taskId}`) : this.rootDir,
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

    const run: ActiveRun = { record, child: null, timer: null, killTimer: null, buffer: '', aborting: false };
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
      this.spawnRunner(run, task, options);
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

    if (fs.existsSync(worktreeDir)) {
      linkWorktreeAiDirectory(worktreeDir, this.rootDir);
      return;
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
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.env,
        NATIV_RUN_ID: record.runId,
        NATIV_TASK_ID: record.taskId,
        NATIV_PROJECT_ROOT: this.rootDir,
      },
    });

    run.child = child;
    record.pid = child.pid ?? null;

    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(run, 'stdout', chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(run, 'stderr', chunk.toString()));
    child.on('error', (err) => {
      record.error = err.message;
      this.appendLog(run, 'stderr', `\n[supervisor] spawn error: ${err.message}\n`);
    });
    child.on('close', (code, signal) => {
      void this.handleExit(run, task, options, code, signal);
    });

    // The parent (studio server / CLI) must stay free to exit on its own terms.
    child.unref();

    run.timer = setTimeout(() => this.handleTimeout(run), record.timeoutSeconds * 1000);
    run.timer.unref?.();
  }

  private handleTimeout(run: ActiveRun): void {
    if (!this.active.has(run.record.taskId)) return;
    run.record.timedOut = true;
    run.record.error = `Runner exceeded the ${run.record.timeoutSeconds}s timeout budget`;
    this.appendLog(run, 'stderr', `\n[supervisor] ${run.record.error} — terminating process tree\n`);

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
      this.finalize(run, 'failed', {
        error: record.error ?? `Runner exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`,
      });
      return;
    }

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
        this.mergeWorktree(record);
      } catch (err: any) {
        this.finalize(run, 'failed', { error: `Merge failed: ${err.message}` });
        return;
      }
    }

    this.finalize(run, 'completed', {});
  }

  private async runVerification(run: ActiveRun, task: MasterPlanTask): Promise<boolean> {
    const { record } = run;
    record.status = 'verifying';
    this.emitStatus(record);

    const result: VerificationResult = await executeVerification(task.verificationCommand, record.worktreeDir);
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

  /** Quiet counterpart to `nativ worktree merge`: no stdout noise inside a server. */
  private mergeWorktree(record: RunnerRecord): void {
    const branch = record.branch!;
    if (fs.existsSync(record.worktreeDir)) {
      safeUnlinkWorktreeAiDirectory(record.worktreeDir);
      spawnSync('git', ['worktree', 'remove', record.worktreeDir, '--force'], {
        cwd: this.rootDir,
        encoding: 'utf8',
        windowsHide: true,
      });
    }

    const merge = spawnSync('git', ['merge', branch, '--no-edit'], {
      cwd: this.rootDir,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (merge.status !== 0) {
      throw new Error(String(merge.stderr || merge.stdout || 'git merge failed').trim());
    }

    spawnSync('git', ['branch', '-d', branch], { cwd: this.rootDir, stdio: 'ignore', windowsHide: true });
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
    run.timer = null;
    run.killTimer = null;
  }

  private finalize(run: ActiveRun, status: RunnerStatus, patch: { error?: string | null }): void {
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
