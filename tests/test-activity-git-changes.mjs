import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { taskChanges } from '../dist/core/activity/git-changes.js';
import { CircuitBreaker } from '../dist/governor/circuit-breaker.js';

console.log('--- Git changes ---');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-git-changes-'));
  fs.mkdirSync(path.join(dir, '.ai'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\ny\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2, 3]));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const byPath = (res) => Object.fromEntries(res.files.map((f) => [f.path, f]));

// Worktree task: committed, uncommitted and untracked changes
{
  const root = makeRepo();
  git(root, 'worktree', 'add', '-q', path.join(root, '.worktrees', 'task-task-1'), '-b', 'agent/task-1');
  const wt = path.join(root, '.worktrees', 'task-task-1');
  fs.mkdirSync(path.join(wt, 'sub'));
  fs.writeFileSync(path.join(wt, 'sub', 'new.txt'), 'n1\nn2\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'work');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nTWO\nthree\nfour\n');
  git(wt, 'rm', '-q', 'gone.txt');
  fs.writeFileSync(path.join(wt, 'bin.dat'), Buffer.from([9, 0, 9, 9, 9]));
  fs.writeFileSync(path.join(wt, 'loose.txt'), 'l1\nl2\nl3');
  fs.writeFileSync(path.join(wt, 'loose.bin'), Buffer.from([0, 1, 2]));

  const res = await taskChanges(root, 'task-1');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(res.scope, 'worktree');
  assert.equal(res.base, head);
  assert.equal(res.diff, undefined);
  const f = byPath(res);
  assert.deepEqual(f['sub/new.txt'], { path: 'sub/new.txt', added: 2, removed: 0, status: 'added' });
  assert.deepEqual(f['a.txt'], { path: 'a.txt', added: 2, removed: 1, status: 'modified' });
  assert.deepEqual(f['gone.txt'], { path: 'gone.txt', added: 0, removed: 2, status: 'deleted' });
  assert.deepEqual(f['loose.txt'], { path: 'loose.txt', added: 3, removed: 0, status: 'untracked' });
  assert.equal(f['bin.dat'].added, 0);
  assert.equal(f['bin.dat'].removed, 0);
  assert.equal(f['loose.bin'].added, 0);
  assert.equal(f['loose.bin'].status, 'untracked');

  const full = await taskChanges(root, 'task-1', { full: true });
  assert.ok(full.diff.includes('+four'));
  console.log('  ok worktree task');
}

// Main-tree task: baseline required, then compared against it
{
  const root = makeRepo();
  await assert.rejects(taskChanges(root, 'task-2'), (e) => e.code === 'NO_BASELINE');
  CircuitBreaker.recordBaseline(root, 'task-2', git(root, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  const res = await taskChanges(root, 'task-2');
  assert.equal(res.scope, 'main');
  const f = byPath(res);
  assert.deepEqual(f['a.txt'], { path: 'a.txt', added: 0, removed: 2, status: 'modified' });
  console.log('  ok main task');
}

// Diff over 1 MB: cut at a line end, flagged, file list still complete
{
  const root = makeRepo();
  fs.writeFileSync(path.join(root, 'big.txt'), 'seed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'big seed');
  CircuitBreaker.recordBaseline(root, 'task-3', git(root, 'rev-parse', 'HEAD'));
  const line = 'x'.repeat(99) + '\n';
  fs.writeFileSync(path.join(root, 'big.txt'), line.repeat(15000));
  const res = await taskChanges(root, 'task-3', { full: true });
  assert.equal(res.diffTruncated, true);
  assert.ok(Buffer.byteLength(res.diff) <= 1024 * 1024);
  assert.ok(res.diff.endsWith('\n'));
  assert.ok(res.diff.includes('+' + 'x'.repeat(99)));
  const f = byPath(res);
  assert.equal(f['big.txt'].added, 15000);
  assert.equal(f['big.txt'].status, 'modified');
  console.log('  ok diff over limit is truncated');
}

// Diff within the limit: flag absent
{
  const root = makeRepo();
  CircuitBreaker.recordBaseline(root, 'task-4', git(root, 'rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  const res = await taskChanges(root, 'task-4', { full: true });
  assert.equal(res.diffTruncated, undefined);
  assert.ok(res.diff.includes('-two'));
  console.log('  ok small diff is not truncated');
}

console.log('Git changes tests passed');
