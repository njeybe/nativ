// Status, Studio, verify, validate, task start and task show on archived milestones (temp fixtures).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'cli.js');
const dist = (f) => import(pathToFileURL(path.join(repo, 'dist', f)).href);
const tmpBase = fs.realpathSync(os.tmpdir());
const made = [];
// Built, not written out: these folders live only in temporary fixtures, never in the repo.
const AI = ['', 'ai'].join('.');

const task = (id, status = 'completed', dependencies = []) => ({
  id, title: `Title ${id}`, description: `Does ${id}`, assignedSubagent: 'backend', dependencies,
  targetFiles: ['a.ts'], status, verificationCommand: 'node -e "process.exit(0)"', notes: '',
});
const plan = (archived) => {
  const m1 = { id: 'm1', name: 'One', status: 'completed', tasks: [task('task-01'), task('task-02')] };
  const m2 = { id: 'm2', name: 'Two', status: 'in_progress', tasks: [task('task-03', 'pending', ['task-02'])] };
  if (archived) {
    m1.archived = {
      summary: 'Did the first thing', commit: null, check: 'x', archivedAt: '2026-01-01T00:00:00.000Z',
      taskCount: 2, taskIds: ['task-01', 'task-02'], file: `${AI}/archive/m1.json`,
    };
    m1.tasks = [];
  }
  return {
    version: '1.0.0', projectName: 'fx', overallStatus: 'in_progress', activeMilestoneId: 'm2',
    lastUpdated: '2026-01-01T00:00:00.000Z', milestones: [m1, m2],
  };
};

function fixture(archived, withFile = true) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'nativ-arch-int-'));
  made.push(dir);
  fs.mkdirSync(path.join(dir, AI, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, AI, 'master_plan.json'), JSON.stringify(plan(archived), null, 2));
  for (const f of ['context.md', 'ui_specs.md']) fs.writeFileSync(path.join(dir, AI, f), '# x');
  for (const f of ['db_schema.json', 'api_contracts.json']) fs.writeFileSync(path.join(dir, AI, f), '{}');
  fs.mkdirSync(path.join(dir, AI, 'subagents'));
  for (const f of ['database', 'backend', 'frontend', 'qa-tester']) {
    fs.writeFileSync(path.join(dir, AI, 'subagents', `${f}.md`), '# x');
  }
  if (archived && withFile) {
    fs.writeFileSync(path.join(dir, AI, 'archive', 'm1.json'), JSON.stringify(plan(false).milestones[0]));
  }
  return dir;
}

const cliRun = (dir, ...args) => spawnSync(process.execPath, [cli, ...args, dir], {
  encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpBase },
});
const out = (r) => `${r.stdout}${r.stderr}`;

try {
  // Status keeps overall counts the same.
  const before = fixture(false);
  const after = fixture(true);
  const text = (d) => out(cliRun(d, 'status')).match(/Completion: (\d+\/\d+)/)[1];
  assert.equal(text(before), '2/3');
  assert.equal(text(after), '2/3', 'status text counts archived tasks');
  assert.match(out(cliRun(after, 'status')), /archived.*Did the first thing/);
  const json = JSON.parse(cliRun(after, 'status', '--json').stdout);
  const stub = json.milestones.find((m) => m.id === 'm1');
  assert.equal(stub.taskCount, 2);
  assert.equal(stub.completedCount, 2);
  assert.equal(stub.summary, 'Did the first thing');
  console.log('✔ status counts match before and after archiving');

  // Validate accepts the archived field and fails when the file is gone or mismatched.
  assert.equal(cliRun(after, 'validate').status, 0, out(cliRun(after, 'validate')));
  const gone = fixture(true, false);
  const bad = cliRun(gone, 'validate');
  assert.notEqual(bad.status, 0);
  assert.match(out(bad), /Archive file of m1 is missing/);
  const mismatch = fixture(true);
  const file = path.join(mismatch, AI, 'archive', 'm1.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.tasks.pop();
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.match(out(cliRun(mismatch, 'validate')), /does not match/);
  console.log('✔ validate accepts stubs and rejects missing or mismatched archives');

  // task show reads from the archive; start explains.
  const shown = JSON.parse(cliRun(after, 'task', 'show', 'task-01', '--json').stdout);
  assert.equal(shown.title, 'Title task-01');
  assert.equal(shown.archived, true);
  assert.equal(JSON.parse(cliRun(after, 'task', 'show', 'task-03', '--json').stdout).archived, false);
  assert.match(out(cliRun(after, 'task', 'show', 'task-01')), /Does task-01/);
  assert.notEqual(cliRun(after, 'task', 'show', 'nope').status, 0);
  const start = cliRun(after, 'task', 'start', 'task-01');
  assert.notEqual(start.status, 0);
  assert.match(out(start), /archived[\s\S]*nativ milestone restore m1/);
  assert.doesNotMatch(out(start), /not found/);
  assert.equal(cliRun(after, 'task', 'start', 'task-03').status, 0, 'dependency on an archived task is met');
  console.log('✔ task show reads archives; start on an archived task explains how to restore');

  // verify --all skips archived tasks; --milestone and a task id explain.
  const { verifyBatch, verifyTask } = await dist('core/verifier/task-verifier.js');
  const all = await verifyBatch(after, { all: true });
  assert.deepEqual(all.tasks.map((t) => t.taskId), ['task-03']);
  const ms = await verifyBatch(after, { milestoneId: 'm1' });
  assert.equal(ms.failed, 1);
  assert.match(ms.tasks[0].result.error, /archived[\s\S]*milestone restore m1/);
  const one = await verifyTask('task-01', after);
  assert.match(one.result.error, /archived/);
  console.log('✔ verify skips archived tasks and explains when asked for one');

  // Server and Studio totals.
  const { handlePipelineStatus, handlePipelineTasks } = await dist('server/routes/task-routes.js');
  const a = handlePipelineStatus(before).pipeline.tasks;
  const b = handlePipelineStatus(after).pipeline.tasks;
  assert.deepEqual([b.total, b.completed, b.progressPercentage], [a.total, a.completed, a.progressPercentage]);
  const apiTasks = handlePipelineTasks(after);
  assert.equal(apiTasks.milestones[1].tasks[0].isAvailable, true, 'depends on an archived task');
  const { pureScript } = await dist('server/studio-ui/shell/pure.js');
  const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, isNaN, isFinite, parseInt });
  vm.runInContext(pureScript, ctx);
  const model = (d) => {
    ctx.__api = { milestones: d.milestones };
    return vm.runInContext('JSON.parse(JSON.stringify(Studio.buildModel(__api)))', ctx);
  };
  const mb = model(handlePipelineTasks(before));
  const ma = model(apiTasks);
  const sum = (m) => [m.summary.tasksTotal, m.summary.tasksDone, m.summary.tasksLeft];
  assert.deepEqual(sum(ma), sum(mb));
  const am = ma.milestones[0];
  assert.deepEqual([am.total, am.done], [2, 2], 'archived milestone is not 0 of 0');
  assert.equal(am.archived.summary, 'Did the first thing');
  assert.deepEqual(ma.byId['task-03'].waitingOn, [], 'archived dependency is not waited on');
  console.log('✔ Studio server and model totals match before and after archiving');
  // Runner: a dependency on an archived task is met; an unfinished one is still refused.
  const { AgentSupervisor } = await dist('runner/agent-supervisor.js');
  const sup = new AgentSupervisor({ cwd: fixture(true) });
  const check = (deps) => sup.assertDependenciesMet({ id: 'task-x', dependencies: deps });
  assert.doesNotThrow(() => check(['task-01', 'task-02']), 'archived dependencies are met');
  assert.throws(() => check(['task-03']), (err) => err.code === 'UNMET_DEPENDENCIES');
  assert.throws(() => check(['task-01', 'task-03']), (err) => err.code === 'UNMET_DEPENDENCIES');
  console.log('✔ runner accepts archived dependencies and still refuses unfinished ones');
} finally {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
}
