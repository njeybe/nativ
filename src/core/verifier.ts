import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { MasterPlan, MasterPlanTask, MasterPlanMilestone } from '../scanner/types.js';
import { checkCodeShape, formatCodeShapeReport, type CodeShapeReport } from './code-shape.js';
import { parseJsonLoose } from './enforcement.js';
import { resolveMainRoot } from './root-resolver.js';

export interface VerificationResult {
  success: boolean;
  exitCode: number;
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
  skipped?: boolean;
  codeShape?: CodeShapeReport;
  /** Results of the configured `verifyPhases`, when any ran. */
  phases?: PhaseResult[];
}

export interface PhaseResult {
  name: string;
  command: string;
  success: boolean;
  durationMs: number;
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

export interface VerifyPhase {
  name: string;
  run: string;
}

/** Configured phases, or an error when the config exists but cannot be trusted to say what they are. */
export interface VerifyPhasesConfig {
  phases: VerifyPhase[];
  error?: string;
}

/** Reads the file, retrying once: antivirus or an editor saving can briefly lock it on Windows. */
function readConfigText(file: string): string | null {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      if (attempt >= 1) throw err;
    }
  }
}

/** `verifyPhases` from the main checkout's `.nativ/config.json`, never from a worktree's own copy. */
export function loadVerifyPhases(configDir: string): VerifyPhasesConfig {
  let raw: string | null;
  try {
    raw = readConfigText(path.join(resolveMainRoot(configDir), '.nativ', 'config.json'));
  } catch (err: any) {
    return { phases: [], error: `.nativ/config.json cannot be read (${err?.message})` };
  }
  if (raw === null) return { phases: [] };
  if (!raw.trim()) return { phases: [], error: '.nativ/config.json is empty' };
  let phases: unknown;
  try {
    phases = parseJsonLoose<{ verifyPhases?: unknown }>(raw)?.verifyPhases;
  } catch (err: any) {
    return { phases: [], error: `.nativ/config.json is not valid JSON (${err?.message})` };
  }
  if (phases === undefined || phases === null) return { phases: [] };
  // An empty or null "run" switches a phase off; a missing or mistyped field is a mistake.
  const isEntry = (p: any) => typeof p?.name === 'string' && p.name.trim()
    && (p.run === null || typeof p.run === 'string');
  if (!Array.isArray(phases) || !phases.every(isEntry)) {
    return { phases: [], error: 'verifyPhases must be a list of { "name": "...", "run": "..." } entries' };
  }
  const active = (phases as Array<{ name: string; run: string | null }>).filter((p) => p.run && p.run.trim());
  return { phases: active.map((p) => ({ name: p.name.trim(), run: p.run!.trim() })) };
}

/** Outcome of running the configured phases once; shared by every task in a batch. */
export interface PhasesOutcome {
  reports: PhaseResult[];
  failure?: VerificationResult;
}

function configFailure(message: string): VerificationResult {
  const error = `${message}, so the configured checks could not run. Fix it and verify again.`;
  const command = '.nativ/config.json';
  return { success: false, exitCode: 1, command, stdout: '', stderr: error, durationMs: 0, error };
}

/** Runs the configured phases in order and stops at the first failure. */
export async function runVerifyPhases(cwd: string, configDir: string, timeout?: number): Promise<PhasesOutcome> {
  const config = loadVerifyPhases(configDir);
  if (config.error) return { reports: [], failure: configFailure(config.error) };
  const reports: PhaseResult[] = [];
  for (const phase of config.phases) {
    const res = await executeVerification(phase.run, cwd, timeout);
    reports.push({ name: phase.name, command: res.command, success: res.success, durationMs: res.durationMs });
    if (!res.success) {
      const cause = res.error ? `: ${res.error.trim()}` : '';
      return { reports, failure: { ...res, phases: reports, error: `Phase "${phase.name}" failed${cause}` } };
    }
  }
  return { reports };
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
