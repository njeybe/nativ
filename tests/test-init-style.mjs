import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../dist/commands/init.js';
import { runUpdate } from '../dist/commands/update.js';

console.log('--- Starting init style Tests ---');
async function nativ(cwd, cmd) {
  const lines = [];
  const orig = console.log;
  console.log = (x) => lines.push(String(x));
  try {
    await (cmd === 'init' ? runInit(cwd) : runUpdate(cwd));
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-istyle-'));
  dirs.push(d);
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"demo","version":"1.0.0"}');
  return d;
};

try {
  const a = tmp();
  g(a, 'init', '-q');
  g(a, 'config', 'user.email', 't@t.t');
  g(a, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(a, 'src'));
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(a, 'src', `f${i}.js`), `export const v${i} = ${i};\n`);
  }
  g(a, '-c', 'core.autocrlf=false', 'add', '-A');
  g(a, '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');
  const out = await nativ(a, 'init');
  assert.ok(fs.existsSync(path.join(a, '.ai', 'code_style.json')));
  assert.match(out, /Pipeline Scaffolding Completed/);
  assert.equal((out.match(/Code style:/g) ?? []).length, 1);
  console.log('✔ Test 1: init scans an existing git codebase');

  const b = tmp();
  const rb = await nativ(b, 'init');
  assert.ok(!fs.existsSync(path.join(b, '.ai', 'code_style.json')));
  assert.match(rb, /Pipeline Scaffolding Completed/);
  assert.match(rb, /Code style scan skipped: not a git repository/);
  console.log('✔ Test 2: outside git init prints one reason line');

  const u1 = await nativ(b, 'update');
  assert.match(u1, /Run nativ style scan to record/);
  assert.ok(!fs.existsSync(path.join(b, '.ai', 'code_style.json')));
  const u2 = await nativ(a, 'update');
  assert.doesNotMatch(u2, /Run nativ style scan to record/);
  console.log('✔ Test 3: update hints only when the record is missing');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
