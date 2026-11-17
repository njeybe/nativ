import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromHookPayload, fromToolCall } from '../dist/core/activity/normalize.js';

console.log('--- Activity normaliser ---');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-normalize-'));
fs.mkdirSync(path.join(root, '.ai'));
fs.mkdirSync(path.join(root, '.worktrees', 'task-task-7'), { recursive: true });
const now = new Date('2026-01-02T03:04:05.000Z');
const at = now.toISOString();

const post = (extra, cwd = root) => ({
  hook_event_name: 'PostToolUse', session_id: 's1', cwd, tool_response: { stdout: 'x' }, ...extra,
});
const hook = (p, env = {}) => fromHookPayload(p, env, now);
const bash = (command) => hook(post({ tool_name: 'Bash', tool_input: { command } })).data;
const lines = (n) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');

// Table: payload to exact event.
const table = [
  [
    post({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src', 'a.ts') } }),
    { v: 1, at, src: 'hook', lane: { id: 's:s1', session: 's1', role: 'main' }, kind: 'tool',
      data: { name: 'Read', ok: true, path: 'src/a.ts' } },
  ],
  [
    { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'ag1', agent_type: 'worker', cwd: root },
    { v: 1, at, src: 'hook',
      lane: { id: 's:s1/a:ag1', session: 's1', agent: 'ag1', agentType: 'worker', role: 'worker' },
      kind: 'agent', data: { phase: 'start' } },
  ],
  [
    { hook_event_name: 'SubagentStop', session_id: 's1', agent_type: 'worker', cwd: root },
    { v: 1, at, src: 'hook',
      lane: { id: 's:s1/t:worker', session: 's1', agentType: 'worker', role: 'worker' },
      kind: 'agent', data: { phase: 'stop' } },
  ],
];
for (const [payload, expected] of table) assert.deepEqual(hook(payload), expected);
assert.equal(hook({ hook_event_name: 'PreToolUse', session_id: 's1' }), null);
for (const tool_name of ['Agent', 'Task']) {
  assert.equal(hook(post({ tool_name, tool_input: { subagent_type: 'explorer' } })), null);
}
assert.equal(hook(post({ tool_name: 'Read' }, root) && { hook_event_name: 'PostToolUse' }), null);
assert.equal(hook(post({ tool_name: 'Read' })).lane.role, 'main');
assert.equal(hook(post({ tool_name: 'Read' }), { NATIV_ROLE: 'architect' }).lane.role, 'architect');

// A third word is a task id only after task or verify.
assert.equal(bash('nativ db inspect secretword').taskId, undefined);
assert.equal(bash('nativ verify task-3').taskId, 'task-3');
assert.equal(bash('node dist/cli.js task start task-3').taskId, 'task-3');
assert.equal(bash('nativ studio start').taskId, undefined);

// Bash.
assert.deepEqual(
  { program: bash('DB_URL=x npm test --watch').program, nativ: bash('DB_URL=x npm test --watch').nativ },
  { program: 'npm', nativ: undefined });
assert.deepEqual(Object.keys(bash('DB_URL=x npm test --watch')).sort(), ['name', 'ok', 'program']);
const done = hook(post({ tool_name: 'Bash', tool_input: { command: 'nativ task complete task-9' } }));
assert.deepEqual(done.data, { name: 'Bash', ok: true, program: 'nativ', nativ: 'task complete', taskId: 'task-9' });
assert.deepEqual(done.task, { id: 'task-9', via: 'command' });
assert.equal(bash('node dist/cli.js task start task-3').nativ, 'task start');
assert.equal(bash('C:\\bin\\Git.EXE status').program, 'git');
assert.equal(bash('"quoted thing" a').program, undefined);

// Paths.
const outside = hook(post({ tool_name: 'Read', tool_input: { file_path: path.join(os.tmpdir(), 'zz.txt') } }));
assert.equal(outside.data.outside, true);
assert.equal('path' in outside.data, false);
const wt = path.join(root, '.worktrees', 'task-task-7');
const inTree = hook(post({ tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'b.ts'),
  old_string: 'a', new_string: 'b\nc' } }, wt));
assert.equal(inTree.data.path, 'src/b.ts');
assert.deepEqual(inTree.task, { id: 'task-7', via: 'worktree' });
assert.deepEqual([inTree.data.removed, inTree.data.added], [1, 2]);

// Line counts.
const big = hook(post({ tool_name: 'Write', tool_input: { file_path: 'big.txt', content: lines(5000) } }));
assert.equal(big.data.added, 5000);
assert.ok(!JSON.stringify(big).includes('l4999'));
const multi = hook(post({ tool_name: 'MultiEdit', tool_input: { file_path: 'm.ts', edits: [
  { old_string: 'a\nb', new_string: 'c' }, { old_string: 'd', new_string: 'e\nf\ng' } ] } }));
assert.deepEqual([multi.data.removed, multi.data.added], [3, 4]);
const patched = hook(post({ tool_name: 'Edit', tool_input: { file_path: 'p.ts', old_string: 'a', new_string: 'b' },
  tool_response: { structuredPatch: [{ lines: [' ctx', '-x', '-y', '+z'] }] } }));
assert.deepEqual([patched.data.removed, patched.data.added], [2, 1]);

// Air-gap: fake secrets in every free-text field.
const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const secretPayloads = [
  post({ tool_name: 'Bash', tool_input: { command: `curl https://x/${KEY} --token ${KEY}` },
    tool_response: { stdout: KEY, stderr: KEY } }),
  post({ tool_name: 'Grep', tool_input: { pattern: KEY, path: root } }),
  post({ tool_name: 'Write', tool_input: { file_path: `${KEY}.txt`, content: KEY } }),
  post({ tool_name: 'mcp__nativ__nativ_task_start', tool_input: { taskId: KEY } }),
  post({ tool_name: KEY, tool_input: {} }),
  { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a', agent_type: 'w', last_assistant_message: KEY },
];
for (const p of secretPayloads) {
  const ev = hook(p);
  assert.ok(ev, 'event produced');
  assert.ok(!JSON.stringify(ev).includes(KEY), JSON.stringify(ev));
}
const spawned = fromToolCall({ name: 'Agent', input: { subagent_type: KEY, model: 'haiku' } }, { root, runId: 'r1' });
assert.ok(!('spawn' in spawned.data));
const clipped = bash(`${'a'.repeat(40)} x`);
assert.equal(clipped.program, undefined);
const longPath = hook(post({ tool_name: 'Read', tool_input: { file_path: 'd/' + 'p'.repeat(400) } }));
assert.equal(longPath.data.path.length, 300);

// MCP and runner tool calls.
const mcp = hook(post({ tool_name: 'mcp__nativ__nativ_task_complete', tool_input: { taskId: 'task-5', notes: 'n' } }));
assert.deepEqual(mcp.data, { name: 'mcp__nativ__nativ_task_complete', ok: true, taskId: 'task-5' });
assert.deepEqual(mcp.task, { id: 'task-5', via: 'command' });
const runner = fromToolCall(
  { name: 'Edit', input: { file_path: path.join(root, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }, ok: false },
  { root, runId: 'r1', role: 'backend', model: 'sonnet', taskId: 'task-7', now });
assert.deepEqual(runner, {
  v: 1, at, src: 'runner', lane: { id: 'run:r1', runId: 'r1', role: 'backend', model: 'sonnet' },
  task: { id: 'task-7', via: 'env' }, kind: 'tool',
  data: { name: 'Edit', ok: false, path: 'src/a.ts', removed: 1, added: 1 } });
const chat = hook(post({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }));
assert.deepEqual({ ...runner.data, ok: true }, chat.data);

fs.rmSync(root, { recursive: true, force: true });
console.log('Activity normaliser tests passed');
