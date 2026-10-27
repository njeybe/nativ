import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanEnvReads, listProjectEnvNames } from '../dist/core/env-reads.js';

console.log('--- Starting Env Reads Tests ---');
const names = (t, f) => scanEnvReads(t, f).map((r) => r.name);
const fb = (t, f) => scanEnvReads(t, f).map((r) => r.fallback);

// JS/TS read forms
const js = [
  'const a = process.env.ALPHA;',
  "const b = process.env['BETA'];",
  'const c = import.meta.env.GAMMA;',
  "const d = Deno.env.get('DELTA');",
  'const e = Bun.env.EPSILON;',
].join('\n');
assert.deepEqual(names(js, 'a.ts'), ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'EPSILON']);
assert.deepEqual(scanEnvReads(js, 'a.ts').map((r) => r.line), [1, 2, 3, 4, 5]);

// JS fallbacks
const fbJs = [
  "const a = Deno.env.get('A') ?? '';",
  'const b = process.env.B ?? "";',
  'const c = process.env.C ?? null;',
  'const d = process.env.D ?? undefined,',
  "const e = process.env.E || '';",
  "const f = process.env.F ?? '3000';",
  "const g = process.env.G ?? '';  // nativ-allow-fallback",
  'const h = process.env.H;',
].join('\n');
assert.deepEqual(fb(fbJs, 'x.mjs'), [true, true, true, true, true, false, false, false]);

// Python
const py = [
  "a = os.environ['PY_A']",
  "b = os.environ.get('PY_B', 'x')",
  "c = os.getenv('PY_C', '')",
  "d = os.environ.get('PY_D') or ''",
  'e = os.getenv("PY_E", None)',
  "f = os.getenv('PY_F') or 'dflt'",
  "g = os.getenv('PY_G', '')  # nativ-allow-fallback",
].join('\n');
assert.deepEqual(names(py, 'm.py'), ['PY_A', 'PY_B', 'PY_C', 'PY_D', 'PY_E', 'PY_F', 'PY_G']);
assert.deepEqual(fb(py, 'm.py'), [false, false, true, true, true, false, false]);

// Go
const go = [
  'a := os.Getenv("GO_A")', 'use(a)', 'more()', 'more()', 'more()',
  'b := os.Getenv("GO_B")',
  'if b == "" {',
  '  panic("missing")',
  '}',
  'c, ok := os.LookupEnv("GO_C")',
  'if os.Getenv("GO_D") != "" {}',
].join('\n');
assert.deepEqual(names(go, 'main.go'), ['GO_A', 'GO_B', 'GO_C', 'GO_D']);
assert.deepEqual(fb(go, 'main.go'), [true, false, false, false]);
assert.equal(scanEnvReads('x := os.Getenv("GO_A")', 'a.go')[0].fallback, true);

// Unknown extension and CRLF
assert.deepEqual(scanEnvReads('process.env.X', 'notes.md'), []);
assert.deepEqual(fb("a\r\nprocess.env.X ?? ''\r\n", 'a.js'), [true]);

// Project scan
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-envreads-'));
const w = (f, t) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), t);
};
w('src/a.ts', 'process.env.SRC_VAR');
w('node_modules/x/i.js', 'process.env.HIDDEN_NM');
w('dist/o.js', 'process.env.HIDDEN_DIST');
w('app.py', "os.getenv('PY_VAR')");
w('.env.example', 'EX_VAR=1\n# comment\nexport EX_TWO=\n');
w('.env.local', 'SECRET_LOCAL=abc\n');
const expected = ['EX_TWO', 'EX_VAR', 'PY_VAR', 'SRC_VAR'];
assert.deepEqual(listProjectEnvNames(dir), expected, 'walk mode');
spawnSync('git', ['init', '-q'], { cwd: dir });
w('.gitignore', 'node_modules/\ndist/\n');
assert.deepEqual(listProjectEnvNames(dir), expected, 'git mode');
assert.ok(!listProjectEnvNames(dir).includes('SECRET_LOCAL'));
fs.rmSync(dir, { recursive: true, force: true });

console.log('Env reads tests passed.');
