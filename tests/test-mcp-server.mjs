import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting MCP Stdio Protocol & Tool Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'cli.js');
const SECRET = 'mcp-air-gap-secret';

const EXPECTED_TOOLS = [
  'agentj_task_next',
  'agentj_task_list',
  'agentj_task_start',
  'agentj_task_complete',
  'agentj_task_block',
  'agentj_task_escalate',
  'agentj_init',
  'agentj_status',
  'agentj_db_status',
  'agentj_db_diff',
  'agentj_db_inspect',
];

const EXPECTED_RESOURCES = [
  'agentj://context',
  'agentj://master-plan',
  'agentj://db-schema',
  'agentj://api-contracts',
  'agentj://escalation',
];

/** A loopback port with nothing listening, so connections are refused quickly. */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function createFixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentj-mcp-'));
  const aiDir = path.join(dir, '.ai');
  fs.mkdirSync(aiDir, { recursive: true });
  fs.writeFileSync(path.join(aiDir, 'context.md'), '# Fixture Context\n', 'utf8');
  fs.writeFileSync(path.join(aiDir, 'db_schema.json'), JSON.stringify({ tables: [] }, null, 2), 'utf8');
  fs.writeFileSync(path.join(aiDir, 'api_contracts.json'), JSON.stringify({ endpoints: [] }, null, 2), 'utf8');
  const plan = {
    projectName: 'mcp-fixture',
    overallStatus: 'pending',
    activeMilestoneId: 'm1',
    lastUpdated: new Date().toISOString(),
    milestones: [
      {
        id: 'm1',
        name: 'Fixture Milestone',
        status: 'pending',
        tasks: [
          { id: 'task-1', title: 'First task', assignedSubagent: 'backend', dependencies: [], targetFiles: ['a.ts'], status: 'pending', verificationCommand: 'true', notes: '' },
          { id: 'task-2', title: 'Second task', assignedSubagent: 'qa-tester', dependencies: ['task-1'], targetFiles: ['b.ts'], status: 'pending', verificationCommand: 'true', notes: '' },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(aiDir, 'master_plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  return dir;
}

/** Minimal newline-delimited JSON-RPC client over the server's stdio. */
function startServer(projectDir, env) {
  const child = spawn(process.execPath, [cliPath, 'mcp', projectDir], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const rawStdoutLines = [];
  let stderr = '';
  let buffer = '';
  let nextId = 1;

  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      rawStdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Recorded in rawStdoutLines; asserted on later.
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

  return {
    child,
    rawStdoutLines,
    stderr: () => stderr,
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}. stderr:\n${stderr}`));
        }, 15000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });
    },
    async callTool(name, args = {}) {
      const res = await this.request('tools/call', { name, arguments: args });
      return res;
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

function toolText(res) {
  assert.ok(res.result, `expected a result, got: ${JSON.stringify(res)}`);
  assert.equal(res.result.content[0].type, 'text');
  return res.result.content[0].text;
}

const projectDir = createFixtureProject();

// Strip host DB config so the child only sees the fixture connection below.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(PROD_)?DB_|^MYSQL_|^POSTGRES_|^PG(HOST|PORT|USER|PASSWORD|DATABASE)$|DATABASE_URL|MONGO|FIRESTORE/.test(key)) delete env[key];
}
env.DEV_DATABASE_URL = `postgres://agent:${SECRET}@127.0.0.1:${await closedPort()}/fixture_dev`;

const server = startServer(projectDir, env);
let passed = 0;
const check = (label) => {
  passed++;
  console.log(`  ✔ ${label}`);
};

try {
  // 1. Initialization handshake
  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nativ-test', version: '0.0.0' },
  });
  assert.equal(init.jsonrpc, '2.0');
  assert.ok(['nativ', 'agentj'].includes(init.result.serverInfo.name), `unexpected serverInfo name ${init.result.serverInfo.name}`);
  assert.ok(init.result.capabilities.tools, 'server advertises tools capability');
  assert.ok(init.result.capabilities.resources, 'server advertises resources capability');
  server.notify('notifications/initialized');
  check('initialize handshake returns nativ serverInfo with tools + resources capabilities');

  // 2. Tool discovery
  const tools = await server.request('tools/list');
  const toolNames = tools.result.tools.map((t) => t.name);
  for (const name of EXPECTED_TOOLS) assert.ok(toolNames.includes(name), `missing legacy tool ${name}`);
  for (const name of EXPECTED_TOOLS) {
    const nativName = name.replace('agentj_', 'nativ_');
    assert.ok(toolNames.includes(nativName), `missing nativ tool ${nativName}`);
  }
  assert.ok(!toolNames.some((n) => /sync|ui|studio/.test(n)), 'contract-writing / studio tools must not be exposed');
  const escalate = tools.result.tools.find((t) => t.name === 'nativ_task_escalate' || t.name === 'agentj_task_escalate');
  assert.deepEqual([...escalate.inputSchema.required].sort(), ['details', 'taskId', 'type']);
  check(`tools/list exposes both nativ_* and legacy agentj_* tools with input schemas`);

  // 3. Resource listing & reads
  const resources = await server.request('resources/list');
  const uris = resources.result.resources.map((r) => r.uri);
  for (const uri of EXPECTED_RESOURCES) assert.ok(uris.includes(uri), `missing legacy resource ${uri}`);
  for (const uri of EXPECTED_RESOURCES) {
    const nativUri = uri.replace('agentj://', 'nativ://');
    assert.ok(uris.includes(nativUri), `missing nativ resource ${nativUri}`);
  }
  check(`resources/list exposes both nativ:// and legacy agentj:// resources`);

  const planRes = await server.request('resources/read', { uri: 'agentj://master-plan' });
  const planContent = planRes.result.contents[0];
  assert.equal(planContent.mimeType, 'application/json');
  assert.equal(JSON.parse(planContent.text).projectName, 'mcp-fixture');
  const ctxRes = await server.request('resources/read', { uri: 'agentj://context' });
  assert.match(ctxRes.result.contents[0].text, /Fixture Context/);
  const escRes = await server.request('resources/read', { uri: 'agentj://escalation' });
  assert.deepEqual(JSON.parse(escRes.result.contents[0].text), { escalations: [] });
  check('resources/read returns .ai/ file contents (escalation defaults to empty)');

  // 4. agentj_task_next
  const next = await server.callTool('agentj_task_next');
  assert.notEqual(next.result.isError, true);
  const nextJson = JSON.parse(toolText(next));
  assert.equal(nextJson.status, 'ready');
  assert.equal(nextJson.task.id, 'task-1');
  assert.equal(nextJson.task.roleGuide, '.ai/subagents/backend.md');
  check('agentj_task_next returns the ready task as JSON with its role guide');

  // 5. Lifecycle mutation round-trip
  const start = await server.callTool('agentj_task_start', { taskId: 'task-1' });
  assert.notEqual(start.result.isError, true);
  assert.match(toolText(start), /in_progress/);
  assert.doesNotMatch(toolText(start), /\x1b\[/, 'ANSI color codes must be stripped');
  const complete = await server.callTool('agentj_task_complete', { taskId: 'task-1', notes: 'done via MCP' });
  assert.notEqual(complete.result.isError, true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectDir, '.ai', 'master_plan.json'), 'utf8'));
  assert.equal(onDisk.milestones[0].tasks[0].status, 'completed');
  assert.equal(onDisk.milestones[0].tasks[0].notes, 'done via MCP');
  const next2 = JSON.parse(toolText(await server.callTool('agentj_task_next')));
  assert.equal(next2.task.id, 'task-2');
  check('agentj_task_start / agentj_task_complete update master_plan.json and advance task_next');

  // 6. Error reporting
  const missing = await server.callTool('agentj_task_start', { taskId: 'task-404' });
  assert.equal(missing.result.isError, true);
  assert.match(toolText(missing), /not found/);
  const badArgs = await server.callTool('agentj_task_block', { taskId: 'task-2' });
  assert.ok(badArgs.error || badArgs.result?.isError, 'missing required "reason" must be rejected');
  check('unknown task IDs and invalid arguments are reported as tool errors');

  // 7. agentj_db_status (air-gap)
  const dbStatus = await server.callTool('agentj_db_status');
  assert.notEqual(dbStatus.result.isError, true, 'an offline database is a status report, not a tool failure');
  const dbText = toolText(dbStatus);
  const dbJson = JSON.parse(dbText);
  assert.equal(dbJson.dev.connected, false);
  assert.equal(dbJson.prod.connected, false);
  assert.ok(!dbText.includes(SECRET), 'db status output must never contain the raw password');
  assert.ok(!server.stderr().includes(SECRET), 'server stderr must never contain the raw password');
  check('agentj_db_status reports offline databases as JSON with masked credentials');

  // 8. stdout carries JSON-RPC frames only
  for (const line of server.rawStdoutLines) {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, '2.0', `non JSON-RPC line on stdout: ${line}`);
  }
  assert.ok(!server.rawStdoutLines.some((l) => l.includes(SECRET)));
  check(`stdout contained only JSON-RPC frames (${server.rawStdoutLines.length} lines)`);

  console.log(`\n✔ All ${passed} MCP server checks passed.`);
} catch (err) {
  console.error('\n✖ MCP server verification failed:', err);
  console.error('--- server stderr ---\n' + server.stderr());
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
}
