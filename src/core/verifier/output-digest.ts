import fs from 'node:fs';
import path from 'node:path';
import type { VerificationResult } from './types.js';

/** Lines of each output stream an agent sees for a failed check; the rest goes to the log file. */
export const DIGEST_MAX_LINES = 40;

/**
 * Picks at most `maxLines` lines from a long test run, in their original order.
 * Only called when `lines.length > maxLines`.
 */
export function digestLines(lines: string[], maxLines: number): string[] {
  // TODO(human): choose which lines an agent needs to fix the failure.
  return lines.slice(-maxLines);
}

/** Short enough to keep in an agent's context; says how much was left out. */
export function digestOutput(text: string, maxLines = DIGEST_MAX_LINES): string {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  const kept = digestLines(lines, maxLines).slice(0, maxLines);
  return `${kept.join('\n')}\n[... ${lines.length - kept.length} of ${lines.length} lines left out ...]`;
}

/** Writes the whole run to .nativ/logs/ and returns its project-relative path, or null if it cannot. */
export function saveFullLog(root: string, taskId: string, result: VerificationResult): string | null {
  try {
    const dir = path.join(root, '.nativ', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    // Logs can quote test data; keep them out of commits whatever the project's own ignore rules say.
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const file = path.join(dir, `verify-${taskId.replace(/[^\w.-]/g, '_')}.log`);
    const body = [`$ ${result.command}`, '--- stdout ---', result.stdout, '--- stderr ---', result.stderr];
    if (result.error) body.push('--- error ---', result.error);
    fs.writeFileSync(file, body.join('\n'));
    return path.relative(root, file).split(path.sep).join('/');
  } catch {
    return null;
  }
}

export interface FailureDigest {
  stderr: string;
  stdout: string;
  logFile: string | null;
}

/** What a failed check shows an agent: a digest of each non-empty stream and where the full log is. */
export function digestFailure(root: string, taskId: string, result: VerificationResult): FailureDigest {
  return {
    stderr: result.stderr?.trim() ? digestOutput(result.stderr) : '',
    stdout: result.stdout?.trim() ? digestOutput(result.stdout) : '',
    logFile: saveFullLog(root, taskId, result),
  };
}
