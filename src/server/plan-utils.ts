import fs from 'node:fs';
import path from 'node:path';
import { loadPlan } from '../core/lock-manager.js';
import type { MasterPlan, MasterPlanMilestone, MasterPlanTask } from '../scanner/types.js';
import { HttpError } from './http-utils.js';

export const AI_DIR = '.ai';
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function readPlan(root: string): MasterPlan | null {
  return loadPlan(path.join(root, AI_DIR, 'master_plan.json'), { silent: true, retries: 3 });
}

/** Milestones with a usable task list; tolerates hand-edited or half-written plans. */
export function planMilestones(plan: MasterPlan | null): MasterPlanMilestone[] {
  const milestones = plan?.milestones;
  if (!Array.isArray(milestones)) return [];
  return milestones.filter((m) => m && Array.isArray(m.tasks));
}

export function findTask(plan: MasterPlan | null, taskId: string): MasterPlanTask | null {
  for (const m of planMilestones(plan)) {
    const task = m.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

/** Task ids reach git branch names and shell commands in the worktree handlers, so the charset is strict. */
export function parseTaskId(value: unknown): string {
  const taskId = typeof value === 'string' ? value.trim() : '';
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"taskId" must be a task id (letters, digits, ".", "_" or "-")');
  }
  return taskId;
}
