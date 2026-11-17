import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pureScript, wrapPage } from '../dist/server/studio-ui/shell/pure.js';
import { tasksPage } from '../dist/server/studio-ui/pages/tasks/index.js';
import { flowLayoutScript } from '../dist/server/studio-ui/pages/flow/layout.js';
import { flowPlanScript } from '../dist/server/studio-ui/pages/flow/plan-view.js';
import { detailViewScript } from '../dist/server/studio-ui/shell/detail-view.js';
import { formatScript } from '../dist/server/studio-ui/shell/format.js';

// Run with `npm run build && node tests/test-studio-dropped-ui.mjs`: dropped task views in a vm.
console.log('--- Studio dropped tasks ---');
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok - ' + name); };

const raw = (id, status, extra = {}) => ({
  id, title: 'T ' + id, status, assignedSubagent: 'backend', dependencies: [], ...extra,
});
const DROP = { reason: 'Superseded <b>x</b>', replacedBy: 'task-3', changeId: 'pc-03', at: 'now' };
const API = { milestones: [{ id: 'm1', name: 'M one', tasks: [
  raw('task-1', 'completed'), raw('task-2', 'dropped'), raw('task-3', 'pending'), raw('task-4', 'dropped'),
] }], telemetry: { taskBreakdowns: [] }, runs: [], escalations: [], logTail: {} };

function studio() {
  const ctx = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, isNaN, isFinite, parseInt });
  vm.runInContext(pureScript, ctx);
  ctx.__api = API;
  vm.runInContext('Studio.setModel(Studio.buildModel(__api));', ctx);
  // The model does not carry the drop record yet; attach it the way the API sends it.
  vm.runInContext('Studio.model.byId["task-2"].drop = ' + JSON.stringify(DROP) + ';' +
    'Studio.model.byId["task-4"].drop = { reason: "gone", changeId: "pc-04", at: "now" };', ctx);
  return ctx;
}
const ctx = studio();
const S = ctx.Studio;

test('dropped has the label and neutral muted style, never danger', () => {
  assert.equal(S.statusLabel('dropped'), 'dropped');
  assert.equal(S.status.bucket(S.model.byId['task-2']), 'done');
  const pill = S.ui.pill('dropped');
  assert.ok(pill.includes('>dropped<') && pill.includes('--fg-3'));
  assert.ok(!/danger|--bad/.test(pill + S.ui.statusIcon('dropped')));
});

const render = (extra = {}) => {
  vm.runInContext(wrapPage(tasksPage.script), ctx);
  const page = S.pages.tasks;
  S.repaint = () => {};
  return page.render({ model: S.model, state: { tasksView: 'list', ...extra }, fmt: S.fmt });
};

test('list: dropped under Done, muted, replaced by, milestone count excludes it', () => {
  const html = render();
  assert.ok(html.includes('class="trow dropped"') && html.includes('opacity:.6'));
  assert.ok(html.includes('replaced by task-3'));
  assert.ok(html.includes('>1 of 2<'), 'count is completed over non-dropped tasks');
  assert.ok(html.includes('Done <span class="num">3</span>'), 'Done filter includes dropped');
});

test('board: dropped cards sit in the Done column', () => {
  const ctx2 = studio();
  vm.runInContext(wrapPage(tasksPage.script), ctx2);
  ctx2.Studio.repaint = () => {};
  const s2 = ctx2.Studio;
  const html = s2.pages.tasks.render({ model: s2.model, state: { tasksView: 'board' }, fmt: s2.fmt });
  const done = html.split('data-col="completed"')[1].split('data-col="blocked"')[0];
  assert.ok(done.includes('data-task="task-2"') && done.includes('data-task="task-4"'));
  assert.ok(done.includes('<span class="count">3</span>'));
});

test('inspector shows reason, replacement link and change id, no actions', () => {
  const html = S.detailHtml('task-2', {});
  assert.ok(html.includes('Dropped'));
  assert.ok(html.includes('Superseded &lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'));
  assert.ok(html.includes('data-task="task-3"'));
  assert.ok(html.includes('by plan change <span class="mono">pc-03</span>'));
  assert.ok(!/data-act="task-(start|dispatch|abort|output)"/.test(html));
  assert.ok(!/>(Dispatch|Restart|Start)</.test(html));
  assert.ok(!S.detailHtml('task-4', {}).includes('Replaced by'));
});

test('flow legend lists dropped and dropped nodes are muted and dashed', () => {
  const c = studio();
  vm.runInContext(wrapPage('var ui = Studio.ui, fmt = Studio.fmt;' + flowLayoutScript + flowPlanScript +
    'Studio.__plan = flowPlan;'), c);
  const html = c.Studio.__plan(c.Studio.model.milestones[0], null, { implied: false });
  assert.ok(html.includes('<div class="legend">') && html.includes('title="dropped"'));
  assert.ok(html.includes('class="node dropped"') && html.includes('border-style:dashed'));
});

test('buildModel copies drop and leaves dropped tasks out of milestone counts', () => {
  const api = { milestones: [{ id: 'm2', name: 'M two', tasks: [
    raw('task-5', 'completed'), raw('task-6', 'dropped', { drop: DROP }), raw('task-7', 'pending'),
  ] }], telemetry: { taskBreakdowns: [] }, runs: [], escalations: [], logTail: {} };
  const c = vm.createContext({ Date, Math, JSON, Object, Array, String, Number, isNaN, isFinite, parseInt });
  vm.runInContext(pureScript, c);
  c.__api = api;
  vm.runInContext('Studio.setModel(Studio.buildModel(__api));', c);
  const M = c.Studio.model;
  assert.deepEqual(M.byId['task-6'].drop, DROP);
  assert.equal(M.byId['task-5'].drop, null);
  const html = c.Studio.detailHtml('task-6', {});
  assert.ok(html.includes('Superseded &lt;b&gt;x&lt;/b&gt;') && html.includes('data-task="task-3"'));
  assert.ok(html.includes('pc-03'));
  const m2 = M.milestones.filter(function (x) { return x.id === 'm2'; })[0];
  assert.equal(m2.total, 2);
  assert.equal(m2.done, 1);
});

test('client code has no backtick or dollar-brace and no dashes in UI text', () => {
  for (const s of [formatScript, tasksPage.script, detailViewScript, flowPlanScript]) {
    assert.ok(!s.includes('`') && !s.includes('$' + '{'));
  }
  const html = render() + S.detailHtml('task-2', {});
  assert.ok(!/[–—]/.test(html));
});

console.log(`\n${passed} passed`);
