import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
// Run via `npx tsx` (the task's verificationCommand): imports the TypeScript source, so no build is needed.
import { startStudioServer } from '../src/server/studio-server.ts';

console.log('--- Starting Studio Pipeline API & SSE Stream Verification ---');

let passed = 0;
function check(name) {
  passed++;
  console.log(`  ✔ ${name}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, cmd) =>
  execSync(`git -c user.name=nativ-test -c user.email=test@nativ.local -c commit.gpgsign=false ${cmd}`, { cwd, stdio: 'pipe' }).toString();

// ─── Sandbox project (never the real .ai/) ──────────────────────────────────────
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-studio-pipeline-'));
const projectDir = path.join(tmpBase, 'project');
const sharedAi = path.join(tmpBase, 'shared-ai');
fs.mkdirSync(projectDir);
fs.mkdirSync(sharedAi);
// Mount .ai/ as a junction/symlink like `nativ worktree create` does: fs.watch must see through it.
fs.symlinkSync(sharedAi, path.join(projectDir, '.ai'), 'junction');

const makeTask = (id, status, dependencies, verificationCommand) => ({
  id,
  title: `Task ${id}`,
  description: '',
  assignedSubagent: 'backend',
  dependencies,
  targetFiles: ['src/example.ts'],
  status,
  verificationCommand,
  notes: '',
});

const plan = {
  version: '1.0.0',
  projectName: 'pipeline-sandbox',
  lastUpdated: new Date().toISOString(),
  overallStatus: 'in_progress',
  activeMilestoneId: 'm1',
  milestones: [
    {
      id: 'm1',
      name: 'Milestone One',
      status: 'in_progress',
      tasks: [
        makeTask('t-pass', 'pending', [], 'node -e "process.exit(0)"'),
        makeTask('t-fail', 'pending', [], 'node -e "process.exit(3)"'),
        makeTask('t-done', 'completed', [], 'none'),
      ],
    },
    {
      id: 'm2',
      name: 'Milestone Two',
      status: 'pending',
      tasks: [makeTask('t-dep', 'pending', ['t-pass'], 'none'), makeTask('t-blocked', 'blocked', [], 'none')],
    },
  ],
};

fs.writeFileSync(path.join(sharedAi, 'master_plan.json'), JSON.stringify(plan, null, 2));
fs.writeFileSync(path.join(sharedAi, 'context.md'), '# Context\n');
fs.writeFileSync(
  path.join(sharedAi, 'telemetry.json'),
  JSON.stringify({
    version: '1.0.0',
    projectName: 'pipeline-sandbox',
    lastUpdated: '',
    modelTierDefault: 'claude-3-7-sonnet',
    summary: {
      totalTasksCompleted: 1,
      totalDurationMs: 5,
      estimatedTotalTokens: 4280,
      estimatedTotalCostUsd: 0.017,
      verificationPassRate: 0.75,
      totalVerificationsRun: 4,
      totalVerificationsPassed: 3,
      circuitBreakerTrips: 1,
    },
    tasks: [{ taskId: 't-done' }, { taskId: 't-other' }],
  }),
);
fs.writeFileSync(
  path.join(sharedAi, '.governor_ledger.json'),
  JSON.stringify({ 't-blocked': { consecutiveFailures: 3, lastFailureTime: '', patchCount: 3 } }),
);

fs.writeFileSync(path.join(projectDir, 'README.md'), 'sandbox\n');
fs.writeFileSync(path.join(projectDir, '.gitignore'), '.ai\n.worktrees\n');
git(projectDir, 'init -q -b main');
git(projectDir, 'add -A');
git(projectDir, 'commit -q -m init');
const doneWorktree = path.join(projectDir, '.worktrees', 'task-t-done');
git(projectDir, `worktree add -q "${path.join(projectDir, '.worktrees', 'task-t-dep')}" -b agent/task-t-dep`);
git(projectDir, `worktree add -q "${doneWorktree}" -b agent/task-t-done`);
fs.writeFileSync(path.join(doneWorktree, 'done.txt'), 'done\n');
git(doneWorktree, 'add -A');
git(doneWorktree, 'commit -q -m done');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal EventSource over fetch: collects parsed `event:`/`data:` frames. */
function openSse(url) {
  const controller = new AbortController();
  const events = [];
  const ready = fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } }).then((res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of frame.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) events.push({ event, data: JSON.parse(data), at: Date.now() });
          }
        }
      } catch {
        // Aborted by close().
      }
    })();
    return res;
  });

  const waitFor = async (event, since = 0, timeoutMs = 4000) => {
    const start = Date.now();
    for (;;) {
      const hit = events.find((e) => e.event === event && e.at >= since);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for SSE "${event}"`);
      await sleep(25);
    }
  };

  return { ready, events, waitFor, close: () => controller.abort() };
}

function rawStatus(port, requestPath, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

const studio = await startStudioServer({ port: 0, cwd: projectDir, connections: { dev: null, prod: null }, heartbeatMs: 250 });
const getJson = async (p, base = studio.url) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};
const postJson = async (p, body, headers = { 'Content-Type': 'application/json' }) => {
  const res = await fetch(studio.url + p, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const allTasks = (tasksBody) => tasksBody.milestones.flatMap((m) => m.tasks);

const sse = openSse(`${studio.url}/api/events`);
let studio2 = null;

try {
  // 1. Pipeline status
  {
    const { status, body } = await getJson('/api/pipeline/status');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const p = body.pipeline;
    assert.match(p.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(p.contracts, {
      masterPlanExists: true,
      contextExists: true,
      dbSchemaExists: false,
      apiContractsExists: false,
      uiSpecsExists: false,
    });
    assert.deepEqual(p.milestones, { total: 2, completed: 0, inProgress: 1, pending: 1 });
    assert.deepEqual(p.tasks, { total: 5, completed: 1, inProgress: 0, pending: 3, blocked: 1, progressPercentage: 20 });
    assert.deepEqual(p.telemetry, { totalTokens: 4280, estimatedCostUsd: 0.017, totalTasksTracked: 2, passRate: 0.75, circuitBreakerTrips: 1 });
    check('GET /api/pipeline/status aggregates contracts, milestones, tasks and telemetry KPIs');
  }

  // 2. Pipeline tasks
  {
    const { status, body } = await getJson('/api/pipeline/tasks');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.activeMilestoneId, 'm1');
    assert.equal(body.milestones.length, 2);
    assert.equal(body.milestones[0].progressPercentage, 33);
    const byId = Object.fromEntries(allTasks(body).map((t) => [t.id, t]));
    assert.equal(byId['t-pass'].isAvailable, true);
    assert.equal(byId['t-dep'].isAvailable, false, 't-dep waits on t-pass');
    assert.equal(byId['t-pass'].assignedSubagent, 'backend');
    assert.equal(byId['t-pass'].verificationCommand, 'node -e "process.exit(0)"');
    assert.deepEqual(byId['t-blocked'].circuitBreaker, { active: true, consecutiveFailures: 3, maxThreshold: 3, tripped: true });
    assert.equal(byId['t-pass'].circuitBreaker.consecutiveFailures, 0);
    check('GET /api/pipeline/tasks returns milestones with readiness and circuit-breaker attempts');
  }

  // 3. SSE stream + heartbeat
  {
    const res = await sse.ready;
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const heartbeat = await sse.waitFor('heartbeat');
    assert.ok(!Number.isNaN(Date.parse(heartbeat.data.at)));
    check('GET /api/events streams text/event-stream with heartbeat events');
  }

  // 4. Task action validation
  {
    let r = await postJson('/api/pipeline/tasks/action', { action: 'explode', taskId: 't-pass' });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.equal(typeof r.body.error, 'string');
    r = await postJson('/api/pipeline/tasks/action', { action: 'start', taskId: 'x"; rm -rf / #' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_ERROR');
    r = await postJson('/api/pipeline/tasks/action', { action: 'start', taskId: 'no-such-task' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'TASK_NOT_FOUND');
    r = await postJson('/api/pipeline/tasks/action', { action: 'block', taskId: 't-pass' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /reason/);
    r = await postJson('/api/pipeline/tasks/action', { action: 'block', taskId: 't-pass', reason: 42 });
    assert.equal(r.status, 400);
    r = await postJson('/api/pipeline/tasks/action', { action: 'start', taskId: 't-pass' }, {});
    assert.equal(r.status, 415);
    assert.equal(r.body.ok, false);
    r = await postJson('/api/pipeline/tasks/action', { action: 'complete', taskId: 't-done' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_TRANSITION');
    check('POST /api/pipeline/tasks/action validates input with the { ok: false, error } envelope');
  }

  // 5. start → plan_change + telemetry_change
  {
    const since = Date.now();
    const r = await postJson('/api/pipeline/tasks/action', { action: 'start', taskId: 't-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.task.id, 't-pass');
    assert.equal(r.body.task.status, 'in_progress');
    const planEvent = await sse.waitFor('plan_change', since);
    assert.ok(planEvent.data.files.includes('master_plan.json'), JSON.stringify(planEvent.data));
    assert.ok(!Number.isNaN(Date.parse(planEvent.data.at)));
    const telemetryEvent = await sse.waitFor('telemetry_change', since);
    assert.deepEqual(telemetryEvent.data.files, ['telemetry.json']);
    await sleep(400);
    const burst = sse.events.filter((e) => e.event === 'plan_change' && e.at >= since).length;
    assert.ok(burst <= 2, `plan writes should be debounced, got ${burst} plan_change events`);
    for (const e of sse.events) {
      for (const f of e.data.files ?? []) assert.ok(!/\.(tmp|lock)$/.test(f), `temp/lock file leaked into SSE: ${f}`);
    }
    check(`task start emits debounced plan_change (${burst}) and telemetry_change over SSE`);
  }

  // 6. Transition guard
  {
    const r = await postJson('/api/pipeline/tasks/action', { action: 'start', taskId: 't-pass' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_TRANSITION');
    check('starting an already in_progress task is rejected');
  }

  // 7. complete runs the verification gatekeeper
  {
    await postJson('/api/pipeline/tasks/action', { action: 'start', taskId: 't-fail' });
    const r = await postJson('/api/pipeline/tasks/action', { action: 'complete', taskId: 't-fail' });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /verification FAILED with exit code 3/);
    assert.ok(!/\x1b\[/.test(r.body.error), 'ANSI colors must be stripped from errors');
    const { body } = await getJson('/api/pipeline/tasks');
    assert.equal(allTasks(body).find((t) => t.id === 't-fail').status, 'in_progress');
    check('complete runs the verification gatekeeper and keeps the task in_progress on failure');
  }

  {
    const r = await postJson('/api/pipeline/tasks/action', { action: 'complete', taskId: 't-pass' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.task.status, 'completed');
    const { body } = await getJson('/api/pipeline/tasks');
    assert.equal(allTasks(body).find((t) => t.id === 't-dep').isAvailable, true);
    check('complete with a passing verification marks the task completed and unblocks dependents');
  }

  {
    const r = await postJson('/api/pipeline/tasks/action', { action: 'block', taskId: 't-fail', reason: '  flaky env  ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.task.status, 'blocked');
    assert.equal(r.body.task.notes, 'flaky env');
    assert.equal(process.exitCode, undefined, 'captured CLI handlers must not leak process.exitCode');
    check('block records the reason; process.exitCode is restored after captured CLI runs');
  }

  // 8. Worktrees
  {
    const { status, body } = await getJson('/api/pipeline/worktrees');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const main = body.worktrees.find((w) => !w.isAgentWorktree);
    assert.equal(main.branch, 'main');
    assert.equal(main.mergeEligible, false);
    const byTask = Object.fromEntries(body.worktrees.filter((w) => w.taskId).map((w) => [w.taskId, w]));
    assert.match(byTask['t-dep'].head, /^[0-9a-f]{40}$/);
    assert.equal(byTask['t-dep'].branch, 'agent/task-t-dep');
    assert.equal(byTask['t-dep'].taskStatus, 'pending');
    assert.equal(byTask['t-dep'].mergeEligible, false);
    assert.match(byTask['t-dep'].mergeBlockedReason, /pending/);
    assert.equal(byTask['t-done'].taskStatus, 'completed');
    assert.equal(byTask['t-done'].mergeEligible, true);
    assert.equal(byTask['t-done'].mergeBlockedReason, null);
    check('GET /api/pipeline/worktrees lists branches, commit SHAs and merge eligibility');
  }

  {
    let r = await postJson('/api/pipeline/worktrees/action', { action: 'merge', taskId: 't-dep' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'MERGE_REJECTED');
    r = await postJson('/api/pipeline/worktrees/action', { action: 'merge', taskId: 'ghost' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'WORKTREE_NOT_FOUND');
    r = await postJson('/api/pipeline/worktrees/action', { action: 'nuke', taskId: 't-dep' });
    assert.equal(r.status, 400);
    r = await postJson('/api/pipeline/worktrees/action', { action: 'remove', taskId: '$(whoami)' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_ERROR');
    check('POST /api/pipeline/worktrees/action rejects ineligible merges, unknown worktrees and unsafe ids');
  }

  {
    let r = await postJson('/api/pipeline/worktrees/action', { action: 'merge', taskId: 't-done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.message, 'string');
    assert.ok(fs.existsSync(path.join(projectDir, 'done.txt')), 'agent branch merged into main');
    r = await postJson('/api/pipeline/worktrees/action', { action: 'remove', taskId: 't-dep' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { body } = await getJson('/api/pipeline/worktrees');
    assert.equal(body.worktrees.length, 1);
    check('POST /api/pipeline/worktrees/action merges an eligible worktree and removes another');
  }

  // 9. Benchmarks
  {
    const { status, body } = await getJson('/api/pipeline/benchmarks');
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, report: null });
    check('GET /api/pipeline/benchmarks returns null before any run');
  }

  {
    const since = Date.now();
    const [a, b] = await Promise.all([
      postJson('/api/pipeline/benchmarks/run', undefined, {}),
      postJson('/api/pipeline/benchmarks/run', undefined, {}),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 500));
    assert.equal(a.body.ok, true);
    assert.equal(typeof a.body.report.summary.totalScenarios, 'number');
    assert.equal(a.body.report.timestamp, b.body.report.timestamp, 'concurrent callers share one in-flight run');
    const cached = await getJson('/api/pipeline/benchmarks');
    assert.equal(cached.body.report.timestamp, a.body.report.timestamp);
    const event = await sse.waitFor('telemetry_change', since);
    assert.ok(event.data.files.includes('benchmark_report.json'), JSON.stringify(event.data));
    assert.equal(process.exitCode, undefined);
    check(`POST /api/pipeline/benchmarks/run executes once, caches the report and emits telemetry_change (score ${a.body.report.summary.score})`);
  }

  // 10. Routing & loopback security
  {
    let r = await postJson('/api/pipeline/status', {});
    assert.equal(r.status, 405);
    assert.equal(r.body.ok, false);
    r = await getJson('/api/pipeline/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    r = await postJson('/api/events', {});
    assert.equal(r.status, 405);
    const dbStatus = await getJson('/api/status');
    assert.equal(dbStatus.status, 200);
    assert.equal(dbStatus.body.dev.connected, false);
    const legacy404 = await getJson('/api/nope');
    assert.equal(legacy404.body.error.code, 'NOT_FOUND');
    check('405/404 use the pipeline envelope on /api/pipeline/*; existing DB routes keep their error shape');
  }

  {
    assert.equal(await rawStatus(studio.port, '/api/events', 'evil.example'), 403);
    assert.equal(await rawStatus(studio.port, '/api/pipeline/status', 'evil.example'), 403);
    check('non-loopback Host headers are rejected on SSE and pipeline routes');
  }

  // 11. Shutdown with open streams
  {
    const second = openSse(`${studio.url}/api/events`);
    await second.ready;
    await Promise.race([
      studio.close(),
      sleep(3000).then(() => {
        throw new Error('studio.close() hung on open SSE connections');
      }),
    ]);
    sse.close();
    second.close();
    check('studio.close() completes promptly with SSE clients connected');
  }

  // 12. No .ai/ yet: empty pipeline + polling fallback
  {
    const bareDir = path.join(tmpBase, 'bare');
    fs.mkdirSync(bareDir);
    studio2 = await startStudioServer({ port: 0, cwd: bareDir, connections: { dev: null, prod: null }, heartbeatMs: 60_000 });

    const { body } = await getJson('/api/pipeline/status', studio2.url);
    assert.equal(body.ok, true);
    assert.equal(body.pipeline.contracts.masterPlanExists, false);
    assert.equal(body.pipeline.tasks.total, 0);
    assert.deepEqual((await getJson('/api/pipeline/tasks', studio2.url)).body.milestones, []);
    check('pipeline endpoints degrade to an empty pipeline when .ai/ is missing');

    const stream = openSse(`${studio2.url}/api/events`);
    await stream.ready;
    await sleep(300);
    const since = Date.now();
    fs.mkdirSync(path.join(bareDir, '.ai'));
    fs.writeFileSync(path.join(bareDir, '.ai', 'master_plan.json'), JSON.stringify(plan));
    const event = await stream.waitFor('plan_change', since, 5000);
    assert.deepEqual(event.data.files, ['master_plan.json']);
    stream.close();
    check('SSE falls back to polling and emits plan_change once .ai/ appears');
  }

  console.log(`\n✔ All ${passed} Studio pipeline API & SSE checks passed.`);
} catch (err) {
  console.error('\n✖ Studio pipeline API verification failed:', err);
  process.exitCode = 1;
} finally {
  sse.close();
  await studio.close().catch(() => {});
  if (studio2) await studio2.close().catch(() => {});
  fs.rmSync(tmpBase, { recursive: true, force: true });
}
