import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCleanTree, sweepStaleCleanTrees, disposeTree } from '../dist/core/verifier/clean-tree.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-ct-'));
g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
g(root, 'config', 'core.autocrlf', 'true');
fs.writeFileSync(path.join(root, '.gitignore'), '.ai/\n.env\nnode_modules/\n');
fs.writeFileSync(path.join(root, 'lf.txt'), 'a\nb\n');
fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');
fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
fs.writeFileSync(path.join(root, 'untracked.txt'), 'u\n');
fs.mkdirSync(path.join(root, '.ai'));
fs.writeFileSync(path.join(root, '.env'), 'S=1\n');
fs.mkdirSync(path.join(root, 'node_modules'));
fs.writeFileSync(path.join(root, 'node_modules', 'keep.txt'), 'k');
const stashBefore = g(root, 'stash', 'list');
const indexBefore = g(root, 'status', '--porcelain');
const keep = () => fs.readFileSync(path.join(root, 'node_modules', 'keep.txt'), 'utf8');

const t = await createCleanTree(root, { links: ['node_modules', 'missing'] });
assert.ok(t.ok, t.reason);
assert.ok(!t.dir.startsWith(root));
assert.ok(path.basename(t.dir).startsWith('nativ-verify-'));
assert.equal(fs.readFileSync(path.join(t.dir, 'tracked.txt'), 'utf8'), 'two\n');
assert.ok(fs.existsSync(path.join(t.dir, 'untracked.txt')));
assert.ok(!fs.existsSync(path.join(t.dir, '.ai')));
assert.ok(!fs.existsSync(path.join(t.dir, '.env')));
assert.ok(fs.existsSync(path.join(t.dir, 'node_modules', 'keep.txt')));
assert.ok(!fs.existsSync(path.join(t.dir, 'missing')));
// LF stays LF even with autocrlf=true in the project config
assert.equal(fs.readFileSync(path.join(t.dir, 'lf.txt'), 'utf8'), 'a\nb\n');
await t.dispose();
await t.dispose();
assert.ok(!fs.existsSync(t.dir));
assert.equal(keep(), 'k');
assert.ok(!g(root, 'worktree', 'list').includes('nativ-verify-'));
assert.equal(g(root, 'stash', 'list'), stashBefore);
assert.equal(g(root, 'status', '--porcelain'), indexBefore);

// A command killed mid-run still leaves nothing behind.
const k = await createCleanTree(root, { links: ['node_modules'] });
assert.ok(k.ok);
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: k.dir });
await new Promise((r) => setTimeout(r, 300));
child.kill();
await new Promise((r) => child.once('exit', r));
await k.dispose();
assert.ok(!fs.existsSync(k.dir));
assert.ok(!g(root, 'worktree', 'list').includes('nativ-verify-'));
assert.equal(keep(), 'k');

// Stale sweep removes old leftovers and keeps fresh ones.
const s = await createCleanTree(root, { links: ['node_modules'] });
const old = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(s.dir, old, old);
const fresh = await createCleanTree(root);
assert.ok((await sweepStaleCleanTrees(root)) >= 1);
assert.ok(!fs.existsSync(s.dir));
assert.ok(fs.existsSync(fresh.dir));
assert.equal(keep(), 'k');
await fresh.dispose();

// A link that cannot be unlinked blocks all deletion; the sweep finishes the job later.
const b = await createCleanTree(root, { links: ['node_modules'] });
await disposeTree(root, b.dir, ['node_modules'], () => false);
assert.ok(fs.existsSync(b.dir));
assert.ok(fs.existsSync(path.join(b.dir, 'node_modules', 'keep.txt')));
assert.equal(keep(), 'k');
fs.utimesSync(b.dir, old, old);
assert.ok((await sweepStaleCleanTrees(root)) >= 1);
assert.ok(!fs.existsSync(b.dir));
assert.equal(keep(), 'k');

// Not a git repository.
const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-ct-plain-'));
const np = await createCleanTree(plain);
assert.equal(np.ok, false);
assert.match(np.reason, /needs a git repository/);

for (const d of [root, plain]) fs.rmSync(d, { recursive: true, force: true });
console.log('clean-tree tests passed');
