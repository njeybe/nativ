import { spawnSync } from 'node:child_process';

/**
 * nativ · The person who ran a human-only action, from `git config user.name`. A record only, never
 * a permission. The email is never read.
 */

const MAX_NAME = 64;
// Same hidden-character set learnings.ts removes from text a human reads.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function resolvePerson(cwd: string): string | undefined {
  try {
    const r = spawnSync('git', ['config', 'user.name'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    if (r.error || r.status !== 0) return undefined;
    const name = (r.stdout ?? '').replace(HIDDEN, ' ').trim();
    if (!name) return undefined;
    return name.length > MAX_NAME ? name.slice(0, MAX_NAME) : name;
  } catch {
    return undefined;
  }
}
