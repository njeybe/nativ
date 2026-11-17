// Studio plan-change routes, dropped counts, the dispatch guard and the plan_change SSE frame.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startStudioServer } from '../dist/server/studio-server.js';
import { STUDIO_KEY_COOKIE, createStudioSession } from '../dist/server/studio-session.js';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n${err.stack ?? err}`);
  }
}

function request(baseUrl, method, pathname, { body, cookie } = {}) {
  const url = new URL(pathname, baseUrl);
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (data) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}

const task = (id, status, dependencies = [], extra = {}) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies, targetFiles: [],
  status, verificationCommand: 'true', ...extra,
});

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-plan-changes-api-'));
  fs.mkdirSync(path.join(dir, '.ai'));
  const archived = { taskCount: 3, taskIds: ['a1', 'a2', 'a3'], droppedTaskIds: ['a3'] };
  const plan = {
    projectName: 'demo', overallStatus: 'in_progress', activeMilestoneId: 'm2',
    milestones: [
      { id: 'm1', name: 'old', status: 'completed', tasks: [], archived },
      {
        id: 'm2', name: 'now', status: 'in_progress',
        tasks: [
          task('t1', 'pending'), task('t2', 'pending', ['t1']), task('t3', 'pending'),
          task('t4', 'completed'), task('t5', 'pending'),
          task('t6', 'dropped', [], { drop: { reason: 'old', changeId: 'pc-00', at: '2026-01-01T00:00:00.000Z' } }),
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  const changes = [
    { id: 'pc-01', status: 'proposed', taskId: 't1', change: { drop: { reason: 'redo', replacedBy: 't3' } },
      reason: 'superseded', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'pc-02', status: 'proposed', taskId: 't4', change: { notes: 'x' }, reason: 'late',
      createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'pc-03', status: 'proposed', taskId: 't5', change: { notes: 'hello' }, reason: 'note',
      createdAt: '2026-01-03T00:00:00.000Z' },
    { id: 'pc-04', status: 'rejected', taskId: 't5', change: { notes: 'y' }, reason: 'no',
      createdAt: '2026-01-04T00:00:00.000Z' },
  ];
  fs.writeFileSync(path.join(dir, '.ai', 'plan_changes.json'),
    JSON.stringify({ version: '1.0.0', changes }, null, 2));
  return dir;
}

async function withStudio(human, fn) {
  const cwd = makeProject();
  const studio = await startStudioServer({ port: 0, cwd, connections: { dev: null, prod: null }, human });
  try {
    await fn(studio, cwd);
  } finally {
    await studio.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const keyOf = (s) => new URL(s.launchUrl('http://127.0.0.1:1/')).searchParams.get('key');
const cookieOf = (s) => `${STUDIO_KEY_COOKIE}=${keyOf(s)}`;
const DECIDE = '/api/pipeline/plan-changes/decide';
const seenOf = async (studio, id) => {
  const r = await request(studio.url, 'GET', '/api/pipeline/plan-changes?status=all');
  return r.body.changes.find((c) => c.id === id).seen;
};

console.log('studio plan-change routes');

await test('GET lists proposed newest first with seen, check and effects; human follows the cookie', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio) => {
    const r = await request(studio.url, 'GET', '/api/pipeline/plan-changes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.changes.map((c) => c.id), ['pc-03', 'pc-02', 'pc-01']);
    assert.equal(r.body.human, false);
    const [c3, c2, c1] = r.body.changes;
    assert.equal(typeof c3.seen, 'string');
    assert.deepEqual(c3.check, { ok: true, reason: null });
    assert.equal(c2.check.ok, false);
    assert.match(c2.check.reason, /t4/);
    assert.deepEqual(c1.effects, { rewired: [{ taskId: 't2', from: 't1', to: 't3' }] });
    const all = await request(studio.url, 'GET', '/api/pipeline/plan-changes?status=all', { cookie: cookieOf(human) });
    assert.equal(all.body.changes.length, 4);
    assert.equal(all.body.human, true);
    assert.equal(all.body.changes[0].check, undefined);
    const bad = await request(studio.url, 'GET', '/api/pipeline/plan-changes?status=nope');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VALIDATION_ERROR');
  });
});

await test('GET on an unreadable plan_changes.json is 500 PLAN_CHANGES_UNREADABLE', async () => {
  await withStudio(createStudioSession(), async (studio, cwd) => {
    fs.writeFileSync(path.join(cwd, '.ai', 'plan_changes.json'), '{ not json');
    const r = await request(studio.url, 'GET', '/api/pipeline/plan-changes');
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'PLAN_CHANGES_UNREADABLE');
  });
});

await test('decide on an unreadable file is 500 with the refusal code', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio, cwd) => {
    const cookie = cookieOf(human);
    const seen = await seenOf(studio, 'pc-03');
    const body = { id: 'pc-03', decision: 'approve', seen };
    const file = (n) => path.join(cwd, '.ai', n);
    const plan = fs.readFileSync(file('master_plan.json'), 'utf8');
    fs.writeFileSync(file('master_plan.json'), '{ not json');
    const noPlan = await request(studio.url, 'POST', DECIDE, { body, cookie });
    assert.equal(noPlan.status, 500);
    assert.equal(noPlan.body.code, 'PLAN_UNREADABLE');
    fs.writeFileSync(file('master_plan.json'), plan);
    fs.writeFileSync(file('plan_changes.json'), '{ not json');
    const noChanges = await request(studio.url, 'POST', DECIDE, { body, cookie });
    assert.equal(noChanges.status, 500);
    assert.equal(noChanges.body.code, 'PLAN_CHANGES_UNREADABLE');
  });
});

await test('decide without the session key is 403 before the body is read', async () => {
  await withStudio(createStudioSession({ headless: true }), async (studio, cwd) => {
    const before = fs.readFileSync(path.join(cwd, '.ai', 'plan_changes.json'), 'utf8');
    const r = await request(studio.url, 'POST', DECIDE, { body: { nonsense: true } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'HUMAN_KEY_REQUIRED');
    assert.equal(fs.readFileSync(path.join(cwd, '.ai', 'plan_changes.json'), 'utf8'), before);
  });
});

await test('decide and escalation resolve check the key before a bad body is parsed', async () => {
  await withStudio(createStudioSession({ headless: true }), async (studio, cwd) => {
    const escalation = path.join(cwd, '.ai', 'escalation.json');
    fs.writeFileSync(escalation, JSON.stringify({ escalations: [] }, null, 2));
    const files = [path.join(cwd, '.ai', 'plan_changes.json'), escalation];
    const before = files.map((f) => fs.readFileSync(f));
    const post = (pathname, raw) => new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      const req = http.request(new URL(pathname, studio.url), { method: 'POST', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(raw);
    });
    const routes = [DECIDE, '/api/pipeline/escalations/resolve'];
    for (const route of routes) {
      for (const raw of ['', '{ not json']) {
        const r = await post(route, raw);
        assert.equal(r.status, 403, `${route} with ${JSON.stringify(raw)}`);
        assert.equal(r.body.code, 'HUMAN_KEY_REQUIRED');
      }
    }
    files.forEach((f, i) => assert.ok(fs.readFileSync(f).equals(before[i]), `${f} changed`));
  });
});

await test('decide validates the body and maps every refusal to its code', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio) => {
    const cookie = cookieOf(human);
    const post = (body) => request(studio.url, 'POST', DECIDE, { body, cookie });
    const seen = await seenOf(studio, 'pc-03');
    for (const body of [
      {}, { id: 'pc-03', decision: 'maybe', seen }, { id: 'pc-03', decision: 'approve' },
      { id: 'pc-03', decision: 'approve', seen, note: 'x'.repeat(501) },
    ]) {
      const r = await post(body);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'VALIDATION_ERROR');
    }
    assert.equal((await post({ id: 'pc-99', decision: 'approve', seen })).body.code, 'CHANGE_NOT_FOUND');
    assert.equal((await post({ id: 'pc-04', decision: 'approve', seen })).body.code, 'CHANGE_ALREADY_DECIDED');
    assert.equal((await post({ id: 'pc-03', decision: 'approve', seen: 'stale' })).body.code, 'CHANGE_EDITED');
    const refused = await post({ id: 'pc-02', decision: 'approve', seen: await seenOf(studio, 'pc-02') });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'CHANGE_REFUSED');
    assert.match(refused.body.error, /t4/);
    const still = await request(studio.url, 'GET', '/api/pipeline/plan-changes');
    assert.ok(still.body.changes.some((c) => c.id === 'pc-02'));
  });
});

await test('approve applies the change with via studio; reject records a note', async () => {
  const human = createStudioSession();
  await withStudio(human, async (studio, cwd) => {
    const cookie = cookieOf(human);
    const ok = await request(studio.url, 'POST', DECIDE, {
      cookie, body: { id: 'pc-03', decision: 'approve', seen: await seenOf(studio, 'pc-03'), note: 'fine' },
    });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.change.status, 'approved');
    assert.equal(ok.body.change.decidedVia, 'studio');
    assert.equal(ok.body.change.decisionNote, 'fine');
    assert.equal(typeof ok.body.message, 'string');
    const plan = JSON.parse(fs.readFileSync(path.join(cwd, '.ai', 'master_plan.json'), 'utf8'));
    assert.equal(plan.milestones[1].tasks.find((t) => t.id === 't5').notes, 'hello');
    const no = await request(studio.url, 'POST', DECIDE, {
      cookie, body: { id: 'pc-02', decision: 'reject', seen: await seenOf(studio, 'pc-02'), note: 'nope' },
    });
    assert.equal(no.body.change.status, 'rejected');
    assert.equal(no.body.change.decisionNote, 'nope');
  });
});

await test('status counts dropped and leaves it out of totals and percentages', async () => {
  await withStudio(createStudioSession(), async (studio) => {
    const { pipeline } = (await request(studio.url, 'GET', '/api/pipeline/status')).body;
    // Live: t1 t2 t3 t5 pending, t4 done, t6 dropped. Archived: a1 a2 kept, a3 dropped.
    assert.equal(pipeline.tasks.dropped, 2);
    assert.equal(pipeline.tasks.total, 7);
    assert.equal(pipeline.tasks.completed, 3);
    assert.equal(pipeline.tasks.pending, 4);
    assert.equal(pipeline.tasks.progressPercentage, Math.round((3 / 7) * 100));
    const tasks = (await request(studio.url, 'GET', '/api/pipeline/tasks')).body;
    const live = tasks.milestones[1];
    assert.equal(live.progressPercentage, Math.round((1 / 5) * 100));
    assert.deepEqual(live.tasks.find((t) => t.id === 't6').drop.changeId, 'pc-00');
    assert.equal(live.tasks.find((t) => t.id === 't6').isAvailable, false);
  });
});

await test('dispatch refuses a dropped or completed task', async () => {
  await withStudio(createStudioSession(), async (studio) => {
    for (const taskId of ['t6', 't4']) {
      const r = await request(studio.url, 'POST', '/api/pipeline/tasks/dispatch', { body: { taskId } });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'INVALID_TRANSITION');
    }
  });
});

await test('a change to plan_changes.json sends a plan_change SSE frame', async () => {
  await withStudio(createStudioSession(), async (studio, cwd) => {
    const frame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no plan_change frame')), 10000);
      const req = http.get(new URL('/api/events', studio.url), (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
          if (/event: plan_change\n[^]*plan_changes\.json/.test(text)) {
            clearTimeout(timer);
            req.destroy();
            resolve(text);
          }
        });
        setTimeout(() => {
          const file = path.join(cwd, '.ai', 'plan_changes.json');
          fs.writeFileSync(file, JSON.stringify({ version: '1.0.0', changes: [] }));
        }, 300);
      });
      req.on('error', () => {});
    });
    assert.match(frame, /plan_changes\.json/);
  });
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall studio plan-change tests passed');
