import { exec } from 'node:child_process';
import type { VerificationResult } from './types.js';

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
