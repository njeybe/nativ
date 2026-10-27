import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanEnvReads } from '../dist/core/env-reads.js';

console.log('--- Starting M16 End-to-End Scenario ---');

// One invented git project, driven through the real CLI: init, skip policy, clean-copy checks,
// timeout cleanup, config fallbacks and the docs check.
const CLI = path.resolve('bin', 'cli.js');
const env = { ...process.env, NATIV_PROVIDER_CHILD: '1' };
for (const k of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'NATIV_ROLE', 'NATIV_CI_OVERRIDE']) delete env[k];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-m16-e2e-'));
const at = (...p) => path.join(root, ...p);
const opts = { cwd: root, encoding: 'utf8', env, timeout: 120_000 };
const nativ = (...a) => spawnSync(process.execPath, [CLI, ...a], opts);
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('nativ-verify-')).sort();

try {
  git('init', '-q');
  write('package.json', JSON.stringify({ name: 'shop-demo', version: '1.0.0' }));
  const init = nativ('init', '.');
  assert.equal(init.status, 0, init.stdout + init.stderr);

  // init: the managed block exists and git sees no nativ path
  assert.match(fs.readFileSync(at('.gitignore'), 'utf8'), />>> nativ \(managed\)/);
  const status = git('status', '--porcelain').stdout;
  assert.ok(!/\.ai|\.nativ|AGENTS|CLAUDE|GEMINI|\.claude|\.mcp|\.worktrees/.test(status), status);

  // A test that reads a gitignored file, a check that is skipped, and one that hangs
  fs.appendFileSync(at('.gitignore'), 'local-data/\n');
  write('local-data/prices.txt', 'apple=3\n');
  write('tests/prices.test.js', "require('fs').readFileSync('local-data/prices.txt', 'utf8');\n");
  const plan = JSON.parse(fs.readFileSync(at('.ai', 'master_plan.json'), 'utf8'));
  const task = (id, cmd) => ({
    id, title: id, description: 'd', assignedSubagent: 'qa-agent', dependencies: [],
    targetFiles: ['tests/prices.test.js'], status: 'pending', verificationCommand: cmd,
    verificationKind: 'unit', notes: '',
  });
  plan.milestones[0].tasks = [
    task('t-skip', 'skip'),
    task('t-read', 'node tests/prices.test.js'),
    task('t-slow', 'node -e "setTimeout(()=>{},60000)"'),
  ];
  write('.ai/master_plan.json', JSON.stringify(plan, null, 2));
  git('add', '-A');
  git('-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-qm', 'base');

  // Enterprise refuses an explicit-kind skip
  assert.equal(nativ('task', 'start', 't-skip', '.').status, 0);
  const skip = nativ('task', 'complete', 't-skip', '.');
  assert.match(skip.stdout + skip.stderr, /cannot complete: .*no real check/);
  const after = JSON.parse(fs.readFileSync(at('.ai', 'master_plan.json'), 'utf8'));
  assert.equal(after.milestones[0].tasks[0].status, 'in_progress');

  // The gitignored read fails in a clean copy and passes in place
  const clean = nativ('verify', 't-read', '.', '--isolation', 'clean');
  assert.equal(clean.status, 1, clean.stdout);
  assert.match(clean.stdout, /clean copy/);
  const plain = nativ('verify', 't-read', '.', '--isolation', 'none');
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);

  // A timeout leaves no clean worktree or temp folder of ours behind
  const before = leftovers();
  const slow = nativ('verify', 't-slow', '.', '--isolation', 'clean', '--timeout', '2000');
  assert.equal(slow.status, 1);
  assert.match(slow.stdout + slow.stderr, /timed out/);
  assert.deepEqual(leftovers(), before);
  assert.ok(!git('worktree', 'list').stdout.includes('nativ-verify-'));

  // The config-fallback fixture is flagged, a real default is not
  const src = "const a = process.env.SHOP_REGION ?? '';\nconst b = process.env.SHOP_PORT ?? '80';\n";
  const reads = scanEnvReads(src, 'a.js');
  assert.deepEqual(reads.map((r) => [r.name, r.fallback]), [['SHOP_REGION', true], ['SHOP_PORT', false]]);

  // check docs flags an invented placeholder
  write('scripts/seed.sh', 'echo "<ADMIN_NAME>"\n');
  write('guide.md', 'Run `scripts/seed.sh` with `<your-name>`.\n');
  const docs = nativ('check', 'docs', 'guide.md', '--json');
  assert.equal(docs.status, 1, docs.stdout + docs.stderr);
  assert.deepEqual(JSON.parse(docs.stdout).findings.map((f) => f.kind), ['placeholder']);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('M16 end-to-end scenario passed.');
