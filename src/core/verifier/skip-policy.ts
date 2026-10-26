import { MasterPlanTask } from '../../scanner/types.js';

export type SkipMode = 'allow' | 'warn' | 'block';
export interface SkipDecision {
  action: 'pass' | 'warn' | 'block';
  message?: string;
}

const FIX = 'Add a real verificationCommand, or set verificationKind "manual" with notes saying how it was checked.';

/** Decides what a skipped check (empty, none or skip) means for a task under the profile. */
export function evaluateSkip(task: MasterPlanTask, mode: SkipMode): SkipDecision {
  if (task.verificationKind === 'manual' && (task.notes ?? '').trim()) return { action: 'pass' };
  if (mode === 'allow') return { action: 'pass' };
  const why = `Task [${task.id}] has no real check, so nothing proves it works. ${FIX}`;
  // Older plans without a kind only warn, so work already in progress does not stall.
  if (mode === 'block' && task.verificationKind !== undefined) return { action: 'block', message: why };
  return { action: 'warn', message: why };
}
