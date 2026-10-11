import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkText, readProfile, DESIGN_PROFILES } from '../dist/core/design-rules.js';

const ids = (t, ext, p) => checkText(t, ext, p).map((f) => f.rule);
const cases = [
  ['no-emoji', 'const a = "\u{1F680}";', 'const a = "ok";', 'taste-v1', '.ts'],
  ['no-em-dash', 'a — b', 'a - b', 'taste-v2', '.ts'],
  ['no-h-screen', '<div className="h-screen">', '<div className="min-h-[100dvh]">', 'taste-v1', '.tsx'],
  ['no-scroll-listener', "window.addEventListener('scroll', f)", "window.addEventListener('click', f)", 'taste-v1', '.ts'],
  ['no-pure-black', 'color: #000;', 'color: #0000ff;', 'taste-v1', '.css'],
  ['no-pure-black', 'color: rgb(0, 0, 0)', 'color: #000a', 'taste-v1', '.css'],
  ['no-google-fonts-link', '<link href="https://fonts.googleapis.com/x">', '<link href="/f.css">', 'taste-v2', '.html'],
  ['no-custom-cursor', 'cursor: url(a.png)', 'cursor: pointer', 'taste-v1', '.css'],
  ['no-hand-rolled-icon', '<svg><path d="M0"/></svg>', '<svg><circle/></svg>', 'taste-v1', '.tsx'],
];
for (const [rule, bad, good, prof, ext] of cases) {
  assert.ok(ids(bad, ext, prof).includes(rule), `${rule} should fire`);
  assert.ok(!ids(good, ext, prof).includes(rule), `${rule} should pass`);
}
assert.strictEqual(DESIGN_PROFILES.length, 2);
assert.ok(!ids('<svg><path/></svg>', '.html', 'taste-v1').includes('no-hand-rolled-icon'));

// position and comments
const pos = checkText('x\n  h-screen', '.tsx', 'taste-v1')[0];
assert.deepStrictEqual([pos.line, pos.column], [2, 3]);
assert.deepStrictEqual(checkText('// h-screen \u{1F680}', '.ts', 'taste-v1'), []);
assert.deepStrictEqual(checkText('{/* h-screen */}', '.tsx', 'taste-v1'), []);

// profile gating
assert.ok(!ids('a — b', '.ts', 'taste-v1').includes('no-em-dash'));

// readProfile
assert.strictEqual(readProfile('- **Profile:** taste-v1 | taste-v2\n'), null);
assert.strictEqual(readProfile('- **Profile:** nativ\n'), null);
assert.strictEqual(readProfile('x\n- **Profile:** taste-v2\n'), 'taste-v2');
assert.strictEqual(readProfile('# nothing'), null);

// CLI
const cli = path.resolve('bin/cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-dc-'));
try {
  fs.mkdirSync(path.join(tmp, 'src', 'sub'), { recursive: true });
  const bad = path.join(tmp, 'src', 'sub', 'a.tsx');
  fs.writeFileSync(bad, 'const a = "\u{1F680}";\n');
  const run = (...args) => spawnSync('node', [cli, 'design', 'check', ...args], { cwd: tmp, encoding: 'utf8' });
  const none = run();
  assert.strictEqual(none.status, 1);
  assert.match(none.stderr, /No design profile is set/);
  const noneJson = run('--json');
  assert.strictEqual(noneJson.status, 1);
  assert.match(JSON.parse(noneJson.stdout).error, /No design profile is set/);
  fs.writeFileSync(bad, 'const c = "#000";\n');
  const warn = run('--profile', 'taste-v1', '--json');
  assert.strictEqual(warn.status, 0);
  const j = JSON.parse(warn.stdout);
  assert.strictEqual(j.profile, 'taste-v1');
  assert.strictEqual(j.filesScanned, 1);
  assert.strictEqual(j.warnings, 1);
  assert.strictEqual(j.errors, 0);
  assert.strictEqual(j.findings[0].file, 'src/sub/a.tsx');
  assert.strictEqual(j.findings[0].rule, 'no-pure-black');
  assert.strictEqual(run('--profile', 'bogus').status, 1);
  assert.strictEqual(run('missing').status, 1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('design-check tests passed');
