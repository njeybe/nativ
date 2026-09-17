import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { MasterPlan } from '../scanner/types.js';

function isGitRepo(targetDir: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: targetDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function loadPlan(targetDir: string): MasterPlan | null {
  const planPath = path.join(targetDir, '.ai', 'master_plan.json');
  if (!fs.existsSync(planPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return null;
  }
}

export async function runWorktreeCreate(taskId: string, targetDirArg?: string) {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  if (!isGitRepo(targetDir)) {
    console.error(pc.red(`\n✖ Not a git repository: ${targetDir}`));
    console.log(pc.yellow('Git must be initialized to use worktree features.\n'));
    process.exitCode = 1;
    return;
  }

  const plan = loadPlan(targetDir);
  if (plan) {
    let taskExists = false;
    for (const m of plan.milestones) {
      if (m.tasks.some((t) => t.id === taskId)) {
        taskExists = true;
        break;
      }
    }
    if (!taskExists) {
      console.log(pc.yellow(`⚠ Warning: Task [${taskId}] is not declared in .ai/master_plan.json.`));
    }
  }

  const worktreeDir = path.join(targetDir, '.worktrees', `task-${taskId}`);
  const branchName = `agent/task-${taskId}`;

  if (fs.existsSync(worktreeDir)) {
    console.log(pc.yellow(`\n⚠ Worktree already exists at: ${worktreeDir}`));
    return;
  }

  try {
    console.log(pc.cyan(`\n🌿 Spawning isolated Git Worktree for Task [${taskId}]...`));
    execSync(`git worktree add "${worktreeDir}" -b "${branchName}"`, {
      cwd: targetDir,
      stdio: 'inherit',
    });

    console.log(pc.bold(pc.green(`\n✔ Worktree created successfully!`)));
    console.log(pc.dim('  Branch:   ') + pc.cyan(branchName));
    console.log(pc.dim('  Location: ') + pc.white(worktreeDir));
    console.log(pc.dim('\nExecution Instructions:'));
    console.log(pc.white(`  Run your agent in: ${worktreeDir}`));
    console.log(pc.dim(`  When completed and verified, merge with: `) + pc.cyan(`ai-agent-workflow worktree merge ${taskId}\n`));
  } catch (err: any) {
    console.error(pc.red(`\n✖ Failed to create git worktree: ${err.message}\n`));
    process.exitCode = 1;
  }
}

export async function runWorktreeList(targetDirArg?: string) {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  if (!isGitRepo(targetDir)) {
    console.error(pc.red(`\n✖ Not a git repository: ${targetDir}\n`));
    process.exitCode = 1;
    return;
  }

  try {
    const raw = execSync('git worktree list', { cwd: targetDir, encoding: 'utf8' });
    console.log(pc.bold(pc.cyan('\n🌿 Active Git Worktrees:')));
    const lines = raw.trim().split('\n');
    for (const line of lines) {
      if (line.includes('.worktrees')) {
        console.log(pc.green(`  ▶ ${line}`));
      } else {
        console.log(pc.dim(`  • ${line}`));
      }
    }
    console.log();
  } catch (err: any) {
    console.error(pc.red(`\n✖ Failed to list worktrees: ${err.message}\n`));
    process.exitCode = 1;
  }
}

export async function runWorktreeMerge(taskId: string, targetDirArg?: string) {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  if (!isGitRepo(targetDir)) {
    console.error(pc.red(`\n✖ Not a git repository: ${targetDir}\n`));
    process.exitCode = 1;
    return;
  }

  const worktreeDir = path.join(targetDir, '.worktrees', `task-${taskId}`);
  const branchName = `agent/task-${taskId}`;

  try {
    console.log(pc.cyan(`\n🔀 Merging worktree for Task [${taskId}]...`));

    // 1. Remove worktree directory
    if (fs.existsSync(worktreeDir)) {
      execSync(`git worktree remove "${worktreeDir}" --force`, { cwd: targetDir, stdio: 'inherit' });
      console.log(pc.dim(`  ✔ Removed worktree directory: ${worktreeDir}`));
    }

    // 2. Merge branch into current branch
    execSync(`git merge "${branchName}" --no-edit`, { cwd: targetDir, stdio: 'inherit' });
    console.log(pc.green(`  ✔ Merged branch ${pc.bold(branchName)} into current branch`));

    // 3. Delete branch
    try {
      execSync(`git branch -d "${branchName}"`, { cwd: targetDir, stdio: 'ignore' });
      console.log(pc.dim(`  ✔ Deleted branch ${branchName}`));
    } catch {
      // ignore if branch already deleted
    }

    console.log(pc.bold(pc.green(`\n✔ Task [${taskId}] worktree cleanly merged!\n`)));
  } catch (err: any) {
    console.error(pc.red(`\n✖ Failed to merge worktree: ${err.message}\n`));
    process.exitCode = 1;
  }
}
