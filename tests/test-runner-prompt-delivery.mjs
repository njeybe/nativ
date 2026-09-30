import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor, buildRunnerPrompt } from '../dist/runner/agent-supervisor.js';

console.log('--- Starting Runner Prompt Delivery Tests ---');

const nasty = `q"uote 'single' > < | & % ^ $HOME \`tick\` ! \\ back, é 日本語 😀`;
const task = {
  id: 't-nasty',
  title: `Title ${nasty}`,
  description: `Line one ${nasty}\nLine two after newline`,
  assignedSubagent: 'backend',
  dependencies: [],
  targetFiles: [],
  status: 'pending',
  verificationCommand: `node -e "let l='x';if(l.length>120){bad++;}" > out.txt`,
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ prompt delivery-'));
const root = path.join(base, 'my project');
fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify({
  projectName: 'p', overallStatus: 'in_progress', activeMilestoneId: 'm1', lastUpdated: new Date().toISOString(),
  milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: [task] }],
}));

const stubDir = path.join(base, 'stub');
fs.mkdirSync(stubDir);
const outFile = path.join(stubDir, 'captured.json');
const stubScript = path.join(stubDir, 'stub.js');
fs.writeFileSync(stubScript, [
  "const fs = require('fs');",
  'const chunks = [];',
  "process.stdin.on('data', (c) => chunks.push(c));",
  "process.stdin.on('end', () => {",
  `  const stdin = Buffer.concat(chunks).toString('base64');`,
  `  fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ stdin, argv: process.argv.slice(2) }));`,
  '});',
].join('\n'));
const isWin = process.platform === 'win32';
const stubFile = path.join(stubDir, isWin ? 'claude.cmd' : 'claude');
const nodeExe = process.execPath;
fs.writeFileSync(
  stubFile,
  isWin
    ? `@"${nodeExe}" "${stubScript}" %*\r\n`
    : `#!/bin/sh\nexec "${nodeExe}" "${stubScript}" "$@"\n`,
);
fs.chmodSync(stubFile, 0o755);

const listFiles = (dir) => fs.readdirSync(dir).filter((n) => n !== '.nativ').sort();
const before = listFiles(root);

const savedPath = process.env.PATH;
process.env.PATH = `${stubDir}${path.delimiter}${savedPath}`;
try {
  const sup = new AgentSupervisor({ cwd: root });
  const started = await sup.dispatch({
    taskId: task.id, runnerEngine: 'cli', useWorktree: false, timeoutSeconds: 60,
  });
  let record = sup.getRun(task.id);
  const deadline = Date.now() + 30_000;
  while (record && ['running', 'spawning_worktree'].includes(record.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    record = sup.getRun(task.id);
  }
  assert.equal(record.status, 'completed', `run should complete, got ${record.status} (${record.error})`);

  const captured = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const stdin = Buffer.from(captured.stdin, 'base64');
  assert.ok(stdin.equals(Buffer.from(buildRunnerPrompt(task), 'utf8')), 'stdin equals the prompt byte for byte');
  assert.ok(!captured.argv.some((a) => a.includes(nasty) || a.includes('Title ')), 'argv carries no task text');

  for (const text of [task.title, task.description, task.verificationCommand]) {
    assert.ok(!started.command.includes(text), 'started command has no task text');
    assert.ok(!record.command.includes(text), 'record command has no task text');
  }
  assert.deepEqual(listFiles(root), before, 'no stray files in the project directory');

  const settings = /--settings "([^"]+)"$/.exec(record.command);
  assert.ok(settings, 'command ends with a quoted --settings path');
  assert.ok(fs.existsSync(settings[1]), 'settings file exists');

  sup.shutdown?.();
} finally {
  process.env.PATH = savedPath;
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('Runner prompt delivery tests passed.');
