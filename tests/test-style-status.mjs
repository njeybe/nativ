import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runStatus } from '../dist/commands/status.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
async function status(cwd, ...a) {
  const lines = [];
  const orig = console.log;
  console.log = (x) => lines.push(String(x));
  try {
    await runStatus(cwd, { json: a.includes('--json') });
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-ss-'));
g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'one');
const commit = g(root, 'rev-parse', 'HEAD');
fs.mkdirSync(path.join(root, '.ai'));
const plan = { projectName: 'p', overallStatus: 'in_progress', activeMilestoneId: 'm1', milestones: [] };
fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify(plan));

assert.equal(JSON.parse(await status(root, '--json')).codeStyle, null);
assert.ok(!(await status(root)).includes('Code style'));

const rule = 'raw-sql';
const style = {
  version: 1,
  scannedAt: { commit },
  project: {},
  folders: {},
  decisions: [{ rule, status: 'pending', evidence: { count: 0, files: [] } }],
  patterns: [],
};
fs.writeFileSync(path.join(root, '.ai', 'code_style.json'), JSON.stringify(style));
const out = JSON.parse(await status(root, '--json')).codeStyle;
if (out === null) throw new Error('codeStyle null; check the fixture is valid');
assert.equal(out.commit, commit);
assert.equal(out.behind, 0);
assert.equal(out.stale, false);
assert.equal(out.pending.length, 1);
const text = await status(root);
assert.ok(text.includes(`scanned at ${commit.slice(0, 7)}`));
assert.ok(text.includes('0 commits behind HEAD'));
assert.ok(text.includes('nativ style decide'));
console.log('style status ok');
