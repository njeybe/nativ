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
    task('q-3', 'qa-agent', 'pending'),
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

// Table structure and columns
const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
assert.deepEqual(heads, ['Agent', 'Current task', 'Tasks done', 'Time', 'Cost', 'Success rate', 'Last active']);
assert.ok(html.includes('<table') && !html.includes('class="panel"'), 'table, no cards');
assert.equal(cells('backend').length, 7);

// Aliases merge into one row; the id is kept raw in data-agent
assert.equal(order.length, 4);
// Agent name as text, tasks done as a plain number
assert.equal(text(cells('backend')[0]), 'Backend');
assert.equal(text(cells('qa-tester')[0]), 'QA tester');
assert.equal(text(cells('database')[0]), 'Database');
assert.equal(text(cells('backend')[2]), '3');
assert.equal(text(cells('frontend')[2]), '1');
assert.equal(text(cells('database')[2]), '0');

// Success rate: completed over finished (completed + blocked), hyphen without data
assert.equal(text(cells('backend')[5]), '100%');
assert.equal(text(cells('qa-tester')[5]), '0%');
assert.equal(text(cells('database')[5]), '-');
assert.ok(rowOf('backend').includes('class="mono r hide-sm"'), 'mono rate');

// Last active
assert.ok(cells('backend')[6].includes('title="'), 'exact time on hover');
assert.equal(text(cells('backend')[6]), '30m ago');
assert.equal(text(cells('database')[6]), '-');

// Current task: running shows id and title, others a state word
const f = cells('frontend');
assert.ok(f[1].includes('data-tid="f-2"') && text(f[1]) === 'f-2Title of f-2', 'running task');
assert.ok(f[1].includes('title="Title of f-2"'), 'truncated title has hover text');
assert.equal(text(cells('backend')[1]), 'Up next');
assert.equal(text(cells('qa-tester')[1]), 'Stuck q-1Title of q-1');
assert.ok(cells('qa-tester')[1].includes('data-tid="q-1"'), 'stuck task button');
assert.ok(cells('backend')[1].includes('class="idle"'), 'state word is muted');
assert.ok(!html.includes('Idle'), 'no Idle word');

// Inspector link
assert.ok(f[1].includes('data-act="team-open"'), 'opens the inspector');
import { teamScript } from '../src/server/studio-ui/pages/team/script.ts';
assert.ok(teamScript.includes('Studio.openTask('), 'opens the task drawer');

// No status dots, colours come from tokens
assert.ok(!html.includes('run-dot'));
import { teamCss } from '../src/server/studio-ui/pages/team/styles.ts';
assert.ok(!/background:\s*#|style="[^"]*background/.test(rowOf('frontend')), 'no inline colours');
assert.ok(!html.includes('--ag-') && !html.includes('agent-chip'), 'no per-agent colours');

// Time and cost
assert.equal(text(cells('backend')[3]), '4m 00s');
assert.equal(text(cells('backend')[4]), '$0.75');
assert.equal(text(cells('database')[3]) + text(cells('database')[4]), '--');
assert.ok(html.includes('title="Completed / (completed + blocked)"'), 'rate header tip');
assert.ok(html.includes('<details') && html.includes('What these columns mean'), 'definitions');
for (const k of ['Tasks done', 'Time', 'Cost', 'Current task']) assert.ok(html.includes('<b>' + k + '</b>'));

// Narrow screens hide the last two columns
assert.ok(teamCss.includes('max-width: 1023px') && html.includes('hide-sm'));

// Old card/definition content is gone; plain words only
assert.ok(!html.includes('Share of work'));
for (const bad of ['thinking budget', 'token burn', 'phase', 'cockpit', 'teleprompter', 'pod']) {
  assert.ok(!html.toLowerCase().includes(bad), 'no old word: ' + bad);
}
assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html), 'no emojis');
assert.ok(!/[\u2013\u2014]/.test(html), 'no en or em dashes');

// Empty state
const empty = renderPage('team', { milestones: [], status: {}, telemetry: {}, runs: [], escalations: [], logTail: {} });
assert.ok(empty.includes('No agents have worked on this project yet.') && !empty.includes('<table'));

console.log('✔ Team page render checks passed');
