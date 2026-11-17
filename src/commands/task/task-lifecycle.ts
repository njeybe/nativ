import path from 'node:path';
import { withArchivedAsDone } from '../../core/milestone-archive.js';
import pc from 'picocolors';
import { archivedTaskMessage, findArchivedMilestoneId } from './task-show.js';
import { parseIsolation } from '../verify.js';
import { resolveActiveProfileSettings } from '../../core/profiles.js';
import { resolveMainRoot } from '../../core/root-resolver.js';
import { MasterPlanTask, TaskOverride, TaskOverrideAction } from '../../scanner/types.js';
import { resolvePerson } from '../../core/identity.js';
import { runTaskVerification, VerificationResult } from '../../core/verifier.js';
import { evaluateSkip } from '../../core/verifier/skip-policy.js';
import { digestFailure } from '../../core/verifier/output-digest.js';
import {
  CircuitBreaker,
  TestIntegrityGuard,
  resolveGitHead,
  closeEscalationsForTask,
} from '../../governor/index.js';
import { loadPlan, withPlanLock } from '../../core/lock-manager.js';
import { recordTaskStart, recordTaskComplete } from '../../core/telemetry.js';
import { addTaskUnlock, removeTaskUnlock } from '../../core/enforcement.js';
import { appendEvent } from '../../core/activity/event-log.js';
import { cleanText } from '../../core/activity/normalize.js';
import type { VerifyData } from '../../core/activity/event-types.js';
import { refuseHeadless } from '../../core/human-gate.js';
import { claimConflict, droppedRefusal, resolveAgentId, startRefusal } from '../../core/task-claims.js';
import { isSettled, settleMilestone } from '../../core/plan-status.js';
import {
  getPlanPath,
  TaskUnlockOptions,
  TaskCompleteOptions,
} from './task-common.js';

export interface TaskStartOptions {
  /** Who claims the task; defaults to NATIV_AGENT_ID. */
  agent?: string;
  /** Human override: start a blocked task or one whose dependencies are unfinished. */
  force?: boolean;
}

export async function runTaskStart(taskId: string, targetDirArg?: string, options: TaskStartOptions = {}) {
  if (options.force && refuseHeadless('nativ task start --force')) return;
  const { targetDir, planPath } = getPlanPath(targetDirArg);
  const agent = resolveAgentId(options.agent);
  let started = false;
  await withPlanLock(planPath, async (plan, ctx) => {
    let foundTask: MasterPlanTask | null = null;
    let foundMilestone: any = null;

    for (const m of plan.milestones) {
      const t = m.tasks.find((task) => task.id === taskId);
      if (t) {
        foundTask = t;
        foundMilestone = m;
        break;
      }
    }

    if (!foundTask) {
      ctx.abort();
      const archivedIn = findArchivedMilestoneId(plan, taskId);
      const why = archivedIn
        ? archivedTaskMessage(taskId, archivedIn)
        : `Task [${taskId}] not found in .ai/master_plan.json`;
      console.error(pc.red(`\n✖ ${why}\n`));
      process.exitCode = 1;
      return;
    }

    if (refuseDropped(foundTask)) {
      ctx.abort();
      return;
    }

    const wouldRefuse = startRefusal(withArchivedAsDone(plan), foundTask, agent);
    const refusal = options.force ? null : wouldRefuse;
    if (options.force && wouldRefuse) recordOverride(foundTask, 'start --force', targetDir);
    if (refusal) {
      ctx.abort();
      console.error(pc.red(`\n✖ ${refusal}\n`));
      process.exitCode = 1;
      return;
    }

    const resumed = foundTask.status === 'in_progress';
    foundTask.status = 'in_progress';
    foundTask.claimedAt = new Date().toISOString();
    if (agent) foundTask.claimedBy = agent;
    else if (!resumed) delete foundTask.claimedBy;
    if (foundMilestone.status === 'pending') {
      foundMilestone.status = 'in_progress';
    }
    if (plan.overallStatus === 'pending') {
      plan.overallStatus = 'in_progress';
    }
    plan.activeMilestoneId = foundMilestone.id;

    // Pin the commit this task starts from so completion can prove the test
    // suites that existed here were not deleted or weakened.
    const baseline = resolveGitHead(targetDir);
    if (baseline) CircuitBreaker.recordBaseline(targetDir, taskId, baseline);

    try {
      await recordTaskStart(targetDir, foundTask);
    } catch {
      // Non-fatal
    }
    started = true;
    console.log(pc.green(`\n✔ Task [${pc.bold(taskId)}] marked as `) + pc.yellow('▶ in_progress') + '\n');
  });
  if (started) emitTaskEvent(targetDir, taskId, 'start', agent);
}

/** Appends a task lifecycle event; never throws, so it cannot change the command's result. */
export function emitTaskEvent(
  root: string,
  taskId: string,
  action: 'start' | 'complete' | 'block' | 'reclaim' | 'escalate',
  agent?: string,
): void {
  try {
    const by = cleanText(agent ?? resolveAgentId());
    appendEvent(root, {
      v: 1,
      at: new Date().toISOString(),
      src: 'cli',
      lane: { id: `cli:${by ?? 'terminal'}` },
      task: { id: taskId, via: 'command' },
      kind: 'task',
      data: { action, ...(by ? { by } : {}) },
    });
  } catch {
    // Activity logging is best effort.
  }
}

/** Counts only: no output, digest text or messages reach the log. */
function emitVerifyEvent(root: string, taskId: string, r: VerificationResult): void {
  try {
    const failed = r.phases?.find((p) => !p.success);
    const issues = r.codeShape?.issues ?? [];
    const byKind: Record<string, number> = {};
    for (const i of issues) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    const data: VerifyData = { pass: r.success, durationMs: r.durationMs, exitCode: r.exitCode };
    const phase = cleanText(failed?.name);
    if (phase) data.failedPhase = phase;
    if (r.skipped) data.skipped = true;
    if (issues.length) data.shape = { issues: issues.length, byKind };
    const by = cleanText(resolveAgentId());
    appendEvent(root, {
      v: 1,
      at: new Date().toISOString(),
      src: 'cli',
      lane: { id: `cli:${by ?? 'terminal'}` },
      task: { id: taskId, via: 'command' },
      kind: 'verify',
      data,
    });
  } catch {
    // Activity logging is best effort.
  }
}

export async function runTaskUnlock(taskId: string, targetDirArg?: string, options: TaskUnlockOptions = {}) {
  if (!options.revoke && refuseHeadless('nativ task unlock')) return;
  const { targetDir, planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }
  if (!plan.milestones.some((m) => m.tasks.some((t) => t.id === taskId))) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }

  if (options.revoke) {
    const removed = removeTaskUnlock(targetDir, taskId);
    console.log(removed ? pc.green(`\n✔ Task [${taskId}] re-locked to its target files.\n`) : pc.dim(`\nTask [${taskId}] was not unlocked.\n`));
    return;
  }
  addTaskUnlock(targetDir, taskId, options.reason?.trim() || undefined, resolvePerson(targetDir));
  console.log(pc.yellow(`\n⚠ Task [${pc.bold(taskId)}] unlocked: its agent may edit files outside targetFiles.`));
  console.log(pc.dim('  .ai/ contracts and secret files stay protected. Re-lock with `nativ task unlock ' + taskId + ' --revoke`.\n'));
}

export async function runTaskComplete(
  taskId: string,
  targetDirArg?: string,
  options: TaskCompleteOptions & { isolation?: string } = {}
) {
  if (options.skipVerify && refuseHeadless('nativ task complete --no-verify')) return;
  let isolation: 'none' | 'clean' | undefined;
  try {
    isolation = parseIsolation(options);
  } catch (e) {
    console.error(pc.red(`
✖ ${(e as Error).message}
`));
    process.exitCode = 1;
    return;
  }
  const root = resolveMainRoot(path.resolve(targetDirArg || process.cwd()));
  const profile = resolveActiveProfileSettings(root);
  if (isolation === 'none' &&
    profile.verifyIsolationFailure === 'block' &&
    refuseHeadless('nativ task complete --isolation none')) return;
  const { targetDir, planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  let foundTask: MasterPlanTask | null = null;
  let foundMilestone: any = null;

  for (const m of plan.milestones) {
    const t = m.tasks.find((task) => task.id === taskId);
    if (t) {
      foundTask = t;
      foundMilestone = m;
      break;
    }
  }

  if (!foundTask) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }

  const agent = resolveAgentId();
  if (refuseDropped(foundTask)) return;
  if (refuseOnClaim(foundTask, agent)) return;
  const seen = { status: foundTask.status, claimedBy: foundTask.claimedBy };

  // ── Test-Integrity Invariant ───────────────────────────────────────────────
  const integrity = TestIntegrityGuard.evaluate(targetDir, taskId);
  if (!integrity.approved) {
    const humanOverride = Boolean(options.skipVerify && process.stdin.isTTY);
    if (humanOverride) {
      console.log(pc.yellow(`\n⚠ Test-integrity violations overridden via --no-verify for [${taskId}]:`));
      integrity.findings.forEach((f) => console.log(pc.yellow(`    • ${f.detail}`)));
    } else {
      console.error(pc.red(`\n✖ Task [${pc.bold(taskId)}] cannot complete: ${integrity.message}`));
      integrity.findings.forEach((f) => console.error(pc.red(`    • [${f.rule}] ${f.detail}`)));
      console.error(
        pc.dim(`  Compared against ${integrity.baselineRecorded ? 'the commit recorded at task start' : 'HEAD'} (${integrity.baselineRef?.slice(0, 12)}).`),
      );

      const affected = [...new Set(integrity.findings.map((f) => f.path))];
      const { state, escalationId, proposal } = CircuitBreaker.recordGuardViolation(
        targetDir,
        taskId,
        integrity,
        { escalationType: 'architectural_ambiguity', affected, intent: `Complete task ${taskId} with modified test suites` },
        () => TestIntegrityGuard.proposeRestoration(targetDir, integrity),
      );
      console.error(pc.yellow(`  Circuit Breaker: ${state.consecutiveFailures}/${state.maxThreshold} failures`));
      if (state.tripped) {
        console.error(pc.bold(pc.red(`  🛑 CIRCUIT BREAKER TRIPPED: Task locked to blocked.`)));
        console.error(pc.magenta(`  Escalation record written to .ai/escalation.json (${escalationId})`));
        if (proposal?.kind === 'restore_tests') {
          console.error(pc.magenta(`  Self-healing proposal ${proposal.proposalId}: ${proposal.commands[0]}\n`));
        }
      } else {
        console.error(pc.white('  Restore the tests (or strengthen them) and retry. If removing them is intended, escalate:'));
        console.error(pc.white(`  nativ task escalate ${taskId} --type architectural_ambiguity --details "..."\n`));
      }
      process.exitCode = 1;
      return;
    }
  }

  // ── Verification Gatekeeper ────────────────────────────────────────────────
  let vResult: VerificationResult | null = null;
  if (!options.skipVerify) {
    vResult = await runTaskVerification(foundTask, { cwd: targetDir, timeout: options.timeout, isolation });
    emitVerifyEvent(targetDir, taskId, vResult);
    if (!vResult.success) {
      console.error(pc.red(`\n✖ Task [${pc.bold(taskId)}] verification FAILED with exit code ${vResult.exitCode}:`));
      const failedPhase = vResult.phases?.find((p) => !p.success);
      if (failedPhase) console.error(pc.yellow(`  Phase:   ${failedPhase.name}`));
      console.error(pc.yellow(`  Command: \`${vResult.command}\``));

      const digest = digestFailure(targetDir, taskId, vResult);
      if (digest.stderr) {
        console.error(pc.red('\n--- stderr ---'));
        console.error(pc.red(digest.stderr));
      }
      if (digest.stdout) {
        console.error(pc.dim('\n--- stdout ---'));
        console.error(pc.dim(digest.stdout));
      }
      if (vResult.error && !vResult.stderr?.includes(vResult.error)) {
        console.error(pc.red(`\nError: ${vResult.error}`));
      }
      if (digest.logFile) console.error(pc.dim(`\n  Full output: ${digest.logFile}`));

      console.error(pc.yellow(`\n⚠ Task remains '${foundTask.status}'. Fix the issue and retry:`));
      console.error(pc.white(`  nativ task complete ${taskId}`));
      console.error(pc.dim('  (or pass --no-verify to bypass verification check)\n'));
      process.exitCode = 1;
      return;
    }

    if (vResult.skipped) {
      const skip = evaluateSkip(foundTask, profile.skippedCheck);
      if (skip.action === 'block') {
        console.error(pc.red(`
✖ Task [${pc.bold(taskId)}] cannot complete: ${skip.message}`));
        console.error(pc.yellow(`  Task remains '${foundTask.status}'.
`));
        process.exitCode = 1;
        return;
      }
      if (skip.action === 'warn') console.log(pc.yellow(`
⚠ ${skip.message}`));
      console.log(pc.dim(`\n○ Verification skipped: no verification command specified for [${taskId}]`));
    } else {
      const elapsed = (vResult.durationMs / 1000).toFixed(2);
      const used = vResult.isolation ?? 'none';
      console.log(pc.green(`\n✔ Verification passed (${elapsed}s, isolation: ${used}): `) +
        pc.yellow(`\`${foundTask.verificationCommand}\``));
      for (const w of vResult.warnings ?? []) console.log(pc.yellow(`  ⚠ ${w}`));
    }
  } else {
    vResult = {
      command: foundTask.verificationCommand || 'none',
      durationMs: 0,
      exitCode: 0,
      stdout: '',
      stderr: '',
      skipped: true,
      success: true,
    };
    console.log(pc.yellow(`\n⚠ Verification skipped via --no-verify for [${taskId}]`));
  }

  let changed = false;
  let written = false;
  await withPlanLock(planPath, (plan, ctx) => {
    let taskToComplete: MasterPlanTask | null = null;
    let milestoneToComplete: any = null;

    for (const m of plan.milestones) {
      const t = m.tasks.find((task) => task.id === taskId);
      if (t) {
        taskToComplete = t;
        milestoneToComplete = m;
        break;
      }
    }

    if (!taskToComplete) {
      ctx.abort();
      console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
      process.exitCode = 1;
      return;
    }

    if (refuseDropped(taskToComplete)) {
      ctx.abort();
      changed = true;
      return;
    }

    const why = changedDuringVerification(taskToComplete, seen, agent);
    if (why) {
      ctx.abort();
      console.error(pc.red(`
✖ ${why}
`));
      process.exitCode = 1;
      changed = true;
      return;
    }

    if (options.skipVerify) recordOverride(taskToComplete, 'complete --no-verify', targetDir);
    taskToComplete.status = 'completed';
    delete taskToComplete.claimedBy;
    delete taskToComplete.claimedAt;
    if (options.notes) {
      taskToComplete.notes = options.notes;
    }
    written = true;

    // Completed and dropped tasks both settle a milestone
    if (milestoneToComplete.tasks.every(isSettled)) {
      const { next } = settleMilestone(plan, milestoneToComplete);
      console.log(pc.green(`\n🏁 Milestone [${pc.bold(milestoneToComplete.id)}] completed!`));
      if (next) {
        console.log(pc.cyan(`▶ Active milestone advanced to: [${next.id}] ${next.name}`));
      } else {
        console.log(pc.bold(pc.green('🎉 All project milestones completed!')));
      }
    }
  });
  if (changed) return;
  if (written) emitTaskEvent(targetDir, taskId, 'complete', agent);

  CircuitBreaker.recordSuccess(targetDir, taskId);
  CircuitBreaker.clearBaseline(targetDir, taskId);
  const closed = closeEscalationsForTask(targetDir, taskId, 'Closed automatically: the task was completed.');
  if (closed.length) console.log(pc.dim(`  Closed its open escalations: ${closed.join(', ')}`));

  try {
    await recordTaskComplete(targetDir, foundTask, vResult, options.notes);
  } catch {
    // Non-fatal telemetry recording
  }

  console.log(pc.green(`\n✔ Task [${pc.bold(taskId)}] successfully marked as `) + pc.green('✔ completed') + '\n');
}

export async function runTaskBlock(taskId: string, reason: string, targetDirArg?: string) {
  if (!reason || reason.trim().length === 0) {
    console.error(pc.red('\n✖ A reason must be provided via `--reason <text>` when blocking a task.\n'));
    process.exitCode = 1;
    return;
  }

  const { targetDir, planPath } = getPlanPath(targetDirArg);
  let blocked = false;
  await withPlanLock(planPath, (plan, ctx) => {
    let foundTask: MasterPlanTask | null = null;

    for (const m of plan.milestones) {
      const t = m.tasks.find((task) => task.id === taskId);
      if (t) {
        foundTask = t;
        break;
      }
    }

    if (!foundTask) {
      ctx.abort();
      console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
      process.exitCode = 1;
      return;
    }

    if (refuseDropped(foundTask) || refuseOnClaim(foundTask, resolveAgentId())) {
      ctx.abort();
      return;
    }

    foundTask.status = 'blocked';
    foundTask.notes = reason.trim();
    delete foundTask.claimedBy;
    delete foundTask.claimedAt;

    console.log(pc.yellow(`\n⚠ Task [${pc.bold(taskId)}] marked as `) + pc.red('✖ blocked'));
    console.log(pc.dim(`  Reason: ${foundTask.notes}\n`));
    blocked = true;
  });
  if (blocked) emitTaskEvent(targetDir, taskId, 'block');
}

/** Appends a record of a human override to the task; call it inside the plan lock. */
export function recordOverride(task: MasterPlanTask, action: TaskOverrideAction, root: string): void {
  const by = resolvePerson(root);
  const entry: TaskOverride = { action, at: new Date().toISOString(), ...(by ? { by } : {}) };
  task.overrides = [...(task.overrides ?? []), entry];
}

/** Prints and flags a dropped task; true when the caller must stop. */
function refuseDropped(task: MasterPlanTask): boolean {
  const why = droppedRefusal(task);
  if (!why) return false;
  console.error(pc.red(`\n✖ ${why}\n`));
  process.exitCode = 1;
  return true;
}

/** Prints and flags a fresh claim held by another explicit id; true when the caller must stop. */
function refuseOnClaim(task: MasterPlanTask, agent: string | undefined): boolean {
  const conflict = claimConflict(task, agent);
  if (!conflict) return false;
  console.error(pc.red(`
✖ ${conflict}
`));
  process.exitCode = 1;
  return true;
}

/** Why completion must not write: the task changed under us while verification ran. */
function changedDuringVerification(
  task: MasterPlanTask,
  seen: { status: string; claimedBy?: string },
  agent: string | undefined,
): string | null {
  if (task.status === 'completed') return `Task [${task.id}] is already completed; nothing to change.`;
  if (task.status === 'blocked' && seen.status !== 'blocked') {
    return `Task [${task.id}] was blocked while verification ran${task.notes ? ` (${task.notes})` : ''}.`;
  }
  const now = task.claimedBy;
  if (now && now !== seen.claimedBy && now !== agent) {
    return `Task [${task.id}] is already claimed by ${now} since ${task.claimedAt}. ` +
      'Pick another task with `nativ task next`.';
  }
  return null;
}
