import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStatus } from '../dist/commands/status.js';
import { runTaskList } from '../dist/commands/task/task-query.js';

const LIMIT = 20000;
const LIST_LIMIT = 60000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-size-'));
fs.mkdirSync(path.join(dir, '.ai'));

function task(m, i, status) {
  return {
    id: `task-${m}-${i}`, title: `Task ${i} of milestone ${m}`, assignedSubagent: 'backend',
    dependencies: [], targetFiles: ['src/a.ts', 'src/b.ts'], status,
    description: 'x'.repeat(1500), verificationCommand: 'npm test', notes: 'n'.repeat(200),
    acceptanceCriteria: ['a'.repeat(200), 'b'.repeat(200)],
  };
}
const milestones = Array.from({ length: 20 }, (_, m) => ({
  id: `m${m}`, name: `Milestone ${m}`, status: m < 19 ? 'completed' : 'in_progress',
  tasks: Array.from({ length: 15 }, (_, i) => task(m, i, m < 19 ? 'completed' : 'pending')),
}));
fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify({
  projectName: 'size-fixture', overallStatus: 'in_progress', activeMilestoneId: 'm19', milestones,
}));

async function capture(fn) {
  let out = '';
  const orig = console.log;
  console.log = (m) => { out += m + '\n'; };
  try { await fn(); } finally { console.log = orig; }
  return out;
}

try {
  const fullList = await capture(() => runTaskList(dir, { json: true }));
  const briefList = await capture(() => runTaskList(dir, { json: true, brief: true }));
  const fullStatus = await capture(() => runStatus(dir, { json: true, full: true }));
  const status = await capture(() => runStatus(dir, { json: true }));
  assert.ok(fullList.length > LIST_LIMIT * 3, 'fixture should be large');
  assert.ok(briefList.length < LIST_LIMIT, `task list ${briefList.length} over ${LIST_LIMIT}`);
  assert.ok(status.length < LIST_LIMIT, `status ${status.length} over ${LIST_LIMIT}`);
  assert.ok(fullStatus.length > status.length * 3);
  const parsed = JSON.parse(status);
  assert.equal(parsed.milestones[0].taskCount, 15);
  assert.equal(parsed.milestones[0].completedCount, 15);
  assert.equal(parsed.milestones[0].tasks, undefined);
  assert.equal(parsed.milestones[19].tasks.length, 15);
  assert.equal(parsed.tasksTelemetry, undefined);
  console.log('✔ read output size: default task list and status JSON stay small');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
