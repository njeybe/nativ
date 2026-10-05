import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Terminates a detached process *group*. Agent runners spawn shells that spawn
 * their own children, so killing only the leader leaves orphans holding the
 * worktree open.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export function tailLines(text: string, count: number): string {
  if (count <= 0) return '';
  const lines = text.split('\n');
  if (lines.length <= count) return text;
  return lines.slice(lines.length - count).join('\n');
}

/** Extracts the executable binary or command name, handling quoted Windows paths. */
export function extractBinary(cmd: string): string {
  const trimmed = cmd.trim();
  if (trimmed.startsWith('"')) {
    const nextQuote = trimmed.indexOf('"', 1);
    if (nextQuote !== -1) return trimmed.slice(1, nextQuote);
  }
  if (trimmed.startsWith("'")) {
    const nextQuote = trimmed.indexOf("'", 1);
    if (nextQuote !== -1) return trimmed.slice(1, nextQuote);
  }
  return trimmed.split(/\s+/)[0] || '';
}

/** Pre-flight check verifying whether a command binary exists in PATH or on the filesystem. */
export function isExecutableInPath(cmd: string): boolean {
  const bin = extractBinary(cmd);
  if (!bin) return false;
  if (
    path.isAbsolute(bin) ||
    bin.startsWith('./') ||
    bin.startsWith('.\\') ||
    bin.startsWith('../') ||
    bin.startsWith('..\\')
  ) {
    return fs.existsSync(bin);
  }
  try {
    const checkCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const res = spawnSync(checkCmd, [bin], { stdio: 'ignore', windowsHide: true });
    if (res.status === 0) return true;
  } catch {}

  const pathEnv = process.env.PATH || '';
  const delimiter = path.delimiter;
  const dirs = pathEnv.split(delimiter);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = path.join(dir, bin + (ext.startsWith('.') ? ext : `.${ext}`));
      try {
        if (fs.existsSync(full)) return true;
      } catch {}
    }
  }
  return false;
}
