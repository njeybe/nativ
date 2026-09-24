import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  linkWorktreeAiDirectory,
  linkWorktreeNodeModules,
  safeUnlinkWorktreeAiDirectory,
  safeUnlinkWorktreeNodeModules,
} from './root-resolver.js';

export interface WorktreeMergeOutcome {
  merged: boolean;
  /** The agent left uncommitted changes; they were committed on the agent branch before merging. */
  committedPendingWork: boolean;
  /** Commit created for the pending work, when there was any. */
  pendingCommit: string | null;
  /** The worktree directory and agent branch were removed (only after a successful merge). */
  cleanedUp: boolean;
  message: string;
}

export class WorktreeMergeError extends Error {
  constructor(
    message: string,
    /** True when the worktree and agent branch were left in place with all work intact. */
    readonly workPreserved: boolean,
  ) {
    super(message);
    this.name = 'WorktreeMergeError';
  }
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

function remount(worktreeDir: string, rootDir: string): void {
  linkWorktreeAiDirectory(worktreeDir, rootDir);
  linkWorktreeNodeModules(worktreeDir, rootDir);
}

/**
 * Merges `agent/task-<id>` back into the current branch without ever losing agent work:
 *
 * 1. Uncommitted changes in the worktree are committed on the agent branch first — the
 *    verification gatekeeper checked the working tree, so that state is what gets merged.
 * 2. The branch is merged. On failure (e.g. conflicts) the merge is aborted and the
 *    worktree and branch are left exactly as they were.
 * 3. Only after a successful merge is the worktree removed and the (now merged) branch
 *    deleted with the safe `-d`.
 *
 * Git hooks run normally; a failing hook stops the merge with the work preserved.
 */
export function mergeAgentWorktree(rootDir: string, taskId: string): WorktreeMergeOutcome {
  const worktreeDir = path.join(rootDir, '.worktrees', `task-${taskId}`);
  const branch = `agent/task-${taskId}`;
  const hasWorktree = fs.existsSync(path.join(worktreeDir, '.git'));

  if (!git(rootDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    throw new WorktreeMergeError(`Branch ${branch} does not exist; nothing to merge.`, false);
  }

  let pendingCommit: string | null = null;
  if (hasWorktree) {
    // The .ai and node_modules junctions must never be staged, even in repos that do not ignore them.
    safeUnlinkWorktreeNodeModules(worktreeDir);
    safeUnlinkWorktreeAiDirectory(worktreeDir);

    const status = git(worktreeDir, ['status', '--porcelain']);
    if (!status.ok) {
      remount(worktreeDir, rootDir);
      throw new WorktreeMergeError(`Could not read the worktree status: ${status.out}`, true);
    }
    if (status.out) {
      const add = git(worktreeDir, ['add', '-A']);
      const commit = add.ok
        ? git(worktreeDir, ['commit', '-m', `chore(agent): commit uncommitted work from ${taskId}`, '-m', 'Recorded by nativ before merging the verified worktree.'])
        : add;
      if (!commit.ok) {
        remount(worktreeDir, rootDir);
        throw new WorktreeMergeError(
          `Could not commit the agent's uncommitted changes, so nothing was merged or removed: ${commit.out}`,
          true,
        );
      }
      pendingCommit = git(worktreeDir, ['rev-parse', 'HEAD']).out || null;
    }
  }

  const merge = git(rootDir, ['merge', branch, '--no-edit']);
  if (!merge.ok) {
    // Leave the main checkout as it was rather than half-merged.
    if (git(rootDir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok) git(rootDir, ['merge', '--abort']);
    if (hasWorktree) remount(worktreeDir, rootDir);
    const conflict = /CONFLICT|Automatic merge failed/i.test(merge.out);
    throw new WorktreeMergeError(
      `${conflict ? 'Merge conflict' : 'Merge failed'}; the worktree and ${branch} were kept with all work committed. ${merge.out}`,
      true,
    );
  }

  let cleanedUp = true;
  if (hasWorktree) {
    // Everything is committed and merged, so a plain remove succeeds; --force only clears ignored build output.
    if (!git(rootDir, ['worktree', 'remove', worktreeDir]).ok) {
      const leftover = git(worktreeDir, ['status', '--porcelain']);
      if (leftover.ok && !leftover.out) git(rootDir, ['worktree', 'remove', '--force', worktreeDir]);
    }
    git(rootDir, ['worktree', 'prune']);
  }
  // A directory without git metadata may still hold files nobody committed: report it, never delete it.
  if (fs.existsSync(worktreeDir)) cleanedUp = false;
  if (!git(rootDir, ['branch', '-d', branch]).ok) cleanedUp = false;

  return {
    merged: true,
    committedPendingWork: pendingCommit !== null,
    pendingCommit,
    cleanedUp,
    message:
      `Merged ${branch}` +
      (pendingCommit ? ' (uncommitted agent work was committed first)' : '') +
      (cleanedUp ? '' : '; the worktree or branch could not be removed and was left in place'),
  };
}
