import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStyleSlice } from '../dist/core/style/style-slice.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-slice-'));
const task = { targetFiles: ['src/components/Card.ts'] };

assert.deepEqual(buildStyleSlice(root, task), { text: '', warnings: [] });

const tr = (value) => ({ value, share: 0.9, samples: 10 });
const style = {
  version: 1,
  scannedAt: { commit: 'abc', date: '2026-01-01', files: 3 },
  languages: ['js'],
  formatters: [],
  project: { js: { indent: tr('2'), quotes: tr('single'), semicolons: tr('mixed') } },
  folders: { 'src/components': { js: { fileNaming: tr('pascal'), exportStyle: tr('default') } } },
  decisions: [
    { rule: 'raw-sql', status: 'pending', evidence: { count: 2, files: ['a.ts'] }, decidedAt: null },
    { rule: 'swallowed-errors', status: 'codebase', evidence: { count: 0, files: [] }, decidedAt: 'x' },
    { rule: 'config-fallback', status: 'pending', evidence: { count: 0, files: [] }, decidedAt: null },
  ],
  patterns: [
    { id: 'pat-01', text: 'Use\nthe api helper', evidence: [], scope: [] },
    { id: 'pat-02', text: 'Only in db', evidence: [], scope: ['src/db/'] },
  ],
};
const write = (doc) => {
  fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ai', 'code_style.json'), JSON.stringify(doc));
};
write(style);
const { text, warnings } = buildStyleSlice(root, task);
assert.deepEqual(warnings, []);
assert.deepEqual(text.split('\n'), [
  "Raw SQL outside the model layer: follow nativ's rule",
  'Errors hidden in defaults: matching the existing code is allowed',
  'src/components: file names pascal, default exports',
  'Use the api helper',
  'formatting: indent 2, quotes single',
]);

style.formatters = [{ tool: 'prettier', config: 'p', language: 'js', owns: ['indent', 'quotes'] }];
write(style);
assert.ok(buildStyleSlice(root, task).text.endsWith('prettier owns formatting'));

const long = (id, ch) => ({ id, text: ch.repeat(190), evidence: [], scope: [] });
style.patterns = [long('pat-01', 'x'), long('pat-02', 'y'), long('pat-03', 'z'), long('pat-04', 'w')];
write(style);
const big = buildStyleSlice(root, task).text;
assert.ok(big.length <= 600);
assert.ok(!big.includes('prettier owns'));
assert.ok(big.split('\n').every((l) => l.length > 0));

fs.writeFileSync(path.join(root, '.ai', 'code_style.json'), '{nope');
const bad = buildStyleSlice(root, task);
assert.equal(bad.text, '');
assert.equal(bad.warnings.length, 1);

g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
fs.writeFileSync(path.join(root, 'a.txt'), 'a');
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'one');
style.scannedAt.commit = 'deadbeef';
write(style);
assert.equal(buildStyleSlice(root, task).warnings.length, 1);
console.log('style slice ok');
