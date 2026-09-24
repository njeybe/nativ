import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting Contract Governor Invariant Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const execFileAsync = promisify(execFile);
const tempDirs = [];

function createProjectFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-governor-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });

  const dbSchema = {
    version: '1.0.0',
    projectName: 'governor-test',
    updatedAt: new Date().toISOString(),
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'UUID', primaryKey: true, nullable: false },
          { name: 'email', type: 'VARCHAR(255)', nullable: false },
        ],
        indexes: [],
        foreignKeys: [],
      },
    ],
  };

  const apiContracts = {
    version: '1.0.0',
    projectName: 'governor-test',
    updatedAt: new Date().toISOString(),
    endpoints: [
      {
        id: 'user-profile',
        path: '/profile',
        method: 'GET',
        auth: true,
        request: { queryParams: {}, headers: {}, body: null },
        responses: {
          '200': { description: 'User profile', body: { id: 'string', email: 'string' } },
        },
      },
    ],
  };

  const masterPlan = {
    version: '1.0.0',
    projectName: 'governor-test',
    lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress',
    activeMilestoneId: 'm1',
    milestones: [
      {
        id: 'm1',
        name: 'Core Features',
        status: 'in_progress',
        tasks: [
          {
            id: 'task-01',
            title: 'User Preferences Migration',
            description: 'Add preferences column',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'in_progress',
            verificationCommand: '',
            notes: '',
          },
          {
            id: 'task-02',
            title: 'Budget Test Task',
            description: 'Test patch budgeting',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'in_progress',
            verificationCommand: '',
            notes: '',
          },
          ...['task-03', 'task-04', 'task-05'].map((id) => ({
            id,
            title: `Parallel ${id}`,
            description: 'Concurrent failure accounting',
            assignedSubagent: 'backend',
            dependencies: [],
            targetFiles: [],
            status: 'in_progress',
            verificationCommand: '',
            notes: '',
          })),
        ],
      },
    ],
  };

  fs.writeFileSync(path.join(dir, '.ai', 'db_schema.json'), JSON.stringify(dbSchema, null, 2));
  fs.writeFileSync(path.join(dir, '.ai', 'api_contracts.json'), JSON.stringify(apiContracts, null, 2));
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(masterPlan, null, 2));

  return dir;
}

async function cli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { timeout: 60000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

try {
  const dir = createProjectFixture();

  // Test 1: Additive DB Schema Approval (ADD nullable column)
  console.log('1. Testing Additive DB Schema Approval (ADD nullable column)...');
  const res1 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'db_schema',
    '--op',
    'ADD',
    '--path',
    'users.columns.bio',
    '--value',
    JSON.stringify({ name: 'bio', type: 'TEXT', nullable: true }),
    '--reason',
    'User biography field',
    '--json',
  ]);
  assert.equal(res1.code, 0, `Expected exit 0, got: ${res1.stderr}`);
  const verdict1 = JSON.parse(res1.stdout);
  assert.equal(verdict1.approved, true);
  assert.equal(verdict1.blastRadius, 'LOW_ADDITIVE');
  assert.equal(verdict1.patchApplied, true);

  // Verify file was mutated
  const updatedDb = JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'db_schema.json'), 'utf8'));
  const userTable = updatedDb.tables.find((t) => t.name === 'users');
  assert.ok(userTable.columns.some((c) => c.name === 'bio'), 'Expected column bio in users table');
  console.log('✔ Additive DB Schema approved and automatically merged.');

  // Test 2: Destructive DB Schema Rejection (DROP column)
  console.log('2. Testing Destructive DB Schema Rejection (DROP column)...');
  const res2 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'db_schema',
    '--op',
    'DROP',
    '--path',
    'users.columns.email',
    '--reason',
    'Dropping email column',
    '--json',
  ]);
  assert.equal(res2.code, 1, 'Expected rejection exit code 1');
  const verdict2 = JSON.parse(res2.stdout);
  assert.equal(verdict2.approved, false);
  assert.equal(verdict2.blastRadius, 'HIGH_DESTRUCTIVE');
  assert.equal(verdict2.patchApplied, false);
  console.log('✔ Destructive DB mutation correctly rejected.');

  // Test 3: Path Collision Check (ADD existing column)
  console.log('3. Testing Path Collision Invariant (ADD on existing column)...');
  const res3 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'db_schema',
    '--op',
    'ADD',
    '--path',
    'users.columns.email',
    '--value',
    JSON.stringify({ name: 'email', type: 'TEXT', nullable: true }),
    '--reason',
    'Collision attempt',
    '--json',
  ]);
  assert.equal(res3.code, 1);
  const verdict3 = JSON.parse(res3.stdout);
  assert.equal(verdict3.approved, false);
  assert.ok(verdict3.violations.some((v) => v.includes('PATH_COLLISION')), 'Expected PATH_COLLISION violation');
  console.log('✔ Path collision prevented.');

  // Test 4: Additive API Contract Approval (ADD optional query param)
  console.log('4. Testing Additive API Contract Approval...');
  const res4 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'api_contracts',
    '--op',
    'ADD',
    '--path',
    'endpoints.user-profile.queryParams.include_avatar',
    '--value',
    'boolean (optional)',
    '--reason',
    'Include avatar in profile',
    '--json',
  ]);
  assert.equal(res4.code, 0);
  const verdict4 = JSON.parse(res4.stdout);
  assert.equal(verdict4.approved, true);
  assert.equal(verdict4.blastRadius, 'LOW_ADDITIVE');
  assert.equal(verdict4.patchApplied, true);
  console.log('✔ Additive API modification approved.');

  // Test 5: Destructive API Contract Rejection (DROP endpoint)
  console.log('5. Testing Destructive API Contract Rejection (DROP endpoint)...');
  const res5 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'api_contracts',
    '--op',
    'DROP',
    '--path',
    'endpoints.user-profile',
    '--reason',
    'Remove profile route',
    '--json',
  ]);
  assert.equal(res5.code, 1);
  const verdict5 = JSON.parse(res5.stdout);
  assert.equal(verdict5.approved, false);
  assert.equal(verdict5.blastRadius, 'HIGH_DESTRUCTIVE');
  console.log('✔ Destructive API route drop rejected.');

  // Test 6: Orphaned Foreign Key Rejection
  console.log('6. Testing Referential Integrity DAG (Orphaned Foreign Key)...');
  const res6 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'db_schema',
    '--op',
    'ADD',
    '--path',
    'users.foreignKeys.role_id',
    '--value',
    JSON.stringify({ targetTable: 'non_existent_roles', targetColumn: 'id' }),
    '--reason',
    'Link to roles table',
    '--json',
  ]);
  assert.equal(res6.code, 1);
  const verdict6 = JSON.parse(res6.stdout);
  assert.equal(verdict6.approved, false);
  assert.ok(verdict6.violations.some((v) => v.includes('ORPHANED_FOREIGN_KEY')), 'Expected ORPHANED_FOREIGN_KEY');
  console.log('✔ Orphaned foreign key rejected.');

  // Test 7: Circuit Breaker Tripping & Flight Recorder
  console.log('7. Testing 3-Strike Circuit Breaker Tripping & Escalation...');
  // task-01 currently has 2 consecutive failures (tests 5 and 6). Trigger the 3rd strike:
  const res7 = await cli([
    'task',
    'propose-patch',
    'task-01',
    dir,
    '--target',
    'db_schema',
    '--op',
    'DROP',
    '--path',
    'users.columns.bio',
    '--reason',
    'Another destructive drop triggering 3rd strike',
    '--json',
  ]);
  assert.equal(res7.code, 1);
  const verdict7 = JSON.parse(res7.stdout);
  assert.equal(verdict7.circuitBreaker.tripped, true, 'Circuit breaker should have tripped after 3 consecutive failures');
  assert.ok(verdict7.diagnosticBundle, 'Expected diagnosticBundle in verdict when breaker is tripped');

  // Verify task was marked as blocked in .ai/master_plan.json
  const updatedPlan = JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));
  const task01 = updatedPlan.milestones[0].tasks.find((t) => t.id === 'task-01');
  assert.equal(task01.status, 'blocked', 'Task should be transitioned to blocked');

  // Verify .ai/escalation.json has record
  const escalationPath = path.join(dir, '.ai', 'escalation.json');
  assert.ok(fs.existsSync(escalationPath), 'Expected .ai/escalation.json to exist');
  const escalations = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
  assert.ok(escalations.escalations.length > 0, 'Expected at least 1 escalation record');
  console.log('✔ Circuit breaker tripped and diagnostic flight recorder logged escalation.');

  // Test 8: Patch Budget Cap
  console.log('8. Testing Task Patch Budget Cap (Max 3 patches)...');
  for (let i = 1; i <= 3; i++) {
    const pRes = await cli([
      'task',
      'propose-patch',
      'task-02',
      dir,
      '--target',
      'db_schema',
      '--op',
      'ADD',
      '--path',
      `users.columns.field_${i}`,
      '--value',
      JSON.stringify({ name: `field_${i}`, type: 'TEXT', nullable: true }),
      '--reason',
      `Field ${i}`,
      '--json',
    ]);
    assert.equal(pRes.code, 0, `Patch ${i} should be approved`);
  }
  // 4th patch should exceed budget
  const pRes4 = await cli([
    'task',
    'propose-patch',
    'task-02',
    dir,
    '--target',
    'db_schema',
    '--op',
    'ADD',
    '--path',
    'users.columns.field_4',
    '--value',
    JSON.stringify({ name: 'field_4', type: 'TEXT', nullable: true }),
    '--reason',
    'Field 4 exceeds budget',
    '--json',
  ]);
  assert.equal(pRes4.code, 1);
  const v4 = JSON.parse(pRes4.stdout);
  assert.equal(v4.ruleId, 'TASK_PATCH_BUDGET_EXCEEDED');
  console.log('✔ Patch budget cap correctly halts scope creep.');

  // Test 9: Parallel failures are all counted and escalate once, with unique ids
  console.log('9. Testing concurrent failures across agents (ledger + escalation locking)...');
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', file), 'utf8'));
  const escalationsBefore = readJson('escalation.json').escalations.length;
  const drop = (taskId) =>
    cli(['task', 'propose-patch', taskId, dir, '--target', 'db_schema', '--op', 'DROP', '--path', 'users.columns.email', '--reason', `parallel ${taskId}`, '--json']);
  // Six agents fail at the same moment: three on each task. Unlocked writes lose counts and ids collide.
  const parallel = await Promise.all([...Array(3)].flatMap(() => [drop('task-03'), drop('task-04')]));
  assert.ok(parallel.every((r) => r.code === 1), 'every destructive proposal is rejected');
  const ledger = readJson('.governor_ledger.json');
  assert.equal(ledger['task-03'].consecutiveFailures, 3, 'no concurrent failure may be lost from the ledger');
  assert.equal(ledger['task-04'].consecutiveFailures, 3, 'no concurrent failure may be lost from the ledger');
  const allEscalations = readJson('escalation.json').escalations;
  const tripped = allEscalations.filter((e) => e.taskId === 'task-03' || e.taskId === 'task-04');
  assert.equal(allEscalations.length, escalationsBefore + 2, 'each task escalates exactly once, and neither write is lost');
  assert.deepEqual(tripped.map((e) => e.taskId).sort(), ['task-03', 'task-04']);
  const ids = allEscalations.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `escalation ids must be unique: ${ids.join(', ')}`);
  const plan9 = readJson('master_plan.json');
  for (const id of ['task-03', 'task-04']) {
    assert.equal(plan9.milestones[0].tasks.find((t) => t.id === id).status, 'blocked');
  }

  // A fourth failure after the trip is counted but does not file another escalation.
  const again = await drop('task-03');
  assert.equal(JSON.parse(again.stdout).circuitBreaker.consecutiveFailures, 4);
  assert.equal(readJson('escalation.json').escalations.length, escalationsBefore + 2, 'a tripped breaker does not re-escalate on every failure');
  console.log('✔ Six concurrent failures were all counted; each task escalated once with a unique id.');

  // Test 10: Manual escalations keep sequential ids that never collide
  console.log('10. Testing manual escalation ids...');
  const esc1 = await cli(['task', 'escalate', 'task-05', dir, '--type', 'schema_flaw', '--details', 'first gap']);
  const esc2 = await cli(['task', 'escalate', 'task-05', dir, '--type', 'schema_flaw', '--details', 'second gap']);
  assert.equal(esc1.code, 0, esc1.stderr);
  assert.equal(esc2.code, 0, esc2.stderr);
  const manual = readJson('escalation.json').escalations.filter((e) => e.taskId === 'task-05');
  assert.deepEqual(manual.map((e) => e.id), ['esc-01', 'esc-02'], 'manual escalations are numbered esc-01, esc-02, ...');
  const allIds = readJson('escalation.json').escalations.map((e) => e.id);
  assert.equal(new Set(allIds).size, allIds.length, 'manual and circuit-breaker ids never collide');
  console.log('✔ Manual escalations are numbered sequentially without colliding with breaker ids.');

  console.log('\n🎉 ALL CONTRACT GOVERNOR INVARIANT TESTS PASSED!');
} finally {
  for (const d of tempDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
