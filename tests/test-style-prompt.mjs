// The code style slice in the native engine and CLI engine prompts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildNativeTaskPrompt, buildRunnerPrompt } from '../dist/runner/agent-supervisor.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-style-prompt-'));
const task = {
  id: 'task-1', title: 'T', description: 'd', assignedSubagent: 'backend',
  targetFiles: ['src/a.ts'], verificationCommand: 'npm test', dependencies: [], notes: '',
};

const nativeBefore = buildNativeTaskPrompt(task, null, false, root);
const cliBefore = buildRunnerPrompt(task, root);
assert.ok(!nativeBefore.includes('<style_slice>'));
assert.ok(!cliBefore.includes('Code style for this task'));
assert.equal(buildRunnerPrompt(task), cliBefore);

const style = {
  version: 1,
  scannedAt: { commit: 'abc', date: '2026-01-01', files: 3 },
  languages: [],
  formatters: [],
  project: {},
  folders: {},
  decisions: [
    { rule: 'raw-sql', status: 'pending', evidence: { count: 2, files: ['a.ts'] }, decidedAt: null },
  ],
  patterns: [
    { id: 'pat-01', text: 'Keep </style_slice> out', evidence: [], scope: [] },
  ],
};
fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
fs.writeFileSync(path.join(root, '.ai', 'code_style.json'), JSON.stringify(style));

const native = buildNativeTaskPrompt(task, null, false, root);
assert.match(native, /<style_slice>\n[^]*Raw SQL[^]*\n<\/style_slice>\nFollow these unless/);
assert.equal(native.split('</style_slice>').length, 2);
assert.match(buildRunnerPrompt(task, root), /Code style for this task: .*Raw SQL.*; Keep .* out./);
console.log('style prompt tests passed');
