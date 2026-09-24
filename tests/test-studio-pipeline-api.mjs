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
import { ContractGovernor } from '../src/governor/index.ts';

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

// Grounded usage of past native runs on claude-opus-5-5 ($4 in / $20 out / $5 cache write / $0.20 cache read per MTok):
// 1000×4 + 500×20 + 2000×5 + 6000×0.2 = 25,200 µ$.
const TASK_A_ACTUAL = {
  model: 'claude-opus-5-5',
  turns: 2,
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationTokens: 2000,
  cacheReadTokens: 6000,
  thinkingTokens: 120,
  costUsd: 0.0252,
};

// Scripted stand-in for the Claude API: every native turn ends at once with fixed usage
// (1000×4 + 200×20 + 3000×5 = 23,000 µ$ on claude-opus-5-5).
const NATIVE_TURN_USAGE = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_creation_input_tokens: 3000,
  cache_read_input_tokens: 0,
  output_tokens_details: { thinking_tokens: 80 },
};
const nativeRequests = [];
function fakeAnthropicClient() {
  return {
    beta: {
      messages: {
        stream(params) {
          nativeRequests.push(params);
          const handlers = {};
          return {
            on(event, callback) {
              handlers[event] = callback;
              return this;
            },
            async finalMessage() {
              handlers.text?.('native agent: done');
              return {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                model: params.model,
                stop_reason: 'end_turn',
                stop_details: null,
                content: [{ type: 'text', text: 'native agent: done' }],
                usage: NATIVE_TURN_USAGE,
              };
            },
          };
        },
      },
    },
  };
}

const closeTo = (actual, expected, label, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: expected ${expected}, got ${actual}`);

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
          // task-g never completes (its verification fails), so task-e is permanently dependency-blocked.
          fixtureTask('task-e', 'blocked', 'security-auditor', {
            notes: 'Verification failed after 3 attempts',
            dependencies: ['task-g'],
          }),
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
  const record = (taskId, status, durationMs, tokens, actualUsage) => ({
    taskId,
    title: `Fixture ${taskId}`,
    assignedSubagent: 'backend',
    startedAt: '2026-09-01T00:00:00.000Z',
    ...(status === 'completed' ? { completedAt: '2026-09-01T00:01:00.000Z' } : {}),
    durationMs,
    status,
    ...(tokens ? { tokens } : {}),
    ...(actualUsage ? { actualUsage } : {}),
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
      record(
        'task-a',
        'completed',
        60000,
        { inputEstimated: 9000, outputEstimated: 3000, totalEstimated: 12000, costUsdEstimated: 0.06 },
        TASK_A_ACTUAL,
      ),
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

/** Runner events are interleaved per task and phase, so match on the decoded payload, not just the type. */
async function waitForRunnerEvent(stream, type, predicate, since, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  while (Date.now() < deadline) {
    for (const ev of stream.events.slice(since)) {
      if (ev.type !== type) continue;
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        assert.fail(`${stream.label}: "${type}" carried non-JSON data: ${ev.data.slice(0, 120)}`);
      }
      seen.push(`${data.taskId}:${data.status ?? data.stream}`);
      if (predicate(data)) return data;
    }
    if (stream.error) throw stream.error;
    if (stream.closed) assert.fail(`${stream.label}: SSE stream closed before ${label}`);
    await delay(25);
  }
  assert.fail(`${stream.label}: no "${type}" event matching ${label} within ${timeoutMs}ms (saw: [${seen.join(', ')}])`);
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
  const studio = await startStudioServer({
    port: 0,
    cwd: fullDir,
    connections: { dev: null, prod: null },
    supervisor: { anthropicClientFactory: fakeAnthropicClient },
  });
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

    // Grounded KPIs come from API-reported usage, not the estimate.
    closeTo(t.actualSpendUsd, 0.0252, 'telemetry.actualSpendUsd');
    assert.equal(t.cacheReadTokens, 6000);
    assert.equal(t.cacheCreationTokens, 2000);
    assert.equal(t.thinkingTokens, 120);
    // 6000 read / (1000 uncached + 2000 written + 6000 read)
    closeTo(t.cacheHitRate, 0.6667, 'telemetry.cacheHitRate', 1e-4);
    console.log('✔ GET /api/pipeline/status aggregates contracts, milestones, task velocity, telemetry and grounded spend KPIs');
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

  // ─── Autonomous agent dispatch ───────────────────────────────────────────────
  // Deterministic stand-ins for the `claude` runner, quoted for cmd.exe and POSIX shells alike.
  const mocksDir = path.join(fullDir, 'mocks');
  fs.mkdirSync(mocksDir, { recursive: true });
  fs.writeFileSync(
    path.join(mocksDir, 'runner-ok.mjs'),
    "process.stdout.write(`CWD:${process.cwd()}\\n`);\nprocess.stdout.write('agent: hello\\n');\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(mocksDir, 'runner-hang.mjs'),
    "process.stdout.write('agent: started\\n');\nsetInterval(() => {}, 1000);\n",
    'utf8',
  );
  const mockRunner = (name) => `"${process.execPath}" "${path.join(mocksDir, name)}"`;
  const dispatch = (payload) => requestJson(studio.url, 'POST', '/api/pipeline/tasks/dispatch', payload);

  // 12. POST /api/pipeline/tasks/dispatch — background runner with runner_log / runner_status SSE
  {
    await settle();
    const mark = alpha.events.length;
    const { status, body } = await dispatch({
      taskId: 'task-h',
      runnerCommand: mockRunner('runner-ok.mjs'),
      useWorktree: false,
      timeoutSeconds: 60,
    });
    assert.equal(status, 200, `dispatch task-h → HTTP ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    const { run } = body;
    assert.ok(run && typeof run === 'object', 'dispatch must return the run record');
    assert.equal(run.taskId, 'task-h');
    assert.equal(run.status, 'running', 'an in-place dispatch reports `running` once the process is spawned');
    assert.equal(typeof run.runId, 'string');
    assert.ok(run.runId.length > 0, 'runId identifies the execution across runs of the same task');
    assert.equal(typeof run.pid, 'number', 'the contract exposes the spawned PID');
    assert.equal(run.branch, null, 'useWorktree:false runs carry no agent branch');
    assert.equal(run.worktreeDir, fullDir, 'useWorktree:false runs execute at the project root');
    assert.ok(!Number.isNaN(Date.parse(run.startedAt)), 'startedAt must be an ISO timestamp');

    const logEvent = await waitForRunnerEvent(alpha, 'runner_log', (d) => d.taskId === 'task-h', mark, 'runner_log for task-h');
    assert.equal(logEvent.runId, run.runId, 'log chunks are tagged with the run they came from');
    assert.ok(['stdout', 'stderr'].includes(logEvent.stream), 'runner_log names the stream it came from');
    assert.equal(typeof logEvent.chunk, 'string');

    const finished = await waitForRunnerEvent(
      alpha,
      'runner_status',
      (d) => d.taskId === 'task-h' && d.status === 'completed',
      mark,
      'runner_status completed for task-h',
    );
    assert.equal(finished.exitCode, 0);
    assert.equal(finished.pid, null, 'a settled run releases its PID');
    assert.ok(finished.endedAt, 'a settled run records endedAt');
    console.log('✔ POST /api/pipeline/tasks/dispatch spawned a background runner and streamed runner_log/runner_status');
  }

  // 13. GET /api/pipeline/tasks/logs and /runs — buffered output, filtering and history
  {
    const logs = await getOk(studio.url, '/api/pipeline/tasks/logs?taskId=task-h');
    assert.equal(logs.taskId, 'task-h');
    assert.equal(logs.status, 'completed');
    assert.ok(logs.log.includes('agent: hello'), `log buffer must contain the runner output, got: ${logs.log.slice(0, 200)}`);
    assert.ok(logs.log.includes(`CWD:${fullDir}`), 'an in-place runner executes in the project root');
    assert.ok(logs.totalBytes > 0, 'totalBytes reports the captured size');

    const tailed = await getOk(studio.url, '/api/pipeline/tasks/logs?taskId=task-h&tailLines=1');
    assert.ok(tailed.log.split('\n').length <= 2, 'tailLines must bound the returned chunk');

    const { runs } = await getOk(studio.url, '/api/pipeline/tasks/runs');
    assert.ok(Array.isArray(runs), '"runs" must be an array');
    assert.ok(runs.some((r) => r.taskId === 'task-h' && r.status === 'completed'), 'finished runs stay in the recent history');

    const filtered = await getOk(studio.url, '/api/pipeline/tasks/runs?taskId=task-h');
    assert.equal(filtered.runs.length, 1, 'taskId filters the run list');
    assert.equal(filtered.runs[0].taskId, 'task-h');

    const active = await getOk(studio.url, '/api/pipeline/tasks/runs?activeOnly=true');
    assert.deepEqual(active.runs, [], 'activeOnly hides settled runs');
    console.log('✔ GET /api/pipeline/tasks/logs and /runs serve buffered output, filtering and run history');
  }

  // 14. POST /api/pipeline/tasks/abort — killswitch on a long-running agent
  {
    await settle();
    const mark = alpha.events.length;
    const started = await dispatch({
      taskId: 'task-g',
      runnerCommand: mockRunner('runner-hang.mjs'),
      useWorktree: false,
      timeoutSeconds: 120,
    });
    assert.equal(started.status, 200, `dispatch task-g → HTTP ${started.status}: ${JSON.stringify(started.body)}`);
    await waitForRunnerEvent(alpha, 'runner_log', (d) => d.taskId === 'task-g', mark, 'runner_log for task-g');

    const active = await getOk(studio.url, '/api/pipeline/tasks/runs?activeOnly=1');
    assert.equal(active.runs.length, 1, 'the hung runner must be listed as active');
    assert.equal(active.runs[0].taskId, 'task-g');
    assert.equal(active.runs[0].status, 'running');

    assertContractError(
      'dispatch while already running',
      await dispatch({ taskId: 'task-g', runnerCommand: mockRunner('runner-ok.mjs'), useWorktree: false }),
    );

    const aborted = await requestJson(studio.url, 'POST', '/api/pipeline/tasks/abort', {
      taskId: 'task-g',
      reason: 'operator cancelled',
    });
    assert.equal(aborted.status, 200, `abort task-g → HTTP ${aborted.status}: ${JSON.stringify(aborted.body)}`);
    assert.equal(aborted.body.ok, true);
    assert.equal(aborted.body.taskId, 'task-g');
    assert.equal(aborted.body.status, 'aborted');
    assert.ok(aborted.body.message.includes('operator cancelled'), 'the abort reason is echoed back to the operator');

    const settledRun = await waitForRunnerEvent(
      alpha,
      'runner_status',
      (d) => d.taskId === 'task-g' && d.status === 'aborted',
      mark,
      'runner_status aborted for task-g',
    );
    assert.equal(settledRun.abortReason, 'operator cancelled');
    assert.deepEqual((await getOk(studio.url, '/api/pipeline/tasks/runs?activeOnly=1')).runs, [], 'abort frees the runner slot');
    assertContractError('abort without a running task', await requestJson(studio.url, 'POST', '/api/pipeline/tasks/abort', { taskId: 'task-g' }));
    console.log('✔ POST /api/pipeline/tasks/abort terminated the agent process tree and broadcast the aborted phase');
  }

  // 15. Dispatch guard rails and log/run validation follow the { ok: false, error } contract
  {
    assertContractError('dispatch without taskId', await dispatch({}));
    assertContractError('dispatch unknown task', await dispatch({ taskId: 'task-does-not-exist', useWorktree: false }));
    assertContractError(
      'dispatch with unmet dependencies',
      await dispatch({ taskId: 'task-e', runnerCommand: mockRunner('runner-ok.mjs'), useWorktree: false }),
    );
    assertContractError('dispatch with a negative timeout', await dispatch({ taskId: 'task-h', timeoutSeconds: -1 }));
    assertContractError('dispatch with a non-string runnerCommand', await dispatch({ taskId: 'task-h', runnerCommand: 42 }));
    assertContractError('dispatch with a non-boolean useWorktree', await dispatch({ taskId: 'task-h', useWorktree: 'yes' }));
    assertContractError('logs without taskId', await requestJson(studio.url, 'GET', '/api/pipeline/tasks/logs'));
    assertContractError('logs for a task that never ran', await requestJson(studio.url, 'GET', '/api/pipeline/tasks/logs?taskId=task-b'));
    assertContractError('logs with tailLines=0', await requestJson(studio.url, 'GET', '/api/pipeline/tasks/logs?taskId=task-h&tailLines=0'));

    const wrongMethod = await requestJson(studio.url, 'GET', '/api/pipeline/tasks/dispatch');
    assert.equal(wrongMethod.status, 405, 'GET on the dispatch route is a method error, not a 404');
    assert.equal(wrongMethod.body.ok, false);
    assert.deepEqual((await getOk(studio.url, '/api/pipeline/tasks/runs?activeOnly=1')).runs, [], 'rejected dispatches must not spawn anything');
    console.log('✔ Dispatch, abort and log routes reject invalid payloads with HTTP 400 and never spawn a runner');
  }

  // 16. Worktree-isolated dispatch — agent branch, mounted contracts, and cleanup through the worktree API
  {
    await settle();
    const mark = alpha.events.length;
    const { status, body } = await dispatch({
      taskId: 'task-d',
      runnerCommand: mockRunner('runner-ok.mjs'),
      timeoutSeconds: 120,
    });
    assert.equal(status, 200, `worktree dispatch → HTTP ${status}: ${JSON.stringify(body)}`);

    const worktreeDir = path.join(fullDir, '.worktrees', 'task-task-d');
    assert.equal(body.run.branch, 'agent/task-task-d', 'isolated runs execute on the task agent branch');
    assert.equal(body.run.worktreeDir, worktreeDir);
    assert.ok(fs.existsSync(worktreeDir), 'the worktree must exist on disk before the runner starts');
    assert.ok(fs.existsSync(path.join(worktreeDir, '.ai')), '.ai contracts must be mounted into the worktree');

    await waitForRunnerEvent(
      alpha,
      'runner_status',
      (d) => d.taskId === 'task-d' && d.status === 'spawning_worktree',
      mark,
      'runner_status spawning_worktree for task-d',
    );
    await waitForRunnerEvent(
      alpha,
      'runner_status',
      (d) => d.taskId === 'task-d' && d.status === 'completed',
      mark,
      'runner_status completed for task-d',
    );

    const logs = await getOk(studio.url, `/api/pipeline/tasks/logs?taskId=task-d`);
    assert.ok(logs.log.includes(`CWD:${worktreeDir}`), `the runner must execute inside the worktree, got: ${logs.log.slice(0, 200)}`);

    const { worktrees } = await getOk(studio.url, '/api/pipeline/worktrees');
    assert.ok(worktrees.some((wt) => wt.taskId === 'task-d' && wt.isAgentWorktree), 'the dispatched worktree is listed for Mission Control');

    // GET /api/pipeline/worktrees/diff — uncommitted changes inside the isolated worktree
    assertContractError('diff without taskId', await requestJson(studio.url, 'GET', '/api/pipeline/worktrees/diff'));
    assertContractError('diff with invalid taskId', await requestJson(studio.url, 'GET', '/api/pipeline/worktrees/diff?taskId=..%2Fetc'));
    assertContractError('diff for a task without a worktree', await requestJson(studio.url, 'GET', '/api/pipeline/worktrees/diff?taskId=task-no-wt'));

    const initialDiff = await getOk(studio.url, '/api/pipeline/worktrees/diff?taskId=task-d');
    assert.equal(initialDiff.taskId, 'task-d');
    assert.equal(initialDiff.branch, 'agent/task-task-d');
    assert.equal(typeof initialDiff.hasChanges, 'boolean');
    assert.ok(Array.isArray(initialDiff.filesChanged), '"filesChanged" must be an array');
    assert.equal(typeof initialDiff.diff, 'string');

    // An untracked file with spaces inside an untracked directory is reported by its full path.
    fs.mkdirSync(path.join(worktreeDir, 'diff probe'), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'diff probe', 'A B.txt'), 'worktree diff inspection\n', 'utf8');
    const dirtyDiff = await getOk(studio.url, '/api/pipeline/worktrees/diff?taskId=task-d');
    assert.equal(dirtyDiff.hasChanges, true, 'hasChanges must be true when the worktree has uncommitted files');
    assert.ok(dirtyDiff.filesChanged.includes('diff probe/A B.txt'), `filesChanged must list the exact path, got: ${JSON.stringify(dirtyDiff.filesChanged)}`);
    assert.ok(dirtyDiff.diff.includes('+worktree diff inspection'), 'the diff must include the untracked file contents as additions');

    // Staged additions and a modified rename (porcelain -z "RM new\0old") report the new paths only.
    const wtGit = (args) => execSync(`git ${args}`, { cwd: worktreeDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(worktreeDir, 'staged.txt'), 'staged content\n', 'utf8');
    wtGit('add staged.txt');
    fs.mkdirSync(path.join(worktreeDir, 'docs'), { recursive: true });
    wtGit('mv README.md "docs/READ ME.md"');
    fs.appendFileSync(path.join(worktreeDir, 'docs', 'READ ME.md'), 'edited line\n', 'utf8');
    const trackedDiff = await getOk(studio.url, '/api/pipeline/worktrees/diff?taskId=task-d');
    for (const file of ['staged.txt', 'docs/READ ME.md', 'diff probe/A B.txt']) {
      assert.ok(trackedDiff.filesChanged.includes(file), `filesChanged must list "${file}", got: ${JSON.stringify(trackedDiff.filesChanged)}`);
    }
    assert.ok(!trackedDiff.filesChanged.includes('README.md'), 'a rename must report its new path, not the original');
    assert.equal(new Set(trackedDiff.filesChanged).size, trackedDiff.filesChanged.length, 'filesChanged must not contain duplicates');
    assert.ok(trackedDiff.diff.includes('+staged content'), 'staged additions must appear in the diff');
    assert.ok(trackedDiff.diff.includes('+edited line'), 'modifications to a renamed file must appear in the diff');
    console.log('✔ GET /api/pipeline/worktrees/diff reports uncommitted worktree changes and rejects unknown worktrees');

    const removed = await requestJson(studio.url, 'POST', '/api/pipeline/worktrees/action', { action: 'remove', taskId: 'task-d' });
    assert.equal(removed.status, 200, `worktree remove → HTTP ${removed.status}: ${JSON.stringify(removed.body)}`);
    assert.ok(!fs.existsSync(worktreeDir), 'the worktree is discarded without touching the mounted contracts');
    assert.ok(fs.existsSync(path.join(fullDir, '.ai', 'master_plan.json')), 'removing the worktree must never follow the .ai mount');
    console.log('✔ Worktree-isolated dispatch ran on the agent branch with mounted contracts, then cleaned up');
  }

  // 17. Loopback guard covers the pipeline and SSE routes (DNS rebinding / cross-site)
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

  // 18. Dual-mode dispatch: the native engine streams runner_token_usage and grounds telemetry in API usage
  {
    assertContractError('dispatch with an unknown runnerEngine', await dispatch({ taskId: 'task-c', runnerEngine: 'gpt' }));
    assertContractError(
      'dispatch with a negative thinkingBudget',
      await dispatch({ taskId: 'task-c', runnerEngine: 'native', thinkingBudget: -1 }),
    );
    assertContractError('dispatch with a malformed model', await dispatch({ taskId: 'task-c', runnerEngine: 'native', model: 'rm -rf /' }));
    assert.equal(nativeRequests.length, 0, 'rejected native dispatches must never reach the Claude API');

    await settle();
    const mark = alpha.events.length;
    const { status, body } = await dispatch({
      taskId: 'task-c',
      runnerEngine: 'native',
      model: 'claude-opus-5-5',
      thinkingBudget: 4000,
      useWorktree: false,
      timeoutSeconds: 60,
    });
    assert.equal(status, 200, `native dispatch → HTTP ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.run.engine, 'native');
    assert.equal(body.run.model, 'claude-opus-5-5');
    assert.deepEqual(body.run.thinking, { budget: 4000, effort: 'high', budgetTokens: null }, 'a 4k (Deep) budget maps to high effort');

    const usage = await waitForRunnerEvent(
      alpha,
      'runner_token_usage',
      (d) => d.taskId === 'task-c',
      mark,
      'runner_token_usage for task-c',
    );
    assert.equal(usage.runId, body.run.runId, 'usage events are tagged with their run');
    assert.equal(usage.model, 'claude-opus-5-5', 'usage names the model that served the turn');
    assert.equal(usage.turn, 1);
    assert.deepEqual(
      [usage.delta.inputTokens, usage.delta.outputTokens, usage.delta.cacheCreationTokens, usage.delta.cacheReadTokens, usage.delta.thinkingTokens],
      [1000, 200, 3000, 0, 80],
      'the delta carries the API-reported counters verbatim',
    );
    closeTo(usage.total.costUsd, 0.023, 'runner_token_usage total.costUsd');
    assert.equal(usage.total.cacheHitRate, 0);

    const finished = await waitForRunnerEvent(
      alpha,
      'runner_status',
      (d) => d.taskId === 'task-c' && d.status === 'completed',
      mark,
      'runner_status completed for task-c',
    );
    assert.equal(finished.usage.turns, 1, 'runner_status carries the accumulated usage');
    assert.equal(finished.usage.cacheHitRate, 0, 'runner records expose the derived cache hit rate');

    const request = nativeRequests.at(-1);
    assert.deepEqual(request.output_config, { effort: 'high' });
    assert.deepEqual(request.cache_control, { type: 'ephemeral' }, 'native requests opt into prompt caching');
    assert.equal(request.thinking?.type, 'adaptive');

    const runs = await getOk(studio.url, '/api/pipeline/tasks/runs?taskId=task-c');
    assert.equal(runs.runs[0].engine, 'native');
    closeTo(runs.runs[0].usage.costUsd, 0.023, 'runs[0].usage.costUsd');

    // Usage is folded into telemetry.json after the run settles; the KPIs are read from there.
    const deadline = Date.now() + 10_000;
    let pipeline;
    do {
      ({ pipeline } = await getOk(studio.url, '/api/pipeline/status'));
      if (Math.abs(pipeline.telemetry.actualSpendUsd - 0.0482) < 1e-9) break;
      await delay(100);
    } while (Date.now() < deadline);
    closeTo(pipeline.telemetry.actualSpendUsd, 0.0482, 'actualSpendUsd after the native run (task-a + task-c)');
    assert.equal(pipeline.telemetry.cacheCreationTokens, 5000);
    assert.equal(pipeline.telemetry.thinkingTokens, 200);
    // 6000 read / (2000 uncached + 5000 written + 6000 read)
    closeTo(pipeline.telemetry.cacheHitRate, 0.4615, 'cacheHitRate after the native run', 1e-4);
    console.log('✔ Native dispatch streamed runner_token_usage over SSE and grounded the spend KPIs in API usage');
  }

  // 19. GET /api/pipeline/telemetry/detailed — per-task financial audit
  {
    const { summary, taskBreakdowns } = await getOk(studio.url, '/api/pipeline/telemetry/detailed');
    closeTo(summary.actual.spendUsd, 0.0482, 'summary.actual.spendUsd');
    assert.equal(summary.actual.turns, 3);
    assert.equal(typeof summary.estimated.costUsd, 'number', 'the heuristic estimate is reported alongside actual spend');
    assert.equal(summary.byModel.length, 1, 'all grounded usage so far ran on one model');
    assert.equal(summary.byModel[0].model, 'claude-opus-5-5');
    assert.ok(Array.isArray(taskBreakdowns), '"taskBreakdowns" must be an array');

    assert.deepEqual(taskBreakdowns.slice(0, 2).map((b) => b.taskId), ['task-a', 'task-c'], 'the most expensive tasks come first');
    const [a] = taskBreakdowns;
    assert.equal(a.status, 'completed');
    // The native run's telemetry write re-priced the stored estimate at current Opus 5.5 rates:
    // 9,000 in × $4 + 3,000 out × $20 = $0.096 (the fixture's hand-written $0.06 is replaced).
    closeTo(a.estimated.costUsd, 0.096, 'task-a estimated cost');
    closeTo(a.varianceUsd, -0.0708, 'task-a variance (actual − estimate)');
    closeTo(a.actual.cacheHitRate, 0.6667, 'task-a cache hit rate', 1e-4);
    // 6000 cache reads on Opus 5.5 billed at $0.20 instead of $4.00 per MTok.
    closeTo(summary.actual.cacheSavingsUsd, 0.0228, 'summary.actual.cacheSavingsUsd (priced server-side)');

    const c = taskBreakdowns.find((b) => b.taskId === 'task-c');
    assert.ok(c.runs.some((r) => r.engine === 'native' && r.usage?.turns === 1), 'task-c lists its native run with usage');
    const h = taskBreakdowns.find((b) => b.taskId === 'task-h');
    assert.ok(h, 'tasks with runs but no telemetry record are still audited');
    assert.equal(h.actual, null, 'cli runs report no grounded usage');
    assert.ok(h.runs.every((r) => r.engine === 'cli' && r.usage === null));
    console.log('✔ GET /api/pipeline/telemetry/detailed pairs estimates with grounded usage per task and run');
  }

  // 20. Self-healing escalations — 3-strike trips file sandbox-verified proposals; approve applies + unblocks, reject dismisses
  {
    const dbPath = path.join(fullDir, '.ai', 'db_schema.json');
    writeJsonAtomic(dbPath, {
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'UUID', primaryKey: true, nullable: false },
            { name: 'email', type: 'TEXT', nullable: false },
            { name: 'legacy_flag', type: 'BOOLEAN', nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });
    const listEscalations = (query = '') => getOk(studio.url, `/api/pipeline/escalations${query}`);
    const resolve = (payload) => requestJson(studio.url, 'POST', '/api/pipeline/escalations/resolve', payload);
    const trip = async (taskId, column) => {
      for (let i = 0; i < 3; i++) {
        ContractGovernor.evaluate(fullDir, { taskId, target: 'db_schema', operation: 'DROP', path: `users.columns.${column}`, reason: `drop ${column}` });
      }
      await delay(20); // escalation ids and timestamps are time-based
    };

    assert.deepEqual((await listEscalations()).escalations, [], 'no escalation.json yet → an empty list, not an error');

    await trip('task-f', 'email');
    await trip('task-h', 'legacy_flag');
    assert.equal(readPlanTask(fullDir, 'task-h').status, 'blocked', 'the third strike blocks the task');

    const { escalations } = await listEscalations();
    assert.equal(escalations.length, 2);
    const escF = escalations.find((e) => e.taskId === 'task-f');
    const escH = escalations.find((e) => e.taskId === 'task-h');
    assert.equal(escalations[0].id, escH.id, 'escalations are listed newest first');
    for (const esc of [escF, escH]) {
      assert.equal(esc.status, 'pending_review');
      assert.equal(esc.proposedPatch?.kind, 'contract_patch', `${esc.taskId} carries a self-healing proposal`);
      assert.equal(esc.proposedPatch.strategy, 'deprecate_instead_of_drop');
      assert.equal(esc.proposedPatch.requiresHumanApproval, true);
      assert.equal(esc.proposedPatch.verificationProof.isolated, true);
      assert.equal(esc.proposedPatch.verificationProof.passed, true, 'only sandbox-verified candidates are proposed');
    }
    assert.equal((await listEscalations('?status=pending_review')).escalations.length, 2);
    assert.deepEqual((await listEscalations('?status=resolved')).escalations, []);
    assertContractError('escalations with an unknown status filter', await requestJson(studio.url, 'GET', '/api/pipeline/escalations?status=bogus'));

    assertContractError('resolve without escalationId', await resolve({ decision: 'approve' }));
    assertContractError('resolve with an unknown decision', await resolve({ escalationId: escF.id, decision: 'maybe' }));
    assertContractError('resolve an unknown escalation', await resolve({ escalationId: 'esc-missing', decision: 'approve' }));
    assertContractError('resolve with non-string notes', await resolve({ escalationId: escF.id, decision: 'approve', notes: 5 }));

    // Approve: the proven candidate is applied, the breaker reset and the task unblocked — streamed as plan_change.
    await settle();
    const mark = alpha.events.length;
    const approved = await resolve({ escalationId: escF.id, decision: 'approve', notes: 'Deprecate, never drop' });
    assert.equal(approved.status, 200, `approve → HTTP ${approved.status}: ${JSON.stringify(approved.body)}`);
    assert.equal(approved.body.ok, true);
    assert.equal(approved.body.unblockedTaskId, 'task-f');
    assert.equal(typeof approved.body.message, 'string');
    await waitForEvent(alpha, 'plan_change', mark);

    assert.equal(readPlanTask(fullDir, 'task-f').status, 'pending', 'approval unblocks the task for re-dispatch');
    const email = JSON.parse(fs.readFileSync(dbPath, 'utf8')).tables[0].columns.find((col) => col.name === 'email');
    assert.deepEqual({ nullable: email.nullable, deprecated: email.deprecated }, { nullable: true, deprecated: true }, 'the column is deprecated, never dropped');
    const taskF = (await getOk(studio.url, '/api/pipeline/tasks')).milestones.flatMap((m) => m.tasks).find((t) => t.id === 'task-f');
    assert.equal(taskF.circuitBreaker.consecutiveFailures, 0, 'approval resets the circuit breaker');

    const [resolvedF] = (await listEscalations('?status=resolved')).escalations;
    assert.equal(resolvedF.id, escF.id);
    assert.equal(resolvedF.status, 'resolved');
    assert.equal(resolvedF.resolutionNotes, 'Deprecate, never drop');
    assert.equal(resolvedF.resolution.proposalApplied, true);
    assertContractError('resolving the same escalation twice', await resolve({ escalationId: escF.id, decision: 'approve' }));

    // escH was proven against the contract before escF changed it: approval must refuse instead of applying blindly.
    const stale = await resolve({ escalationId: escH.id, decision: 'approve' });
    assertContractError('approving a stale proposal', stale);
    assert.match(stale.body.error, /changed after proposal/);
    assert.equal((await listEscalations('?status=pending_review')).escalations[0]?.id, escH.id, 'a refused approval leaves the escalation pending');
    assert.equal(readPlanTask(fullDir, 'task-h').status, 'blocked');

    const rejected = await resolve({ escalationId: escH.id, decision: 'reject' });
    assert.equal(rejected.status, 200, `reject → HTTP ${rejected.status}: ${JSON.stringify(rejected.body)}`);
    assert.equal(rejected.body.unblockedTaskId, null);
    assert.equal(readPlanTask(fullDir, 'task-h').status, 'blocked', 'rejecting a proposal keeps the task blocked');
    const closed = (await listEscalations('?status=resolved')).escalations;
    assert.equal(closed.length, 2, '"resolved" lists every closed escalation');
    assert.equal(closed.find((e) => e.id === escH.id).status, 'dismissed');

    const wrongMethod = await requestJson(studio.url, 'GET', '/api/pipeline/escalations/resolve');
    assert.equal(wrongMethod.status, 405, 'GET on the resolve route is a method error, not a 404');
    console.log('✔ Escalations list sandbox-verified proposals; approve applies + unblocks, stale proofs are refused, reject dismisses');
  }

  // 21. Sparse, non-git project: missing contracts/telemetry/benchmarks degrade gracefully
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
    assert.equal(pipeline.telemetry.actualSpendUsd, 0);
    assert.equal(pipeline.telemetry.cacheReadTokens, 0);
    assert.equal(pipeline.telemetry.cacheHitRate, 0);

    const detailed = await getOk(sparse.url, '/api/pipeline/telemetry/detailed');
    assert.deepEqual(detailed.taskBreakdowns, [], 'no telemetry and no runs → no breakdowns');
    assert.equal(detailed.summary.actual.spendUsd, 0);
    assert.deepEqual((await getOk(sparse.url, '/api/pipeline/escalations')).escalations, []);

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
