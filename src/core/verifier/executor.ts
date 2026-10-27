import { spawn, execFile } from 'node:child_process';
import type { VerificationResult } from './types.js';

const MAX_OUTPUT = 10 * 1024 * 1024;

/**
 * Execute a verification command in the workspace directory with timeout and output capture.
 */
export async function executeVerification(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
  options: { env?: NodeJS.ProcessEnv } = {},
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
    let timedOut = false;
    let out = '';
    let errOut = '';
    const child = spawn(finalCommand, {
      cwd,
      shell: true,
      env: options.env ?? { ...process.env, NATIV_VERIFY_SANDBOX: '1' },
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const cap = (cur: string, chunk: Buffer) =>
      cur.length < MAX_OUTPUT ? cur + chunk.toString() : cur;
    child.stdout?.on('data', (c: Buffer) => (out = cap(out, c)));
    child.stderr?.on('data', (c: Buffer) => (errOut = cap(errOut, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const finish = (code: number | null, message?: string) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (code === 0 && !message && !timedOut) {
        resolve({ success: true, exitCode: 0, command: trimmed, stdout: out, stderr: errOut, durationMs });
        return;
      }
      const error = timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : message ?? `Command failed: ${trimmed}`;
      resolve({
        success: false,
        exitCode: typeof code === 'number' && code !== 0 ? code : 1,
        command: trimmed,
        stdout: out,
        stderr: errOut || error,
        durationMs,
        error,
      });
    };
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

/** Kills the process and all its descendants. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Group already gone
  }
}