import vm from 'node:vm';
import assert from 'node:assert/strict';
import { formatScript } from '../src/server/studio-ui/shell/format.ts';
import { wrapPage } from '../src/server/studio-ui/shell/pure.ts';
import { pages } from '../src/server/studio-ui/pages/index.ts';
import { activityScript } from '../src/server/studio-ui/pages/activity/script.ts';
import { activityCss } from '../src/server/studio-ui/pages/activity/styles.ts';

// Run with `npx tsx tests/test-studio-activity.mjs`: the Activity page in a vm with stubbed shell.
console.log('--- Starting Studio Activity page verification ---');
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const iso = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();
const lane = (o) => ({
  id: 'l', label: 'worker', kind: 'subagent', role: 'worker', model: null, status: 'active', elapsedMs: 252000,
  task: null, last: null, files: { count: 0, source: 'events', top: [] }, tokens: null, runId: null, ...o,
});
const LANES = [
  lane({ id: 'a', model: 'sonnet', task: { id: 'task-121', title: 'Event <log> writer' },
    last: { at: iso(12), text: 'Edit src/x.ts +42 -3' }, elapsedMs: 252000,
    files: { count: 3, top: [{ path: 'src/a/event-log.ts', added: 120, removed: 0 },
      { path: 'b.ts', added: 1, removed: 2 }, { path: 'c.ts', added: 3, removed: 4 }] } }),
  lane({ id: 'b', label: 'main session', kind: 'main', status: 'idle', last: { at: iso(120), text: 'Agent worker' },
    elapsedMs: 1862000 }),
  lane({ id: 'c', label: 'runner', kind: 'runner', model: 'haiku', runId: 'r1',
    task: { id: 'task-122', title: 'Watch' }, last: { at: iso(40), text: 'nativ task complete' },
    tokens: { total: 31004 }, status: 'failed',
    files: { count: 1, top: [{ path: 'watch.ts', added: 150, removed: 0 }] } }),
  lane({ id: 'd', status: 'stopped', model: null, tokens: null }),
];
const EVENTS = [
  { at: iso(30), kind: 'tool', src: 'hook', cursor: 'f:1', lane: { id: 'a', role: 'worker' },
    task: { id: 'task-121' }, data: { name: 'Edit', path: 'src/x.ts', added: 42, removed: 3 } },
];

const store = {};
let state;
function makeEnv() {
  state = {
    pipe: { activity: { lanes: LANES, events: EVENTS }, errors: {}, loaded: { activity: true } },
    clock: NOW, calls: [], fetches: [], PIPE_PATHS: { activity: '/api/pipeline/activity' },
    rc: { taskId: null }, els: {}, copied: [],
  };
  const ctx = vm.createContext({
    state, store, console, Date, Math, Promise, setTimeout, clearTimeout,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  });
  const prelude = [
    'var pipe = state.pipe, PIPE_PATHS = state.PIPE_PATHS, rc = state.rc;',
    'var $ = function (id) { return state.els[id] || (state.els[id] = { textContent: "" }); };',
    'function fetchPipeline(p) { state.fetches.push(p); return Promise.resolve(); }',
    'function errorCard(w, m) { return "<div class=state-error>Could not load " + w + ": " + m + "</div>"; }',
    'function staleNote(k) { return pipe.errors[k] ? "<p>Showing the last synced data.</p>" : ""; }',
    'function openConsole(id, q, tab) { rc.taskId = id; state.calls.push([id, tab]); }',
    'function copyText(t) { state.copied.push(t); }',
    'function api(url) { state.calls.push(url); return Promise.resolve({ text: "hello transcript" }); }',
  ].join('\n');
  const src = '(function () {\n' + prelude + '\n' + formatScript +
    '\nStudio.now = function () { return state.clock; };\n' + wrapPage(activityScript) + '\nreturn { Studio: Studio, fetchPipeline: fetchPipeline };\n})()';
  const out = vm.runInContext(src, ctx);
  out.page = out.Studio.pages.activity;
  return out;
}

// Lanes: label, model, task, status, elapsed, last text, files, tokens
let env = makeEnv();
let html = env.page.render({});
assert.ok(html.includes('2 agents'), 'count is active + idle');
const laneHtml = (id) => html.slice(html.indexOf('data-lane-id="' + id + '"')).split('</section>')[0];
const a = laneHtml('a');
assert.ok(a.includes('sonnet') && a.includes('task-121') && a.includes('Event &lt;log&gt; writer'), 'line 1');
assert.ok(a.includes('title="Event &lt;log&gt; writer"') && a.includes('Active') && a.includes('04:12'), 'status');
assert.ok(a.includes('act-st-active') && a.includes('12s ago') && a.includes('Edit src/x.ts +42 -3'), 'line 2');
assert.ok(a.includes('3 files') && a.includes('event-log.ts +120 -0') && a.includes('c.ts +3 -4'), 'line 3');
assert.ok(a.includes('tokens -'), 'unknown tokens');
const b = laneHtml('b');
assert.ok(b.includes('main session') && b.includes('No task') && b.includes('2m ago') && b.includes('Idle'), 'main');
assert.ok(b.includes('>-<'), 'unknown model dash');
assert.ok(b.includes('31:02') && !b.includes('class="lane-actions"'), 'no actions without task');
const c = laneHtml('c');
assert.ok(c.includes('tokens 31,004') && c.includes('Failed') && c.includes('act-st-failed'), 'runner lane');
assert.ok(laneHtml('d').includes('Done') && laneHtml('d').includes('act-st-stopped'), 'stopped is Done');
assert.ok(html.includes('1 file<'), 'singular file');

// Status uses the Activity class, never the shell's st class (shell.ts .st is a 16px icon box)
assert.ok(a.includes('<span class="act-st act-st-active">'), 'status uses act-st classes');
assert.ok(!/class="st[ "]/.test(html), 'no shell st class on any lane');
assert.ok(!/\.st[ {]/.test(activityCss), 'activity css has no bare .st selector');

// Actions by lane kind
const acts = (h) => [...h.matchAll(/data-act="(act-[a-z]+)"/g)].map((m) => m[1]);
assert.deepEqual(acts(a), ['act-changes'], 'worker: changes only');
assert.deepEqual(acts(c), ['act-console', 'act-transcript', 'act-changes'], 'runner: all three');
assert.ok(!html.includes('Copy transcript path'), 'no path source, no copy action');
state.pipe.activity.lanes = [{ ...LANES[0], transcriptPath: '/t/x.jsonl' }];
assert.ok(env.page.render({}).includes('Copy transcript path'), 'copy appears when the log has the path');
state.pipe.activity.lanes = LANES;

// Actions open the inspector
const el = (id) => ({ getAttribute: () => id });
env.page.actions['act-console'](el('c'));
env.page.actions['act-changes'](el('c'));
assert.equal(JSON.stringify(state.calls), '[["task-122","logs"],["task-122","diff"]]', 'tabs');
state.calls.length = 0;
env.page.actions['act-transcript'](el('c'));
await new Promise((r) => setTimeout(r, 5));
assert.equal(state.calls[1], '/api/pipeline/runs/transcript?run=r1');
assert.equal(state.els['rc-body'].textContent, 'hello transcript', 'transcript text in the inspector');
state.pipe.activity.lanes = [{ ...LANES[0], transcriptPath: '/t/x.jsonl' }];
env.page.actions['act-copy'](el('a'));
assert.equal(state.copied[0], '/t/x.jsonl', 'copyText used');
state.pipe.activity.lanes = LANES;

// Feed
assert.ok(html.includes('class="feed"') && html.includes('Edit src/x.ts +42 -3'), 'feed');
assert.match(html, /\d\d:\d\d:\d\d/, 'HH:MM:SS');

// Window chips and localStorage
assert.ok(html.includes('data-w="30m"') && html.includes('data-w="2h"') && html.includes('>Today<'), 'chips');
assert.ok(/chip on" data-act="act-window" data-w="30m"/.test(html), '30m default');
// Today's window is recomputed on each fetch, so it grows as the clock moves on.
store['nativ-studio:activity-window'] = 'today';
env = makeEnv();
env.page.actions['act-window'](el('today'));
const firstMins = Number(state.PIPE_PATHS.activity.split('=')[1]);
state.clock = NOW + 10 * 60000;
await new Promise((r) => setTimeout(r, 520));
env.fetchPipeline(['activity']);
const laterMins = Number(state.PIPE_PATHS.activity.split('=')[1]);
assert.ok(laterMins > firstMins, 'Today window grows between fetches');
assert.equal(laterMins - firstMins, 10, 'Today window moves by the 10 minutes');
store['nativ-studio:activity-window'] = '30m';
env = makeEnv();
assert.equal(state.PIPE_PATHS.activity, '/api/pipeline/activity?windowMinutes=30');
env.page.actions['act-window'](el('2h'));
assert.equal(store['nativ-studio:activity-window'], '2h');
assert.equal(state.PIPE_PATHS.activity, '/api/pipeline/activity?windowMinutes=120');
env.page.actions['act-window'](el('today'));
const mins = Number(state.PIPE_PATHS.activity.split('=')[1]);
const d = new Date(NOW);
const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
assert.equal(mins, Math.max(1, Math.floor((NOW - midnight) / 60000)));
env = makeEnv();
assert.ok(/chip on" data-act="act-window" data-w="today"/.test(env.page.render({})), 'chip remembered');
store['nativ-studio:activity-window'] = '30m';
env = makeEnv();
env.fetchPipeline(['activity']);
env.fetchPipeline(['activity']);
await new Promise((r) => setTimeout(r, 700));
assert.ok(state.fetches.length <= 2, 'activity refetch throttled to one per 500 ms');

// States
env = makeEnv();
assert.equal((env.page.skeleton({}).match(/class="lane"/g) || []).length, 3, 'three lane skeletons');
state.pipe.activity = { lanes: [], events: [] };
html = env.page.render({});
assert.ok(html.includes('No agent activity in the last 30 minutes.'), 'empty copy');
assert.ok(html.includes('Chat agents are recorded after') && html.includes('nativ setup'), 'empty hint');
state.pipe.errors.activity = 'boom';
assert.ok(env.page.render({}).includes('Could not load activity'), 'error card');
state.pipe.activity = { lanes: LANES, events: [] };
html = env.page.render({});
assert.ok(html.includes('Showing the last synced data'), 'stale note keeps data');
assert.ok(html.includes('data-lane-id="a"'), 'offline keeps last lanes');

// Narrow layout, sidebar order, text rules
assert.ok(/max-width: 1023px[\s\S]*flex-direction: column/.test(activityCss), 'lanes stack below 1024px');
assert.deepEqual(pages.slice(0, 4).map((p) => p.label), ['Home', 'Activity', 'Tasks', 'Flow']);
assert.ok(pages[1].id === 'activity' && pages[1].group === 'now', 'page module');
for (const src of [activityScript, activityCss]) {
  assert.ok(!src.includes('`') && !src.includes('${'), 'no backtick or dollar-brace');
  assert.ok(!/[\u2013\u2014]/.test(src), 'no em or en dashes');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(src), 'no emojis');
}
assert.doesNotThrow(() => new vm.Script(activityScript), 'script parses');
for (const [i, line] of activityScript.split('\n').entries()) assert.ok(line.length <= 120, 'line ' + (i + 1));

console.log('Activity page checks passed');
