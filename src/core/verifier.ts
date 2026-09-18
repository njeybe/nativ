import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { MasterPlan, MasterPlanTask, MasterPlanMilestone } from '../scanner/types.js';

export interface VerificationResult {
  success: boolean;
  exitCode: number;
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  skipped?: boolean;
}

export interface TaskVerificationResult {
  taskId: string;
  title: string;
  milestoneId: string;
  milestoneName: string;
  status: string;
  result: VerificationResult;
}

export interface BatchVerificationResult {
  projectName: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  tasks: TaskVerificationResult[];
}

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
 * Execute a verification command in the workspace directory with timeout and output capture.
 */
export async function executeVerification(
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<VerificationResult> {
  const trimmed = (command || '').trim();

  // Treat empty, 'none', or 'skip' as an informational pass
  if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'skip') {
    return {
      success: true,
      exitCode: 0,
      command: trimmed || 'none',
      stdout: '',
      stderr: '',
      durationMs: 0,
      skipped: true,
    };
  }

  // Cross-platform compatibility for common test commands on Windows cmd.exe
  let finalCommand = trimmed;
  if (process.platform === 'win32') {
    if (trimmed === 'true') finalCommand = 'exit 0';
    else if (trimmed === 'false') finalCommand = 'exit 1';
  }

  const start = Date.now();

  return new Promise<VerificationResult>((resolve) => {
    exec(
      finalCommand,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const out = (stdout || '').toString();
        const errOut = (stderr || '').toString();

        if (err) {
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          resolve({
            success: false,
            exitCode,
            command: trimmed,
            stdout: out,
            stderr: errOut || err.message,
            durationMs,
            error: err.killed ? `Command timed out after ${timeoutMs}ms` : err.message,
          });
        } else {
          resolve({
            success: true,
            exitCode: 0,
            command: trimmed,
            stdout: out,
            stderr: errOut,
            durationMs,
          });
        }
      }
    );
  });
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

  const result = await executeVerification(foundTask.verificationCommand, targetDir, options.timeout);
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

  for (const { task, milestone } of candidates) {
    const vResult = await executeVerification(task.verificationCommand, targetDir, options.timeout);
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
