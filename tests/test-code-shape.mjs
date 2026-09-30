import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCodeShape, formatCodeShapeReport } from '../dist/core/code-shape.js';
import { verifyBatch } from '../dist/core/verifier.js';

console.log('--- Starting Code Shape Check Tests ---');

function fixture(config, verificationCommand = 'node -e "process.exit(0)"') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-shape-test-'));
  fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  if (config) {
    fs.mkdirSync(path.join(dir, '.nativ'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.nativ', 'config.json'), JSON.stringify(config));
  }
  const long = 'const x = "' + 'a'.repeat(130) + '";\n';
  const comment = '// one\n// two\n// three\nconst y = 1;\n';
  const header = '/* license\n * more\n * lines\n */\nconst z = 1;\n';
  const jsdoc = '/**\n * a\n * b\n * c\n */\nexport function f() {}\n';
  fs.writeFileSync(path.join(dir, 'a.ts'), 'const ok = 1;\n' + long + comment);
  fs.writeFileSync(path.join(dir, 'exempt.ts'), header + jsdoc);
  fs.writeFileSync(path.join(dir, 'dist', 'gen.js'), long);
  fs.writeFileSync(path.join(dir, 'notes.md'), long);
  const plan = {
    projectName: 'shape', overallStatus: 'in_progress', activeMilestoneId: 'm1',
    lastUpdated: new Date().toISOString(),
    milestones: [{
      id: 'm1', name: 'M', status: 'in_progress',
      tasks: [{
        id: 't1', title: 'T', assignedSubagent: 'backend', dependencies: [],
        targetFiles: ['a.ts'], status: 'in_progress', verificationCommand, notes: '',
      }],
    }],
  };
  fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify(plan));
  return dir;
}

const files = ['a.ts', 'exempt.ts', 'dist/gen.js', 'notes.md', 'missing.ts'];

// Defaults: long line and long comment in a.ts only.
let dir = fixture();
let report = checkCodeShape(dir, files);
assert.equal(report.mode, 'warn');
assert.deepEqual(report.issues.map((i) => `${i.file}:${i.line}:${i.kind}`), [
  'a.ts:2:long-line', 'a.ts:3:long-comment',
]);
assert.match(formatCodeShapeReport(report), /a\.ts:2 line is 143 characters/);
console.log('✔ defaults, skips and exemptions');

// Custom settings.
dir = fixture({ codeStyle: { maxLineLength: 200, maxCommentLines: 5 } });
assert.equal(checkCodeShape(dir, files).issues.length, 0);
assert.equal(formatCodeShapeReport(checkCodeShape(dir, files)), '');
dir = fixture({ codeStyle: { mode: 'off' } });
assert.equal(checkCodeShape(dir, files).issues.length, 0);
console.log('✔ config overrides and off mode');

// Warn mode never changes pass/fail.
dir = fixture();
let batch = await verifyBatch(dir, { taskId: 't1' });
assert.equal(batch.passed, 1);
assert.equal(batch.failed, 0);
assert.equal(batch.tasks[0].result.codeShape.issues.length, 2);
console.log('✔ warn mode keeps verification passing');

// Block mode fails with a clear reason.
dir = fixture({ codeStyle: { mode: 'block' } });
batch = await verifyBatch(dir, { taskId: 't1' });
assert.equal(batch.failed, 1);
assert.match(batch.tasks[0].result.error, /Code shape check failed/);
console.log('✔ block mode fails verification');

// task complete still completes in warn mode and prints the warning to stderr.
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
dir = fixture();
const done = spawnSync(process.execPath, [cli, 'task', 'complete', 't1', dir], { encoding: 'utf8' });
assert.equal(done.status, 0, done.stderr);
assert.match(done.stderr, /a\.ts:2 line is 143 characters/);
assert.doesNotMatch(done.stdout, /143 characters/);
const saved = JSON.parse(fs.readFileSync(path.join(dir, '.ai', 'master_plan.json'), 'utf8'));
assert.equal(saved.milestones[0].tasks[0].status, 'completed');
console.log('✔ task complete warns on stderr and still completes');

console.log('--- Code Shape Check Tests Passed ---');
