import type { MasterPlan, MasterPlanTask } from '../scanner/types.js';
import { isSettled } from './plan-status.js';
import type { PlanChangeBody, Rewire } from './plan-changes.js';

/** The checks a plan change must pass against the live plan, with no I/O. */

export interface PlanIndex {
  live: Map<string, MasterPlanTask>;
  archivedIn: Map<string, string>;
  dropped: Set<string>;
}

export function indexPlan(plan: MasterPlan): PlanIndex {
  const idx: PlanIndex = { live: new Map(), archivedIn: new Map(), dropped: new Set() };
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      idx.live.set(t.id, t);
      if (t.status === 'dropped') idx.dropped.add(t.id);
    }
    for (const id of m.archived?.taskIds ?? []) idx.archivedIn.set(id, m.id);
    for (const id of m.archived?.droppedTaskIds ?? []) idx.dropped.add(id);
  }
  return idx;
}

const exists = (idx: PlanIndex, id: string): boolean => idx.live.has(id) || idx.archivedIn.has(id);

function hasCycle(deps: Map<string, string[]>): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    if ((deps.get(id) ?? []).some((d) => deps.has(d) && visit(d))) return true;
    state.set(id, 2);
    return false;
  };
  return [...deps.keys()].some(visit);
}

function checkDeps(idx: PlanIndex, task: MasterPlanTask, c: PlanChangeBody): string | null {
  for (const d of c.addDependencies ?? []) {
    if (d === task.id) return `${task.id} cannot depend on itself.`;
    if (!exists(idx, d)) return `${task.id} cannot depend on ${d}: no such task.`;
    if (task.dependencies.includes(d)) return `${task.id} already depends on ${d}.`;
    if (idx.dropped.has(d)) return `${task.id} cannot depend on ${d}: it was dropped.`;
  }
  const missing = (c.removeDependencies ?? []).find((d) => !task.dependencies.includes(d));
  return missing ? `${task.id} does not depend on ${missing}.` : null;
}

function checkDrop(idx: PlanIndex, task: MasterPlanTask, c: PlanChangeBody): string | null {
  const to = c.drop?.replacedBy;
  if (!c.drop) return null;
  if (!c.drop.reason) return `Dropping ${task.id} needs a reason.`;
  if (to === task.id) return `${task.id} cannot replace itself.`;
  if (to && !exists(idx, to)) return `${task.id} cannot be replaced by ${to}: no such task.`;
  if (to && idx.dropped.has(to)) return `${task.id} cannot be replaced by ${to}: it was dropped.`;
  const open = [...idx.live.values()].filter((t) => !isSettled(t) && t.dependencies.includes(task.id));
  if (!to && open.length) {
    return `${task.id} cannot be dropped without a replacement: ${open.map((t) => t.id).join(', ')} depend on it.`;
  }
  return null;
}

/** The dependency lists after the change, and the dependents a drop rewires. */
function project(idx: PlanIndex, task: MasterPlanTask, c: PlanChangeBody) {
  const kept = [...idx.live].filter(([, t]) => t.status !== 'dropped');
  const deps = new Map(kept.map(([id, t]) => [id, t.dependencies]));
  const rewired: Rewire[] = [];
  const remove = new Set(c.removeDependencies ?? []);
  deps.set(task.id, [...new Set([...task.dependencies.filter((d) => !remove.has(d)), ...(c.addDependencies ?? [])])]);
  if (c.drop) {
    deps.delete(task.id);
    const to = c.drop.replacedBy;
    for (const t of idx.live.values()) {
      if (!to || isSettled(t) || !t.dependencies.includes(task.id)) continue;
      deps.set(t.id, [...new Set(t.dependencies.map((d) => (d === task.id ? to : d)))]);
      rewired.push({ taskId: t.id, from: task.id, to });
    }
  }
  return { deps, rewired };
}

/** Runs every check on a plan; returns the refusal, or the effects the change would have. */
export function checkPlanChange(
  plan: MasterPlan, taskId: string, c: PlanChangeBody,
): string | { rewired: Rewire[] } {
  const idx = indexPlan(plan);
  const task = idx.live.get(taskId);
  if (!task) {
    const m = idx.archivedIn.get(taskId);
    return m ? `${taskId} is archived in ${m}; restore it first.` : `No task ${taskId} in the plan.`;
  }
  if (isSettled(task)) return `${taskId} is ${task.status}, so its plan can no longer change.`;
  const onlyNotes = Object.keys(c).every((k) => k === 'notes');
  if (task.status === 'in_progress' && !onlyNotes) return `${taskId} is in progress; only its notes can change.`;
  if (c.release && task.status !== 'blocked') return `${taskId} is ${task.status}, not blocked; it cannot be released.`;
  const refusal = checkDeps(idx, task, c) ?? checkDrop(idx, task, c);
  if (refusal) return refusal;
  const { deps, rewired } = project(idx, task, c);
  if (hasCycle(deps)) return `The change to ${taskId} would create a dependency cycle.`;
  return { rewired };
}
