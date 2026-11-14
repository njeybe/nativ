import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listStyleSources, isExistingCodebase } from '../dist/core/style/style-sources.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-ss-'));
const put = (root, rel, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const commit = (root) => {
  g(root, '-c', 'core.autocrlf=false', 'add', '-A');
  g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');
};

// outside git
const plain = mk();
put(plain, 'a.ts');
assert.deepEqual(listStyleSources(plain), { available: false, reason: 'not a git repository' });
assert.equal(isExistingCodebase(plain), false);

// skips
const root = mk();
g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
for (const f of ['src/keep.ts', 'dist/a.js', 'node_modules/b.js', 'src/generated/c.ts',
  'src/x.min.js', 'src/t.d.ts', '.env', '.env.local', 'k.pem', 'k.key', '.nativ/a.local.json']) {
  put(root, f);
}
put(root, 'src/gen.ts', '// @generated\nx\n');
put(root, 'src/big.ts', 'a'.repeat(300 * 1024));
commit(root);
const r = listStyleSources(root);
assert.deepEqual(r, { available: true, files: ['src/keep.ts'] });

// caps and determinism
const many = mk();
g(many, 'init', '-q');
g(many, 'config', 'user.email', 't@t.t');
g(many, 'config', 'user.name', 't');
for (let i = 0; i < 45; i++) put(many, `d/f${String(i).padStart(2, '0')}.ts`);
for (let d = 0; d < 40; d++) for (let i = 0; i < 40; i++) put(many, `p${d}/f${i}.py`);
commit(many);
const a = listStyleSources(many);
assert.equal(a.files.filter((f) => f.startsWith('d/')).length, 40);
assert.equal(a.files.length, 1500);
assert.deepEqual(a.files, [...a.files].sort());
assert.deepEqual(listStyleSources(many), a);
assert.equal(isExistingCodebase(many), true);

// threshold
const nine = mk();
g(nine, 'init', '-q');
g(nine, 'config', 'user.email', 't@t.t');
g(nine, 'config', 'user.name', 't');
for (let i = 0; i < 9; i++) put(nine, `s${i}.js`);
commit(nine);
assert.equal(isExistingCodebase(nine), false);
put(nine, 's9.py');
commit(nine);
assert.equal(isExistingCodebase(nine), true);
console.log('style-sources ok');
