import assert from 'node:assert/strict';
import { measurePython } from '../dist/core/style/measure-python.js';

const src = [
  'import os',
  'from . import sibling',
  'from .pkg import thing',
  'MAX_SIZE = 10',
  'default_name: str = "x"',
  '# comment with "quotes" and def fake_name(self):',
  'class UserCard:',
  '    """Docstring with \'quotes\' and def bad_name():"""',
  '    def get_user(self, user_id: int) -> str:',
  "        name = 'a'",
  '        return "b" + "c"',
  '',
  'def plain_func(a, b=":"):',
  '    x = """not counted \'q\'"""',
  '    return a',
  '',
  'def camelFunc(a):',
  '    return a',
  '',
  'class lower_class:',
  '    pass',
].join('\n');

const c = measurePython('src/user_card.py', src);
assert.deepEqual(c.quotes, { single: 1, double: 4 });
assert.deepEqual(c.indent, { 4: 5 });
assert.deepEqual(c.fileNaming, { snake: 1 });
assert.deepEqual(c.functionNaming, { snake: 2, camel: 1 });
assert.deepEqual(c.classNaming, { pascal: 1, other: 1 });
assert.deepEqual(c.constantNaming, { 'upper-snake': 1, other: 1 });
assert.deepEqual(c.importStyle, { absolute: 1, relative: 2 });
assert.deepEqual(c.typeHints, { yes: 1, no: 2 });

// Ambiguous names do not vote.
for (const f of ['__init__.py', 'utils.py', 'a/index.py', 'Foo.py']) {
  assert.deepEqual(measurePython(f, '').fileNaming, {}, f);
}
assert.deepEqual(measurePython('userCard.test.py', '').fileNaming, { camel: 1 });
assert.deepEqual(measurePython('UserCard.py', '').fileNaming, { pascal: 1 });

// Tabs and 2-space indent.
assert.deepEqual(measurePython('a_b.py', 'if x:\n\ty = 1\n').indent, { tab: 1 });
assert.deepEqual(measurePython('a_b.py', 'if x:\n  y = 1\n').indent, { 2: 1 });
// Continuation lines inside brackets do not count.
assert.deepEqual(measurePython('a_b.py', 'x = [\n    1,\n]\n').indent, {});
console.log('measure-python ok');
