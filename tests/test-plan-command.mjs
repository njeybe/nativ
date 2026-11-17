import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPlanPropose, runPlanDecide, runPlanList } from '../dist/commands/plan.js';
import { resolvePerson } from '../dist/core/identity.js';

console.log('--- Starting Plan Command Tests ---');

const task = (id, status, dependencies = []) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies, targetFiles: [],
  status, verificationCommand: 'true',
});

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-plan-cmd-'));
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const plan = {
    version: '1.0.0', projectName: 'p', status: 'in_progress', activeMilestoneId: 'm1',
    milestones: [{
      id: 'm1', name: 'm', status: 'in_progress',
      tasks: [task('task-1', 'pending'), task('task-2', 'blocked'), task('task-3', 'pending')],
    }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', f), 'utf8'));

async function capture(fn) {
  const out = [];
  const err = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  process.exitCode = 0;
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  const code = process.exitCode;
  process.exitCode = 0;
  return { out: out.join('\n'), err: err.join('\n'), code };
}

const savedOverride = process.env.NATIV_HEADLESS_OVERRIDE;
delete process.env.NATIV_HEADLESS_OVERRIDE;
delete process.env.NATIV_CI_OVERRIDE;
const dir = makeProject();

// Propose stores a record; refusals print the plain reason and exit 1
let r = await capture(() => runPlanPropose('task-3', dir, { reason: 'needs 1', addDeps: 'task-1', json: true }));
assert.equal(r.code, 0);
const stored = JSON.parse(r.out);
assert.equal(stored.id, 'pc-01');
assert.deepEqual(stored.change.addDependencies, ['task-1']);

r = await capture(() => runPlanPropose('task-3', dir, { reason: 'again', addDeps: 'task-3' }));
assert.equal(r.code, 1);
assert.match(r.err, /cannot depend on itself/);

r = await capture(() => runPlanPropose('task-3', dir, { reason: 'no change' }));
assert.equal(r.code, 1);
assert.match(r.err, /at least one change/);

r = await capture(() => runPlanPropose('task-2', dir, { reason: 'unblock', release: true, notes: 'ok' }));
assert.equal(r.code, 0);
assert.match(r.out, /pc-02/);

r = await capture(() => runPlanPropose('task-1', dir, { reason: 'x', drop: true, release: true }));
assert.equal(r.code, 1);
assert.match(r.err, /excludes every other/);

// List shows a fresh check for proposed records, and --json prints records
r = await capture(() => runPlanList(dir, { status: 'proposed' }));
assert.match(r.out, /passes the checks/);
assert.match(r.out, /2 waiting/);
r = await capture(() => runPlanList(dir, { json: true }));
assert.equal(JSON.parse(r.out).length, 2);
r = await capture(() => runPlanList(dir, { status: 'bogus' }));
assert.equal(r.code, 1);

// Approve and reject refuse without a terminal and change nothing
r = await capture(() => runPlanDecide('pc-01', 'approved', dir, { yes: true }));
assert.equal(r.code, 1);
assert.match(r.err, /needs an interactive terminal/);
assert.equal(readJson(dir, 'plan_changes.json').changes[0].status, 'proposed');

// With the explicit override, --yes decides; the record is stamped cli and the plan changes
process.env.NATIV_HEADLESS_OVERRIDE = '1';
r = await capture(() => runPlanDecide('pc-01', 'approved', dir, { yes: true, note: 'fine' }));
assert.equal(r.code, 0);
assert.match(r.out, /needs 1/);
assert.match(r.out, /passes the checks/);
const done = readJson(dir, 'plan_changes.json').changes[0];
assert.equal(done.status, 'approved');
assert.equal(done.decidedVia, 'cli');
assert.equal(done.decidedBy, resolvePerson(dir));
assert.equal(done.decisionNote, 'fine');
const plan = readJson(dir, 'master_plan.json');
assert.deepEqual(plan.milestones[0].tasks[2].dependencies, ['task-1']);

// Reject leaves the plan alone
r = await capture(() => runPlanDecide('pc-02', 'rejected', dir, { yes: true }));
assert.equal(r.code, 0);
assert.equal(readJson(dir, 'plan_changes.json').changes[1].status, 'rejected');
assert.equal(readJson(dir, 'master_plan.json').milestones[0].tasks[1].status, 'blocked');

r = await capture(() => runPlanDecide('pc-09', 'approved', dir, { yes: true }));
assert.equal(r.code, 1);
assert.match(r.err, /No plan change pc-09/);

if (savedOverride !== undefined) process.env.NATIV_HEADLESS_OVERRIDE = savedOverride;
else delete process.env.NATIV_HEADLESS_OVERRIDE;
fs.rmSync(dir, { recursive: true, force: true });
console.log('All plan command tests passed.');
