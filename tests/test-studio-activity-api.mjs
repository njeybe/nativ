import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Run with `npx tsx tests/test-studio-activity-api.mjs`: the server is imported from TypeScript.
import { startStudioServer } from '../src/server/studio-server.ts';
import { appendEvent } from '../src/core/activity/event-log.ts';

console.log('--- Studio activity, task changes and transcript routes ---');

setTimeout(() => {
  console.error('Studio activity suite exceeded 60s.');
  process.exit(1);
}, 60_000).unref();

process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync(os.tmpdir());
process.env.NATIV_PROVIDER_CHILD = '1';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-activity-api-')));
const git = (args, cwd = dir) => execSync(`git ${args}`, { cwd, stdio: 'ignore' });

function setup() {
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const task = {
    id: 'task-a', title: 'A', description: 'A', assignedSubagent: 'backend', dependencies: [],
    targetFiles: ['a.txt'], status: 'in_progress', verificationCommand: 'node -e "0"', notes: '',
  };
  const plan = {
    version: '1.0.0', projectName: 'activity-fixture', lastUpdated: '2026-09-01T00:00:00.000Z',
    overallStatus: 'in_progress', activeMilestoneId: 'm1',
    milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: [task, { ...task, id: 'task-b' }] }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan), 'utf8');
  git('init -q');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  git('add README.md');
  git('-c user.name=T -c user.email=t@nativ.dev -c commit.gpgsign=false commit -q -m init');
  git('worktree add -q .worktrees/task-task-a -b task-a-branch');
  fs.writeFileSync(path.join(dir, '.worktrees', 'task-task-a', 'new.txt'), 'one\ntwo\n', 'utf8');
  const runs = path.join(dir, '.nativ', 'runs', 'transcripts');
  fs.mkdirSync(runs, { recursive: true });
  const lines = [
    { type: 'run_start', at: '2026-09-01T00:00:00.000Z', taskId: 'task-a', engine: 'cli' },
    { type: 'assistant_text', at: '2026-09-01T00:00:05.000Z', text: 'hello there' },
    { type: 'run_end', at: '2026-09-01T00:00:10.000Z', status: 'completed', durationMs: 10000 },
  ];
  fs.writeFileSync(path.join(runs, 'run-abc12345.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function eventAt(at) {
  return {
    v: 1, at, src: 'runner', lane: { id: 'run-abc12345', runId: 'run-abc12345' },
    task: { id: 'task-a', via: 'worktree' }, kind: 'run',
    data: { runId: 'run-abc12345', status: 'running', engine: 'cli' },
  };
}

function waitForFrame(port, name, trigger) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} frame within 5s`)), 5000);
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes(`event: ${name}`)) {
          clearTimeout(timer);
          req.destroy();
          resolve(buffer);
        } else if (!trigger.done) {
          trigger.done = true;
          trigger.run();
        }
      });
    });
    req.on('error', (err) => { if (!err.message.includes('socket hang up')) reject(err); });
  });
}

async function call(base, route, method = 'GET') {
  const res = await fetch(`${base}${route}`, { method });
  return { status: res.status, body: await res.json() };
}

function expectError(r, code, status = 400) {
  assert.equal(r.status, status);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, code);
  assert.equal(typeof r.body.error, 'string');
}

setup();
const handle = await startStudioServer({ port: 0, cwd: dir, connections: { dev: null, prod: null } });
try {
  const base = handle.url;
  appendEvent(dir, eventAt(new Date().toISOString()));
  let act;
  for (let i = 0; i < 40; i++) {
    act = await call(base, '/api/pipeline/activity?windowMinutes=60&limit=10');
    if (act.body.events?.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(act.status, 200);
  assert.deepEqual(Object.keys(act.body).sort(), ['cursor', 'events', 'lanes', 'ok', 'truncated', 'windowMinutes']);
  assert.equal(act.body.windowMinutes, 60);
  assert.equal(act.body.events.length, 1);
  assert.equal(typeof act.body.cursor, 'string');
  const later = await call(base, `/api/pipeline/activity?since=${encodeURIComponent(act.body.cursor)}`);
  assert.equal(later.body.events.length, 0);
  console.log('✔ activity returns the contract body');

  const bad = ['windowMinutes=0', 'windowMinutes=1441', 'windowMinutes=abc', 'limit=0', 'limit=501'];
  for (const q of [...bad, 'since=garbage']) {
    expectError(await call(base, `/api/pipeline/activity?${q}`), 'VALIDATION_ERROR');
  }
  console.log('✔ activity rejects out-of-range values');

  const ch = await call(base, '/api/pipeline/tasks/changes?taskId=task-a');
  assert.equal(ch.status, 200);
  assert.equal(ch.body.taskId, 'task-a');
  assert.equal(ch.body.scope, 'worktree');
  assert.equal(typeof ch.body.base, 'string');
  assert.ok(ch.body.files.some((f) => f.path === 'new.txt' && f.added === 2));
  assert.equal('diff' in ch.body, false);
  const full = await call(base, '/api/pipeline/tasks/changes?taskId=task-a&full=true');
  assert.equal(typeof full.body.diff, 'string');
  expectError(await call(base, '/api/pipeline/tasks/changes'), 'VALIDATION_ERROR');
  expectError(await call(base, '/api/pipeline/tasks/changes?taskId=task-a&full=maybe'), 'VALIDATION_ERROR');
  expectError(await call(base, '/api/pipeline/tasks/changes?taskId=task-zzz'), 'TASK_NOT_FOUND');
  expectError(await call(base, '/api/pipeline/tasks/changes?taskId=task-b'), 'NO_BASELINE');
  console.log('✔ changes returns files, diff only when full, and its error codes');

  const tr = await call(base, '/api/pipeline/runs/transcript?run=task-a');
  assert.equal(tr.status, 200);
  assert.deepEqual(Object.keys(tr.body).sort(), ['events', 'ok', 'runId', 'taskId', 'text']);
  assert.equal(tr.body.runId, 'run-abc12345');
  assert.equal(tr.body.taskId, 'task-a');
  assert.equal(tr.body.events, 3);
  assert.ok(tr.body.text.includes('hello there'));
  const byPrefix = await call(base, '/api/pipeline/runs/transcript?run=run-abc&full=1');
  assert.equal(byPrefix.body.runId, 'run-abc12345');
  expectError(await call(base, '/api/pipeline/runs/transcript'), 'VALIDATION_ERROR');
  expectError(await call(base, '/api/pipeline/runs/transcript?run=nothing-here'), 'RUN_NOT_FOUND');
  console.log('✔ transcript returns the contract body and its error codes');

  for (const p of ['/api/pipeline/activity', '/api/pipeline/tasks/changes', '/api/pipeline/runs/transcript']) {
    expectError(await call(base, p, 'POST'), 'METHOD_NOT_ALLOWED', 405);
  }
  console.log('✔ POST gives 405');

  const trigger = { done: false, run: () => appendEvent(dir, eventAt(new Date().toISOString())) };
  const frame = await waitForFrame(handle.port, 'activity_change', trigger);
  assert.ok(frame.includes('event: activity_change'));
  console.log('✔ an appended event reaches /api/events as activity_change');
} finally {
  await handle.close();
  try { git('worktree remove --force .worktrees/task-task-a'); } catch { /* best effort */ }
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('--- Studio activity routes passed ---');
process.exit(0);
