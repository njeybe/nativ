import type { EventEmitter } from 'node:events';
import { loadMasterPlan } from '../core/verifier.js';
import { appendEvent } from '../core/activity/event-log.js';
import { fromToolCall } from '../core/activity/normalize.js';
import type { ActivityEvent, EventLane, RunData, RunReason } from '../core/activity/event-types.js';
import { EVENT_LOG_VERSION } from '../core/activity/event-types.js';
import type { RunnerRecord, RunnerTokenUsageEvent } from './types.js';

/** A tool call the supervisor or native driver reports. `ok` is unset while a cli call awaits its result. */
export interface RunnerToolEvent {
  runId: string;
  taskId: string;
  id?: string;
  name?: string;
  input?: unknown;
  ok?: boolean;
  cwd?: string;
}

interface RunInfo {
  role?: string;
  model?: string;
  pending: Map<string, RunnerToolEvent>;
}

const TERMINAL = new Set(['completed', 'failed', 'aborted']);

/** Maps a finished run to a reason code. Only the code is kept, never the error text. */
export function reasonFor(
  record: Pick<RunnerRecord, 'status' | 'timedOut' | 'error' | 'verification'>,
): RunReason | undefined {
  if (record.status === 'aborted') return 'aborted';
  if (record.status !== 'failed') return undefined;
  const error = record.error ?? '';
  if (record.timedOut) return /no output/i.test(error) ? 'idle' : 'timeout';
  if (record.verification && !record.verification.success && !record.verification.skipped) return 'verify_failed';
  if (error.startsWith('Merge failed')) return 'merge_failed';
  if (error.startsWith('Worktree provisioning failed')) return 'worktree_failed';
  if (error.startsWith('Failed to spawn')) return 'spawn_failed';
  return 'exit_nonzero';
}

function roleOf(root: string, taskId: string): string | undefined {
  try {
    const { plan } = loadMasterPlan(root);
    for (const milestone of plan?.milestones ?? []) {
      const task = milestone.tasks.find((t) => t.id === taskId);
      if (task) return task.assignedSubagent || undefined;
    }
  } catch {
    // The role is a label only.
  }
  return undefined;
}

/** Records runner status, tool and usage events in the activity log. Returns a detach function. */
export function attachActivityLog(supervisor: EventEmitter, root: string): () => void {
  const runs = new Map<string, RunInfo>();
  const info = (runId: string, taskId: string): RunInfo => {
    let entry = runs.get(runId);
    if (!entry) {
      entry = { role: roleOf(root, taskId), pending: new Map() };
      runs.set(runId, entry);
    }
    return entry;
  };
  const lane = (runId: string, entry: RunInfo): EventLane => {
    const out: EventLane = { id: `run:${runId}`, runId };
    if (entry.role) out.role = entry.role;
    if (entry.model) out.model = entry.model;
    return out;
  };
  const writeTool = (e: RunnerToolEvent, ok: boolean): void => {
    const entry = info(e.runId, e.taskId);
    const event = fromToolCall(
      { name: e.name ?? '', input: e.input, ok },
      { root, runId: e.runId, cwd: e.cwd, role: entry.role, model: entry.model, taskId: e.taskId },
    );
    appendEvent(root, event);
  };
  const flush = (entry: RunInfo): void => {
    for (const call of entry.pending.values()) writeTool(call, true);
    entry.pending.clear();
  };

  const onStatus = (record: RunnerRecord & { at?: string }): void => {
    const entry = info(record.runId, record.taskId);
    entry.model = record.model ?? entry.model;
    if (TERMINAL.has(record.status)) flush(entry);
    const data: RunData = { runId: record.runId, status: record.status, engine: record.engine };
    if (record.model) data.model = record.model;
    if (typeof record.exitCode === 'number') data.exitCode = record.exitCode;
    const reason = reasonFor(record);
    if (reason) data.reason = reason;
    const event: ActivityEvent = {
      v: EVENT_LOG_VERSION,
      at: record.at ?? new Date().toISOString(),
      src: 'runner',
      lane: lane(record.runId, entry),
      task: { id: record.taskId, via: 'env' },
      kind: 'run',
      data,
    };
    appendEvent(root, event);
    if (TERMINAL.has(record.status)) runs.delete(record.runId);
  };

  const onTool = (e: RunnerToolEvent): void => {
    const entry = info(e.runId, e.taskId);
    if (e.name && e.ok === undefined) {
      if (e.id) entry.pending.set(e.id, e);
      return;
    }
    if (e.name) return writeTool(e, e.ok !== false);
    const call = e.id ? entry.pending.get(e.id) : undefined;
    if (!call || !e.id) return;
    entry.pending.delete(e.id);
    writeTool(call, e.ok !== false);
  };

  const onUsage = (u: RunnerTokenUsageEvent): void => {
    const entry = info(u.runId, u.taskId);
    entry.model = entry.model ?? u.model;
    const d = u.delta;
    appendEvent(root, {
      v: EVENT_LOG_VERSION,
      at: u.at,
      src: 'runner',
      lane: { ...lane(u.runId, entry), model: u.model },
      task: { id: u.taskId, via: 'env' },
      kind: 'usage',
      data: {
        runId: u.runId,
        model: u.model,
        turns: d.turns,
        input: d.inputTokens,
        output: d.outputTokens,
        cacheRead: d.cacheReadTokens,
        cacheCreation: d.cacheCreationTokens,
        costUsd: d.costUsd,
      },
    });
  };

  supervisor.on('runner_status', onStatus);
  supervisor.on('runner_tool', onTool);
  supervisor.on('runner_token_usage', onUsage);
  return () => {
    supervisor.off('runner_status', onStatus);
    supervisor.off('runner_tool', onTool);
    supervisor.off('runner_token_usage', onUsage);
  };
}
