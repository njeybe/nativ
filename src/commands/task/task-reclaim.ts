import fs from 'node:fs';
import pc from 'picocolors';
import { withPlanLock } from '../../core/lock-manager.js';
import { refuseHeadless } from '../../core/human-gate.js';
import { DEFAULT_STALE_HOURS, claimAgeHours } from '../../core/task-claims.js';
import { getPlanPath } from './task-common.js';

export interface TaskReclaimOptions {
  /** Claims at least this many hours old are abandoned (default 4). */
  olderThan?: number;
  dryRun?: boolean;
  json?: boolean;
  /** Human override: reclaim a named task even though its claim is fresh. */
  force?: boolean;
}

export interface ReclaimedTask {
  id: string;
  claimedBy?: string;
  ageHours: number | null;
}

export interface TaskReclaimResult {
  reclaimed: ReclaimedTask[];
  /** in_progress tasks with no claim time (started before claims existed): reclaim them by id. */
  unknownAge: string[];
}

const round = (h: number | null) => (h === null ? null : Math.round(h * 10) / 10);

/** Puts in_progress tasks whose agent stopped (crash, closed session) back to pending so another agent can take them. */
export async function runTaskReclaim(taskId?: string, targetDirArg?: string, options: TaskReclaimOptions = {}): Promise<TaskReclaimResult | null> {
  const hours = options.olderThan ?? DEFAULT_STALE_HOURS;
  const fail = (message: string) => {
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(pc.red(`\n✖ ${message}\n`));
    process.exitCode = 1;
    return null;
  };
  if (!Number.isFinite(hours) || hours <= 0) return fail('--older-than must be a positive number of hours');
  if (options.force && refuseHeadless('nativ task reclaim --force')) return null;

  // `nativ task reclaim <dir>` reads naturally, so a lone existing directory is the target, not a task id.
  if (taskId && !targetDirArg && fs.existsSync(taskId) && fs.statSync(taskId).isDirectory()) {
    targetDirArg = taskId;
    taskId = undefined;
  }
  const { planPath } = getPlanPath(targetDirArg);
  const result: TaskReclaimResult = { reclaimed: [], unknownAge: [] };
  let error = null as string | null;
  let planRead = false as boolean;

  await withPlanLock(planPath, (plan, ctx) => {
    planRead = true;
    const now = Date.now();
    const inProgress = plan.milestones.flatMap((m) => m.tasks).filter((t) => t.status === 'in_progress');
    if (taskId && !inProgress.some((t) => t.id === taskId)) {
      error = `Task [${taskId}] is not in_progress, so there is nothing to reclaim.`;
    }
    for (const t of inProgress) {
      if (error || (taskId && t.id !== taskId)) continue;
      const age = claimAgeHours(t, now);
      const stale = age !== null && age >= hours;
      if (!taskId && age === null) {
        result.unknownAge.push(t.id);
        continue;
      }
      if (!stale && !(taskId && age === null) && !options.force) {
        if (taskId) error = `Task [${t.id}] was claimed${t.claimedBy ? ` by ${t.claimedBy}` : ''} ${round(age)}h ago; its agent may still be working. A human can pass --force.`;
        continue;
      }
      result.reclaimed.push({ id: t.id, ...(t.claimedBy ? { claimedBy: t.claimedBy } : {}), ageHours: round(age) });
      if (options.dryRun) continue;
      t.status = 'pending';
      delete t.claimedBy;
      delete t.claimedAt;
    }
    if (error || options.dryRun || !result.reclaimed.length) ctx.abort();
  });

  if (!planRead) return fail(`No readable plan at ${planPath}`);
  if (error) return fail(error);
  if (options.json) {
    console.log(JSON.stringify({ ok: true, dryRun: Boolean(options.dryRun), olderThanHours: hours, ...result }));
    return result;
  }
  const verb = options.dryRun ? 'Would reclaim' : 'Reclaimed';
  if (!result.reclaimed.length) console.log(pc.dim(`\nNo in_progress task has a claim older than ${hours}h.`));
  for (const r of result.reclaimed) {
    const who = r.claimedBy ? ` from ${r.claimedBy}` : '';
    const age = r.ageHours === null ? '' : ` (${r.ageHours}h old)`;
    console.log(pc.yellow(`\n↺ ${verb} [${pc.bold(r.id)}]${who}${age}: back to pending.`));
  }
  if (result.reclaimed.length && !options.dryRun) {
    console.log(pc.dim('  The previous agent may have left partial changes in the working tree; review them before restarting.'));
  }
  if (result.unknownAge.length) {
    console.log(pc.dim(`  No claim time on: ${result.unknownAge.join(', ')}. Reclaim one by id: nativ task reclaim <taskId>`));
  }
  console.log();
  return result;
}
