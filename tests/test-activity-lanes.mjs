import assert from 'node:assert/strict';
import { foldLanes, eventText } from '../dist/core/activity/lanes.js';

console.log('--- Activity lane fold ---');

const T0 = Date.parse('2026-01-02T10:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const NOW = T0 + 30 * 60000;
const opts = { windowMinutes: 60 };

const task = (id, status, targetFiles = []) => ({
  id, title: `Title ${id}`, description: '', assignedSubagent: 'backend', dependencies: [],
  targetFiles, status, verificationCommand: 'true',
});
const planOf = (tasks) => ({
  version: '1', projectName: 'p', lastUpdated: iso(0), overallStatus: 'in_progress',
  activeMilestoneId: 'm1', milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks }],
});
const ev = (min, lane, kind, data, extra = {}) => ({ v: 1, at: iso(min), src: 'hook', lane, kind, data, ...extra });

const runLane = { id: 'run:r1', runId: 'r1', role: 'backend' };
const main = { id: 's:s1', session: 's1', role: 'main' };
const w1 = { id: 's:s1/a:a1', session: 's1', agent: 'a1', agentType: 'worker', role: 'worker' };
const w2 = { id: 's:s1/a:a2', session: 's1', agent: 'a2', agentType: 'worker', role: 'worker' };
const other = { id: 's:s2', session: 's2', role: 'main' };
const cmd = (id) => ({ id, via: 'command' });
const wt = (id) => ({ id, via: 'worktree' });
const usage = (n) => ({ runId: 'r1', model: 'opus', turns: 1, input: n, output: n, cacheRead: 0, cacheCreation: 0 });
const tokens = { input: 10, output: 5, cacheRead: 2, cacheCreation: 1 };

// Scenario: runner run, main session, two parallel workers, unattributed lane.
const plan = planOf([task('task-1', 'in_progress', ['src/a.ts']), task('task-2', 'in_progress', ['src/b.ts']),
  task('task-3', 'pending')]);
const events = [
  ev(1, runLane, 'run', { runId: 'r1', status: 'running', engine: 'native', model: 'sonnet' },
    { src: 'runner', task: { id: 'task-3', via: 'env' } }),
  ev(2, runLane, 'usage', usage(100), { src: 'runner' }),
  ev(3, runLane, 'usage', usage(50), { src: 'runner' }),
  ev(5, main, 'tool', { name: 'Agent', ok: true, spawn: { agentType: 'worker', model: 'opus' } }),
  ev(5.5, main, 'tool', { name: 'Agent', ok: true, spawn: { agentType: 'worker', model: 'haiku' } }),
  ev(6, w1, 'agent', { phase: 'start' }),
  ev(6.5, w2, 'agent', { phase: 'start' }),
  ev(7, w1, 'tool', { name: 'Bash', ok: true, nativ: 'task start', taskId: 'task-1' }, { task: cmd('task-1') }),
  ev(8, w1, 'tool', { name: 'Edit', ok: true, path: 'src/a.ts', added: 3, removed: 1 }, { task: cmd('task-1') }),
  ev(9, w1, 'tool', { name: 'Edit', ok: true, path: 'src/a.ts', added: 2, removed: 0 }, { task: cmd('task-1') }),
  ev(10, w2, 'tool', { name: 'Write', ok: false, path: 'src/b.ts', added: 4, removed: 0 }, { task: wt('task-2') }),
  ev(11, w1, 'agent', { phase: 'stop', tokens, models: ['opus'] }),
  ev(12, other, 'tool', { name: 'Bash', ok: true, program: 'ls' }),
];
const lanes = foldLanes(events, plan, NOW, opts);
const byId = Object.fromEntries(lanes.map((l) => [l.id, l]));

assert.deepEqual(byId['run:r1'], {
  id: 'run:r1', label: 'runner', kind: 'runner', role: 'backend', model: 'opus', status: 'active',
  startedAt: iso(1), lastAt: iso(3), elapsedMs: 29 * 60000,
  task: { id: 'task-3', via: 'env', title: 'Title task-3' }, last: { at: iso(1), text: 'run running' },
  files: { count: 0, source: 'events', top: [] },
  tokens: { input: 150, output: 150, cacheRead: 0, cacheCreation: 0, total: 300 }, runId: 'r1', sessionId: null,
});
assert.deepEqual(byId['s:s1'], {
  id: 's:s1', label: 'main session', kind: 'main', role: 'main', model: null, status: 'idle',
  startedAt: iso(5), lastAt: iso(5.5), elapsedMs: 30000, task: null,
  last: { at: iso(5.5), text: 'Agent worker' }, files: { count: 0, source: 'events', top: [] },
  tokens: null, runId: null, sessionId: 's1',
});
assert.deepEqual(byId['s:s1/a:a1'], {
  id: 's:s1/a:a1', label: 'worker', kind: 'subagent', role: 'worker', model: 'opus', status: 'stopped',
  startedAt: iso(6), lastAt: iso(11), elapsedMs: 5 * 60000,
  task: { id: 'task-1', via: 'command', title: 'Title task-1' }, last: { at: iso(11), text: 'agent stop' },
  files: { count: 1, source: 'events', top: [{ path: 'src/a.ts', added: 5, removed: 1 }] },
  tokens: { ...tokens, total: 18 }, runId: null, sessionId: 's1',
});
assert.deepEqual(byId['s:s1/a:a2'], {
  id: 's:s1/a:a2', label: 'worker', kind: 'subagent', role: 'worker', model: 'haiku', status: 'idle',
  startedAt: iso(6.5), lastAt: iso(10), elapsedMs: 3.5 * 60000,
  task: { id: 'task-2', via: 'worktree', title: 'Title task-2' },
  last: { at: iso(10), text: 'Write src/b.ts +4 -0 failed' },
  files: { count: 1, source: 'events', top: [{ path: 'src/b.ts', added: 4, removed: 0 }] },
  tokens: null, runId: null, sessionId: 's1',
});
assert.equal(byId['s:s2'].task, null);
assert.equal(byId['s:s2'].last.text, 'Bash ls');
console.log('  ok exact lanes for runner, main, two workers, unattributed');

// Ordering: active first, then newest lastAt.
assert.deepEqual(lanes.map((l) => l.id), ['run:r1', 's:s2', 's:s1/a:a1', 's:s1/a:a2', 's:s1']);
console.log('  ok ordering');

// Rule 2: a cli verify event joins the worker lane holding its task.
{
  const cli = { id: 'cli:terminal' };
  const evs = [
    ev(1, w1, 'tool', { name: 'Bash', ok: true, nativ: 'task start', taskId: 'task-1' }, { task: cmd('task-1') }),
    ev(2, cli, 'verify', { pass: false, durationMs: 5, failedPhase: 'test' }, { src: 'cli', task: cmd('task-1') }),
    ev(3, cli, 'task', { action: 'start' }, { src: 'cli', task: cmd('task-9') }),
  ];
  const out = foldLanes(evs, plan, NOW, opts);
  const w = out.find((l) => l.id === w1.id);
  assert.deepEqual(w.last, { at: iso(2), text: 'verify failed (test)' });
  const c = out.find((l) => l.id === 'cli:terminal');
  assert.equal(c.label, 'terminal');
  assert.equal(c.role, null);
  assert.equal(c.task.id, 'task-9');
  assert.equal(c.last.text, 'task start');
  console.log('  ok cli verify joins holder lane');
}

// Rule 3: a worker with no task takes the only in_progress task.
{
  const one = planOf([task('task-1', 'in_progress'), task('task-2', 'pending')]);
  const out = foldLanes([ev(1, w1, 'tool', { name: 'Read', ok: true, path: 'x.md' })], one, NOW, opts);
  assert.deepEqual(out[0].task, { id: 'task-1', via: 'only', title: 'Title task-1' });
  const none = foldLanes([ev(1, w1, 'tool', { name: 'Read', ok: true, path: 'x.md' })], plan, NOW, opts);
  assert.equal(none[0].task, null);
  console.log('  ok via only');
}

// Rule 4: a write matching exactly one task's targetFiles names it; two candidates give none.
{
  const write = (lane, p) => ev(1, lane, 'tool', { name: 'Write', ok: true, path: p, added: 1, removed: 0 });
  const out = foldLanes([write(main, 'src/b.ts')], plan, NOW, opts);
  assert.deepEqual(out[0].task, { id: 'task-2', via: 'scope', title: 'Title task-2' });
  const both = planOf([task('task-1', 'in_progress', ['src/b.ts']), task('task-2', 'in_progress', ['src/b.ts'])]);
  assert.equal(foldLanes([write(main, 'src/b.ts')], both, NOW, opts)[0].task, null);
  const split = foldLanes([write(main, 'src/a.ts'), write(main, 'src/b.ts')], plan, NOW, opts);
  assert.equal(split[0].task, null);
  console.log('  ok via scope and no guessing');
}

// Status rules.
{
  const run = (status) => ev(1, runLane, 'run', { runId: 'r1', status, engine: 'native' }, { src: 'runner' });
  const st = (evs, now = NOW) => foldLanes(evs, plan, now, opts)[0].status;
  assert.equal(st([run('running'), run('failed')]), 'failed');
  assert.equal(st([run('completed')]), 'stopped');
  assert.equal(st([run('aborted')]), 'stopped');
  assert.equal(st([run('verifying')]), 'active');
  assert.equal(st([ev(1, main, 'tool', { name: 'Read', ok: true })], T0 + 2 * 60000), 'active');
  assert.equal(st([ev(1, main, 'tool', { name: 'Read', ok: true })], T0 + 3 * 60000), 'idle');
  assert.equal(st([ev(1, w1, 'agent', { phase: 'stop' })], T0 + 61000), 'stopped');
  const all = foldLanes(events, plan, NOW, opts).map((l) => l.status);
  assert.ok(!all.includes('paused'));
  console.log('  ok status rules');
}

// Tokens null when unknown; files from git when a task and git results exist.
{
  const evs = [ev(1, w1, 'tool', { name: 'Edit', ok: true, path: 'src/a.ts', added: 1, removed: 1 },
    { task: cmd('task-1') }), ev(2, w1, 'agent', { phase: 'stop' })];
  const noGit = foldLanes(evs, plan, NOW, opts)[0];
  assert.equal(noGit.tokens, null);
  assert.equal(noGit.files.source, 'events');
  const gitFiles = { 'task-1': [
    { path: 'a', added: 1, removed: 0, status: 'modified' }, { path: 'b', added: 9, removed: 1, status: 'added' },
    { path: 'c', added: 2, removed: 2, status: 'modified' }, { path: 'd', added: 0, removed: 3, status: 'deleted' },
  ] };
  const withGit = foldLanes(evs, plan, NOW, { ...opts, gitFiles })[0];
  assert.deepEqual(withGit.files, { count: 4, source: 'git', top: [
    { path: 'b', added: 9, removed: 1 }, { path: 'c', added: 2, removed: 2 }, { path: 'd', added: 0, removed: 3 },
  ] });
  assert.equal(foldLanes([ev(1, runLane, 'run', { runId: 'r1', status: 'running', engine: 'x' })],
    plan, NOW, opts)[0].tokens, null);
  console.log('  ok tokens and files');
}

// Window: old lanes drop, active runs stay.
{
  const evs = [
    ev(-120, runLane, 'run', { runId: 'r1', status: 'running', engine: 'x' }, { src: 'runner' }),
    ev(-120, main, 'tool', { name: 'Read', ok: true }),
    ev(20, other, 'tool', { name: 'Read', ok: true }),
  ];
  assert.deepEqual(foldLanes(evs, plan, NOW, opts).map((l) => l.id), ['run:r1', 's:s2']);
  console.log('  ok window filter');
}

// Text formats.
{
  const long = `src/${'x'.repeat(60)}.ts`;
  const text = eventText(ev(1, main, 'tool', { name: 'Edit', ok: true, path: long, added: 1, removed: 2 }));
  assert.equal(text, `Edit ...${long.slice(-48)} +1 -2`);
  assert.equal(eventText(ev(1, main, 'verify', { pass: true, durationMs: 1 })), 'verify passed');
  assert.equal(eventText(ev(1, main, 'usage', usage(1))), null);
  console.log('  ok text formats');
}

console.log('All lane fold tests passed.');
