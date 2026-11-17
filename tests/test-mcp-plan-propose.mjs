import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

console.log('--- Starting MCP plan_propose and breaker checks ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(repoRoot, 'dist', rel)).href);
const { createMcpServer } = await load('mcp/server.js');
const { CircuitBreaker } = await load('governor/circuit-breaker.js');

const task = (id, status, deps = []) => ({
  id, title: id, assignedSubagent: 'backend', dependencies: deps,
  targetFiles: ['a.ts'], status, verificationCommand: 'true', notes: '',
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-mcp-plan-'));
fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
const planFile = path.join(dir, '.ai', 'master_plan.json');
fs.writeFileSync(planFile, JSON.stringify({
  projectName: 'fixture',
  overallStatus: 'pending',
  activeMilestoneId: 'm1',
  lastUpdated: new Date().toISOString(),
  milestones: [{
    id: 'm1', name: 'M', status: 'pending',
    tasks: [
      task('task-1', 'pending'),
      task('task-2', 'pending'),
      task('task-done', 'completed'),
      task('task-gone', 'dropped'),
      task('task-open', 'in_progress'),
    ],
  }],
}, null, 2));

const readTask = (id) =>
  JSON.parse(fs.readFileSync(planFile, 'utf8')).milestones[0].tasks.find((t) => t.id === id);

const server = createMcpServer(dir);
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test', version: '1.0.0' });
await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('nativ_plan_propose'), 'plan_propose is registered');
  const banned = names.filter((n) => n.includes('plan') && /approve|reject/.test(n));
  assert.deepEqual(banned, [], 'no tool approves or rejects a plan change');
  assert.ok(!names.some((n) => /approve|reject/.test(n)), 'no approve or reject tool at all');

  const list = tools.find((t) => t.name === 'nativ_task_list');
  assert.ok(list.inputSchema.properties.status.enum.includes('dropped'), 'task_list accepts dropped');

  const ok = await client.callTool({
    name: 'nativ_plan_propose',
    arguments: { taskId: 'task-1', notes: 'new notes', reason: 'clarify the task' },
  });
  assert.ok(!ok.isError, `a valid proposal succeeds: ${ok.content[0].text}`);
  const record = JSON.parse(ok.content[0].text);
  assert.equal(record.status, 'proposed');
  assert.equal(record.taskId, 'task-1');
  assert.equal(readTask('task-1').notes, '', 'proposing does not touch the plan');

  const drop = await client.callTool({
    name: 'nativ_plan_propose',
    arguments: { taskId: 'task-2', drop: true, replacedBy: 'task-1', reason: 'superseded' },
  });
  assert.ok(!drop.isError, `a drop proposal succeeds: ${drop.content[0].text}`);
  const dropped = JSON.parse(drop.content[0].text).change.drop;
  assert.equal(dropped.replacedBy, 'task-1', 'the record carries the drop');

  const refused = await client.callTool({
    name: 'nativ_plan_propose',
    arguments: { taskId: 'task-nope', notes: 'x', reason: 'unknown task' },
  });
  assert.equal(refused.isError, true, 'a refusal is a tool error');
  assert.ok(refused.content[0].text.length > 0, 'the refusal says why');
} finally {
  await client.close();
  await server.close();
}

const rule = { approved: false, blastRadius: 'high', ruleId: 'R-TEST', message: 'm', violations: [] };
const context = { intent: 'test', affected: ['a.ts'], escalationType: 'contract_drift' };
const trip = (id) => {
  for (let i = 0; i < 3; i += 1) CircuitBreaker.recordGuardViolation(dir, id, rule, context);
};
trip('task-done');
trip('task-gone');
trip('task-open');
assert.equal(readTask('task-done').status, 'completed', 'breaker leaves a completed task');
assert.equal(readTask('task-gone').status, 'dropped', 'breaker leaves a dropped task');
assert.equal(readTask('task-done').notes, '');
assert.equal(readTask('task-open').status, 'blocked', 'breaker still blocks an open task');

fs.rmSync(dir, { recursive: true, force: true });
console.log('MCP plan_propose checks passed.');
