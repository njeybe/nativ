import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

console.log('--- Starting Activity Bridge Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => pathToFileURL(path.join(repoRoot, 'dist', p)).href;
const { attachActivityLog, reasonFor } = await import(dist('runner/activity-bridge.js'));
const { readEvents } = await import(dist('core/activity/event-log.js'));
const { fromToolCall } = await import(dist('core/activity/normalize.js'));

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-bridge-')));
fs.mkdirSync(path.join(root, '.ai'));
fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify({
  version: '1.0.0', projectName: 'p', lastUpdated: new Date().toISOString(),
  overallStatus: 'in_progress', activeMilestoneId: 'm1',
  milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: [{
    id: 'task-1', title: 'T', description: 'd', assignedSubagent: 'backend', dependencies: [],
    targetFiles: [], status: 'in_progress', verificationCommand: '', notes: '',
  }] }],
}));

const sup = new EventEmitter();
attachActivityLog(sup, root);
const base = { runId: 'r1', taskId: 'task-1' };
const record = (status, extra = {}) => ({
  ...base, status, engine: 'cli', model: 'sonnet', exitCode: null, timedOut: false,
  error: null, verification: null, ...extra,
});
const cwd = root;
const input = { file_path: path.join(root, 'src', 'a.ts'), content: 'x' };

sup.emit('runner_status', record('running'));
// cli: call then result, paired by id
sup.emit('runner_tool', { ...base, cwd, id: 't1', name: 'Write', input });
sup.emit('runner_tool', { ...base, id: 't1', ok: false });
// native: call and outcome together
sup.emit('runner_tool', { ...base, cwd, name: 'Write', input, ok: true });
sup.emit('runner_token_usage', {
  ...base, model: 'sonnet', turn: 1, at: new Date().toISOString(),
  delta: { model: 'sonnet', turns: 1, inputTokens: 5, outputTokens: 6, cacheReadTokens: 7,
    cacheCreationTokens: 8, thinkingTokens: 0, costUsd: 0.5 },
});
sup.emit('runner_status', record('failed', {
  exitCode: 2, error: 'Runner exited with code 2: secret detail',
}));

const events = readEvents(root).events;
const tools = events.filter((e) => e.kind === 'tool');
assert.equal(tools.length, 2);
assert.equal(tools[0].data.ok, false);
assert.equal(tools[1].data.ok, true);
const expected = fromToolCall({ name: 'Write', input, ok: true },
  { root, runId: 'r1', cwd, role: 'backend', model: 'sonnet', taskId: 'task-1' });
assert.deepEqual(tools[1].data, expected.data);
assert.equal(tools[1].src, 'runner');
console.log('  ok: tool events go through fromToolCall');

for (const e of events) {
  assert.equal(e.lane.id, 'run:r1');
  assert.equal(e.lane.role, 'backend');
}
console.log('  ok: lane id and role');

const runs = events.filter((e) => e.kind === 'run');
assert.deepEqual(runs.map((e) => e.data.status), ['running', 'failed']);
assert.equal(runs[1].data.reason, 'exit_nonzero');
assert.equal(runs[1].data.exitCode, 2);
assert.ok(!JSON.stringify(events).includes('secret detail'));
console.log('  ok: run events carry a reason code, no error text');

const usage = events.find((e) => e.kind === 'usage');
assert.deepEqual(
  {
    m: usage.data.model, i: usage.data.input, o: usage.data.output,
    r: usage.data.cacheRead, c: usage.data.cacheCreation,
  },
  { m: 'sonnet', i: 5, o: 6, r: 7, c: 8 },
);
console.log('  ok: usage events');

const rec = (status, o = {}) => ({ status, timedOut: false, error: null, verification: null, ...o });
assert.equal(reasonFor(rec('completed')), undefined);
assert.equal(reasonFor(rec('aborted')), 'aborted');
assert.equal(reasonFor(rec('failed', { timedOut: true, error: 'budget' })), 'timeout');
assert.equal(reasonFor(rec('failed', { timedOut: true, error: 'no output for 5s' })), 'idle');
assert.equal(reasonFor(rec('failed', { verification: { success: false, skipped: false } })), 'verify_failed');
assert.equal(reasonFor(rec('failed', { error: 'Merge failed: x' })), 'merge_failed');
assert.equal(reasonFor(rec('failed', { error: 'Worktree provisioning failed: x' })), 'worktree_failed');
assert.equal(reasonFor(rec('failed', { error: 'Failed to spawn runner: x' })), 'spawn_failed');
console.log('  ok: reason mapping');

fs.rmSync(root, { recursive: true, force: true });
console.log('--- Activity Bridge Verification Passed ---');
