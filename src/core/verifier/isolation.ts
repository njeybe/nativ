import { MasterPlanTask } from '../../scanner/types.js';
import { loadVerifySettings } from '../profiles.js';
import { resolveMainRoot } from '../root-resolver.js';
import { executeVerification } from './executor.js';
import { createCleanTree, sweepStaleCleanTrees } from './clean-tree.js';
import { lintPortability } from './portability-lint.js';
import { buildVerifyEnv } from './verify-env.js';
import { loadVerifyPhases, runVerifyPhases } from './phases.js';
import type { PhasesOutcome, VerificationResult } from './types.js';

/** Where a verification runs: the real tree, or a disposable clean copy. */
export interface IsolationPlan {
  mode: 'none' | 'clean';
  dir?: string;
  env?: NodeJS.ProcessEnv;
  warnings: string[];
  dispose?: () => Promise<void>;
}

export const NO_ISOLATION: IsolationPlan = { mode: 'none', warnings: [] };

function isSkipped(command: string): boolean {
  const t = (command || '').trim().toLowerCase();
  return !t || t === 'none' || t === 'skip';
}

export function needsRun(commands: string[], configDir: string, sharedPhases: boolean): boolean {
  if (commands.some((c) => !isSkipped(c))) return true;
  return !sharedPhases && loadVerifyPhases(configDir).phases.length > 0;
}

export async function openIsolation(
  cwd: string,
  configDir: string,
  wanted: 'none' | 'clean',
): Promise<IsolationPlan> {
  if (wanted !== 'clean') return NO_ISOLATION;
  await sweepStaleCleanTrees(cwd);
  const settings = loadVerifySettings(resolveMainRoot(configDir));
  const tree = await createCleanTree(cwd, { links: settings.verifyLinks });
  if (!tree.ok) {
    return { mode: 'none', warnings: [`Clean isolation unavailable (${tree.reason}); ran in place.`] };
  }
  const env = buildVerifyEnv(settings.verifyEnv);
  return { mode: 'clean', dir: tree.dir, env, warnings: [], dispose: tree.dispose };
}

/** Like runVerifyPhases, but with an explicit environment for each phase. */
export async function runPhasesIn(
  dir: string,
  configDir: string,
  timeout: number | undefined,
  env?: NodeJS.ProcessEnv,
): Promise<PhasesOutcome> {
  const config = loadVerifyPhases(configDir);
  if (!env || config.error) return runVerifyPhases(dir, configDir, timeout);
  const reports: PhasesOutcome['reports'] = [];
  for (const phase of config.phases) {
    const res = await executeVerification(phase.run, dir, timeout, { env });
    reports.push({ name: phase.name, command: res.command, success: res.success, durationMs: res.durationMs });
    if (!res.success) {
      const cause = res.error ? `: ${res.error.trim()}` : '';
      return { reports, failure: { ...res, phases: reports, error: `Phase "${phase.name}" failed${cause}` } };
    }
  }
  return { reports };
}

export interface RunOptions {
  cwd: string;
  configDir?: string;
  timeout?: number;
  phases?: PhasesOutcome;
  isolation?: 'none' | 'clean';
  plan?: IsolationPlan;
}

// The phases then the task command, in the plan's directory; code-shape is not part of this.
export async function runInPlan(task: MasterPlanTask, o: RunOptions, plan: IsolationPlan): Promise<VerificationResult> {
  const configDir = o.configDir ?? o.cwd;
  const dir = plan.dir ?? o.cwd;
  const outcome = o.phases ?? (await runPhasesIn(dir, configDir, o.timeout, plan.env));
  // In a batch the shared phase time is counted once, by the batch, not again for every task.
  if (outcome.failure) {
    return { ...outcome.failure, phases: outcome.reports, ...(o.phases ? { durationMs: 0 } : {}) };
  }
  const raw = await executeVerification(task.verificationCommand, dir, o.timeout, { env: plan.env });
  if (outcome.reports.length) {
    raw.phases = outcome.reports;
    raw.durationMs += o.phases ? 0 : outcome.reports.reduce((sum, r) => sum + r.durationMs, 0);
    raw.skipped = false;
  }
  return raw;
}

// A clean failure is re-run in place only to learn whether the clean copy is the cause.
export async function diagnose(
  task: MasterPlanTask,
  o: RunOptions,
  failed: VerificationResult,
  failure: 'warn' | 'block',
): Promise<VerificationResult> {
  if (failed.error?.startsWith('Command timed out')) return failed;
  const local = await runInPlan(task, { ...o, phases: undefined }, NO_ISOLATION);
  if (!local.success) return failed;
  const base = 'Passes only on this machine: it failed in a clean copy of the project.';
  const note = [base, ...lintPortability(o.cwd, task.targetFiles || [])].join(' ');
  if (failure === 'warn') {
    return { ...local, isolation: 'clean', warnings: [...(failed.warnings ?? []), note] };
  }
  const error = `${failed.error ?? 'Verification failed'}. ${note} Isolation failure is set to block.`;
  return { ...failed, error, warnings: [...(failed.warnings ?? []), note] };
}
