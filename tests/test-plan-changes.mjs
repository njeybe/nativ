// Plan-change store: propose with checks, decide under the changes lock then the plan lock,
// parallel approvals, crash recovery, and the release and drop effects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  proposePlanChange, decidePlanChange, changeContent, loadPlanChanges, listPlanChanges, planChangesPath,
} from '../dist/core/plan-changes.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const created = [];
const ch = (code) => String.fromCharCode(code);
let passed = 0;

const task = (id, extra = {}) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [],
  status: 'pending', verificationCommand: 'true', notes: '', ...extra,
});

function basePlan() {
  return {
    version: '1.0.0', projectName: 'demo', lastUpdated: '2026-01-01T00:00:00.000Z',
    overallStatus: 'in_progress', activeMilestoneId: 'm2',
    milestones: [
      {
        id: 'm1', name: 'Old', status: 'completed', tasks: [],
        archived: {
          summary: 's', commit: null, check: 'c', archivedAt: 'x', taskCount: 2,
          taskIds: ['task-a1', 'task-a2'], droppedTaskIds: ['task-a2'], file: 'f',
        },
      },
      {
        id: 'm2', name: 'Now', status: 'in_progress', tasks: [
          task('task-01'),
          task('task-02', { dependencies: ['task-01'] }),
          task('task-03', { status: 'blocked', claimedBy: 'agent-x', claimedAt: 'then' }),
          task('task-04', { status: 'in_progress', claimedBy: 'agent-y', claimedAt: 'then' }),
          task('task-05', { status: 'completed' }),
          task('task-06', { status: 'dropped', drop: { reason: 'gone', changeId: 'pc-00', at: 'then' } }),
          task('task-07', { dependencies: ['task-02'] }),
        ],
      },
      { id: 'm3', name: 'Next', status: 'pending', tasks: [task('task-08')] },
    ],
  };
}

function fixture(plan = basePlan()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-pc-'));
  created.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  writePlan(dir, plan);
  return dir;
}

const planFile = (dir) => path.join(dir, '.ai', 'master_plan.json');
const readPlan = (dir) => JSON.parse(fs.readFileSync(planFile(dir), 'utf8'));
const writePlan = (dir, plan) => fs.writeFileSync(planFile(dir), JSON.stringify(plan, null, 2));
const findTask = (plan, id) => plan.milestones.flatMap((m) => m.tasks).find((t) => t.id === id);
const editPlan = (dir, fn) => { const p = readPlan(dir); fn(p); writePlan(dir, p); };

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

// Each refusal: the proposal input that is refused on a fresh plan.
const refusedOnPropose = [
  ['unknown task', { taskId: 'task-99', notes: 'x' }, /No task task-99/],
  ['archived task', { taskId: 'task-a1', notes: 'x' }, /archived in m1; restore it first/],
  ['completed task', { taskId: 'task-05', notes: 'x' }, /task-05 is completed/],
  ['dropped task', { taskId: 'task-06', notes: 'x' }, /task-06 is dropped/],
  ['in progress, deps', { taskId: 'task-04', addDependencies: ['task-01'] }, /in progress; only its notes/],
  ['dep unknown', { taskId: 'task-01', addDependencies: ['task-99'] }, /depend on task-99: no such task/],
  ['dep self', { taskId: 'task-01', addDependencies: ['task-01'] }, /cannot depend on itself/],
  ['dep present', { taskId: 'task-02', addDependencies: ['task-01'] }, /already depends on task-01/],
  ['dep dropped live', { taskId: 'task-01', addDependencies: ['task-06'] }, /task-06: it was dropped/],
  ['dep dropped archived', { taskId: 'task-01', addDependencies: ['task-a2'] }, /task-a2: it was dropped/],
  ['remove absent', { taskId: 'task-01', removeDependencies: ['task-02'] }, /does not depend on task-02/],
  ['cycle', { taskId: 'task-01', addDependencies: ['task-07'] }, /dependency cycle/],
  ['release not blocked', { taskId: 'task-01', release: true }, /not blocked; it cannot be released/],
  ['drop no reason', { taskId: 'task-07', drop: { reason: ' ' } }, /needs a reason/],
  ['replaced by unknown', { taskId: 'task-07', drop: { reason: 'r', replacedBy: 'task-99' } }, /no such task/],
  ['replaced by self', { taskId: 'task-07', drop: { reason: 'r', replacedBy: 'task-07' } }, /replace itself/],
  ['replaced by dropped', { taskId: 'task-07', drop: { reason: 'r', replacedBy: 'task-06' } }, /was dropped/],
  ['open dependents', { taskId: 'task-02', drop: { reason: 'r' } }, /without a replacement: task-07/],
  ['drop plus other', { taskId: 'task-07', notes: 'n', drop: { reason: 'r' } }, /excludes every other/],
  ['no change', { taskId: 'task-01' }, /at least one change/],
];

// Valid on a fresh plan, refused at approval after the plan changed in between. Self, already
// present, removed-absent and release-not-pending cannot arise this way (or read as already applied).
const refusedOnApprove = [
  ['unknown task', { taskId: 'task-01', notes: 'x' },
    (p) => { p.milestones[1].tasks = p.milestones[1].tasks.filter((t) => t.id !== 'task-01');
      findTask(p, 'task-02').dependencies = []; }, /No task task-01/],
  ['archived task', { taskId: 'task-08', notes: 'x' },
    (p) => { p.milestones[2].tasks = []; p.milestones[2].archived = { ...p.milestones[0].archived,
      taskIds: ['task-08'], droppedTaskIds: [] }; }, /archived in m3/],
  ['completed task', { taskId: 'task-01', notes: 'x' }, (p) => { findTask(p, 'task-01').status = 'completed'; },
    /task-01 is completed/],
  ['dropped task', { taskId: 'task-08', notes: 'x' },
    (p) => Object.assign(findTask(p, 'task-08'), { status: 'dropped', drop: { reason: 'r', changeId: 'z', at: 'a' } }),
    /task-08 is dropped/],
  ['in progress', { taskId: 'task-01', addDependencies: ['task-08'] },
    (p) => { findTask(p, 'task-01').status = 'in_progress'; }, /in progress; only its notes/],
  ['dep unknown', { taskId: 'task-01', addDependencies: ['task-08'] }, (p) => { p.milestones[2].tasks = []; },
    /no such task/],
  ['dep dropped', { taskId: 'task-01', addDependencies: ['task-08'] },
    (p) => Object.assign(findTask(p, 'task-08'), { status: 'dropped', drop: { reason: 'r', changeId: 'z', at: 'a' } }),
    /task-08: it was dropped/],
  ['cycle', { taskId: 'task-01', addDependencies: ['task-08'] },
    (p) => { findTask(p, 'task-08').dependencies = ['task-01']; }, /dependency cycle/],
  ['replaced by unknown', { taskId: 'task-07', drop: { reason: 'r', replacedBy: 'task-08' } },
    (p) => { p.milestones[2].tasks = []; }, /no such task/],
  ['replaced by dropped', { taskId: 'task-07', drop: { reason: 'r', replacedBy: 'task-08' } },
    (p) => Object.assign(findTask(p, 'task-08'), { status: 'dropped', drop: { reason: 'r', changeId: 'z', at: 'a' } }),
    /was dropped/],
  ['open dependents', { taskId: 'task-07', drop: { reason: 'r' } },
    (p) => { findTask(p, 'task-08').dependencies = ['task-07']; }, /without a replacement: task-08/],
];

for (const [name, input, pattern] of refusedOnPropose) {
  await test(`propose refuses: ${name}`, () => {
    const dir = fixture();
    const out = proposePlanChange(dir, { reason: 'why', ...input });
    assert.equal(out.code, 'CHANGE_REFUSED');
    assert.match(out.message, pattern);
    assert.equal(fs.existsSync(planChangesPath(dir)), false);
  });
}

for (const [name, input, mutate, pattern] of refusedOnApprove) {
  await test(`approve refuses after the plan changed: ${name}`, () => {
    const dir = fixture();
    const rec = proposePlanChange(dir, { reason: 'why', ...input });
    assert.equal(typeof rec, 'object', String(rec));
    editPlan(dir, mutate);
    const before = fs.readFileSync(planFile(dir), 'utf8');
    const out = decidePlanChange(dir, rec.id, 'approved', { by: 'Ann' });
    assert.equal(out.code, 'CHANGE_REFUSED');
    assert.match(out.message, pattern);
    assert.equal(fs.readFileSync(planFile(dir), 'utf8'), before);
    assert.equal(loadPlanChanges(dir).changes[0].status, 'proposed');
  });
}

await test('propose stores a cleaned record', () => {
  const dir = fixture();
  const notes = `line one${ch(0x200b)}\nline${ch(7)} two`;
  const rec = proposePlanChange(dir, {
    taskId: ' task-01 ', notes, reason: `because${ch(10)}it${ch(0x202e)} is`, by: 'agent-1', fromTask: 'task-02',
  });
  assert.equal(rec.id, 'pc-01');
  assert.equal(rec.status, 'proposed');
  assert.equal(rec.taskId, 'task-01');
  assert.equal(rec.change.notes, 'line one\nline two');
  assert.equal(rec.reason, 'because it  is');
  assert.equal(rec.proposedBy, 'agent-1');
  assert.equal(rec.fromTask, 'task-02');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'plan_changes.json'), 'utf8'));
  assert.equal(stored.version, '1.0.0');
  assert.deepEqual(stored.changes[0], rec);
  const long = proposePlanChange(dir, { taskId: 'task-02', notes: 'n'.repeat(3000), reason: 'r'.repeat(900) });
  assert.equal(long.change.notes.length, 2000);
  assert.equal(long.reason.length, 500);
});

await test('proposedBy falls back to NATIV_AGENT_ID, then NATIV_ROLE', () => {
  const dir = fixture();
  const saved = [process.env.NATIV_AGENT_ID, process.env.NATIV_ROLE];
  process.env.NATIV_AGENT_ID = 'agent-env';
  process.env.NATIV_ROLE = 'backend';
  try {
    assert.equal(proposePlanChange(dir, { taskId: 'task-01', notes: 'a', reason: 'r' }).proposedBy, 'agent-env');
    delete process.env.NATIV_AGENT_ID;
    assert.equal(proposePlanChange(dir, { taskId: 'task-01', notes: 'b', reason: 'r' }).proposedBy, 'backend');
  } finally {
    for (const [k, v] of [['NATIV_AGENT_ID', saved[0]], ['NATIV_ROLE', saved[1]]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

await test('duplicates, the pending cap, malformed records and an unreadable file', () => {
  const dir = fixture();
  const file = planChangesPath(dir);
  fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', changes: [{ id: 'pc-07', junk: true }] }));
  const rec = proposePlanChange(dir, { taskId: 'task-01', notes: 'n', reason: 'r' });
  assert.equal(rec.id, 'pc-08');
  const dup = proposePlanChange(dir, { taskId: 'task-01', notes: 'n', reason: 'other' });
  assert.equal(dup.code, 'CHANGE_REFUSED');
  assert.match(dup.message, /pc-08 already proposes/);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(raw.changes[0], { id: 'pc-07', junk: true });
  assert.deepEqual(listPlanChanges(dir).map((c) => c.id), ['pc-08']);
  for (let i = 1; i < 50; i++) proposePlanChange(dir, { taskId: 'task-01', notes: `n${i}`, reason: 'r' });
  assert.equal(listPlanChanges(dir, { status: 'proposed' }).length, 50);
  const full = proposePlanChange(dir, { taskId: 'task-01', notes: 'more', reason: 'r' });
  assert.equal(full.code, 'CHANGE_REFUSED');
  assert.match(full.message, /50 plan changes/);
  fs.writeFileSync(file, '{ not json');
  const unread = proposePlanChange(dir, { taskId: 'task-01', notes: 'z', reason: 'r' });
  assert.equal(unread.code, 'PLAN_CHANGES_UNREADABLE');
  assert.match(unread.message, /cannot be read/);
  const unreadDecide = decidePlanChange(dir, 'pc-08', 'rejected');
  assert.equal(unreadDecide.code, 'PLAN_CHANGES_UNREADABLE');
  assert.match(unreadDecide.message, /cannot be read/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.equal(loadPlanChanges(dir).unreadable, true);
});

await test('seen must match, reject touches only the record, decided records stay decided', () => {
  const dir = fixture();
  const rec = proposePlanChange(dir, { taskId: 'task-01', addDependencies: ['task-08'], reason: 'r' });
  const before = fs.readFileSync(planFile(dir), 'utf8');
  const edited = decidePlanChange(dir, rec.id, 'approved', { seen: '["x"]' });
  assert.equal(edited.code, 'CHANGE_EDITED');
  assert.match(edited.message, /edited while you were reviewing/);
  const opts = { seen: changeContent(rec), note: 'no', by: 'Ann', via: 'cli' };
  const out = decidePlanChange(dir, rec.id, 'rejected', opts);
  assert.equal(out.status, 'rejected');
  assert.equal(out.decidedBy, 'Ann');
  assert.equal(out.decidedVia, 'cli');
  assert.equal(out.decisionNote, 'no');
  assert.equal(fs.readFileSync(planFile(dir), 'utf8'), before);
  const again = decidePlanChange(dir, rec.id, 'approved');
  assert.equal(again.code, 'CHANGE_ALREADY_DECIDED');
  assert.match(again.message, /already rejected/);
  const missing = decidePlanChange(dir, 'pc-99', 'approved');
  assert.equal(missing.code, 'CHANGE_NOT_FOUND');
  assert.match(missing.message, /No plan change pc-99/);
});

await test('an unreadable plan is its own refusal, on propose and on approve', () => {
  const dir = fixture();
  const rec = proposePlanChange(dir, { taskId: 'task-01', notes: 'n', reason: 'r' });
  fs.writeFileSync(planFile(dir), '{ not json');
  const onApprove = decidePlanChange(dir, rec.id, 'approved', { by: 'Ann' });
  assert.equal(onApprove.code, 'PLAN_UNREADABLE');
  assert.match(onApprove.message, /plan .*cannot be read/);
  const onPropose = proposePlanChange(dir, { taskId: 'task-01', notes: 'm', reason: 'r' });
  assert.equal(onPropose.code, 'PLAN_UNREADABLE');
  assert.equal(listPlanChanges(dir, { status: 'proposed' }).length, 1);
});

await test('approve applies dependency and notes changes in order', () => {
  const dir = fixture();
  const rec = proposePlanChange(dir, {
    taskId: 'task-07', addDependencies: ['task-08', 'task-01', 'task-08'], removeDependencies: ['task-02'],
    notes: 'new notes', reason: 'r',
  });
  const out = decidePlanChange(dir, rec.id, 'approved', { by: 'Ann', via: 'studio' });
  assert.equal(out.status, 'approved');
  assert.equal(out.decidedVia, 'studio');
  const t = findTask(readPlan(dir), 'task-07');
  assert.deepEqual(t.dependencies, ['task-08', 'task-01']);
  assert.equal(t.notes, 'new notes');
});

await test('release clears the claim and resets the circuit breaker', () => {
  const dir = fixture();
  const ledger = path.join(dir, '.ai', '.governor_ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ 'task-03': { consecutiveFailures: 3, patchCount: 1 } }));
  const rec = proposePlanChange(dir, { taskId: 'task-03', release: true, reason: 'r' });
  assert.equal(decidePlanChange(dir, rec.id, 'approved', { by: 'Ann' }).status, 'approved');
  const t = findTask(readPlan(dir), 'task-03');
  assert.equal(t.status, 'pending');
  assert.equal(t.notes, `Released by plan change ${rec.id}`);
  assert.equal(t.claimedBy, undefined);
  assert.equal(t.claimedAt, undefined);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8'))['task-03'].consecutiveFailures, 0);
});

await test('drop rewires open dependents, closes escalations and settles the milestone', () => {
  const plan = basePlan();
  plan.milestones[1].tasks = [
    task('task-01', { status: 'completed' }),
    task('task-02', { status: 'blocked', dependencies: ['task-01'] }),
  ];
  plan.milestones[2].tasks.push(task('task-09', { dependencies: ['task-02', 'task-01'] }));
  const dir = fixture(plan);
  const esc = path.join(dir, '.ai', 'escalation.json');
  fs.writeFileSync(esc, JSON.stringify({ version: '1.0.0', escalations: [
    { id: 'esc-01', taskId: 'task-02', status: 'pending_review' },
    { id: 'esc-02', taskId: 'task-08', status: 'pending_review' },
  ] }));
  const drop = { reason: 'obsolete', replacedBy: 'task-01' };
  const rec = proposePlanChange(dir, { taskId: 'task-02', drop, reason: 'r' });
  const out = decidePlanChange(dir, rec.id, 'approved', { by: 'Ann' });
  assert.deepEqual(out.effects, { rewired: [{ taskId: 'task-09', from: 'task-02', to: 'task-01' }] });
  const after = readPlan(dir);
  const t = findTask(after, 'task-02');
  assert.equal(t.status, 'dropped');
  assert.equal(t.drop.reason, 'obsolete');
  assert.equal(t.drop.replacedBy, 'task-01');
  assert.equal(t.drop.changeId, rec.id);
  assert.deepEqual(findTask(after, 'task-09').dependencies, ['task-01']);
  assert.equal(after.milestones[1].status, 'completed');
  assert.equal(after.activeMilestoneId, 'm3');
  const escs = JSON.parse(fs.readFileSync(esc, 'utf8')).escalations;
  assert.equal(escs[0].status, 'resolved');
  assert.equal(escs[0].resolutionNotes, `Closed: task dropped by ${rec.id}`);
  assert.equal(escs[1].status, 'pending_review');
});

await test('a re-run after a crash between the two writes only marks the record', () => {
  const dir = fixture();
  const deps = proposePlanChange(dir, { taskId: 'task-01', addDependencies: ['task-08'], reason: 'r' });
  const drop = proposePlanChange(dir, { taskId: 'task-07', drop: { reason: 'old' }, reason: 'r' });
  editPlan(dir, (p) => {
    findTask(p, 'task-01').dependencies = ['task-08'];
    Object.assign(findTask(p, 'task-07'), { status: 'dropped', drop: { reason: 'old', changeId: drop.id, at: 'a' } });
  });
  const before = fs.readFileSync(planFile(dir), 'utf8');
  assert.equal(decidePlanChange(dir, deps.id, 'approved', { by: 'Ann' }).status, 'approved');
  assert.equal(decidePlanChange(dir, drop.id, 'approved', { by: 'Ann' }).status, 'approved');
  assert.equal(fs.readFileSync(planFile(dir), 'utf8'), before);
});

function approveInChild(dir, id) {
  const mod = pathToFileURL(path.join(repoRoot, 'dist', 'core', 'plan-changes.js')).href;
  const code = `import(${JSON.stringify(mod)}).then((m) => { const r = m.decidePlanChange(process.argv[1],`
    + ` process.argv[2], 'approved', { by: 'Ann' }); process.stdout.write(JSON.stringify(r)); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, dir, id], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${status}`))));
  });
}

await test('two parallel approvals of one change apply it once', async () => {
  const dir = fixture();
  const rec = proposePlanChange(dir, { taskId: 'task-01', addDependencies: ['task-08'], notes: 'n', reason: 'r' });
  const results = await Promise.all([approveInChild(dir, rec.id), approveInChild(dir, rec.id)]);
  const won = results.filter((r) => !r.code);
  const refused = results.filter((r) => r.code);
  assert.equal(won.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, 'CHANGE_ALREADY_DECIDED');
  assert.match(refused[0].message, /already approved/);
  assert.deepEqual(findTask(readPlan(dir), 'task-01').dependencies, ['task-08']);
  assert.equal(listPlanChanges(dir, { status: 'approved' }).length, 1);
});

for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
console.log(`plan changes: ${passed} tests passed`);
