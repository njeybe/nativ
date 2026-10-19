import assert from 'node:assert/strict';
import { createStudio, loadModel, run, NOW } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-status-words.mjs`.
console.log('--- Studio status words ---');
const ctx = createStudio();
const ev = (code) => JSON.parse(JSON.stringify(run(ctx, `(function(){return ${code}})()`)));

assert.deepEqual(ev('Studio.status.buckets.map(function(b){return b[1]})'), ['Up next', 'Running', 'Done', 'Stuck']);
const b = (s, x = '') => ev(`Studio.status.bucket({status:'${s}'${x}})`);
assert.equal(b('completed'), 'done');
assert.equal(b('in_progress'), 'running');
assert.equal(b('in_progress', ',stale:true'), 'next');
assert.equal(b('blocked'), 'stuck');
assert.equal(b('pending'), 'next');
const rb = { spawning_worktree: 'running', running: 'running', verifying: 'running', merging: 'running',
  completed: 'done', failed: 'stuck', aborted: 'next' };
for (const [k, v] of Object.entries(rb)) assert.equal(ev(`Studio.status.runBucket({status:'${k}'})`), v);
assert.equal(ev('Studio.status.runBucket(null)'), null);
assert.equal(ev("Studio.status.word('stuck')"), 'Stuck');
assert.equal(ev("Studio.status.word('completed')"), 'Done');
assert.equal(ev("Studio.status.word('in_progress')"), 'Running');
assert.equal(ev("Studio.statusLabel('pending')"), 'Up next');

const ready = (x) => ev(`Studio.status.isReady({status:'pending',${x}})`);
assert.equal(ready('isAvailable:true,waitingOn:["a"]'), true);
assert.equal(ready('waitingOn:[]'), true);
assert.equal(ready('waitingOn:["a"]'), false);
assert.equal(ev("Studio.status.isReady({status:'blocked',waitingOn:[]})"), false);

const w = (x) => ev(`Studio.status.waitText({status:'pending',${x}})`);
assert.equal(w('waitingOn:["a"]'), 'Waits for 1 task');
assert.equal(w('waitingOn:["a","b"]'), 'Waits for 2 tasks');
assert.equal(w('waitingOn:[]'), '');
assert.equal(ev("Studio.status.waitText({status:'completed',waitingOn:['a']})"), '');

const t = (id, over) => ({ id, title: id, status: 'in_progress', assignedSubagent: 'backend', dependencies: [],
  isAvailable: false, ...over });
const old = new Date(NOW - 5 * 3600e3).toISOString();
const fresh = new Date(NOW - 3600e3).toISOString();
const model = loadModel(ctx, {
  milestones: [{ id: 'm1', name: 'One: x', tasks: [t('a', { claimedAt: old }), t('b', { claimedAt: fresh }),
    t('c', { claimedAt: old }), t('d', { status: 'pending' })] },
  { id: 'm2', name: 'Two', tasks: [t('e', { status: 'completed' })] }],
  runs: [{ taskId: 'c', status: 'running' }],
});
assert.equal(model.byId.a.stale, true);
assert.equal(model.byId.b.stale, false);
assert.equal(model.byId.c.stale, false);
assert.deepEqual([...model.running.map((x) => x.id)], ['b', 'c']);

ctx.Studio.state.milestoneId = 'm1';
const html = run(ctx, 'Studio.ui.milestoneSelect()');
assert.ok(html.includes('>m1 One (0/4, active)<'));
assert.ok(html.includes('>m2 Two (1/1)<'));
assert.ok(!html.includes('·'));
console.log('ok');
