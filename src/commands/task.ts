import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  isSubagentType,
  MasterPlan,
  MasterPlanMilestone,
  MasterPlanTask,
  SUBAGENT_TYPES,
  SubagentType,
  validateMasterPlanTask,
  EscalationFile,
  EscalationRecord,
  EscalationType,
} from '../scanner/types.js';
import { executeVerification, VerificationResult } from '../core/verifier.js';
import {
  ContractGovernor,
  CircuitBreaker,
  ContractPatch,
  TestIntegrityGuard,
  resolveGitHead,
  appendEscalation,
} from '../governor/index.js';
import { loadPlan, savePlan, withPlanLock } from '../core/lock-manager.js';
import { recordTaskStart, recordTaskComplete } from '../core/telemetry.js';
import { addTaskUnlock, removeTaskUnlock } from '../core/enforcement.js';

export { loadPlan, savePlan, withPlanLock };

function getPlanPath(targetDirArg?: string): { targetDir: string; planPath: string } {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const planPath = path.join(targetDir, '.ai', 'master_plan.json');
  return { targetDir, planPath };
}

export function getRoleGuide(assignedSubagent: SubagentType): string {
  const normalized = assignedSubagent
    .replace(/-agent$/, '')
    .replace(/^qa$/, 'qa-tester');

  const fileMap: Record<string, string> = {
    backend: 'backend.md',
    frontend: 'frontend.md',
    database: 'database.md',
    'qa-tester': 'qa-tester.md',
    'flutter-developer': 'flutter-developer.md',
    'devops-agent': 'devops-agent.md',
    'security-auditor': 'security-auditor.md',
    'db-migration': 'db-migration.md',
  };

  const filename = fileMap[assignedSubagent] || fileMap[normalized] || `${normalized}.md`;
  return `.ai/subagents/${filename}`;
}

export function getRecommendedContractSlice(assignedSubagent: SubagentType): string {
  const sub = assignedSubagent.toLowerCase();
  if (sub.includes('frontend') || sub.includes('flutter')) {
    return '.ai/ui_specs.md (UI tokens & hierarchy) + .ai/api_contracts.json (Client endpoint integration)';
  }
  if (sub.includes('backend')) {
    return '.ai/api_contracts.json (Endpoint routes, request/response schemas) + .ai/db_schema.json (Models)';
  }
  if (sub.includes('database') || sub.includes('db-migration')) {
    return '.ai/db_schema.json (Database schema contract & models)';
  }
  if (sub.includes('devops')) {
    return '.ai/context.md (Infrastructure, runtime & deployment guardrails)';
  }
  if (sub.includes('security')) {
    return 'Target files & dependency manifests (.ai/context.md security guardrails)';
  }
  if (sub.includes('qa')) {
    return 'Target files, .ai/api_contracts.json, and verification test suite';
  }
  return '.ai/context.md';
}

export async function runTaskList(
  targetDirArg?: string,
  options: {
    available?: boolean;
    status?: string;
    milestone?: string;
    fastPath?: boolean;
    json?: boolean;
  } = {}
) {
  const { planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  const completedTaskIds = new Set<string>();
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      if (t.status === 'completed') {
        completedTaskIds.add(t.id);
      }
    }
  }

  const results: Array<{
    task: MasterPlanTask;
    milestoneId: string;
    milestoneName: string;
    isAvailable: boolean;
  }> = [];

  for (const m of plan.milestones) {
    if (options.milestone && m.id !== options.milestone && !m.name.toLowerCase().includes(options.milestone.toLowerCase())) {
      continue;
    }

    for (const t of m.tasks) {
      const deps = t.dependencies || [];
      const depsSatisfied = deps.every((d) => completedTaskIds.has(d));
      const isAvailable = (t.status === 'pending' || t.status === 'in_progress') && depsSatisfied;

      if (options.available && !isAvailable) {
        continue;
      }
      if (options.status && t.status !== options.status) {
        continue;
      }
      if (options.fastPath && t.fastPath !== true && m.fastPath !== true) {
        continue;
      }

      results.push({
        task: t,
        milestoneId: m.id,
        milestoneName: m.name,
        isAvailable,
      });
    }
  }

  if (options.json) {
    const jsonOutput = results.map(({ task, milestoneId, milestoneName, isAvailable }) => ({
      ...task,
      milestoneId,
      milestoneName,
      isAvailable,
      roleGuide: getRoleGuide(task.assignedSubagent),
      contractSlice: getRecommendedContractSlice(task.assignedSubagent),
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  console.log(pc.bold(pc.cyan(`\n📋 nativ Tasks: ${plan.projectName}`)));
  console.log(pc.dim(`Overall Status: ${plan.overallStatus.toUpperCase()} | Active Milestone: ${plan.activeMilestoneId}\n`));

  if (results.length === 0) {
    console.log(pc.yellow('  No tasks match the specified filters.\n'));
    return;
  }

  const grouped = new Map<string, typeof results>();
  for (const item of results) {
    const key = `[${item.milestoneId}] ${item.milestoneName}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(item);
  }

  for (const [milestoneTitle, items] of grouped.entries()) {
    console.log(pc.bold(`🚩 Milestone ${milestoneTitle}`));
    for (const { task: t, isAvailable } of items) {
      let statusBadge = pc.gray('○ pending');
      if (t.status === 'completed') {
        statusBadge = pc.green('✔ completed');
      } else if (t.status === 'in_progress') {
        statusBadge = pc.yellow('▶ in_progress');
      } else if (t.status === 'blocked') {
        statusBadge = pc.red('✖ blocked');
      }

      const readyBadge = isAvailable && t.status === 'pending' ? pc.bgGreen(pc.black(' READY ')) + ' ' : '';
      const fastBadge = t.fastPath ? pc.magenta('[fast path] ') : '';
      console.log(`  ${statusBadge} ${readyBadge}${fastBadge}${pc.bold(t.id)}: ${t.title}`);
      const depText = t.dependencies && t.dependencies.length > 0 ? pc.dim(`deps: ${t.dependencies.join(', ')}`) : pc.dim('no deps');
      const filesText = t.targetFiles && t.targetFiles.length > 0 ? pc.cyan(t.targetFiles.join(', ')) : pc.dim('none');
      console.log(pc.dim(`    Agent: `) + pc.magenta(`[${t.assignedSubagent}]`) + pc.dim(` | ${depText} | Files: ${filesText}`));
      if (t.notes) {
        console.log(pc.dim(`    Note: `) + (t.status === 'blocked' ? pc.red(t.notes) : pc.dim(t.notes)));
      }
    }
    console.log();
  }

  const completedCount = results.filter((r) => r.task.status === 'completed').length;
  const inProgressCount = results.filter((r) => r.task.status === 'in_progress').length;
  const pendingCount = results.filter((r) => r.task.status === 'pending').length;
  const blockedCount = results.filter((r) => r.task.status === 'blocked').length;

  console.log(pc.dim(`Showing ${results.length} tasks: `) +
    pc.green(`${completedCount} completed`) + pc.dim(', ') +
    pc.yellow(`${inProgressCount} in progress`) + pc.dim(', ') +
    pc.gray(`${pendingCount} pending`) + pc.dim(', ') +
    pc.red(`${blockedCount} blocked`) + '\n');
}

export async function runTaskNext(targetDirArg?: string, options: { json?: boolean } = {}) {
  const { planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  // Completed task lookup for dependency check
  const completedTaskIds = new Set<string>();
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      if (t.status === 'completed') {
        completedTaskIds.add(t.id);
      }
    }
  }

  // ── Prioritize Fast-Path tasks ─────────────────────────────────────────────
  // If any fast-path task is in_progress or ready to execute, prioritize it immediately!
  let fastPathCandidate: { task: MasterPlanTask; milestone: any } | null = null;
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      if (t.fastPath) {
        if (t.status === 'in_progress') {
          fastPathCandidate = { task: t, milestone: m };
          break;
        }
        if (t.status === 'pending') {
          const deps = t.dependencies || [];
          if (deps.every((depId) => completedTaskIds.has(depId))) {
            if (!fastPathCandidate) {
              fastPathCandidate = { task: t, milestone: m };
            }
          }
        }
      }
    }
    if (fastPathCandidate && fastPathCandidate.task.status === 'in_progress') break;
  }

  let activeMilestone: any;
  let targetTask: MasterPlanTask | null = null;

  if (fastPathCandidate) {
    activeMilestone = fastPathCandidate.milestone;
    targetTask = fastPathCandidate.task;
  } else {
    activeMilestone = plan.milestones.find((m) => m.id === plan.activeMilestoneId);
    if (!activeMilestone || activeMilestone.status === 'completed') {
      activeMilestone = plan.milestones.find((m) => m.status !== 'completed');
      if (activeMilestone) {
        plan.activeMilestoneId = activeMilestone.id;
        await withPlanLock(planPath, (p) => {
          p.activeMilestoneId = activeMilestone.id;
        });
      }
    }

    if (!activeMilestone) {
      if (options.json) {
        console.log(JSON.stringify({ status: 'all_milestones_completed', activeTask: null }, null, 2));
      } else {
        console.log(pc.bold(pc.green('\n🎉 All milestones and tasks are completed!\n')));
        console.log(pc.dim('Run `nativ status` to inspect final project statistics.\n'));
      }
      return;
    }

    // 1. Look for in_progress task first
    targetTask = activeMilestone.tasks.find((t: any) => t.status === 'in_progress') || null;

    // 2. If none in progress, find first pending task whose dependencies are satisfied
    if (!targetTask) {
      targetTask = activeMilestone.tasks.find((t: any) => {
        if (t.status !== 'pending') return false;
        const deps = t.dependencies || [];
        return deps.every((depId: string) => completedTaskIds.has(depId));
      }) || null;
    }

    // 3. If still none found, check if milestone has blocked tasks or waiting dependencies
    if (!targetTask) {
      const hasBlocked = activeMilestone.tasks.some((t: any) => t.status === 'blocked');
      if (options.json) {
        console.log(JSON.stringify({
          status: hasBlocked ? 'milestone_blocked' : 'waiting_dependencies',
          milestoneId: activeMilestone.id,
          milestoneName: activeMilestone.name,
          activeTask: null,
        }, null, 2));
      } else {
        if (hasBlocked) {
          console.log(pc.bold(pc.red(`\n✖ Milestone [${activeMilestone.id}] has blocked tasks.`)));
          console.log(pc.yellow('Run `nativ status` to review blockers.\n'));
        } else {
          console.log(pc.bold(pc.yellow(`\n⚠ Milestone [${activeMilestone.id}] has no immediately executable tasks due to unresolved dependencies.\n`)));
        }
      }
      return;
    }
  }

  const roleGuide = getRoleGuide(targetTask.assignedSubagent);
  const contractSlice = getRecommendedContractSlice(targetTask.assignedSubagent);

  if (options.json) {
    console.log(JSON.stringify({
      status: 'ready',
      milestoneId: activeMilestone.id,
      milestoneName: activeMilestone.name,
      task: {
        ...targetTask,
        roleGuide,
        recommendedContractSlice: contractSlice,
      }
    }, null, 2));
    return;
  }

  const fastTag = targetTask.fastPath ? pc.cyan(' [FAST-PATH PRIORITY]') : '';
  console.log(pc.bold(pc.cyan(`\n⚡ Next Executable Task in [${activeMilestone.id} - ${activeMilestone.name}]:`)) + fastTag);
  console.log(pc.bold(`\n  Task ID:           `) + pc.yellow(targetTask.id));
  console.log(pc.bold(`  Title:             `) + pc.white(targetTask.title));
  console.log(pc.bold(`  Status:            `) + (targetTask.status === 'in_progress' ? pc.yellow('▶ in_progress') : pc.gray('○ pending')));
  if (targetTask.fastPath) {
    console.log(pc.bold(`  Track:             `) + pc.cyan('⚡ fast-path (prioritized execution)'));
  }
  console.log(pc.bold(`  Assigned Role:     `) + pc.magenta(`[${targetTask.assignedSubagent}]`) + pc.dim(` -> ${roleGuide}`));
  console.log(pc.bold(`  JIT Contract Slice:`) + pc.green(` ${contractSlice}`));
  console.log(pc.bold(`  Target Files:      `) + (targetTask.targetFiles.length > 0 ? pc.cyan(targetTask.targetFiles.join(', ')) : pc.dim('none specified')));
  console.log(pc.bold(`  Verification Cmd:  `) + pc.yellow(`\`${targetTask.verificationCommand || 'none'}\``));
  if (targetTask.dependencies && targetTask.dependencies.length > 0) {
    console.log(pc.bold(`  Dependencies:      `) + pc.dim(targetTask.dependencies.join(', ')));
  }
  if (targetTask.notes) {
    console.log(pc.bold(`  Notes:             `) + pc.red(targetTask.notes));
  }

  console.log(pc.dim('\n─── Quick CLI Actions ──────────────────────────────────────────'));
  console.log(pc.dim('  Start task:   ') + pc.white(`nativ task start ${targetTask.id}`));
  console.log(pc.dim('  Complete task:') + pc.white(`nativ task complete ${targetTask.id}`));
  console.log(pc.dim('  Block task:   ') + pc.white(`nativ task block ${targetTask.id} --reason "..."`));
  console.log(pc.dim('  Escalate task:') + pc.white(`nativ task escalate ${targetTask.id} --type schema_flaw --details "..."\n`));
}

export async function runTaskStart(taskId: string, targetDirArg?: string) {
  const { targetDir, planPath } = getPlanPath(targetDirArg);
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

    foundTask.status = 'in_progress';
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

export interface TaskUnlockOptions {
  /** Why scope enforcement is being lifted; kept in .nativ/unlocks.json. */
  reason?: string;
  /** Re-locks the task instead. */
  revoke?: boolean;
}

/**
 * Lifts role enforcement's target-file scope for one task (emergency escape hatch), or restores it with
 * --revoke. Contract and secret paths stay protected either way. Deliberately CLI-only and not an MCP
 * tool: an agent must not be able to remove its own guardrail.
 */
export async function runTaskUnlock(taskId: string, targetDirArg?: string, options: TaskUnlockOptions = {}) {
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

export interface TaskCompleteOptions {
  notes?: string;
  skipVerify?: boolean;
  timeout?: number;
}

export async function runTaskComplete(
  taskId: string,
  targetDirArg?: string,
  options: TaskCompleteOptions = {}
) {
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
  // Runs before verification: a suite that was deleted or weakened can pass
  // trivially. `--no-verify` bypasses it only from an interactive terminal, so
  // headless agents cannot use the emergency override to skip it.
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
    vResult = await executeVerification(foundTask.verificationCommand, targetDir, options.timeout);
    if (!vResult.success) {
      console.error(pc.red(`\n✖ Task [${pc.bold(taskId)}] verification FAILED with exit code ${vResult.exitCode}:`));
      console.error(pc.yellow(`  Command: \`${foundTask.verificationCommand}\``));

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

    console.log(pc.yellow(`\n⚠ Task [${pc.bold(taskId)}] marked as `) + pc.red('✖ blocked'));
    console.log(pc.dim(`  Reason: ${foundTask.notes}\n`));
  });
}

export async function runTaskEscalate(
  taskId: string,
  targetDirArg?: string,
  options: {
    type?: string;
    details?: string;
    affected?: string;
  } = {}
) {
  const { targetDir, planPath } = getPlanPath(targetDirArg);
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

    const validTypes: EscalationType[] = [
      'contract_drift',
      'schema_flaw',
      'missing_credential',
      'dependency_conflict',
      'architectural_ambiguity',
    ];
    const escType = (options.type && validTypes.includes(options.type as EscalationType))
      ? (options.type as EscalationType)
      : 'architectural_ambiguity';

    const affectedContracts = options.affected
      ? options.affected.split(',').map((s) => s.trim())
      : ['.ai/db_schema.json', '.ai/api_contracts.json'];

    const summary = options.details || `Task ${taskId} blocked by ${escType}`;

    const reportedBy = foundTask.assignedSubagent;
    // Locked append: the id is numbered under the escalation file lock, so concurrent
    // escalations (and circuit-breaker trips) never collide or overwrite each other.
    const escId = appendEscalation(
      targetDir,
      (id): EscalationRecord => ({
        id,
        taskId,
        type: escType,
        reportedBy,
        timestamp: new Date().toISOString(),
        summary,
        details: options.details || '',
        affectedContracts,
        status: 'pending_review',
      }),
      { style: 'sequential', position: 'last', projectName: plan.projectName },
    );

    foundTask.status = 'blocked';
    foundTask.notes = `Escalated [${escId}]: ${summary}`;

    console.log(pc.bold(pc.yellow(`\n🚨 Task [${pc.bold(taskId)}] Escalated to the Architect!`)));
    console.log(pc.dim('  Escalation ID:      ') + pc.cyan(escId));
    console.log(pc.dim('  Type:               ') + pc.white(escType));
    console.log(pc.dim('  Reported By:        ') + pc.magenta(`[${foundTask.assignedSubagent}]`));
    console.log(pc.dim('  Affected Contracts: ') + pc.white(affectedContracts.join(', ')));
    console.log(pc.dim('  Details:            ') + pc.yellow(summary));
    console.log(pc.dim('\nNext Step for the Architect:'));
    console.log(pc.white(`  Ask the architect agent (Claude Code, or Antigravity if that is your host) to review .ai/escalation.json, update the affected contracts, and unblock the task. \`nativ triage\` can assess it first.\n`));
  });
}

// ─── Task add: dual-track router (planned milestones + fast path) ─────────

export const FAST_PATH_MILESTONE_NAME = 'Fast-Path Tasks';

/** Next `<prefix><n>` after the highest existing number, keeping that ID's zero-padding. */
function nextNumberedId(ids: string[], prefix: string, defaultWidth: number): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  let width = defaultWidth;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match && Number(match[1]) >= max) {
      max = Number(match[1]);
      width = match[1].length;
    }
  }
  const taken = new Set(ids);
  let n = max + 1;
  let candidate = `${prefix}${String(n).padStart(width, '0')}`;
  while (taken.has(candidate)) candidate = `${prefix}${String(++n).padStart(width, '0')}`;
  return candidate;
}

export function generateNextTaskId(plan: MasterPlan): string {
  return nextNumberedId(plan.milestones.flatMap((m) => m.tasks.map((t) => t.id)), 'task-', 2);
}

export function generateNextMilestoneId(plan: MasterPlan): string {
  return nextNumberedId(plan.milestones.map((m) => m.id), 'm', 1);
}

export interface TaskAddOptions {
  /** Milestone ID or name; defaults to the active milestone (or the fast-path milestone with fastPath). */
  milestone?: string;
  /** Assigned sub-agent (default backend). */
  agent?: string;
  /** Verification command run by the `task complete` gatekeeper. */
  verify?: string;
  /** Target files, comma-separated or as an array. */
  files?: string | string[];
  description?: string;
  fastPath?: boolean;
  /** Dependency task IDs, comma-separated or as an array. */
  deps?: string | string[];
  notes?: string;
  json?: boolean;
}

export interface TaskAddResult {
  task: MasterPlanTask;
  milestoneId: string;
  milestoneName: string;
  createdMilestone: boolean;
  reopenedMilestone: boolean;
}

function splitList(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function failTaskAdd(code: string, message: string, json?: boolean): null {
  if (json) console.log(JSON.stringify({ error: { code, message } }, null, 2));
  else console.error(pc.red(`\n✖ ${message}\n`));
  process.exitCode = 1;
  return null;
}

/** Resolves a milestone by exact ID, exact name, or a unique partial name (all case-insensitive). */
function findMilestone(plan: MasterPlan, query: string): MasterPlanMilestone | MasterPlanMilestone[] | null {
  const q = query.trim().toLowerCase();
  const exact = plan.milestones.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = plan.milestones.filter((m) => m.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  return partial.length > 1 ? partial : null;
}

/**
 * Appends a task to .ai/master_plan.json with an auto-incremented ID.
 * Routing: --milestone wins; otherwise fast-path tasks go to the fast-path milestone (created on
 * first use) and planned tasks to the active milestone. Completed milestones are reopened.
 */
export async function runTaskAdd(title: string, targetDirArg?: string, options: TaskAddOptions = {}): Promise<TaskAddResult | null> {
  const { planPath } = getPlanPath(targetDirArg);
  return withPlanLock(planPath, (plan, ctx) => {
    if (!Array.isArray(plan.milestones)) {
      ctx.abort();
      return failTaskAdd('INVALID_PLAN', '.ai/master_plan.json is missing its "milestones" array', options.json);
    }

    const cleanTitle = (title ?? '').trim();
    if (!cleanTitle) {
      ctx.abort();
      return failTaskAdd('INVALID_TITLE', 'A task title is required', options.json);
    }

    const agent = (options.agent ?? 'backend').trim();
    if (!isSubagentType(agent)) {
      ctx.abort();
      return failTaskAdd('INVALID_AGENT', `Unknown sub-agent "${agent}". Expected one of: ${SUBAGENT_TYPES.join(', ')}`, options.json);
    }

    const existingIds = new Set(plan.milestones.flatMap((m) => m.tasks.map((t) => t.id)));
    const deps = [...new Set(splitList(options.deps))];
    const unknownDeps = deps.filter((d) => !existingIds.has(d));
    if (unknownDeps.length) {
      ctx.abort();
      return failTaskAdd('UNKNOWN_DEPENDENCY', `Unknown dependency task ID(s): ${unknownDeps.join(', ')}`, options.json);
    }

    const fastPath = options.fastPath === true;
    let milestone: MasterPlanMilestone | undefined;
    let createdMilestone = false;

    if (options.milestone) {
      const found = findMilestone(plan, options.milestone);
      if (Array.isArray(found)) {
        ctx.abort();
        return failTaskAdd('AMBIGUOUS_MILESTONE', `"${options.milestone}" matches several milestones: ${found.map((m) => m.id).join(', ')}`, options.json);
      }
      if (!found) {
        ctx.abort();
        return failTaskAdd('UNKNOWN_MILESTONE', `Milestone "${options.milestone}" not found`, options.json);
      }
      milestone = found;
    } else if (fastPath) {
      milestone = plan.milestones.find((m) => m.fastPath === true);
      if (!milestone) {
        milestone = { id: generateNextMilestoneId(plan), name: FAST_PATH_MILESTONE_NAME, status: 'pending', fastPath: true, tasks: [] };
        plan.milestones.push(milestone);
        createdMilestone = true;
      }
    } else {
      const active = plan.milestones.find((m) => m.id === plan.activeMilestoneId);
      milestone = active && active.status !== 'completed' ? active : plan.milestones.find((m) => m.status !== 'completed');
      if (!milestone) {
        ctx.abort();
        return failTaskAdd('NO_OPEN_MILESTONE', 'Every milestone is completed. Pass --milestone <id> to reopen one, or --fast-path', options.json);
      }
    }

    const task: MasterPlanTask = {
      id: generateNextTaskId(plan),
      title: cleanTitle,
      description: (options.description ?? '').trim(),
      assignedSubagent: agent,
      dependencies: deps,
      targetFiles: splitList(options.files),
      status: 'pending',
      verificationCommand: (options.verify ?? '').trim(),
      notes: (options.notes ?? '').trim(),
      ...(fastPath ? { fastPath: true } : {}),
    };

    const problems = validateMasterPlanTask(task);
    if (problems.length) {
      ctx.abort();
      return failTaskAdd('INVALID_TASK', problems.join('; '), options.json);
    }

    milestone.tasks.push(task);
    const reopenedMilestone = milestone.status === 'completed';
    if (reopenedMilestone) milestone.status = 'in_progress';
    if (plan.overallStatus === 'completed') plan.overallStatus = 'in_progress';

    const result: TaskAddResult = { task, milestoneId: milestone.id, milestoneName: milestone.name, createdMilestone, reopenedMilestone };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return result;
    }

    const track = fastPath ? pc.magenta(' [fast path]') : '';
    console.log(pc.green(`\n✔ Task [${pc.bold(task.id)}] added to [${milestone.id}] ${milestone.name}`) + track);
    if (createdMilestone) console.log(pc.cyan(`  Created fast-path milestone [${milestone.id}]`));
    if (reopenedMilestone) console.log(pc.yellow(`  Reopened completed milestone [${milestone.id}]`));
    console.log(pc.dim('  Title:    ') + task.title);
    console.log(pc.dim('  Agent:    ') + pc.magenta(`[${task.assignedSubagent}]`) + pc.dim(` -> ${getRoleGuide(task.assignedSubagent)}`));
    console.log(pc.dim('  Files:    ') + (task.targetFiles.length ? pc.cyan(task.targetFiles.join(', ')) : pc.dim('none')));
    console.log(pc.dim('  Verify:   ') + (task.verificationCommand ? pc.yellow(`\`${task.verificationCommand}\``) : pc.dim('none (completion will not be gated)')));
    if (task.dependencies.length) console.log(pc.dim('  Deps:     ') + task.dependencies.join(', '));
    console.log(pc.dim('\n  Start it: ') + pc.white(`nativ task start ${task.id}\n`));
    return result;
  });
}

export interface ProposePatchOptions {
  taskId: string;
  target: 'db_schema' | 'api_contracts';
  operation: 'ADD' | 'ALTER' | 'DROP' | 'RENAME';
  path: string;
  value?: any;
  reason: string;
  baseHash?: string;
  json?: boolean;
}

export async function runTaskProposePatch(targetDirArg: string | undefined, options: ProposePatchOptions) {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  let parsedValue = options.value;
  if (typeof options.value === 'string') {
    try {
      parsedValue = JSON.parse(options.value);
    } catch {
      parsedValue = options.value;
    }
  }

  const patch: ContractPatch = {
    taskId: options.taskId,
    target: options.target,
    operation: options.operation,
    path: options.path,
    value: parsedValue,
    reason: options.reason || 'No reason provided',
    baseHash: options.baseHash,
  };

  const verdict = ContractGovernor.evaluate(targetDir, patch);

  if (options.json) {
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.approved) {
      process.exitCode = 1;
    }
    return verdict;
  }

  if (verdict.approved) {
    console.log(pc.green(`\n✔ [GOVERNOR APPROVED] Blast Radius: `) + pc.cyan(verdict.blastRadius));
    console.log(pc.dim('  Rule:    ') + pc.yellow(verdict.ruleId));
    console.log(pc.dim('  Message: ') + verdict.message);
    if (verdict.patchApplied) {
      console.log(pc.green(`  Patch automatically merged into .ai/${options.target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json'}`));
      console.log(pc.dim(`  Audit log updated at .ai/audit_log.jsonl\n`));
    }
  } else {
    console.error(pc.red(`\n✖ [GOVERNOR REJECTED] Blast Radius: `) + pc.red(verdict.blastRadius));
    console.error(pc.yellow(`  Rule:    ${verdict.ruleId}`));
    console.error(pc.red(`  Message: ${verdict.message}`));
    if (verdict.violations.length > 0) {
      console.error(pc.dim('  Violations:'));
      verdict.violations.forEach((v) => console.error(pc.red(`    • ${v}`)));
    }
    console.error(pc.yellow(`  Circuit Breaker: ${verdict.circuitBreaker.consecutiveFailures}/${verdict.circuitBreaker.maxThreshold} failures`));
    if (verdict.circuitBreaker.tripped) {
      console.error(pc.bold(pc.red(`  🛑 CIRCUIT BREAKER TRIPPED: Task locked to blocked.`)));
      console.error(pc.magenta(`  Escalation record written to .ai/escalation.json (${verdict.diagnosticBundle?.escalationId})\n`));
    } else {
      console.error(pc.dim('  Fix the issue or formulate a backward-compatible proposal.\n'));
    }
    process.exitCode = 1;
  }
  return verdict;
}
