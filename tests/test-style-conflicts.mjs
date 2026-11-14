import assert from 'node:assert/strict';
import { detectConflicts, isModelLayerPath } from '../dist/core/style/conflicts.js';

console.log('--- Starting Style Conflicts Tests ---');
const f = (path, text) => ({ path, text });
const rules = (files) => detectConflicts(files).map((c) => c.rule);

assert.equal(isModelLayerPath('src/models/user.ts'), true);
assert.equal(isModelLayerPath('src/db/x.py'), true);
assert.equal(isModelLayerPath('src/app/user.ts'), false);
assert.equal(isModelLayerPath('models.ts'), false);
assert.equal(isModelLayerPath('src\\models\\user.ts'), true);
assert.equal(isModelLayerPath('src\\app\\user.ts'), false);

const sql = (p) => f(p, 'const q = "SELECT * FROM users";');
assert.deepEqual(rules([sql('a.ts'), sql('b.ts')]), ['raw-sql']);
assert.deepEqual(rules([sql('a.ts')]), []);
assert.deepEqual(rules([sql('models/a.ts'), sql('db/b.ts')]), []);
assert.deepEqual(rules([f('a.py', 'cursor.execute(q)'), f('b.ts', 'pool.query(q)')]), ['raw-sql']);

const swallow = [
  f('a.ts', 'x().catch(() => [])'),
  f('b.ts', 'try { a() } catch {}'),
  f('c.py', 'try:\n  a()\nexcept:\n  pass'),
  f('d.py', 'try:\n  a()\nexcept Exception:\n  pass'),
];
const found = detectConflicts(swallow)[0];
assert.equal(found.rule, 'swallowed-errors');
assert.equal(found.count, 4);
assert.deepEqual(found.files, ['a.ts', 'b.ts', 'c.py']);

const env = (p, extra = '') => f(p, `const a = process.env.KEY ?? ''; ${extra}`);
assert.deepEqual(rules([env('a.ts'), env('b.ts')]), ['config-fallback']);
const allowed = env('a.ts', '// nativ-allow-fallback');
assert.deepEqual(rules([allowed, env('b.ts', '// nativ-allow-fallback')]), []);

console.log('Style conflicts tests passed.');
