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
  fs.writeFileSync(path.join(dir, '.gitignore'), '.ai/\n.worktrees/\n.nativ/\nmocks/\n.env\n', 'utf8');
  // A secret the native engine's tools must never read.
  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://secret\n', 'utf8');
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
          task('task-native'),
          task('task-native-hang'),
          task('task-native-timeout'),
          task('task-native-fail'),
          task('task-native-refusal'),
          task('task-native-truncated'),
          task('task-native-legacy'),
          task('task-cli-flags'),
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  fs.mkdirSync(path.join(aiDir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'subagents', 'backend.md'), '# Backend Role Fixture\nFollow the contracts.\n', 'utf8');

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
  fs.writeFileSync(
    path.join(mocks, 'env.mjs'),
    "process.stdout.write(`MAX_THINKING_TOKENS=${process.env.MAX_THINKING_TOKENS ?? 'unset'}\\n`);\n",
    'utf8',
  );

  return dir;
}

/** Quoted so paths containing spaces survive both cmd.exe and POSIX shells. */
function mockCommand(dir, name) {
  return `"${process.execPath}" "${path.join(dir, 'mocks', name)}"`;
}

/**
 * Scripted stand-in for the Anthropic SDK client (`client.beta.messages.stream`). Each dispatch
 * builds a fresh client, so every run replays `turns` from the start. A turn is a response spec,
 * 'hang' (never settles until the run's AbortSignal fires) or an Error to throw.
 */
function scriptedClient(turns, requests) {
  return () => {
    let i = 0;
    return {
      beta: {
        messages: {
          stream(params, options) {
            requests.push(JSON.parse(JSON.stringify(params)));
            const turn = turns[Math.min(i++, turns.length - 1)];
            const handlers = {};
            return {
              on(event, callback) {
                handlers[event] = callback;
                return this;
              },
              async finalMessage() {
                if (turn === 'hang') {
                  return new Promise((_, reject) =>
                    options.signal.addEventListener('abort', () => reject(new Error('stream aborted'))),
                  );
                }
                if (turn instanceof Error) throw turn;
                for (const block of turn.content) {
                  if (block.type === 'thinking') handlers.thinking?.(block.thinking, block.thinking);
                  if (block.type === 'text') handlers.text?.(block.text);
                }
                return {
                  id: `msg_${i}`,
                  type: 'message',
                  role: 'assistant',
                  model: turn.model ?? params.model,
                  stop_reason: turn.stop,
                  stop_details: turn.stopDetails ?? null,
                  content: turn.content,
                  usage: turn.usage,
                };
              },
            };
          },
        },
      },
    };
  };
}

const usage = (input, output, cacheCreate, cacheRead, thinking) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheCreate,
  cache_read_input_tokens: cacheRead,
  output_tokens_details: { thinking_tokens: thinking },
});

const closeTo = (actual, expected, label, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: expected ${expected}, got ${actual}`);

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
const {
  AgentSupervisor,
  SupervisorError,
  isActiveStatus,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_NATIVE_ALLOWED_COMMANDS,
  buildDefaultClaudeCommand,
  checkNativeBashCommand,
  resolveNativeThinking,
  supportsServerFallback,
  thinkingBudgetToEffort,
} = await import(pathToFileURL(distFile).href);

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

  // ── 13. Native engine: thinking resolution and command policy (pure) ──────
  console.log('13. Testing native thinking resolution and the bash command policy...');
  assert.equal(thinkingBudgetToEffort(2048), 'low');
  assert.equal(thinkingBudgetToEffort(2049), 'medium');
  assert.equal(thinkingBudgetToEffort(8192), 'medium');
  assert.equal(thinkingBudgetToEffort(24576), 'high');
  assert.equal(thinkingBudgetToEffort(49152), 'xhigh');
  assert.equal(thinkingBudgetToEffort(49153), 'max');
  assert.equal(resolveNativeThinking('claude-opus-5-5', null).effort, 'medium', 'Opus 5.5 starts at medium effort');
  assert.equal(resolveNativeThinking('claude-opus-5', null).effort, 'high');
  assert.equal(resolveNativeThinking('claude-opus-4-6', 32000).effort, 'high', 'the 4.6 generation has no xhigh');
  assert.deepEqual(resolveNativeThinking('claude-haiku-4-5', 500), { budget: 500, effort: null, budgetTokens: 1024 }, 'legacy budgets clamp to the 1024 minimum');
  assert.deepEqual(resolveNativeThinking('claude-haiku-4-5', null), { budget: null, effort: null, budgetTokens: null }, 'legacy models without a budget do not think');

  const allow = new Set(DEFAULT_NATIVE_ALLOWED_COMMANDS);
  const allowed = [
    'npx tsx tests/test-agent-supervisor.mjs',
    'git status --short && git diff HEAD~1..HEAD',
    'npm test 2>&1',
    'grep -rn "/api/events" src 2>/dev/null',
    'cat .env.example',
    'node -e "console.log(Object.keys({a:1}))"',
  ];
  const denied = [
    ['cat .env', /Secret files/],
    ['cat ./config/.env.local', /Secret files/],
    ['cat server.key', /Secret files/],
    ['echo $(whoami)', /substitution/],
    ['echo `whoami`', /substitution/],
    ['curl https://example.com', /allowlist/],
    ['cat /etc/passwd', /Absolute path/],
    ['cd .. && ls', /Parent-directory/],
    ['git push origin main', /reserved for the operator/],
    ['npm publish', /reserved for the operator/],
    ['node server.js &', /Background jobs/],
  ];
  for (const command of allowed) assert.equal(checkNativeBashCommand(command, allow), null, `must allow: ${command}`);
  for (const [command, reason] of denied) assert.match(checkNativeBashCommand(command, allow) ?? '', reason, `must reject: ${command}`);
  console.log('✔ Budgets map onto effort (legacy models keep budget_tokens) and the bash policy blocks escapes.');

  // ── 14. Native engine end to end in an isolated worktree ──────────────────
  console.log('14. Testing the native engine loop, tools, caching and grounded usage...');
  process.env.NATIV_TEST_SECRET_TOKEN = 'leaked-credential';
  const nativeRequests = [];
  const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const edit = (id, input) => toolUse(id, 'str_replace_based_edit_tool', input);
  const turn1 = [
    { type: 'thinking', thinking: 'Checking the workspace first.', signature: 'sig' },
    { type: 'text', text: 'Working on it.' },
    toolUse('tu1', 'bash', { command: 'node --version' }),
    edit('tu2', { command: 'create', path: 'out.txt', file_text: 'hello\nworld\n' }),
    edit('tu3', { command: 'view', path: '.env' }),
    edit('tu4', { command: 'create', path: '../escape.txt', file_text: 'x' }),
    toolUse('tu5', 'bash', { command: 'cat .env' }),
    edit('tu6', { command: 'view', path: '.ai/subagents/backend.md' }),
    edit('tu7', { command: 'create', path: '.ai/hack.json', file_text: '{}' }),
    toolUse('tu8', 'bash', { command: 'curl https://example.com' }),
  ];
  const nativeSup = new AgentSupervisor({
    cwd: dir,
    killGraceMs: 200,
    anthropicClientFactory: scriptedClient(
      [
        { stop: 'tool_use', content: turn1, usage: usage(100, 50, 2000, 0, 20) },
        {
          stop: 'tool_use',
          content: [
            edit('tu9', { command: 'str_replace', path: 'out.txt', old_str: 'world', new_str: 'nativ' }),
            edit('tu10', { command: 'insert', path: 'out.txt', insert_line: 0, insert_text: 'top' }),
            toolUse('tu11', 'bash', { command: 'node -e "process.exit(4)"' }),
            edit('tu12', { command: 'view', path: 'out.txt', view_range: [1, 2] }),
            toolUse('tu13', 'bash', { command: `node -e "console.log(process.env.NATIV_TEST_SECRET_TOKEN ?? 'stripped')"` }),
          ],
          usage: usage(100, 50, 0, 2000, 20),
        },
        // A refusal fallback (or any router) can serve a turn on another model; it is priced as that model.
        { stop: 'end_turn', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Done.' }], usage: usage(100, 50, 0, 2000, 20) },
      ],
      nativeRequests,
    ),
  });
  const usageEvents = [];
  nativeSup.on('runner_token_usage', (event) => usageEvents.push(event));
  const nativeDone = waitForStatus(nativeSup, 'task-native', ['completed', 'failed']);
  const nativeRecord = await nativeSup.dispatch({ taskId: 'task-native', runnerEngine: 'native', model: 'claude-opus-5-5', thinkingBudget: 32000, timeoutSeconds: 60 });
  assert.equal(nativeRecord.engine, 'native');
  assert.equal(nativeRecord.model, 'claude-opus-5-5');
  assert.deepEqual(nativeRecord.thinking, { budget: 32000, effort: 'xhigh', budgetTokens: null });
  assert.equal(nativeRecord.branch, 'agent/task-task-native', 'native runs also get an isolated worktree');
  const nativeFinal = await nativeDone;
  assert.equal(nativeFinal.status, 'completed', `native run failed: ${nativeFinal.error}`);
  assert.equal(nativeFinal.exitCode, 0);

  // Request shape: caching, thinking and a byte-stable prefix across turns.
  const [req1, req2, req3] = nativeRequests;
  assert.equal(nativeRequests.length, 3);
  assert.equal(req1.model, 'claude-opus-5-5');
  assert.equal(req1.max_tokens, 64000);
  assert.deepEqual(req1.cache_control, { type: 'ephemeral' }, 'top-level cache breakpoint follows the conversation');
  assert.deepEqual(req1.system[0].cache_control, { type: 'ephemeral' }, 'tools + system prompt are cached');
  assert.deepEqual(req1.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(req1.output_config, { effort: 'xhigh' });
  assert.deepEqual(req1.tools.map((t) => t.name), ['bash', 'str_replace_based_edit_tool']);
  assert.equal(req1.fallbacks !== undefined, supportsServerFallback('claude-opus-5-5'), 'fallbacks follow supportsServerFallback');
  assert.ok(req1.messages[0].content.includes('# Backend Role Fixture'), 'the role guide is injected into the task prompt');
  assert.ok(req1.messages[0].content.includes('task-native'));
  for (const later of [req2, req3]) {
    assert.equal(later.system[0].text, req1.system[0].text, 'the system prompt is frozen across turns (cacheable prefix)');
    assert.deepEqual(later.tools, req1.tools, 'the tool list is stable across turns');
  }
  assert.equal(req2.messages.length, 3, 'history is user → assistant → tool results');
  assert.deepEqual(req2.messages[1].content, turn1, 'assistant turns (thinking included) are passed back unchanged');

  // Tool results: one user message per turn, rejections returned as is_error so the model can adjust.
  const results1 = Object.fromEntries(req2.messages[2].content.map((r) => [r.tool_use_id, r]));
  assert.equal(Object.keys(results1).length, 8, 'every tool_use gets exactly one tool_result');
  assert.match(results1.tu1.content, /^v\d+/);
  assert.ok(!results1.tu1.is_error && !results1.tu2.is_error);
  assert.ok(results1.tu3.is_error && /Secret files/.test(results1.tu3.content), 'editor refuses .env');
  assert.ok(results1.tu4.is_error && /outside the workspace/.test(results1.tu4.content), 'editor refuses path escapes');
  assert.ok(results1.tu5.is_error && /Secret files/.test(results1.tu5.content), 'bash refuses cat .env');
  assert.ok(!results1.tu6.is_error && results1.tu6.content.includes('# Backend Role Fixture'), 'contracts are readable through the .ai mount');
  assert.ok(results1.tu7.is_error && /read-only/.test(results1.tu7.content), 'contracts are not writable');
  assert.ok(results1.tu8.is_error && /allowlist/.test(results1.tu8.content), 'non-allowlisted executables are refused');
  const results2 = Object.fromEntries(req3.messages[4].content.map((r) => [r.tool_use_id, r]));
  assert.ok(results2.tu11.content.includes('[exit code 4]') && !results2.tu11.is_error, 'non-zero exits are reported, not treated as tool errors');
  assert.equal(results2.tu12.content, '1\ttop\n2\thello', 'view_range returns numbered lines');
  assert.equal(results2.tu13.content.trim(), 'stripped', 'credential-looking env vars never reach the model shell');

  const nativeWt = path.join(dir, '.worktrees', 'task-task-native');
  assert.equal(fs.readFileSync(path.join(nativeWt, 'out.txt'), 'utf8'), 'top\nhello\nnativ\n');
  assert.ok(!fs.existsSync(path.join(dir, '.worktrees', 'escape.txt')), 'the escape write never happened');
  assert.ok(!fs.existsSync(path.join(dir, '.ai', 'hack.json')), 'the contract write never happened');

  // Grounded usage: per-turn events, served-model pricing, cumulative record.
  // Opus 5.5: 100×4 + 50×20 + 2000×5 = 11,400 µ$; 100×4 + 50×20 + 2000×0.2 = 1,800 µ$.
  // Opus 4.8: 100×5 + 50×25 + 2000×0.5 = 2,750 µ$. Total 15,950 µ$.
  assert.equal(usageEvents.length, 3, 'one runner_token_usage event per API turn');
  assert.deepEqual(usageEvents.map((e) => e.turn), [1, 2, 3]);
  assert.equal(usageEvents[2].model, 'claude-opus-4-8', 'usage names the model that served the turn');
  closeTo(usageEvents[0].delta.costUsd, 0.0114, 'turn 1 cost (cache write)');
  closeTo(usageEvents[2].delta.costUsd, 0.00275, 'turn 3 priced at Opus 4.8 rates');
  closeTo(usageEvents[2].total.cacheHitRate, 0.6349, 'cumulative cache hit rate', 1e-4);
  const nativeUsage = nativeFinal.usage;
  assert.deepEqual(
    [nativeUsage.turns, nativeUsage.inputTokens, nativeUsage.outputTokens, nativeUsage.cacheCreationTokens, nativeUsage.cacheReadTokens, nativeUsage.thinkingTokens],
    [3, 300, 150, 2000, 4000, 60],
  );
  closeTo(nativeUsage.costUsd, 0.01595, 'run cost');

  const nativeLog = nativeSup.getLogs('task-native', 500).log;
  assert.ok(nativeLog.includes('[native:thinking] Checking the workspace first.'), 'progress notes in thinking blocks reach the log');
  assert.ok(nativeLog.includes('[native] $ node --version'), 'every bash command is logged');
  assert.ok(nativeLog.includes('[native] turn 3'), 'per-turn usage is logged');
  assert.ok(!nativeLog.includes('postgres://secret') && !nativeLog.includes('leaked-credential'), 'secrets never reach the run log');

  const telemetryFile = path.join(dir, '.ai', 'telemetry.json');
  const deadline = Date.now() + 10_000;
  let telemetry = null;
  while (Date.now() < deadline) {
    try {
      telemetry = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
      if (telemetry.tasks.some((t) => t.taskId === 'task-native' && t.actualUsage)) break;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const nativeTel = telemetry?.tasks.find((t) => t.taskId === 'task-native');
  assert.ok(nativeTel?.actualUsage, 'grounded usage is folded into .ai/telemetry.json');
  assert.equal(nativeTel.actualUsage.turns, 3);
  closeTo(nativeTel.actualUsage.costUsd, 0.01595, 'telemetry actualUsage.costUsd');
  assert.equal(telemetry.summary.cacheReadTokens, 4000);
  console.log('✔ Native loop ran tools in the worktree, blocked escapes and secrets, cached its prefix and grounded its spend.');

  // ── 15. Native abort and timeout interrupt the in-flight stream ───────────
  console.log('15. Testing native abort and timeout killswitches...');
  const hangSup = new AgentSupervisor({ cwd: dir, killGraceMs: 200, anthropicClientFactory: scriptedClient(['hang'], []) });
  const nativeHangRunning = waitForStatus(hangSup, 'task-native-hang', 'running');
  await hangSup.dispatch({ taskId: 'task-native-hang', runnerEngine: 'native', useWorktree: false, timeoutSeconds: 60 });
  await nativeHangRunning;
  const hangAborted = waitForStatus(hangSup, 'task-native-hang', 'aborted');
  await hangSup.abort('task-native-hang', 'operator stop');
  await hangAborted;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(hangSup.getRun('task-native-hang').status, 'aborted', 'the rejected stream must not overwrite the aborted status');
  assert.equal(hangSup.isRunning('task-native-hang'), false);

  const timeoutFailed = waitForStatus(hangSup, 'task-native-timeout', 'failed');
  await hangSup.dispatch({ taskId: 'task-native-timeout', runnerEngine: 'native', useWorktree: false, timeoutSeconds: 1 });
  const timedOutRun = await timeoutFailed;
  assert.equal(timedOutRun.timedOut, true);
  assert.match(timedOutRun.error, /timeout budget/);
  hangSup.shutdown();
  console.log('✔ Abort and timeout cancel the API stream and settle the run exactly once.');

  // ── 16. Native failure modes ──────────────────────────────────────────────
  console.log('16. Testing native API failures, refusals and truncated tool calls...');
  const failRun = async (taskId, turns) => {
    const sup = new AgentSupervisor({ cwd: dir, anthropicClientFactory: scriptedClient(turns, []) });
    const failed = waitForStatus(sup, taskId, ['failed', 'completed']);
    await sup.dispatch({ taskId, runnerEngine: 'native', useWorktree: false, timeoutSeconds: 30 });
    const record = await failed;
    sup.shutdown();
    return record;
  };
  const apiFailure = await failRun('task-native-fail', [new Error('upstream exploded')]);
  assert.equal(apiFailure.status, 'failed');
  assert.equal(apiFailure.error, 'upstream exploded');

  const refusal = await failRun('task-native-refusal', [
    { stop: 'refusal', stopDetails: { type: 'refusal', category: 'cyber' }, content: [], usage: usage(80, 0, 0, 0, 0) },
  ]);
  assert.equal(refusal.status, 'failed');
  assert.match(refusal.error, /refusal: cyber/, 'the refusal category is surfaced');
  assert.equal(refusal.usage.turns, 1, 'refused turns still count toward usage');

  const truncated = await failRun('task-native-truncated', [
    { stop: 'max_tokens', content: [toolUse('tu-cut', 'bash', { command: 'touch ran.txt' })], usage: usage(80, 64000, 0, 0, 0) },
  ]);
  assert.equal(truncated.status, 'failed');
  assert.match(truncated.error, /max_tokens/);
  assert.ok(!fs.existsSync(path.join(dir, 'ran.txt')), 'a tool call cut off at max_tokens is never executed');
  console.log('✔ API errors, refusals and truncated tool calls fail the run with a clear reason.');

  // ── 17. Dispatch validation, credentials and legacy thinking budgets ──────
  console.log('17. Testing native dispatch validation and legacy budget_tokens...');
  const legacyRequests = [];
  const legacySup = new AgentSupervisor({
    cwd: dir,
    anthropicClientFactory: scriptedClient([{ stop: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: usage(10, 10, 0, 0, 0) }], legacyRequests),
  });
  await expectError(legacySup.dispatch({ taskId: 'task-native-legacy', runnerEngine: 'gpt' }), 'VALIDATION_ERROR');
  await expectError(legacySup.dispatch({ taskId: 'task-native-legacy', runnerEngine: 'native', thinkingBudget: -1 }), 'VALIDATION_ERROR');
  await expectError(legacySup.dispatch({ taskId: 'task-native-legacy', runnerEngine: 'native', model: 'rm -rf /' }), 'VALIDATION_ERROR');
  assert.equal(legacyRequests.length, 0, 'rejected dispatches never reach the API');
  const noCredentials = new AgentSupervisor({ cwd: dir, anthropicClientFactory: () => { throw new Error('no key configured'); } });
  await expectError(noCredentials.dispatch({ taskId: 'task-native-legacy', runnerEngine: 'native', useWorktree: false }), 'ANTHROPIC_CREDENTIALS_MISSING');
  noCredentials.shutdown();

  const legacyDone = waitForStatus(legacySup, 'task-native-legacy', ['completed', 'failed']);
  const legacyRecord = await legacySup.dispatch({ taskId: 'task-native-legacy', runnerEngine: 'native', model: 'claude-haiku-4-5', thinkingBudget: 500, useWorktree: false });
  assert.deepEqual(legacyRecord.thinking, { budget: 500, effort: null, budgetTokens: 1024 });
  assert.equal((await legacyDone).status, 'completed');
  assert.deepEqual(legacyRequests[0].thinking, { type: 'enabled', budget_tokens: 1024 }, 'legacy models get a literal budget_tokens');
  assert.equal(legacyRequests[0].output_config, undefined, 'legacy models get no effort parameter');
  legacySup.shutdown();
  console.log('✔ Invalid engines, budgets, models and missing credentials are refused; legacy models keep budget_tokens.');

  // ── 18. CLI engine receives the model and thinking budget ─────────────────
  console.log('18. Testing CLI dispatch passes --model and MAX_THINKING_TOKENS...');
  const cliCommand = buildDefaultClaudeCommand({ id: 'task-x', title: 'X', description: '', verificationCommand: '' }, 'claude-opus-5-5');
  assert.match(cliCommand, /--model claude-opus-5-5/);
  assert.match(cliCommand, /--dangerously-skip-permissions$/);
  const cliSup = new AgentSupervisor({ cwd: dir });
  const cliDone = waitForStatus(cliSup, 'task-cli-flags', 'completed');
  const cliRecord = await cliSup.dispatch({
    taskId: 'task-cli-flags',
    runnerCommand: mockCommand(dir, 'env.mjs'),
    thinkingBudget: 4096,
    useWorktree: false,
    timeoutSeconds: 30,
  });
  assert.equal(cliRecord.engine, 'cli', 'cli stays the default engine');
  assert.equal(cliRecord.usage, null, 'cli runs report no grounded usage');
  assert.deepEqual(cliRecord.thinking, { budget: 4096, effort: null, budgetTokens: 4096 });
  await cliDone;
  assert.ok(cliSup.getLogs('task-cli-flags', 20).log.includes('MAX_THINKING_TOKENS=4096'), 'the budget reaches Claude Code as MAX_THINKING_TOKENS');
  cliSup.shutdown();
  console.log('✔ CLI dispatch forwards the model flag and MAX_THINKING_TOKENS.');

  // ── 19. Restart restores native records and upgrades pre-dual-mode ones ───
  console.log('19. Testing restore of native and pre-dual-mode run records...');
  fs.writeFileSync(
    path.join(dir, '.nativ', 'runs', 'task-old.json'),
    JSON.stringify({ runId: 'old-run', taskId: 'task-old', status: 'completed', pid: null, startedAt: '2026-01-01T00:00:00.000Z', logFile: '' }),
    'utf8',
  );
  const reborn = new AgentSupervisor({ cwd: dir });
  const restoredNative = reborn.getRun('task-native');
  assert.equal(restoredNative.engine, 'native');
  assert.equal(restoredNative.usage.turns, 3, 'grounded usage survives a restart');
  const restoredOld = reborn.getRun('task-old');
  assert.equal(restoredOld.engine, 'cli', 'records from before dual-mode dispatch restore as cli runs');
  assert.equal(restoredOld.usage, null);
  assert.equal(restoredOld.thinking, null);
  reborn.shutdown();
  nativeSup.shutdown();
  console.log('✔ Native run records and their usage survive a restart; legacy records are normalized.');

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
