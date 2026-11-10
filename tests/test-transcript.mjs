import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  TranscriptWriter, blockParts, clip, pruneTranscripts, streamLineParts,
  transcriptDir, transcriptFile, transcriptsEnabled,
} from '../dist/runner/transcript.js';
import {
  findTranscript, formatTranscript, listTranscripts, readTranscript, summarizeTranscript,
} from '../dist/runner/transcript-view.js';
import { SHARED_PATHS } from '../dist/core/setup/gitignore-block.js';

console.log('--- Starting Transcript Recorder Tests ---');

const CLI = path.resolve('bin', 'cli.js');
const dirs = [];
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-transcript-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.nativ'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify({ version: '1.0.0', milestones: [] }));
  return dir;
}
const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  // ── Writer: ordering, versioning, reserved fields ─────────────────────────────
  {
    const root = project();
    const file = transcriptFile(root, 'run-a');
    assert.equal(file, path.join(transcriptDir(root), 'run-a.jsonl'));
    const w = new TranscriptWriter(file);
    w.write('run_start', { taskId: 'task-1', engine: 'cli', seq: 999, type: 'evil' });
    w.write('assistant_text', { text: 'hello' });
    w.write('run_end', { status: 'completed', durationMs: 1500 });
    const events = lines(file);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], 'events are numbered in order');
    assert.deepEqual(events.map((e) => e.type), ['run_start', 'assistant_text', 'run_end'], 'a field cannot overwrite the event type');
    assert.ok(events.every((e) => e.v === 1 && !Number.isNaN(Date.parse(e.at))));
    w.write('note', { text: 'after the end' });
    assert.equal(lines(file).length, 3, 'nothing is written after run_end');
    console.log('✔ Events are versioned, ordered, and closed by run_end.');
  }

  // ── Writer: secret redaction ──────────────────────────────────────────────────
  {
    const root = project();
    const file = transcriptFile(root, 'run-secret');
    const w = new TranscriptWriter(file, { secrets: ['hunter2-exact-key'] });
    w.write('tool_call', {
      name: 'Bash',
      input: { command: 'echo hunter2-exact-key && curl -H "x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"', password: 'letmein', nested: { apiKey: 'zzz999' } },
    });
    w.write('tool_result', { output: 'token is hunter2-exact-key' });
    const raw = fs.readFileSync(file, 'utf8');
    for (const secret of ['hunter2-exact-key', 'abcdefghijklmnopqrstuvwxyz0123456789', 'letmein', 'zzz999']) {
      assert.ok(!raw.includes(secret), `${secret} must not reach the file`);
    }
    console.log('✔ Exact keys, key-shaped strings, and credential-named fields are masked.');
  }

  // ── Writer: clipping and the size cap ─────────────────────────────────────────
  {
    const clipped = clip('a'.repeat(100) + 'END', 50);
    assert.ok(clipped.includes('omitted') && clipped.endsWith('END'), 'clip keeps the tail');
    assert.equal(clip('short', 50), 'short');

    const root = project();
    const file = transcriptFile(root, 'run-big');
    const w = new TranscriptWriter(file, { maxBytes: 2000, maxFieldChars: 300 });
    w.write('run_start', { taskId: 'big' });
    for (let i = 0; i < 50; i++) w.write('assistant_text', { text: `line ${i} ${'x'.repeat(200)}` });
    w.write('run_end', { status: 'completed' });
    const events = lines(file);
    assert.equal(events.filter((e) => e.type === 'truncated').length, 1, 'one truncation marker');
    assert.equal(events[events.length - 1].type, 'run_end', 'run_end still lands in a capped transcript');
    assert.ok(fs.statSync(file).size < 2000 + 600, 'the file stays near its cap');
    console.log('✔ Long fields are clipped and the file is capped with a marker; run_end always lands.');
  }

  // ── Writer never throws ───────────────────────────────────────────────────────
  {
    const root = project();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'a file where a folder is needed');
    const w = new TranscriptWriter(path.join(blocker, 'x', 'run.jsonl'));
    assert.doesNotThrow(() => w.write('run_start', {}));
    const cyclic = {};
    cyclic.self = cyclic;
    const ok = new TranscriptWriter(transcriptFile(root, 'cyc'));
    assert.doesNotThrow(() => ok.write('tool_call', { input: cyclic }));
    console.log('✔ An unwritable folder or odd value never throws into a run.');
  }

  // ── Mapping ───────────────────────────────────────────────────────────────────
  {
    const parts = blockParts([
      { type: 'text', text: 'plan' },
      { type: 'text', text: '   ' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
    assert.deepEqual(parts.map((p) => p[0]), ['assistant_text', 'thinking', 'tool_call']);
    assert.deepEqual(blockParts(undefined), []);

    const result = streamLineParts(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] },
    }));
    assert.deepEqual(result, [['tool_result', { id: 't1', isError: true, output: 'boom' }]]);

    const usage = streamLineParts(JSON.stringify({
      type: 'result', subtype: 'success', num_turns: 3, total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 },
    }))[0];
    assert.equal(usage[0], 'usage');
    assert.equal(usage[1].scope, 'run');
    assert.equal(usage[1].costUsd, 0.5);
    assert.equal(usage[1].cacheReadTokens, 30);

    assert.deepEqual(streamLineParts('plain warning'), [['note', { text: 'plain warning' }]]);
    assert.deepEqual(streamLineParts(''), []);
    assert.deepEqual(streamLineParts(JSON.stringify({ type: 'system', subtype: 'hook' })), []);
    assert.deepEqual(streamLineParts(JSON.stringify({ type: 'unknown' })), []);
    console.log('✔ Claude Code stream lines and API content blocks map to the shared event format.');
  }

  // ── Config switch and pruning ─────────────────────────────────────────────────
  {
    const root = project();
    assert.equal(transcriptsEnabled(root), true, 'on by default');
    fs.writeFileSync(path.join(root, '.nativ', 'config.json'), JSON.stringify({ transcripts: false }));
    assert.equal(transcriptsEnabled(root), false);
    fs.writeFileSync(path.join(root, '.nativ', 'config.json'), '{ not json');
    assert.equal(transcriptsEnabled(root), true, 'a broken config keeps recording on');

    const dir = transcriptDir(root);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `r${i}.jsonl`);
      fs.writeFileSync(f, '{}\n');
      const t = new Date(Date.now() - (5 - i) * 10_000);
      fs.utimesSync(f, t, t);
    }
    assert.equal(pruneTranscripts(dir, 2), 3);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['r3.jsonl', 'r4.jsonl'], 'the newest are kept');
    assert.equal(pruneTranscripts(path.join(root, 'missing'), 2), 0);
    console.log('✔ transcripts:false disables recording and old transcripts are pruned.');
  }

  // ── Reading, listing, finding, replay ─────────────────────────────────────────
  {
    const root = project();
    const make = (runId, task, status, startedAt, extra = {}) => {
      const file = transcriptFile(root, runId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const evs = [
        { v: 1, seq: 1, at: startedAt, type: 'run_start', taskId: task, engine: 'cli', model: null },
        { v: 1, seq: 2, at: startedAt, type: 'tool_call', id: 'a', name: 'Bash', input: { command: 'npm test' } },
        { v: 1, seq: 3, at: startedAt, type: 'tool_result', id: 'a', isError: false, output: 'ok\n'.repeat(30) },
      ];
      if (status) {
        evs.push({
          v: 1, seq: 4, at: new Date(Date.parse(startedAt) + 4000).toISOString(), type: 'run_end', status, durationMs: 4000,
          usage: { costUsd: 0.25, turns: 2, model: 'sonnet', ...extra },
        });
      }
      fs.writeFileSync(file, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return file;
    };
    make('11111111-aaaa', 'task-1', 'completed', '2026-01-01T10:00:00.000Z');
    make('22222222-bbbb', 'task-1', 'failed', '2026-01-02T10:00:00.000Z');
    make('2222zzzz-cccc', 'task-2', null, '2026-01-03T10:00:00.000Z');

    const all = listTranscripts(root);
    assert.deepEqual(all.map((s) => s.runId), ['2222zzzz-cccc', '22222222-bbbb', '11111111-aaaa'], 'newest first');
    assert.equal(all[0].status, null, 'a run with no run_end shows as unfinished');
    assert.equal(all[2].model, 'sonnet', 'the model falls back to the run totals');
    assert.equal(all[2].costUsd, 0.25);
    assert.equal(listTranscripts(root, { task: 'task-1' }).length, 2);
    assert.equal(listTranscripts(root, { limit: 1 }).length, 1);
    assert.deepEqual(listTranscripts(path.join(root, 'nowhere')), []);

    assert.equal(findTranscript(root, '11111111-aaaa').summary.taskId, 'task-1', 'exact run id');
    assert.equal(findTranscript(root, 'task-1').summary.runId, '22222222-bbbb', 'a task id finds its latest run');
    assert.equal(findTranscript(root, '1111').summary.runId, '11111111-aaaa', 'unique prefix');
    assert.match(findTranscript(root, '2222').error, /matches 2 runs/, 'ambiguous prefix');
    assert.match(findTranscript(root, 'nothing').error, /No recorded run/);
    assert.match(findTranscript(root, 'ab').error, /No recorded run/, 'a prefix under 4 characters is not used');

    // A damaged line is skipped, not fatal
    const damaged = transcriptFile(root, 'damaged');
    fs.writeFileSync(damaged, fs.readFileSync(transcriptFile(root, '11111111-aaaa'), 'utf8') + '{"truncated mid wri');
    const read = readTranscript(damaged);
    assert.equal(read.skipped, 1);
    assert.equal(read.events.length, 4);
    assert.ok(summarizeTranscript(damaged), 'a transcript with a torn last line still summarises');

    const events = readTranscript(transcriptFile(root, '11111111-aaaa')).events;
    const short = formatTranscript(events);
    assert.match(short, /start · task task-1 · cli engine/);
    assert.match(short, /call Bash: npm test/);
    assert.match(short, /more lines?/, 'long output is cut in the default view');
    assert.match(short, /end · completed · 4s/);
    assert.ok(!/more lines?/.test(formatTranscript(events, { full: true })), '--full shows everything');
    assert.equal(formatTranscript([]), 'This transcript has no events.');
    console.log('✔ Listing, lookup by run/task/prefix, damaged lines, and replay formatting work.');

    // CLI
    const run = (...args) => spawnSync(process.execPath, [CLI, 'runs', ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const list = run('list', root);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /task-1/);
    assert.match(list.stdout, /unfinished/);
    const json = JSON.parse(run('list', root, '--json', '--task', 'task-2').stdout);
    assert.equal(json.length, 1);
    const show = run('show', 'task-1', root);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /22222222-bbbb/);
    assert.match(show.stdout, /end · failed/);
    const replay = run('replay', '11111111', root, '--json');
    assert.equal(JSON.parse(replay.stdout).events.length, 4, 'replay is an alias of show');
    const missing = run('show', 'nope-nope', root);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /No recorded run/);
    const empty = run('list', project());
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /No recorded runs/);
    console.log('✔ "nativ runs list" and "nativ runs show" behave as documented.');
  }

  // ── Shared-git mode must not commit transcripts ───────────────────────────────
  assert.ok(SHARED_PATHS.includes('/.nativ/runs/'), 'transcripts are ignored even when nativ files are shared');
  console.log('✔ Shared git mode ignores .nativ/runs/.');

  console.log('\n🎉 ALL TRANSCRIPT TESTS PASSED!');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
