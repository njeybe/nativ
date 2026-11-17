import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  runTaskStart, runTaskComplete, runTaskBlock, runTaskReclaim, runTaskEscalate,
} from '../dist/commands/task.js';
import { runHookCheck } from '../dist/commands/hook.js';
import { readEvents } from '../dist/core/activity/event-log.js';

console.log('--- Task, gate and violation events ---');

const dirs = [];
const task = (id, extra = {}) => ({
  id, title: id, description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [],
  status: 'pending', verificationCommand: '', ...extra,
});

function project(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-gate-events-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const plan = {
    version: '1.0.0', projectName: 'ev', lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress', activeMilestoneId: 'm1',
    milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

async function quiet(fn) {
  const logs = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.error] = logs;
  }
}

const events = (dir) => readEvents(dir).events;
const kinds = (dir, kind) => events(dir).filter((e) => e.kind === kind);
const savedAgent = process.env.NATIV_AGENT_ID;
process.env.NATIV_AGENT_ID = 'agent-x';

try {
  // Test 1: start, block and a refused start
  {
    const dir = project([task('t1'), task('t2', { status: 'completed' })]);
    await quiet(() => runTaskStart('t1', dir));
    let ev = kinds(dir, 'task');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].data, { action: 'start', by: 'agent-x' });
    assert.deepEqual(ev[0].task, { id: 't1', via: 'command' });
    assert.equal(ev[0].src, 'cli');
    assert.equal(ev[0].lane.id, 'cli:agent-x');

    process.exitCode = undefined;
    await quiet(() => runTaskStart('t2', dir));
    assert.equal(process.exitCode, 1);
    assert.equal(kinds(dir, 'task').length, 1, 'a refused start appends nothing');
    process.exitCode = undefined;

    await quiet(() => runTaskBlock('t1', 'secret reason text', dir));
    ev = kinds(dir, 'task');
    assert.equal(ev.length, 2);
    assert.equal(ev[1].data.action, 'block');
    assert.ok(!JSON.stringify(events(dir)).includes('secret reason'), 'no block reason in events');
    console.log('  ✔ start and block append task events; a refused start appends none');
  }

  // Test 2: a failing gate writes a verify event with counts only, a passing one a pass event
  {
    const dir = project([
      task('bad', {
        status: 'in_progress',
        verificationCommand: 'node -e "console.error(\'LEAKME\');process.exit(3)"',
      }),
      task('good', { status: 'in_progress', verificationCommand: 'node -e "process.exit(0)"' }),
    ]);
    process.exitCode = undefined;
    await quiet(() => runTaskComplete('bad', dir));
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
    let v = kinds(dir, 'verify');
    assert.equal(v.length, 1);
    assert.equal(v[0].data.pass, false);
    assert.equal(v[0].data.exitCode, 3);
    assert.equal(typeof v[0].data.durationMs, 'number');
    assert.ok(!JSON.stringify(events(dir)).includes('LEAKME'), 'no output in events');
    assert.equal(kinds(dir, 'task').length, 0, 'a failed gate completes nothing');

    await quiet(() => runTaskComplete('good', dir));
    assert.equal(process.exitCode, undefined);
    v = kinds(dir, 'verify');
    assert.equal(v.length, 2);
    assert.equal(v[1].data.pass, true);
    const done = kinds(dir, 'task');
    assert.equal(done.length, 1);
    assert.equal(done[0].data.action, 'complete');
    console.log('  ✔ verify events land for fail and pass; complete only after the plan write');
  }

  // Test 3: reclaim and escalate
  {
    const old = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const dir = project([
      task('r1', { status: 'in_progress', claimedAt: old, claimedBy: 'agent-x' }),
      task('e1', { status: 'in_progress' }),
    ]);
    await quiet(() => runTaskReclaim('r1', dir, { dryRun: true }));
    assert.equal(kinds(dir, 'task').length, 0, 'a dry run appends nothing');
    await quiet(() => runTaskReclaim('r1', dir));
    assert.equal(kinds(dir, 'task')[0].data.action, 'reclaim');
    await quiet(() => runTaskEscalate('e1', dir, { type: 'schema_flaw', details: 'PRIVATE detail' }));
    const ev = kinds(dir, 'task');
    assert.equal(ev.length, 2);
    assert.equal(ev[1].data.action, 'escalate');
    assert.ok(!JSON.stringify(events(dir)).includes('PRIVATE'), 'no escalation details in events');
    process.exitCode = undefined;
    await quiet(() => runTaskEscalate('missing', dir, {}));
    assert.equal(kinds(dir, 'task').length, 2, 'a refused escalation appends nothing');
    process.exitCode = undefined;
    console.log('  ✔ reclaim and escalate append task events only on success');
  }

  // Test 4: hook check appends a violation event with a payload lane
  {
    const dir = project([task('t1', { status: 'in_progress', targetFiles: ['src/a.ts'] })]);
    const payload = {
      session_id: 'sess1', agent_id: 'ag1', agent_type: 'worker', cwd: dir,
      tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'other.ts') },
    };
    let out = '';
    await runHookCheck(dir, {
      input: Readable.from([JSON.stringify(payload)]),
      output: (t) => { out += t; },
      mode: 'warn',
    });
    const v = kinds(dir, 'violation');
    assert.equal(v.length, 1);
    assert.equal(v[0].src, 'hook');
    assert.equal(v[0].lane.id, 's:sess1/a:ag1');
    assert.equal(v[0].lane.role, 'worker');
    assert.equal(v[0].data.tool, 'Edit');
    assert.equal(v[0].data.mode, 'warn');
    assert.equal(v[0].data.path, 'src/other.ts');
    assert.ok(out.length > 0, 'the hook decision is still printed');
    console.log('  ✔ hook check appends a violation event with the payload lane');
  }

  // Test 5: secrets in the agent id, session, agent type and path never reach the log
  {
    const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    const dir = project([
      task('t1', { status: 'in_progress' }),
      task('t2', { status: 'in_progress', targetFiles: ['src/a.ts'] }),
    ]);
    process.env.NATIV_AGENT_ID = KEY;
    try {
      await quiet(() => runTaskBlock('t1', 'r', dir));
    } finally {
      process.env.NATIV_AGENT_ID = 'agent-x';
    }
    assert.equal(kinds(dir, 'task').length, 1);
    assert.ok(!JSON.stringify(events(dir)).includes(KEY), 'secret agent id is not logged');
    assert.equal('by' in kinds(dir, 'task')[0].data, false);

    const payload = {
      session_id: KEY, agent_id: KEY, agent_type: 'worker', cwd: dir,
      tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', `${KEY}.ts`) },
    };
    const run = async () => {
      let out = '';
      await runHookCheck(dir, {
        input: Readable.from([JSON.stringify(payload)]),
        output: (t) => { out += t; },
        mode: 'warn',
      });
      return out;
    };
    const withEvent = await run();
assert.ok(kinds(dir, 'violation').length >= 1, 'the violation is still recorded');
    assert.ok(!JSON.stringify(events(dir)).includes(KEY), 'secrets in the payload are not logged');

    // A runner run writes no violation event, and the hook output is unchanged.
    const before = events(dir).length;
    process.env.NATIV_RUN_ID = 'run-1';
    let skipped;
    try {
      skipped = await run();
    } finally {
      delete process.env.NATIV_RUN_ID;
    }
    assert.equal(events(dir).length, before, 'NATIV_RUN_ID appends no violation event');
    assert.equal(skipped, withEvent, 'the hook output does not change');
    console.log('  ✔ secrets are dropped from events; a runner run appends no violation event');
  }

  console.log('\n✔ All task, gate and violation event tests passed');
} finally {
  if (savedAgent === undefined) delete process.env.NATIV_AGENT_ID;
  else process.env.NATIV_AGENT_ID = savedAgent;
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
