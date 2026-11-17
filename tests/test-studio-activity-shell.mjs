import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pipelineStateScript } from '../dist/server/studio-ui/shell/pipeline-state.js';
import { syncScript } from '../dist/server/studio-ui/shell/sync.js';
import { ICON_PATHS } from '../dist/server/studio-ui/shell/icons.js';

// Run with `npm run build && npx tsx tests/test-studio-activity-shell.mjs`.
console.log('--- Studio shell: activity slice, SSE mapping and pulse icon ---');

const noop = () => {};
// Sandbox arrays come from another realm; copy them so deepEqual compares values.
const plain = (v) => JSON.parse(JSON.stringify(v));
const classList = { add: noop, remove: noop };
const stubEl = { classList, offsetWidth: 0, setAttribute: noop, textContent: '' };

// Loads the browser shell fragments into one sandbox with just enough DOM to run them.
function loadShell() {
  const ctx = {
    window: { matchMedia: null },
    document: { title: '' },
    $: () => stubEl,
    Studio: { setModel: noop },
    buildModel: () => ({}),
    refreshUi: noop,
    api: () => Promise.reject(new Error('api not stubbed')),
    syncHealTab: noop,
    renderTriageChip: noop,
    paintChrome: noop,
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(pipelineStateScript, ctx);
  vm.runInContext(syncScript, ctx);
  return ctx;
}

const BODY = {
  ok: true,
  cursor: 'c-42',
  windowMinutes: 30,
  lanes: [{ key: 'runner:1', label: 'developer', status: 'Active' }],
  events: [{ at: '2026-11-17T07:00:00.000Z', text: 'edit' }],
  truncated: true,
};

// 1. fetchPipeline(['activity']) stores the slice; a failed fetch sets its error.
{
  const ctx = loadShell();
  const seen = [];
  ctx.api = (path) => { seen.push(path); return Promise.resolve(BODY); };
  await ctx.fetchPipeline(['activity']);
  assert.deepEqual(seen, ['/api/pipeline/activity'], 'the activity slice fetches its own path');
  assert.deepEqual(plain(ctx.pipe.activity.lanes), BODY.lanes, 'lanes are stored');
  assert.deepEqual(plain(ctx.pipe.activity.events), BODY.events, 'events are stored');
  assert.equal(ctx.pipe.activity.cursor, 'c-42', 'cursor is stored');
  assert.equal(ctx.pipe.activity.truncated, true, 'truncated is stored');
  assert.equal(ctx.pipe.errors.activity, null, 'a good fetch clears the slice error');
  assert.ok(ctx.ALL_PARTS.includes('activity'), 'activity is part of ALL_PARTS');

  const failing = loadShell();
  failing.api = () => Promise.reject(new Error('activity offline'));
  await failing.fetchPipeline(['activity']);
  assert.equal(failing.pipe.errors.activity, 'activity offline', 'a failed fetch sets the slice error');
  console.log('✔ fetchPipeline stores lanes, events, cursor and truncated; failures set the slice error');
}

// 2. An activity_change frame refetches only the activity slice.
{
  const ctx = loadShell();
  const calls = [];
  ctx.fetchPipeline = (parts) => { calls.push(parts); return Promise.resolve(); };
  assert.deepEqual(plain(ctx.EVENT_PARTS.activity_change), ['activity'], 'activity_change maps to activity');
  ctx.onStreamEvent('activity_change');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(calls.map(plain), [['activity']], 'the frame refetches only the activity slice');
  console.log('✔ An activity_change frame refetches only the activity slice');
}

// 3. The pulse icon is the Phosphor Regular path at viewBox 0 0 256 256.
{
  const expected = '<path d="M240,128a8,8,0,0,1-8,8H204.94l-37.78,75.58A8,8,0,0,1,160,216h-.4a8,8,0,0,1-7.08-5.14' +
    'L95.35,60.76,63.28,131.31A8,8,0,0,1,56,136H24a8,8,0,0,1,0-16H50.85L88.72,36.69a8,8,0,0,1,14.76.46' +
    'l57.51,151,31.85-63.71A8,8,0,0,1,200,120h32A8,8,0,0,1,240,128Z"/>';
  assert.equal(ICON_PATHS.activity, expected, 'ICON_PATHS.activity holds the Phosphor pulse path');
  console.log('✔ ICON_PATHS.activity holds the Phosphor pulse path');
}

// 4. The generated client code has no backticks and no dollar-brace sequences.
{
  const client = pipelineStateScript + syncScript;
  assert.ok(!client.includes('`'), 'client code has no backtick');
  assert.ok(!client.includes('${'), 'client code has no dollar-brace sequence');
  console.log('✔ Generated client code contains no backticks or dollar-brace sequences');
}

console.log('All studio activity shell checks passed.');
