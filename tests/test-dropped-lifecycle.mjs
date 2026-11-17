import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runTaskStart, runTaskComplete, runTaskBlock, runTaskAdd, runTaskEscalate,
} from '../dist/commands/task.js';
import { startRefusal } from '../dist/core/task-claims.js';

console.log('--- Dropped tasks in the task lifecycle ---');

const dirs = [];
const task = (id, extra = {}) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [],
  status: 'pending', verificationCommand: '', ...extra,
});
const dropped = (id) => task(id, { status: 'dropped', drop: { reason: 'cut', changeId: 'c1', at: 'now' } });

function project(milestones) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-dropped-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const plan = {
    version: '1.0.0', projectName: 'dp', lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress', activeMilestoneId: milestones[0].id, milestones,
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

const readPlan = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));
const ms = (id, status, tasks) => ({ id, name: id, status, tasks });

// Runs fn with output captured; returns the error text.
async function capture(fn) {
  const saved = [console.log, console.error];
  let err = '';
  console.log = () => {};
  console.error = (...a) => { err += a.join(' '); };
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    [console.log, console.error] = saved;
  }
  const code = process.exitCode;
  process.exitCode = undefined;
  return { err, code };
}

const savedHeadless = process.env.NATIV_HEADLESS_OVERRIDE;
const savedAgent = process.env.NATIV_AGENT_ID;
delete process.env.NATIV_AGENT_ID;

try {
  // Test 1: start, forced start, complete and block refuse a dropped task
  {
    const dir = project([ms('m1', 'in_progress', [dropped('d1'), task('t1')])]);
    for (const [name, run] of [
      ['start', () => runTaskStart('d1', dir)],
      ['complete', () => runTaskComplete('d1', dir)],
      ['block', () => runTaskBlock('d1', 'why', dir)],
    ]) {
      const r = await capture(run);
      assert.equal(r.code, 1, `${name} fails`);
      assert.match(r.err, /dropped/, `${name} says why`);
    }
    process.env.NATIV_HEADLESS_OVERRIDE = '1';
    const forced = await capture(() => runTaskStart('d1', dir, { force: true }));
    assert.equal(forced.code, 1);
    assert.match(forced.err, /dropped/);
    assert.equal(readPlan(dir).milestones[0].tasks[0].status, 'dropped', 'status unchanged');
    console.log('  ✔ start, start --force, complete and block refuse a dropped task');
  }

  // Test 2: completing the last open task settles the milestone and moves on
  {
    const dir = project([
      ms('m1', 'in_progress', [dropped('d1'), task('t1', { status: 'in_progress' })]),
      ms('m2', 'pending', [task('n1')]),
    ]);
    await capture(() => runTaskComplete('t1', dir));
    const plan = readPlan(dir);
    assert.equal(plan.milestones[0].status, 'completed');
    assert.equal(plan.activeMilestoneId, 'm2');
    assert.equal(plan.overallStatus, 'in_progress');

    const last = project([ms('m1', 'in_progress', [dropped('d1'), task('t1', { status: 'in_progress' })])]);
    await capture(() => runTaskComplete('t1', last));
    assert.equal(readPlan(last).overallStatus, 'completed');
    console.log('  ✔ the last open task completes a milestone whose other tasks are dropped');
  }

  // Test 3: task add refuses a dependency on a dropped task
  {
    const dir = project([ms('m1', 'in_progress', [dropped('d1'), task('t1')])]);
    const saved = [console.log, console.error];
    let out = '';
    console.log = (m) => { out += m; };
    console.error = () => {};
    let result;
    try {
      result = await runTaskAdd('child', dir, { deps: 'd1', json: true });
    } finally {
      [console.log, console.error] = saved;
    }
    process.exitCode = undefined;
    assert.equal(result, null);
    assert.equal(JSON.parse(out).error.code, 'DROPPED_DEPENDENCY');
    assert.equal(readPlan(dir).milestones[0].tasks.length, 2, 'nothing added');
    console.log('  ✔ task add refuses a dropped dependency with DROPPED_DEPENDENCY');
  }

  // Test 4: a dropped dependency never counts as done
  {
    const plan = {
      version: '1.0.0', projectName: 'dp', lastUpdated: 'now', overallStatus: 'in_progress',
      activeMilestoneId: 'm1',
      milestones: [
        ms('m1', 'in_progress', [dropped('d1'), task('t1', { dependencies: ['d1'] })]),
        { ...ms('m0', 'completed', []), archived: { taskIds: ['a1', 'a2'], droppedTaskIds: ['a2'] } },
      ],
    };
    const t1 = plan.milestones[0].tasks[1];
    assert.match(startRefusal(plan, t1, undefined), /waits on unfinished dependencies: d1/);
    const viaArchive = task('t2', { dependencies: ['a2'] });
    assert.match(startRefusal(plan, viaArchive, undefined), /a2/);
    assert.equal(startRefusal(plan, task('t3', { dependencies: ['a1'] }), undefined), null);
    console.log('  ✔ a dropped dependency never counts as done');
  }

  // Test 5: escalate refuses a dropped task and files nothing
  {
    const dir = project([ms('m1', 'in_progress', [dropped('d1'), task('t1')])]);
    const before = readPlan(dir).milestones[0].tasks[0];
    const r = await capture(() => runTaskEscalate('d1', dir, { type: 'schema_flaw', details: 'x' }));
    assert.equal(r.code, 1, 'escalate fails');
    assert.match(r.err, /dropped/, 'escalate says why');
    const after = readPlan(dir).milestones[0].tasks[0];
    assert.equal(after.status, 'dropped', 'status stays dropped');
    assert.equal(after.notes, before.notes, 'notes unchanged');
    assert.deepEqual(after.drop, before.drop, 'drop unchanged');
    const escPath = path.join(dir, '.ai', 'escalation.json');
    const escs = fs.existsSync(escPath) ? JSON.parse(fs.readFileSync(escPath, 'utf8')) : null;
    const list = Array.isArray(escs) ? escs : (escs?.escalations ?? []);
    assert.equal(list.filter((e) => e.taskId === 'd1').length, 0, 'no escalation filed');
    console.log('  ✔ escalate refuses a dropped task and files no escalation');
  }

  console.log('\n✔ All dropped lifecycle tests passed');
} finally {
  if (savedHeadless === undefined) delete process.env.NATIV_HEADLESS_OVERRIDE;
  else process.env.NATIV_HEADLESS_OVERRIDE = savedHeadless;
  if (savedAgent !== undefined) process.env.NATIV_AGENT_ID = savedAgent;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
