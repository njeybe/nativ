import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStyleDecide } from '../dist/commands/style-decide.js';
import {
  decideStyleRule, loadCodeStyle, saveCodeStyle, validateCodeStyle,
} from '../dist/core/style/style-store.js';
import { buildDesiredConfig } from '../dist/core/setup/config-merger.js';

process.env.NATIV_HEADLESS_OVERRIDE = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-decide-'));
execFileSync('git', ['init', '-q'], { cwd: root });
fs.mkdirSync(path.join(root, '.ai'));
saveCodeStyle(root, {
  version: 1, scannedAt: { commit: 'abc1234', date: '2026-11-14', files: 3 }, languages: ['js'],
  formatters: [], project: {}, folders: {}, patterns: [],
  decisions: [{ rule: 'config-fallback', status: 'pending', evidence: { count: 2, files: ['a.js'] }, decidedAt: null }],
});
const logs = [];
const orig = console.log;
console.log = (...a) => logs.push(a.join(' '));
const status = () => loadCodeStyle(root).file.decisions[0].status;

await runStyleDecide('bogus', 'nativ', root, { yes: true });
assert.equal(process.exitCode, 1);
process.exitCode = 0;
await runStyleDecide('config-fallback', 'codebase', root, { yes: true });
console.log = orig;
assert.equal(process.exitCode ?? 0, 0);
assert.equal(status(), 'codebase');
assert.ok(logs.some((l) => l.includes('codeStyle.configFallback')));
assert.ok(logs.some((l) => l.includes('a.js')));

// Decider name: written with a name, dropped on a re-decision without one.
const named = decideStyleRule(root, 'config-fallback', 'nativ', 'Test Person');
assert.equal(named.decisions[0].decidedBy, 'Test Person');
const unnamed = decideStyleRule(root, 'config-fallback', 'codebase');
assert.equal('decidedBy' in unnamed.decisions[0], false);
assert.deepEqual(validateCodeStyle(loadCodeStyle(root).file), []);
assert.deepEqual(validateCodeStyle({ version: 1, decisions: [{ rule: 'raw-sql', status: 'pending',
  evidence: { count: 0, files: [] }, decidedAt: null, decidedBy: 42 }], project: {}, folders: {}, patterns: [] })
  .length, 1);
// An existing file without decidedBy stays valid.
const old = { version: 1, scannedAt: { commit: 'abc1234', date: '2026-11-14', files: 3 }, languages: ['js'],
  formatters: [], project: {}, folders: {}, patterns: [],
  decisions: [{ rule: 'config-fallback', status: 'nativ', evidence: { count: 1, files: ['a.js'] },
    decidedAt: '2026-11-14' }] };
assert.deepEqual(validateCodeStyle(old), []);

// Command path with a local git name in an isolated repo.
const named2 = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-decide-name-'));
execFileSync('git', ['init', '-q'], { cwd: named2 });
execFileSync('git', ['config', 'user.name', 'Local Tester'], { cwd: named2 });
fs.mkdirSync(path.join(named2, '.ai'));
saveCodeStyle(named2, { ...old, decisions: [{ rule: 'config-fallback', status: 'pending',
  evidence: { count: 1, files: ['a.js'] }, decidedAt: null }] });
const logs2 = [];
console.log = (...a) => logs2.push(a.join(' '));
await runStyleDecide('config-fallback', 'nativ', named2, { yes: true });
await runStyleDecide('config-fallback', 'codebase', named2, { yes: true });
console.log = orig;
const written = loadCodeStyle(named2).file.decisions[0];
assert.equal(written.decidedBy, 'Local Tester');
assert.equal(written.status, 'codebase');
assert.ok(logs2.some((l) => l.includes('previous choice: nativ') && l.includes('Local Tester')));

const cfg = buildDesiredConfig({ command: 'node', prefixArgs: ['x.js'] });
for (const p of [cfg.cli, 'nativ']) {
  assert.ok(cfg.deny.includes(`Bash(${p} style decide *)`), p);
}
console.log('style decide ok');
