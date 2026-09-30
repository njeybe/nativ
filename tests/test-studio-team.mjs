import assert from 'node:assert/strict';
import { renderPage, NOW } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-team.mjs`: renders the Team page from fixture data, no DOM.
console.log('--- Starting Studio Team page verification ---');

const iso = (minsAgo) => new Date(NOW - minsAgo * 60_000).toISOString();
const task = (id, agent, status) => ({
  id, title: 'Title of ' + id, status, assignedSubagent: agent, dependencies: [],
});
const timing = (id, endMinsAgo, durationMs, costUsd) => ({
  taskId: id, startedAt: iso(endMinsAgo + 5), completedAt: iso(endMinsAgo), durationMs,
  ...(costUsd ? { actual: { costUsd } } : {}),
});

function api(tasks, breakdowns = []) {
  return {
    milestones: [{ id: 'm1', name: 'One', tasks }],
    status: {}, telemetry: { taskBreakdowns: breakdowns }, runs: [], escalations: [], logTail: {},
  };
}

const fixture = api(
  [
    task('d-1', 'database', 'pending'),
    task('b-1', 'backend', 'completed'),
    task('b-2', 'backend', 'completed'),
    task('b-3', 'backend', 'completed'),
    task('b-4', 'backend', 'pending'),
    task('f-1', 'frontend', 'completed'),
    task('f-2', 'frontend', 'in_progress'),
    task('f-3', 'frontend', 'pending'),
    task('q-1', 'qa-tester', 'blocked'),
    task('q-2', 'qa-tester', 'pending'),
  ],
  [
    timing('b-1', 60, 60_000, 0.5),
    timing('b-2', 30, 180_000, 0.25),
    // b-3 completed with no timing at all
    timing('f-1', 120, 300_000),
    { taskId: 'f-2', startedAt: iso(3) },
  ],
);

const html = renderPage('team', fixture);
const rowOf = (agent) => {
  const start = html.indexOf('<tr data-agent="' + agent + '"');
  assert.ok(start >= 0, 'row for ' + agent);
  return html.slice(start, html.indexOf('</tr>', start));
};
const cells = (agent) => [...rowOf(agent).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
const text = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// Row order: most tasks first
const order = [...html.matchAll(/<tr data-agent="([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(order, ['backend', 'frontend', 'qa-tester', 'database']);

// Done / total
assert.equal(text(cells('backend')[2]), '3 / 4');
assert.equal(text(cells('frontend')[2]), '1 / 3');
assert.equal(text(cells('database')[2]), '0 / 1');

// Averages and totals use only completed tasks that have timing
const b = cells('backend').map(text);
assert.equal(b[4], '2m 00s', 'avg over the two timed tasks, not three');
assert.equal(b[5], '4m 00s', 'total time');
assert.equal(b[6], '$0.75', 'cost sum');
assert.ok(cells('backend')[7].includes('title="'), 'exact time on hover');
assert.equal(b[7], '30m ago');

// Right now: running chip, stuck chip, idle
const f = cells('frontend');
assert.ok(f[1].includes('data-task="f-2"') && text(f[1]) === 'f-2', 'running chip');
const q = cells('qa-tester');
assert.ok(q[1].includes('data-task="q-1"') && text(q[1]) === 'Stuck on q-1', 'stuck chip');
assert.equal(text(cells('backend')[1]), 'Idle');

// Running wins over stuck when an agent has both
const both = renderPage('team', api([
  task('x-1', 'backend', 'blocked'), task('x-2', 'backend', 'in_progress'),
]));
assert.ok(both.includes('data-task="x-2"') && !both.includes('Stuck on'), 'running before stuck');

// Dashes for missing values, dash count on an agent with no timing
const d = cells('database').map(text);
assert.deepEqual([d[4], d[5], d[6], d[7]], ['–', '–', '–', '–']);
assert.equal(text(cells('qa-tester')[4]), '–');

// Share bar relative to the busiest agent, in the agent colour
assert.ok(rowOf('backend').includes('width:100%'));
assert.ok(rowOf('frontend').includes('width:75%'));
assert.ok(rowOf('database').includes('width:25%'));
assert.ok(rowOf('backend').includes('background:var(--'), 'agent colour');

// Definitions panel, plain words only
assert.ok(html.includes('What these columns mean'));
for (const k of ['Tasks done', 'Avg. time', 'Est. cost', 'Right now']) {
  assert.ok(html.includes('<b>' + k + '</b>'), 'definition for ' + k);
}
for (const bad of ['thinking budget', 'token burn', 'phase', 'cockpit', 'teleprompter', 'pod']) {
  assert.ok(!html.toLowerCase().includes(bad), 'no old word: ' + bad);
}
assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html), 'no emojis');

// Empty state
const empty = renderPage('team', { milestones: [], status: {}, telemetry: {}, runs: [], escalations: [], logTail: {} });
assert.ok(empty.includes('No tasks yet') && !empty.includes('<table'));

console.log('✔ Team page render checks passed');
