import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pureScript, wrapPage } from '../src/server/studio-ui/shell/pure.ts';
import { pages } from '../src/server/studio-ui/pages/index.ts';
import { NOW, createStudio, loadModel, renderPage } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-tasks-view.mjs`.
console.log('--- Starting Studio Tasks page verification ---');

const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();

function task(id, status, extra = {}) {
  return {
    id, title: `Title of ${id}`, status, assignedSubagent: 'backend',
    dependencies: extra.deps || [], targetFiles: [], verificationCommand: 'true',
    notes: extra.notes || '', isAvailable: status === 'pending', circuitBreaker: extra.cb,
  };
}
const crumb = (id, minsAgo, durMs = 60_000) => ({
  taskId: id, completedAt: iso(minsAgo), startedAt: iso(minsAgo + 1), durationMs: durMs,
});

// m1 finished, m2 has all four states and 7 finished tasks, m3 is empty of finished work.
const m1 = { id: 'm1', name: 'Initial Setup: first steps', status: 'completed',
  tasks: [task('t-1', 'completed'), task('t-2', 'completed')] };
const m2Done = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => task('d-' + k, 'completed'));
const m2 = { id: 'm2', name: 'Build: the board', status: 'in_progress', tasks: [
  ...m2Done,
  task('p-ready', 'pending', { deps: ['d-a'] }),
  task('p-wait', 'pending', { deps: ['r-1', 'd-a', 'p-ready'] }),
  task('r-1', 'in_progress', { cb: { consecutiveFailures: 1, maxThreshold: 3 } }),
  task('s-1', 'blocked', { cb: { consecutiveFailures: 3, maxThreshold: 3 } }),
] };
const m3 = { id: 'm3', name: 'Later', status: 'pending', tasks: [task('z-1', 'pending')] };

// Finish times: d-a oldest of the timed ones, d-g has no time at all.
const mins = { 'd-a': 50, 'd-b': 40, 'd-c': 10, 'd-d': 30, 'd-e': 20, 'd-f': 5 };
const api = {
  milestones: [m1, m2, m3],
  telemetry: { taskBreakdowns: [
    ...Object.entries(mins).map(([id, m]) => crumb(id, m, 125_000)),
    crumb('t-1', 5000, 90_000),
    { taskId: 'r-1', startedAt: iso(2) },
  ] },
  runs: [], escalations: [],
};

const idsIn = (html, col) => {
  const start = html.indexOf(`data-col="${col}"`);
  const end = html.indexOf('data-col=', start + 10);
  const part = html.slice(start, end === -1 ? html.indexOf('Other milestones') : end);
  return [...part.matchAll(/data-task="([^"]+)"/g)].map((m) => m[1]);
};

// Default is the first milestone with unfinished work.
let html = renderPage('tasks', api);
assert.match(html, /<option value="m2" selected>/, 'active milestone preselected');
assert.ok(html.includes('data-ms-select'), 'selector present');

// Board shows only the selected milestone.
const board = html.slice(html.indexOf('class="board"'), html.indexOf('Other milestones'));
assert.ok(!board.includes('t-1') && !board.includes('z-1'), 'other milestones stay off the board');
assert.deepEqual(idsIn(html, 'pending'), ['p-ready', 'p-wait']);
assert.deepEqual(idsIn(html, 'in_progress'), ['r-1']);
assert.deepEqual(idsIn(html, 'blocked'), ['s-1']);

// Just finished: newest first, capped at 5, untimed last.
assert.deepEqual(idsIn(html, 'completed'), ['d-f', 'd-c', 'd-e', 'd-d', 'd-b']);
assert.ok(html.includes('Show all 7'), 'Show all N link');
assert.ok(html.includes('took 2m 05s'), 'took duration');

// Card texts.
assert.ok(html.includes('Ready to start'));
assert.ok(html.includes('Waiting on r-1, p-ready'), 'waiting lists only unfinished deps');
assert.ok(html.includes('attempt 2 of 3'), 'running attempt');
assert.ok(/Running <span data-since="\d+">/.test(html), 'live timer');
assert.ok(html.includes('Paused after 3 of 3 attempts'));
assert.ok(!/<button[^>]*data-act="task-/.test(html), 'no action buttons on cards');

// Empty columns.
const lone = { milestones: [{ id: 'm9', name: 'Solo', tasks: [task('x', 'pending')] }] };
html = renderPage('tasks', lone, {});
for (const text of ['Nothing queued', 'No task is running', 'Nothing finished yet', 'Nothing is stuck']) {
  assert.equal(html.includes(text), text !== 'Nothing queued', text);
}
assert.ok(!html.includes('Other milestones'), 'no other milestones section when alone');

// Selecting another milestone; all-done fallback goes to the last milestone.
html = renderPage('tasks', api, { state: { milestoneId: 'm1' } });
assert.deepEqual(idsIn(html, 'completed'), ['t-1', 't-2']);
assert.ok(!html.includes('Show all'), 'no cap link for two tasks');
const finished = { milestones: [m1] };
html = renderPage('tasks', finished, {});
assert.match(html, /<option value="m1" selected>/);

// Other milestones: newest first, pill, date, work time, cost, collapsed by default.
html = renderPage('tasks', api, {});
const others = html.slice(html.indexOf('Other milestones'));
assert.ok(others.indexOf('data-ms-id="m3"') < others.indexOf('data-ms-id="m1"'), 'newest first');
assert.ok(!others.includes('data-ms-id="m2"'), 'selected milestone is not repeated');
assert.equal((others.match(/aria-expanded="false"/g) || []).length, 2);
assert.ok(others.includes('>2/2</span>') && others.includes('status-pill completed'), 'done pill');
assert.ok(others.includes('0/1') && others.includes('status-pill in_progress'), 'open pill');
assert.ok(others.includes('no timing'), 'milestone without timing');
assert.ok(others.includes('1m 30s work'), 'work time');
assert.ok(!others.includes('data-task='), 'collapsed rows hide tasks');

// Interaction: Show all, Show fewer, reset on milestone change, expanding a row.
const sx = createStudio();
loadModel(sx, api);
vm.runInContext(wrapPage(pages.find((p) => p.id === 'tasks').script), sx);
const draw = () => vm.runInContext(
  "Studio.pages.tasks.render({ model: Studio.model, state: Studio.state, fmt: Studio.fmt, ui: Studio.ui, width: 1200 })", sx);
const act = (name, attrs = {}) => {
  sx.__el = { getAttribute: (k) => attrs[k] };
  vm.runInContext(`Studio.pages.tasks.actions['${name}'](__el, {})`, sx);
};
sx.Studio.state.milestoneId = 'm2';
assert.equal(idsIn(draw(), 'completed').length, 5);
act('tasks-more');
html = draw();
assert.equal(idsIn(html, 'completed').length, 7, 'Show all reveals every task');
assert.deepEqual(idsIn(html, 'completed').slice(-1), ['d-g'], 'untimed last');
assert.ok(html.includes('Show fewer'));
sx.Studio.state.milestoneId = 'm1';
draw();
sx.Studio.state.milestoneId = 'm2';
assert.equal(idsIn(draw(), 'completed').length, 5, 'cap resets after a milestone change');

act('tasks-hist', { 'data-ms-id': 'm1' });
html = draw();
assert.ok(html.includes('data-ms-id="m1" aria-expanded="true"'));
const rows = html.slice(html.indexOf('hist-tasks'));
assert.ok(rows.indexOf('data-task="t-1"') < rows.indexOf('data-task="t-2"'), 'newest first, untimed last');
assert.ok(rows.includes('1m 30s'), 'took column');
act('tasks-hist', { 'data-ms-id': 'm1' });
assert.ok(!draw().includes('hist-tasks'), 'collapses again');

console.log('✔ Tasks page render checks passed');
