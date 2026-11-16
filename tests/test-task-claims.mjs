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

  // Test 5: reclaim frees stale claims only, reports unknown ages, and honours --dry-run
  {
    const dir = project([
      task('old', { status: 'in_progress', claimedBy: 'agent-a', claimedAt: hoursAgo(6) }),
      task('fresh', { status: 'in_progress', claimedBy: 'agent-b', claimedAt: hoursAgo(1) }),
      task('legacy', { status: 'in_progress' }),
      task('idle'),
    ]);
    const dry = nativ(dir, ['task', 'reclaim', dir, '--dry-run', '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    const dryJson = JSON.parse(dry.stdout);
    assert.deepEqual(dryJson.reclaimed.map((r) => r.id), ['old']);
    assert.deepEqual(dryJson.unknownAge, ['legacy']);
    assert.equal(get(dir, 'old').status, 'in_progress', '--dry-run changes nothing');

    const run = JSON.parse(nativ(dir, ['task', 'reclaim', dir, '--json']).stdout);
    assert.equal(run.reclaimed[0].claimedBy, 'agent-a');
    assert.equal(get(dir, 'old').status, 'pending');
    assert.equal(get(dir, 'old').claimedBy, undefined);
    assert.equal(get(dir, 'fresh').status, 'in_progress', 'a fresh claim is kept');
    assert.equal(get(dir, 'legacy').status, 'in_progress', 'an unknown age is never reclaimed implicitly');

    assert.equal(JSON.parse(nativ(dir, ['task', 'reclaim', dir, '--older-than', '0.5', '--json']).stdout).reclaimed[0].id, 'fresh', '--older-than sets the age');
    assert.equal(nativ(dir, ['task', 'reclaim', 'legacy', dir]).status, 0, 'a task with no claim time is reclaimed by id');
    assert.equal(get(dir, 'legacy').status, 'pending');
    console.log('✔ Test 5: reclaim frees stale claims, keeps fresh ones, and needs an id for unknown ages');
  }

  // Test 6: a named fresh claim needs a human; a task that is not in progress is an error
  {
    const dir = project([task('t1', { status: 'in_progress', claimedBy: 'agent-a', claimedAt: hoursAgo(0.2) }), task('t2')]);
    const fresh = nativ(dir, ['task', 'reclaim', 't1', dir]);
    assert.equal(fresh.status, 1);
    assert.match(fresh.stderr, /claimed by agent-a 0\.2h ago/);
    assert.equal(nativ(dir, ['task', 'reclaim', 't1', dir, '--force']).status, 1, '--force is refused headless');
    assert.equal(get(dir, 't1').status, 'in_progress');
    const idle = nativ(dir, ['task', 'reclaim', 't2', dir]);
    assert.equal(idle.status, 1);
    assert.match(idle.stderr, /not in_progress/);
    assert.equal(nativ(dir, ['task', 'reclaim', dir, '--older-than', '-1']).status, 1, 'a negative age is rejected');
    console.log('✔ Test 6: fresh named claims need a human; reclaiming an idle task is an error');
  }

  // Test 7: the SessionStart orientation flags stale tasks
  {
    const dir = project([task('t1', { status: 'in_progress', claimedAt: hoursAgo(7) })]);
    const ctx = spawnSync(process.execPath, [CLI, 'hook', 'context', dir], { encoding: 'utf8', env: HEADLESS_ENV });
    assert.match(JSON.parse(ctx.stdout).hookSpecificOutput.additionalContext, /stale in_progress: t1 \(7h\): run `nativ task reclaim`/);
    console.log('✔ Test 7: the session orientation lists stale tasks');
  }

  // Test 8: complete and block refuse a fresh claim by another id; anonymous and stale pass
  {
    const fresh = { status: 'in_progress', claimedBy: 'agent-a', claimedAt: hoursAgo(0.5) };
    const dir = project([task('t1', fresh), task('t2', fresh), task('t3', fresh), task('t4', { ...fresh, claimedAt: hoursAgo(5) })]);
    const done = nativ(dir, ['task', 'complete', 't1', dir], 'agent-b');
    assert.equal(done.status, 1);
    assert.match(done.stderr, /already claimed by agent-a/);
    const blocked = nativ(dir, ['task', 'block', 't1', dir, '--reason', 'x'], 'agent-b');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /already claimed by agent-a/);
    assert.equal(get(dir, 't1').status, 'in_progress', 'refusals change nothing');
    assert.equal(nativ(dir, ['task', 'complete', 't2', dir]).status, 0, 'an anonymous caller passes');
    assert.equal(nativ(dir, ['task', 'block', 't3', dir, '--reason', 'x']).status, 0);
    assert.equal(nativ(dir, ['task', 'complete', 't4', dir], 'agent-b').status, 0, 'a stale claim passes');
    console.log('✔ Test 8: complete and block respect fresh claims of other agents');
  }

  // Test 9: complete re-checks under the lock what changed while verification ran
  {
    const dir = project([task('t0')]);
    const planFile = path.join(dir, '.ai', 'master_plan.json');
    const rewrite = (patch) => {
      const js = `const f=${JSON.stringify(planFile)};const fs=require('fs');const p=JSON.parse(fs.readFileSync(f,'utf8'));` +
        `Object.assign(p.milestones[0].tasks[0],${JSON.stringify(patch)});fs.writeFileSync(f,JSON.stringify(p))`;
      return `node -e ${JSON.stringify(js)}`;
    };
    const cases = [
      [{ status: 'completed' }, /already completed/],
      [{ status: 'blocked', notes: 'by a human' }, /blocked while verification ran/],
      [{ claimedBy: 'agent-z', claimedAt: new Date().toISOString() }, /already claimed by agent-z/],
    ];
    for (const [patch, message] of cases) {
      const cmd = rewrite(patch);
      fs.writeFileSync(planFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(planFile, 'utf8')),
        milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks: [task('t1', { status: 'in_progress', verificationCommand: cmd })] }] }));
      const run = nativ(dir, ['task', 'complete', 't1', dir]);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, message);
      assert.doesNotMatch(run.stdout, /successfully marked/);
      const after = get(dir, 't1');
      for (const [k, v] of Object.entries(patch)) assert.equal(after[k], v, 'the plan keeps what changed');
    }
    console.log('✔ Test 9: complete changes nothing when the task changed during verification');
  }

  // Test 10: with no ids anywhere, start then complete works as before
  {
    const dir = project([task('t1', { verificationCommand: 'node -e "process.exit(0)"' })]);
    assert.equal(nativ(dir, ['task', 'start', 't1', dir]).status, 0);
    const run = nativ(dir, ['task', 'complete', 't1', dir]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(get(dir, 't1').status, 'completed');
    console.log('✔ Test 10: anonymous start then complete still completes');
  }

  // Test 11: task next prefers own claim, skips fresh foreign claims, ignores stale ones
  {
    const next = (dir, agent) => JSON.parse(nativ(dir, ['task', 'next', dir, '--json'], agent).stdout).task?.id;
    const fresh = { status: 'in_progress', claimedBy: 'agent-a', claimedAt: hoursAgo(0.5) };
    const dir = project([task('t1', fresh), task('t2', { status: 'in_progress', claimedBy: 'agent-b', claimedAt: hoursAgo(0.5) }), task('t3')]);
    assert.equal(next(dir, 'agent-b'), 't2', 'own claim preferred');
    assert.equal(next(dir, 'agent-c'), 't3', 'fresh foreign claims skipped, pending returned');
    const stale = project([task('t1', { ...fresh, claimedAt: hoursAgo(5) }), task('t2')]);
    assert.equal(next(stale, 'agent-b'), 't1', 'a stale claim is not skipped');
    assert.equal(next(dir), 't1', 'no id gives the first in_progress task');
    console.log('✔ Test 11: task next respects claims of other agents');
  }

  // Test 12: overrides are recorded on the task and unlocks record who
  {
    const emptyCfg = path.join(os.tmpdir(), `nativ-claims-empty-${process.pid}.gitconfig`);
    fs.writeFileSync(emptyCfg, '');
    dirs.push(emptyCfg);
    const human = (dir, args) => spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
      env: { ...HEADLESS_ENV, NATIV_HEADLESS_OVERRIDE: '1', NATIV_AGENT_ID: '', GIT_CONFIG_GLOBAL: emptyCfg, GIT_CONFIG_NOSYSTEM: '1' },
    });
    const repo = (tasks, name) => {
      const dir = project(tasks);
      spawnSync('git', ['init', '-q'], { cwd: dir });
      if (name) spawnSync('git', ['config', 'user.name', name], { cwd: dir });
      return dir;
    };
    const fresh = { status: 'in_progress', claimedBy: 'agent-a', claimedAt: hoursAgo(0.2) };
    const dir = repo([task('s', { status: 'blocked', notes: 'x' }), task('c', fresh), task('r', fresh),
      task('stale', { ...fresh, claimedAt: hoursAgo(6) }), task('d', fresh)], 'Ada Lovelace');
    assert.equal(human(dir, ['task', 'start', 's', dir, '--force']).status, 0);
    assert.equal(human(dir, ['task', 'complete', 'c', dir, '--no-verify']).status, 0);
    assert.equal(human(dir, ['task', 'reclaim', 'd', dir, '--force', '--dry-run']).status, 0);
    assert.equal(get(dir, 'd').overrides, undefined, 'a dry run records nothing');
    assert.equal(human(dir, ['task', 'reclaim', 'r', dir, '--force']).status, 0);
    assert.equal(human(dir, ['task', 'reclaim', 'stale', dir, '--force']).status, 0);
    for (const [id, action] of [['s', 'start --force'], ['c', 'complete --no-verify'], ['r', 'reclaim --force']]) {
      const [o] = get(dir, id).overrides;
      assert.equal(o.action, action);
      assert.equal(o.by, 'Ada Lovelace');
      assert.ok(!Number.isNaN(Date.parse(o.at)));
    }
    assert.equal(get(dir, 'stale').overrides, undefined, 'a stale claim needed no force');

    const anon = repo([task('c', fresh)]);
    assert.equal(human(anon, ['task', 'complete', 'c', anon, '--no-verify']).status, 0);
    const entry = get(anon, 'c').overrides[0];
    assert.equal(entry.action, 'complete --no-verify');
    assert.ok(!('by' in entry), 'no git name omits by');

    assert.equal(human(dir, ['task', 'unlock', 'r', dir]).status, 0);
    const unlocks = JSON.parse(fs.readFileSync(path.join(dir, '.nativ', 'unlocks.json'), 'utf8')).unlocks;
    assert.equal(unlocks[0].by, 'Ada Lovelace');

    const old = project([task('t1')]);
    fs.mkdirSync(path.join(old, '.nativ'), { recursive: true });
    fs.writeFileSync(path.join(old, '.nativ', 'unlocks.json'), JSON.stringify({ unlocks: [{ taskId: 't1', at: 'x' }] }));
    assert.equal(nativ(old, ['task', 'start', 't1', old]).status, 0, 'a plan without overrides works');
    assert.equal(get(old, 't1').overrides, undefined);

    const { validateMasterPlanTask } = await import('../dist/scanner/types.js');
    const base = task('v');
    assert.deepEqual(validateMasterPlanTask({ ...base, overrides: [{ action: 'start --force', at: 'x' }] }), []);
    assert.equal(validateMasterPlanTask({ ...base, overrides: 'no' }).length, 1);
    assert.equal(validateMasterPlanTask({ ...base, overrides: [{ action: 'bogus', at: 'x' }] }).length, 1);
    console.log('✔ Test 12: overrides and unlocks record what was bypassed and by whom');
  }

  console.log('\n🎉 ALL TASK CLAIM TESTS PASSED!');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
