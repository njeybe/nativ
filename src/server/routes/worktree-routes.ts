import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { CircuitBreaker } from '../../governor/index.js';
import { runWorktreeMerge, runWorktreeRemove, type WorktreeInfo } from '../../commands/worktree.js';
import type { MasterPlanTask } from '../../scanner/types.js';
import { HttpError } from '../http-utils.js';
import { parseTaskId, planMilestones, readPlan } from '../plan-utils.js';
import { jsonErrorMessage, runCaptured, truncateOutput } from '../cli-runner.js';

export interface PipelineWorktree extends WorktreeInfo {
  taskStatus: MasterPlanTask['status'] | null;
  mergeEligible: boolean;
  mergeBlockedReason: string | null;
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** `git diff --no-index` exits 1 when the inputs differ, so stdout is also read from that "error". */
export function gitNoIndexDiff(cwd: string, file: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['diff', '--no-index', '--', '/dev/null', file],
      { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(!err || (err as { code?: unknown }).code === 1 ? String(stdout) : ''),
    );
  });
}

/** Async twin of `nativ worktree list --json` (which blocks on execSync and prints to the console). */
export async function listGitWorktrees(root: string): Promise<WorktreeInfo[]> {
  let raw: string;
  try {
    raw = await git(root, ['worktree', 'list', '--porcelain']);
  } catch {
    return []; // Not a git repository, or git is unavailable.
  }

  const worktrees: WorktreeInfo[] = [];
  for (const block of raw.trim().split(/\r?\n\r?\n/)) {
    let wtPath = '';
    let head = '';
    let branch = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wtPath = line.slice(9).trim();
      else if (line.startsWith('HEAD ')) head = line.slice(5).trim();
      else if (line.startsWith('branch ')) branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    if (!wtPath) continue;
    worktrees.push({
      path: wtPath,
      head,
      branch: branch || 'detached',
      isAgentWorktree: wtPath.includes('.worktrees') || branch.startsWith('agent/task-'),
      taskId: /^agent\/task-(.+)$/.exec(branch)?.[1],
    });
  }
  return worktrees;
}

/**
 * GET /api/pipeline/worktrees. Merge eligibility mirrors the `nativ worktree merge` gatekeeper (task completed,
 * circuit breaker not tripped), and additionally requires the task to be declared in the plan.
 */
export async function describeWorktrees(root: string): Promise<PipelineWorktree[]> {
  const statusById = new Map(planMilestones(readPlan(root)).flatMap((m) => m.tasks.map((t) => [t.id, t.status] as const)));
  return (await listGitWorktrees(root)).map((wt) => {
    const taskStatus = (wt.taskId && statusById.get(wt.taskId)) || null;
    let mergeBlockedReason: string | null = null;
    if (!wt.isAgentWorktree || !wt.taskId) mergeBlockedReason = 'Not an agent task worktree';
    else if (!taskStatus) mergeBlockedReason = `Task "${wt.taskId}" is not declared in .ai/master_plan.json`;
    else if (taskStatus !== 'completed') mergeBlockedReason = `Task status is '${taskStatus}'; only completed tasks may be merged`;
    else if (CircuitBreaker.getStatus(root, wt.taskId).tripped) mergeBlockedReason = 'Circuit breaker is tripped; resolve the escalation before merging';
    return { ...wt, taskStatus, mergeEligible: mergeBlockedReason === null, mergeBlockedReason };
  });
}

/** POST /api/pipeline/worktrees/action: `nativ worktree merge|remove`, never forced past the merge gatekeeper. */
export async function handleWorktreeAction(root: string, body: Record<string, unknown>) {
  const { action } = body;
  if (action !== 'merge' && action !== 'remove') throw new HttpError(400, 'VALIDATION_ERROR', '"action" must be one of: merge, remove');
  const taskId = parseTaskId(body.taskId);

  const worktree = (await describeWorktrees(root)).find((wt) => wt.isAgentWorktree && wt.taskId === taskId);
  if (!worktree) throw new HttpError(400, 'WORKTREE_NOT_FOUND', `No agent worktree found for task "${taskId}"`);
  if (action === 'merge' && !worktree.mergeEligible) {
    throw new HttpError(400, 'MERGE_REJECTED', worktree.mergeBlockedReason ?? 'Merge rejected by the gatekeeper');
  }

  const { result, failed, output } = await runCaptured<{ message: string } | null>(() =>
    action === 'merge' ? runWorktreeMerge(taskId, root, { json: true }) : runWorktreeRemove(taskId, root, { json: true }),
  );
  if (failed || !result) {
    throw new HttpError(400, 'WORKTREE_ACTION_FAILED', jsonErrorMessage(output) ?? truncateOutput(output || `Worktree ${action} failed`));
  }
  return { ok: true, message: result.message };
}

/** GET /api/pipeline/worktrees/diff: uncommitted changes and unified diff for an agent worktree. */
export async function handleWorktreeDiff(root: string, searchParams: URLSearchParams) {
  const rawTaskId = searchParams.get('taskId');
  if (!rawTaskId) throw new HttpError(400, 'VALIDATION_ERROR', '"taskId" query parameter is required');
  const taskId = parseTaskId(rawTaskId);

  const worktree = (await describeWorktrees(root)).find((wt) => wt.isAgentWorktree && wt.taskId === taskId);
  if (!worktree || !fs.existsSync(worktree.path)) {
    throw new HttpError(400, 'WORKTREE_NOT_FOUND', `No agent worktree found for task "${taskId}"`);
  }

  let statusOut: string;
  try {
    // -z keeps paths unquoted and unambiguous; -uall lists the files inside untracked directories.
    statusOut = await git(worktree.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
  } catch {
    throw new HttpError(400, 'WORKTREE_INVALID', `Failed to read git status in the worktree for task "${taskId}"`);
  }

  const filesChanged: string[] = [];
  const untracked: string[] = [];
  const entries = statusOut.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    filesChanged.push(file);
    if (xy === '??') untracked.push(file);
    // Renames and copies carry the original path in the next field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }

  let diff = '';
  try {
    diff = await git(worktree.path, ['diff', 'HEAD']);
  } catch {
    diff = await git(worktree.path, ['diff']).catch(() => '');
  }
  // `git diff HEAD` skips untracked files; render them as additions without touching the index.
  for (const file of untracked) {
    diff += (await gitNoIndexDiff(worktree.path, file)) || `+++ b/${file} (untracked)\n`;
  }

  return {
    ok: true,
    taskId,
    branch: worktree.branch,
    hasChanges: filesChanged.length > 0,
    filesChanged,
    diff: diff.trim(),
  };
}
