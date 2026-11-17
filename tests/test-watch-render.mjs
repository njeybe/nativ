import assert from 'node:assert/strict';
import {
  EMPTY_MESSAGE, renderScreen, renderHeader, eventLine, truncate, laneRow, filterByTask, pollStep,
} from '../dist/commands/watch-render.js';
import { parseWindow } from '../dist/commands/watch.js';

console.log('--- Watch renderer ---');

const at = (h, m, s) => new Date(2026, 0, 2, h, m, s).getTime();
const iso = (h, m, s) => new Date(at(h, m, s)).toISOString();

const lane = (over) => ({
  id: 'run:r1', label: 'runner', kind: 'runner', role: null, model: 'sonnet', status: 'active',
  startedAt: iso(10, 0, 0), lastAt: iso(10, 0, 5), elapsedMs: 125000,
  task: { id: 'task-1', title: 'T', via: 'command' },
  last: { at: iso(10, 0, 5), text: 'Edit src/a.ts +3 -1' },
  files: { count: 2, source: 'git', top: [] },
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 1500 },
  runId: 'r1', sessionId: null, ...over,
});
const lanes = [
  lane({}),
  lane({ id: 's:s1', label: 'main session', model: null, status: 'idle', task: null, last: null,
    tokens: null, elapsedMs: 8000, files: { count: 0, source: 'events', top: [] } }),
];
const events = [
  { v: 1, at: iso(10, 0, 5), src: 'hook', lane: { id: 'run:r1' }, kind: 'tool',
    data: { name: 'Edit', path: 'src/a.ts', added: 3, removed: 1, ok: true }, task: { id: 'task-1', via: 'command' } },
  { v: 1, at: iso(10, 0, 6), src: 'hook', lane: { id: 's:s1' }, kind: 'usage',
    data: { model: 'm', turns: 1, input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } },
];

// Header
assert.equal(renderHeader(2, 30, at(10, 0, 7)), 'nativ watch   2 lanes   window 30m   10:00:07');

// Lane rows: unknown values show '-'
assert.deepEqual(laneRow(lanes[0]),
  ['runner (sonnet)', 'task-1', 'active', 'Edit src/a.ts +3 -1', '2', '1.5k', '2m05s']);
assert.deepEqual(laneRow(lanes[1]), ['main session', '-', 'idle', '-', '0', '-', '8s']);

// Event line
assert.equal(eventLine(events[0], lanes), '10:00:05  runner  task-1  Edit src/a.ts +3 -1');

// Full screen
const screen = renderScreen(lanes, events, { width: 100, windowMinutes: 30, now: at(10, 0, 7) });
const rows = screen.split('\n');
assert.equal(rows[0], 'nativ watch   2 lanes   window 30m   10:00:07');
assert.match(rows[2], /^LANE\s+TASK\s+STATUS\s+LAST\s+FILES\s+TOKENS\s+TIME$/);
assert.ok(rows.includes('10:00:05  runner  task-1  Edit src/a.ts +3 -1'));

// Truncation to width
const narrow = renderScreen(lanes, events, { width: 30, windowMinutes: 30, now: at(10, 0, 7) });
assert.ok(narrow.split('\n').every((l) => l.length <= 30));
assert.equal(truncate('abcdefghij', 8), 'abcde...');

// Empty state
const empty = renderScreen([], [], { width: 200, windowMinutes: 30, now: at(10, 0, 7) });
assert.ok(empty.includes(EMPTY_MESSAGE));
assert.equal(EMPTY_MESSAGE,
  'No agent activity yet. Chat agents are recorded after nativ setup; Studio runs always are.');

// Window validation
assert.equal(parseWindow(undefined), 30);
assert.equal(parseWindow('1'), 1);
assert.equal(parseWindow('1440'), 1440);
for (const bad of ['0', '1441', 'abc', '1.5']) {
  assert.throws(() => parseWindow(bad), /--window must be a whole number of minutes from 1 to 1440/);
}

// --task keeps folded-task lanes and their untagged events
const f = filterByTask(lanes, events, 'task-1');
assert.deepEqual(f.lanes.map((l) => l.id), ['run:r1']);
assert.equal(f.events.length, 1);
const untagged = { ...events[0], task: undefined, at: iso(10, 0, 9) };
assert.equal(filterByTask(lanes, [untagged, events[1]], 'task-1').events.length, 1);
assert.equal(filterByTask(lanes, events, undefined).events.length, 2);

// A throwing reader keeps the cursor; the next call recovers
const st = { cursor: 'c1', events: [] };
assert.deepEqual(pollStep(() => { throw new Error('pruned'); }, st), []);
assert.equal(st.cursor, 'c1');
assert.equal(pollStep((c) => ({ events: [events[0]], cursor: c + 'x' }), st).length, 1);
assert.equal(st.cursor, 'c1x');
assert.equal(st.events.length, 1);

console.log('Watch renderer tests passed');
