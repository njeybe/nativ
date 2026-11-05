import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

console.log('--- Starting Single Startup Context Tests ---');

const root = path.resolve('.');
const CLI = path.join(root, 'bin', 'cli.js');
const MARKER = 'nativ project (role-based workflow).';

// A nativ project with a plan, optionally with the project's own SessionStart hook.
function makeProject({ projectHook }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-startup-'));
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify({ milestones: [] }), 'utf8');
  if (projectHook) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const command = `node "${CLI}" hook context`;
    const settings = { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command }] }] } };
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  return dir;
}

// Runs one hook command the way Claude Code does: the project dir is the cwd and the argument.
function runHook(dir, args) {
  const env = { ...process.env, NATIV_ROLE: '' };
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [CLI, 'hook', 'context', dir, ...args], { encoding: 'utf8', env, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const count = (text) => text.split(MARKER).length - 1;

// Both installs: the project hook prints once, the plugin's copy prints nothing
{
  const dir = makeProject({ projectHook: true });
  const fromProject = runHook(dir, []);
  const fromPlugin = runHook(dir, ['--from-plugin']);
  assert.equal(count(fromProject), 1, 'the project hook prints the orientation');
  assert.equal(fromPlugin, '', 'the plugin copy is silent when the project has its own hook');
  assert.equal(count(fromProject) + count(fromPlugin), 1, 'the startup text appears exactly once');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 1: with both installs the startup text prints once');
}

// Plugin only: the plugin's copy still prints
{
  const dir = makeProject({ projectHook: false });
  const fromPlugin = runHook(dir, ['--from-plugin']);
  assert.equal(count(fromPlugin), 1, 'the plugin prints when the project has no nativ hook');
  assert.equal(JSON.parse(fromPlugin).hookSpecificOutput.hookEventName, 'SessionStart');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 2: with only the plugin the startup text still prints');
}

// Project hook without the flag always prints, even when the flag is absent from the plugin
{
  const dir = makeProject({ projectHook: true });
  assert.equal(count(runHook(dir, [])), 1, 'a plain project hook prints');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ Test 3: the project hook command prints as before');
}
