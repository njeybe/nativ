import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Run with `npx tsx tests/test-studio-pipeline-api.mjs`: the studio server is imported from
// TypeScript source so the Mission Control endpoints are verified without a build step.
import { startStudioServer } from '../src/server/studio-server.ts';

console.log('--- Starting Studio Mission Control Pipeline API & SSE Verification ---');

// A hung SSE stream or leaked fs.watch handle must fail the run instead of stalling CI.
setTimeout(() => {
  console.error('\n✖ Studio pipeline suite exceeded 120s (hung request, SSE stream or watcher).');
  process.exit(1);
}, 120_000).unref();

// Keep git discovery inside the fixtures so the non-git fixture is deterministic.
process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync(os.tmpdir());

const PASSING_VERIFY = 'node -e "process.exit(0)"';
const FAILING_VERIFY = 'node -e "process.exit(3)"';
const EVENT_TIMEOUT_MS = 5000;
const tempDirs = [];
const servers = [];
const streams = [];

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function fixtureTask(id, status, assignedSubagent, extra = {}) {
  return {
    id,
    title: `Fixture ${id}`,
    description: `Pipeline fixture task ${id}`,
    assignedSubagent,
    dependencies: [],
    targetFiles: [`src/${id}.ts`],
    status,
    verificationCommand: PASSING_VERIFY,
    notes: '',
    ...extra,
  };
}

/**
 * 3 milestones (completed / in_progress / pending) and 8 tasks:
 * 2 completed, 1 in_progress, 4 pending, 1 blocked → 25% progress.
 */
function buildPlan() {
  return {
    version: '1.0.0',
    projectName: 'studio-pipeline-fixture',
    lastUpdated: '2026-09-01T00:00:00.000Z',
    overallStatus: 'in_progress',
    activeMilestoneId: 'm2',
    milestones: [
      {
        id: 'm1',
        name: 'Foundation',
        status: 'completed',
        tasks: [fixtureTask('task-a', 'completed', 'backend'), fixtureTask('task-b', 'completed', 'database')],
      },
      {
        id: 'm2',
        name: 'Pipeline Dashboard',
        status: 'in_progress',
        tasks: [
          fixtureTask('task-c', 'in_progress', 'frontend'),
          fixtureTask('task-d', 'pending', 'qa-tester', { dependencies: ['task-a'] }),
          fixtureTask('task-e', 'blocked', 'security-auditor', { notes: 'Verification failed after 3 attempts' }),
          fixtureTask('task-f', 'pending', 'backend'),
        ],
      },
      {
        id: 'm3',
        name: 'Hardening',
        status: 'pending',
        tasks: [
          fixtureTask('task-g', 'pending', 'devops-agent', { verificationCommand: FAILING_VERIFY }),
          fixtureTask('task-h', 'pending', 'qa-tester'),
        ],
      },
    ],
  };
}

/** Self-consistent with recomputeTelemetrySummary(): 3 records, 2 completed. */
function buildTelemetry() {
  const record = (taskId, status, durationMs, tokens) => ({
    taskId,
    title: `Fixture ${taskId}`,
    assignedSubagent: 'backend',
    startedAt: '2026-09-01T00:00:00.000Z',
    ...(status === 'completed' ? { completedAt: '2026-09-01T00:01:00.000Z' } : {}),
    durationMs,
    status,
    ...(tokens ? { tokens } : {}),
  });
  return {
    version: '1.0.0',
    projectName: 'studio-pipeline-fixture',
    lastUpdated: '2026-09-01T00:00:00.000Z',
    modelTierDefault: 'claude-3-7-sonnet',
    summary: {
      totalTasksCompleted: 2,
      totalDurationMs: 90000,
      estimatedTotalTokens: 20000,
      estimatedTotalCostUsd: 0.1,
      verificationPassRate: 0.75,
      totalVerificationsRun: 4,
      totalVerificationsPassed: 3,
      circuitBreakerTrips: 1,
    },
    tasks: [
      record('task-a', 'completed', 60000, { inputEstimated: 9000, outputEstimated: 3000, totalEstimated: 12000, costUsdEstimated: 0.06 }),
      record('task-b', 'completed', 30000, { inputEstimated: 6000, outputEstimated: 2000, totalEstimated: 8000, costUsdEstimated: 0.04 }),
      record('task-c', 'in_progress', 0),
    ],
  };
}

function buildBenchmarkReport() {
  return {
    version: '1.0.0',
    timestamp: '2026-09-01T12:00:00.000Z',
    environment: { platform: 'fixture', nodeVersion: 'v0.0.0', cpuCount: 1, arch: 'x64' },
    summary: {
      totalScenarios: 5,
      passedScenarios: 4,
      failedScenarios: 1,
      score: 80,
      totalDurationMs: 4321,
      totalOperations: 60,
      averageThroughputOpsPerSec: 123.4,
    },
    scenarios: [],
  };
}

function writeJsonAtomic(file, value) {
  // Same tmp-file + rename pattern as savePlan()/saveTelemetry(), so watchers see real-world writes.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 20 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function createFixture(prefix, { full }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'context.md'), '# Context\n', 'utf8');

  if (!full) {
    writeJsonAtomic(path.join(aiDir, 'master_plan.json'), {
      ...buildPlan(),
      activeMilestoneId: 'm1',
      milestones: [{ id: 'm1', name: 'Solo', status: 'pending', tasks: [fixtureTask('task-solo', 'pending', 'backend')] }],
    });
    return dir;
  }

  writeJsonAtomic(path.join(aiDir, 'master_plan.json'), buildPlan());
  writeJsonAtomic(path.join(aiDir, 'telemetry.json'), buildTelemetry());
  writeJsonAtomic(path.join(aiDir, 'benchmark_report.json'), buildBenchmarkReport());
  writeJsonAtomic(path.join(aiDir, 'db_schema.json'), { tables: [] });
  writeJsonAtomic(path.join(aiDir, 'api_contracts.json'), { endpoints: [] });
  fs.writeFileSync(path.join(aiDir, 'ui_specs.md'), '# UI Specs\n', 'utf8');

  const git = (args) => execSync(`git ${args}`, { cwd: dir, stdio: 'ignore' });
  git('init -q');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Studio pipeline fixture\n', 'utf8');
  git('add README.md');
  git('-c user.name="Studio Test" -c user.email=studio@nativ.dev -c commit.gpgsign=false commit -q -m "initial commit"');
  return dir;
}

function readPlanTask(dir, taskId) {
  const plan = JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));
  return plan.milestones.flatMap((m) => m.tasks).find((t) => t.id === taskId);
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(baseUrl, method, pathname, payload) {
  const init = { method };
  if (payload !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(payload);
  }
  const res = await withTimeout(fetch(`${baseUrl}${pathname}`, init), 60_000, `${method} ${pathname}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(`${method} ${pathname} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, headers: res.headers, body };
}

async function getOk(baseUrl, pathname) {
  const { status, headers, body } = await requestJson(baseUrl, 'GET', pathname);
  assert.equal(status, 200, `GET ${pathname} → HTTP ${status}: ${JSON.stringify(body)}`);
  assert.match(headers.get('content-type') ?? '', /^application\/json/, `GET ${pathname} must return JSON`);
  assert.equal(body.ok, true, `GET ${pathname} must return { ok: true, ... }`);
  return body;
}

function assertContractError(label, { status, body }) {
  assert.equal(status, 400, `${label} → expected HTTP 400, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, false, `${label} → contract error body is { ok: false, error: string }`);
  assert.equal(typeof body.error, 'string', `${label} → "error" must be a string message, got ${JSON.stringify(body.error)}`);
  assert.ok(body.error.length > 0, `${label} → "error" must not be empty`);
}

/** node:http request so Host/Origin can be forged (fetch forbids overriding Host). */
function rawRequest(port, { method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error(`${method} ${pathname} did not complete within 3s (stream left open?)`)));
    req.end(body);
  });
}

// ─── SSE client (mirrors browser EventSource parsing) ──────────────────────────

function openEventStream(baseUrl, label) {
  const controller = new AbortController();
  const stream = { label, events: [], dataless: [], comments: 0, closed: false, error: null };
  stream.abort = () => controller.abort();
  stream.ready = fetch(`${baseUrl}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  }).then((res) => {
    stream.response = res;
    if (res.ok && res.body) pumpEvents(res.body, stream);
    return res;
  });
  // Aborting a stream whose headers never arrived must not surface as an unhandled rejection.
  stream.ready.catch(() => {});
  streams.push(stream);
  return stream;
}

async function pumpEvents(body, stream) {
  const decoder = new TextDecoder();
  let buffer = '';
  let type = '';
  let data = [];
  let hasData = false;
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let match = /\r\n|\r|\n/.exec(buffer); match; match = /\r\n|\r|\n/.exec(buffer)) {
        // A trailing CR may be the first half of a CRLF split across chunks.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          // Per the SSE spec, EventSource only dispatches events that carried a data: field.
          if (hasData) stream.events.push({ type: type || 'message', data: data.join('\n') });
          else if (type) stream.dataless.push(type);
          type = '';
          data = [];
          hasData = false;
        } else if (line.startsWith(':')) {
          stream.comments++;
        } else {
          const idx = line.indexOf(':');
          const field = idx === -1 ? line : line.slice(0, idx);
          let value = idx === -1 ? '' : line.slice(idx + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') type = value;
          else if (field === 'data') {
            data.push(value);
            hasData = true;
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') stream.error = err;
  } finally {
    stream.closed = true;
  }
}

async function waitForEvent(stream, type, since, timeoutMs = EVENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = stream.events.slice(since).find((ev) => ev.type === type);
    if (hit) return hit;
    if (stream.error) throw stream.error;
    if (stream.closed) assert.fail(`${stream.label}: SSE stream closed before a "${type}" event arrived`);
    await delay(25);
  }
  const seen = stream.events.slice(since).map((ev) => ev.type);
  const hint = stream.dataless.includes(type)
    ? ` "${type}" was sent without a data: line, which EventSource silently drops.`
    : '';
  assert.fail(`${stream.label}: no "${type}" event within ${timeoutMs}ms (saw: [${seen.join(', ')}]).${hint}`);
}

async function connectStream(baseUrl, label) {
  const stream = openEventStream(baseUrl, label);
  const res = await withTimeout(
    stream.ready,
    3000,
    `${label}: GET /api/events response headers (flush headers immediately, e.g. res.flushHeaders())`,
  );
  assert.equal(res.status, 200, `${label}: GET /api/events → HTTP ${res.status}`);
  assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/, `${label}: SSE must use Content-Type text/event-stream`);
  return stream;
}

/** Lets watchers attach and any debounced burst from a previous write drain before the next mutation. */
const settle = () => delay(400);

// ─── Suite ─────────────────────────────────────────────────────────────────────

try {
  const fullDir = createFixture('nativ-studio-pipeline-', { full: true });
  const studio = await startStudioServer({ port: 0, cwd: fullDir, connections: { dev: null, prod: null } });
  servers.push(studio);
  console.log('✔ Studio server started against pipeline fixture:', studio.url);

  // 1. GET /api/pipeline/status — aggregated health matches the fixture plan & telemetry
  {
    const { pipeline } = await getOk(studio.url, '/api/pipeline/status');
    assert.ok(pipeline && typeof pipeline === 'object', 'status body must include a "pipeline" object');
    assert.equal(typeof pipeline.version, 'string', 'pipeline.version must be a string');
    assert.ok(pipeline.version.length > 0, 'pipeline.version must not be empty');
    assert.deepEqual(pipeline.contracts, {
      masterPlanExists: true,
      contextExists: true,
      dbSchemaExists: true,
      apiContractsExists: true,
      uiSpecsExists: true,
    });
    assert.deepEqual(pipeline.milestones, { total: 3, completed: 1, inProgress: 1, pending: 1 });

    const { progressPercentage, ...taskCounts } = pipeline.tasks;
    assert.deepEqual(taskCounts, { total: 8, completed: 2, inProgress: 1, pending: 4, blocked: 1 });
    assert.equal(typeof progressPercentage, 'number', 'tasks.progressPercentage must be a number');
    assert.ok(Math.abs(progressPercentage - 25) <= 0.5, `2/8 tasks completed → ~25%, got ${progressPercentage}`);

    const t = pipeline.telemetry;
    assert.equal(t.totalTokens, 20000, 'telemetry.totalTokens comes from the telemetry summary');
    assert.ok(Math.abs(t.estimatedCostUsd - 0.1) < 1e-9, `telemetry.estimatedCostUsd should be 0.1, got ${t.estimatedCostUsd}`);
    assert.equal(t.totalTasksTracked, 3, 'telemetry.totalTasksTracked is the number of task records in telemetry.json');
    assert.ok(t.passRate === 0.75 || t.passRate === 75, `telemetry.passRate should be 0.75 (or 75%), got ${t.passRate}`);
    assert.equal(t.circuitBreakerTrips, 1);
    console.log('✔ GET /api/pipeline/status aggregates contracts, milestones, task velocity and telemetry KPIs');
  }

  // 2. GET /api/pipeline/tasks — milestones with tasks, subagents and verification commands
  {
    const { milestones } = await getOk(studio.url, '/api/pipeline/tasks');
    assert.ok(Array.isArray(milestones), '"milestones" must be an array');
    assert.deepEqual(milestones.map((m) => m.id), ['m1', 'm2', 'm3']);
    assert.deepEqual(milestones.map((m) => m.name), ['Foundation', 'Pipeline Dashboard', 'Hardening']);
    assert.deepEqual(milestones[1].tasks.map((t) => t.id), ['task-c', 'task-d', 'task-e', 'task-f']);

    const blocked = milestones[1].tasks.find((t) => t.id === 'task-e');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.assignedSubagent, 'security-auditor');
    assert.equal(blocked.verificationCommand, PASSING_VERIFY);
    assert.deepEqual(blocked.targetFiles, ['src/task-e.ts'], 'task cards need targetFiles for the scoped file pill list');
    assert.equal(milestones[2].tasks.find((t) => t.id === 'task-g').verificationCommand, FAILING_VERIFY);
    console.log('✔ GET /api/pipeline/tasks lists milestones, subagent assignments and verification commands');
  }

  // 3. GET /api/pipeline/worktrees — git worktree list for the fixture repository
  {
    const { worktrees } = await getOk(studio.url, '/api/pipeline/worktrees');
    assert.ok(Array.isArray(worktrees), '"worktrees" must be an array');
    assert.ok(worktrees.length >= 1, 'the fixture is a git repository, so its main worktree must be listed');
    for (const wt of worktrees) assert.ok(wt && typeof wt === 'object', 'each worktree entry must be an object');
    console.log(`✔ GET /api/pipeline/worktrees returned ${worktrees.length} worktree(s)`);
  }

  // 4. GET /api/pipeline/benchmarks — cached .ai/benchmark_report.json
  {
    const { report } = await getOk(studio.url, '/api/pipeline/benchmarks');
    assert.ok(report && typeof report === 'object', 'report must be the cached benchmark_report.json object');
    assert.equal(report.timestamp, '2026-09-01T12:00:00.000Z');
    assert.equal(report.summary.score, 80);
    assert.equal(report.summary.averageThroughputOpsPerSec, 123.4);
    console.log('✔ GET /api/pipeline/benchmarks serves the cached benchmark report');
  }

  // 5. GET /api/events — SSE handshake, plan_change / telemetry_change broadcasts
  const planPath = path.join(fullDir, '.ai', 'master_plan.json');
  const telemetryPath = path.join(fullDir, '.ai', 'telemetry.json');
  const alpha = await connectStream(studio.url, 'SSE client A');
  const beta = await connectStream(studio.url, 'SSE client B');
  await settle();
  console.log('✔ GET /api/events opened two text/event-stream connections');

  {
    const markA = alpha.events.length;
    const markB = beta.events.length;
    writeJsonAtomic(planPath, { ...buildPlan(), lastUpdated: new Date().toISOString() });
    await waitForEvent(alpha, 'plan_change', markA);
    await waitForEvent(beta, 'plan_change', markB);
    console.log('✔ Atomic master_plan.json write broadcast plan_change to every connected client');
  }

  {
    await settle();
    const mark = alpha.events.length;
    writeJsonAtomic(planPath, { ...buildPlan(), lastUpdated: new Date().toISOString() });
    await waitForEvent(alpha, 'plan_change', mark);
    console.log('✔ Watcher survives rename-replace: a second plan write emitted plan_change again');
  }

  {
    await settle();
    const mark = alpha.events.length;
    writeJsonAtomic(telemetryPath, { ...buildTelemetry(), lastUpdated: new Date().toISOString() });
    await waitForEvent(alpha, 'telemetry_change', mark);
    console.log('✔ Atomic telemetry.json write emitted telemetry_change');
  }

  {
    // A client that goes away must be dropped without breaking the broadcast for the others.
    beta.abort();
    await settle();
    const mark = alpha.events.length;
    writeJsonAtomic(planPath, { ...buildPlan(), lastUpdated: new Date().toISOString() });
    await waitForEvent(alpha, 'plan_change', mark);
    await getOk(studio.url, '/api/pipeline/status');
    console.log('✔ Disconnected SSE client was pruned; remaining clients and the API stay healthy');
  }

  // 6. POST /api/pipeline/tasks/action — validation errors use the { ok: false, error } contract
  {
    const action = (payload) => requestJson(studio.url, 'POST', '/api/pipeline/tasks/action', payload);
    assertContractError('unknown action', await action({ action: 'explode', taskId: 'task-d' }));
    assertContractError('unknown taskId', await action({ action: 'start', taskId: 'task-does-not-exist' }));
    assertContractError('missing taskId', await action({ action: 'start' }));
    assert.equal(readPlanTask(fullDir, 'task-d').status, 'pending', 'rejected actions must not touch the plan');
    console.log('✔ POST /api/pipeline/tasks/action rejects invalid actions and unknown task IDs with HTTP 400');
  }

  // 7. Concurrent start + block both persist (plan lock prevents lost updates) and stream plan_change
  {
    await settle();
    const mark = alpha.events.length;
    const [started, blocked] = await Promise.all([
      requestJson(studio.url, 'POST', '/api/pipeline/tasks/action', { action: 'start', taskId: 'task-d' }),
      requestJson(studio.url, 'POST', '/api/pipeline/tasks/action', {
        action: 'block',
        taskId: 'task-f',
        reason: 'Waiting on upstream API',
      }),
    ]);
    assert.equal(started.status, 200, `start task-d → HTTP ${started.status}: ${JSON.stringify(started.body)}`);
    assert.equal(started.body.ok, true);
    assert.equal(started.body.task?.id, 'task-d', 'start must return the updated task');
    assert.equal(started.body.task?.status, 'in_progress');
    assert.equal(blocked.status, 200, `block task-f → HTTP ${blocked.status}: ${JSON.stringify(blocked.body)}`);
    assert.equal(blocked.body.task?.status, 'blocked');

    assert.equal(readPlanTask(fullDir, 'task-d').status, 'in_progress', 'start must persist to master_plan.json');
    assert.equal(readPlanTask(fullDir, 'task-f').status, 'blocked', 'block must persist alongside the concurrent start');
    assert.equal(readPlanTask(fullDir, 'task-f').notes, 'Waiting on upstream API', 'block reason is stored in task notes');
    await waitForEvent(alpha, 'plan_change', mark);
    console.log('✔ Concurrent start/block actions both persisted under the plan lock and streamed plan_change');
  }

  // 8. complete runs the verification gatekeeper — passing command completes, failing command is rejected
  {
    const completed = await requestJson(studio.url, 'POST', '/api/pipeline/tasks/action', { action: 'complete', taskId: 'task-c' });
    assert.equal(completed.status, 200, `complete task-c → HTTP ${completed.status}: ${JSON.stringify(completed.body)}`);
    assert.equal(completed.body.task?.status, 'completed');
    assert.equal(readPlanTask(fullDir, 'task-c').status, 'completed');

    const rejected = await requestJson(studio.url, 'POST', '/api/pipeline/tasks/action', { action: 'complete', taskId: 'task-g' });
    assert.notEqual(rejected.status, 200, 'a failing verificationCommand must not complete the task from the studio');
    assert.equal(rejected.body.ok, false);
    assert.equal(typeof rejected.body.error, 'string');
    assert.equal(readPlanTask(fullDir, 'task-g').status, 'pending', 'gatekeeper rejection leaves the task untouched');
    console.log('✔ complete action enforces the verification gatekeeper (pass → completed, fail → rejected)');
  }

  // 9. Status reflects the mutations (no stale cache after plan writes)
  {
    const { pipeline } = await getOk(studio.url, '/api/pipeline/status');
    const { progressPercentage, ...taskCounts } = pipeline.tasks;
    assert.deepEqual(taskCounts, { total: 8, completed: 3, inProgress: 1, pending: 2, blocked: 2 });
    assert.ok(Math.abs(progressPercentage - 37.5) <= 0.5, `3/8 tasks completed → ~37.5%, got ${progressPercentage}`);
    console.log('✔ GET /api/pipeline/status reflects task mutations immediately');
  }

  // 10. POST /api/pipeline/worktrees/action — rejected actions follow the error contract
  {
    const action = (payload) => requestJson(studio.url, 'POST', '/api/pipeline/worktrees/action', payload);
    assertContractError('unknown worktree action', await action({ action: 'nuke', taskId: 'task-c' }));
    assertContractError('merge without a worktree', await action({ action: 'merge', taskId: 'task-no-worktree' }));
    assertContractError('remove without a worktree', await action({ action: 'remove', taskId: 'task-no-worktree' }));
    console.log('✔ POST /api/pipeline/worktrees/action rejects unknown actions and missing worktrees with HTTP 400');
  }

  // 11. POST /api/pipeline/benchmarks/run — executes the synthetic matrix live
  {
    const { status, body } = await requestJson(studio.url, 'POST', '/api/pipeline/benchmarks/run', {});
    assert.equal(status, 200, `benchmarks/run → HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    assert.equal(body.ok, true);
    const { report } = body;
    assert.ok(report && typeof report === 'object', 'run must return the fresh report');
    assert.ok(Array.isArray(report.scenarios) && report.scenarios.length > 0, 'report.scenarios must list executed scenarios');
    assert.equal(report.scenarios.length, report.summary.totalScenarios);
    assert.equal(typeof report.summary.score, 'number');
    assert.notEqual(report.timestamp, '2026-09-01T12:00:00.000Z', 'run must execute live, not replay the cached report');
    console.log(`✔ POST /api/pipeline/benchmarks/run executed ${report.scenarios.length} scenarios (score ${report.summary.score}%)`);
  }

  // 12. Loopback guard covers the pipeline and SSE routes (DNS rebinding / cross-site)
  {
    const forgedHost = await rawRequest(studio.port, { pathname: '/api/pipeline/status', headers: { Host: 'evil.example' } });
    assert.equal(forgedHost.status, 403, 'non-loopback Host must be rejected on /api/pipeline/status');
    const forgedStream = await rawRequest(studio.port, {
      pathname: '/api/events',
      headers: { Host: 'evil.example', Accept: 'text/event-stream' },
    });
    assert.equal(forgedStream.status, 403, 'non-loopback Host must be rejected before an SSE stream opens');
    const crossSiteStream = await rawRequest(studio.port, {
      pathname: '/api/events',
      headers: { Host: `localhost:${studio.port}`, Origin: 'http://evil.example', Accept: 'text/event-stream' },
    });
    assert.equal(crossSiteStream.status, 403, 'cross-site EventSource must not subscribe to pipeline events');
    const crossSiteAction = await rawRequest(studio.port, {
      method: 'POST',
      pathname: '/api/pipeline/tasks/action',
      headers: { Host: `localhost:${studio.port}`, Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', taskId: 'task-h' }),
    });
    assert.equal(crossSiteAction.status, 403, 'cross-site POST must not mutate the plan');
    assert.equal(readPlanTask(fullDir, 'task-h').status, 'pending');
    console.log('✔ Loopback Host/Origin guard protects pipeline endpoints and the SSE stream');
  }

  // 13. Sparse, non-git project: missing contracts/telemetry/benchmarks degrade gracefully
  {
    const sparseDir = createFixture('nativ-studio-sparse-', { full: false });
    const sparse = await startStudioServer({ port: 0, cwd: sparseDir, connections: { dev: null, prod: null } });
    servers.push(sparse);

    const { pipeline } = await getOk(sparse.url, '/api/pipeline/status');
    assert.deepEqual(pipeline.contracts, {
      masterPlanExists: true,
      contextExists: true,
      dbSchemaExists: false,
      apiContractsExists: false,
      uiSpecsExists: false,
    });
    assert.deepEqual(pipeline.milestones, { total: 1, completed: 0, inProgress: 0, pending: 1 });
    assert.equal(pipeline.tasks.total, 1);
    assert.equal(pipeline.tasks.progressPercentage, 0);
    assert.equal(pipeline.telemetry.totalTokens, 0);
    assert.equal(pipeline.telemetry.estimatedCostUsd, 0);
    assert.equal(pipeline.telemetry.totalTasksTracked, 0);
    assert.equal(pipeline.telemetry.circuitBreakerTrips, 0);
    assert.equal(typeof pipeline.telemetry.passRate, 'number');

    const { report } = await getOk(sparse.url, '/api/pipeline/benchmarks');
    assert.equal(report, null, 'no benchmark_report.json → report: null');
    const { worktrees } = await getOk(sparse.url, '/api/pipeline/worktrees');
    assert.deepEqual(worktrees, [], 'a non-git project has no worktrees (and must not fail with 500)');
    console.log('✔ Sparse non-git project: missing contracts flagged, telemetry zeroed, report null, worktrees []');
  }

  assert.ok(
    !process.exitCode,
    `studio handlers leaked process.exitCode=${process.exitCode} into the server process ` +
      '(validate requests before delegating to CLI runners that set process.exitCode on failure)',
  );

  console.log('\n🎉 ALL STUDIO PIPELINE API & SSE TESTS PASSED!');
} finally {
  for (const stream of streams) stream.abort();
  for (const server of servers) {
    try {
      await withTimeout(server.close(), 5000, 'studio.close() (SSE clients, heartbeat timers and fs.watch handles must be released)');
    } catch (err) {
      console.error(`✖ ${err.message}`);
      process.exitCode = 1;
    }
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
  // Anything still keeping the event loop alive after the grace window is a leaked watcher, interval or socket.
  // The window is wide because runBenchmarks() leaves a proper-lockfile retry running for ~17s after it resolves.
  setTimeout(() => {
    const active = process.getActiveResourcesInfo().filter((r) => !['Timeout', 'PipeWrap', 'TTYWrap'].includes(r));
    console.error(
      '✖ Process still alive 30s after studio.close(): leaked fs.watch handle, heartbeat interval or SSE socket ' +
        `(active resources: ${active.join(', ') || 'timers only'}).`,
    );
    process.exit(1);
  }, 30_000).unref();
}
