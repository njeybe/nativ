import assert from 'node:assert/strict';
import { renderPage, NOW } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-home.mjs`: renders the Home page from fixture data, no DOM.
console.log('--- Starting Studio Home page verification ---');

const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();
const task = (id, status, extra = {}) => ({
  id, title: 'Title of ' + id, status, assignedSubagent: 'backend', dependencies: [], ...extra,
});
const timing = (id, endMinsAgo) => ({
  taskId: id, startedAt: iso(endMinsAgo + 4), completedAt: iso(endMinsAgo), durationMs: 240_000,
});
const contracts = (n) => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  return Object.fromEntries(names.map((k, i) => [k, i < n]));
};

function calmApi(extra = {}) {
  const done = [];
  for (let i = 1; i <= 8; i++) done.push(task('task-' + i, 'completed'));
  return {
    milestones: [
      { id: 'm1', name: 'Initial Setup & Contract Verification', tasks: [done[0]] },
      { id: 'm2', name: 'Second: details after colon', tasks: done.slice(1, 8) },
    ],
    status: { contracts: contracts(5) },
    telemetry: {
      summary: { actual: { spendUsd: 6.18, cacheHitRate: 0.976, cacheSavingsUsd: 39.73 } },
      // task-1 has no timing at all; the rest finished at staggered times
      taskBreakdowns: done.slice(1).map((t, i) => timing(t.id, 10 + i * 30)),
    },
    runs: [], escalations: [], logTail: {},
    ...extra,
  };
}

function busyApi() {
  return {
    milestones: [{
      id: 'm3', name: 'Busy milestone: things',
      tasks: [
        task('task-a', 'blocked', {
          notes: 'Verification failed after 3 attempts: heading missing.',
          circuitBreaker: { consecutiveFailures: 3 },
        }),
        task('task-b', 'blocked'),
        task('task-c', 'in_progress', { assignedSubagent: 'frontend' }),
        task('task-d', 'pending', { dependencies: ['task-c'] }),
        task('task-e', 'completed'),
      ],
    }],
    status: { contracts: contracts(3) },
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

const idOrder = (html, ids) => ids.map((id) => html.indexOf('data-task="' + id + '"'));
const ascending = (list) => list.every((n, i) => n >= 0 && (i === 0 || n > list[i - 1]));
const section = (html, title) => {
  const start = html.indexOf('<h2>' + title + '</h2>');
  assert.ok(start >= 0, 'section ' + title);
  const next = html.indexOf('<section', start);
  return html.slice(start, next < 0 ? undefined : next);
};

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

test('calm state and idle state with last finished task', () => {
  const html = renderPage('home', calmApi());
  assert.match(html, /Nothing needs you\. No stuck tasks, questions or proposals\./);
  assert.match(html, /All clear/);
  assert.match(html, /Idle/);
  assert.match(html, /No agent is working\. Last finished <span class="mono">task-2<\/span> 10m ago\./);
  assert.doesNotMatch(html, /See what failed/);
});

test('idle with nothing finished yet', () => {
  const api = { milestones: [{ id: 'm1', name: 'A', tasks: [task('task-1', 'pending')] }], runs: [], escalations: [] };
  const html = renderPage('home', api);
  assert.match(html, /Last finished nothing yet\./);
  assert.match(html, /Nothing has finished yet\./);
});

test('Needs you lists one item per task with the right actions', () => {
  const html = renderPage('home', busyApi());
  const sec = section(html, 'Needs you');
  assert.match(sec, /3 items/);
  assert.equal((sec.match(/class="need"/g) || []).length, 3);
  assert.match(sec, /Verification failed after 3 attempts: heading missing\./);
  assert.match(sec, /Paused after 3 attempts\./);
  assert.match(sec, /Which table should this use\?/);
  assert.equal((sec.match(/See what failed/g) || []).length, 2);
  assert.match(sec, /data-act="home-proposal" data-id="task-a"/);
  assert.match(sec, /data-act="home-ask" data-id="task-b"/);
  assert.doesNotMatch(sec, /data-act="home-ask" data-id="task-a"/);
  assert.equal((sec.match(/data-act="home-start"/g) || []).length, 2);
  assert.match(sec, /Open task/);
});

test('Right now shows only running tasks with timer and latest log', () => {
  const html = renderPage('home', busyApi());
  const sec = section(html, 'Right now');
  assert.match(sec, /1 working/);
  assert.match(sec, /data-task="task-c"/);
  assert.equal((sec.match(/data-task=/g) || []).length, 1);
  assert.match(sec, new RegExp('data-since="' + (NOW - 2 * 60_000) + '">2m 00s<'));
  assert.match(sec, /<div class="log">Writing the home page<\/div>/);
  assert.doesNotMatch(sec, /No agent is working/);
});

test('figure strip shows milestones, tasks, spend and plan files', () => {
  const html = renderPage('home', calmApi());
  const strip = html.slice(html.indexOf('class="panel strip"'), html.indexOf('<h2>Just finished'));
  assert.match(strip, /Milestones<\/span><span class="v">2<small> \/ 2<\/small>/);
  assert.match(strip, /Tasks<\/span><span class="v">8<small> \/ 8<\/small><\/span><span class="s">all done/);
  assert.match(strip, /\$6\.18/);
  assert.match(
    strip,
    /97\.6% cached, saved about \$39\.73/,
  );
  assert.match(
    strip,
    /Plan files<\/span><span class="v">5<small> \/ 5<\/small><\/span><span class="s">all present and intact/,
  );
  const busy = renderPage('home', busyApi());
  assert.match(busy, /4 left/);
  assert.match(busy, /3<small> \/ 5<\/small><\/span><span class="s">2 missing/);
});

test('missing cost and plan data show a dash', () => {
  const api = calmApi({ status: {}, telemetry: { taskBreakdowns: [] } });
  const html = renderPage('home', api);
  assert.match(html, /Spend<\/span><span class="v">–<\/span><span class="s">no spend recorded/);
  assert.match(html, /Plan files<\/span><span class="v">–<small> \/ 5<\/small><\/span><span class="s">not checked/);
});

test('Just finished is newest first, capped at 6, with exact time on hover', () => {
  const html = renderPage('home', calmApi());
  const sec = section(html, 'Just finished');
  const rows = sec.match(/class="row-btn"/g) || [];
  assert.equal(rows.length, 6);
  // task-2 finished 10m ago, task-3 40m ago, and so on; task-1 has no time and is left out
  assert.ok(ascending(idOrder(sec, ['task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-7'])));
  assert.doesNotMatch(sec, /data-task="task-8"/);
  assert.doesNotMatch(sec, /data-task="task-1"/);
  assert.match(sec, /<time datetime="[^"]+" title="[^"]+">10m ago<\/time>/);
  assert.match(sec, /data-go="tasks">Open Tasks/);
});

test('milestones list is newest first and opens Tasks on click', () => {
  const html = renderPage('home', calmApi());
  const sec = section(html, 'Milestones');
  const order = ['m2', 'm1'].map((id) => sec.indexOf('data-ms="' + id + '"'));
  assert.ok(ascending(order));
  assert.match(sec, /<span class="t" title="Second: details after colon">Second<\/span>/);
  assert.match(sec, /style="width:100%"/);
  assert.match(sec, /7\/7/);
  assert.match(sec, /newest first/);
});

test('empty plan renders without failing', () => {
  const html = renderPage('home', { milestones: [], runs: [], escalations: [] });
  assert.match(html, /Nothing needs you/);
  assert.match(html, /No milestones yet\./);
  assert.match(html, /0<small> \/ 0<\/small>/);
});

test('page source has no backticks or template placeholders', async () => {
  const { homePage } = await import('../src/server/studio-ui/pages/home/index.ts');
  assert.ok(!homePage.script.includes('`'));
  assert.ok(!homePage.script.includes('${'));
  assert.ok(!homePage.css.includes('`'));
  const loose = homePage.css.split('\n').filter((l) => /^[#.a-z]/i.test(l) && !l.startsWith('#panel-home'));
  assert.deepEqual(loose, []);
});

console.log('\n✔ ' + passed + ' Studio Home checks passed');
