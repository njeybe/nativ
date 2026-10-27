import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { linkWorktreeDir, safeUnlinkWorktreeDir } from '../root-resolver.js';

export const CLEAN_TREE_PREFIX = 'nativ-verify-';
const STALE_MS = 60 * 60 * 1000;

export type CleanTree =
  | { ok: true; dir: string; dispose: () => Promise<void> }
  | { ok: false; reason: string };

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const opts = { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  return new Promise((resolve) => {
    execFile('git', args, opts, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, out: String(stdout ?? '') });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') return;
    }
    await sleep(150 * (i + 1));
  }
}

// Links go first: removing a tree can follow a junction into the real folder.
function linkRemains(dir: string, names: string[]): boolean {
  return names.some((n) => {
    try {
      return fs.lstatSync(path.join(dir, n)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

// unlink is injectable so tests can simulate a link that refuses to go away.
export async function disposeTree(
  root: string,
  dir: string,
  names: string[],
  unlink: (dir: string, name: string) => boolean = safeUnlinkWorktreeDir,
): Promise<void> {
  try {
    for (const n of names) unlink(dir, n);
    // A surviving link means a recursive delete could reach the real folder: leave it for the sweep.
    if (linkRemains(dir, names)) return;
    for (let i = 0; i < 4; i++) {
      const r = await git(root, ['worktree', 'remove', '--force', dir]);
      if (r.code === 0 || !fs.existsSync(dir)) break;
      await sleep(150 * (i + 1));
    }
    await removeDir(dir);
    await git(root, ['worktree', 'prune']);
  } catch {
    // Cleanup never throws.
  }
}

async function copyUntracked(root: string, dir: string): Promise<void> {
  const r = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const rel of r.out.split('\0').filter(Boolean)) {
    const from = path.join(root, rel);
    const to = path.join(dir, rel);
    try {
      if (!fs.statSync(from).isFile()) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    } catch {
      // A file that vanished mid-copy is not worth failing the tree.
    }
  }
}

export async function createCleanTree(
  root: string,
  opts: { links?: string[] } = {},
): Promise<CleanTree> {
  const inRepo = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo.code !== 0) return { ok: false, reason: 'clean isolation needs a git repository' };
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) return { ok: false, reason: 'clean isolation needs at least one commit' };
  const stash = await git(root, ['stash', 'create']);
  const commit = stash.code === 0 && stash.out.trim() ? stash.out.trim() : head.out.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), CLEAN_TREE_PREFIX));
  fs.rmdirSync(dir);
  const args = ['-c', 'core.autocrlf=false', 'worktree', 'add', '--detach', dir, commit];
  const add = await git(root, args);
  if (add.code !== 0) {
    await removeDir(dir);
    return { ok: false, reason: 'could not create the clean tree' };
  }
  await copyUntracked(root, dir);
  const linked = (opts.links ?? []).filter((n) => linkWorktreeDir(dir, root, n));
  return { ok: true, dir, dispose: () => disposeTree(root, dir, linked) };
}

function ownedBy(root: string, dir: string): boolean {
  try {
    const text = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    const gitdir = text.replace(/^gitdir:\s*/, '').trim();
    const main = realOf(path.resolve(root, '.git')).toLowerCase();
    return realOf(path.resolve(gitdir)).toLowerCase().startsWith(main);
  } catch {
    return false;
  }
}

// Real paths make Windows short (8.3) and aliased paths compare equal.
function realOf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function linkNames(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => fs.lstatSync(path.join(dir, n)).isSymbolicLink());
}

export async function sweepStaleCleanTrees(root: string): Promise<number> {
  let removed = 0;
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith(CLEAN_TREE_PREFIX)) continue;
      const dir = path.join(tmp, name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < STALE_MS) continue;
        if (!ownedBy(root, dir)) continue;
        await disposeTree(root, dir, linkNames(dir));
        if (!fs.existsSync(dir)) removed++;
      } catch {
        // Skip entries we cannot read.
      }
    }
  } catch {
    // Nothing to sweep.
  }
  return removed;
}
