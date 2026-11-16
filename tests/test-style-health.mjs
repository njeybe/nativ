import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHarnessIntegrity } from '../dist/core/harness-integrity.js';
import { runValidate } from '../dist/commands/validate.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-style-health-'));
fs.mkdirSync(path.join(root, '.ai'));
g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');
const commit = g(root, 'rev-parse', 'HEAD');
const file = path.join(root, '.ai', 'code_style.json');
const style = (extra = {}) => JSON.stringify({
  version: 1, project: {}, folders: {}, patterns: [], scannedAt: { commit }, decisions: [], ...extra,
});
const styleFindings = () => checkHarnessIntegrity(root).filter((f) => f.category === 'style');
const validate = async () => {
  const log = console.log;
  let out = '';
  console.log = (m) => { out += `${m}\n`; };
  process.exitCode = 0;
  try { await runValidate(root); } finally { console.log = log; }
  const code = process.exitCode;
  process.exitCode = 0;
  return { code, out };
};

try {
  assert.deepEqual(styleFindings(), []);
  assert.ok(!(await validate()).out.includes('code_style'));

  fs.writeFileSync(file, '{ nope');
  assert.equal(styleFindings()[0].status, 'warn');
  let v = await validate();
  assert.equal(v.code, 1);
  assert.ok(v.out.includes('code_style.json'));

  fs.writeFileSync(file, style({ version: 2 }));
  assert.equal(styleFindings()[0].status, 'warn');
  assert.ok((await validate()).out.includes('Version must be 1'));

  fs.writeFileSync(file, style());
  assert.deepEqual(styleFindings(), []);
  assert.ok((await validate()).out.includes('Valid code style'));

  const decision = { rule: STYLE_RULE(), status: 'pending', evidence: { count: 1, files: ['a.txt'] } };
  fs.writeFileSync(file, style({ decisions: [decision] }));
  const pending = styleFindings();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'info');
  assert.ok(pending[0].message.includes('nativ style decide'));

  fs.writeFileSync(file, style({ scannedAt: { commit: '0'.repeat(40) } }));
  const stale = styleFindings();
  assert.equal(stale[0].status, 'info');
  assert.ok(stale[0].message.includes('stale'));
  console.log('style health tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function STYLE_RULE() {
  return 'raw-sql';
}
