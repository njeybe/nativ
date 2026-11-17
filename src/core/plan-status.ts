import type { MasterPlan, MasterPlanMilestone, MasterPlanTask } from '../scanner/types.js';

/** A settled task needs no more work: it is completed or dropped. */
export function isSettled(task: Pick<MasterPlanTask, 'status'>): boolean {
  return task.status === 'completed' || task.status === 'dropped';
}

/** Ids that satisfy a dependency: completed live tasks plus archived ones, minus dropped. */
export function doneTaskIds(plan: MasterPlan): Set<string> {
  const done = new Set<string>();
  for (const m of plan.milestones) {
    for (const t of m.tasks) if (t.status === 'completed') done.add(t.id);
    const dropped = new Set(m.archived?.droppedTaskIds ?? []);
    for (const id of m.archived?.taskIds ?? []) if (!dropped.has(id)) done.add(id);
  }
  return done;
}

/** The tasks that count toward progress: dropped ones are left out. */
export function countedTasks<T extends Pick<MasterPlanTask, 'status'>>(tasks: T[]): T[] {
  return tasks.filter((t) => t.status !== 'dropped');
}

/** Completes a milestone and moves the plan to the next open one, or finishes the plan. */
export function settleMilestone(
  plan: MasterPlan,
  milestone: MasterPlanMilestone,
): { next: MasterPlanMilestone | null } {
  milestone.status = 'completed';
  const next = plan.milestones.find((m) => m.status !== 'completed') ?? null;
  if (next) plan.activeMilestoneId = next.id;
  else plan.overallStatus = 'completed';
  return { next };
}
