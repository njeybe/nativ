import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'bin', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-hook-event-'));

function project(name, withState = true) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withState) fs.mkdirSync(path.join(dir, '.nativ'));
  return dir;
}

function runEvent(dir, input, env = {}) {
  const clean = { ...process.env, ...env };
  if (!('NATIV_RUN_ID' in env)) delete clean.NATIV_RUN_ID;
  const started = Date.now();
  const res = spawnSync(process.execPath, [cli, 'hook', 'event', dir], {
    input,
    env: clean,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { ...res, ms: Date.now() - started };
}

function events(dir) {
  const d = path.join(dir, '.nativ', 'events');
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l));
}

const stopPayload = (dir, transcript) => JSON.stringify({
  hook_event_name: 'SubagentStop',
  session_id: 'sess1',
  agent_id: 'ag1',
  agent_type: 'worker',
  cwd: dir,
  agent_transcript_path: transcript,
  last_assistant_message: 'SECRET-MESSAGE-TEXT',
});

// Silent, exit 0, nothing written for bad payloads.
const bad = project('bad');
const oversized = JSON.stringify({ hook_event_name: 'SubagentStart', pad: 'x'.repeat(1100 * 1024) });
for (const input of ['', '{not json', oversized, JSON.stringify({ hook_event_name: 'Nope' })]) {
  const r = runEvent(bad, input);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
}
assert.equal(events(bad).length, 0);

// Skipped when NATIV_RUN_ID is set or the root has no state dirs.
const start = JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 's', agent_id: 'a' });
const run = project('run');
assert.equal(runEvent(run, start, { NATIV_RUN_ID: 'r1' }).status, 0);
assert.equal(events(run).length, 0);
const bare = project('bare', false);
assert.equal(runEvent(bare, start).status, 0);
assert.equal(fs.existsSync(path.join(bare, '.nativ')), false);

// A normal start event is written.
const ok = project('ok');
const small = runEvent(ok, start);
assert.equal(small.status, 0);
assert.equal(events(ok)[0].data.phase, 'start');
console.log(`small payload call: ${small.ms} ms`);

// SubagentStop sums the transcript and keeps nothing else from it.
const transcript = path.join(tmp, 'transcript.jsonl');
const line = (model, u) => JSON.stringify({
  type: 'assistant',
  message: { model, usage: u, content: [{ type: 'text', text: 'TRANSCRIPT-TEXT' }] },
});
fs.writeFileSync(transcript, [
  line('model-a', {
    input_tokens: 1, output_tokens: 2,
    cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
  }),
  JSON.stringify({ type: 'user', message: { content: 'hello' } }),
  'not json',
  line('model-b', {
    input_tokens: 10, output_tokens: 20,
    cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
  }),
  line('model-a', { input_tokens: 100, output_tokens: 200 }),
].join('\n'));
const stop = project('stop');
assert.equal(runEvent(stop, stopPayload(stop, transcript)).status, 0);
const [ev] = events(stop);
assert.equal(ev.kind, 'agent');
assert.equal(ev.data.phase, 'stop');
assert.deepEqual(ev.data.tokens, { input: 111, output: 222, cacheRead: 33, cacheCreation: 44 });
assert.deepEqual(ev.data.models, ['model-a', 'model-b']);
const raw = JSON.stringify(ev);
assert.ok(!raw.includes('TRANSCRIPT-TEXT') && !raw.includes('SECRET-MESSAGE-TEXT'));

// A missing transcript still records the stop.
const gone = project('gone');
runEvent(gone, stopPayload(gone, path.join(tmp, 'missing.jsonl')));
assert.equal(events(gone)[0].data.phase, 'stop');

// The module reaches no framework, driver, plan or telemetry code.
const seen = new Set();
const banned = /commander|[\\/]pg[\\/]|postgres|mysql|sqlite|mongo|master-plan|plan-|telemetry/i;
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specs) {
    assert.ok(!banned.test(spec), `${path.basename(file)} imports ${spec}`);
    if (spec.startsWith('.')) walk(path.resolve(path.dirname(file), spec));
  }
}
walk(path.join(repo, 'dist', 'commands', 'hook-event.js'));
assert.ok(seen.size > 3);

// bin/cli.js routes it without loading the full program.
const cliSrc = fs.readFileSync(cli, 'utf8');
const branch = cliSrc.slice(cliSrc.indexOf("subcommand === 'event'"), cliSrc.indexOf('} else {\n  const { run }'));
assert.ok(branch.includes('hook-event.js') && !branch.includes('dist/index.js'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('hook event tests passed');
