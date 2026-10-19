import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { renderStudioHtml } from '../src/server/studio-ui.ts';
import { pulseScript } from '../src/server/studio-ui/shell/pulse.ts';
import { paintScript } from '../src/server/studio-ui/shell/paint.ts';
import { dispatchScript } from '../src/server/studio-ui/shell/dispatch.ts';

// Run with `npx tsx tests/test-studio-pulse.mjs`.
console.log('--- Studio pulse strip ---');

const html = renderStudioHtml();
assert.ok(html.includes('function pulseParts('), 'pulse script is in the page');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(scripts.length > 0);
for (const s of scripts) new vm.Script(s);

assert.ok(/Studio\.afterPaint\.forEach/.test(paintScript), 'paintChrome runs the hooks');
assert.ok(/try \{ fn\(\); \}/.test(paintScript), 'each hook is wrapped');
assert.ok(!/setInterval/.test(dispatchScript), 'dispatch no longer polls');
assert.ok(/Studio\.onPaint\(syncDispatchNext\)/.test(dispatchScript));

const stubEl = { addEventListener() {} };
const ctx = vm.createContext({
  Studio: { onPaint() {} }, pipe: { loaded: {}, escalations: [] },
  live: { mode: 'live' }, $: () => stubEl, esc: (v) => String(v), location: {},
});
const parts = vm.runInContext(`${pulseScript}; pulseParts`, ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));
const base = { loaded: true, offline: false, ms: 'm2 3/7', running: 0, blocked: 0, decisions: 0 };

const loading = plain(parts({ ...base, loaded: false }));
assert.equal(loading.kind, 'loading');
assert.ok(/^-/.test(loading.text));

const zero = plain(parts(base));
assert.equal(zero.kind, 'ready');
assert.equal(zero.counts.length, 0, 'zero counts are dropped');
const html0 = vm.runInContext(`${pulseScript}; pulseHtml`, ctx);
assert.equal(html0(zero), '', 'all zero renders nothing');

const busy = plain(parts({ ...base, running: 2, blocked: 1 }));
assert.deepEqual(busy.counts.map((c) => [c.key, c.label, c.tone]),
  [['running', 'running', 'run'], ['stuck', 'stuck', 'bad']]);
const one = plain(parts({ ...base, decisions: 1 }));
assert.equal(one.counts[0].label, 'decision');
assert.ok(!html0(busy).includes('pdot'), 'no status dots');
assert.equal(busy.ms, 'm2 3/7');

const off = plain(parts({ ...base, offline: true, running: 5 }));
assert.deepEqual(off, { kind: 'offline', text: 'Offline, retrying' });

const inputCtx = vm.createContext({
  Studio: { onPaint() {}, model: { milestones: [], running: [], stuck: [], needsYou: [{}] } },
  pipe: { loaded: { tasks: true }, escalations: [] },
  live: { mode: 'live' }, $: () => stubEl, esc: (v) => String(v), location: {},
});
const input = vm.runInContext(`${pulseScript}; pulseInput()`, inputCtx);
assert.equal(input.decisions, 1, 'decisions come from model.needsYou');

const shellDir = new URL('../src/server/studio-ui/shell/', import.meta.url);
for (const f of ['format.ts', 'pipeline-state.ts']) {
  assert.ok(!readFileSync(new URL(f, shellDir), 'utf8').includes('–'), `${f}: no en dash`);
}

const shellCss = readFileSync(new URL('../src/server/studio-ui/styles/shell.ts', import.meta.url), 'utf8');
assert.ok(!shellCss.includes('break-all'), 'no break-all in shell CSS');
const sideSrc = readFileSync(new URL('../src/server/studio-ui/shell/sidebar-view.ts', import.meta.url), 'utf8');
assert.ok(!sideSrc.includes('benchmarkText'), 'no benchmarks badge');

for (const [name, src] of [['pulse', pulseScript], ['paint', paintScript], ['dispatch', dispatchScript]]) {
  assert.ok(!src.includes('`'), `${name}: no backticks`);
  assert.ok(!src.includes('${'), `${name}: no dollar-brace`);
}
console.log('PASS: studio pulse strip');
