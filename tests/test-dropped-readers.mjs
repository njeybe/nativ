import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskList, runTaskNext } from '../dist/commands/task/task-query.js';
import { runTaskShow } from '../dist/commands/task/task-show.js';
import { runStatus } from '../dist/commands/status.js';

const mk = (id, status, extra = {}) => ({
  id, title: `T ${id}`, description: '', assignedSubagent: 'backend', dependencies: [],
  targetFiles: [], status, verificationCommand: 'true', notes: '', ...extra,
});
const drop = { reason: 'not needed', replacedBy: 'task-3', changeId: 'chg-1', at: '2026-01-01T00:00:00Z' };
const plan = {
  version: '1.0.0', projectName: 'dropped', lastUpdated: '2026-01-01T00:00:00Z',
  overallStatus: 'in_progress', activeMilestoneId: 'm2',
  milestones: [
    { id: 'm1', name: 'Old', status: 'completed', tasks: [], archived: {
      file: '.ai/archive/m1.json', taskIds: ['a1', 'a2', 'a3'], taskCount: 3,
      droppedTaskIds: ['a3'], summary: 'old',
    } },
    { id: 'm2', name: 'Two', status: 'in_progress', tasks: [
      mk('task-1', 'completed'), mk('task-2', 'dropped', { drop }),
      mk('task-3', 'pending', { dependencies: ['task-2'] }), mk('task-4', 'pending'),
    ] },
  ],
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-dropped-readers-'));
fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify(plan));

async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
}

// list: badge, filter, summary count
const text = await capture(() => runTaskList(root, {}));
assert.match(text, /dropped task-2/);
assert.match(text, /1 dropped/);
const only = JSON.parse(await capture(() => runTaskList(root, { status: 'dropped', json: true, brief: true })));
assert.deepEqual(only.map((t) => t.id), ['task-2']);
assert.deepEqual(only[0].drop, drop);
const avail = JSON.parse(await capture(() => runTaskList(root, { available: true, json: true })));
assert.deepEqual(avail.map((t) => t.id), ['task-4']);

// next never picks a dropped task or one depending on it
const next = JSON.parse(await capture(() => runTaskNext(root, { json: true })));
assert.equal(next.task.id, 'task-4');

// show prints reason, replacement and change id
const shown = await capture(() => runTaskShow('task-2', root, {}));
assert.match(shown, /not needed/);
assert.match(shown, /task-3/);
assert.match(shown, /chg-1/);

// status: dropped count, totals exclude dropped, live and archived
const st = await capture(() => runStatus(root, {}));
assert.match(st, /1 dropped/);
assert.match(st, /Completion: 3\/5 tasks/);
const sj = JSON.parse(await capture(() => runStatus(root, { json: true })));
const m1 = sj.milestones.find((m) => m.id === 'm1');
assert.equal(m1.taskCount, 2);
assert.equal(m1.completedCount, 2);
console.log('dropped readers ok');
