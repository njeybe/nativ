import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { lintPortability, isPortabilityTarget } from '../dist/core/verifier/portability-lint.js';

console.log('--- Starting Portability Lint Tests ---');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-port-'));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
spawnSync('git', ['init', '-q'], { cwd: root });
write('.gitignore', '.ai/\nlocal-data/\n');
write('tests/x.test.ts', [
  "import a from './helper';",
  "const a1 = 1;",
  "read('.ai/notes.md');",
  "read('local-data/sample.json');",
  "read('fixtures/ok.json');",
  "spawnSync('nativ', ['check']);",
].join('\n'));
write('src/app.ts', "read('.ai/notes.md');\n");

assert.ok(isPortabilityTarget('tests/a.mjs') && isPortabilityTarget('pkg/x_test.go'));
assert.ok(isPortabilityTarget('test_a.py') && isPortabilityTarget('scripts/run.sh'));
assert.ok(!isPortabilityTarget('src/app.ts'));

const out = lintPortability(root, ['tests/x.test.ts', 'src/app.ts']);
assert.equal(out.length, 3, out.join('\n'));
assert.ok(out.some((m) => m.startsWith('tests/x.test.ts:3 reads .ai/notes.md') && m.includes('tracked') === false
  && m.includes('fixture')));
assert.ok(out.some((m) => m.includes('x.test.ts:4 reads local-data/sample.json') && !m.includes('fixture')));
assert.ok(out.some((m) => m.includes('x.test.ts:6 spawns nativ')));
assert.deepEqual(lintPortability(root, ['src/app.ts']), []);

const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-nogit-'));
fs.mkdirSync(path.join(plain, 'tests'));
fs.writeFileSync(path.join(plain, 'tests/a.test.js'), "read('.ai/x.md');\n");
assert.deepEqual(lintPortability(plain, ['tests/a.test.js']), []);
console.log('--- Portability Lint Tests Passed ---');
