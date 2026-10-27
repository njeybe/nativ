import fs from 'node:fs';
import path from 'node:path';
import { MasterPlan, MasterPlanTask, MasterPlanMilestone } from '../../scanner/types.js';
import { checkCodeShape, formatCodeShapeReport } from '../code-shape.js';
import { resolveActiveProfileSettings } from '../profiles.js';
import { resolveMainRoot } from '../root-resolver.js';
import {
  NO_ISOLATION, needsRun, openIsolation, runPhasesIn, runInPlan, diagnose,
} from './isolation.js';
import type { RunOptions } from './isolation.js';
import type {
  BatchVerificationResult,
  TaskVerificationResult,
  VerificationResult,
} from './types.js';

export function loadMasterPlan(targetDir: string): { planPath: string; plan: MasterPlan | null; error?: string } {
  const planPath = path.join(targetDir, '.ai', 'master_plan.json');
  if (!fs.existsSync(planPath)) {
    return { planPath, plan: null, error: `No .ai/master_plan.json found at: ${planPath}` };
  }
  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    const plan = JSON.parse(raw) as MasterPlan;
    return { planPath, plan };
  } catch (err: any) {
    return { planPath, plan: null, error: `Failed to parse .ai/master_plan.json: ${err.message}` };
  }
}

/**
 * Run the code-shape check on a task's target files and print a short summary to stderr.
 * In 'warn' mode (default) the result is untouched; in 'block' mode issues fail it with a reason.
 */
export function applyCodeShape(
  result: VerificationResult,
  targetDir: string,
  task: MasterPlanTask
): VerificationResult {
  if (result.skipped || !result.success) return result;
  const report = checkCodeShape(targetDir, task.targetFiles || []);
  if (report.issues.length === 0) return result;
  result.codeShape = report;
  const summary = formatCodeShapeReport(report);
  if (summary) console.error(summary);
  const blocking = report.issues.filter((i) =>
    (i.category === 'config' ? report.configMode : report.mode) === 'block');
  if (blocking.length > 0) {
    const names = [...new Set(blocking.filter((i) => i.category === 'config')
      .map((i) => i.message.split(' ')[0]))];
    const config = names.length > 0 ? `; unset-variable fallbacks: ${names.join(', ')}` : '';
    result.success = false;
    result.exitCode = 1;
    result.error = `Code shape check failed: ${blocking.length} issue(s) set to block${config}`;
  }
  return result;
}


/**
 * The one verification every path shares: the configured phases in order, stopping at the
 * first failure, then the task's own command (both in a clean copy when isolation is on),
 * then the code-shape check on the real tree.
 */
export async function runTaskVerification(
  task: MasterPlanTask,
  options: RunOptions,
): Promise<VerificationResult> {
  const configDir = options.configDir ?? options.cwd;
  const settings = resolveActiveProfileSettings(resolveMainRoot(configDir));
  const wanted = options.isolation ?? settings.verifyIsolation;
  const owned = !options.plan;
  const plan = options.plan
    ?? (needsRun([task.verificationCommand], configDir, !!options.phases)
      ? await openIsolation(options.cwd, configDir, wanted)
      : NO_ISOLATION);
  try {
    let result = await runInPlan(task, options, plan);
    result.isolation = plan.mode;
    if (plan.warnings.length) result.warnings = [...plan.warnings];
    if (plan.mode === 'clean' && !result.success) {
      result = await diagnose(task, options, result, settings.verifyIsolationFailure);
    }
    return applyCodeShape(result, options.cwd, task);
  } finally {
    if (owned) await plan.dispose?.();
  }
}

/**
 * Run verification for a single specific task in the plan.
 */
export async function verifyTask(
  taskId: string,
  targetDirArg?: string,
  options: { timeout?: number } = {}
): Promise<TaskVerificationResult> {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const { plan, error } = loadMasterPlan(targetDir);

  if (!plan) {
    return {
      taskId,
      title: 'Unknown',
      milestoneId: 'unknown',
      milestoneName: 'Unknown',
      status: 'unknown',
      result: {
        success: false,
        exitCode: 1,
        command: '',
        stdout: '',
        stderr: error || 'Failed to load master plan',
        durationMs: 0,
        error: error || 'Failed to load master plan',
      },
    };
  }

  let foundTask: MasterPlanTask | null = null;
  let foundMilestone: MasterPlanMilestone | null = null;

  for (const m of plan.milestones) {
    const t = m.tasks.find((item) => item.id === taskId);
    if (t) {
      foundTask = t;
      foundMilestone = m;
      break;
    }
  }

  if (!foundTask || !foundMilestone) {
    return {
      taskId,
      title: 'Not Found',
      milestoneId: 'unknown',
      milestoneName: 'Unknown',
      status: 'unknown',
      result: {
        success: false,
        exitCode: 1,
        command: '',
        stdout: '',
        stderr: `Task [${taskId}] not found in .ai/master_plan.json`,
        durationMs: 0,
        error: `Task [${taskId}] not found`,
      },
    };
  }

  const result = await runTaskVerification(foundTask, { cwd: targetDir, timeout: options.timeout });
  return {
    taskId: foundTask.id,
    title: foundTask.title,
    milestoneId: foundMilestone.id,
    milestoneName: foundMilestone.name,
    status: foundTask.status,
    result,
  };
}

function matchesMilestone(m: MasterPlanMilestone, wanted: string): boolean {
  return m.id === wanted || m.name.toLowerCase() === wanted.toLowerCase();
}

/**
 * Verify a batch of tasks (by milestone, all completed tasks, or the active in-progress task).
 */
export async function verifyBatch(
  targetDirArg?: string,
  options: {
    taskId?: string; milestoneId?: string; all?: boolean; timeout?: number; isolation?: 'none' | 'clean';
  } = {}
): Promise<BatchVerificationResult> {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const { plan, error } = loadMasterPlan(targetDir);

  if (!plan) {
    return {
      projectName: 'unknown',
      total: 0,
      passed: 0,
      failed: 1,
      skipped: 0,
      durationMs: 0,
      tasks: [
        {
          taskId: 'init',
          title: 'Plan Loader',
          milestoneId: 'unknown',
          milestoneName: 'Unknown',
          status: 'unknown',
          result: {
            success: false,
            exitCode: 1,
            command: '',
            stdout: '',
            stderr: error || 'Plan not found',
            durationMs: 0,
            error: error || 'Plan not found',
          },
        },
      ],
    };
  }

  // Filter tasks to run
  const candidates: { task: MasterPlanTask; milestone: MasterPlanMilestone }[] = [];

  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      if (options.taskId && t.id === options.taskId) {
        candidates.push({ task: t, milestone: m });
      } else if (options.milestoneId && matchesMilestone(m, options.milestoneId)) {
        candidates.push({ task: t, milestone: m });
      } else if (options.all) {
        // All tasks with verification commands (prefer completed or in_progress, but include all)
        candidates.push({ task: t, milestone: m });
      }
    }
  }

  // If no filters specified, find the current in_progress task, or next ready task
  if (!options.taskId && !options.milestoneId && !options.all) {
    let activeTask: { task: MasterPlanTask; milestone: MasterPlanMilestone } | null = null;
    for (const m of plan.milestones) {
      const inProgress = m.tasks.find((t) => t.status === 'in_progress');
      if (inProgress) {
        activeTask = { task: inProgress, milestone: m };
        break;
      }
    }
    if (!activeTask) {
      for (const m of plan.milestones) {
        const pending = m.tasks.find((t) => t.status === 'pending');
        if (pending) {
          activeTask = { task: pending, milestone: m };
          break;
        }
      }
    }
    if (activeTask) {
      candidates.push(activeTask);
    }
  }

  const results: TaskVerificationResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let totalDuration = 0;

  // The phases check the whole project, so one run (and one clean tree) serves every task.
  const wanted = options.isolation
    ?? resolveActiveProfileSettings(resolveMainRoot(targetDir)).verifyIsolation;
  const commands = candidates.map((c) => c.task.verificationCommand);
  const isolation = candidates.length && needsRun(commands, targetDir, false)
    ? await openIsolation(targetDir, targetDir, wanted)
    : NO_ISOLATION;
  try {
    const phases = candidates.length
      ? await runPhasesIn(isolation.dir ?? targetDir, targetDir, options.timeout, isolation.env)
      : { reports: [] };
    totalDuration += phases.reports.reduce((sum, r) => sum + r.durationMs, 0);
    for (const { task, milestone } of candidates) {
      const runOpts = { cwd: targetDir, timeout: options.timeout, phases, plan: isolation, isolation: wanted };
      const vResult = await runTaskVerification(task, runOpts);
      totalDuration += vResult.durationMs;
      if (vResult.skipped) skipped++;
      else if (vResult.success) passed++;
      else failed++;
      results.push({
        taskId: task.id,
        title: task.title,
        milestoneId: milestone.id,
        milestoneName: milestone.name,
        status: task.status,
        result: vResult,
      });
    }
  } finally {
    await isolation.dispose?.();
  }

  return {
    projectName: plan.projectName,
    total: candidates.length,
    passed,
    failed,
    skipped,
    durationMs: totalDuration,
    tasks: results,
  };
}
