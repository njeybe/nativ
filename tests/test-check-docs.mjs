import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

console.log('--- Starting Check Docs Tests ---');
const cli = path.resolve('bin/cli.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-docs-'));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = (...args) =>
  spawnSync(process.execPath, [cli, 'check', 'docs', ...args], { cwd: root, encoding: 'utf8' });

write('.ai/.keep', '');
write('scripts/seed.sh', 'echo "<ADMIN_NAME>" "<ADMIN_MAIL>"\n');
write('src/app.js', 'const p = process.env.SERVICE_PORT;\n');
write('.env.example', 'SERVICE_TOKEN=\n');
write('real.md', 'x\n');

// Clean doc: exits 0
write('good.md', [
  'Run `scripts/seed.sh` with `<ADMIN_NAME>` and `<ADMIN_MAIL>`.',
  '',
  'Set `SERVICE_PORT` and `SERVICE_TOKEN=abc`. See `real.md` and `https://example.com/x.md`.',
  'Use `nativ check docs --json` and `npm run --silent`.',
  '',
  '```',
  '`missing/in-fence.md` NOT_A_SETTING',
  '```',
].join('\n'));
let r = run('good.md');
assert.equal(r.status, 0, r.stdout + r.stderr);

// Invented mismatches: placeholders, setting name, path, nativ flag
write('bad.md', [
  'Run `scripts/seed.sh` with `<your-name>` and `<your-mail>`.',
  '',
  'Set `SERVICE_PORTS` first. See `docs/missing.md`.',
  'Try `nativ check docs --nope`.',
].join('\n'));
r = run('bad.md', '--json');
assert.equal(r.status, 1);
const out = JSON.parse(r.stdout);
const kinds = out.findings.map((f) => `${f.kind}@${f.line}`);
assert.deepEqual(kinds, ['placeholder@1', 'placeholder@1', 'setting@3', 'path@3', 'flag@4']);
assert.equal(out.findings[0].file, 'bad.md');

// Plain output: file:line
r = run('bad.md');
assert.equal(r.status, 1);
assert.match(r.stdout, /bad\.md:3 {2}setting/);

fs.rmSync(root, { recursive: true, force: true });
console.log('Check docs tests passed.');
