import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkerModel, toNativeModelId } from '../dist/core/model-routing.js';

console.log('--- Starting Model Routing Tests ---');

function project(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-routing-test-'));
  if (config) {
    fs.mkdirSync(path.join(dir, '.nativ'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nativ', 'config.json'), JSON.stringify(config));
  }
  return dir;
}

const plain = project();
assert.equal(resolveWorkerModel(plain, { complexity: 'simple' }), 'haiku');
assert.equal(resolveWorkerModel(plain, { complexity: 'standard' }), 'sonnet');
assert.equal(resolveWorkerModel(plain, { complexity: 'complex' }), 'opus');
assert.equal(resolveWorkerModel(plain, {}), null);

const custom = project({ workerModels: { simple: 'sonnet', complex: ' claude-opus-5-5 ' }, models: { simple: 'x' } });
assert.equal(resolveWorkerModel(custom, { complexity: 'simple' }), 'sonnet');
assert.equal(resolveWorkerModel(custom, { complexity: 'standard' }), 'sonnet');
assert.equal(resolveWorkerModel(custom, { complexity: 'complex' }), 'claude-opus-5-5');
assert.equal(resolveWorkerModel(custom, {}), null);

assert.equal(resolveWorkerModel(project({ workerModels: 'bad' }), { complexity: 'simple' }), 'haiku');

assert.equal(toNativeModelId('opus', 'claude-opus-5-5'), 'claude-opus-5-5');
assert.match(toNativeModelId('haiku', 'o'), /^claude-haiku-/);
assert.match(toNativeModelId('sonnet', 'o'), /^claude-sonnet-/);
assert.equal(toNativeModelId('claude-custom', 'o'), 'claude-custom');

// Supervisor: an explicit model wins, routing applies otherwise (cli command carries --model).
const { AgentSupervisor } = await import('../dist/runner/agent-supervisor.js');
const root = project({ workerModels: { standard: 'haiku' } });
fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
const task = (id, complexity) => ({
  id, title: id, description: 'd', assignedSubagent: 'backend', dependencies: [],
  targetFiles: [], status: 'pending', verificationCommand: 'node -e "0"', ...(complexity ? { complexity } : {}),
});
fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify({
  projectName: 'r', overallStatus: 'in_progress', activeMilestoneId: 'm1', lastUpdated: new Date().toISOString(),
  milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: [
    task('t-complex', 'complex'), task('t-standard', 'standard'), task('t-none'),
    task('t-explicit', 'complex'),
  ] }],
}));
const brokenClient = () => ({ messages: { stream() { throw new Error('offline'); }, create() { throw new Error('offline'); } } });
const sup = new AgentSupervisor({ cwd: root, anthropicClientFactory: brokenClient });
const run = (taskId, extra) =>
  sup.dispatch({ taskId, runnerEngine: 'native', useWorktree: false, timeoutSeconds: 30, ...extra });
assert.equal((await run('t-complex')).model, 'claude-opus-5-5');
assert.equal((await run('t-standard')).model, toNativeModelId('haiku', ''));
assert.equal((await run('t-none')).model, 'claude-opus-5-5');
const explicitNative = await run('t-explicit', { model: 'claude-custom-1' });
assert.equal(explicitNative.model, 'claude-custom-1', 'explicit model wins on native');
await sup.shutdown?.();

// CLI engine: a stub `claude` on PATH lets dispatch build the real command without the real CLI.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-claude-stub-'));
const stubName = process.platform === 'win32' ? 'claude.cmd' : 'claude';
fs.writeFileSync(path.join(stubDir, stubName), process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(stubDir, stubName), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${stubDir}${path.delimiter}${savedPath}`;
try {
  const cliSup = new AgentSupervisor({ cwd: root });
  const cliRun = (taskId, extra) =>
    cliSup.dispatch({ taskId, runnerEngine: 'cli', useWorktree: false, timeoutSeconds: 30, ...extra });
  const routed = await cliRun('t-complex');
  assert.equal(routed.model, 'opus');
  assert.match(routed.command, /^claude -p .* --model opus /);
  const custom = await cliRun('t-standard');
  assert.equal(custom.model, 'haiku', 'workerModels override reaches the cli command');
  assert.match(custom.command, / --model haiku /);
  const unrouted = await cliRun('t-none');
  assert.equal(unrouted.model, null);
  assert.doesNotMatch(unrouted.command, /--model/);
  const explicitCli = await cliRun('t-explicit', { model: 'claude-custom-1' });
  assert.equal(explicitCli.model, 'claude-custom-1', 'explicit model wins on cli');
  assert.match(explicitCli.command, / --model claude-custom-1 /);
  assert.doesNotMatch(explicitCli.command, /--model opus/);
  await cliSup.shutdown?.();
} finally {
  process.env.PATH = savedPath;
}

console.log('Model routing tests passed.');
