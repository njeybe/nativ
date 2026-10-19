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
    notes: extra.notes || '', isAvailable: status === 'pending' && !extra.deps, circuitBreaker: extra.cb,
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
const B = { state: { tasksView: 'board' } };
let html = renderPage('tasks', api, B);
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
assert.ok(html.includes('Waits for r-1, p-ready'), 'waiting lists only unfinished deps');
assert.ok(html.includes('attempt 2 of 3'), 'running attempt');
assert.ok(/Running <span data-since="\d+">/.test(html), 'live timer');
assert.ok(html.includes('Paused after 3 of 3 attempts'));
assert.ok(!/<button[^>]*data-act="task-/.test(html), 'no action buttons on cards');

// A stale claim (over 4 hours, no run) sits in Up next, not Running.
const staleApi = { milestones: [{ id: 'm8', name: 'Stale', tasks: [
  { ...task('stale-1', 'in_progress'), claimedAt: iso(300) }] }] };
html = renderPage('tasks', staleApi, B);
assert.deepEqual(idsIn(html, 'pending'), ['stale-1'], 'stale claim lands in Up next');
assert.deepEqual(idsIn(html, 'in_progress'), [], 'stale claim is not running');
assert.ok(!/data-since|Waits for/.test(html), 'stale card has no timer or waits text');

// Empty columns.
const lone = { milestones: [{ id: 'm9', name: 'Solo', tasks: [task('x', 'pending')] }] };
html = renderPage('tasks', lone, B);
for (const col of ['pending', 'in_progress', 'completed', 'blocked']) {
  assert.ok(html.includes('data-col="' + col + '"'), 'lane ' + col + ' renders');
}
for (const name of ['Up next', 'Running', 'Done', 'Stuck']) assert.ok(html.includes(name), name);
assert.equal((html.match(/class="col-empty">None</g) || []).length, 3, 'empty lanes show None');
assert.ok(!html.includes('Empty right now'), 'no empty-lanes note');
assert.ok(!html.includes('Just finished'), 'lane renamed');
assert.ok(!html.includes('Other milestones'), 'no other milestones section when alone');

// Selecting another milestone; all-done fallback goes to the last milestone.
html = renderPage('tasks', api, { state: { milestoneId: 'm1', tasksView: 'board' } });
assert.deepEqual(idsIn(html, 'completed'), ['t-1', 't-2']);
assert.ok(!html.includes('Show all'), 'no cap link for two tasks');
const finished = { milestones: [m1] };
html = renderPage('tasks', finished, B);
assert.match(html, /<option value="m1" selected>/);

// Other milestones: newest first, pill, date, work time, cost, collapsed by default.
html = renderPage('tasks', api, B);
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
  "Studio.pages.tasks.render({ model: Studio.model, state: Studio.state, fmt: Studio.fmt, ui: Studio.ui, "
  + "width: 1200 })", sx);
const act = (name, attrs = {}) => {
  sx.__el = { getAttribute: (k) => attrs[k] };
  vm.runInContext(`Studio.pages.tasks.actions['${name}'](__el, {})`, sx);
};
sx.Studio.state.tasksView = 'board';
sx.Studio.state.milestoneId = 'm2';
assert.equal(idsIn(draw(), 'completed').length, 5);
act('tasks-more');
html = draw();
assert.equal(idsIn(html, 'completed').length, 7, 'Show all reveals every task');
assert.deepEqual(idsIn(html, 'completed').slice(-1), ['d-g'], 'untimed last');
assert.ok(html.includes('Show fewer'));
sx.Studio.state.milestoneId = 'm1';
draw();
sx.Studio.state.tasksView = 'board';
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

// List view: a fresh Studio with a fake localStorage and a recording taskAction.
function listStudio(fixture = api, stored = null) {
  const ctx = createStudio();
  const store = stored == null ? {} : { 'nativ-studio:tasks-view': stored };
  ctx.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  ctx.__store = store;
  loadModel(ctx, fixture);
  vm.runInContext(wrapPage(pages.find((p) => p.id === 'tasks').script), ctx);
  vm.runInContext('Studio.calls = []; Studio.openTask = function (id) { Studio.calls.push("open:" + id); }; Studio.taskAction = function (n, id) { Studio.calls.push(n + ":" + id); };'
    + ' Studio.repaint = function () {};', ctx);
  const paint = () => vm.runInContext("Studio.pages.tasks.render({ model: Studio.model, state: Studio.state, "
    + "fmt: Studio.fmt, ui: Studio.ui, width: 1200 })", ctx);
  const press = (name, attrs = {}) => {
    ctx.__el = { getAttribute: (k) => attrs[k] };
    vm.runInContext(`Studio.pages.tasks.actions['${name}'](__el, { model: Studio.model })`, ctx);
  };
  return { ctx, paint, press };
}

// List is the default, with a header row and the group headers.
let L = listStudio();
html = L.paint();
assert.ok(!html.includes('class="board"'), 'list is the default view');
assert.ok(html.includes('class="tlist"'), 'list rendered');
assert.match(html, /data-mode="list" aria-pressed="true"/, 'List toggle pressed');
assert.ok(html.includes('role="columnheader">Id<'), 'header row with column labels');
assert.ok(html.includes('7 of 11'), 'group shows done of total');

// Filter counts: running r-1, ready p-ready and z-1, blocked s-1, done 9.
for (const [f, n] of [['all', 14], ['running', 1], ['next', 3], ['stuck', 1], ['done', 9]]) {
  assert.match(html, new RegExp(`data-filter="${f}" aria-pressed="(true|false)">[A-Za-z ]+ <span class="num">${n}<`),
    'count for ' + f);
}
assert.equal((html.match(/aria-pressed="true"/g) || []).length, 2, 'one filter and one view pressed');

// Completed milestones start collapsed; toggling opens them.
assert.match(html, /data-group="m1" aria-expanded="false"/, 'completed milestone collapsed');
assert.match(html, /data-group="m2" aria-expanded="true"/, 'open milestone expanded');
assert.ok(!html.includes('data-tid="t-1"'), 'collapsed group hides rows');
L.press('tasks-group', { 'data-group': 'm1' });
html = L.paint();
assert.match(html, /data-group="m1" aria-expanded="true"/, 'group expands on toggle');
assert.ok(html.includes('data-tid="t-1"'), 'expanded group shows rows');

// Rows: focusable, open the inspector, truncation title, Dispatch only on ready rows.
assert.match(html, /class="trow" role="row" tabindex="0" data-act="tasks-open" data-tid="r-1"/);
assert.ok(html.includes('title="Title of r-1"'), 'title attribute keeps the full text');
assert.ok(!html.includes('class="dot"'), 'no status dot');
assert.ok(html.includes('data-act="tasks-dispatch" data-tid="p-ready"'), 'ready row has Dispatch');
assert.ok(!html.includes('data-act="tasks-dispatch" data-tid="p-wait"'), 'waiting row has no Dispatch');
assert.ok(!html.includes('data-act="tasks-dispatch" data-tid="r-1"'), 'running row has no Dispatch');
L.press('tasks-open', { 'data-tid': 'r-1' });
L.press('tasks-dispatch', { 'data-tid': 'p-ready' });
assert.deepEqual([...L.ctx.Studio.calls], ['open:r-1', 'dispatch:p-ready'], 'row and Dispatch actions');

// Filter application and the empty-filter state.
L.press('tasks-filter', { 'data-filter': 'stuck' });
html = L.paint();
assert.match(html, /data-filter="stuck" aria-pressed="true"/);
assert.ok(html.includes('data-tid="s-1"') && !html.includes('data-tid="r-1"'), 'filter applies to list');
const noBlock = { milestones: [m3] };
const E = listStudio(noBlock);
E.press('tasks-filter', { 'data-filter': 'stuck' });
html = E.paint();
assert.ok(html.includes('No tasks match this filter.'), 'empty filter copy');
assert.ok(html.includes('data-act="tasks-clear">Clear filter<'), 'Clear filter button');
E.press('tasks-clear');
assert.ok(E.paint().includes('data-tid="z-1"'), 'clear filter shows rows again');

// Studio.taskFilter from the pulse strip is applied once, then cleared.
const P = listStudio();
P.ctx.Studio.taskFilter = 'running';
html = P.paint();
assert.match(html, /data-filter="running" aria-pressed="true"/, 'pulse filter applied');
assert.ok(!html.includes('data-tid="s-1"'), 'pulse filter hides others');
assert.equal(P.ctx.Studio.taskFilter, null, 'pulse filter cleared');

// Toggle persistence: Board is saved and restored; the filter also applies to the board.
L.press('tasks-view', { 'data-mode': 'board' });
assert.equal(L.ctx.__store['nativ-studio:tasks-view'], 'board', 'view saved');
html = L.paint();
assert.ok(html.includes('class="board"'), 'board shown after toggle');
assert.deepEqual(idsIn(html, 'in_progress'), [], 'board honours the blocked filter');
const R = listStudio(api, 'board');
assert.ok(R.paint().includes('class="board"'), 'stored board view restored');

// No plan, skeleton, and source hygiene.
assert.ok(listStudio({ milestones: [] }).paint().includes('No plan yet. Ask the architect to design one.'));
assert.ok(vm.runInContext('Studio.pages.tasks.skeleton()', L.ctx).includes('tskel'), 'skeleton rows');
const src = pages.find((p) => p.id === 'tasks').script;
assert.ok(!src.includes('`') && !src.includes('${'), 'no backticks or dollar-brace in client code');
assert.doesNotThrow(() => new vm.Script(wrapPage(src)), 'script parses');
assert.ok(!/[–—]/.test(src), 'no em or en dashes');

console.log('✔ Tasks page render checks passed');
