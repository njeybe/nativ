import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting Dual-Track Task Router Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const { generateNextTaskId, generateNextMilestoneId } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'commands', 'task.js')).href);
const { validateMasterPlanTask } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'scanner', 'types.js')).href);

const execFileAsync = promisify(execFile);
const tempDirs = [];

function task(id, status = 'completed', extra = {}) {
  return { id, title: `Task ${id}`, description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [], status, verificationCommand: '', notes: '', ...extra };
}

function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-router-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  const plan = {
    version: '1.0.0',
    projectName: 'router-fixture',
    lastUpdated: new Date().toISOString(),
    overallStatus: 'in_progress',
    activeMilestoneId: 'm2',
    milestones: [
      { id: 'm1', name: 'Foundation Setup', status: 'completed', tasks: [task('task-01'), task('task-02')] },
      { id: 'm2', name: 'Payments Engine', status: 'in_progress', tasks: [task('task-03', 'in_progress'), task('task-04', 'pending', { dependencies: ['task-03'] })] },
      { id: 'm3', name: 'Payments Reporting', status: 'pending', tasks: [task('task-05', 'pending')] },
    ],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan, null, 2));
  return dir;
}

const readPlan = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));

async function cli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { timeout: 60000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

async function addJson(dir, title, flags = []) {
  const res = await cli(['task', 'add', title, dir, '--json', ...flags]);
  return { ...res, json: JSON.parse(res.stdout) };
}

function startMcp(projectDir) {
  const child = spawn(process.execPath, [cliPath, 'mcp', projectDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (c) => (stderr += c));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  return {
    notify: (method) => send({ jsonrpc: '2.0', method }),
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}. stderr:\n${stderr}`)), 20000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

let passed = 0;
const check = (label) => {
  passed++;
  console.log(`  ✔ ${label}`);
};

let mcp = null;

try {
  // 1. ID generation
  const planOf = (...ids) => ({ milestones: [{ id: 'm1', tasks: ids.map((id) => ({ id })) }] });
  assert.equal(generateNextTaskId(planOf('task-01', 'task-02')), 'task-03');
  assert.equal(generateNextTaskId(planOf('task-01', 'task-07', 'task-03')), 'task-08', 'continues after the highest, not the count');
  assert.equal(generateNextTaskId(planOf('task-99')), 'task-100');
  assert.equal(generateNextTaskId(planOf('task-001')), 'task-002', 'keeps existing zero-padding');
  assert.equal(generateNextTaskId(planOf('setup', 'auth-login')), 'task-01', 'non-numeric IDs start the sequence');
  assert.equal(generateNextTaskId({ milestones: [] }), 'task-01');
  assert.equal(generateNextMilestoneId({ milestones: [{ id: 'm1' }, { id: 'm9' }, { id: 'extra' }] }), 'm10');
  check('generateNextTaskId / generateNextMilestoneId continue the highest ID and keep padding');

  // 2. Schema validation
  assert.deepEqual(validateMasterPlanTask(task('task-01', 'pending', { fastPath: true })), []);
  assert.ok(validateMasterPlanTask(task('task-01', 'pending', { fastPath: 'yes' })).some((e) => e.includes('fastPath')));
  assert.ok(validateMasterPlanTask(task('task-01', 'done')).some((e) => e.includes('status')));
  assert.ok(validateMasterPlanTask({ ...task('task-01'), assignedSubagent: 'wizard' }).some((e) => e.includes('assignedSubagent')));
  check('validateMasterPlanTask accepts fastPath booleans and rejects malformed tasks');

  // 3. Planned track: active milestone, explicit milestone, reopening
  const dir = createProject();
  const planned = await addJson(dir, 'Add refund endpoint', ['-f', 'src/refunds.ts, src/routes.ts', '--deps', 'task-03', '-v', 'npm test', '-a', 'backend', '-d', 'Refund flow']);
  assert.equal(planned.code, 0, planned.stderr);
  assert.equal(planned.json.task.id, 'task-06');
  assert.equal(planned.json.milestoneId, 'm2', 'planned tasks go to the active milestone');
  assert.deepEqual(planned.json.task.targetFiles, ['src/refunds.ts', 'src/routes.ts']);
  assert.deepEqual(planned.json.task.dependencies, ['task-03']);
  assert.equal(planned.json.task.status, 'pending');
  assert.equal(planned.json.task.fastPath, undefined);
  const byName = await addJson(dir, 'Export CSV', ['-m', 'reporting']);
  assert.equal(byName.json.milestoneId, 'm3', 'milestone resolved by partial name');
  const reopened = await addJson(dir, 'Revisit setup', ['-m', 'm1']);
  assert.equal(reopened.json.reopenedMilestone, true);
  assert.equal(readPlan(dir).milestones[0].status, 'in_progress');
  check('planned track: active-milestone routing, milestone lookup by name, completed milestones reopen');

  // 4. Fast-path track: milestone created once, then appended
  const fast1 = await addJson(dir, 'Fix README typo', ['--fast-path', '-a', 'frontend', '-f', 'README.md', '-v', 'node -e "process.exit(0)"']);
  assert.equal(fast1.json.task.id, 'task-09');
  assert.equal(fast1.json.createdMilestone, true);
  assert.equal(fast1.json.milestoneId, 'm4');
  assert.equal(fast1.json.task.fastPath, true);
  const fast2 = await addJson(dir, 'Bump dependency', ['--fast-path', '-v', 'node -e "process.exit(3)"']);
  assert.equal(fast2.json.createdMilestone, false);
  assert.equal(fast2.json.milestoneId, 'm4');
  const plan = readPlan(dir);
  assert.equal(plan.milestones.filter((m) => m.fastPath).length, 1, 'exactly one fast-path milestone');
  assert.deepEqual(plan.milestones.at(-1).tasks.map((t) => t.id), ['task-09', 'task-10']);
  assert.equal(plan.activeMilestoneId, 'm2', 'fast-path tasks do not hijack the active planned milestone');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.ai')).filter((f) => f.endsWith('.tmp')), [], 'atomic save leaves no temp files');
  for (const t of plan.milestones.flatMap((m) => m.tasks)) assert.deepEqual(validateMasterPlanTask(t), []);
  check('fast-path track: milestone created on first use, later tasks appended, plan stays valid');

  // 5. Error handling leaves the plan untouched
  const before = fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8');
  for (const [flags, code] of [
    [['-a', 'wizard'], 'INVALID_AGENT'],
    [['--deps', 'task-404'], 'UNKNOWN_DEPENDENCY'],
    [['-m', 'm99'], 'UNKNOWN_MILESTONE'],
    [['-m', 'payments'], 'AMBIGUOUS_MILESTONE'],
  ]) {
    const res = await addJson(dir, 'Should fail', flags);
    assert.equal(res.code, 1, `${code} must exit 1`);
    assert.equal(res.json.error.code, code);
  }
  assert.equal((await cli(['task', 'add', '   ', dir, '--json'])).code, 1, 'blank title rejected');
  assert.equal(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'), before, 'failed adds do not write the plan');
  check('invalid agent, unknown dependency/milestone, ambiguous milestone and blank title fail without writing');

  // 6. CLI --fast-path filtering
  const listed = JSON.parse((await cli(['task', 'list', dir, '--fast-path', '--json'])).stdout);
  assert.deepEqual(listed.map((t) => t.id), ['task-09', 'task-10']);
  assert.ok(listed.every((t) => t.fastPath === true && t.milestoneId === 'm4'));
  const alias = JSON.parse((await cli(['tasks', dir, '--fast-path', '--json'])).stdout);
  assert.deepEqual(alias.map((t) => t.id), ['task-09', 'task-10']);
  const text = (await cli(['tasks', dir, '--fast-path'])).stdout;
  assert.match(text, /\[fast path\]/);
  assert.doesNotMatch(text, /task-06/);
  const all = JSON.parse((await cli(['task', 'list', dir, '--json'])).stdout);
  assert.equal(all.length, 10);
  check('task list / tasks --fast-path return only fast-path tasks (JSON and text)');

  // 7. Gatekeeper verification applies to fast-path tasks
  const failing = await cli(['task', 'complete', 'task-10', dir]);
  assert.equal(failing.code, 1, 'failing verification must reject completion');
  assert.equal(readPlan(dir).milestones.at(-1).tasks[1].status, 'pending');
  const ok = await cli(['task', 'complete', 'task-09', dir]);
  assert.equal(ok.code, 0, ok.stderr);
  const forced = await cli(['task', 'complete', 'task-10', dir, '--no-verify']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(readPlan(dir).milestones.at(-1).status, 'completed', 'fast-path milestone completes with its tasks');
  const fast3 = await addJson(dir, 'Another quick fix', ['--fast-path']);
  assert.equal(fast3.json.milestoneId, 'm4');
  assert.equal(fast3.json.reopenedMilestone, true, 'completed fast-path milestone is reused and reopened');
  check('task complete gatekeeper rejects failing fast-path verification; milestone completes and reopens');

  // 8. MCP tools
  mcp = startMcp(dir);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nativ-test', version: '0.0.0' } });
  mcp.notify('notifications/initialized');
  const tools = (await mcp.request('tools/list')).result.tools;
  assert.ok(!tools.some((t) => t.name === 'agentj_task_add'), 'the retired agentj_ alias is gone');
  for (const name of ['nativ_task_add']) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.deepEqual(tool.inputSchema.required, ['title']);
    for (const prop of ['title', 'description', 'assignedSubagent', 'milestone', 'verificationCommand', 'targetFiles', 'fastPath']) {
      assert.ok(tool.inputSchema.properties[prop], `${name} missing input ${prop}`);
    }
  }
  const mcpAdd = await mcp.request('tools/call', {
    name: 'nativ_task_add',
    arguments: { title: 'MCP fast task', assignedSubagent: 'qa-tester', targetFiles: ['tests/a.mjs'], verificationCommand: 'npm test', fastPath: true },
  });
  assert.notEqual(mcpAdd.result.isError, true, mcpAdd.result.content[0].text);
  const mcpJson = JSON.parse(mcpAdd.result.content[0].text);
  assert.equal(mcpJson.task.id, 'task-12');
  assert.equal(mcpJson.milestoneId, 'm4');
  assert.deepEqual(mcpJson.task.targetFiles, ['tests/a.mjs']);
  const plannedOverMcp = await mcp.request('tools/call', { name: 'nativ_task_add', arguments: { title: 'Planned task', milestone: 'm3', dependencies: ['task-05'] } });
  assert.equal(JSON.parse(plannedOverMcp.result.content[0].text).task.id, 'task-13');
  const retired = await mcp.request('tools/call', { name: 'agentj_task_add', arguments: { title: 'x' } });
  assert.ok(retired.error || retired.result?.isError, 'calling a retired agentj_ tool is an error');
  const mcpBad = await mcp.request('tools/call', { name: 'nativ_task_add', arguments: { title: 'x', dependencies: ['task-404'] } });
  assert.equal(mcpBad.result.isError, true);
  const mcpBadAgent = await mcp.request('tools/call', { name: 'nativ_task_add', arguments: { title: 'x', assignedSubagent: 'wizard' } });
  assert.ok(mcpBadAgent.error || mcpBadAgent.result?.isError, 'sub-agent enum enforced');
  const mcpList = await mcp.request('tools/call', { name: 'nativ_task_list', arguments: { fastPath: true } });
  assert.deepEqual(JSON.parse(mcpList.result.content[0].text).map((t) => t.id), ['task-09', 'task-10', 'task-11', 'task-12']);
  check('nativ_task_add over MCP: schema, fast-path routing, errors, task_list fastPath filter');

  console.log(`\n✔ All ${passed} task router checks passed.`);
} catch (err) {
  console.error('\n✖ Task router verification failed:', err);
  process.exitCode = 1;
} finally {
  mcp?.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
