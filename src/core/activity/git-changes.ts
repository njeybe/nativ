import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CircuitBreaker } from '../../governor/circuit-breaker.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  status: ChangeStatus;
}

export interface TaskChanges {
  scope: 'worktree' | 'main';
  base: string | null;
  files: ChangedFile[];
  diff?: string;
}

export class GitChangesError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GitChangesError';
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(new GitChangesError('GIT_ERROR', `git ${args[0]} failed: ${err.message}`));
        else resolve(stdout);
      });
  });
}

const slash = (p: string) => p.replace(/\\/g, '/');

function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (file === '') { file = parts[i + 2] ?? ''; i += 2; }
    map.set(slash(file), { added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2] });
  }
  return map;
}

function parseNameStatus(out: string): Map<string, ChangeStatus> {
  const map = new Map<string, ChangeStatus>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      map.set(slash(parts[i + 2] ?? ''), kind === 'R' ? 'renamed' : 'added');
      i += 2;
      continue;
    }
    const status: ChangeStatus = kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified';
    map.set(slash(parts[i + 1] ?? ''), status);
    i += 1;
  }
  return map;
}

function countLines(file: string): number {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return 0;
  }
  if (buf.subarray(0, 8000).includes(0)) return 0;
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

async function resolveBase(root: string, taskId: string) {
  const wt = path.join(root, '.worktrees', `task-${taskId}`);
  if (fs.existsSync(wt)) {
    const mainHead = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const base = (await git(wt, ['merge-base', 'HEAD', mainHead])).trim();
    return { scope: 'worktree' as const, cwd: wt, base };
  }
  const base = CircuitBreaker.getBaseline(root, taskId);
  if (!base) throw new GitChangesError('NO_BASELINE', `No start commit recorded for ${taskId}`);
  return { scope: 'main' as const, cwd: root, base };
}

export async function taskChanges(
  root: string,
  taskId: string,
  opts: { full?: boolean } = {},
): Promise<TaskChanges> {
  const { scope, cwd, base } = await resolveBase(root, taskId);
  const [numstat, names, others] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '-M', base, '--']),
    git(cwd, ['diff', '--name-status', '-z', '-M', base, '--']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const counts = parseNumstat(numstat);
  const files: ChangedFile[] = [];
  for (const [file, status] of parseNameStatus(names)) {
    const c = counts.get(file) ?? { added: 0, removed: 0 };
    files.push({ path: file, added: c.added, removed: c.removed, status });
  }
  for (const raw of others.split('\0').filter(Boolean)) {
    const file = slash(raw);
    files.push({ path: file, added: countLines(path.join(cwd, raw)), removed: 0, status: 'untracked' });
  }
  const result: TaskChanges = { scope, base, files };
  if (opts.full) result.diff = await git(cwd, ['diff', base, '--']);
  return result;
}
