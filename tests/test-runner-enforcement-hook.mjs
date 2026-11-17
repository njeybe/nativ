import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(pathToFileURL(path.join(repoRoot, 'dist', 'runner', 'cli-config.js')).href);
const task = { verificationCommand: 'npm test' };
const withHook = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'nativ hook check' }] }] } });
const dirs = [];

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-hook-'));
  dirs.push(dir);
  return dir;
}

function setSettings(dir, text) {
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), text);
}

try {
  const root = tmp();
  const wt = tmp();
  setSettings(root, withHook);
  assert.ok(mod.buildRunnerPermissions(task, root, [], wt).hooks, 'worktree without .claude gets the hook');

  setSettings(wt, withHook);
  assert.equal(mod.buildRunnerPermissions(task, root, [], wt).hooks, undefined, 'no double hook');

  const bare = tmp();
  assert.ok(mod.buildRunnerPermissions(task, bare, [], bare).hooks, 'no setup anywhere gets the hook');

  assert.equal(mod.buildRunnerPermissions(task, root).hooks, undefined, 'in-place run uses the root');
  console.log('runner enforcement hook: ok');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
