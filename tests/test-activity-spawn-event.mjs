import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runHookCheck } from '../dist/commands/hook.js';
import { readEvents } from '../dist/core/activity/event-log.js';

console.log('--- Chat spawn events ---');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-spawn-'));
fs.mkdirSync(path.join(root, '.ai'));
const wt = path.join(root, '.worktrees', 'task-task-7');
fs.mkdirSync(wt, { recursive: true });
const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';

async function call(extra) {
  let out = '';
  const payload = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, ...extra };
  await runHookCheck(root, {
    input: Readable.from([JSON.stringify(payload)]),
    output: (t) => { out += t; },
    mode: 'warn',
  });
  return out;
}
const events = () => readEvents(root).events;

try {
  const out = await call({
    tool_name: 'Agent', tool_use_id: 'toolu_1', agent_id: 'ag1', agent_type: 'worker',
    tool_input: { subagent_type: 'explorer', model: 'haiku', prompt: 'PROMPT', description: 'DESC' },
  });
  assert.equal(out, '', 'no hook output for a spawn');
  let ev = events();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tool');
  assert.equal(ev[0].src, 'hook');
  assert.equal(ev[0].lane.id, 's:s1/a:ag1');
  assert.equal(ev[0].lane.role, 'worker');
  assert.deepEqual(ev[0].data, { name: 'Agent', ok: true, spawn: { agentType: 'explorer', model: 'haiku' } });
  assert.equal('task' in ev[0], false);
  const raw = JSON.stringify(ev);
  for (const s of ['PROMPT', 'DESC', 'toolu_1']) assert.ok(!raw.includes(s), s);
  console.log('  ok PreToolUse Agent appends one spawn event');

  await call({ tool_name: 'Task', cwd: wt, tool_input: { subagent_type: 'worker' } });
  ev = events();
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[1].data, { name: 'Task', ok: true, spawn: { agentType: 'worker' } });
  assert.deepEqual(ev[1].task, { id: 'task-7', via: 'worktree' });
  assert.equal(ev[1].lane.role, 'main');
  console.log('  ok Task spawn in a worktree carries the task, model is optional');

  await call({ tool_name: 'Agent', tool_input: { subagent_type: KEY, model: KEY } });
  await call({ tool_name: 'Read', tool_input: { file_path: 'a.ts' } });
  await call({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'x' } });
  assert.equal(events().length, 2, 'secret type, other tools and PostToolUse append nothing');
  assert.ok(!JSON.stringify(events()).includes(KEY));
  console.log('  ok secrets, other tools and PostToolUse add no event');

  process.env.NATIV_RUN_ID = 'run-1';
  try {
    await call({ tool_name: 'Agent', tool_input: { subagent_type: 'explorer' } });
  } finally {
    delete process.env.NATIV_RUN_ID;
  }
  assert.equal(events().length, 2, 'a runner run adds no spawn event');
  console.log('  ok a runner run skips the hook spawn event');

  await call({ tool_name: 'Agent', session_id: KEY, tool_input: { subagent_type: 'explorer' } });
  assert.ok(!JSON.stringify(events()).includes(KEY), 'secret session id is not stored');
  console.log('  ok a secret session id is dropped from the lane');

  console.log('\nChat spawn event tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
