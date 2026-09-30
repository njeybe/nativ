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
    '--accept', 'Errors are readable|Works offline',
  ]);
  assert.equal(rich.code, 0);
  const saved = readPlan(dir).milestones[0].tasks.find((t) => t.id === rich.json.task.id);
  assert.deepEqual(saved.specRefs, ['ui_specs.md#appointment-list', 'api_contracts.json#/paths/~1appointments']);
  assert.equal(saved.complexity, 'complex');
  assert.deepEqual(saved.acceptanceCriteria, ['Shows an empty state', 'Errors are readable', 'Works offline']);
  console.log('  ok add with fields');

  const planBefore = fs.readFileSync(planFile(dir), 'utf8');
  const bad = await add(dir, 'Bad', ['--complexity', 'gigantic']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.error.code, 'INVALID_TASK');
  assert.equal(fs.readFileSync(planFile(dir), 'utf8'), planBefore, 'rejected add does not write');
  console.log('  ok bad complexity rejected');
  console.log('\nAll task field checks passed.');
} finally {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
}
