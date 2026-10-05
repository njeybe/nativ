import fs from 'node:fs';
import path from 'node:path';
import { CircuitBreaker } from '../../governor/index.js';
import { runTaskBlock, runTaskComplete, runTaskStart } from '../../commands/task.js';
import {
  AgentSupervisor,
  SupervisorError,
  type RunnerEngine,
  type RunnerRecord,
} from '../../runner/agent-supervisor.js';
import {
  cacheHitRate,
  loadTelemetry,
} from '../../core/telemetry.js';
import { HttpError } from '../http-utils.js';
import { AI_DIR, findTask, parseTaskId, planMilestones, readPlan } from '../plan-utils.js';
import { runCaptured, truncateOutput } from '../cli-runner.js';
import {
  aggregateActualUsage,
  finiteOr,
  percent,
  roundUsd,
  sanitizeUsage,
  usageView,
} from './telemetry-routes.js';

export const CONTRACT_FILES = {
  masterPlanExists: 'master_plan.json',
  contextExists: 'context.md',
  dbSchemaExists: 'db_schema.json',
  apiContractsExists: 'api_contracts.json',
  uiSpecsExists: 'ui_specs.md',
} as const;

export const TASK_ACTION_STATUS = { start: 'in_progress', complete: 'completed', block: 'blocked' } as const;
export type TaskAction = keyof typeof TASK_ACTION_STATUS;

const MAX_REASON_LENGTH = 1000;
const MAX_RUNNER_COMMAND_LENGTH = 2000;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 5000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:@-]{0,127}$/;
const MAX_THINKING_BUDGET = 1_000_000;

let cachedVersion: string | null = null;

export function packageVersion(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
      cachedVersion = pkg.version ?? 'unknown';
    } catch {
      cachedVersion = 'unknown';
    }
  }
  return cachedVersion;
}

/** GET /api/pipeline/status: contract matrix, milestone/task burndown and telemetry KPIs. */
export function handlePipelineStatus(root: string) {
  const aiDir = path.join(root, AI_DIR);
  const contracts = Object.fromEntries(
    Object.entries(CONTRACT_FILES).map(([key, file]) => [key, fs.existsSync(path.join(aiDir, file))]),
  ) as Record<keyof typeof CONTRACT_FILES, boolean>;

  const milestones = planMilestones(readPlan(root));
  const tasks = milestones.flatMap((m) => m.tasks);
  const count = (items: Array<{ status: string }>, status: string) => items.filter((i) => i.status === status).length;
  const completedTasks = count(tasks, 'completed');
  const { summary, tasks: trackedTasks } = loadTelemetry(path.join(aiDir, 'telemetry.json'));
  const actual = aggregateActualUsage(trackedTasks);

  return {
    ok: true,
    pipeline: {
      version: packageVersion(),
      contracts,
      milestones: {
        total: milestones.length,
        completed: count(milestones, 'completed'),
        inProgress: count(milestones, 'in_progress'),
        pending: count(milestones, 'pending'),
      },
      tasks: {
        total: tasks.length,
        completed: completedTasks,
        inProgress: count(tasks, 'in_progress'),
        pending: count(tasks, 'pending'),
        blocked: count(tasks, 'blocked'),
        progressPercentage: percent(completedTasks, tasks.length),
      },
      telemetry: {
        totalTokens: finiteOr(summary?.estimatedTotalTokens, 0),
        estimatedCostUsd: finiteOr(summary?.estimatedTotalCostUsd, 0),
        // Grounded in API-reported usage (native runs), summed from the task records so a
        // stale summary written by an older nativ can never under-report spend.
        actualSpendUsd: roundUsd(actual.costUsd),
        cacheReadTokens: actual.cacheReadTokens,
        cacheCreationTokens: actual.cacheCreationTokens,
        thinkingTokens: actual.thinkingTokens,
        cacheHitRate: cacheHitRate(actual),
        totalTasksTracked: trackedTasks.length,
        // Ratio in [0, 1], as stored in telemetry.json.
        passRate: finiteOr(summary?.verificationPassRate, 1),
        circuitBreakerTrips: finiteOr(summary?.circuitBreakerTrips, 0),
      },
    },
  };
}

/** GET /api/pipeline/tasks: milestones with per-task dependency readiness and circuit-breaker attempts. */
export function handlePipelineTasks(root: string) {
  const plan = readPlan(root);
  const milestones = planMilestones(plan);
  const completedIds = new Set(
    milestones.flatMap((m) => m.tasks).filter((t) => t.status === 'completed').map((t) => t.id),
  );
  return {
    ok: true,
    projectName: plan?.projectName ?? null,
    overallStatus: plan?.overallStatus ?? null,
    activeMilestoneId: plan?.activeMilestoneId ?? null,
    milestones: milestones.map((m) => ({
      ...m,
      progressPercentage: percent(m.tasks.filter((t) => t.status === 'completed').length, m.tasks.length),
      tasks: m.tasks.map((t) => ({
        ...t,
        // Same readiness rule as `nativ task list --available`.
        isAvailable:
          (t.status === 'pending' || t.status === 'in_progress') &&
          (t.dependencies ?? []).every((d) => completedIds.has(d)),
        circuitBreaker: CircuitBreaker.getStatus(root, t.id),
      })),
    })),
  };
}

/** POST /api/pipeline/tasks/action: the same lock-guarded transitions as `nativ task start|complete|block`. */
export async function handleTaskAction(root: string, body: Record<string, unknown>) {
  const { action } = body;
  if (typeof action !== 'string' || !Object.hasOwn(TASK_ACTION_STATUS, action)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"action" must be one of: ${Object.keys(TASK_ACTION_STATUS).join(', ')}`);
  }
  const taskAction = action as TaskAction;
  const taskId = parseTaskId(body.taskId);
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"reason" must be a string');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  }
  if (taskAction === 'block' && !reason) throw new HttpError(400, 'VALIDATION_ERROR', '"reason" is required when blocking a task');

  const task = findTask(readPlan(root), taskId);
  if (!task) throw new HttpError(400, 'TASK_NOT_FOUND', `Task "${taskId}" not found in .ai/master_plan.json`);
  if (task.status === TASK_ACTION_STATUS[taskAction]) {
    throw new HttpError(400, 'INVALID_TRANSITION', `Task "${taskId}" is already ${task.status}`);
  }

  // `complete` runs the task's verificationCommand as a gatekeeper, exactly like the CLI.
  const { failed, output } = await runCaptured(async () => {
    if (taskAction === 'start') await runTaskStart(taskId, root);
    else if (taskAction === 'complete') await runTaskComplete(taskId, root);
    else await runTaskBlock(taskId, reason, root);
  });
  if (failed) throw new HttpError(400, 'TASK_ACTION_FAILED', truncateOutput(output || `Task ${taskAction} failed`));

  return { ok: true, task: findTask(readPlan(root), taskId) ?? task };
}

/** Supervisor guard rails (unmet dependencies, already running, unknown task) map to the contract's 400 envelope. */
export function toHttpError(err: unknown): never {
  if (err instanceof SupervisorError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

export function parseRunnerCommand(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', '"runnerCommand" must be a string');
  const command = value.trim();
  if (!command) throw new HttpError(400, 'VALIDATION_ERROR', '"runnerCommand" must not be empty');
  if (command.length > MAX_RUNNER_COMMAND_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"runnerCommand" must be at most ${MAX_RUNNER_COMMAND_LENGTH} characters`);
  }
  return command;
}

export function parseTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_SECONDS) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"timeoutSeconds" must be a number between 1 and ${MAX_TIMEOUT_SECONDS}`);
  }
  return Math.floor(value);
}

export function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', `"${field}" must be a boolean`);
  return value;
}

/** Query strings carry booleans as text: `?activeOnly=1|true|yes`. */
export function parseBooleanParam(value: string | null): boolean {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function parseTailLines(value: string | null): number {
  if (value === null || value === '') return DEFAULT_TAIL_LINES;
  const tail = Number(value);
  if (!Number.isFinite(tail) || tail <= 0 || tail > MAX_TAIL_LINES) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"tailLines" must be a number between 1 and ${MAX_TAIL_LINES}`);
  }
  return Math.floor(tail);
}

export function parseRunnerEngine(value: unknown): RunnerEngine | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'native' && value !== 'cli') throw new HttpError(400, 'VALIDATION_ERROR', `"runnerEngine" must be 'native' or 'cli'`);
  return value;
}

export function parseThinkingBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  // 0 is valid: "as little thinking as the model allows" (the Studio's None chip).
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_THINKING_BUDGET) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"thinkingBudget" must be a number between 0 and ${MAX_THINKING_BUDGET}`);
  }
  return Math.floor(value);
}

export function parseModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !MODEL_ID_PATTERN.test(value.trim())) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"model" must be a model ID such as claude-opus-5-5');
  }
  return value.trim();
}

/** Runner records as served by the API: usage gains its derived cache hit rate. */
export function runView(run: RunnerRecord) {
  return { ...run, usage: usageView(sanitizeUsage(run.usage)) };
}

/**
 * POST /api/pipeline/tasks/dispatch: hands a task to a background runner, either the native
 * Messages API engine or a CLI command (Claude Code by default), in an isolated worktree.
 */
export async function handleTaskDispatch(supervisor: AgentSupervisor, body: Record<string, unknown>) {
  const taskId = parseTaskId(body.taskId);
  const runnerEngine = parseRunnerEngine(body.runnerEngine);
  const runnerCommand = parseRunnerCommand(body.runnerCommand);
  const thinkingBudget = parseThinkingBudget(body.thinkingBudget);
  const model = parseModel(body.model);
  const timeoutSeconds = parseTimeoutSeconds(body.timeoutSeconds);
  const useWorktree = parseOptionalBoolean(body.useWorktree, 'useWorktree');
  const verify = parseOptionalBoolean(body.verify, 'verify');
  const autoMerge = parseOptionalBoolean(body.autoMerge, 'autoMerge');

  let run: RunnerRecord;
  try {
    run = await supervisor.dispatch({
      taskId,
      runnerEngine,
      runnerCommand,
      thinkingBudget,
      model,
      timeoutSeconds,
      useWorktree,
      verify,
      autoMerge,
    });
  } catch (err) {
    toHttpError(err);
  }
  return { ok: true, run: runView(run) };
}

/** POST /api/pipeline/tasks/abort: terminates the runner's process tree and settles the run as aborted. */
export async function handleTaskAbort(supervisor: AgentSupervisor, body: Record<string, unknown>) {
  const taskId = parseTaskId(body.taskId);
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"reason" must be a string');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  }

  try {
    const { status, message } = await supervisor.abort(taskId, reason || undefined);
    return { ok: true, taskId, status, message };
  } catch (err) {
    toHttpError(err);
  }
}

/** GET /api/pipeline/tasks/runs: active and recent runs, newest first. */
export function handleTaskRuns(supervisor: AgentSupervisor, searchParams: URLSearchParams) {
  const rawTaskId = searchParams.get('taskId');
  const taskId = rawTaskId === null || rawTaskId === '' ? undefined : parseTaskId(rawTaskId);
  const runs = supervisor.listRuns({ taskId, activeOnly: parseBooleanParam(searchParams.get('activeOnly')) });
  return { ok: true, runs: runs.map(runView) };
}

/** GET /api/pipeline/tasks/logs: tail of a runner's streaming log buffer. */
export function handleTaskLogs(supervisor: AgentSupervisor, searchParams: URLSearchParams) {
  const taskId = parseTaskId(searchParams.get('taskId'));
  const { status, totalBytes, log, runId, truncated } = supervisor.getLogs(taskId, parseTailLines(searchParams.get('tailLines')));
  if (status === null) throw new HttpError(400, 'RUN_NOT_FOUND', `No runner history for task "${taskId}"`);
  return { ok: true, taskId, runId, status, totalBytes, log, truncated };
}
