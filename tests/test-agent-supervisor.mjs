import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

console.log('--- Starting Agent Supervisor Process Engine Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFile = path.join(repoRoot, 'src', 'runner', 'agent-supervisor.ts');
const distFile = path.join(repoRoot, 'dist', 'runner', 'agent-supervisor.js');
const tempDirs = [];

/** The supervisor ships as TypeScript; compile on demand so plain `node` can import it. */
function ensureBuild() {
  const stale =
    !fs.existsSync(distFile) || fs.statSync(distFile).mtimeMs < fs.statSync(srcFile).mtimeMs;
  if (stale) {
    console.log('  (compiling dist/ before running supervisor tests...)');
    execSync('npx tsc', { cwd: repoRoot, stdio: 'inherit' });
  }
}

function createFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-sup-')));
  tempDirs.push(dir);

  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test Runner"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@nativ.dev"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Supervisor Fixture\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ai/\n.worktrees/\n.nativ/\nmocks/\n', 'utf8');
  execSync('git add . && git commit -m "initial commit"', { cwd: dir, stdio: 'ignore' });

  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });

  const task = (id, overrides = {}) => ({
    id,
    title: `Task ${id}`,
    description: 'Supervisor fixture task',
    assignedSubagent: 'backend',
    dependencies: [],
    targetFiles: [],
    status: 'pending',
    verificationCommand: '',
    notes: '',
    ...overrides,
  });

  const plan = {
    version: '1.0.0',
    projectName: 'supervisor-fixture',
    lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress',
    activeMilestoneId: 'm1',
    milestones: [
      {
        id: 'm1',
        name: 'Supervisor Sprint',
        status: 'in_progress',
        tasks: [
          task('task-echo'),
          task('task-worktree'),
          task('task-hang'),
          task('task-timeout'),
          task('task-flood'),
          task('task-fail'),
          task('task-verify', { verificationCommand: 'node --version' }),
          task('task-blocked-dep', { dependencies: ['task-echo'] }),
          task('task-ready-dep', { dependencies: ['task-done'] }),
          task('task-done', { status: 'completed' }),
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');

  // Deterministic stand-ins for the `claude` runner.
  const mocks = path.join(dir, 'mocks');
  fs.mkdirSync(mocks, { recursive: true });
  fs.writeFileSync(
    path.join(mocks, 'echo.mjs'),
    [
      "process.stdout.write(`CWD:${process.cwd()}\\n`);",
      "process.stdout.write(`TASK:${process.env.NATIV_TASK_ID}\\n`);",
      "process.stderr.write('agent: warning line\\n');",
      "process.stdout.write('agent: done\\n');",
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(mocks, 'hang.mjs'),
    ["process.stdout.write('agent: started\\n');", 'setInterval(() => {}, 1000);'].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(mocks, 'flood.mjs'),
    [
      "for (let i = 0; i < 400; i++) process.stdout.write(`line ${i} ${'x'.repeat(80)}\\n`);",
      "process.stdout.write('FLOOD_TAIL_MARKER\\n');",
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(mocks, 'fail.mjs'),
    ["process.stderr.write('agent: fatal\\n');", 'process.exit(3);'].join('\n'),
    'utf8',
  );

  return dir;
}

/** Quoted so paths containing spaces survive both cmd.exe and POSIX shells. */
function mockCommand(dir, name) {
  return `"${process.execPath}" "${path.join(dir, 'mocks', name)}"`;
}

function waitForStatus(supervisor, taskId, statuses, timeoutMs = 30_000) {
  const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      supervisor.off('runner_status', onStatus);
      reject(new Error(`Timed out waiting for [${[...wanted]}] on ${taskId}`));
    }, timeoutMs);
    const onStatus = (record) => {
      if (record.taskId !== taskId || !wanted.has(record.status)) return;
      clearTimeout(timer);
      supervisor.off('runner_status', onStatus);
      resolve(record);
    };
    supervisor.on('runner_status', onStatus);
  });
}

function waitForLog(supervisor, taskId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      supervisor.off('runner_log', onLog);
      reject(new Error(`Timed out waiting for log output on ${taskId}`));
    }, timeoutMs);
    const onLog = (entry) => {
      if (entry.taskId !== taskId) return;
      clearTimeout(timer);
      supervisor.off('runner_log', onLog);
      resolve(entry);
    };
    supervisor.on('runner_log', onLog);
  });
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `Expected error code ${code}, received ${err.code}: ${err.message}`);
    assert.ok(err.message.length > 0, 'SupervisorError must carry a message');
    return err;
  }
  throw new Error(`Expected dispatch to reject with ${code}`);
}

/** Junctions must be unlinked explicitly so cleanup never walks into the real .ai/. */
function unlinkWorktreeMounts(dir) {
  const worktrees = path.join(dir, '.worktrees');
  if (!fs.existsSync(worktrees)) return;
  for (const entry of fs.readdirSync(worktrees)) {
    const mount = path.join(worktrees, entry, '.ai');
    try {
      const stat = fs.lstatSync(mount);
      if (stat.isSymbolicLink() || stat.isDirectory()) fs.unlinkSync(mount);
    } catch {
      // Nothing mounted here.
    }
  }
}

ensureBuild();
const { AgentSupervisor, SupervisorError, isActiveStatus, DEFAULT_TIMEOUT_SECONDS } = await import(
  pathToFileURL(distFile).href
);

const dir = createFixture();
let supervisor = new AgentSupervisor({ cwd: dir, killGraceMs: 300, maxLogBufferBytes: 4096 });
const statusLog = [];
supervisor.on('runner_status', (record) => statusLog.push(`${record.taskId}:${record.status}`));

try {
  // ── 1. Happy-path lifecycle, in-place (no worktree) ────────────────────────
  console.log('1. Testing dispatch lifecycle and completion (in-place)...');
  const echoDone = waitForStatus(supervisor, 'task-echo', 'completed');
  const echoRecord = await supervisor.dispatch({
    taskId: 'task-echo',
    runnerCommand: mockCommand(dir, 'echo.mjs'),
    useWorktree: false,
    timeoutSeconds: 30,
  });

  assert.ok(echoRecord.runId, 'Dispatch must return a runId');
  assert.equal(echoRecord.taskId, 'task-echo');
  assert.equal(echoRecord.status, 'running');
  assert.equal(echoRecord.branch, null, 'In-place runs carry no agent branch');
  assert.equal(echoRecord.worktreeDir, dir, 'In-place runs execute at the project root');
  assert.equal(typeof echoRecord.pid, 'number', 'Dispatch must expose the spawned PID');
  assert.equal(echoRecord.timeoutSeconds, 30);
  assert.ok(supervisor.isRunning('task-echo'), 'Task should report as running right after dispatch');

  const finished = await echoDone;
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.pid, null, 'Finished runs release their PID');
  assert.ok(finished.endedAt && finished.durationMs !== null, 'Finished runs record timing');
  assert.equal(supervisor.isRunning('task-echo'), false);
  assert.equal(isActiveStatus('running'), true);
  assert.equal(isActiveStatus('completed'), false);
  console.log('✔ Runner spawned detached, streamed to completion, and released its slot.');

  // ── 2. Log streaming + buffer persistence ──────────────────────────────────
  console.log('2. Testing log capture across stdout/stderr and disk persistence...');
  const echoLogs = supervisor.getLogs('task-echo', 200);
  assert.equal(echoLogs.taskId, 'task-echo');
  assert.equal(echoLogs.status, 'completed');
  assert.ok(echoLogs.log.includes('agent: done'), 'stdout must reach the log buffer');
  assert.ok(echoLogs.log.includes('agent: warning line'), 'stderr must reach the log buffer');
  assert.ok(echoLogs.log.includes('TASK:task-echo'), 'Runner receives NATIV_TASK_ID in its environment');
  assert.ok(echoLogs.totalBytes > 0, 'totalBytes must report the full captured size');

  const logFile = path.join(dir, '.nativ', 'runs', 'task-echo.log');
  const recordFile = path.join(dir, '.nativ', 'runs', 'task-echo.json');
  assert.ok(fs.existsSync(logFile), 'Log buffer must persist to .nativ/runs/<taskId>.log');
  assert.ok(fs.readFileSync(logFile, 'utf8').includes('agent: done'));
  const persisted = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(persisted.status, 'completed');
  assert.equal(persisted.taskId, 'task-echo');
  console.log('✔ Log buffer streamed both channels and persisted under .nativ/runs/.');

  // ── 3. Worktree isolation ──────────────────────────────────────────────────
  console.log('3. Testing isolated worktree provisioning...');
  const wtSpawning = waitForStatus(supervisor, 'task-worktree', 'spawning_worktree');
  const wtDone = waitForStatus(supervisor, 'task-worktree', 'completed');
  const wtRecord = await supervisor.dispatch({
    taskId: 'task-worktree',
    runnerCommand: mockCommand(dir, 'echo.mjs'),
    timeoutSeconds: 60,
  });
  await wtSpawning;

  const expectedDir = path.join(dir, '.worktrees', 'task-task-worktree');
  assert.equal(wtRecord.branch, 'agent/task-task-worktree');
  assert.equal(wtRecord.worktreeDir, expectedDir);
  assert.ok(fs.existsSync(expectedDir), 'Worktree directory must exist on disk');
  assert.ok(fs.existsSync(path.join(expectedDir, '.ai')), '.ai contracts must be mounted into the worktree');

  await wtDone;
  const wtLogs = supervisor.getLogs('task-worktree', 50);
  assert.ok(
    wtLogs.log.includes(`CWD:${expectedDir}`),
    `Runner must execute inside the worktree (got: ${wtLogs.log.trim()})`,
  );
  assert.ok(
    statusLog.includes('task-worktree:spawning_worktree') && statusLog.includes('task-worktree:running'),
    'Worktree runs must broadcast spawning_worktree before running',
  );
  console.log('✔ Worktree provisioned on agent branch with .ai mounted, runner executed inside it.');

  // ── 4. Guard rails: duplicate dispatch, unmet dependencies, unknown task ────
  console.log('4. Testing dispatch guard rails...');
  const hangRunning = waitForStatus(supervisor, 'task-hang', 'running');
  await supervisor.dispatch({
    taskId: 'task-hang',
    runnerCommand: mockCommand(dir, 'hang.mjs'),
    useWorktree: false,
    timeoutSeconds: 60,
  });
  await hangRunning;

  const duplicate = await expectError(
    supervisor.dispatch({ taskId: 'task-hang', runnerCommand: mockCommand(dir, 'echo.mjs'), useWorktree: false }),
    'TASK_ALREADY_RUNNING',
  );
  assert.ok(duplicate instanceof SupervisorError, 'Guard rails must raise SupervisorError');
  assert.equal(duplicate.status, 400, 'Guard-rail failures map to HTTP 400');

  await expectError(
    supervisor.dispatch({ taskId: 'task-blocked-dep', runnerCommand: mockCommand(dir, 'echo.mjs'), useWorktree: false }),
    'UNMET_DEPENDENCIES',
  );
  await expectError(
    supervisor.dispatch({ taskId: 'task-ghost', runnerCommand: mockCommand(dir, 'echo.mjs'), useWorktree: false }),
    'TASK_NOT_FOUND',
  );
  await expectError(supervisor.dispatch({ taskId: '   ' }), 'VALIDATION_ERROR');
  await expectError(
    supervisor.dispatch({ taskId: 'task-fail', timeoutSeconds: 0, useWorktree: false }),
    'VALIDATION_ERROR',
  );
  await expectError(supervisor.abort('task-echo'), 'TASK_NOT_RUNNING');
  console.log('✔ Duplicate, dependency-blocked, unknown and malformed dispatches rejected with codes.');

  // ── 5. Abort killswitch ────────────────────────────────────────────────────
  console.log('5. Testing abort killswitch on a long-running agent...');
  await waitForLog(supervisor, 'task-hang');
  const hangPid = supervisor.getRun('task-hang').pid;
  const aborted = waitForStatus(supervisor, 'task-hang', 'aborted');
  const abortResult = await supervisor.abort('task-hang', 'operator cancelled');
  assert.equal(abortResult.status, 'aborted');
  assert.equal(abortResult.taskId, 'task-hang');
  assert.ok(abortResult.message.includes('operator cancelled'));

  const abortedRecord = await aborted;
  assert.equal(abortedRecord.abortReason, 'operator cancelled');
  assert.equal(supervisor.isRunning('task-hang'), false, 'Aborted runs must free their slot');
  await new Promise((resolve) => setTimeout(resolve, 500));
  let alive = true;
  try {
    process.kill(hangPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `Aborted process tree (pid ${hangPid}) must be reaped`);
  console.log('✔ Abort terminated the detached process tree and settled the run as aborted.');

  // ── 6. Timeout killswitch ──────────────────────────────────────────────────
  console.log('6. Testing timeout killswitch...');
  const timedOut = waitForStatus(supervisor, 'task-timeout', 'failed');
  await supervisor.dispatch({
    taskId: 'task-timeout',
    runnerCommand: mockCommand(dir, 'hang.mjs'),
    useWorktree: false,
    timeoutSeconds: 1,
  });
  const timeoutRecord = await timedOut;
  assert.equal(timeoutRecord.timedOut, true, 'Timed-out runs must be flagged');
  assert.ok(timeoutRecord.error.includes('timeout budget'), 'Timeout must be explained in the record');
  assert.equal(supervisor.isRunning('task-timeout'), false);
  console.log('✔ Killswitch fired after the timeout budget and settled the run as failed.');

  // ── 7. Non-zero exit handling ──────────────────────────────────────────────
  console.log('7. Testing non-zero runner exit handling...');
  const failed = waitForStatus(supervisor, 'task-fail', 'failed');
  await supervisor.dispatch({
    taskId: 'task-fail',
    runnerCommand: mockCommand(dir, 'fail.mjs'),
    useWorktree: false,
    timeoutSeconds: 30,
  });
  const failRecord = await failed;
  assert.equal(failRecord.exitCode, 3);
  assert.equal(failRecord.timedOut, false);
  assert.ok(failRecord.error.includes('3'), 'Failure reason must mention the exit code');
  assert.ok(supervisor.getLogs('task-fail', 20).log.includes('agent: fatal'));
  console.log('✔ Failing runner surfaced its exit code, reason, and stderr.');

  // ── 8. Post-run verification phase ─────────────────────────────────────────
  console.log('8. Testing post-run verification phase...');
  const verifying = waitForStatus(supervisor, 'task-verify', 'verifying');
  const verified = waitForStatus(supervisor, 'task-verify', 'completed');
  await supervisor.dispatch({
    taskId: 'task-verify',
    runnerCommand: mockCommand(dir, 'echo.mjs'),
    useWorktree: false,
    timeoutSeconds: 60,
    verify: true,
  });
  await verifying;
  const verifiedRecord = await verified;
  assert.ok(verifiedRecord.verification, 'Verification result must be attached to the record');
  assert.equal(verifiedRecord.verification.success, true);
  assert.equal(verifiedRecord.verification.command, 'node --version');
  console.log('✔ Verification phase ran the task verificationCommand and recorded its result.');

  // ── 9. Log buffer bounding ─────────────────────────────────────────────────
  console.log('9. Testing bounded log ring buffer...');
  const flooded = waitForStatus(supervisor, 'task-flood', 'completed');
  await supervisor.dispatch({
    taskId: 'task-flood',
    runnerCommand: mockCommand(dir, 'flood.mjs'),
    useWorktree: false,
    timeoutSeconds: 60,
  });
  const floodRecord = await flooded;
  assert.ok(floodRecord.logBytes > 30_000, `Expected a large log volume, got ${floodRecord.logBytes}`);

  const floodTail = supervisor.getLogs('task-flood', 5);
  assert.ok(floodTail.log.includes('FLOOD_TAIL_MARKER'), 'Tail must retain the newest output');
  assert.ok(floodTail.log.split('\n').length <= 6, 'tailLines must honour the requested line count');
  assert.equal(floodTail.truncated, true, 'Trimmed buffers must be reported as truncated');
  assert.ok(floodTail.totalBytes > Buffer.byteLength(floodTail.log, 'utf8'), 'totalBytes tracks untrimmed size');
  assert.ok(
    fs.readFileSync(path.join(dir, '.nativ', 'runs', 'task-flood.log'), 'utf8').includes('line 0'),
    'The on-disk log keeps the full history that the memory buffer drops',
  );
  console.log('✔ Ring buffer stayed bounded while the on-disk log retained full history.');

  // ── 10. Run listing and filtering ──────────────────────────────────────────
  console.log('10. Testing run listing, filtering and history...');
  const allRuns = supervisor.listRuns();
  assert.ok(allRuns.length >= 6, `Expected recent runs in history, got ${allRuns.length}`);
  assert.deepEqual(
    [...allRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => r.runId),
    allRuns.map((r) => r.runId),
    'Runs must be listed newest first',
  );
  assert.equal(supervisor.listRuns({ taskId: 'task-echo' }).length, 1);
  assert.equal(supervisor.listRuns({ activeOnly: true }).length, 0, 'No runners should remain in flight');
  assert.equal(supervisor.getRun('task-ghost'), null);
  assert.equal(supervisor.getRun('task-echo').status, 'completed');
  console.log('✔ Run listing filters by task and active state.');

  // ── 11. Restart recovery ───────────────────────────────────────────────────
  console.log('11. Testing history restore from .nativ/runs after a restart...');
  const restarted = new AgentSupervisor({ cwd: dir });
  const restoredIds = restarted.listRuns().map((r) => r.taskId);
  assert.ok(restoredIds.includes('task-echo'), 'Restarted supervisor must restore persisted runs');
  assert.ok(restoredIds.includes('task-flood'));
  assert.equal(restarted.listRuns({ activeOnly: true }).length, 0);
  const restoredEcho = restarted.getRun('task-echo');
  assert.equal(restoredEcho.status, 'completed');
  assert.ok(restarted.getLogs('task-echo', 200).log.includes('agent: done'), 'Logs are readable after restart');
  restarted.shutdown();
  console.log('✔ Persisted runs and logs survive a supervisor restart.');

  // ── 12. Shutdown reaps in-flight runners ───────────────────────────────────
  console.log('12. Testing shutdown reaping of in-flight runners...');
  const shutdownSup = new AgentSupervisor({ cwd: dir, killGraceMs: 200 });
  const secondRunning = waitForStatus(shutdownSup, 'task-hang', 'running');
  await shutdownSup.dispatch({
    taskId: 'task-hang',
    runnerCommand: mockCommand(dir, 'hang.mjs'),
    useWorktree: false,
    timeoutSeconds: 60,
  });
  await secondRunning;
  const livePid = shutdownSup.getRun('task-hang').pid;
  shutdownSup.shutdown('test shutdown');
  assert.equal(shutdownSup.isRunning('task-hang'), false, 'Shutdown must clear in-flight runs');
  await new Promise((resolve) => setTimeout(resolve, 500));
  let stillAlive = true;
  try {
    process.kill(livePid, 0);
  } catch {
    stillAlive = false;
  }
  assert.equal(stillAlive, false, `Shutdown must reap in-flight process tree (pid ${livePid})`);
  await expectError(shutdownSup.dispatch({ taskId: 'task-echo', useWorktree: false }), 'SHUTTING_DOWN');
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 600, 'Default timeout must match the API contract default');
  console.log('✔ Shutdown reaped live runners and refused further dispatches.');

  console.log('\n🎉 ALL AGENT SUPERVISOR TESTS PASSED!');
} finally {
  try {
    supervisor.shutdown();
  } catch {
    // Already closed.
  }
  for (const d of tempDirs) {
    try {
      unlinkWorktreeMounts(d);
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}
