import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { withFileLock } from './lock-manager.js';
import { MasterPlanTask } from '../scanner/types.js';
import { VerificationResult } from './verifier.js';

export interface TokenEstimate {
  inputEstimated: number;
  outputEstimated: number;
  totalEstimated: number;
  costUsdEstimated: number;
}

export interface TaskTelemetryRecord {
  taskId: string;
  title: string;
  assignedSubagent: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  status: 'in_progress' | 'completed' | 'failed' | 'blocked';
  verification?: {
    command: string;
    durationMs: number;
    exitCode: number;
    skipped: boolean;
  };
  tokens?: TokenEstimate;
  notes?: string;
}

export interface TelemetrySummary {
  totalTasksCompleted: number;
  totalDurationMs: number;
  estimatedTotalTokens: number;
  estimatedTotalCostUsd: number;
  verificationPassRate: number;
  totalVerificationsRun: number;
  totalVerificationsPassed: number;
  circuitBreakerTrips: number;
}

export interface ProjectTelemetry {
  $schema?: string;
  version: string;
  projectName: string;
  lastUpdated: string;
  modelTierDefault: string;
  summary: TelemetrySummary;
  tasks: TaskTelemetryRecord[];
}

export const INPUT_TOKEN_COST_PER_M = 3.0; // $3.00 / 1M tokens (Claude 3.5/3.7 Sonnet / Gemini Pro standard)
export const OUTPUT_TOKEN_COST_PER_M = 15.0; // $15.00 / 1M tokens

/**
 * Calculates estimated tokens and cost based on contract slice, target files, and diff heuristics.
 */
export function estimateTokens(targetDir: string, task: MasterPlanTask): TokenEstimate {
  let fileBytes = 0;
  if (Array.isArray(task.targetFiles)) {
    for (const relFile of task.targetFiles) {
      const fullPath = path.resolve(targetDir, relFile);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            fileBytes += stat.size;
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
  }

  // Base prompt context (contracts + role guide + system prompt) ~ 3,500 tokens
  const baseContextTokens = 3500;
  const fileTokens = Math.round(fileBytes / 4);
  const inputEstimated = baseContextTokens + fileTokens;

  // Output estimation: diff or file modification approximation
  let outputEstimated = 350; // minimum baseline generation
  if (fileBytes > 0) {
    outputEstimated = Math.max(350, Math.round(fileBytes / 6));
  }

  const cost =
    (inputEstimated / 1_000_000) * INPUT_TOKEN_COST_PER_M +
    (outputEstimated / 1_000_000) * OUTPUT_TOKEN_COST_PER_M;

  return {
    inputEstimated,
    outputEstimated,
    totalEstimated: inputEstimated + outputEstimated,
    costUsdEstimated: Math.round(cost * 10000) / 10000,
  };
}

/**
 * Loads project telemetry from .ai/telemetry.json or returns a fresh initialized state.
 */
export function loadTelemetry(telemetryPath: string, projectName: string = 'project'): ProjectTelemetry {
  if (fs.existsSync(telemetryPath)) {
    try {
      const raw = fs.readFileSync(telemetryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks)) {
        return parsed as ProjectTelemetry;
      }
    } catch {
      // Fall through to initial structure
    }
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    version: '1.0.0',
    projectName,
    lastUpdated: new Date().toISOString(),
    modelTierDefault: 'claude-3-7-sonnet',
    summary: {
      totalTasksCompleted: 0,
      totalDurationMs: 0,
      estimatedTotalTokens: 0,
      estimatedTotalCostUsd: 0,
      verificationPassRate: 1.0,
      totalVerificationsRun: 0,
      totalVerificationsPassed: 0,
      circuitBreakerTrips: 0,
    },
    tasks: [],
  };
}

/**
 * Atomically writes telemetry to disk with Windows EPERM resilience.
 */
export function saveTelemetry(telemetryPath: string, telemetry: ProjectTelemetry): boolean {
  telemetry.lastUpdated = new Date().toISOString();
  const dir = path.dirname(telemetryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${telemetryPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(telemetry, null, 2) + '\n', 'utf8');

    let renamed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.renameSync(tmpPath, telemetryPath);
        renamed = true;
        break;
      } catch (err: any) {
        if (err.code === 'EPERM' || err.code === 'EBUSY') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        } else {
          throw err;
        }
      }
    }

    if (!renamed) {
      fs.copyFileSync(tmpPath, telemetryPath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best effort
      }
    }

    return true;
  } catch {
    fs.rmSync(tmpPath, { force: true });
    return false;
  }
}

/**
 * Recomputes aggregate summary metrics across all recorded tasks.
 */
export function recomputeTelemetrySummary(telemetry: ProjectTelemetry): void {
  const completedTasks = telemetry.tasks.filter((t) => t.status === 'completed');
  telemetry.summary.totalTasksCompleted = completedTasks.length;

  let totalDuration = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const t of completedTasks) {
    totalDuration += t.durationMs || 0;
    if (t.tokens) {
      totalTokens += t.tokens.totalEstimated || 0;
      totalCost += t.tokens.costUsdEstimated || 0;
    }
  }

  telemetry.summary.totalDurationMs = totalDuration;
  telemetry.summary.estimatedTotalTokens = totalTokens;
  telemetry.summary.estimatedTotalCostUsd = Math.round(totalCost * 10000) / 10000;

  if (telemetry.summary.totalVerificationsRun > 0) {
    telemetry.summary.verificationPassRate =
      Math.round((telemetry.summary.totalVerificationsPassed / telemetry.summary.totalVerificationsRun) * 100) / 100;
  } else {
    telemetry.summary.verificationPassRate = 1.0;
  }
}

/**
 * Records the start of an agent task in .ai/telemetry.json.
 */
export async function recordTaskStart(
  targetDir: string,
  task: MasterPlanTask
): Promise<void> {
  const telemetryPath = path.join(targetDir, '.ai', 'telemetry.json');
  await withFileLock(telemetryPath, () => {
    const telemetry = loadTelemetry(telemetryPath, path.basename(targetDir));
    const existing = telemetry.tasks.find((t) => t.taskId === task.id);
    if (existing) {
      existing.startedAt = new Date().toISOString();
      existing.status = 'in_progress';
    } else {
      telemetry.tasks.push({
        taskId: task.id,
        title: task.title,
        assignedSubagent: task.assignedSubagent,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'in_progress',
        notes: task.notes || '',
      });
    }
    saveTelemetry(telemetryPath, telemetry);
  });
}

/**
 * Records completion of an agent task, tracking duration, verification results, tokens, and cost.
 */
export async function recordTaskComplete(
  targetDir: string,
  task: MasterPlanTask,
  verificationResult?: VerificationResult | null,
  notes?: string
): Promise<TaskTelemetryRecord | null> {
  const telemetryPath = path.join(targetDir, '.ai', 'telemetry.json');
  return withFileLock(telemetryPath, () => {
    const telemetry = loadTelemetry(telemetryPath, path.basename(targetDir));
    let record = telemetry.tasks.find((t) => t.taskId === task.id);
    const now = new Date();
    const completedAt = now.toISOString();

    if (!record) {
      record = {
        taskId: task.id,
        title: task.title,
        assignedSubagent: task.assignedSubagent,
        startedAt: completedAt,
        durationMs: 0,
        status: 'completed',
      };
      telemetry.tasks.push(record);
    }

    const startTime = new Date(record.startedAt || completedAt).getTime();
    record.completedAt = completedAt;
    record.durationMs = Math.max(0, now.getTime() - startTime);
    record.status = 'completed';
    if (notes) record.notes = notes;

    if (verificationResult) {
      record.verification = {
        command: verificationResult.command,
        durationMs: verificationResult.durationMs,
        exitCode: verificationResult.exitCode,
        skipped: verificationResult.skipped === true,
      };

      if (!verificationResult.skipped) {
        telemetry.summary.totalVerificationsRun++;
        if (verificationResult.success) {
          telemetry.summary.totalVerificationsPassed++;
        }
      }
    }

    record.tokens = estimateTokens(targetDir, task);
    recomputeTelemetrySummary(telemetry);

    saveTelemetry(telemetryPath, telemetry);
    return record;
  });
}

/**
 * Increments circuit breaker trips counter in telemetry.
 */
export async function recordCircuitBreakerTrip(targetDir: string, taskId: string): Promise<void> {
  const telemetryPath = path.join(targetDir, '.ai', 'telemetry.json');
  await withFileLock(telemetryPath, () => {
    const telemetry = loadTelemetry(telemetryPath, path.basename(targetDir));
    telemetry.summary.circuitBreakerTrips++;
    const record = telemetry.tasks.find((t) => t.taskId === taskId);
    if (record) {
      record.status = 'blocked';
    }
    saveTelemetry(telemetryPath, telemetry);
  });
}

/**
 * Returns formatted telemetry dashboard summary lines for CLI display.
 */
export function formatTelemetrySummary(telemetry: ProjectTelemetry): string {
  const { summary } = telemetry;
  const minutes = (summary.totalDurationMs / 60000).toFixed(1);
  const passPct = Math.round(summary.verificationPassRate * 100);

  const lines = [
    pc.bold(pc.cyan('\n⚡ Execution & Cost Telemetry')),
    pc.dim('  Model Tier Benchmark: ') + pc.white(telemetry.modelTierDefault),
    pc.dim('  Tasks Completed:      ') + pc.green(`${summary.totalTasksCompleted}`),
    pc.dim('  Total Time Active:    ') + pc.white(`${minutes} min (${summary.totalDurationMs}ms)`),
    pc.dim('  Estimated Tokens:     ') + pc.yellow(`${summary.estimatedTotalTokens.toLocaleString()}`),
    pc.dim('  Estimated Cost:       ') + pc.green(`$${summary.estimatedTotalCostUsd.toFixed(4)} USD`),
    pc.dim('  Verification Pass:    ') +
      (passPct >= 80 ? pc.green(`${passPct}%`) : pc.red(`${passPct}%`)) +
      pc.dim(` (${summary.totalVerificationsPassed}/${summary.totalVerificationsRun} runs)`),
    pc.dim('  Circuit Breaker Trips:') +
      (summary.circuitBreakerTrips > 0 ? pc.red(` ${summary.circuitBreakerTrips}`) : pc.dim(' 0')),
  ];
  return lines.join('\n');
}
