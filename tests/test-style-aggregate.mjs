import assert from 'node:assert/strict';
import { aggregateStyle, resolveExpected } from '../dist/core/style/aggregate.js';

const f = (path, counts, lang = 'js') => ({ path, lang, counts });
const q = (single, double) => ({ quotes: { single, double } });

// one vote per file; a tie inside a file does not vote
let s = aggregateStyle([f('a.ts', q(99, 1)), f('b.ts', q(1, 2)), f('c.ts', q(3, 3))]);
assert.deepEqual(s.project.js.quotes, { value: 'mixed', share: 0.5, samples: 2 });

// below 70 percent is mixed, a tie is mixed
s = aggregateStyle([f('a.ts', q(1, 0)), f('b.ts', q(9, 0)), f('c.ts', q(0, 1))]);
assert.deepEqual(s.project.js.quotes, { value: 'mixed', share: 0.67, samples: 3 });
s = aggregateStyle([f('a.ts', q(1, 0)), f('b.ts', q(0, 1))]);
assert.equal(s.project.js.quotes.value, 'mixed');

// folder entries
const files = [];
for (let i = 0; i < 40; i++) files.push(f(`src/a${i}.ts`, q(1, 0)));
for (let i = 0; i < 6; i++) files.push(f(`src/ui/b${i}.ts`, q(0, 1)));
for (let i = 0; i < 4; i++) files.push(f(`src/few/c${i}.ts`, q(0, 1)));
for (let i = 0; i < 6; i++) files.push(f(`src/same/d${i}.ts`, q(1, 0)));
for (let i = 0; i < 6; i++) files.push(f(`src/ui/deep/e${i}.ts`, q(0, 1)));
s = aggregateStyle(files);
assert.equal(s.project.js.quotes.value, 'single');
assert.equal(s.folders['src/ui'].js.quotes.value, 'double');
assert.equal(s.folders['src/few'], undefined);
assert.equal(s.folders['src/same'], undefined);
assert.equal(s.folders['src/ui/deep'], undefined);

// resolution walks up
assert.equal(resolveExpected(s, 'src/ui/x.ts', 'js').quotes, 'double');
assert.equal(resolveExpected(s, 'src/ui/deep/x.ts', 'js').quotes, 'double');
assert.equal(resolveExpected(s, 'src/x.ts', 'js').quotes, 'single');
assert.deepEqual(resolveExpected(s, 'src/x.py', 'python'), {});

// mixed folder falls to parent; mixed project and owned traits give nothing
const st = {
  project: {
    js: {
      quotes: { value: 'single', share: 1, samples: 9 },
      indent: { value: 'mixed', share: 0.5, samples: 9 },
      semicolons: { value: 'always', share: 1, samples: 9, owner: 'prettier' },
    },
  },
  folders: { lib: { js: { quotes: { value: 'mixed', share: 0.5, samples: 6 } } } },
};
assert.deepEqual(resolveExpected(st, 'lib/a.ts', 'js'), { quotes: 'single' });

// pure: input order does not matter
assert.deepEqual(aggregateStyle(files), aggregateStyle([...files].reverse()));
console.log('style aggregate ok');
