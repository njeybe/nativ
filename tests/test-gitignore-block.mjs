import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyBlock, listGeneratedPaths, trackedNativPaths, BLOCK_START, BLOCK_END,
} from '../dist/core/setup/gitignore-block.js';
import { stampManaged } from '../dist/core/setup/types.js';

console.log('--- Starting Gitignore Block Tests ---');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-gi-'));
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

// idempotent, in place, outside text and CRLF kept
const paths = ['/.ai/', '/.nativ/'];
const once = applyBlock('node_modules/\n', paths);
assert.equal(applyBlock(once, paths), once);
assert.ok(once.startsWith('node_modules/\n') && once.includes(BLOCK_START) && once.includes(BLOCK_END));
const updated = applyBlock(once + 'dist/\n', ['/.ai/']);
assert.ok(!updated.includes('/.nativ/') && updated.endsWith('dist/\n'));
const crlf = applyBlock('a\r\nb\r\n', paths);
assert.ok(!/[^\r]\n/.test(crlf) && applyBlock(crlf, paths) === crlf);
assert.equal(applyBlock(null, paths).split('\n')[0], BLOCK_START);

// listing
const root = tmp();
put(root, 'AGENTS.md', stampManaged('# Directive'));
put(root, 'CLAUDE.md', '# My own notes\n');
put(root, 'GEMINI.md', '# Gemini / Antigravity directive\n\n@AGENTS.md\n');
put(root, '.claude/agents/worker.md', stampManaged('worker'));
put(root, '.claude/agents/mine.md', 'custom');
put(root, '.mcp.json', JSON.stringify({ mcpServers: { nativ: { command: 'nativ' } } }));
put(root, '.claude/settings.json', JSON.stringify({
  permissions: { allow: ['Bash(nativ *)'] },
  hooks: { PreToolUse: [{ hooks: [{ command: 'nativ hook check' }] }] },
}));
const hidden = listGeneratedPaths(root);
for (const p of ['/.ai/', '/.nativ/', '/.worktrees/', '/AGENTS.md', '/GEMINI.md',
  '/.claude/agents/worker.md', '/.mcp.json', '/.claude/settings.json']) assert.ok(hidden.includes(p), p);
assert.ok(!hidden.includes('/CLAUDE.md') && !hidden.includes('/.claude/agents/mine.md'));
assert.ok(!hidden.includes('/.claude/agents/') && !hidden.includes('/.claude/agents/architect.md'));

put(root, '.mcp.json', JSON.stringify({ mcpServers: { nativ: {}, other: {} } }));
put(root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
const mixed = listGeneratedPaths(root);
assert.ok(!mixed.includes('/.mcp.json') && !mixed.includes('/.claude/settings.json'));

const shared = listGeneratedPaths(root, 'shared');
assert.deepEqual(shared, ['/.nativ/*.local.json', '/.nativ/logs/', '/.nativ/*.log',
  '/.nativ/notify-state.json', '/.worktrees/']);

// tracked paths
assert.deepEqual(trackedNativPaths(root, hidden), { tracked: [], command: '' });
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
git('init', '-q');
git('add', 'AGENTS.md', '.claude/agents/worker.md');
const t = trackedNativPaths(root, hidden);
assert.deepEqual(t.tracked, ['AGENTS.md', '.claude/agents/worker.md']);
assert.equal(t.command, 'git rm --cached -r -- AGENTS.md .claude/agents/worker.md');
assert.ok(git('ls-files').stdout.includes('AGENTS.md'));

console.log('--- Gitignore Block Tests Passed ---');
