import assert from 'node:assert/strict';
import { measureJs } from '../dist/core/style/measure-js.js';

const m = (file, text) => measureJs(file, text);

// File names
assert.deepEqual(m('src/user-card.ts', '').fileNaming, { kebab: 1 });
assert.deepEqual(m('src/userCard.test.ts', '').fileNaming, { camel: 1 });
assert.deepEqual(m('src/UserCard.tsx', '').fileNaming, { pascal: 1 });
assert.deepEqual(m('src/user_card.js', '').fileNaming, { snake: 1 });
assert.equal(m('src/index.ts', '').fileNaming, undefined);
assert.equal(m('src/user.ts', '').fileNaming, undefined);
for (const ext of ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs']) {
  assert.deepEqual(m(`a-b.${ext}`, '').fileNaming, { kebab: 1 }, ext);
}
assert.deepEqual(m('a-b.py', 'x = 1'), {});

// Quotes, ignoring text inside other literals and comments
const q = m('a.js', "const a = 'x';\nconst b = 'y';\nconst c = \"z\";\n// \"no\" 'no'\nconst d = `'t'`;\n");
assert.deepEqual(q.quotes, { single: 2, double: 1 });

// Semicolons
assert.deepEqual(m('a.js', 'const a = 1;\nconst b = 2;\n').semicolons, { always: 2 });
assert.deepEqual(m('a.js', 'const a = 1\nconst b = 2\nreturn b\n').semicolons, { never: 3 });
assert.equal(m('a.js', '// const a = 1\nconst s = "x;";\n').semicolons.never, undefined);

// Indent
assert.deepEqual(m('a.js', 'if (a) {\n  b();\n  if (c) {\n    d();\n  }\n}\n').indent, { 2: 2 });
assert.deepEqual(m('a.js', 'if (a) {\n    b();\n}\n').indent, { 4: 1 });
assert.deepEqual(m('a.js', 'if (a) {\n\tb();\n}\n').indent, { tab: 1 });

// Trailing commas
assert.deepEqual(m('a.js', 'const a = {\n  x: 1,\n  y: 2,\n};\n').trailingCommas, { always: 1 });
assert.deepEqual(m('a.js', 'foo(\n  1,\n  2\n);\n').trailingCommas, { never: 1 });
assert.equal(m('a.js', 'if (a) {\n  b();\n}\n').trailingCommas, undefined);

// Names
const names = m('a.ts', 'function doIt() {}\nconst runNow = () => 1;\nfunction do_it() {}\nfunction Card() {}\n');
assert.deepEqual(names.functionNaming, { camel: 2, snake: 1, pascal: 1 });
assert.deepEqual(m('a.ts', 'interface Foo {}\nclass Bar {}\ntype Baz = 1;\n').typeNaming, { pascal: 3 });
const consts = m('a.ts', 'const MAX_SIZE = 3;\nconst someValue = 1;\nfunction f() {\n  const inner = 1;\n}\n');
assert.deepEqual(consts.constantNaming, { 'upper-snake': 1, camel: 1 });

// Modules, exports, imports
const esm = m('a.ts', "import a from './a.js';\nimport b from '@/b';\nimport c from './c';\nexport const x = 1;\n");
assert.deepEqual(esm.moduleSystem, { esm: 1 });
assert.deepEqual(esm.exportStyle, { named: 1 });
assert.deepEqual(esm.importStyle, { relative: 2, alias: 1 });
assert.deepEqual(esm.importSuffix, { js: 1, none: 1 });
const cjs = m('a.cjs', "const a = require('./a');\nmodule.exports = { a };\n");
assert.deepEqual(cjs.moduleSystem, { cjs: 1 });
assert.deepEqual(cjs.exportStyle, { default: 1 });
assert.deepEqual(m('a.ts', 'export default 1;\n').exportStyle, { default: 1 });

// Async and errors
const flow = m('a.ts', 'async function f() {\n  try {\n    await g();\n  } catch (e) {}\n  h().then(x).catch(y);\n}\n');
assert.deepEqual(flow.asyncStyle, { await: 1, then: 1 });
assert.deepEqual(flow.errorStyle, { 'try-catch': 1, 'promise-catch': 1 });

// Literals never count
const trap = m('a.ts', [
  'const re = /await "x" try {/g;',
  'const t = `await ${a} .then(`;',
  '/* await try { */',
  'const s = "await .then( try {";',
].join('\n'));
assert.equal(trap.asyncStyle, undefined);
assert.equal(trap.errorStyle, undefined);

console.log('measure-js tests passed');
