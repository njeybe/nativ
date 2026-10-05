import pc from 'picocolors';
import path from 'node:path';
import { loadPlan, withPlanLock } from '../../core/lock-manager.js';
import { resolveSpecSlices } from '../../core/spec-slices.js';
import { resolveWorkerModel } from '../../core/model-routing.js';
import { learningsForTask, type Learning } from '../../core/learnings.js';
import { taskEscalationHistory } from '../../governor/index.js';
import type { MasterPlanTask } from '../../scanner/types.js';
import { getPlanPath, getRoleGuide, getRecommendedContractSlice } from './task-common.js';

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

/** What a worker needs from a lesson; status and audit fields stay in .ai/learnings.json. */
function toTaskLearning({ id, insight, details, files }: Learning) {
  return { id, insight, ...(details ? { details } : {}), ...(files ? { files } : {}) };
}

export async function runTaskNext(targetDirArg?: string, options: { json?: boolean } = {}) {
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

  // ── Prioritize Fast-Path tasks ─────────────────────────────────────────────
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
  const projectRoot = path.dirname(path.dirname(planPath));
  const learnings = learningsForTask(projectRoot, targetTask);
  const priorEscalations = taskEscalationHistory(projectRoot, targetTask.id);

  if (options.json) {
    const specResult = targetTask.specRefs?.length
      ? resolveSpecSlices(projectRoot, targetTask.specRefs)
      : null;
    const recommendedModel = resolveWorkerModel(projectRoot, targetTask);
    console.log(JSON.stringify({
      status: 'ready',
      milestoneId: activeMilestone.id,
      milestoneName: activeMilestone.name,
      task: {
        ...targetTask,
        roleGuide,
        recommendedContractSlice: contractSlice,
        ...(recommendedModel ? { recommendedModel } : {}),
        ...(specResult ? { specSlices: specResult.slices, ...(specResult.warnings.length ? { specWarnings: specResult.warnings } : {}) } : {}),
        ...(learnings.length ? { learnings: learnings.map(toTaskLearning) } : {}),
        ...(priorEscalations.length ? { priorEscalations } : {}),
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
  for (const l of learnings) {
    console.log(pc.bold(`  Learning:          `) + pc.white(`${l.id} ${l.insight}`));
  }
  for (const e of priorEscalations) {
    const outcome = e.resolutionNotes ? ` -> ${e.resolutionNotes}` : '';
    console.log(pc.bold(`  Past escalation:   `) + pc.white(`${e.id} ${e.status}: ${e.summary}${outcome}`));
  }

  console.log(pc.dim('\n─── Quick CLI Actions ──────────────────────────────────────────'));
  console.log(pc.dim('  Start task:   ') + pc.white(`nativ task start ${targetTask.id}`));
  console.log(pc.dim('  Complete task:') + pc.white(`nativ task complete ${targetTask.id}`));
  console.log(pc.dim('  Block task:   ') + pc.white(`nativ task block ${targetTask.id} --reason "..."`));
  console.log(pc.dim('  Escalate task:') + pc.white(`nativ task escalate ${targetTask.id} --type schema_flaw --details "..."\n`));
}
