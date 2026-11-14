import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTaskNext } from '../dist/commands/task/task-query.js';
import { runStyleShow } from '../dist/commands/style.js';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-delivery-'));
g(root, 'init', '-q');
g(root, 'config', 'user.email', 't@t.t');
g(root, 'config', 'user.name', 't');
fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
g(root, '-c', 'core.autocrlf=false', 'add', '-A');
g(root, '-c', 'core.autocrlf=false', 'commit', '-qm', 'init');
const head = g(root, 'rev-parse', '--short', 'HEAD').trim();

const task = {
  id: 'task-01', title: 'T', description: '', assignedSubagent: 'backend', dependencies: [],
  targetFiles: ['src/a.ts'], status: 'pending', verificationCommand: 'true', notes: '',
};
const plan = {
  version: '1.0.0', projectName: 'delivery', lastUpdated: new Date().toISOString(),
  overallStatus: 'in_progress', activeMilestoneId: 'm1',
  milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks: [task] }],
};
fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify(plan));

async function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}
const next = async (json) => capture(() => runTaskNext(root, { json }));

// No style file: nothing added
const none = JSON.parse(await next(true)).task;
assert.ok(!('styleSlice' in none));
assert.ok(!('styleWarnings' in none));
assert.ok(!(await next(false)).includes('Code style:'));

const style = {
  version: 1,
  scannedAt: { commit: head, date: '2026-01-01', files: 1 },
  languages: [], formatters: [], project: {}, folders: {},
  decisions: [{ rule: 'raw-sql', status: 'pending', evidence: { count: 2, files: ['a.ts'] }, decidedAt: null }],
  patterns: [],
};
fs.writeFileSync(path.join(root, '.ai', 'code_style.json'), JSON.stringify(style));
const expected = "Raw SQL outside the model layer: follow nativ's rule";

const withStyle = JSON.parse(await next(true)).task;
assert.equal(withStyle.styleSlice, expected);
assert.ok(!('styleWarnings' in withStyle));
const text = await next(false);
assert.ok(text.includes('Code style:'));
assert.ok(text.includes(expected));

// Stale scan adds a warning
style.scannedAt.commit = 'deadbee';
fs.writeFileSync(path.join(root, '.ai', 'code_style.json'), JSON.stringify(style));
const stale = JSON.parse(await next(true)).task;
assert.equal(stale.styleWarnings.length, 1);

// style show --files
const shown = await capture(() => runStyleShow(root, { files: 'src/a.ts, src/b.ts' }));
assert.ok(shown.includes(expected));
const shownJson = JSON.parse(await capture(() => runStyleShow(root, { files: 'src/a.ts', json: true })));
assert.equal(shownJson.text, expected);

fs.rmSync(root, { recursive: true, force: true });
console.log('style delivery ok');
