import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { loadPlan } from '../../core/lock-manager.js';
import { MasterPlan, MasterPlanTask } from '../../scanner/types.js';
import { getPlanPath } from './task-common.js';

export interface TaskShowOptions {
  json?: boolean;
}

/** The sentence shown when someone acts on a task that moved to an archive file. */
export function archivedTaskMessage(taskId: string, milestoneId: string): string {
  return `Task [${taskId}] is archived (milestone ${milestoneId}). `
    + `Run \`nativ milestone restore ${milestoneId}\` to bring its tasks back first.`;
}

export function findArchivedMilestoneId(plan: MasterPlan, taskId: string): string | undefined {
  return plan.milestones.find((m) => m.archived?.taskIds.includes(taskId))?.id;
}

function readFromArchive(targetDir: string, plan: MasterPlan, taskId: string) {
  const milestone = plan.milestones.find((m) => m.archived?.taskIds.includes(taskId));
  if (!milestone?.archived) return null;
  const file = path.join(targetDir, milestone.archived.file);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const task = (saved.tasks as MasterPlanTask[]).find((t) => t.id === taskId);
  if (!task) throw new Error(`${milestone.archived.file} has no task ${taskId}`);
  return { task, milestoneId: milestone.id };
}

function findTask(targetDir: string, plan: MasterPlan, taskId: string) {
  for (const m of plan.milestones) {
    const task = m.tasks.find((t) => t.id === taskId);
    if (task) return { task, milestoneId: m.id, archived: false };
  }
  const found = readFromArchive(targetDir, plan, taskId);
  return found && { ...found, archived: true };
}

/** Prints one task from the plan or, when archived, from its archive file. */
export async function runTaskShow(taskId: string, targetDirArg?: string, options: TaskShowOptions = {}) {
  const { targetDir, planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }
  let found;
  try {
    found = findTask(targetDir, plan, taskId);
  } catch (err: any) {
    console.error(pc.red(`\n✖ The archive of task [${taskId}] cannot be read: ${err.message}\n`));
    process.exitCode = 1;
    return;
  }
  if (!found) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify({ ...found.task, milestoneId: found.milestoneId, archived: found.archived }, null, 2));
    return;
  }
  const { task } = found;
  const where = found.archived ? `${found.milestoneId}, archived` : found.milestoneId;
  console.log(pc.bold(pc.cyan(`\n[${task.id}] ${task.title}`)) + pc.dim(` (${where})`));
  console.log(`  Status: ${task.status} | Agent: ${task.assignedSubagent}`);
  console.log(`  Verify: \`${task.verificationCommand || 'none'}\``);
  if (task.dependencies?.length) console.log(`  Depends on: ${task.dependencies.join(', ')}`);
  if (task.targetFiles?.length) console.log(`  Files: ${task.targetFiles.join(', ')}`);
  if (task.description) console.log(`\n${task.description}`);
  if (task.notes) console.log(pc.dim(`\nNotes: ${task.notes}`));
  console.log('');
}
