import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendEvent, pruneEvents, readEvents, segmentName, eventsDir, PART_MAX_BYTES, MAX_LINE_BYTES,
} from '../dist/core/activity/event-log.js';

console.log('--- Event log ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logUrl = pathToFileURL(path.join(repoRoot, 'dist', 'core', 'activity', 'event-log.js')).href;

function fixture(withAi = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-event-log-'));
  if (withAi) fs.mkdirSync(path.join(dir, '.ai'));
  return dir;
}

function toolEvent(data = {}) {
  const lane = { id: 'main' };
  const at = new Date().toISOString();
  return { v: 1, at, kind: 'tool', src: 'hook', lane, data: { name: 'Edit', ok: true, ...data } };
}

function segments(root) {
  const dir = eventsDir(root);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function childScript(worker) {
  return `
    import { appendEvent } from ${JSON.stringify(logUrl)};
    const root = process.argv[1];
    for (let i = 0; i < 500; i++) {
      const pad = 'x'.repeat(200 + ((i * 37 + ${worker} * 101) % 1500));
      const ev = { v: 1, at: new Date().toISOString(), kind: 'tool', src: 'hook',
        lane: { id: 'w${worker}' }, data: { name: pad, ok: true, taskId: String(i) } };
      if (!appendEvent(root, ev)) { console.error('append failed'); process.exit(1); }
    }`;
}

function runChild(root, worker) {
  return new Promise((resolve, reject) => {
    const args = ['--input-type=module', '-e', childScript(worker), root];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${worker} exit ${code}`))));
  });
}

async function testConcurrency() {
  const root = fixture();
  await Promise.all(Array.from({ length: 8 }, (_, w) => runChild(root, w)));
  const files = segments(root);
  assert.equal(files.length, 1, 'one segment');
  const text = fs.readFileSync(path.join(eventsDir(root), files[0]), 'utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.slice(0, -1).split('\n');
  let torn = 0;
  for (const line of lines) {
    try { JSON.parse(line); } catch { torn++; }
  }
  console.log(`  concurrency: ${lines.length} lines, ${torn} torn`);
  assert.equal(torn, 0, 'no torn line');
  assert.equal(lines.length, 4000);
  assert.equal(readEvents(root).events.length, 4000);
}

function testAppendRules() {
  const bare = fixture(false);
  assert.equal(appendEvent(bare, toolEvent()), false);
  assert.equal(fs.existsSync(path.join(bare, '.nativ')), false, 'no write without .ai or .nativ');
  assert.equal(appendEvent(path.join(bare, 'nope\0bad'), toolEvent()), false, 'never throws');

  const root = fixture();
  const wt = path.join(root, '.worktrees', 'task-x');
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(appendEvent(wt, toolEvent()), true);
  assert.equal(fs.existsSync(path.join(wt, '.nativ')), false);
  assert.equal(segments(root)[0], segmentName(new Date(), 0));

  const big = toolEvent({ path: 'p'.repeat(1000), program: 'q'.repeat(1500) });
  assert.equal(appendEvent(root, big), true);
  const last = readEvents(root).events.at(-1);
  assert.equal(last.data.program, undefined, 'non-path field dropped first');
  assert.equal(last.data.path.length, 1000, 'path kept when it fits');
  assert.equal(appendEvent(root, toolEvent({ name: 'n'.repeat(MAX_LINE_BYTES) })), false, 'dropped');
  for (const line of fs.readFileSync(path.join(eventsDir(root), segments(root)[0]), 'utf8').split('\n')) {
    assert.ok(Buffer.byteLength(line) < MAX_LINE_BYTES);
  }
}

function testPartsAndReader() {
  const root = fixture();
  assert.equal(appendEvent(root, toolEvent({ taskId: 'a' })), true);
  const { cursor } = readEvents(root);
  const first = path.join(eventsDir(root), segments(root)[0]);
  fs.appendFileSync(first, 'not json\n' + JSON.stringify({ ...toolEvent(), v: 2 }) + '\n');
  fs.appendFileSync(first, 'p'.repeat(PART_MAX_BYTES) + '\n');
  assert.equal(appendEvent(root, toolEvent({ taskId: 'b' })), true);
  assert.deepEqual(segments(root), [segmentName(new Date(), 0), segmentName(new Date(), 1)]);

  const second = path.join(eventsDir(root), segments(root)[1]);
  fs.appendFileSync(second, JSON.stringify(toolEvent({ taskId: 'c' })).slice(0, 30));
  const res = readEvents(root, cursor);
  assert.deepEqual(res.events.map((e) => e.data.taskId), ['b'], 'skips bad, v2 and trailing lines');
  assert.ok(res.cursor.startsWith(`${segments(root)[1]}:`));
  fs.appendFileSync(second, 'zz\n');
  const garbage = readEvents(root, res.cursor);
  assert.equal(garbage.events.length, 0, 'completed torn tail does not parse');
  assert.equal(appendEvent(root, toolEvent({ taskId: 'd' })), true);
  const again = readEvents(root, garbage.cursor);
  assert.deepEqual(again.events.map((e) => e.data.taskId), ['d']);
}

function testPrune() {
  const root = fixture();
  const dir = path.join(root, '.nativ', 'events');
  fs.mkdirSync(dir, { recursive: true });
  const old = segmentName(new Date(Date.now() - 20 * 86400000), 0);
  fs.writeFileSync(path.join(dir, old), '{}\n');
  const day = (n) => new Date(Date.now() - n * 86400000);
  const sized = [segmentName(day(3), 0), segmentName(day(2), 0), segmentName(day(1), 0)];
  for (const name of sized) {
    const fd = fs.openSync(path.join(dir, name), 'w');
    fs.ftruncateSync(fd, 40 * 1024 * 1024);
    fs.closeSync(fd);
  }
  const seen = [];
  const deleted = pruneEvents(root, { beforeDelete: (f) => seen.push(path.basename(f)) });
  assert.deepEqual(deleted.sort(), [old, sized[0]].sort());
  assert.deepEqual(seen.sort(), deleted.sort());
  assert.deepEqual(segments(root), sized.slice(1));
}

await testConcurrency();
testAppendRules();
testPartsAndReader();
testPrune();
console.log('Event log tests passed');
