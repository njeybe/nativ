import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { loadMasterPlan } from '../core/verifier.js';
import {
  cacheHitRate,
  computeActualCostUsd,
  emptyActualUsage,
  mergeActualUsage,
  recordRunnerUsage,
  type ActualTokenUsage,
} from '../core/telemetry.js';
import {
  resolveProjectRoot,
  linkWorktreeAiDirectory,
  safeUnlinkWorktreeAiDirectory,
  linkWorktreeNodeModules,
  safeUnlinkWorktreeNodeModules,
} from '../core/root-resolver.js';
import type { MasterPlanTask } from '../scanner/types.js';
import { resolveWorkerModel, toNativeModelId } from '../core/model-routing.js';

import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_LOG_BUFFER_BYTES,
  DEFAULT_NATIVE_ALLOWED_COMMANDS,
  DEFAULT_NATIVE_MAX_TURNS,
  DEFAULT_NATIVE_MODEL,
  DEFAULT_NATIVE_TOOL_TIMEOUT_MS,
  DEFAULT_RUNNER_COMMAND,
  DEFAULT_RUNNER_ENGINE,
  DEFAULT_TIMEOUT_SECONDS,
  NATIVE_MAX_OUTPUT_TOKENS,
  SupervisorError,
  isActiveStatus,
  type AbortResult,
  type ActiveRun,
  type AgentSupervisorOptions,
  type DispatchOptions,
  type ListRunsQuery,
  type LogSlice,
  type NativeRunState,
  type RunnerEngine,
  type RunnerRecord,
  type RunnerStatus,
  type RunnerThinking,
  type RunnerTokenUsageEvent,
} from './types.js';
import { isExecutableInPath, isPidAlive, killProcessTree, tailLines } from './process-utils.js';
import {
  buildDefaultClaudeCommand,
  buildRunnerEnv,
  buildRunnerPermissions,
  buildRunnerPrompt,
  formatClaudeStreamLine,
  parseRunnerAllowList,
  usesClaudeStreamJson,
  writeRunnerSettings,
  type ClaudeStreamResult,
} from './cli-config.js';
import { resolveToolShell } from './native-tools.js';
import {
  describeNativeError,
  normalizeEngine,
  normalizeModel,
  normalizeThinkingBudget,
  resolveNativeThinking,
  supportsServerFallback,
} from './native-engine.js';
import { runNativeLoop, readRoleGuide } from './native-driver.js';
import { runTaskVerificationStep, mergeWorktreeStep, resetLogFile } from './run-lifecycle.js';

// Re-export domain modules for full backward compatibility
export * from './types.js';
export * from './process-utils.js';
export * from './cli-config.js';
export * from './native-tools.js';
export * from './native-engine.js';
export * from './native-driver.js';
export * from './run-lifecycle.js';

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
        this.finalize(run, 'failed', { error: record.verification?.error ?? 'Verification command failed' });
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
      await runNativeLoop(
        {
          rootDir: this.rootDir,
          nativeMaxTurns: this.nativeMaxTurns,
          nativeToolTimeoutMs: this.nativeToolTimeoutMs,
          nativeAllowedCommands: this.nativeAllowedCommands,
          toolShell: this.toolShell,
          appendLog: (r, stream, chunk) => this.appendLog(r, stream, chunk),
          onTurnUsage: (record, delta, model) => {
            const event: RunnerTokenUsageEvent = {
              runId: record.runId,
              taskId: record.taskId,
              model,
              turn: record.usage!.turns,
              delta,
              total: { ...record.usage!, cacheHitRate: cacheHitRate(record.usage!) },
              at: new Date().toISOString(),
            };
            this.emit('runner_token_usage', event);
            this.persist(record);
          },
        },
        run,
        useWorktree,
      );
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

  private async runVerification(run: ActiveRun, task: MasterPlanTask): Promise<boolean> {
    return runTaskVerificationStep(
      this.rootDir,
      run,
      task,
      (rec) => this.emitStatus(rec),
      (r, stream, chunk) => this.appendLog(r, stream, chunk),
    );
  }

  /** Quiet counterpart to `nativ worktree merge`: same safe merge, no stdout noise inside a server. */
  private mergeWorktree(run: ActiveRun): void {
    mergeWorktreeStep(this.rootDir, run, (r, stream, chunk) => this.appendLog(r, stream, chunk));
  }

  // ─── Log buffer ─────────────────────────────────────────────────────────────

  private resetLogFile(record: RunnerRecord): void {
    resetLogFile(this.runsDir, record);
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
