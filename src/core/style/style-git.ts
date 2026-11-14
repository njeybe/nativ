import { spawnSync } from 'node:child_process';

/** Stdout of a git command, or null when git fails or is missing; stderr is ignored. */
export function gitOutput(root: string, args: string[]): string | null {
  const res = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return res.status === 0 ? res.stdout : null;
}
