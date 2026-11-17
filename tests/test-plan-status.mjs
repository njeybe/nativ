import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateMasterPlanTask, TASK_STATUSES } from '../dist/scanner/types.js';
import {
  isSettled, doneTaskIds, countedTasks, settleMilestone,
} from '../dist/core/plan-status.js';
import { archiveMilestones, withArchivedAsDone, archivedTaskIds } from '../dist/core/milestone-archive.js';

const task = (id, status, extra = {}) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies: [],
  targetFiles: [], status, verificationCommand: 'true', ...extra,
});
const drop = { reason: 'replaced', changeId: 'c1', at: '2026-01-01T00:00:00Z' };

// Validation
assert.ok(TASK_STATUSES.includes('dropped'));
assert.deepEqual(validateMasterPlanTask(task('a', 'dropped', { drop })), []);
assert.ok(validateMasterPlanTask(task('a', 'dropped')).some((e) => e.includes('drop.reason')));
assert.ok(validateMasterPlanTask(task('a', 'dropped', { drop: { ...drop, reason: ' ' } })).length);
assert.ok(validateMasterPlanTask(task('a', 'pending', { drop })).some((e) => e.includes('"drop"')));

// Helpers
assert.equal(isSettled(task('a', 'completed')), true);
assert.equal(isSettled(task('a', 'dropped')), true);
assert.equal(isSettled(task('a', 'blocked')), false);
assert.deepEqual(countedTasks([task('a', 'completed'), task('b', 'dropped')]).map((t) => t.id), ['a']);

const archivedMs = {
  id: 'm0', name: 'old', status: 'completed', tasks: [],
  archived: { summary: 's', commit: null, check: 'c', archivedAt: 'x', taskCount: 3,
    taskIds: ['o1', 'o2', 'o3'], droppedTaskIds: ['o3'], file: 'f' },
};
const plan = {
  projectName: 'p', overallStatus: 'in_progress', activeMilestoneId: 'm1',
  milestones: [
    archivedMs,
    { id: 'm1', name: 'one', status: 'in_progress', tasks: [task('a', 'completed'), task('b', 'dropped', { drop })] },
    { id: 'm2', name: 'two', status: 'pending', tasks: [task('c', 'pending')] },
  ],
};
assert.deepEqual([...doneTaskIds(plan)].sort(), ['a', 'o1', 'o2']);
assert.deepEqual(archivedTaskIds(plan), ['o1', 'o2', 'o3']);
const seen = withArchivedAsDone(plan).milestones.flatMap((m) => m.tasks.map((t) => t.id));
assert.ok(seen.includes('o1') && !seen.includes('o3'));

const r = settleMilestone(plan, plan.milestones[1]);
assert.equal(plan.milestones[1].status, 'completed');
assert.equal(r.next.id, 'm2');
assert.equal(plan.activeMilestoneId, 'm2');
assert.equal(plan.overallStatus, 'in_progress');
settleMilestone(plan, plan.milestones[2]);
assert.equal(plan.overallStatus, 'completed');

// Archiving a milestone of completed and dropped tasks
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-plan-status-'));
try {
  fs.mkdirSync(path.join(dir, '.ai'));
  const live = {
    projectName: 'p', overallStatus: 'in_progress', activeMilestoneId: 'm1',
    milestones: [{ id: 'm1', name: 'one', status: 'completed',
      tasks: [task('a', 'completed'), task('b', 'dropped', { drop })] }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(live));
  await archiveMilestones(dir, { ids: ['m1'], summaries: { m1: 'done' }, check: 'node -e "0"' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));
  const info = saved.milestones[0].archived;
  assert.deepEqual(info.taskIds, ['a', 'b']);
  assert.deepEqual(info.droppedTaskIds, ['b']);
  assert.equal(info.taskCount, 2);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('plan-status: ok');
