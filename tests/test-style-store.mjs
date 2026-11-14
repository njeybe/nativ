import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCodeStyle, saveCodeStyle, validateCodeStyle, mergeScan, styleStaleness, codeStylePath,
} from '../dist/core/style/style-store.js';
import { STYLE_RULES } from '../dist/core/style/style-types.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-style-'));
const decision = (rule, status, count, files = []) =>
  ({ rule, status, evidence: { count, files }, decidedAt: status === 'pending' ? null : '2026-01-01' });
const base = (over = {}) => ({
  version: 1, scannedAt: { commit: 'abc1234', date: '2026-11-14', files: 3 }, languages: ['js'],
  formatters: [], project: {}, folders: {}, decisions: [], patterns: [], ...over,
});

assert.deepEqual(STYLE_RULES.map((r) => r.id), ['raw-sql', 'swallowed-errors', 'config-fallback']);
assert.ok(STYLE_RULES.every((r) => r.title));

// tolerant loading
const root = tmp();
assert.deepEqual(loadCodeStyle(root), { file: null, unreadable: false, problems: [] });
fs.mkdirSync(path.join(root, '.ai'));
fs.writeFileSync(codeStylePath(root), '{ nope');
let bad = loadCodeStyle(root);
assert.ok(bad.unreadable && bad.file === null && bad.problems.length);
fs.writeFileSync(codeStylePath(root), JSON.stringify(base({ version: 2 })));
bad = loadCodeStyle(root);
assert.ok(bad.unreadable && /Version/.test(bad.problems[0]));

// validation
assert.deepEqual(validateCodeStyle(base()), []);
const problems = validateCodeStyle(base({
  project: { js: { quotes: { value: 'single', share: 2, samples: 1 } } },
  decisions: [decision('raw-sql', 'maybe', 1, ['/abs/x', '../y'])],
  patterns: [
    { id: 'pat-01', text: 'x'.repeat(201), evidence: ['a/../b'], scope: [] },
    { id: 'pat-01', text: 'ok', evidence: [], scope: [] },
    { id: 'bad', text: 'ok', evidence: [], scope: [] },
  ],
}));
for (const re of [/share/, /status/, /evidence files/, /at most 200/, /evidence paths/, /twice/, /pat-01/]) {
  assert.ok(problems.some((p) => re.test(p)), String(re));
}

// save and load round trip
const good = base({ decisions: [decision('raw-sql', 'pending', 2, ['a.ts', 'b.ts'])] });
saveCodeStyle(root, good);
assert.deepEqual(loadCodeStyle(root), { file: good, unreadable: false, problems: [] });

// mergeScan
const prev = base({
  decisions: [
    decision('raw-sql', 'nativ', 5, ['a']),
    decision('swallowed-errors', 'pending', 3, ['b']),
    decision('config-fallback', 'codebase', 2, ['c']),
  ],
  patterns: [{ id: 'pat-01', text: 't', evidence: [], scope: [] }],
});
const scan = base({ decisions: [decision('raw-sql', 'pending', 7, ['x', 'y'])] });
const merged = mergeScan(prev, scan);
assert.equal(merged.decisions.length, 2);
const raw = merged.decisions.find((d) => d.rule === 'raw-sql');
assert.deepEqual([raw.status, raw.decidedAt, raw.evidence.count], ['nativ', '2026-01-01', 7]);
const gone = merged.decisions.find((d) => d.rule === 'config-fallback');
assert.deepEqual([gone.status, gone.evidence], ['codebase', { count: 0, files: [] }]);
assert.ok(!merged.decisions.some((d) => d.rule === 'swallowed-errors'));
assert.equal(merged.patterns.length, 1);

// staleness
assert.equal(styleStaleness(tmp(), base()), null);
const repo = tmp();
g(repo, 'init', '-q');
g(repo, 'config', 'user.email', 't@t.t');
g(repo, 'config', 'user.name', 't');
const commit = (n) => {
  fs.writeFileSync(path.join(repo, 'f.txt'), String(n));
  g(repo, '-c', 'core.autocrlf=false', 'add', '-A');
  g(repo, '-c', 'core.autocrlf=false', 'commit', '-qm', `c${n}`);
};
commit(0);
const first = g(repo, 'rev-parse', 'HEAD');
const at = (c) => base({ scannedAt: { commit: c, date: '2026-11-14', files: 1 } });
assert.deepEqual(styleStaleness(repo, at(first)), { behind: 0, gone: false, stale: false });
for (let i = 1; i <= 3; i++) commit(i);
assert.equal(styleStaleness(repo, at(first)).behind, 3);
for (let i = 4; i <= 50; i++) commit(i);
assert.deepEqual(styleStaleness(repo, at(first)), { behind: 50, gone: false, stale: true });
assert.deepEqual(styleStaleness(repo, at('1234567890abcdef1234567890abcdef12345678')),
  { behind: 0, gone: true, stale: true });
assert.equal(styleStaleness(repo, base({ scannedAt: { commit: '', date: '', files: 0 } })), null);
console.log('style store ok');
