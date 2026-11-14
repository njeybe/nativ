import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStyleDecide } from '../dist/commands/style-decide.js';
import { loadCodeStyle, saveCodeStyle } from '../dist/core/style/style-store.js';
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

const cfg = buildDesiredConfig({ command: 'node', prefixArgs: ['x.js'] });
for (const p of [cfg.cli, 'nativ']) {
  assert.ok(cfg.deny.includes(`Bash(${p} style decide *)`), p);
}
console.log('style decide ok');
