import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ActivityFeed } from '../dist/server/activity-feed.js';
import { PipelineEventHub } from '../dist/server/event-hub.js';
import { eventsDir, segmentName } from '../dist/core/activity/event-log.js';

console.log('--- Activity feed ---');

const roots = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-feed-'));
  fs.mkdirSync(path.join(dir, '.ai'));
  roots.push(dir);
  return dir;
}

function line(i, at = new Date()) {
  const ev = { v: 1, at: at.toISOString(), kind: 'tool', src: 'hook', lane: { id: 'main' },
    data: { name: 'Edit', ok: true, taskId: String(i) } };
  return `${JSON.stringify(ev)}\n`;
}

// Appends from a separate plain node process, like a real hook would.
function appendFromChild(file, text) {
  const code = 'require("fs").appendFileSync(process.argv[1], JSON.parse(process.argv[2]))';
  const r = spawnSync(process.execPath, ['-e', code, file, JSON.stringify(text)]);
  assert.equal(r.status, 0, String(r.stderr));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

function segmentFile(root) {
  const dir = eventsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, segmentName(new Date(), 0));
}

// 1. Appended lines show up in snapshot and fire one debounced onChange.
{
  const root = fixture();
  const file = segmentFile(root);
  fs.writeFileSync(file, line(0));
  const calls = [];
  const feed = new ActivityFeed(root, (n) => calls.push({ n, t: Date.now() }));
  assert.equal(feed.snapshot().events.length, 1);
  const t0 = Date.now();
  appendFromChild(file, line(1) + line(2));
  assert.ok(await waitFor(() => calls.length > 0), 'onChange fired');
  const delay = calls[0].t - t0;
  console.log(`  measured onChange delay: ${delay} ms`);
  assert.ok(delay < 700, `delay ${delay}`);
  await sleep(500);
  assert.equal(calls.length, 1, 'one debounced call');
  assert.equal(calls[0].n, 2);
  assert.equal(feed.snapshot().events.length, 3);
  feed.close();
  console.log('  ok appended lines and debounce');
}

// 2. Torn line is read once complete; missing directory is picked up.
{
  const root = fixture();
  const calls = [];
  const feed = new ActivityFeed(root, (n) => calls.push(n));
  assert.equal(feed.snapshot().cursor, null);
  assert.equal(feed.snapshot().events.length, 0);
  const file = segmentFile(root);
  const full = line(1);
  appendFromChild(file, full.slice(0, 30));
  await sleep(1400);
  assert.equal(feed.snapshot().events.length, 0, 'torn line not read');
  appendFromChild(file, full.slice(30));
  assert.ok(await waitFor(() => feed.snapshot().events.length === 1), 'completed line read');
  await sleep(1400);
  assert.equal(feed.snapshot().events.length, 1, 'read exactly once');
  feed.close();
  console.log('  ok torn line and missing directory');
}

// 3. snapshot options match the API body.
{
  const root = fixture();
  const file = segmentFile(root);
  fs.writeFileSync(file, [1, 2, 3, 4, 5].map((i) => line(i)).join(''));
  const feed = new ActivityFeed(root, () => {});
  const snap = feed.snapshot({ windowMinutes: 10, limit: 2 });
  assert.equal(snap.ok, true);
  assert.equal(snap.windowMinutes, 10);
  assert.equal(snap.events.length, 2);
  assert.equal(snap.events[1].data.taskId, '5', 'newest last');
  assert.equal(snap.truncated, true);
  assert.ok(snap.cursor.startsWith(path.basename(file)));
  assert.ok(Array.isArray(snap.lanes) && snap.lanes.length === 1);
  const next = feed.snapshot({ since: snap.cursor });
  assert.equal(next.events.length, 0);
  assert.equal(next.truncated, false);
  appendFromChild(file, line(6));
  assert.ok(await waitFor(() => feed.snapshot().events.length === 6));
  const after = feed.snapshot({ since: snap.cursor });
  assert.deepEqual(after.events.map((e) => e.data.taskId), ['6']);
  assert.equal(feed.snapshot().windowMinutes, 30);
  feed.close();
  console.log('  ok snapshot body');
}

// 4. Old events are ignored at start.
{
  const root = fixture();
  const file = segmentFile(root);
  fs.writeFileSync(file, line(1, new Date(Date.now() - 30 * 3600 * 1000)) + line(2));
  const feed = new ActivityFeed(root, () => {});
  assert.deepEqual(feed.snapshot().events.map((e) => e.data.taskId), ['2']);
  feed.close();
  console.log('  ok 24 hour window');
}

// 5. publishChange sends activity_change frames; close() stops everything.
{
  const frames = [];
  const res = {
    socket: null,
    writeHead() {},
    write: (s) => frames.push(s),
    on() {},
    destroy() {},
  };
  const hub = new PipelineEventHub(fixture() + '/.ai', 60_000);
  hub.subscribe(res);
  hub.publishChange('activity_change', { at: 'now', count: 3 });
  assert.ok(frames.includes('event: activity_change\ndata: {"at":"now","count":3}\n\n'));
  hub.publish('runner_log', { a: 1 });
  assert.ok(frames.includes('event: runner_log\ndata: {"a":1}\n\n'));
  hub.close();
  hub.publishChange('activity_change', {});
  assert.equal(frames.filter((f) => f.includes('activity_change')).length, 1);
  console.log('  ok publishChange');
}

for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
console.log('Activity feed tests passed');
