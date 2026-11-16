import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStyleDrift } from '../dist/core/style/style-drift.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-drift-'));
const g = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8' });
const put = (p, t) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), t);
};
const entry = (value, extra = {}) => ({ value, share: 0.9, samples: 10, ...extra });
const style = {
  version: 1,
  project: { js: {
    indent: entry('2'), quotes: entry('single'), semicolons: entry('always'),
    fileNaming: entry('kebab'), moduleSystem: entry('esm'), functionNaming: entry('mixed'),
  } },
  folders: {}, decisions: [], patterns: [],
};

put('old.ts', "const a = 'x';\n");
assert.deepEqual(checkStyleDrift(root, ['old.ts']), [], 'no git, no findings');
g('init', '-q');
g('config', 'user.email', 't@t.t');
g('config', 'user.name', 't');
g('add', '-A');
g('commit', '-qm', 'init');
assert.deepEqual(checkStyleDrift(root, ['old.ts']), [], 'no contract, no findings');

put('.ai/code_style.json', JSON.stringify(style));
put('userCard.ts', 'const a = "1";\nconst b = "2";\nconst c = "3";\nconst d = \'4\';\n');
const fresh = checkStyleDrift(root, ['userCard.ts']);
const messages = fresh.map((i) => i.message);
assert.ok(fresh.every((i) => i.kind === 'style-drift' && i.category === 'drift'));
assert.ok(messages.includes('3 of 4 new strings use double; this folder uses single (90%)'), messages.join('|'));
assert.ok(messages.includes('file name userCard.ts is camel; this folder uses kebab (90%)'), messages.join('|'));
assert.equal(fresh.find((i) => i.message.includes('strings')).line, 1);

put('few.ts', 'const a = "1";\nconst b = "2";\n');
assert.ok(!checkStyleDrift(root, ['few.ts']).some((i) => i.message.includes('strings')), 'needs 3+');

put('old.ts', "const a = 'x';\nconst b = \"1\";\nconst c = \"2\";\nconst d = \"3\";\n");
const tracked = checkStyleDrift(root, ['old.ts']);
assert.equal(tracked.length, 1, JSON.stringify(tracked));
assert.equal(tracked[0].line, 2);
assert.ok(tracked[0].message.startsWith('3 of 3 added strings use double'));

style.project.js.quotes = entry('single', { owner: 'prettier' });
put('.ai/code_style.json', JSON.stringify(style));
assert.equal(checkStyleDrift(root, ['old.ts']).length, 0, 'formatter-owned skipped');
style.project.js.quotes = entry('mixed');
put('.ai/code_style.json', JSON.stringify(style));
assert.equal(checkStyleDrift(root, ['old.ts']).length, 0, 'mixed skipped');
fs.rmSync(root, { recursive: true, force: true });
console.log('style-drift ok');
