import fs from 'node:fs';
import { GitChangesError, taskChanges } from '../../core/activity/git-changes.js';
import { findTranscript, formatTranscript, readTranscript } from '../../runner/transcript-view.js';
import type { ActivityFeed } from '../activity-feed.js';
import { HttpError } from '../http-utils.js';
import { findTask, parseTaskId, readPlan } from '../plan-utils.js';

const CURSOR_PATTERN = /^[^:\\/]+:\d+$/;
const MAX_RUN_ID_LENGTH = 200;

function intParam(params: URLSearchParams, name: string, min: number, max: number, dflt: number): number {
  const raw = params.get(name);
  if (raw === null) return dflt;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"${name}" must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function flagParam(params: URLSearchParams, name: string): boolean {
  const raw = params.get(name);
  if (raw === null || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new HttpError(400, 'VALIDATION_ERROR', `"${name}" must be true or false`);
}

/** GET /api/pipeline/activity: agent lanes and the newest events from the event log. */
export function handleActivity(feed: ActivityFeed, params: URLSearchParams) {
  const windowMinutes = intParam(params, 'windowMinutes', 1, 1440, 30);
  const limit = intParam(params, 'limit', 1, 500, 50);
  const since = params.get('since');
  if (since !== null && !CURSOR_PATTERN.test(since)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"since" must be a cursor from a previous response');
  }
  return feed.snapshot({ windowMinutes, limit, ...(since !== null ? { since } : {}) });
}

/** GET /api/pipeline/tasks/changes: files a task changed, from git. */
export async function handleTaskChanges(root: string, params: URLSearchParams) {
  const taskId = parseTaskId(params.get('taskId'));
  const full = flagParam(params, 'full');
  if (!findTask(readPlan(root), taskId)) throw new HttpError(400, 'TASK_NOT_FOUND', `No task "${taskId}" in the plan`);
  try {
    const changes = await taskChanges(root, taskId, { full });
    return { ok: true, taskId, ...changes };
  } catch (err) {
    if (err instanceof GitChangesError) {
      const code = err.code === 'NO_BASELINE' ? 'NO_BASELINE' : 'GIT_ERROR';
      throw new HttpError(code === 'NO_BASELINE' ? 400 : 500, code, err.message);
    }
    throw err;
  }
}

/** GET /api/pipeline/runs/transcript: a recorded run, formatted as `nativ runs show` prints it. */
export function handleRunTranscript(root: string, params: URLSearchParams) {
  const run = (params.get('run') ?? '').trim();
  if (!run || run.length > MAX_RUN_ID_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"run" is required: a run id, run id prefix or task id');
  }
  const full = flagParam(params, 'full');
  const found = findTranscript(root, run);
  if ('error' in found) throw new HttpError(400, 'RUN_NOT_FOUND', found.error);
  const { summary } = found;
  if (!fs.existsSync(summary.file)) throw new HttpError(400, 'RUN_NOT_FOUND', `No recorded run matches "${run}"`);
  const { events } = readTranscript(summary.file);
  return {
    ok: true,
    runId: summary.runId,
    taskId: summary.taskId,
    events: events.length,
    text: formatTranscript(events, { full }),
  };
}
