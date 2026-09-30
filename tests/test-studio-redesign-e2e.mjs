import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startStudioServer } from '../src/server/studio-server.ts';
import { renderStudioHtml } from '../src/server/studio-ui.ts';
import { paletteScript } from '../src/server/studio-ui/shell/palette.ts';
import { routerScript } from '../src/server/studio-ui/shell/router.ts';
import { wrapPage } from '../src/server/studio-ui/shell/pure.ts';
import { pages } from '../src/server/studio-ui/pages/index.ts';
import { NOW, createStudio, loadModel, renderPage, run } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-redesign-e2e.mjs`.
// Serves a fixture project through the real Studio server, then renders the new pages from
// the real API responses (no DOM: pages run in node:vm through the harness).
console.log('--- Studio redesign end-to-end regression ---');

const MIN = 60_000;
const iso = (minsAgo) => new Date(NOW - minsAgo * MIN).toISOString();
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); checks++; };
const match = (s, re, msg) => { assert.match(s, re, msg); checks++; };
const no = (s, re, msg) => { assert.doesNotMatch(s, re, msg); checks++; };
const same = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

function task(id, status, agent, deps = [], extra = {}) {
  return {
    id, title: `Title of ${id}`, status, assignedSubagent: agent, dependencies: deps,
    targetFiles: [`src/${id}.ts`], verificationCommand: 'true', notes: extra.notes || '',
    complexity: 'standard', acceptanceCriteria: [],
  };
}
const ids = (prefix, n, status, agent) =>
  Array.from({ length: n }, (_, i) => task(`${prefix}-${i + 1}`, status, agent));

const STUCK_REASON = 'Verification failed after 3 attempts: heading not found.';
const m1 = { id: 'm1', name: 'Foundation: project setup', status: 'completed',
  tasks: ids('f', 9, 'completed', 'backend') };
const m2Tasks = [
  task('d-1', 'completed', 'backend'),
  task('d-2', 'completed', 'backend', ['d-1']),
  task('d-3', 'completed', 'frontend', ['d-2']),
  task('d-4', 'completed', 'frontend', ['d-3']),
  task('d-5', 'completed', 'backend', ['d-4']),
  task('d-6', 'completed', 'backend'),
  task('d-7', 'completed', 'frontend'),
  task('e-2', 'in_progress', 'frontend', ['d-2']),
  task('e-3', 'blocked', 'database', ['d-2'], { notes: STUCK_REASON }),
  task('e-4', 'pending', 'backend', ['d-3', 'f-1']),
  task('e-5', 'pending', 'backend', ['e-2']),
  task('e-6', 'pending', 'backend', ['e-4', 'd-3']),
];
const m2 = { id: 'm2', name: 'Build: the engine', status: 'in_progress', tasks: m2Tasks };
const m3 = { id: 'm3', name: 'Later: polish', status: 'pending',
  tasks: [task('l-1', 'pending', 'frontend', ['e-4'])] };

const usage = (cost) => ({
  model: 'claude-sonnet-4-5', turns: 2, inputTokens: 1000, outputTokens: 500,
  cacheCreationTokens: 0, cacheReadTokens: 4000, thinkingTokens: 0, costUsd: cost,
});
function record(id, agent, startAgo, durMin, extra = {}) {
  return {
    taskId: id, title: `Title of ${id}`, assignedSubagent: agent, status: 'completed',
    startedAt: iso(startAgo), completedAt: iso(startAgo - durMin), durationMs: durMin * MIN, ...extra,
  };
}
const records = [
  record('f-1', 'backend', 900, 4),
  record('f-2', 'backend', 880, 4, { actualUsage: usage(0.5) }),
  record('f-3', 'backend', 860, 4),
  record('d-1', 'backend', 300, 5, { actualUsage: usage(0.42), verification: { command: 'true', durationMs: 38_000, exitCode: 0, skipped: false } }),
  record('d-2', 'backend', 290, 5),
  // A 85 minute idle stretch follows d-2, so the timeline squeezes it.
  record('d-3', 'frontend', 200, 5, { actualUsage: usage(0.3) }),
  record('d-4', 'frontend', 195, 5),
  record('d-5', 'backend', 190, 5),
  { taskId: 'e-2', title: 'Title of e-2', assignedSubagent: 'frontend', status: 'in_progress',
    startedAt: iso(2), durationMs: 0 },
];
const escalation = {
  id: 'esc-1', taskId: 'e-3', status: 'pending_review', timestamp: iso(30),
  reason: 'The check keeps failing', proposedPatch: { op: 'ADD', path: 'x.columns.y' },
};

const tempDirs = [];
let studio;
const fetchJson = async (p) => {
  const res = await fetch(`${studio.url}${p}`);
  eq(res.status, 200, `${p} answers 200`);
  return res.json();
};
const toApi = (tasks, statusBody, telemetry, runs, esc) => ({
  milestones: tasks.milestones, status: statusBody.pipeline,
  telemetry: { summary: telemetry.summary || {}, taskBreakdowns: telemetry.taskBreakdowns },
  runs: runs.runs, escalations: esc.escalations, logTail: {},
});
const between = (html, from, to) => {
  const a = html.indexOf(from);
  ok(a >= 0, `found ${from}`);
  const b = html.indexOf(to, a + from.length);
  return html.slice(a, b < 0 ? undefined : b);
};
const idsIn = (html, col) => {
  const start = html.indexOf(`data-col="${col}"`);
  const end = html.indexOf('data-col=', start + 10);
  const part = html.slice(start, end === -1 ? html.indexOf('Other milestones') : end);
  return [...part.matchAll(/data-task="([^"]+)"/g)].map((m) => m[1]);
};
const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

try {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-studio-e2e-')));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'));
  const writeAi = (name, data) => fs.writeFileSync(
    path.join(dir, '.ai', name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  writeAi('context.md', '# Context\n');
  writeAi('master_plan.json', {
    version: '1.0.0', projectName: 'e2e-fixture', lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress', activeMilestoneId: 'm2', milestones: [m1, m2, m3],
  });
  writeAi('telemetry.json', {
    version: '1.0.0', projectName: 'e2e-fixture', lastUpdated: new Date().toISOString(),
    modelTierDefault: 'claude-sonnet-4-5', tasks: records,
    summary: { totalTasksCompleted: 8, totalDurationMs: 0, estimatedTotalTokens: 0,
      estimatedTotalCostUsd: 0, verificationPassRate: 1, totalVerificationsRun: 1,
      totalVerificationsPassed: 1, circuitBreakerTrips: 0 },
  });
  writeAi('escalation.json', { escalations: [escalation] });

  studio = await startStudioServer({
    port: 0, cwd: dir, connections: { dev: null, prod: null },
    html: () => renderStudioHtml({ version: '9.9.9' }),
  });

  const res = await fetch(`${studio.url}/`);
  const served = await res.text();
  eq(res.status, 200, 'GET / answers 200');
  const [tasksBody, telemetry, escBody, statusBody, runsBody] = await Promise.all([
    fetchJson('/api/pipeline/tasks'),
    fetchJson('/api/pipeline/telemetry/detailed'),
    fetchJson('/api/pipeline/escalations?status=pending_review'),
    fetchJson('/api/pipeline/status'),
    fetchJson('/api/pipeline/tasks/runs'),
  ]);
  eq(escBody.escalations.length, 1, 'one pending escalation is served');
  ok(escBody.escalations[0].proposedPatch, 'the escalation carries its proposed patch');
  const api = toApi(tasksBody, statusBody, telemetry, runsBody, escBody);
  console.log('✔ Fixture served through the real server, all five endpoints answer');

  // 1. Served page: sidebar entries, removed pages, no simulation, scripts parse, no emojis, same origin.
  {
    const order = JSON.parse(/Studio\.order = (\[.*?\]);/.exec(served)[1]);
    same(order.map((p) => p.id), ['home', 'tasks', 'flow', 'team', 'worktrees', 'benchmarks', 'database'],
      'seven sidebar entries');
    same([...new Set(order.map((p) => p.group))].length, 3, 'three groups');
    const ctx = createStudio();
    loadModel(ctx, api);
    const side = run(ctx, 'Studio.sidebarHtml({ model: Studio.model, view: "home", worktreeCount: 0, benchmarkText: "" })');
    same([...side.matchAll(/nav-glabel">([^<]+)</g)].map((m) => m[1]), ['Now', 'Project', 'System']);
    eq((side.match(/data-go="/g) || []).length, 7, 'seven sidebar buttons');
    for (const gone of ['nav-pods', 'panel-pods', 'panel-canvas', 'nav-canvas', 'Play Simulation', '/api/pipeline/simulation/']) {
      ok(!served.includes(gone), `served page has no ${gone}`);
    }
    for (const id of ['home', 'tasks', 'flow', 'team']) ok(served.includes(`id="panel-${id}"`), `panel-${id} present`);
    const scripts = [...served.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    ok(scripts.length > 0, 'inline scripts found');
    for (const code of scripts) assert.doesNotThrow(() => new vm.Script(code), 'inline script parses');
    checks++;
    no(served, emoji, 'served page has no emojis');
    no(served, /<link[^>]+href|<script[^>]+src=|@import|@font-face/i, 'no linked or imported assets');
    no(served, /(?:src|href|action)="https?:\/\//i, 'no attribute loads another origin');
    no(served, /url\(\s*['"]?(?:https?:)?\/\//i, 'no css url() from another origin');
    no(scripts.join('\n'), /fetch\(\s*['"]https?:/, 'client fetches only same-origin paths');
    console.log('✔ Served page: 7 entries in 3 groups, removed pages gone, scripts parse, same origin');
  }

  // 2. Tasks: active milestone, 5-card cap on Just finished, column contents.
  {
    const html = renderPage('tasks', api);
    match(html, /<option value="m2" selected>/, 'defaults to the active milestone');
    const board = html.slice(html.indexOf('class="board"'), html.indexOf('Other milestones'));
    ok(!/data-task="(f-\d|l-1)"/.test(board), 'board shows only the selected milestone');
    same(idsIn(html, 'pending'), ['e-4', 'e-5', 'e-6']);
    same(idsIn(html, 'in_progress'), ['e-2']);
    same(idsIn(html, 'blocked'), ['e-3']);
    const done = idsIn(html, 'completed');
    eq(done.length, 5, 'Just finished capped at 5 cards');
    match(html, /Show all 7/, 'Show all 7');
    match(html, /Ready to start/);
    match(html, /Waiting on e-2/, 'waiting names its unfinished dependency');
    match(html, /Waiting on e-4/);
    no(html, /Waiting on [^<]*f-1/, 'finished cross-milestone dependency is not waited on');
    match(html, /Running <span data-since="\d+">/, 'running timer');
    match(html, /Paused after/, 'stuck card');
    const page = withActions('tasks', api);
    match(page.render(), /Show all 7/);
    page.act('tasks-more');
    const expanded = page.render();
    eq(idsIn(expanded, 'completed').length, 7, 'Show all reveals all 7 finished tasks');
    match(expanded, /Show fewer/);
    console.log('✔ Tasks: active milestone only, Just finished capped at 5 until Show all');
  }

  // 3. Flow: one milestone, no cross-milestone link, implied links hidden, timeline gap and untimed.
  {
    const html = renderPage('flow', api, { state: { milestoneId: 'm2' } });
    const drawn = [...html.matchAll(/<button[^>]*data-id="([^"]+)"/g)].map((m) => m[1]).sort();
    same(drawn, m2Tasks.map((t) => t.id).sort(), 'only m2 tasks are drawn');
    ok(!/f-1|l-1/.test(html), 'no task or link from another milestone');
    no(html, /data-from="f-1"|data-to="l-1"|data-from="e-4" data-to="l-1"/, 'no cross-milestone link');
    no(html, /simulat|scenario|Play/i, 'no simulation controls');
    eq((html.match(/<path class="wire/g) || []).length, 9, 'nine links inside m2 with the implied one hidden');
    no(html, /data-from="d-3" data-to="e-6"/, 'implied link hidden by default');
    match(html, /Show 1 implied link</, 'implied link counter');
    const other = renderPage('flow', api, { state: { milestoneId: 'm3' } });
    match(other, /data-id="l-1"/);
    ok(!other.includes('e-4'), 'm3 draws no link to its dependency in m2');
    const fl = withActions('flow', api, { milestoneId: 'm2' });
    fl.act('flow-mode', { getAttribute: () => 'timeline' });
    const t = fl.render();
    const gaps = [...t.matchAll(/data-gap="(\d+)"/g)].map((m) => Number(m[1]));
    ok(gaps.length >= 1 && gaps.includes(85 * MIN), 'the 85 minute idle gap is squeezed');
    match(t, /class="gap-line"/);
    match(t, /Not on the timeline:/, 'untimed tasks are listed');
    const tail = t.slice(t.indexOf('Not on the timeline:'));
    match(tail, /data-task="d-6"/);
    match(tail, /data-task="d-7"/);
    match(t, /class="bar-c"/, 'check strip for the checked task');
    match(t, /class="now-line"/, 'running task reaches the now line');
    console.log('✔ Flow: selected milestone only, implied links hidden, gap squeezed, untimed listed');
  }

  // 4. Home: stuck task and proposal in Needs you, calm state without them.
  {
    const html = renderPage('home', api);
    const sec = between(html, '<h2>Needs you</h2>', '<section');
    match(sec, /class="need"/);
    match(sec, /data-task="e-3"/, 'stuck task is listed');
    match(sec, /Verification failed after 3 attempts: heading not found\./, 'reason from notes');
    match(sec, /data-act="home-proposal" data-id="e-3"/, 'proposal action');
    eq((sec.match(/class="need"/g) || []).length, 1, 'one item for the task and its proposal');
    const now = between(html, '<h2>Right now</h2>', '<section');
    match(now, /data-task="e-2"/, 'running task shown');
    match(now, /1 working/);
    const calm = JSON.parse(JSON.stringify(api));
    calm.milestones[1].tasks.find((t) => t.id === 'e-3').status = 'completed';
    calm.milestones[1].tasks.find((t) => t.id === 'e-2').status = 'completed';
    calm.escalations = [];
    const calmHtml = renderPage('home', calm);
    match(calmHtml, /Nothing needs you\. No stuck tasks, questions or proposals\./, 'calm state');
    match(calmHtml, /All clear/);
    match(calmHtml, /No agent is working/);
    match(html, /Plan files/);
    console.log('✔ Home: stuck task and proposal in Needs you, calm state when none');
  }

  // 5. Team: rows per agent, dashes where nothing was recorded.
  {
    const html = renderPage('team', api);
    const order = [...html.matchAll(/<tr data-agent="([^"]+)"/g)].map((m) => m[1]);
    same(order.slice().sort(), ['backend', 'database', 'frontend']);
    const cells = (agent) => {
      const s = html.indexOf(`<tr data-agent="${agent}"`);
      const row = html.slice(s, html.indexOf('</tr>', s));
      return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map((m) => m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    };
    const db = cells('database');
    same([db[4], db[5], db[6]], ['–', '–', '–'], 'database has no timing or cost: dashes');
    ok(cells('backend')[6].startsWith('$'), 'backend shows its recorded cost');
    ok(cells('frontend')[6].startsWith('$'), 'frontend shows its recorded cost');
    ok(html.includes('Stuck on') && html.includes('data-task="e-3"'), 'stuck agent chip');
    ok(html.includes('data-task="e-2"'), 'running agent chip');
    console.log('✔ Team: rows per agent, dashes for missing values');
  }

  // 6. All new pages render without emojis or old wording.
  for (const id of ['home', 'tasks', 'flow', 'team']) {
    const html = renderPage(id, api);
    no(html, emoji, `${id} has no emojis`);
    no(html, /Play Simulation|nav-pods|panel-canvas|Cockpit/, `${id} has no removed features`);
  }
  console.log('✔ Every new page renders from the real API with no emojis or removed features');

  // 7. Command palette keys, driven through the real handler in a stubbed page.
  {
    const ctx = createStudio();
    loadModel(ctx, api);
    const els = {};
    const mk = () => ({ hidden: true, innerHTML: '', value: '', textContent: '', listeners: {},
      addEventListener(t, f) { this.listeners[t] = f; }, setAttribute() {}, focus() {} });
    const docListeners = {};
    const opened = [];
    const went = [];
    Object.assign(ctx, {
      $: (id) => (els[id] ||= mk()),
      document: { activeElement: null, body: { contains: () => false }, querySelector: () => null,
        addEventListener: (t, f) => { docListeners[t] = f; } },
      openDetail: (id) => opened.push(id),
      closeDetail: () => {},
      repaintFor: () => {},
    });
    run(ctx, 'Studio.go = function (v) { __went.push(v); };');
    ctx.__went = went;
    run(ctx, `(function () { ${paletteScript}\n __pal = function () { return pal; }; })()`);
    const key = (k, extra = {}) => docListeners.keydown({ key: k, preventDefault() {}, ...extra });
    const sel = () => {
      const tag = [...els['pal-list'].innerHTML.matchAll(/<li[^>]*>/g)]
        .map((m) => m[0]).find((t) => t.includes('aria-selected="true"'));
      return Number(/data-i="(\d+)"/.exec(tag)[1]);
    };
    const items = run(ctx, 'Studio.paletteItems("")').map((i) => (i.page ? i.page.id : i.task.id));
    const n = items.length;
    ok(n >= 3, 'the empty search lists several results');

    key('k', { ctrlKey: true });
    eq(els.pal.hidden, false, 'Ctrl+K opens the palette');
    eq(sel(), 0, 'first result highlighted');
    key('ArrowDown');
    eq(sel(), 1, 'ArrowDown moves the highlight down');
    key('ArrowUp');
    eq(sel(), 0, 'ArrowUp moves it back up');
    key('ArrowUp');
    eq(sel(), n - 1, 'ArrowUp on the first result wraps to the last');
    key('ArrowDown');
    eq(sel(), 0, 'ArrowDown on the last result wraps to the first');
    for (let i = 0; i < n - 1; i++) key('ArrowDown');
    eq(sel(), n - 1, 'ArrowDown reaches the last result');
    eq(run(ctx, '__pal().sel'), n - 1, 'state matches the highlight');
    key('Escape');
    eq(els.pal.hidden, true, 'Esc closes the palette');
    same(opened, [], 'Esc opens nothing');

    key('k', { ctrlKey: true });
    eq(sel(), 0, 'reopening starts at the first result');
    key('ArrowDown');
    key('Enter');
    eq(els.pal.hidden, true, 'Enter closes the palette');
    same(opened.length + went.length, 1, 'Enter opens exactly one result');
    ok(opened.includes(items[1]) || went.includes(items[1]), 'Enter opens the highlighted result');

    key('/');
    eq(els.pal.hidden, false, 'slash opens the palette');
    key('k', { ctrlKey: true });
    eq(els.pal.hidden, true, 'Ctrl+K again closes it');

    key('k', { metaKey: true });
    els['pal-q'].value = 'zzzz-nothing';
    els.pal.listeners.input();
    match(els['pal-list'].innerHTML, /No task matches/, 'empty search shows the empty state');
    key('ArrowDown');
    key('ArrowUp');
    eq(run(ctx, '__pal().sel'), 0, 'arrows stay at 0 when there is nothing to pick');
    const before = opened.length + went.length;
    key('Enter');
    eq(opened.length + went.length, before, 'Enter with no result opens nothing');
    console.log('✔ Palette: Ctrl+K, ArrowDown/ArrowUp with wrapping, Enter opens, Esc closes, empty bounds');
  }

  // 8. Old links redirect, through the real hashchange handler.
  {
    const ctx = createStudio();
    loadModel(ctx, api);
    const els = {};
    const mk = () => ({ hidden: false, textContent: '', addEventListener() {}, setAttribute() {} });
    const listeners = {};
    const location = { hash: '' };
    const history = { replaceState: (a, b, u) => { location.hash = u; } };
    const noop = () => {};
    Object.assign(ctx, {
      $: (id) => (els[id] ||= mk()), location, history, setInterval: noop, fmt: {},
      window: { addEventListener: (t, f) => { listeners[t] = f; }, scrollTo: noop, history },
      paintChrome: noop, paintPage: noop, closeDetail: noop, openDetail: noop, repaintFor: noop,
      pageCtx: noop, fetchPipeline: noop, connectEvents: noop, api: noop, postJson: noop, toast: noop,
      PIPE_PATHS: {}, ALL_PARTS: [],
    });
    const order = JSON.parse(/Studio\.order = (\[.*?\]);/.exec(served)[1]);
    run(ctx, `Studio.order = ${JSON.stringify(order)};`);
    run(ctx, `${order.map((p) => `Studio.pages['${p.id}'] = {};`).join('')}`);
    run(ctx, `(function () { ${routerScript}\n })()`);
    ok(typeof listeners.hashchange === 'function', 'router listens for hashchange');
    ctx.Studio.state.view = 'tasks';
    const cases = [['#canvas', 'flow'], ['#pods', 'team'], ['#overview', 'home']];
    for (const [hash, view] of cases) {
      location.hash = hash;
      listeners.hashchange();
      eq(ctx.Studio.state.view, view, `${hash} lands on ${view}`);
      eq(location.hash, `#${view}`, `${hash} rewrites the address to #${view}`);
      eq(els['crumb-view'].textContent, order.find((p) => p.id === view).label, `${hash} updates the crumb`);
      ctx.Studio.state.view = 'tasks';
    }
    console.log('✔ Old links: #canvas to #flow, #pods to #team, #overview to #home');
  }

  console.log(`\n✔ ${checks} Studio redesign end-to-end assertions passed`);
  console.log('ALL STUDIO REDESIGN E2E TESTS PASSED');
} finally {
  if (studio) await studio.close();
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  }
  setTimeout(() => {
    console.error('✖ Process still alive 10s after studio.close().');
    process.exit(1);
  }, 10_000).unref();
}

// Loads one page script so its actions can be driven and it can be rendered again.
function withActions(pageId, data, state = {}) {
  const ctx = createStudio();
  loadModel(ctx, data);
  Object.assign(ctx.Studio.state, state);
  ctx.Studio.repaint = () => {};
  ctx.Studio.openTask = () => {};
  ctx.Studio.closeDetail = () => { ctx.Studio.state.focusTaskId = null; };
  run(ctx, wrapPage(pages.find((p) => p.id === pageId).script));
  ctx.__w = 1200;
  const render = () => run(ctx, `Studio.pages['${pageId}'].render({ model: Studio.model, state: Studio.state, fmt: Studio.fmt, ui: Studio.ui, width: __w })`);
  const act = (name, el = {}) => { ctx.__el = el; run(ctx, `Studio.pages['${pageId}'].actions['${name}'](__el)`); };
  return { ctx, render, act };
}
