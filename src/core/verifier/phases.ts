import fs from 'node:fs';
import path from 'node:path';
import { parseJsonLoose } from '../enforcement.js';
import { resolveMainRoot } from '../root-resolver.js';
import { executeVerification } from './executor.js';
import type {
  PhaseResult,
  PhasesOutcome,
  VerificationResult,
  VerifyPhase,
  VerifyPhasesConfig,
} from './types.js';

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
