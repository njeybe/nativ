/**
 * Picks the worker model from a task's complexity.
 * Overrides live under `workerModels` in .nativ/config.json. The separate `models` key is
 * for nativ's own provider calls and is never read here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TASK_COMPLEXITIES, type MasterPlanTask, type TaskComplexity } from '../scanner/types.js';

export const DEFAULT_WORKER_MODELS: Record<TaskComplexity, string> = {
  simple: 'haiku',
  standard: 'sonnet',
  complex: 'opus',
};

// Full IDs for the native engine. Opus is passed in by the caller (its default model).
const NATIVE_MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

function loadWorkerModelOverrides(root: string): Partial<Record<TaskComplexity, string>> {
  try {
    const raw = fs.readFileSync(path.join(root, '.nativ', 'config.json'), 'utf8');
    const overrides = JSON.parse(raw)?.workerModels;
    if (!overrides || typeof overrides !== 'object') return {};
    const result: Partial<Record<TaskComplexity, string>> = {};
    for (const level of TASK_COMPLEXITIES) {
      const value = overrides[level];
      if (typeof value === 'string' && value.trim()) result[level] = value.trim();
    }
    return result;
  } catch {
    return {};
  }
}

/** Model alias for the task, or null when it has no complexity (behaviour stays unchanged). */
export function resolveWorkerModel(root: string, task: Pick<MasterPlanTask, 'complexity'>): string | null {
  const level = task.complexity;
  if (!level || !TASK_COMPLEXITIES.includes(level)) return null;
  return loadWorkerModelOverrides(root)[level] ?? DEFAULT_WORKER_MODELS[level];
}

/** Turns an alias into a full model ID for the native engine; unknown values pass through. */
export function toNativeModelId(model: string, opusModelId: string): string {
  if (model === 'opus') return opusModelId;
  return NATIVE_MODEL_IDS[model] ?? model;
}
