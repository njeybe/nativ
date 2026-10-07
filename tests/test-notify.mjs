import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isAllowedWebhook, loadNotifyConfig, notifyHuman } from '../dist/core/notify.js';
import { evaluateEscalation } from '../dist/core/tier1-liaison.js';

console.log('--- Starting Human Notification Tests ---');

// Keep triage offline and deterministic (see test-tier1-liaison.mjs).
for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'NATIV_NOTIFY_WEBHOOK', 'NATIV_NOTIFY_COMMAND']) delete process.env[k];
process.env.NATIV_PROVIDER_CHILD = '1';

const CLI = path.resolve('bin', 'cli.js');
const dirs = [];
function project(notify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-notify-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.nativ'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify({ version: '1.0.0', milestones: [] }));
  if (notify) fs.writeFileSync(path.join(dir, '.nativ', 'config.json'), JSON.stringify({ notify }));
  return dir;
}
const fakeFetch = (calls, status = 200) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: status < 300, status };
};
const input = { event: 'human_decision', taskId: 'task-7', escalationId: 'esc-03', summary: 'Drop a column?', question: 'Keep the data?', options: ['Keep', 'Drop'] };

try {
  // Test 1: configuration
  {
    assert.equal(loadNotifyConfig(project()), null, 'off by default');
    assert.ok(isAllowedWebhook('https://hooks.slack.com/x'));
    assert.ok(isAllowedWebhook('http://127.0.0.1:9/x'), 'plain http to this machine is fine');
    assert.ok(!isAllowedWebhook('http://example.com/x'), 'plain http elsewhere is refused');
    assert.ok(!isAllowedWebhook('not a url'));
    const cfg = loadNotifyConfig(project({ webhook: 'https://a.example/h', events: ['circuit_breaker_tripped', 'bogus'] }));
    assert.deepEqual(cfg, { webhook: 'https://a.example/h', events: ['circuit_breaker_tripped'] });
    const env = loadNotifyConfig(project({ webhook: 'https://file.example' }), { NATIV_NOTIFY_WEBHOOK: 'https://env.example' });
    assert.equal(env.webhook, 'https://env.example', 'the environment overrides the file');
    console.log('✔ Test 1: off by default, https-only (localhost aside), env overrides file, unknown events dropped');
  }

  // Test 2: delivery, payload shape, de-duplication and event filter
  {
    const dir = project({ webhook: 'https://hooks.example/abc' });
    const calls = [];
    const first = await notifyHuman(dir, input, { fetch: fakeFetch(calls), env: {} });
    assert.deepEqual(first, { sent: true, errors: [] });
    const body = calls[0].body;
    assert.equal(body.event, 'human_decision');
    assert.equal(body.nextStep, 'nativ triage esc-03');
    assert.equal(body.project, path.basename(dir));
    assert.match(body.text, /needs you: Drop a column\?[\s\S]*Options: Keep \| Drop[\s\S]*Next: nativ triage esc-03/);
    assert.equal(body.content, body.text, 'Discord reads content, Slack reads text');

    const again = await notifyHuman(dir, input, { fetch: fakeFetch(calls), env: {} });
    assert.equal(again.skipped, 'already_sent');
    assert.equal(calls.length, 1, 'the same escalation is announced once');
    assert.equal((await notifyHuman(dir, input, { fetch: fakeFetch(calls), env: {}, force: true })).sent, true);

    const filtered = project({ webhook: 'https://hooks.example/abc', events: ['circuit_breaker_tripped'] });
    assert.equal((await notifyHuman(filtered, input, { fetch: fakeFetch([]), env: {} })).skipped, 'event_disabled');
    console.log('✔ Test 2: one readable message per escalation, with the next step; events can be filtered');
  }

  // Test 3: failures are reported, recorded and retried later, never thrown
  {
    const dir = project({ webhook: 'https://hooks.example/abc' });
    const calls = [];
    const failed = await notifyHuman(dir, input, { fetch: fakeFetch(calls, 500), env: {} });
    assert.deepEqual(failed, { sent: false, errors: ['webhook answered 500'] });
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.nativ', 'notify-state.json'), 'utf8'));
    assert.deepEqual(state.lastError.errors, ['webhook answered 500']);
    assert.equal((await notifyHuman(dir, input, { fetch: fakeFetch(calls), env: {} })).sent, true, 'a failed delivery is retried next time');

    const thrown = await notifyHuman(project({ webhook: 'https://x.example' }), input, { fetch: async () => { throw new Error('offline'); }, env: {} });
    assert.deepEqual(thrown.errors, ['webhook failed: offline']);
    const insecure = await notifyHuman(project({ webhook: 'http://example.com/h' }), input, { fetch: fakeFetch([]), env: {} });
    assert.equal(insecure.sent, false);
    assert.match(insecure.errors[0], /https/);
    console.log('✔ Test 3: failed or refused deliveries are reported and recorded, not thrown, and retried');
  }

  // Test 4: a local command receives the payload on stdin and in NATIV_NOTIFY_JSON
  {
    const out = path.join(project(), 'got.json');
    const script = `process.stdin.on('data',d=>require('fs').appendFileSync(${JSON.stringify(out)},d)).on('end',()=>{if(!process.env.NATIV_NOTIFY_JSON)process.exit(3)})`;
    const dir = project({ command: `"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"` });
    const result = await notifyHuman(dir, input, { env: {} });
    assert.deepEqual(result, { sent: true, errors: [] });
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).escalationId, 'esc-03');
    const bad = await notifyHuman(project({ command: `"${process.execPath}" -e "process.exit(4)"` }), input, { env: {} });
    assert.deepEqual(bad.errors, ['command exited with 4']);
    console.log('✔ Test 4: the command channel gets the payload and reports a failing exit code');
  }

  // Test 5: triage that needs a human sends one notification to a real local webhook
  {
    const received = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c)).on('end', () => {
        received.push(JSON.parse(data));
        res.end('ok');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = project({ webhook: `http://127.0.0.1:${server.address().port}/hook` });
    fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify({ version: '1.0.0', escalations: [
      { id: 'esc-09', taskId: 'task-db', status: 'pending_review', summary: 'Destructive migration: DROP COLUMN requested', details: 'DROP COLUMN notes deletes user records.' },
    ] }));
    const result = await evaluateEscalation(dir, 'esc-09');
    assert.equal(result.classification, 'REQUIRE_HUMAN_DECISION');
    await evaluateEscalation(dir, 'esc-09');
    server.close();
    assert.equal(received.length, 1, 'triaging the same escalation twice notifies once');
    assert.equal(received[0].escalationId, 'esc-09');
    assert.ok(received[0].options.length >= 2, 'the decision options travel with the message');
    console.log('✔ Test 5: a REQUIRE_HUMAN_DECISION verdict notifies the human once');
  }

  // Test 6: `nativ notify test`
  {
    const off = spawnSync(process.execPath, [CLI, 'notify', 'test', project()], { encoding: 'utf8' });
    assert.equal(off.status, 1);
    assert.match(off.stdout, /Notifications are off/);
    const out = path.join(project(), 'test.json');
    const dir = project({ command: `"${process.execPath}" -e "process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(out).replace(/"/g, "'")}))"` });
    const on = spawnSync(process.execPath, [CLI, 'notify', 'test', dir], { encoding: 'utf8' });
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Test notification sent via command/);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).taskId, 'task-test');
    console.log('✔ Test 6: `nativ notify test` explains setup when off and delivers a sample when on');
  }

  console.log('\n🎉 ALL NOTIFICATION TESTS PASSED!');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
