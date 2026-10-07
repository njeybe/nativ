import type { MasterPlan, MasterPlanTask } from '../scanner/types.js';

/** A claim with no fresh `task start` for this long is presumed abandoned (crashed or closed agent). */
export const DEFAULT_STALE_HOURS = 4;
export const AGENT_ID_ENV = 'NATIV_AGENT_ID';

export function resolveAgentId(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (explicit ?? env[AGENT_ID_ENV] ?? '').trim() || undefined;
}

/** Hours since the task was claimed, or null when the claim time is unknown (claimed before claims were recorded). */
export function claimAgeHours(task: { claimedAt?: string }, now = Date.now()): number | null {
  const at = task.claimedAt ? Date.parse(task.claimedAt) : NaN;
  return Number.isFinite(at) ? Math.max(0, (now - at) / 3_600_000) : null;
}

export function isStaleClaim(task: { status: string; claimedAt?: string }, hours = DEFAULT_STALE_HOURS, now = Date.now()): boolean {
  const age = claimAgeHours(task, now);
  return task.status === 'in_progress' && age !== null && age >= hours;
}

/** Why `task start` must not claim this task, or null when it may. */
export function startRefusal(plan: MasterPlan, task: MasterPlanTask, agent: string | undefined, now = Date.now()): string | null {
  if (task.status === 'completed') return `Task [${task.id}] is already completed.`;
  if (task.status === 'blocked') {
    const why = task.notes ? ` (${task.notes})` : '';
    return `Task [${task.id}] is blocked${why}. Resolve it with \`nativ triage\` first; a human can override with \`nativ task start ${task.id} --force\`.`;
  }
  const done = new Set(plan.milestones.flatMap((m) => m.tasks).filter((t) => t.status === 'completed').map((t) => t.id));
  const waiting = (task.dependencies ?? []).filter((d) => !done.has(d));
  if (waiting.length) return `Task [${task.id}] waits on unfinished dependencies: ${waiting.join(', ')}.`;
  if (task.status === 'in_progress' && task.claimedBy && agent && task.claimedBy !== agent && !isStaleClaim(task, DEFAULT_STALE_HOURS, now)) {
    return `Task [${task.id}] is already claimed by ${task.claimedBy} since ${task.claimedAt}. Pick another task with \`nativ task next\`.`;
  }
  return null;
}
