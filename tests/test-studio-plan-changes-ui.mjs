import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pureScript, wrapPage } from '../dist/server/studio-ui/shell/pure.js';
import { homePage } from '../dist/server/studio-ui/pages/home/index.js';
import { pipelineStateScript } from '../dist/server/studio-ui/shell/pipeline-state.js';
import { modelScript } from '../dist/server/studio-ui/shell/model.js';
import { triageScript } from '../dist/server/studio-ui/shell/triage.js';
import { syncScript } from '../dist/server/studio-ui/shell/sync.js';

// Run with `npm run build && node tests/test-studio-plan-changes-ui.mjs`: Home plan rows in a vm, no DOM.
function createStudio() {
  const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, isNaN, isFinite, parseInt });
  vm.runInContext(pureScript, ctx);
  const order = [{ id: 'home', group: 'now', label: 'Home', icon: '' }];
  vm.runInContext('Studio.order = ' + JSON.stringify(order) + ';', ctx);
  return ctx;
}
function loadModel(ctx, data) {
  ctx.__api = data;
  vm.runInContext('Studio.setModel(Studio.buildModel(__api));', ctx);
}
console.log('--- Studio plan change rows ---');
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok - ' + name); };

const task = (id, status) => ({ id, title: 'T ' + id, status, assignedSubagent: 'backend', dependencies: [] });
const change = (id, body, extra = {}) => ({
  id, status: 'proposed', taskId: 'task-52', change: body, reason: 'Because', proposedBy: 'architect',
  seen: 'h-' + id, check: { ok: true, reason: null }, effects: { rewired: [] }, ...extra,
});
const CHANGES = [
  change('pc-01', { drop: { reason: 'x', replacedBy: 'task-139' } }, {
    taskId: 'task-138', effects: { rewired: [{ taskId: 'task-150', from: 'task-138', to: 'task-139' }] },
  }),
  change('pc-02', { release: true }, { taskId: 'task-41' }),
  change('pc-03', { addDependencies: ['task-50'], removeDependencies: ['task-47'] }),
  change('pc-04', { notes: 'hello' }, { reason: 'r'.repeat(200), check: { ok: false, reason: 'task is archived' } }),
];
const api = (changes = CHANGES, escalations = []) => ({
  milestones: [{ id: 'm1', name: 'M', tasks: [task('task-1', 'blocked'), task('task-9', 'dropped')] }],
  telemetry: { taskBreakdowns: [] },
  runs: [],
  status: { styleDecisions: [{ rule: 'r', title: 't', count: 1, command: 'c' }] },
  escalations,
  planChanges: changes,
  logTail: {},
});

function home({ human = false, post, changes = CHANGES } = {}) {
  const ctx = createStudio();
  ctx.pipe = { planChanges: changes, planUi: {}, session: { human } };
  ctx.toasts = []; ctx.fetched = []; ctx.copied = [];
  ctx.toast = (m, k) => ctx.toasts.push(k ? [m, k] : [m]);
  ctx.copyText = (t) => ctx.copied.push(t);
  ctx.fetchPipeline = (p) => { ctx.fetched.push(p); return Promise.resolve(); };
  ctx.postJson = post || (() => Promise.resolve({ ok: true }));
  loadModel(ctx, api(changes));
  vm.runInContext(wrapPage(homePage.script), ctx);
  ctx.Studio.repaint = () => {};
  const def = ctx.Studio.pages.home;
  const el = (id) => ({ getAttribute: (k) => (k === 'data-id' ? id : 'cmd ' + id) });
  return {
    ctx, el, act: (n, id) => def.actions[n](el(id)),
    html: () => def.render({
      model: ctx.Studio.model, state: ctx.Studio.state, fmt: ctx.Studio.fmt, ui: ctx.Studio.ui,
    }),
  };
}

await test('rows and wording for each change kind', () => {
  const h = home().html();
  assert.match(h, /Plan change<\/b><span class="mono">pc-01/);
  assert.match(h, /Drop task-138, replaced by task-139/);
  assert.match(h, /Release task-41/);
  assert.match(h, /task-52: add task-50, remove task-47/);
  assert.match(h, /task-52: new notes/);
  assert.match(h, /Proposed by architect/);
  assert.match(h, /task-150 will wait on task-139 instead of task-138/);
  assert.ok(h.indexOf('data-need="plan:pc-01"') < h.indexOf('data-need="style:r"'), 'plan before style');
  assert.ok(h.indexOf('data-need="task-1"') < h.indexOf('data-need="plan:pc-01"'), 'task before plan');
  assert.match(h, /Show more/);
  assert.match(h, /color:var\(--danger\)">task is archived/);
});

await test('counts feed items, pulse and Home badge', () => {
  const h = home();
  assert.equal(h.ctx.Studio.model.needsYou.length, 1 + 4 + 1);
  assert.match(h.html(), /6 items/);
  const side = vm.runInContext('Studio.sidebarHtml({ model: Studio.model, view: "home", worktreeCount: null })', h.ctx);
  assert.match(side, />6</);
});

await test('without a key: command and Copy, no buttons', () => {
  const h = home({ human: false });
  const html = h.html();
  assert.match(html, /nativ plan approve pc-03/);
  assert.match(html, /Open Studio from your terminal to decide here\./);
  assert.doesNotMatch(html, /home-plan-ask-approve/);
  h.act('home-copy-style', 'pc-03');
  assert.equal(h.ctx.copied.length, 1);
});

await test('with a key: Approve, Reject, inline confirm, failed check disables Approve', () => {
  const h = home({ human: true });
  let html = h.html();
  assert.match(html, /data-act="home-plan-ask-approve" data-id="pc-01">Approve/);
  assert.match(html, /data-act="home-plan-ask-approve" data-id="pc-04" disabled/);
  assert.doesNotMatch(html, /nativ plan approve/);
  h.act('home-plan-ask-approve', 'pc-03');
  html = h.html();
  assert.match(html, /Approve pc-03\?/);
  assert.match(html, /home-plan-confirm" data-id="pc-03">Confirm/);
  h.act('home-plan-cancel', 'pc-03');
  assert.doesNotMatch(h.html(), /Approve pc-03\?/);
  h.act('home-plan-ask-reject', 'pc-03');
  assert.match(h.html(), /Reject pc-03\?/);
});

await test('pending then success removes the row and toasts', async () => {
  let release;
  const h = home({
    human: true,
    post: (p, b) => { h.sent = [p, b]; return new Promise((r) => { release = r; }); },
  });
  h.act('home-plan-ask-approve', 'pc-03');
  h.act('home-plan-confirm', 'pc-03');
  const html = h.html();
  assert.match(html, /Approving\.\.\./);
  assert.match(html, /data-id="pc-03" disabled/);
  assert.ok(html.includes('data-need="plan:pc-03"'), 'no optimistic removal');
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [
    '/api/pipeline/plan-changes/decide', { id: 'pc-03', decision: 'approve', seen: 'h-pc-03' },
  ]);
  release({ ok: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.toasts[0])), ['pc-03 approved', 'ok']);
  assert.equal(h.ctx.fetched[0][0], 'planChanges');
  assert.equal(h.ctx.pipe.planChanges.some((c) => c.id === 'pc-03'), false);
});

await test('failure keeps the row, re-enables it and toasts the reason', async () => {
  const h = home({ human: true, post: () => Promise.reject(new Error('That change was edited')) });
  h.act('home-plan-ask-reject', 'pc-02');
  h.act('home-plan-confirm', 'pc-02');
  assert.match(h.html(), /Rejecting\.\.\./);
  await new Promise((r) => setTimeout(r, 5));
  const html = h.html();
  assert.ok(html.includes('plan:pc-02'));
  assert.doesNotMatch(html, /Rejecting\.\.\./);
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.toasts[0])), ['That change was edited']);
});

await test('needsYou skips escalations of dropped tasks', () => {
  const ctx = createStudio();
  loadModel(ctx, api([], [{ id: 'e1', taskId: 'task-9', status: 'pending_review' }]));
  assert.ok(!ctx.Studio.model.needsYou.some((i) => i.taskId === 'task-9'));
});

await test('escalation buttons follow the key', () => {
  const ctx = vm.createContext({
    esc: (s) => String(s), pipe: { session: { human: false } }, copyText() {}, $: () => ({ addEventListener() {} }),
  });
  vm.runInContext('function healBody(){ return "BASE"; }' + triageScript, ctx);
  const e = { id: 'esc-1' };
  assert.match(ctx.decisionActions(e), /nativ triage esc-1/);
  assert.doesNotMatch(ctx.decisionActions(e), /data-heal="t1-decide"/);
  assert.match(ctx.healBody(e), /Open Studio from your terminal/);
  ctx.pipe.session.human = true;
  assert.match(ctx.decisionActions(e), /data-heal="t1-decide"/);
  assert.equal(ctx.healBody(e), 'BASE');
});

await test('slices, plan_change refetch, no backtick or dollar-brace', async () => {
  const ctx = vm.createContext({
    window: {}, document: {}, $: () => ({}), Studio: { setModel() {} }, buildModel: () => ({}),
    refreshUi() {}, syncHealTab() {}, renderTriageChip() {}, Promise,
  });
  vm.runInContext(pipelineStateScript, ctx);
  const seen = [];
  ctx.api = (p) => {
    seen.push(p);
    return Promise.resolve(p.includes('session') ? { human: true } : { changes: [{ id: 'pc-1' }] });
  };
  await ctx.fetchPipeline(['planChanges', 'session']);
  assert.ok(seen.includes('/api/pipeline/plan-changes?status=proposed'));
  const sync = vm.createContext({
    window: {}, document: {}, Promise, setTimeout, console,
    setInterval() { return 0; }, clearInterval() {},
  });
  vm.runInContext(syncScript, sync);
  assert.ok(sync.EVENT_PARTS.plan_change.includes('planChanges'), 'plan_change refetches planChanges');
  assert.equal(ctx.pipe.session.human, true);
  assert.equal(ctx.pipe.planChanges[0].id, 'pc-1');
  const src = pipelineStateScript + modelScript + triageScript + homePage.script;
  assert.ok(!src.includes('`') && !src.includes('${'));
});

console.log('All ' + passed + ' plan change UI checks passed.');
