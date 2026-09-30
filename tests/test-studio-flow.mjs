import assert from 'node:assert/strict';
import { pureScript, wrapPage } from '../src/server/studio-ui/shell/pure.ts';
import { pages } from '../src/server/studio-ui/pages/index.ts';
import { NOW, createStudio, loadModel, renderPage, run } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-flow.mjs`.
console.log('--- Starting Studio Flow page verification ---');

const MIN = 60_000;
const iso = (minsAgo) => new Date(NOW - minsAgo * MIN).toISOString();

function task(id, status, agent, deps = []) {
  return {
    id, title: `Title of ${id}`, status, assignedSubagent: agent, dependencies: deps,
    targetFiles: [], verificationCommand: 'true', notes: '', isAvailable: false,
  };
}
// start and duration in minutes ago / minutes; check in ms
function crumb(id, startAgo, durMin, checkMs) {
  return {
    taskId: id, startedAt: iso(startAgo), completedAt: iso(startAgo - durMin), durationMs: durMin * MIN,
    verification: checkMs ? { durationMs: checkMs } : undefined,
  };
}

// a -> b -> c -> e, b -> d, and a -> c is implied because b already needs a.
const m1 = { id: 'm1', name: 'Build: the flow', status: 'in_progress', tasks: [
  task('a-1', 'completed', 'backend'),
  task('b-1', 'completed', 'backend', ['a-1']),
  task('c-1', 'completed', 'frontend', ['a-1', 'b-1']),
  task('d-1', 'completed', 'frontend', ['b-1']),
  task('e-1', 'in_progress', 'qa-tester', ['c-1', 'z-1']),
  task('f-1', 'completed', 'backend'),
] };
const m2 = { id: 'm2', name: 'Other work', status: 'pending', tasks: [task('z-1', 'pending', 'backend')] };
const m3 = { id: 'm3', name: 'Old work', status: 'completed', tasks: [task('o-1', 'completed', 'backend')] };
const m4 = { id: 'm4', name: 'Empty', status: 'pending', tasks: [] };

const api = {
  milestones: [m1, m2, m3, m4],
  telemetry: { taskBreakdowns: [
    crumb('a-1', 200, 5), crumb('b-1', 194, 4), crumb('c-1', 120, 10, 60_000), crumb('d-1', 118, 10),
    { taskId: 'e-1', startedAt: iso(3) },
    { taskId: 'o-1', completedAt: iso(500), durationMs: 5 * MIN },
  ] },
  runs: [], escalations: [],
};

const count = (html, re) => (html.match(re) || []).length;
const attr = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map((m) => m[1]);
const nodeTag = (html, id) => html.match(new RegExp(`<button[^>]*data-id="${id}"[^>]*>`))[0];

const plan = (state = {}) => renderPage('flow', api, { state: { milestoneId: 'm1', ...state } });

// Only the selected milestone is drawn, and no link leaves it.
let html = plan();
assert.deepEqual(attr(html, 'data-id').sort(), ['a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1']);
assert.ok(!html.includes('z-1'), 'other milestone task not drawn, not linked');
assert.equal(count(html, /data-lane="/g), 3, 'one lane per agent');
assert.ok(!/simulat|scenario|speed/i.test(html), 'no simulation controls');
assert.match(html, /data-mode="plan"/);
assert.match(html, /aria-pressed="true"[^>]*>Plan|data-mode="plan" aria-pressed="true"/);

// Rounds count dependencies inside the milestone only.
const round = (id) => Number(nodeTag(html, id).match(/data-round="(\d+)"/)[1]);
assert.deepEqual(['a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1'].map(round), [1, 2, 3, 3, 4, 1]);
assert.match(html, /Round 4/);
assert.ok(!html.includes('Round 5'));

// Implied links hidden by default, with a counter checkbox.
assert.equal(count(html, /<path class="wire/g), 4, 'four real links');
assert.ok(!html.includes('data-from="a-1" data-to="c-1"'), 'implied link a-1 to c-1 hidden');
assert.match(html, /Show 1 implied link</);
assert.match(html, /type="checkbox"/);

// Focus set: task, what it needs, what it unblocks; rest dimmed.
html = plan({ focusTaskId: 'c-1' });
const hotIds = ['a-1', 'b-1', 'c-1', 'e-1'];
for (const id of ['a-1', 'b-1', 'c-1', 'd-1', 'e-1', 'f-1']) {
  const hot = / hot[ "]/.test(nodeTag(html, id));
  assert.equal(hot, hotIds.includes(id), `${id} hot state`);
}
assert.match(nodeTag(html, 'c-1'), / sel[ "]/);
assert.match(html, /class="canvas focus"/);
assert.equal(count(html, /class="wire hot"/g), 3, 'a-b, b-c, c-e lit');
assert.match(html, /Clear highlight/);
assert.ok(!/class="canvas focus"/.test(plan()), 'no dimming without focus');

// Actions: checkbox, focus click, mode switch, and Plan wins while a task is focused.
function withActions() {
  const ctx = createStudio();
  loadModel(ctx, api);
  ctx.Studio.state.milestoneId = 'm1';
  const calls = [];
  ctx.Studio.repaint = (id) => calls.push(['repaint', id]);
  ctx.Studio.openTask = (id) => calls.push(['open', id]);
  ctx.Studio.closeDetail = () => { calls.push(['close']); ctx.Studio.state.focusTaskId = null; };
  run(ctx, wrapPage(pages.find((p) => p.id === 'flow').script));
  ctx.__w = 1200;
  const render = () => run(ctx, "Studio.pages.flow.render({ model: Studio.model, state: Studio.state, fmt: Studio.fmt, ui: Studio.ui, width: __w })");
  const act = (name, el) => { ctx.__el = el; run(ctx, `Studio.pages.flow.actions['${name}'](__el)`); };
  return { ctx, calls, render, act };
}
const h = withActions();
h.act('flow-implied', { checked: true });
assert.equal(count(h.render(), /<path class="wire/g), 5, 'checkbox shows implied link');
assert.match(h.render(), /data-from="a-1" data-to="c-1"/);
h.act('flow-implied', { checked: false });
assert.equal(count(h.render(), /<path class="wire/g), 4);

h.act('flow-focus', { getAttribute: () => 'b-1' });
assert.equal(h.ctx.Studio.state.focusTaskId, 'b-1');
assert.deepEqual(h.calls.filter((c) => c[0] === 'open'), [['open', 'b-1']]);
h.act('flow-focus', { getAttribute: () => 'b-1' });
assert.equal(h.ctx.Studio.state.focusTaskId, null, 'second click clears');

h.act('flow-mode', { getAttribute: () => 'timeline' });
assert.match(h.render(), /data-mode="timeline"/);
h.ctx.Studio.state.focusTaskId = 'c-1';
assert.match(h.render(), /data-mode="plan"/, 'Show in Flow arrival forces Plan');
h.act('flow-mode', { getAttribute: () => 'timeline' });
assert.equal(h.ctx.Studio.state.focusTaskId, null, 'switching mode clears focus');

// What happened: bars, stacking, squeezed pauses, check strip, striped running bar.
function timelineHtml(width) {
  const s = withActions();
  s.act('flow-mode', { getAttribute: () => 'timeline' });
  s.ctx.__w = width;
  return s.render();
}
html = timelineHtml(1200);
assert.match(html, /data-mode="timeline"/);
const barTag = (id) => html.match(new RegExp(`<rect[^>]*data-task="${id}"[^>]*>`))[0];
const num = (tag, name) => Number(tag.match(new RegExp(` ${name}="([\\d.]+)"`))[1]);
const barIds = [...html.matchAll(/<rect[^>]*data-task="([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(barIds, ['a-1', 'b-1', 'c-1', 'd-1', 'e-1'], 'untimed f-1 has no bar');

// Two idle stretches over 15 minutes become fixed bands with a marker.
assert.deepEqual(attr(html, 'data-gap').map(Number), [70 * MIN, 105 * MIN]);
assert.equal(count(html, /<text[^>]*text-anchor="middle">\+1h<\/text>/g), 2);
assert.equal(count(html, /class="gap-line"/g), 2);
assert.ok(num(barTag('c-1'), 'width') > 200, 'squeezed timeline gives real work room');
assert.ok(num(barTag('e-1'), 'x') + num(barTag('e-1'), 'width') <= 1198, 'fits the width');

// Overlapping tasks of one agent stack; sequential ones share a row.
assert.match(barTag('c-1'), /data-row="0"/);
assert.match(barTag('d-1'), /data-row="1"/);
assert.match(barTag('a-1'), /data-row="0"/);
assert.match(barTag('b-1'), /data-row="0"/);

// Check strip only where a check time exists; running bar striped with a now line.
assert.equal(count(html, /class="bar-c"/g), 1);
assert.match(barTag('e-1'), /class="bar-w in_progress"/);
assert.match(html, /class="now-line"/);
assert.match(html, /fl-stripes/);
assert.match(html, /check 1m 00s/);

// Summary figures.
assert.match(html, /Start to finish<\/span><span class="v">3h 20m</);
assert.match(html, /Agents busy<\/span><span class="v">12%</);
assert.match(html, /24m 00s of work time/);
assert.match(html, /Most at once<\/span><span class="v">2</);
assert.match(html, /tasks ran side by side/);
assert.match(html, /Longest pause<\/span><span class="v">1h 45m</);

// Untimed tasks are listed below, with their state.
assert.match(html, /Not on the timeline: <button[^>]*data-task="f-1"[^>]*>f-1<\/button> \(done\)/);

// No timing at all: the empty state, and the Plan view is unaffected.
const untimedHtml = (() => {
  const s = withActions();
  s.ctx.Studio.state.milestoneId = 'm3';
  s.ctx.Studio.state.focusTaskId = null;
  s.act('flow-mode', { getAttribute: () => 'timeline' });
  return s.render();
})();
assert.match(untimedHtml, /No timing recorded for m3/);
assert.match(untimedHtml, /The Plan view still shows how they connect/);

// A pending-only milestone still draws its own tasks.
assert.match(renderPage('flow', api, { state: { milestoneId: 'm2' } }), /data-id="z-1"/);

// A milestone with no tasks.
const emptyPlan = renderPage('flow', api, { state: { milestoneId: 'm4' } });
assert.match(emptyPlan, /This milestone has no tasks yet\./);
assert.ok(!emptyPlan.includes('class="canvas'));

// Shell contract: page CSS is scoped, client code has no template literals.
const page = pages.find((p) => p.id === 'flow');
assert.ok(page.css.split('\n').filter(Boolean).every((l) => l.startsWith('#panel-flow')), 'css scoped');
assert.ok(!page.script.includes('`') && !page.script.includes('${'), 'no backticks or dollar-brace');
assert.ok(pureScript.length > 0);

console.log('Studio Flow page checks passed.');
