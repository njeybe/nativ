// `nativ milestone archive` and `restore`, run against temporary fixture projects.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'cli.js');
const coreFile = path.join(repo, 'dist', 'core', 'milestone-archive.js');
const core = await import(pathToFileURL(coreFile).href);
const tmpBase = fs.realpathSync(os.tmpdir());
// The temp folder may sit inside a larger repo; a fixture must only see its own.
process.env.GIT_CEILING_DIRECTORIES = tmpBase;
const made = [];

const task = (id, status = 'completed', dependencies = []) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies,
  targetFiles: [], status, verificationCommand: 'none', notes: '',
});

function basePlan() {
  return {
    version: '1.0.0', projectName: 'fixture', overallStatus: 'in_progress',
    activeMilestoneId: 'm3', lastUpdated: '2026-01-01T00:00:00.000Z',
    milestones: [
      { id: 'm1', name: 'One', status: 'completed', tasks: [task('task-01'), task('task-02')] },
      { id: 'm2', name: 'Two', status: 'completed', tasks: [task('task-09')] },
      { id: 'm3', name: 'Three', status: 'in_progress', tasks: [task('task-03', 'pending')] },
    ],
  };
}

function git(dir, ...args) {
  const all = ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args];
  const res = spawnSync('git', all, { cwd: dir, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
}

function fixture({ plan = basePlan(), repo: useGit = true, config } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'nativ-archive-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'));
  fs.writeFileSync(planFile(dir), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ai/\nruns.log\n.nativ/\n');
  const countRun = "require('fs').appendFileSync('runs.log','x')";
  fs.writeFileSync(path.join(dir, 'pass.cjs'), `${countRun}\n`);
  fs.writeFileSync(path.join(dir, 'fail.cjs'), `${countRun}\nprocess.exit(3)\n`);
  fs.writeFileSync(path.join(dir, 'dirties.cjs'), "require('fs').appendFileSync('pass.cjs','//')\n");
  fs.writeFileSync(path.join(dir, 'slow.cjs'), 'setTimeout(() => {}, 30000)\n');
  if (config) {
    fs.mkdirSync(path.join(dir, '.nativ'));
    fs.writeFileSync(path.join(dir, '.nativ', 'config.json'), JSON.stringify(config));
  }
  if (useGit) {
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
  }
  return dir;
}

function planFile(dir) {
  return path.join(dir, '.ai', 'master_plan.json');
}
const archiveDir = (dir) => path.join(dir, '.ai', 'archive');
const planText = (dir) => fs.readFileSync(planFile(dir), 'utf8');
const readPlan = (dir) => JSON.parse(planText(dir));
const withoutTime = ({ lastUpdated, ...rest }) => rest;

function runs(dir) {
  const log = path.join(dir, 'runs.log');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
}

function nativ(dir, ...args) {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}
const archive = (dir, ...rest) => nativ(dir, 'milestone', 'archive', ...rest);
const restore = (dir, id) => nativ(dir, 'milestone', 'restore', id);
const GOOD = ['--summary', 'done', '--check', 'node pass.cjs'];

/** The command refuses, naming the reason, with plan and archive folder as they were. */
function assertRefused(dir, args, reason) {
  const before = planText(dir);
  const res = archive(dir, ...args);
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, reason);
  assert.equal(planText(dir), before);
  assert.equal(fs.existsSync(archiveDir(dir)), false);
}

function summariesFile(dir, content) {
  const file = path.join(dir, 'summaries.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

const tests = {
  'archive leaves a stub and restore returns an equal plan'() {
    const dir = fixture();
    const original = readPlan(dir);
    const res = archive(dir, 'm1', ...GOOD);
    assert.equal(res.code, 0, res.out);
    const stub = readPlan(dir).milestones[0];
    assert.deepEqual(stub.tasks, []);
    assert.equal(stub.archived.summary, 'done');
    assert.equal(stub.archived.check, 'node pass.cjs');
    assert.equal(stub.archived.taskCount, 2);
    assert.deepEqual(stub.archived.taskIds, ['task-01', 'task-02']);
    assert.equal(stub.archived.file, '.ai/archive/m1.json');
    assert.match(stub.archived.commit, /^[0-9a-f]{40}$/);
    const saved = JSON.parse(fs.readFileSync(path.join(archiveDir(dir), 'm1.json'), 'utf8'));
    assert.deepEqual(saved, original.milestones[0]);

    const back = restore(dir, 'm1');
    assert.equal(back.code, 0, back.out);
    assert.deepEqual(withoutTime(readPlan(dir)), withoutTime(original));
    assert.equal(fs.existsSync(path.join(archiveDir(dir), 'm1.json')), false);
  },

  'refuses unfinished tasks'() {
    assertRefused(fixture(), ['m3', ...GOOD], /unfinished tasks: task-03/);
  },

  'refuses a milestone that does not exist, or an unsafe id'() {
    const dir = fixture();
    assertRefused(dir, ['m99', ...GOOD], /not found/);
    assertRefused(dir, ['../evil', ...GOOD], /not a valid milestone id/);
  },

  'refuses an open escalation, but not a settled one'() {
    const dir = fixture();
    const write = (status) => fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify({
      escalations: [{ id: 'esc-1', taskId: 'task-01', status }],
    }));
    write('pending_review');
    assertRefused(dir, ['m1', ...GOOD], /open escalations: esc-1/);
    write('resolved');
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
  },

  'refuses a milestone already archived, leaving its file'() {
    const dir = fixture();
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    const before = planText(dir);
    const res = archive(dir, 'm1', ...GOOD);
    assert.equal(res.code, 1);
    assert.match(res.out, /already archived/);
    assert.equal(planText(dir), before);
    assert.ok(fs.existsSync(path.join(archiveDir(dir), 'm1.json')));
  },

  'refuses uncommitted tracked changes without running the suite'() {
    const dir = fixture();
    fs.appendFileSync(path.join(dir, 'pass.cjs'), '// edit\n');
    assertRefused(dir, ['m1', ...GOOD], /uncommitted changes: pass\.cjs/);
    assert.equal(runs(dir), 0);
  },

  'refuses when the suite fails, and does not save the failing command'() {
    const dir = fixture();
    assertRefused(dir, ['m1', '--summary', 'x', '--check', 'node fail.cjs'], /test suite failed/);
    assert.equal(runs(dir), 1);
    assert.equal(fs.existsSync(path.join(dir, '.nativ', 'config.json')), false);
  },

  'refuses when the suite outlives the timeout'() {
    const args = ['m1', '--summary', 'x', '--check', 'node slow.cjs', '--timeout', '300'];
    assertRefused(fixture(), args, /timed out/);
  },

  'refuses when the suite itself changes tracked code'() {
    const args = ['m1', '--summary', 'x', '--check', 'node dirties.cjs'];
    assertRefused(fixture(), args, /uncommitted changes/);
  },

  'refuses a missing summary before running anything'() {
    const dir = fixture();
    assertRefused(dir, ['m1', '--check', 'node pass.cjs'], /summary is required/);
    assertRefused(dir, ['m1,m2', '--summary', 'x', '--check', 'node pass.cjs'], /--summaries/);
    assert.equal(runs(dir), 0);
  },

  'refuses with no suite set and says how to set one'() {
    assertRefused(fixture(), ['m1', '--summary', 'x'], /regressionCommand/);
  },

  'refuses a check that runs nothing, or sets an override name'() {
    const dir = fixture();
    assertRefused(dir, ['m1', '--summary', 'x', '--check', 'none'], /runs no tests/);
    const named = 'set NATIV_CI_OVERRIDE=1 && node pass.cjs';
    assertRefused(dir, ['m1', '--summary', 'x', '--check', named], /must not set/);
    const saved = fixture({ config: { regressionCommand: 'NATIV_HEADLESS_OVERRIDE=1 node pass.cjs' } });
    assertRefused(saved, ['m1', '--summary', 'x'], /must not set/);
    assert.equal(runs(dir) + runs(saved), 0);
  },

  '--check is saved and later runs use it, keeping other settings'() {
    const dir = fixture({ config: { keep: 1, regressionCommand: 'node fail.cjs' } });
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.nativ', 'config.json'), 'utf8'));
    assert.deepEqual(config, { keep: 1, regressionCommand: 'node pass.cjs' });
    assert.equal(archive(dir, 'm2', '--summary', 'x').code, 0);
    assert.equal(runs(dir), 2);
  },

  'several milestones run the suite once'() {
    const dir = fixture();
    const file = summariesFile(dir, { m1: 'first', m2: 'second' });
    const res = archive(dir, 'm1,m2', '--summaries', file, '--check', 'node pass.cjs');
    assert.equal(res.code, 0, res.out);
    assert.equal(runs(dir), 1);
    const plan = readPlan(dir);
    assert.equal(plan.milestones[0].archived.summary, 'first');
    assert.equal(plan.milestones[1].archived.summary, 'second');
  },

  'one refused id stops the whole batch'() {
    const dir = fixture();
    const file = summariesFile(dir, { m1: 'a', m3: 'b' });
    assertRefused(dir, ['m1,m3', '--summaries', file, '--check', 'node pass.cjs'], /unfinished/);
    assert.equal(runs(dir), 0);
  },

  'plan unchanged when the archive file cannot be written'() {
    const dir = fixture();
    fs.writeFileSync(archiveDir(dir), 'a file where the folder should be');
    const before = planText(dir);
    const res = archive(dir, 'm1', ...GOOD);
    assert.equal(res.code, 1, res.out);
    assert.match(res.out, /plan is unchanged/);
    assert.equal(planText(dir), before);
  },

  async 'plan unchanged when the read-back does not match or does not parse'() {
    for (const text of ['{"id":"other"}', 'not json']) {
      const dir = fixture();
      const before = planText(dir);
      const request = { ids: ['m1'], summaries: { m1: 'x' }, check: 'node pass.cjs' };
      const work = core.archiveMilestones(dir, request, { readBack: () => text });
      await assert.rejects(work, /plan is unchanged/);
      assert.equal(planText(dir), before);
      assert.equal(fs.existsSync(archiveDir(dir)), false);
    }
  },

  async 'a failed batch removes the files it wrote, and a failed plan save too'() {
    const dir = fixture();
    const before = planText(dir);
    const request = { ids: ['m1', 'm2'], summaries: { m1: 'x', m2: 'y' }, check: 'node pass.cjs' };
    const readBack = (f) => (f.endsWith('m2.json') ? 'bad' : fs.readFileSync(f, 'utf8'));
    await assert.rejects(core.archiveMilestones(dir, request, { readBack }), /plan is unchanged/);
    assert.equal(planText(dir), before);
    assert.equal(fs.existsSync(archiveDir(dir)), false);
    const failedSave = core.archiveMilestones(dir, request, { save: () => false });
    await assert.rejects(failedSave, /plan is unchanged/);
    assert.equal(planText(dir), before);
    assert.equal(fs.existsSync(archiveDir(dir)), false);
  },

  'archived ids stay taken and still satisfy dependencies'() {
    const dir = fixture();
    assert.equal(archive(dir, 'm2', ...GOOD).code, 0);
    const args = ['task', 'add', 'New', '--deps', 'task-09', '--milestone', 'm3', '--json'];
    const added = JSON.parse(nativ(dir, ...args).out);
    assert.equal(added.task.id, 'task-10');
    assert.equal(nativ(dir, 'task', 'start', 'task-10').code, 0);
    assert.equal(readPlan(dir).milestones[2].tasks[1].status, 'in_progress');
    assert.match(nativ(dir, 'task', 'add', 'Bad', '--deps', 'task-77').out, /Unknown dependency/);
  },

  'task list and next treat an archived dependency as done'() {
    const plan = basePlan();
    plan.milestones[2].tasks = [task('task-03', 'pending', ['task-09'])];
    const dir = fixture({ plan });
    assert.equal(archive(dir, 'm2', ...GOOD).code, 0);
    assert.match(nativ(dir, 'tasks', '--available', '--json').out, /task-03/);
    assert.match(nativ(dir, 'task', 'next', '--json').out, /task-03/);
  },

  'task add refuses an archived milestone'() {
    const dir = fixture();
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    const res = nativ(dir, 'task', 'add', 'New', '--milestone', 'm1');
    assert.equal(res.code, 1);
    assert.match(res.out, /is archived/);
    assert.equal(readPlan(dir).milestones[0].tasks.length, 0);
  },

  'an archived fast-path milestone is not reused for new fast-path tasks'() {
    const plan = basePlan();
    plan.milestones[1].fastPath = true;
    const dir = fixture({ plan });
    assert.equal(archive(dir, 'm2', ...GOOD).code, 0);
    assert.equal(nativ(dir, 'task', 'add', 'Quick', '--fast-path').code, 0);
    const after = readPlan(dir);
    assert.deepEqual(after.milestones[1].tasks, []);
    assert.equal(after.milestones[3].tasks[0].id, 'task-10');
  },

  'the active milestone moves to the first open one, or stays when none is open'() {
    const plan = basePlan();
    plan.activeMilestoneId = 'm1';
    const dir = fixture({ plan });
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    assert.equal(readPlan(dir).activeMilestoneId, 'm3');

    const allDone = basePlan();
    allDone.milestones.pop();
    allDone.activeMilestoneId = 'm1';
    const other = fixture({ plan: allDone });
    assert.equal(archive(other, 'm1', ...GOOD).code, 0);
    assert.equal(readPlan(other).activeMilestoneId, 'm1');
  },

  'commit is null outside a git repo'() {
    const dir = fixture({ repo: false });
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    assert.equal(readPlan(dir).milestones[0].archived.commit, null);
  },

  'restore refuses and keeps the plan when it cannot trust the archive'() {
    const dir = fixture();
    const notArchived = restore(dir, 'm1');
    assert.equal(notArchived.code, 1);
    assert.match(notArchived.out, /not archived/);
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    const before = planText(dir);
    const file = path.join(archiveDir(dir), 'm1.json');
    for (const bad of ['not json', '{"id":"m1","tasks":[]}']) {
      fs.writeFileSync(file, bad);
      const res = restore(dir, 'm1');
      assert.equal(res.code, 1, res.out);
      assert.equal(planText(dir), before);
      assert.equal(fs.readFileSync(file, 'utf8'), bad);
    }
    fs.rmSync(file);
    assert.equal(restore(dir, 'm1').code, 1);
    assert.equal(planText(dir), before);
  },

  async 'restore keeps the archive file when the plan cannot be saved'() {
    const dir = fixture();
    assert.equal(archive(dir, 'm1', ...GOOD).code, 0);
    const before = planText(dir);
    const work = core.restoreMilestone(dir, 'm1', { save: () => false });
    await assert.rejects(work, /archive file of m1 is kept/);
    assert.equal(planText(dir), before);
    assert.ok(fs.existsSync(path.join(archiveDir(dir), 'm1.json')));
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('milestone archive: all passed');
