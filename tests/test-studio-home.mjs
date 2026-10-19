import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderPage, createStudio, loadModel, NOW } from './helpers/studio-harness.mjs';
import { wrapPage } from '../src/server/studio-ui/shell/pure.ts';
import { homePage } from '../src/server/studio-ui/pages/home/index.ts';

// Run with `npx tsx tests/test-studio-home.mjs`: renders the Home page from fixture data, no DOM.
console.log('--- Starting Studio Home page verification ---');

const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();
const task = (id, status, extra = {}) => ({
  id, title: 'Title of ' + id, status, assignedSubagent: 'backend', dependencies: [], ...extra,
});
const timing = (id, endMinsAgo) => ({
  taskId: id, startedAt: iso(endMinsAgo + 4), completedAt: iso(endMinsAgo), durationMs: 240_000,
});

function calmApi() {
  const done = [];
  for (let i = 1; i <= 8; i++) done.push(task('task-' + i, 'completed'));
  return {
    milestones: [
      { id: 'm1', name: 'Initial Setup', tasks: done.slice(0, 4) },
      { id: 'm2', name: 'Second milestone', tasks: [...done.slice(4), task('task-9', 'pending')] },
    ],
    telemetry: { taskBreakdowns: done.slice(1).map((t, i) => timing(t.id, 10 + i * 30)) },
    runs: [], escalations: [], logTail: {},
  };
}

function busyApi() {
  return {
    milestones: [{
      id: 'm3', name: 'Busy milestone',
      tasks: [
        task('task-a', 'blocked', { notes: 'Verification failed after 3 attempts: heading missing.' }),
        task('task-b', 'blocked'),
        task('task-c', 'in_progress', { assignedSubagent: 'frontend' }),
        task('task-d', 'pending', { dependencies: ['task-c'] }),
        task('task-e', 'completed'),
        task('task-f', 'pending'),
      ],
    }],
    telemetry: { taskBreakdowns: [timing('task-e', 5), { taskId: 'task-c', startedAt: iso(2) }] },
    runs: [],
    escalations: [
      { id: 'esc-1', taskId: 'task-a', status: 'pending_review', proposedPatch: { op: 'ADD' } },
      { id: 'esc-2', taskId: 'task-b', status: 'pending_review' },
      { id: 'esc-3', taskId: 'task-d', status: 'pending_review', reason: 'Which table should this use?' },
    ],
    logTail: { 'task-c': 'earlier line\n\u001b[32mWriting the home page\u001b[0m\n\n' },
  };
}

const sec = (html, key) => {
  const start = html.indexOf('data-sec="' + key + '"');
  assert.ok(start >= 0, 'section ' + key);
  const next = html.indexOf('<section', start);
  return html.slice(start, next < 0 ? undefined : next);
};

// Registers Home with a recording taskAction and returns a trigger for its data-act handlers.
function withActions(api) {
  const ctx = createStudio();
  loadModel(ctx, api);
  vm.runInContext(wrapPage(homePage.script), ctx);
  const calls = [];
  ctx.Studio.taskAction = (name, id) => calls.push([name, id]);
  const act = (name, id) => ctx.Studio.pages.home.actions[name]({ getAttribute: () => id });
  return { calls, act };
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

test('sections render in order', () => {
  const html = renderPage('home', busyApi());
  const order = ['decisions', 'running', 'next', 'milestone', 'activity']
    .map((k) => html.indexOf('data-sec="' + k + '"'));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), String(order));
});

test('decision queue shows only when decisions exist', () => {
  assert.doesNotMatch(renderPage('home', calmApi()), /data-sec="decisions"|Human Decision Required/);
  const q = sec(renderPage('home', busyApi()), 'decisions');
  assert.equal((q.match(/class="need"/g) || []).length, 3);
  assert.equal((q.match(/Human Decision Required/g) || []).length, 3);
  assert.match(q, /Verification failed after 3 attempts: heading missing\./);
  assert.match(q, /Which table should this use\?/);
  assert.match(q, /data-act="home-proposal" data-id="task-a"/);
  assert.match(q, /data-act="home-ask" data-id="task-b"/);
  assert.equal((q.match(/data-act="home-start"/g) || []).length, 2);
});

test('now running row with timer, log and Watch live only when a run exists', () => {
  const noRun = sec(renderPage('home', busyApi()), 'running');
  assert.doesNotMatch(noRun, /home-console/);
  assert.doesNotMatch(noRun, /class="dot/);
  const api = busyApi();
  api.runs = [{ taskId: 'task-c', runId: 'r1', status: 'running' }];
  const r = sec(renderPage('home', api), 'running');
  assert.match(r, /<span class="mono id">task-c<\/span>/);
  assert.match(r, /Running/);
  assert.match(r, new RegExp('data-since="' + (NOW - 2 * 60_000) + '">2m 00s<'));
  assert.match(r, /Writing the home page/);
  assert.match(r, /data-act="home-console" data-id="task-c">Watch live</);
});

test('Watch live and Dispatch call the shell task actions', () => {
  const page = withActions(busyApi());
  page.act('home-console', 'task-c');
  page.act('home-dispatch', 'task-f');
  page.act('home-proposal', 'task-a');
  assert.deepEqual(page.calls, [['logs', 'task-c'], ['dispatch', 'task-f'], ['proposal', 'task-a']]);
});

test('idle state offers Dispatch for the next ready task', () => {
  const r = sec(renderPage('home', calmApi()), 'running');
  assert.match(r, /No agent is running\./);
  assert.match(r, /data-act="home-dispatch" data-id="task-9"/);
});

test('up next: ready tasks dispatch, waiting tasks say how many they wait for', () => {
  const u = sec(renderPage('home', busyApi()), 'next');
  assert.match(u, /data-act="home-dispatch" data-id="task-f">Dispatch</);
  assert.match(u, /Waits for 1 task/);
  assert.doesNotMatch(u, /data-act="home-dispatch" data-id="task-d"/);
});

test('milestone progress shows done of total with no filled track', () => {
  const m = sec(renderPage('home', calmApi()), 'milestone');
  assert.match(m, /Second milestone/);
  assert.match(m, /4 of 5/);
  assert.match(m, /style="width:80%"/);
  const rule = homePage.css.split('\n').find((l) => l.includes('.progress {'));
  assert.doesNotMatch(rule, /background/);
});

test('recent activity: one row per task, titles and state words', () => {
  const a = sec(renderPage('home', calmApi()), 'activity');
  const rows = [...a.matchAll(/data-event="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(rows.length, 7);
  assert.equal(rows[0], 'task-2');
  assert.match(a, /class="mono num when"/);
  assert.match(a, /data-task="task-2">Title of task-2</);
  assert.match(a, /Done, took 4m 00s/);
  assert.doesNotMatch(a, />(completed|started)</);
  const b = sec(renderPage('home', busyApi()), 'activity');
  assert.match(b, /data-event="task-c"[^]*?Running/);
  assert.match(b, /data-event="task-e"[^]*?Done, took 4m 00s/);
});

test('empty plan and loading copy', () => {
  const html = renderPage('home', { milestones: [], runs: [], escalations: [] });
  assert.match(html, /No plan yet\. Ask the architect to design one\./);
  const ctx = createStudio();
  vm.runInContext(wrapPage(homePage.script), ctx);
  const skel = ctx.Studio.pages.home.skeleton();
  assert.equal((skel.match(/skel-row/g) || []).length, 4);
});

test('no emojis or long dashes in the page', () => {
  const html = renderPage('home', busyApi()) + homePage.script;
  assert.doesNotMatch(html, /[–—]|\p{Extended_Pictographic}/u);
});

test('a completed task leaves the queue even if its escalation stays open', () => {
  const api = busyApi();
  api.escalations.push({ id: 'esc-4', taskId: 'task-e', status: 'pending_review', reason: 'Old question' });
  const q = sec(renderPage('home', api), 'decisions');
  assert.match(q, /3 items/);
  assert.doesNotMatch(q, /task-e/);
  assert.doesNotMatch(q, /Old question/);
});

test('decision items keep their task and reason hooks', () => {
  const q = sec(renderPage('home', busyApi()), 'decisions');
  assert.match(q, /data-need="task-a"/);
  assert.match(q, /data-need="task-b"/);
  assert.match(q, /data-need="task-d"/);
  assert.match(q, /Paused after 3 attempts\./);
  assert.equal((q.match(/See what failed/g) || []).length, 2);
  assert.match(q, /Open task/);
  assert.doesNotMatch(q, /data-act="home-ask" data-id="task-a"/);
  assert.match(q, /<span class="mono">task-a<\/span>/);
});

test('now running lists only running tasks', () => {
  const r = sec(renderPage('home', busyApi()), 'running');
  assert.match(r, /1 running/);
  assert.doesNotMatch(r, /No agent is running/);
  assert.doesNotMatch(r, /task-a|task-e/);
  assert.match(r, />Frontend</);
  assert.doesNotMatch(r, /class="dot/);
});

test('up next caps rows and puts ready tasks first', () => {
  const u = sec(renderPage('home', busyApi()), 'next');
  assert.ok(u.indexOf('task-f') < u.indexOf('task-d'));
  assert.doesNotMatch(u, /data-task="task-c"|task-e/);
  const none = sec(renderPage('home', { milestones: [{ id: 'm', name: 'M', tasks: [task('x', 'completed')] }] }), 'next');
  assert.match(none, /Nothing is waiting\./);
});

test('styles follow the Ink rules', () => {
  const css = homePage.css;
  assert.match(css, /\.decisions \{[^}]*border-left: 3px solid var\(--warn\)/);
  assert.match(css, /\.decisions \{[^}]*box-shadow: var\(--shadow\)/);
  assert.match(css, /\.decisions \{[^}]*border-radius: 6px/);
  assert.match(css, /\.row \{[^}]*min-height: 36px/);
  assert.doesNotMatch(css, /960px|.dot/);
  assert.match(css, /@media \(max-width: 1024px\)/);
  assert.match(css, /\.progress i \{[^}]*height: 4px/);
  assert.doesNotMatch(css, /border-radius: 12px/);
});

test('page source parses and has no backticks or template placeholders', () => {
  assert.ok(!homePage.script.includes('`'));
  assert.ok(!homePage.script.includes('${'));
  assert.ok(!homePage.css.includes('`'));
  new vm.Script(wrapPage(homePage.script));
  const loose = homePage.css.split('\n').filter((l) => /^[#.a-z]/i.test(l) && !l.startsWith('#panel-home'));
  assert.deepEqual(loose, []);
});

console.log('\n' + passed + ' Studio Home checks passed');
