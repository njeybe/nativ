import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { MasterPlan, MasterPlanTask } from '../scanner/types.js';
import { resolveProjectRoot, linkWorktreeAiDirectory, safeUnlinkWorktreeAiDirectory } from '../core/root-resolver.js';
import { CircuitBreaker } from '../governor/index.js';

function isGitRepo(targetDir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: targetDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function loadPlan(rootDir: string): MasterPlan | null {
  const planPath = path.join(rootDir, '.ai', 'master_plan.json');
  if (!fs.existsSync(planPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return null;
  }
}

export interface WorktreeCreateOptions {
  json?: boolean;
}

export interface WorktreeCreateResult {
  success: boolean;
  taskId: string;
  branch: string;
  worktreeDir: string;
  aiMounted: boolean;
  message: string;
}

export async function runWorktreeCreate(
  taskId: string,
  targetDirArg?: string,
  options: WorktreeCreateOptions = {}
): Promise<WorktreeCreateResult | null> {
  const rootDir = resolveProjectRoot(targetDirArg);

  if (!isGitRepo(rootDir)) {
    const msg = `Not a git repository: ${rootDir}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(pc.red(`\n✖ ${msg}`));
      console.log(pc.yellow('Git must be initialized to use worktree features.\n'));
    }
    process.exitCode = 1;
    return null;
  }

  const plan = loadPlan(rootDir);
  if (plan) {
    let taskExists = false;
    for (const m of plan.milestones) {
      if (m.tasks.some((t) => t.id === taskId)) {
        taskExists = true;
        break;
      }
    }
    if (!taskExists && !options.json) {
      console.log(pc.yellow(`⚠ Warning: Task [${taskId}] is not declared in .ai/master_plan.json.`));
    }
  }

  const worktreeDir = path.join(rootDir, '.worktrees', `task-${taskId}`);
  const branchName = `agent/task-${taskId}`;

  if (fs.existsSync(worktreeDir)) {
    const msg = `Worktree already exists at: ${worktreeDir}`;
    if (options.json) {
      console.log(JSON.stringify({ success: true, taskId, branch: branchName, worktreeDir, alreadyExists: true, message: msg }, null, 2));
    } else {
      console.log(pc.yellow(`\n⚠ ${msg}\n`));
    }
    return { success: true, taskId, branch: branchName, worktreeDir, aiMounted: false, message: msg };
  }

  try {
    if (!options.json) {
      console.log(pc.cyan(`\n🌿 Spawning isolated Git Worktree for Task [${taskId}]...`));
    }

    fs.mkdirSync(path.join(rootDir, '.worktrees'), { recursive: true });
    execSync(`git worktree add "${worktreeDir}" -b "${branchName}"`, {
      cwd: rootDir,
      stdio: options.json ? 'pipe' : 'inherit',
    });

    // Link/mount .ai contract directory into the worktree
    const aiMounted = linkWorktreeAiDirectory(worktreeDir, rootDir);

    const result: WorktreeCreateResult = {
      success: true,
      taskId,
      branch: branchName,
      worktreeDir,
      aiMounted,
      message: `Worktree for ${taskId} created successfully`,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(pc.bold(pc.green(`\n✔ Worktree created successfully!`)));
      console.log(pc.dim('  Branch:     ') + pc.cyan(branchName));
      console.log(pc.dim('  Location:   ') + pc.white(worktreeDir));
      console.log(pc.dim('  .ai Mount:  ') + (aiMounted ? pc.green('Linked to project root') : pc.dim('Resolved dynamically')));
      console.log(pc.dim('\nExecution Instructions:'));
      console.log(pc.white(`  Run your agent in: ${worktreeDir}`));
      console.log(pc.dim(`  When completed and verified, merge with: `) + pc.cyan(`nativ worktree merge ${taskId}\n`));
    }

    return result;
  } catch (err: any) {
    const msg = `Failed to create git worktree: ${err.message}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(pc.red(`\n✖ ${msg}\n`));
    }
    process.exitCode = 1;
    return null;
  }
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string;
  isAgentWorktree: boolean;
  taskId?: string;
}

export async function runWorktreeList(targetDirArg?: string, options: { json?: boolean } = {}): Promise<WorktreeInfo[]> {
  const rootDir = resolveProjectRoot(targetDirArg);

  if (!isGitRepo(rootDir)) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: 'Not a git repository' }, null, 2));
    } else {
      console.error(pc.red(`\n✖ Not a git repository: ${rootDir}\n`));
    }
    process.exitCode = 1;
    return [];
  }

  try {
    const raw = execSync('git worktree list --porcelain', { cwd: rootDir, encoding: 'utf8' });
    const worktrees: WorktreeInfo[] = [];

    const blocks = raw.trim().split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n');
      let wtPath = '';
      let head = '';
      let branch = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) wtPath = line.substring(9).trim();
        else if (line.startsWith('HEAD ')) head = line.substring(5).trim();
        else if (line.startsWith('branch ')) branch = line.substring(7).trim().replace('refs/heads/', '');
      }

      if (wtPath) {
        const isAgent = wtPath.includes('.worktrees') || branch.startsWith('agent/task-');
        const match = branch.match(/^agent\/task-(.+)$/);
        worktrees.push({
          path: wtPath,
          head,
          branch: branch || 'detached',
          isAgentWorktree: isAgent,
          taskId: match ? match[1] : undefined,
        });
      }
    }

    if (options.json) {
      console.log(JSON.stringify(worktrees, null, 2));
      return worktrees;
    }

    console.log(pc.bold(pc.cyan('\n🌿 Active Git Worktrees:')));
    for (const wt of worktrees) {
      if (wt.isAgentWorktree) {
        console.log(pc.green(`  ▶ [${wt.taskId || 'agent'}] `) + pc.white(wt.branch) + pc.dim(` (${wt.path})`));
      } else {
        console.log(pc.dim(`  • [main] `) + pc.white(wt.branch) + pc.dim(` (${wt.path})`));
      }
    }
    console.log();
    return worktrees;
  } catch (err: any) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
    } else {
      console.error(pc.red(`\n✖ Failed to list worktrees: ${err.message}\n`));
    }
    process.exitCode = 1;
    return [];
  }
}

export interface WorktreeMergeOptions {
  force?: boolean;
  json?: boolean;
}

export interface WorktreeMergeResult {
  success: boolean;
  taskId: string;
  branch: string;
  merged: boolean;
  message: string;
}

export async function runWorktreeMerge(
  taskId: string,
  targetDirArg?: string,
  options: WorktreeMergeOptions = {}
): Promise<WorktreeMergeResult | null> {
  const rootDir = resolveProjectRoot(targetDirArg);

  if (!isGitRepo(rootDir)) {
    const msg = `Not a git repository: ${rootDir}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(pc.red(`\n✖ ${msg}\n`));
    }
    process.exitCode = 1;
    return null;
  }

  // ─── Safe Merge Gatekeeper ─────────────────────────────────────────────────
  if (!options.force) {
    // Check 1: Verify task status in master_plan.json
    const plan = loadPlan(rootDir);
    if (plan) {
      let foundTask: MasterPlanTask | null = null;
      for (const m of plan.milestones) {
        const t = m.tasks.find((task) => task.id === taskId);
        if (t) {
          foundTask = t;
          break;
        }
      }

      if (foundTask && foundTask.status !== 'completed') {
        const msg = `[GATEKEEPER REJECTED] Task '${taskId}' has status '${foundTask.status}'. Only tasks verified and marked 'completed' may be merged. (Use --force to override)`;
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: msg, status: foundTask.status }, null, 2));
        } else {
          console.error(pc.red(`\n✖ ${msg}`));
          console.log(pc.yellow(`Complete task verification first with:\n  nativ task complete ${taskId}\n`));
        }
        process.exitCode = 1;
        return null;
      }
    }

    // Check 2: Verify Governor Circuit Breaker is not tripped
    const breaker = CircuitBreaker.getStatus(rootDir, taskId);
    if (breaker.tripped) {
      const msg = `[GATEKEEPER REJECTED] Task '${taskId}' has a tripped Circuit Breaker in the Contract Governor. Active escalation must be resolved before merging.`;
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: msg, circuitBreaker: breaker }, null, 2));
      } else {
        console.error(pc.red(`\n✖ ${msg}\n`));
      }
      process.exitCode = 1;
      return null;
    }
  } else if (!options.json) {
    console.log(pc.yellow(`⚠ Safe Merge Gatekeeper bypassed via --force.`));
  }

  const worktreeDir = path.join(rootDir, '.worktrees', `task-${taskId}`);
  const branchName = `agent/task-${taskId}`;

  try {
    if (!options.json) {
      console.log(pc.cyan(`\n🔀 Merging worktree for Task [${taskId}]...`));
    }

    // 1. Remove worktree directory safely (unlinking .ai junction first)
    if (fs.existsSync(worktreeDir)) {
      safeUnlinkWorktreeAiDirectory(worktreeDir);
      execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: rootDir, stdio: options.json ? 'pipe' : 'inherit' });
      if (!options.json) {
        console.log(pc.dim(`  ✔ Removed worktree directory: ${worktreeDir}`));
      }
    }

    // 2. Merge branch into current branch
    execSync(`git merge "${branchName}" --no-edit`, { cwd: rootDir, stdio: options.json ? 'pipe' : 'inherit' });
    if (!options.json) {
      console.log(pc.green(`  ✔ Merged branch ${pc.bold(branchName)} into current branch`));
    }

    // 3. Delete branch
    try {
      execSync(`git branch -d "${branchName}"`, { cwd: rootDir, stdio: 'ignore' });
      if (!options.json) {
        console.log(pc.dim(`  ✔ Deleted branch ${branchName}`));
      }
    } catch {
      // Branch might require force delete or already removed
      try {
        execSync(`git branch -D "${branchName}"`, { cwd: rootDir, stdio: 'ignore' });
      } catch {
        // ignore
      }
    }

    const result: WorktreeMergeResult = {
      success: true,
      taskId,
      branch: branchName,
      merged: true,
      message: `Task [${taskId}] worktree cleanly merged`,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(pc.bold(pc.green(`\n✔ Task [${taskId}] worktree cleanly merged!\n`)));
    }

    return result;
  } catch (err: any) {
    const msg = `Failed to merge worktree: ${err.message}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(pc.red(`\n✖ ${msg}\n`));
    }
    process.exitCode = 1;
    return null;
  }
}

export interface WorktreeRemoveOptions {
  force?: boolean;
  json?: boolean;
}

export async function runWorktreeRemove(
  taskId: string,
  targetDirArg?: string,
  options: WorktreeRemoveOptions = {}
) {
  const rootDir = resolveProjectRoot(targetDirArg);

  if (!isGitRepo(rootDir)) {
    const msg = `Not a git repository: ${rootDir}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(pc.red(`\n✖ ${msg}\n`));
    }
    process.exitCode = 1;
    return null;
  }

  const worktreeDir = path.join(rootDir, '.worktrees', `task-${taskId}`);
  const branchName = `agent/task-${taskId}`;

  try {
    if (!options.json) {
      console.log(pc.yellow(`\n🗑 Cleaning up worktree for Task [${taskId}] without merging...`));
    }

    if (fs.existsSync(worktreeDir)) {
      safeUnlinkWorktreeAiDirectory(worktreeDir);
      execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: rootDir, stdio: options.json ? 'pipe' : 'inherit' });
      if (!options.json) {
        console.log(pc.dim(`  ✔ Removed worktree directory: ${worktreeDir}`));
      }
    }

    // Delete branch
    try {
      execSync(`git branch -D "${branchName}"`, { cwd: rootDir, stdio: 'ignore' });
      if (!options.json) {
        console.log(pc.dim(`  ✔ Discarded branch ${branchName}`));
      }
    } catch {
      // Ignore if branch doesn't exist
    }

    const result = {
      success: true,
      taskId,
      branch: branchName,
      removed: true,
      message: `Worktree for Task [${taskId}] removed`,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(pc.green(`\n✔ Worktree for Task [${taskId}] successfully removed.\n`));
    }
    return result;
  } catch (err: any) {
    const msg = `Failed to remove worktree: ${err.message}`;
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: msg }, null, 2));
    } else {
      console.error(pc.red(`\n✖ ${msg}\n`));
    }
    process.exitCode = 1;
    return null;
  }
}
