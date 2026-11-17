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

console.log('Git changes tests passed');
