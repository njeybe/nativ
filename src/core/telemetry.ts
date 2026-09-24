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
  /** Grounded usage reported by the Messages API across every native run of this task. */
  actualUsage?: ActualTokenUsage;
  notes?: string;
}

/**
 * Token counts reported by the Messages API (`response.usage`), accumulated
 * across agent turns. `inputTokens` excludes cached tokens, matching the API.
 */
export interface ActualTokenUsage {
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Subset of `outputTokens` spent on internal reasoning (0 when not reported). */
  thinkingTokens: number;
  costUsd: number;
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
  /** Grounded spend across all native runs, including failed ones (billing is billing). */
  actualSpendUsd?: number;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  thinkingTokens?: number;
  /** cacheRead / (input + cacheRead + cacheCreation), in [0, 1]. */
  cacheHitRate?: number;
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

/** Model whose rates price heuristic estimates; matches the native engine's default model. */
export const DEFAULT_TELEMETRY_MODEL = 'claude-opus-5-5';
/** List price of DEFAULT_TELEMETRY_MODEL; also the fallback for models missing from MODEL_PRICING. */
export const INPUT_TOKEN_COST_PER_M = 4.0; // $4.00 / 1M tokens
export const OUTPUT_TOKEN_COST_PER_M = 20.0; // $20.00 / 1M tokens

export interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  /** 5-minute ephemeral cache writes. */
  cacheWritePerM: number;
  cacheReadPerM: number;
}

function standardPricing(inputPerM: number, outputPerM: number, cacheReadPerM = inputPerM * 0.1): ModelPricing {
  return { inputPerM, outputPerM, cacheWritePerM: inputPerM * 1.25, cacheReadPerM };
}

/** First-party Claude API list prices in USD per 1M tokens. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-fable-5-1': standardPricing(10, 50, 0.25),
  'claude-fable-5': standardPricing(10, 50),
  'claude-opus-5-5': standardPricing(4, 20, 0.2),
  'claude-opus-5': standardPricing(5, 25),
  'claude-opus-4-8': standardPricing(5, 25),
  'claude-opus-4-7': standardPricing(5, 25),
  'claude-opus-4-6': standardPricing(5, 25),
  'claude-sonnet-5': standardPricing(2, 10),
  'claude-sonnet-4-6': standardPricing(3, 15),
  'claude-haiku-4-5': standardPricing(1, 5),
};

/** Unknown models fall back to the heuristic estimate rates so spend is never silently zero. */
const FALLBACK_PRICING = standardPricing(INPUT_TOKEN_COST_PER_M, OUTPUT_TOKEN_COST_PER_M);

/** True when MODEL_PRICING knows the model (exactly or as a dated / suffixed variant). */
export function isPricedModel(model: unknown): model is string {
  return typeof model === 'string' && Object.keys(MODEL_PRICING).some((id) => model === id || model.startsWith(`${id}-`));
}

/** Resolves pricing by exact ID, then by longest known prefix (e.g. dated or `-fast` variants). */
export function resolveModelPricing(model: string): ModelPricing {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  const prefix = Object.keys(MODEL_PRICING)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? MODEL_PRICING[prefix] : FALLBACK_PRICING;
}

/** Prices one usage slice with the model's input, output, cache-write and cache-read rates. */
export function computeActualCostUsd(
  model: string,
  usage: Pick<ActualTokenUsage, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>,
): number {
  const p = resolveModelPricing(model);
  const cost =
    (usage.inputTokens * p.inputPerM +
      usage.outputTokens * p.outputPerM +
      usage.cacheCreationTokens * p.cacheWritePerM +
      usage.cacheReadTokens * p.cacheReadPerM) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function emptyActualUsage(model: string): ActualTokenUsage {
  return {
    model,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
  };
}

/** Sums two usage records; the result keeps `a.model` unless `a` is empty. */
export function mergeActualUsage(a: ActualTokenUsage, b: ActualTokenUsage): ActualTokenUsage {
  return {
    model: a.turns > 0 ? a.model : b.model,
    turns: a.turns + b.turns,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1_000_000) / 1_000_000,
  };
}

export function cacheHitRate(usage: Pick<ActualTokenUsage, 'inputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): number {
  const promptTokens = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  return promptTokens > 0 ? Math.round((usage.cacheReadTokens / promptTokens) * 10000) / 10000 : 0;
}

/** Prices estimated input/output tokens at a model's list rates. */
export function priceEstimate(model: string, inputEstimated: number, outputEstimated: number): number {
  const p = resolveModelPricing(model);
  const cost = (inputEstimated / 1_000_000) * p.inputPerM + (outputEstimated / 1_000_000) * p.outputPerM;
  return Math.round(cost * 10000) / 10000;
}

/**
 * Calculates estimated tokens and cost based on contract slice, target files, and diff heuristics.
 */
export function estimateTokens(targetDir: string, task: MasterPlanTask, model: string = DEFAULT_TELEMETRY_MODEL): TokenEstimate {
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

  return {
    inputEstimated,
    outputEstimated,
    totalEstimated: inputEstimated + outputEstimated,
    costUsdEstimated: priceEstimate(model, inputEstimated, outputEstimated),
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
        // Files written before the current model table name retired models (e.g. claude-3-7-sonnet);
        // estimates are priced at the current default instead.
        if (!isPricedModel(parsed.modelTierDefault)) parsed.modelTierDefault = DEFAULT_TELEMETRY_MODEL;
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
    modelTierDefault: DEFAULT_TELEMETRY_MODEL,
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
      // Token estimates are kept as recorded; only the rate is current, so older records are re-priced.
      t.tokens.costUsdEstimated = priceEstimate(telemetry.modelTierDefault, t.tokens.inputEstimated || 0, t.tokens.outputEstimated || 0);
      totalTokens += t.tokens.totalEstimated || 0;
      totalCost += t.tokens.costUsdEstimated;
    }
  }

  telemetry.summary.totalDurationMs = totalDuration;
  telemetry.summary.estimatedTotalTokens = totalTokens;
  telemetry.summary.estimatedTotalCostUsd = Math.round(totalCost * 10000) / 10000;

  let actual = emptyActualUsage(telemetry.modelTierDefault);
  for (const t of telemetry.tasks) {
    if (t.actualUsage) actual = mergeActualUsage(actual, t.actualUsage);
  }
  telemetry.summary.actualSpendUsd = Math.round(actual.costUsd * 10000) / 10000;
  telemetry.summary.actualInputTokens = actual.inputTokens;
  telemetry.summary.actualOutputTokens = actual.outputTokens;
  telemetry.summary.cacheReadTokens = actual.cacheReadTokens;
  telemetry.summary.cacheCreationTokens = actual.cacheCreationTokens;
  telemetry.summary.thinkingTokens = actual.thinkingTokens;
  telemetry.summary.cacheHitRate = cacheHitRate(actual);

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

    record.tokens = estimateTokens(targetDir, task, telemetry.modelTierDefault);
    recomputeTelemetrySummary(telemetry);

    saveTelemetry(telemetryPath, telemetry);
    return record;
  });
}

/**
 * Folds one native run's API-reported usage into the task's grounded telemetry.
 * Creates the task record when the run was dispatched without `nativ task start`.
 */
export async function recordRunnerUsage(
  targetDir: string,
  task: Pick<MasterPlanTask, 'id' | 'title' | 'assignedSubagent'>,
  usage: ActualTokenUsage,
): Promise<TaskTelemetryRecord> {
  const telemetryPath = path.join(targetDir, '.ai', 'telemetry.json');
  return withFileLock(telemetryPath, () => {
    const telemetry = loadTelemetry(telemetryPath, path.basename(targetDir));
    let record = telemetry.tasks.find((t) => t.taskId === task.id);
    if (!record) {
      record = {
        taskId: task.id,
        title: task.title,
        assignedSubagent: task.assignedSubagent,
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'in_progress',
      };
      telemetry.tasks.push(record);
    }
    record.actualUsage = record.actualUsage ? mergeActualUsage(record.actualUsage, usage) : { ...usage };
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
export function formatTelemetrySummary(telemetry: ProjectTelemetry, plan?: { completedTasks: number }): string {
  const { summary } = telemetry;
  const minutes = (summary.totalDurationMs / 60000).toFixed(1);
  const passPct = Math.round(summary.verificationPassRate * 100);
  // Tasks completed before telemetry existed (or with --no-verify from older builds) have no record.
  const untracked = plan ? Math.max(0, plan.completedTasks - summary.totalTasksCompleted) : 0;

  const lines = [
    pc.bold(pc.cyan('\n⚡ Execution & Cost Telemetry')),
    pc.dim('  Model Tier Benchmark: ') + pc.white(telemetry.modelTierDefault),
    pc.dim('  Tasks Completed:      ') +
      pc.green(`${summary.totalTasksCompleted}`) +
      (untracked ? pc.dim(` measured (+${untracked} completed without telemetry)`) : ''),
    pc.dim('  Total Time Active:    ') + pc.white(`${minutes} min (${summary.totalDurationMs}ms)`),
    pc.dim('  Estimated Tokens:     ') + pc.yellow(`${summary.estimatedTotalTokens.toLocaleString()}`),
    pc.dim('  Estimated Cost:       ') + pc.green(`$${summary.estimatedTotalCostUsd.toFixed(4)} USD`),
    ...(summary.actualSpendUsd
      ? [
          pc.dim('  Actual Spend:         ') +
            pc.green(`$${summary.actualSpendUsd.toFixed(4)} USD`) +
            pc.dim(` (cache hit ${Math.round((summary.cacheHitRate ?? 0) * 100)}%)`),
        ]
      : []),
    pc.dim('  Verification Pass:    ') +
      (passPct >= 80 ? pc.green(`${passPct}%`) : pc.red(`${passPct}%`)) +
      pc.dim(` (${summary.totalVerificationsPassed}/${summary.totalVerificationsRun} runs)`),
    pc.dim('  Circuit Breaker Trips:') +
      (summary.circuitBreakerTrips > 0 ? pc.red(` ${summary.circuitBreakerTrips}`) : pc.dim(' 0')),
  ];
  return lines.join('\n');
}
