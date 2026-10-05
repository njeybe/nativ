import fs from 'node:fs';
import path from 'node:path';
import {
  cacheHitRate,
  emptyActualUsage,
  loadTelemetry,
  mergeActualUsage,
  resolveModelPricing,
  type ActualTokenUsage,
  type TaskTelemetryRecord,
} from '../../core/telemetry.js';
import type { BenchmarkReport } from '../../core/benchmark.js';
import { runBench } from '../../commands/bench.js';
import type { AgentSupervisor, RunnerRecord } from '../../runner/agent-supervisor.js';
import { HttpError } from '../http-utils.js';
import { AI_DIR, planMilestones, readPlan } from '../plan-utils.js';
import { runCaptured, truncateOutput } from '../cli-runner.js';

export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Telemetry is hand-editable JSON: coerce every counter so one bad record cannot NaN the totals. */
export function sanitizeUsage(value: unknown): ActualTokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Partial<ActualTokenUsage>;
  const n = (v: unknown) => Math.max(0, finiteOr(v, 0));
  return {
    model: typeof u.model === 'string' ? u.model : 'unknown',
    turns: n(u.turns),
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheCreationTokens: n(u.cacheCreationTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    thinkingTokens: n(u.thinkingTokens),
    costUsd: n(u.costUsd),
  };
}

export function aggregateActualUsage(records: TaskTelemetryRecord[]): ActualTokenUsage {
  let total = emptyActualUsage('');
  for (const record of records) {
    const usage = sanitizeUsage(record?.actualUsage);
    if (usage) total = mergeActualUsage(total, usage);
  }
  return total;
}

/** Usage as served by the API: the stored counters plus the derived cache hit rate. */
export function usageView(usage: ActualTokenUsage | null) {
  return usage ? { ...usage, costUsd: roundUsd(usage.costUsd), cacheHitRate: cacheHitRate(usage) } : null;
}

/** GET /api/pipeline/benchmarks: the cached report written by `nativ bench` or benchmarks/run. */
export function handleBenchmarks(root: string) {
  let report: unknown = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, AI_DIR, 'benchmark_report.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) report = parsed;
  } catch {
    // No benchmark has been run yet, or the report is unreadable.
  }
  return { ok: true, report };
}

export function createBenchmarkRunner(root: string): () => Promise<BenchmarkReport> {
  let benchmarkRun: Promise<BenchmarkReport> | null = null;
  return (): Promise<BenchmarkReport> => {
    benchmarkRun ??= runCaptured(() => runBench(root, { json: true }))
      .then(({ result, output }) => {
        if (!result) throw new HttpError(500, 'BENCHMARK_FAILED', truncateOutput(output || 'Benchmark suite failed to run'));
        return result;
      })
      .finally(() => {
        benchmarkRun = null;
      });
    return benchmarkRun;
  };
}

/**
 * GET /api/pipeline/telemetry/detailed: per-task financial audit. Each breakdown pairs the heuristic
 * estimate with API-reported usage and lists the task's runs (engine, model, per-run usage).
 */
export function handleTelemetryDetailed(root: string, supervisor: AgentSupervisor) {
  const telemetry = loadTelemetry(path.join(root, AI_DIR, 'telemetry.json'));
  const records = telemetry.tasks.filter((t): t is TaskTelemetryRecord => Boolean(t) && typeof t.taskId === 'string');
  const planTasks = new Map(planMilestones(readPlan(root)).flatMap((m) => m.tasks).map((t) => [t.id, t] as const));

  const runsByTask = new Map<string, RunnerRecord[]>();
  for (const run of supervisor.listRuns()) {
    const list = runsByTask.get(run.taskId) ?? [];
    list.push(run);
    runsByTask.set(run.taskId, list);
  }

  const taskIds = [...new Set([...records.map((r) => r.taskId), ...runsByTask.keys()])];
  const taskBreakdowns = taskIds
    .map((taskId) => {
      const record = records.find((r) => r.taskId === taskId);
      const planTask = planTasks.get(taskId);
      const actual = sanitizeUsage(record?.actualUsage);
      const estimate = record?.tokens;
      const estimated = estimate
        ? {
            inputTokens: finiteOr(estimate.inputEstimated, 0),
            outputTokens: finiteOr(estimate.outputEstimated, 0),
            totalTokens: finiteOr(estimate.totalEstimated, 0),
            costUsd: finiteOr(estimate.costUsdEstimated, 0),
          }
        : null;
      return {
        taskId,
        title: record?.title ?? planTask?.title ?? taskId,
        assignedSubagent: record?.assignedSubagent ?? planTask?.assignedSubagent ?? null,
        status: planTask?.status ?? record?.status ?? null,
        startedAt: record?.startedAt ?? null,
        completedAt: record?.completedAt ?? null,
        durationMs: finiteOr(record?.durationMs, 0),
        verification: record?.verification ?? null,
        estimated,
        actual: usageView(actual),
        // Positive: the task cost more than estimated.
        varianceUsd: actual && estimated ? roundUsd(actual.costUsd - estimated.costUsd) : null,
        runs: (runsByTask.get(taskId) ?? []).map((run) => ({
          runId: run.runId,
          engine: run.engine,
          model: run.model,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          durationMs: run.durationMs,
          thinking: run.thinking,
          usage: usageView(sanitizeUsage(run.usage)),
        })),
      };
    })
    // Most expensive first; tasks without grounded usage keep their telemetry order at the end.
    .sort((a, b) => (b.actual?.costUsd ?? -1) - (a.actual?.costUsd ?? -1));

  const byModel = new Map<string, ActualTokenUsage>();
  for (const record of records) {
    const usage = sanitizeUsage(record.actualUsage);
    if (!usage) continue;
    byModel.set(usage.model, mergeActualUsage(byModel.get(usage.model) ?? emptyActualUsage(usage.model), usage));
  }

  const { summary } = telemetry;
  const actual = aggregateActualUsage(records);
  return {
    ok: true,
    summary: {
      projectName: telemetry.projectName,
      lastUpdated: telemetry.lastUpdated,
      modelTierDefault: telemetry.modelTierDefault,
      tasksTracked: records.length,
      totalTasksCompleted: finiteOr(summary?.totalTasksCompleted, 0),
      totalDurationMs: finiteOr(summary?.totalDurationMs, 0),
      estimated: {
        totalTokens: finiteOr(summary?.estimatedTotalTokens, 0),
        costUsd: finiteOr(summary?.estimatedTotalCostUsd, 0),
      },
      actual: {
        turns: actual.turns,
        inputTokens: actual.inputTokens,
        outputTokens: actual.outputTokens,
        cacheReadTokens: actual.cacheReadTokens,
        cacheCreationTokens: actual.cacheCreationTokens,
        thinkingTokens: actual.thinkingTokens,
        spendUsd: roundUsd(actual.costUsd),
        cacheHitRate: cacheHitRate(actual),
        // What the cache reads would have cost at each model's full input rate, minus what they did cost.
        cacheSavingsUsd: roundUsd(
          [...byModel.values()].reduce((sum, u) => {
            const rates = resolveModelPricing(u.model);
            return sum + (u.cacheReadTokens * (rates.inputPerM - rates.cacheReadPerM)) / 1_000_000;
          }, 0),
        ),
      },
      byModel: [...byModel.values()].map(usageView).sort((a, b) => b!.costUsd - a!.costUsd),
      verification: {
        passRate: finiteOr(summary?.verificationPassRate, 1),
        runs: finiteOr(summary?.totalVerificationsRun, 0),
        passed: finiteOr(summary?.totalVerificationsPassed, 0),
      },
      circuitBreakerTrips: finiteOr(summary?.circuitBreakerTrips, 0),
    },
    taskBreakdowns,
  };
}
