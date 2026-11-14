import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

console.log('--- Starting init style Tests ---');
const CLI = path.resolve('bin', 'cli.js');
const nativ = (cwd, ...a) =>
  spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', timeout: 120_000 });
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
  const r = nativ(a, 'init', a);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(a, '.ai', 'code_style.json')));
  assert.equal((r.stdout.match(/Code style:/g) ?? []).length, 1);
  console.log('✔ Test 1: init scans an existing git codebase');

  const b = tmp();
  const rb = nativ(b, 'init', b);
  assert.equal(rb.status, 0, rb.stderr);
  assert.ok(!fs.existsSync(path.join(b, '.ai', 'code_style.json')));
  assert.match(rb.stdout, /Code style scan skipped: not a git repository/);
  console.log('✔ Test 2: outside git init prints one reason line');

  const u1 = nativ(b, 'update', b);
  assert.match(u1.stdout, /Run nativ style scan to record/);
  assert.ok(!fs.existsSync(path.join(b, '.ai', 'code_style.json')));
  const u2 = nativ(a, 'update', a);
  assert.doesNotMatch(u2.stdout, /Run nativ style scan to record/);
  console.log('✔ Test 3: update hints only when the record is missing');
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
