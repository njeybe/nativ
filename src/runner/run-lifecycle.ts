import fs from 'node:fs';
import { loadMasterPlan, runTaskVerification, type VerificationResult } from '../core/verifier.js';
import { formatCodeShapeReport } from '../core/code-shape.js';
import { mergeAgentWorktree } from '../core/worktree-merge.js';
import type { MasterPlanTask } from '../scanner/types.js';
import type { ActiveRun, RunnerRecord } from './types.js';

export async function runTaskVerificationStep(
  rootDir: string,
  run: ActiveRun,
  task: MasterPlanTask,
  emitStatus: (record: RunnerRecord) => void,
  appendLog: (run: ActiveRun, stream: 'stdout' | 'stderr', chunk: string) => void
): Promise<boolean> {
  const { record } = run;
  record.status = 'verifying';
  emitStatus(record);

  const result: VerificationResult = await runTaskVerification(task, {
    cwd: record.worktreeDir,
    configDir: rootDir,
  });
  const phases = result.phases?.map(({ name, success, durationMs }) => ({ name, success, durationMs }));
  record.verification = {
    command: result.command,
    success: result.success,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    skipped: Boolean(result.skipped),
    ...(result.error ? { error: result.error } : {}),
    ...(phases ? { phases } : {}),
  };

  const shape = result.codeShape ? formatCodeShapeReport(result.codeShape) : '';
  const output = [result.stdout, result.stderr, shape, result.error].filter(Boolean).join('\n');
  if (output) appendLog(run, 'stdout', `\n[supervisor] verification output:\n${output}\n`);
  return result.success;
}

/** Quiet counterpart to `nativ worktree merge`: same safe merge, no stdout noise inside a server. */
export function mergeWorktreeStep(
  rootDir: string,
  run: ActiveRun,
  appendLog: (run: ActiveRun, stream: 'stdout' | 'stderr', chunk: string) => void
): void {
  const outcome = mergeAgentWorktree(rootDir, run.record.taskId);
  appendLog(run, 'stdout', `\n[supervisor] ${outcome.message}\n`);
}

export function resetLogFile(runsDir: string, record: RunnerRecord): void {
  try {
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(record.logFile, '', 'utf8');
  } catch {
    // A read-only workspace must not abort the run; logs stay in memory.
  }
}
