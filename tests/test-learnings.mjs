// Learnings (propose, human approval, scoped delivery) and configured verify phases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { proposeLearning, decideLearning, learningsForTask, loadLearnings, MAX_TASK_LEARNINGS } from '../dist/core/learnings.js';
import { runTaskVerification, verifyTask } from '../dist/core/verifier.js';
import { buildDesiredConfig } from '../dist/core/setup-assets.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'bin', 'cli.js');

function fixture(task = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-learn-'));
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const t = {
    id: 'task-01', title: 'Form', description: '', assignedSubagent: 'frontend', dependencies: [],
    targetFiles: ['src/components/forms/DateField.tsx'], status: 'in_progress',
    verificationCommand: 'node -e "process.exit(0)"', notes: '', ...task,
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify({
    version: '1.0.0', projectName: 'learn', lastUpdated: '', overallStatus: 'in_progress', activeMilestoneId: 'm1',
    milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks: [t] }],
  }));
  return { dir, task: t };
}

const writeConfig = (dir, config) => {
  fs.mkdirSync(path.join(dir, '.nativ'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.nativ', 'config.json'), JSON.stringify(config));
};

// Proposed lessons wait for approval; ids are sequential.
{
  const { dir, task } = fixture();
  const a = proposeLearning(dir, { insight: 'Set the date picker locale before mount', role: 'frontend' });
  assert.equal(a.id, 'learn-01');
  assert.equal(a.status, 'proposed');
  assert.deepEqual(learningsForTask(dir, task), [], 'a proposed lesson is not delivered');
  assert.equal(typeof decideLearning(dir, 'learn-99', 'approved'), 'string', 'unknown id is an error');
  const approved = decideLearning(dir, a.id, 'approved', 'confirmed');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.decisionNote, 'confirmed');
  assert.deepEqual(learningsForTask(dir, task).map((l) => l.id), ['learn-01']);
  decideLearning(dir, a.id, 'rejected');
  assert.deepEqual(learningsForTask(dir, task), [], 'a rejected lesson is withdrawn');
  assert.throws(() => proposeLearning(dir, { insight: '   ' }), /insight/);
  console.log('✔ Proposed lessons wait for approval');
}

// Role and file scope, ordering and the cap.
{
  const { dir, task } = fixture();
  const add = (insight, scope) => decideLearning(dir, proposeLearning(dir, { insight, ...scope }).id, 'approved');
  add('general');
  add('backend only', { role: 'backend' });
  add('frontend role', { role: 'frontend' });
  add('forms files', { files: ['src/components/forms/'] });
  add('api files', { files: ['src/api/**'] });
  add('frontend forms glob', { role: 'frontend', files: ['src/components/**/*.tsx'] });
  let got = learningsForTask(dir, task).map((l) => l.insight);
  assert.deepEqual(got, ['frontend forms glob', 'forms files', 'frontend role', 'general'], 'most specific first, out-of-scope dropped');
  for (let i = 0; i < 4; i++) add(`extra ${i}`);
  got = learningsForTask(dir, task);
  assert.equal(got.length, MAX_TASK_LEARNINGS, 'capped');
  assert.equal(got[0].insight, 'frontend forms glob');
  console.log('✔ Lessons are scoped by role and files, most specific first, capped');
}

// Concurrent proposals from separate processes all land.
{
  const { dir } = fixture();
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    execFileAsync(process.execPath, [cli, 'learn', 'propose', `lesson ${i}`, dir, '--json'])));
  const ids = loadLearnings(dir).learnings.map((l) => l.id).sort();
  assert.equal(ids.length, 6, 'no lost writes');
  assert.equal(new Set(ids).size, 6, 'no duplicate ids');
  console.log('✔ Parallel proposals keep every lesson with a unique id');
}

// task next carries approved lessons without audit fields; the CLI approves.
{
  const { dir } = fixture();
  await execFileAsync(process.execPath, [cli, 'learn', 'propose', 'Use the shared form hook', dir, '--role', 'frontend', '--files', 'src/components/']);
  let next = JSON.parse((await execFileAsync(process.execPath, [cli, 'task', 'next', dir, '--json'])).stdout).task;
  assert.equal(next.learnings, undefined);
  await execFileAsync(process.execPath, [cli, 'learn', 'approve', 'learn-01', dir]);
  next = JSON.parse((await execFileAsync(process.execPath, [cli, 'task', 'next', dir, '--json'])).stdout).task;
  assert.deepEqual(next.learnings, [{ id: 'learn-01', insight: 'Use the shared form hook', files: ['src/components/'] }]);
  console.log('✔ task next --json carries approved lessons');
}

// Agents cannot approve: setup denies the approve and reject commands.
{
  const deny = buildDesiredConfig({ command: 'nativ', prefixArgs: [] }).deny;
  assert.ok(deny.includes('Bash(nativ learn approve *)'));
  assert.ok(deny.includes('Bash(nativ learn reject *)'));
  console.log('✔ Setup denies learn approve and reject to agents');
}

// Configured phases run before the task command and stop at the first failure.
{
  const { dir, task } = fixture();
  let r = await runTaskVerification(task, { cwd: dir });
  assert.equal(r.success, true);
  assert.equal(r.phases, undefined, 'no config, no phases');

  writeConfig(dir, { verifyPhases: [
    { name: 'types', run: 'node -e "process.exit(0)"' },
    { name: 'lint', run: 'node -e "process.exit(3)"' },
    { name: 'never', run: 'node -e "process.exit(0)"' },
  ] });
  r = await runTaskVerification(task, { cwd: dir });
  assert.equal(r.success, false);
  assert.deepEqual(r.phases.map((p) => [p.name, p.success]), [['types', true], ['lint', false]]);
  assert.match(r.error, /Phase "lint" failed/);

  const out = await execFileAsync(process.execPath, [cli, 'task', 'complete', 'task-01', dir]).catch((e) => e);
  assert.notEqual(out.code ?? 0, 0, 'the gatekeeper refuses');
  assert.match(String(out.stderr), /Phase:\s+lint/);

  writeConfig(dir, { verifyPhases: [{ name: 'types', run: 'node -e "process.exit(0)"' }, { name: 'bad' }] });
  const v = await verifyTask('task-01', dir);
  assert.equal(v.result.success, true);
  assert.deepEqual(v.result.phases.map((p) => p.name), ['types'], 'entries without a command are ignored');

  const none = await runTaskVerification({ ...task, verificationCommand: 'none' }, { cwd: dir });
  assert.equal(none.skipped, false, 'phases ran, so it is not a skip');
  console.log('✔ verifyPhases run first, stop at the first failure and block task complete');
}

console.log('test-learnings: ok');
