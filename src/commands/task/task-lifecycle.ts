import pc from 'picocolors';
import { MasterPlanTask } from '../../scanner/types.js';
import { runTaskVerification, VerificationResult } from '../../core/verifier.js';
import {
  CircuitBreaker,
  TestIntegrityGuard,
  resolveGitHead,
  closeEscalationsForTask,
} from '../../governor/index.js';
import { loadPlan, withPlanLock } from '../../core/lock-manager.js';
import { recordTaskStart, recordTaskComplete } from '../../core/telemetry.js';
import { addTaskUnlock, removeTaskUnlock } from '../../core/enforcement.js';
import { refuseHeadless } from '../../core/human-gate.js';
import { resolveAgentId, startRefusal } from '../../core/task-claims.js';
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
  return withPlanLock(planPath, async (plan, ctx) => {
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
      console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
      process.exitCode = 1;
      return;
    }

    const refusal = options.force ? null : startRefusal(plan, foundTask, agent);
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
    console.log(pc.green(`\n✔ Task [${pc.bold(taskId)}] marked as `) + pc.yellow('▶ in_progress') + '\n');
  });
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
  addTaskUnlock(targetDir, taskId, options.reason?.trim() || undefined);
  console.log(pc.yellow(`\n⚠ Task [${pc.bold(taskId)}] unlocked: its agent may edit files outside targetFiles.`));
  console.log(pc.dim('  .ai/ contracts and secret files stay protected. Re-lock with `nativ task unlock ' + taskId + ' --revoke`.\n'));
}

export async function runTaskComplete(
  taskId: string,
  targetDirArg?: string,
  options: TaskCompleteOptions = {}
) {
  if (options.skipVerify && refuseHeadless('nativ task complete --no-verify')) return;
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
    vResult = await runTaskVerification(foundTask, { cwd: targetDir, timeout: options.timeout });
    if (!vResult.success) {
      console.error(pc.red(`\n✖ Task [${pc.bold(taskId)}] verification FAILED with exit code ${vResult.exitCode}:`));
      const failedPhase = vResult.phases?.find((p) => !p.success);
      if (failedPhase) console.error(pc.yellow(`  Phase:   ${failedPhase.name}`));
      console.error(pc.yellow(`  Command: \`${vResult.command}\``));

      if (vResult.stderr && vResult.stderr.trim()) {
        console.error(pc.red('\n--- stderr ---'));
        console.error(pc.red(vResult.stderr.trim()));
      }
      if (vResult.stdout && vResult.stdout.trim() && !vResult.stderr?.trim()) {
        console.error(pc.dim('\n--- stdout ---'));
        console.error(pc.dim(vResult.stdout.trim()));
      }
      if (vResult.error && !vResult.stderr?.includes(vResult.error)) {
        console.error(pc.red(`\nError: ${vResult.error}`));
      }

      console.error(pc.yellow(`\n⚠ Task remains '${foundTask.status}'. Fix the issue and retry:`));
      console.error(pc.white(`  nativ task complete ${taskId}`));
      console.error(pc.dim('  (or pass --no-verify to bypass verification check)\n'));
      process.exitCode = 1;
      return;
    }

    if (vResult.skipped) {
      console.log(pc.dim(`\n○ Verification skipped: no verification command specified for [${taskId}]`));
    } else {
      const elapsed = (vResult.durationMs / 1000).toFixed(2);
      console.log(pc.green(`\n✔ Verification passed (${elapsed}s): `) + pc.yellow(`\`${foundTask.verificationCommand}\``));
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

    taskToComplete.status = 'completed';
    delete taskToComplete.claimedBy;
    delete taskToComplete.claimedAt;
    if (options.notes) {
      taskToComplete.notes = options.notes;
    }

    // Check if milestone is completed
    const allMilestoneTasksDone = milestoneToComplete.tasks.every((t: MasterPlanTask) => t.status === 'completed');
    if (allMilestoneTasksDone) {
      milestoneToComplete.status = 'completed';
      console.log(pc.green(`\n🏁 Milestone [${pc.bold(milestoneToComplete.id)}] completed!`));

      // Find next milestone
      const nextMilestone = plan.milestones.find((m) => m.status !== 'completed');
      if (nextMilestone) {
        plan.activeMilestoneId = nextMilestone.id;
        console.log(pc.cyan(`▶ Active milestone advanced to: [${nextMilestone.id}] ${nextMilestone.name}`));
      } else {
        plan.overallStatus = 'completed';
        console.log(pc.bold(pc.green('🎉 All project milestones completed!')));
      }
    }
  });

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

  const { planPath } = getPlanPath(targetDirArg);
  return withPlanLock(planPath, (plan, ctx) => {
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

    foundTask.status = 'blocked';
    foundTask.notes = reason.trim();
    delete foundTask.claimedBy;
    delete foundTask.claimedAt;

    console.log(pc.yellow(`\n⚠ Task [${pc.bold(taskId)}] marked as `) + pc.red('✖ blocked'));
    console.log(pc.dim(`  Reason: ${foundTask.notes}\n`));
  });
}
