import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

console.log('--- Starting Task Claim Tests ---');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(root, 'bin', 'cli.js');
const HEADLESS_ENV = { ...process.env, CI: '', GITHUB_ACTIONS: '', GITLAB_CI: '', NATIV_CI_OVERRIDE: '', NATIV_HEADLESS_OVERRIDE: '' };
const dirs = [];

const task = (id, extra = {}) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [], status: 'pending', verificationCommand: '', ...extra,
});

function project(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-claims-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const plan = { version: '1.0.0', projectName: 'claims', lastUpdated: new Date().toISOString(), overallStatus: 'in_progress', activeMilestoneId: 'm1', milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks }] };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

const nativ = (dir, args, agent) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...HEADLESS_ENV, NATIV_AGENT_ID: agent ?? '' } });
const get = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8')).milestones[0].tasks.find((t) => t.id === id);
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

try {
  // Test 1: start refuses completed, blocked and dependency-waiting tasks
  {
    const dir = project([task('t1', { status: 'completed' }), task('t2', { status: 'blocked', notes: 'needs schema' }), task('t3', { dependencies: ['t4'] }), task('t4')]);
    const done = nativ(dir, ['task', 'start', 't1', dir]);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /already completed/);
    const blocked = nativ(dir, ['task', 'start', 't2', dir]);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /blocked \(needs schema\).*nativ triage/);
    const waiting = nativ(dir, ['task', 'start', 't3', dir]);
    assert.equal(waiting.status, 1);
    assert.match(waiting.stderr, /unfinished dependencies: t4/);
    assert.equal(get(dir, 't3').status, 'pending', 'a refused start changes nothing');
    console.log('✔ Test 1: completed, blocked and dependency-waiting tasks cannot be started');
  }

  // Test 2: a start records the claim; another agent is refused, the same agent refreshes it
  {
    const dir = project([task('t1')]);
    assert.equal(nativ(dir, ['task', 'start', 't1', dir], 'agent-a').status, 0);
    const claimed = get(dir, 't1');
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.claimedBy, 'agent-a');
    assert.ok(Date.now() - Date.parse(claimed.claimedAt) < 60_000, 'claimedAt is now');

    const other = nativ(dir, ['task', 'start', 't1', dir], 'agent-b');
    assert.equal(other.status, 1);
    assert.match(other.stderr, /already claimed by agent-a/);
    assert.equal(get(dir, 't1').claimedBy, 'agent-a');

    assert.equal(nativ(dir, ['task', 'start', 't1', dir, '--agent', 'agent-a']).status, 0, '--agent works like NATIV_AGENT_ID');
    assert.equal(nativ(dir, ['task', 'start', 't1', dir]).status, 0, 'an anonymous resume is allowed');
    assert.equal(get(dir, 't1').claimedBy, 'agent-a', 'and keeps the owner');
    console.log('✔ Test 2: claims are recorded, held against other agents, and refreshed by their owner');
  }

  // Test 3: a stale claim can be taken over; completing or blocking releases the claim
  {
    const dir = project([task('t1', { status: 'in_progress', claimedBy: 'agent-a', claimedAt: hoursAgo(5) }), task('t2')]);
    assert.equal(nativ(dir, ['task', 'start', 't1', dir], 'agent-b').status, 0, 'a 5h-old claim is stale');
    assert.equal(get(dir, 't1').claimedBy, 'agent-b');
    assert.equal(nativ(dir, ['task', 'complete', 't1', dir], 'agent-b').status, 0);
    assert.equal(get(dir, 't1').claimedBy, undefined);
    assert.equal(get(dir, 't1').claimedAt, undefined);

    assert.equal(nativ(dir, ['task', 'start', 't2', dir], 'agent-b').status, 0);
    assert.equal(nativ(dir, ['task', 'block', 't2', dir, '--reason', 'stuck']).status, 0);
    assert.equal(get(dir, 't2').claimedBy, undefined);
    console.log('✔ Test 3: stale claims can be taken over; complete and block release the claim');
  }

  // Test 4: --force is a human override that agents cannot use
  {
    const dir = project([task('t1', { status: 'blocked', notes: 'x' })]);
    const forced = nativ(dir, ['task', 'start', 't1', dir, '--force']);
    assert.equal(forced.status, 1);
    assert.match(forced.stderr, /needs an interactive terminal/);
    const ci = spawnSync(process.execPath, [CLI, 'task', 'start', 't1', dir, '--force'], { cwd: dir, encoding: 'utf8', env: { ...HEADLESS_ENV, NATIV_HEADLESS_OVERRIDE: '1' } });
    assert.equal(ci.status, 0, ci.stderr);
    assert.equal(get(dir, 't1').status, 'in_progress');
    console.log('✔ Test 4: --force is refused headless and works with a human override');
  }

  console.log('\n🎉 ALL TASK CLAIM TESTS PASSED!');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
