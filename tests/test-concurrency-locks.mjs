import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

console.log('--- Starting Multi-Agent Concurrency & File Lock Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');

function createConcurrentFixture(taskCount = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-concurrency-test-'));
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });

  const tasks = [];
  for (let i = 1; i <= taskCount; i++) {
    const id = `task-${String(i).padStart(2, '0')}`;
    tasks.push({
      id,
      title: `Concurrent Task ${id}`,
      description: `Description for ${id}`,
      assignedSubagent: i % 2 === 0 ? 'frontend' : 'backend',
      dependencies: [],
      targetFiles: [`file-${id}.js`],
      status: 'pending',
      verificationCommand: 'none',
      notes: '',
    });
  }

  const plan = {
    version: '1.0.0',
    projectName: 'concurrency-fixture',
    overallStatus: 'pending',
    activeMilestoneId: 'm1',
    lastUpdated: new Date().toISOString(),
    milestones: [
      {
        id: 'm1',
        name: 'Concurrent Execution Milestone',
        status: 'pending',
        tasks,
      },
    ],
  };

  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  return { dir, aiDir, planPath: path.join(aiDir, 'master_plan.json') };
}

function readPlan(planPath) {
  return JSON.parse(fs.readFileSync(planPath, 'utf8'));
}

async function cli(args) {
  try {
    return await execFileAsync(process.execPath, [cliPath, ...args], { timeout: 30000 });
  } catch (err) {
    console.error(`CLI ERROR on [${args.join(' ')}]: code=${err.code}\nstderr: ${err.stderr}\nstdout: ${err.stdout}`);
    throw err;
  }
}

// ── Test 1: High-Concurrency Parallel `task start` ─────────────────────────
console.log('1. Testing Parallel `task start` across 10 concurrent processes...');
const fixture1 = createConcurrentFixture(10);

const startPromises = [];
for (let i = 1; i <= 10; i++) {
  const taskId = `task-${String(i).padStart(2, '0')}`;
  startPromises.push(cli(['task', 'start', taskId, fixture1.dir]));
}

const startResults = await Promise.all(startPromises);
assert.equal(startResults.length, 10, 'All 10 start commands must finish');

const planAfterStart = readPlan(fixture1.planPath);
for (const t of planAfterStart.milestones[0].tasks) {
  assert.equal(
    t.status,
    'in_progress',
    `Task [${t.id}] must be 'in_progress', found '${t.status}'. No lost updates!`
  );
}
assert.equal(planAfterStart.overallStatus, 'in_progress', 'Overall plan status should be in_progress');
console.log('✔ Parallel `task start`: 10/10 tasks atomically updated with zero lost updates.');

// ── Test 2: High-Concurrency Parallel `task complete` ──────────────────────
console.log('2. Testing Parallel `task complete` across 10 concurrent processes...');
const completePromises = [];
for (let i = 1; i <= 10; i++) {
  const taskId = `task-${String(i).padStart(2, '0')}`;
  completePromises.push(cli(['task', 'complete', taskId, fixture1.dir, '--no-verify']));
}

const completeResults = await Promise.all(completePromises);
assert.equal(completeResults.length, 10, 'All 10 complete commands must finish');

const planAfterComplete = readPlan(fixture1.planPath);
for (const t of planAfterComplete.milestones[0].tasks) {
  assert.equal(
    t.status,
    'completed',
    `Task [${t.id}] must be 'completed', found '${t.status}'`
  );
}
assert.equal(planAfterComplete.milestones[0].status, 'completed', 'Milestone should be completed');
assert.equal(planAfterComplete.overallStatus, 'completed', 'Overall plan status should be completed');
console.log('✔ Parallel `task complete`: 10/10 tasks completed and milestone marked done without race conditions.');

// ── Test 3: High-Concurrency Parallel `task add` (Unique ID Allocation) ────
console.log('3. Testing Parallel `task add` across 8 concurrent processes...');
const fixture2 = createConcurrentFixture(0); // empty milestone

const addPromises = [];
for (let i = 1; i <= 8; i++) {
  addPromises.push(
    cli(['task', 'add', `Dynamic Worker Task ${i}`, fixture2.dir, '--json', '--agent', 'backend'])
  );
}

const addResults = await Promise.all(addPromises);
assert.equal(addResults.length, 8, 'All 8 add commands must finish');

const addedIds = addResults.map((r) => JSON.parse(r.stdout).task.id);
const uniqueIds = new Set(addedIds);
assert.equal(
  uniqueIds.size,
  8,
  `Expected 8 unique task IDs, but got ${uniqueIds.size}: ${addedIds.join(', ')}`
);

const planAfterAdd = readPlan(fixture2.planPath);
assert.equal(
  planAfterAdd.milestones[0].tasks.length,
  8,
  'All 8 dynamically added tasks must be persisted in master_plan.json'
);
console.log(`✔ Parallel \`task add\`: 8 unique tasks added [${addedIds.join(', ')}] with zero ID collisions.`);

// ── Test 4: Mixed Concurrent Operations (Start, Block, Complete, Add) ──────
console.log('4. Testing Mixed Parallel Operations (Start, Block, Add simultaneously)...');
const fixture3 = createConcurrentFixture(6);

const mixedOps = [
  cli(['task', 'start', 'task-01', fixture3.dir]),
  cli(['task', 'block', 'task-02', fixture3.dir, '--reason', 'Waiting on API key']),
  cli(['task', 'complete', 'task-03', fixture3.dir, '--no-verify']),
  cli(['task', 'add', 'Fast Add Task', fixture3.dir, '--fast-path', '--json']),
  cli(['task', 'start', 'task-04', fixture3.dir]),
];

await Promise.all(mixedOps);

const planAfterMixed = readPlan(fixture3.planPath);
const t1 = planAfterMixed.milestones[0].tasks.find((t) => t.id === 'task-01');
const t2 = planAfterMixed.milestones[0].tasks.find((t) => t.id === 'task-02');
const t3 = planAfterMixed.milestones[0].tasks.find((t) => t.id === 'task-03');
const t4 = planAfterMixed.milestones[0].tasks.find((t) => t.id === 'task-04');

assert.equal(t1.status, 'in_progress', 'task-01 should be in_progress');
assert.equal(t2.status, 'blocked', 'task-02 should be blocked');
assert.equal(t2.notes, 'Waiting on API key', 'task-02 notes should be recorded');
assert.equal(t3.status, 'completed', 'task-03 should be completed');
assert.equal(t4.status, 'in_progress', 'task-04 should be in_progress');

console.log('✔ Mixed Parallel Operations: Start, Block, Complete, and Add executed flawlessly.');

console.log('\n🎉 ALL MULTI-AGENT CONCURRENCY & LOCK TESTS PASSED!\n');
