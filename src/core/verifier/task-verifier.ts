import fs from 'node:fs';
import path from 'node:path';
import { MasterPlan, MasterPlanTask, MasterPlanMilestone } from '../../scanner/types.js';
import { checkCodeShape, formatCodeShapeReport } from '../code-shape.js';
import { executeVerification } from './executor.js';
import { runVerifyPhases } from './phases.js';
import type {
  BatchVerificationResult,
  PhasesOutcome,
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
  if (report.mode === 'off') return result;
  result.codeShape = report;
  const summary = formatCodeShapeReport(report);
  if (summary) console.error(summary);
  if (report.mode === 'block' && report.issues.length > 0) {
    result.success = false;
    result.exitCode = 1;
    result.error = `Code shape check failed: ${report.issues.length} issue(s) (codeStyle.mode is "block")`;
  }
  return result;
}

/**
 * The one verification every path shares: the configured phases in order, stopping at the
 * first failure, then the task's own command, then the code-shape check.
 */
export async function runTaskVerification(
  task: MasterPlanTask,
  options: { cwd: string; configDir?: string; timeout?: number; phases?: PhasesOutcome }
): Promise<VerificationResult> {
  const configDir = options.configDir ?? options.cwd;
  const outcome = options.phases ?? (await runVerifyPhases(options.cwd, configDir, options.timeout));
  // In a batch the shared phase time is counted once, by the batch, not again for every task.
  if (outcome.failure) {
    return { ...outcome.failure, phases: outcome.reports, ...(options.phases ? { durationMs: 0 } : {}) };
  }
  const raw = await executeVerification(task.verificationCommand, options.cwd, options.timeout);
  if (outcome.reports.length) {
    raw.phases = outcome.reports;
    raw.durationMs += options.phases ? 0 : outcome.reports.reduce((sum, r) => sum + r.durationMs, 0);
    raw.skipped = false;
  }
  return applyCodeShape(raw, options.cwd, task);
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

/**
 * Verify a batch of tasks (by milestone, all completed tasks, or the active in-progress task).
 */
export async function verifyBatch(
  targetDirArg?: string,
  options: { taskId?: string; milestoneId?: string; all?: boolean; timeout?: number } = {}
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
      } else if (options.milestoneId && (m.id === options.milestoneId || m.name.toLowerCase() === options.milestoneId.toLowerCase())) {
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

  // The phases check the whole project, so one run serves every task in the batch.
  const phases = candidates.length ? await runVerifyPhases(targetDir, targetDir, options.timeout) : { reports: [] };
  totalDuration += phases.reports.reduce((sum, r) => sum + r.durationMs, 0);
  for (const { task, milestone } of candidates) {
    const vResult = await runTaskVerification(task, { cwd: targetDir, timeout: options.timeout, phases });
    totalDuration += vResult.durationMs;

    if (vResult.skipped) {
      skipped++;
    } else if (vResult.success) {
      passed++;
    } else {
      failed++;
    }

    results.push({
      taskId: task.id,
      title: task.title,
      milestoneId: milestone.id,
      milestoneName: milestone.name,
      status: task.status,
      result: vResult,
    });
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
