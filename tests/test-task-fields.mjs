import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting Optional Task Fields Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const { validateMasterPlanTask } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'scanner', 'types.js')).href);
const execFileAsync = promisify(execFile);
const tempDirs = [];

function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-fields-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const old = { id: 'task-01', title: 'Old', description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [], status: 'pending', verificationCommand: '', notes: '' };
  const plan = {
    version: '1.0.0', projectName: 'fields', lastUpdated: new Date().toISOString(), overallStatus: 'in_progress',
    activeMilestoneId: 'm1', milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks: [old] }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

const planFile = (dir) => path.join(dir, '.ai', 'master_plan.json');
const readPlan = (dir) => JSON.parse(fs.readFileSync(planFile(dir), 'utf8'));

async function add(dir, title, flags = []) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'task', 'add', title, dir, '--json', ...flags], { timeout: 60000 });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.code ?? 1, json: JSON.parse(String(err.stdout || '{}')) };
  }
}

try {
  const base = {
    id: 't', title: 'T', description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [], status: 'pending', verificationCommand: '',
  };
  assert.deepEqual(validateMasterPlanTask(base), [], 'fields are never required');
  assert.deepEqual(validateMasterPlanTask({ ...base, specRefs: ['a.md#b'], complexity: 'complex', acceptanceCriteria: ['x'] }), []);
  assert.ok(validateMasterPlanTask({ ...base, complexity: 'huge' }).length, 'unknown complexity rejected');
  assert.ok(validateMasterPlanTask({ ...base, specRefs: 'a' }).length, 'specRefs must be an array');
  assert.ok(validateMasterPlanTask({ ...base, acceptanceCriteria: [1] }).length, 'acceptanceCriteria must be strings');
  console.log('  ok validator');

  const dir = createProject();
  const before = fs.readFileSync(planFile(dir), 'utf8');
  const plain = await add(dir, 'Plain task');
  assert.equal(plain.code, 0);
  for (const key of ['specRefs', 'complexity', 'acceptanceCriteria']) {
    assert.ok(!(key in plain.json.task), `no empty ${key} written`);
  }
  assert.equal(JSON.stringify(readPlan(dir).milestones[0].tasks[0]), JSON.stringify(JSON.parse(before).milestones[0].tasks[0]), 'old task unchanged');
  console.log('  ok add without fields');

  const rich = await add(dir, 'Rich task', [
    '--spec-refs', 'ui_specs.md#appointment-list, api_contracts.json#/paths/~1appointments',
    '--complexity', 'complex',
    '--accept', 'Shows an empty state',
    '--accept', 'Errors are readable',
    '--accept', 'Works offline',
    '--accept', 'Status is open|closed',
  ]);
  assert.equal(rich.code, 0);
  const saved = readPlan(dir).milestones[0].tasks.find((t) => t.id === rich.json.task.id);
  assert.deepEqual(saved.specRefs, ['ui_specs.md#appointment-list', 'api_contracts.json#/paths/~1appointments']);
  assert.equal(saved.complexity, 'complex');
  assert.deepEqual(saved.acceptanceCriteria, [
    'Shows an empty state', 'Errors are readable', 'Works offline', 'Status is open|closed',
  ]);
  console.log('  ok add with fields');

  const planBefore = fs.readFileSync(planFile(dir), 'utf8');
  const bad = await add(dir, 'Bad', ['--complexity', 'gigantic']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, 'INVALID_TASK');
  assert.equal(fs.readFileSync(planFile(dir), 'utf8'), planBefore, 'rejected add does not write');
  console.log('  ok bad complexity rejected');
  assert.deepEqual(validateMasterPlanTask({ ...base, verificationKind: 'docs' }), []);
  assert.ok(validateMasterPlanTask({ ...base, verificationKind: 'vibes' }).length, 'unknown kind rejected');
  const kd = await add(dir, 'Docs', ['--kind', 'docs', '--files', 'docs/a.md,src/x.ts']);
  assert.equal(kd.code, 0);
  assert.equal(kd.json.task.verificationKind, 'docs');
  assert.match(kd.json.task.verificationCommand, /check docs docs\/a\.md$/);
  const km = await add(dir, 'Manual', ['--kind', 'manual']);
  assert.equal(km.code, 1);
  const kn = await add(dir, 'Manual ok', ['--kind', 'manual', '--notes', 'Owner confirms']);
  assert.equal(kn.json.task.notes, 'Owner confirms');
  const kb = await add(dir, 'Bad kind', ['--kind', 'nope']);
  assert.equal(kb.code, 1);
  console.log('  ok verification kind');
  const nm = createProject();
  const open = await add(nm, 'Next', ['--new-milestone', 'Second']);
  assert.equal(open.code, 1);
  assert.equal(open.json.error.code, 'MILESTONE_STILL_OPEN');
  const conflict = await add(nm, 'Next', ['--new-milestone', 'Second', '--fast-path']);
  assert.equal(conflict.json.error.code, 'CONFLICTING_OPTIONS');
  const conflict2 = await add(nm, 'Next', ['--new-milestone', 'Second', '--milestone', 'm1']);
  assert.equal(conflict2.json.error.code, 'CONFLICTING_OPTIONS');
  const p0 = readPlan(nm);
  p0.milestones[0].status = 'completed';
  p0.milestones.push({ id: 'm16b', name: 'Follow', status: 'completed', tasks: [] });
  p0.milestones.push({ id: 'm5', name: 'Five', status: 'completed', tasks: [] });
  p0.overallStatus = 'completed';
  fs.writeFileSync(planFile(nm), JSON.stringify(p0, null, 2));
  const made = await add(nm, 'Next', ['--new-milestone', 'Second', '--accept', 'A, B']);
  assert.equal(made.code, 0);
  assert.equal(made.json.milestoneId, 'm6');
  assert.equal(made.json.createdMilestone, true);
  assert.deepEqual(made.json.task.acceptanceCriteria, ['A, B']);
  const p1 = readPlan(nm);
  assert.equal(p1.activeMilestoneId, 'm6');
  assert.equal(p1.overallStatus, 'in_progress');
  const m6 = p1.milestones.find((m) => m.id === 'm6');
  assert.equal(m6.status, 'in_progress');
  assert.equal(m6.tasks.length, 1);
  const refused = await add(nm, 'Again', ['--new-milestone', 'Third']);
  assert.equal(refused.json.error.code, 'MILESTONE_STILL_OPEN');
  const f2 = await add(nm, 'Forced', ['--new-milestone', 'Third', '--force']);
  assert.equal(f2.json.milestoneId, 'm7');
  assert.equal(readPlan(nm).activeMilestoneId, 'm7');
  console.log('  ok new milestone');
  console.log('\nAll task field checks passed.');
} finally {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
}
