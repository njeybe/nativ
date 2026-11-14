import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanStyle } from '../dist/core/style/style-scan.js';
import { runStyleScan, runStyleShow } from '../dist/commands/style.js';
import { loadCodeStyle, saveCodeStyle } from '../dist/core/style/style-store.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-style-'));
g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
fs.mkdirSync(path.join(root, 'src'));
for (let i = 0; i < 6; i++) {
  const body = "const a = 'x';\nfunction f() {\n  return a;\n}\n";
  fs.writeFileSync(path.join(root, 'src', `f${i}.js`), body);
}
fs.writeFileSync(path.join(root, '.prettierrc'), '{}\n');
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');

for (const n of ['a', 'b']) {
  const body = "db.q('SELECT * FROM t');\ntry { x(); } catch {}\n";
  fs.writeFileSync(path.join(root, 'src', `sql${n}.js`), body);
}
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'more');

const dry = scanStyle(root, true);
assert.ok(dry.style && !dry.written);
assert.ok(!fs.existsSync(path.join(root, '.ai', 'code_style.json')));

const real = scanStyle(root);
assert.ok(real.written);
const { file } = loadCodeStyle(root);
assert.equal(file.scannedAt.files, 8);
assert.deepEqual(file.decisions.map((d) => d.rule), ['raw-sql', 'swallowed-errors']);
assert.ok(file.decisions.every((d) => d.status === 'pending' && d.evidence.count === 2));
const settled = { ...file, decisions: file.decisions.map((d) => ({ ...d, status: 'nativ', decidedAt: '2026-01-01' })) };
saveCodeStyle(root, settled);
scanStyle(root);
assert.ok(loadCodeStyle(root).file.decisions.every((d) => d.status === 'nativ' && d.decidedAt === '2026-01-01'));
assert.equal(file.scannedAt.commit, g(root, 'rev-parse', '--short', 'HEAD').trim());
assert.deepEqual(file.languages, ['js']);
assert.equal(file.formatters[0].tool, 'prettier');
assert.equal(file.project.js.quotes.owner, 'prettier');
assert.equal(file.project.js.quotes.value, 'single');

const logs = [];
const orig = console.log;
console.log = (...a) => logs.push(a.join(' '));
await runStyleScan(root, { dryRun: true });
await runStyleShow(root, {});
await runStyleShow(root, { json: true });
console.log = orig;
assert.ok(logs.some((l) => l.includes('Formatter: prettier')));
assert.equal(JSON.parse(logs[logs.length - 1]).version, 1);

const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-nogit-'));
const errs = [];
const origErr = console.error;
console.error = (...a) => errs.push(a.join(' '));
process.exitCode = 0;
await runStyleScan(plain, {});
console.error = origErr;
assert.equal(process.exitCode, 1);
assert.ok(errs[0].includes('not a git repository'));
process.exitCode = 0;
console.log('style scan ok');
