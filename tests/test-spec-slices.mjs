import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

console.log('--- Starting Spec Slices Verification ---');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { resolveSpecSlices, TRUNCATION_MARKER } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'core', 'spec-slices.js')).href);
const execFileAsync = promisify(execFile);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-slices-'));
fs.mkdirSync(path.join(dir, '.ai'), { recursive: true });
fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
fs.writeFileSync(path.join(dir, '.ai', 'ui_specs.md'), [
  '# UI Specs', 'intro', '',
  '## Appointment List', 'List body line', '```', '# not a heading', '```',
  '### Row Details', 'row text', '',
  '## Booking Form!', 'form text', '',
  '## Appointment List', 'second one', '',
].join('\n'));
fs.writeFileSync(path.join(dir, '.ai', 'api_contracts.json'), JSON.stringify({
  paths: { '/appointments': { get: { summary: 'list' } }, 'a~b': { x: 1 } },
  list: [10, 20],
}));
fs.writeFileSync(path.join(dir, '.ai', 'big.md'), '# Big\n' + 'x'.repeat(5000));

try {
  // Heading section: includes sub-headings and fenced pseudo-headings, stops at next same-level heading.
  let r = resolveSpecSlices(dir, ['ui_specs.md#appointment-list']);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.slices.length, 1);
  assert.equal(r.slices[0].file, '.ai/ui_specs.md');
  assert.ok(r.slices[0].text.startsWith('## Appointment List'));
  assert.ok(r.slices[0].text.includes('# not a heading'));
  assert.ok(r.slices[0].text.includes('### Row Details'));
  assert.ok(!r.slices[0].text.includes('form text'));
  assert.equal(r.slices[0].truncated, false);

  // Punctuation slug and duplicate suffix.
  r = resolveSpecSlices(dir, ['ui_specs.md#booking-form', 'ui_specs.md#appointment-list-1']);
  assert.equal(r.slices.length, 2);
  assert.ok(r.slices[1].text.includes('second one'));

  // JSON pointers, escaped tokens, arrays.
  r = resolveSpecSlices(dir, ['api_contracts.json#/paths/~1appointments', 'api_contracts.json#/paths/a~0b', 'api_contracts.json#/list/1']);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(JSON.parse(r.slices[0].text), { get: { summary: 'list' } });
  assert.deepEqual(JSON.parse(r.slices[1].text), { x: 1 });
  assert.equal(JSON.parse(r.slices[2].text), 20);

  // Missing file / anchor / pointer warn without throwing.
  r = resolveSpecSlices(dir, ['nope.md#x', 'ui_specs.md#missing', 'api_contracts.json#/nothing']);
  assert.equal(r.slices.length, 0);
  assert.equal(r.warnings.length, 3);

  // Endpoint refs: method + path, encoded spaces, baseUrl-prefixed path, id, and unknown refs warn.
  fs.writeFileSync(path.join(dir, '.ai', 'api_contracts.json'), JSON.stringify({
    baseUrl: '/api/v1',
    endpoints: [
      { id: 'health-check', path: '/health', method: 'GET' },
      { id: 'create-item', path: '/items', method: 'POST' },
    ],
    paths: { '/legacy': { get: { summary: 'old' } } },
  }));
  r = resolveSpecSlices(dir, [
    'api_contracts.json#GET /health', 'api_contracts.json#get%20/health',
    'api_contracts.json#POST /api/v1/items', 'api_contracts.json#health-check',
    'api_contracts.json#GET /legacy',
  ]);
  assert.equal(r.warnings.length, 0);
  assert.equal(JSON.parse(r.slices[0].text).id, 'health-check');
  assert.equal(JSON.parse(r.slices[1].text).id, 'health-check');
  assert.equal(JSON.parse(r.slices[2].text).id, 'create-item');
  assert.equal(JSON.parse(r.slices[3].text).path, '/health');
  assert.deepEqual(JSON.parse(r.slices[4].text), { summary: 'old' });
  r = resolveSpecSlices(dir, ['api_contracts.json#POST /health', 'api_contracts.json#no-such-id']);
  assert.equal(r.slices.length, 0);
  assert.equal(r.warnings.length, 2);

  // Size caps.
  r = resolveSpecSlices(dir, ['big.md#big'], { maxChars: 100 });
  assert.equal(r.slices[0].truncated, true);
  assert.ok(r.slices[0].text.endsWith(TRUNCATION_MARKER));
  assert.ok(r.slices[0].text.length <= 100 + TRUNCATION_MARKER.length);
  r = resolveSpecSlices(dir, ['big.md#big', 'big.md#big', 'big.md#big'], { maxChars: 100, maxTotalChars: 150 });
  assert.equal(r.slices.length, 2);
  assert.equal(r.warnings.length, 1);

  // Path escape rejected.
  r = resolveSpecSlices(dir, ['../secret.txt', '../../etc/passwd#x', path.join(dir, 'secret.txt')]);
  assert.equal(r.slices.length, 0);
  assert.equal(r.warnings.length, 3);

  // No refs: nothing.
  assert.deepEqual(resolveSpecSlices(dir, undefined), { slices: [], warnings: [] });

  // task next --json wiring and validate warning.
  const task = (id, specRefs) => ({ id, title: id, description: '', assignedSubagent: 'backend', dependencies: [], targetFiles: [], status: 'pending', verificationCommand: '', notes: '', ...(specRefs ? { specRefs } : {}) });
  const writePlan = (t) => fs.writeFileSync(path.join(dir, '.ai', 'master_plan.json'), JSON.stringify({
    version: '1.0.0', projectName: 's', lastUpdated: new Date().toISOString(), overallStatus: 'in_progress',
    activeMilestoneId: 'm1', milestones: [{ id: 'm1', name: 'One', status: 'in_progress', tasks: [t] }],
  }));
  const cli = path.join(repoRoot, 'bin', 'cli.js');

  writePlan(task('task-01', ['ui_specs.md#booking-form', 'ui_specs.md#gone']));
  let out = await execFileAsync(process.execPath, [cli, 'task', 'next', '--json'], { cwd: dir });
  let payload = JSON.parse(out.stdout).task;
  assert.equal(payload.specSlices.length, 1);
  assert.equal(payload.specWarnings.length, 1);
  assert.ok(payload.recommendedContractSlice);

  writePlan(task('task-01'));
  out = await execFileAsync(process.execPath, [cli, 'task', 'next', '--json'], { cwd: dir });
  payload = JSON.parse(out.stdout).task;
  assert.equal(payload.specSlices, undefined);
  assert.equal(payload.priorEscalations, undefined, 'no escalation history, no field');

  // Closed escalations of the task travel with it; open ones and other tasks' do not.
  const esc = (id, taskId, status, extra = {}) => ({
    id, taskId, type: 'schema_flaw', reportedBy: 'backend', timestamp: `2026-01-0${id.slice(-1)}T00:00:00Z`,
    summary: `gap ${id}`, affectedContracts: [], status, ...extra,
  });
  fs.writeFileSync(path.join(dir, '.ai', 'escalation.json'), JSON.stringify({ version: '1.0.0', projectName: 's', lastUpdated: '', escalations: [
    esc('esc-01', 'task-01', 'resolved', { resolutionNotes: 'Added users.bio', resolvedAt: '2026-01-05T00:00:00Z' }),
    esc('esc-02', 'task-01', 'pending_review'),
    esc('esc-03', 'task-02', 'resolved'),
    esc('esc-04', 'task-01', 'dismissed', { resolutionNotes: 'Use the existing route' }),
  ] }));
  out = await execFileAsync(process.execPath, [cli, 'task', 'next', '--json'], { cwd: dir });
  payload = JSON.parse(out.stdout).task;
  assert.deepEqual(payload.priorEscalations.map((e) => e.id), ['esc-04', 'esc-01'], 'closed ones only, oldest first');
  assert.equal(payload.priorEscalations[1].resolutionNotes, 'Added users.bio');
  fs.rmSync(path.join(dir, '.ai', 'escalation.json'));

  writePlan(task('task-01', ['ui_specs.md#gone']));
  out = await execFileAsync(process.execPath, [cli, 'validate'], { cwd: dir }).catch((e) => e);
  assert.ok(String(out.stdout).includes('task-01: specRef "ui_specs.md#gone"'), 'validate warns on unresolved specRefs');

  console.log('✔ Spec slices verified');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
