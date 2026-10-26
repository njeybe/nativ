import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyBlock, listGeneratedPaths, trackedNativPaths, BLOCK_START, BLOCK_END,
} from '../dist/core/setup/gitignore-block.js';
import { buildDesiredConfig, mergeClaudeSettings, mergeMcpConfig } from '../dist/core/setup/config-merger.js';
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
const desired = buildDesiredConfig({ command: 'nativ', prefixArgs: [], portable: true });
const generated = mergeClaudeSettings({}, desired).merged;
put(root, '.mcp.json', JSON.stringify(mergeMcpConfig({}, desired).merged));
put(root, '.claude/settings.json', JSON.stringify(generated));
const hidden = listGeneratedPaths(root);
for (const p of ['/.ai/', '/.nativ/', '/.worktrees/', '/AGENTS.md', '/GEMINI.md',
  '/.claude/agents/worker.md', '/.mcp.json', '/.claude/settings.json']) assert.ok(hidden.includes(p), p);
assert.ok(!hidden.includes('/CLAUDE.md') && !hidden.includes('/.claude/agents/mine.md'));
assert.ok(!hidden.includes('/.claude/agents/') && !hidden.includes('/.claude/agents/architect.md'));

put(root, '.mcp.json', JSON.stringify({ mcpServers: { nativ: {}, other: {} } }));
put(root, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
const mixed = listGeneratedPaths(root);
assert.ok(!mixed.includes('/.mcp.json') && !mixed.includes('/.claude/settings.json'));

// user entries that merely mention nativ keep the files out
const setSettings = (v) => put(root, '.claude/settings.json', JSON.stringify(v));
const settingsListed = () => listGeneratedPaths(root).includes('/.claude/settings.json');
const withAllow = (e) => ({ ...generated, permissions: { ...generated.permissions,
  allow: [...generated.permissions.allow, e] } });
setSettings(withAllow('Bash(echo nativ-notes:*)'));
assert.ok(!settingsListed());
setSettings(withAllow('Bash(node cli.js)'));
assert.ok(!settingsListed());
setSettings({ ...generated, hooks: { ...generated.hooks, PreToolUse: [
  ...generated.hooks.PreToolUse,
  { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo nativ-note', timeout: 5 }] }] } });
assert.ok(!settingsListed());
setSettings({ ...generated, hooks: { ...generated.hooks, Stop: generated.hooks.PreToolUse } });
assert.ok(!settingsListed());
setSettings(generated);
assert.ok(settingsListed());
// a custom invocation is still recognised
const npx = buildDesiredConfig({ command: 'npx', prefixArgs: ['-y', '@scope/tool'], portable: true });
setSettings(mergeClaudeSettings({}, npx).merged);
assert.ok(settingsListed());
put(root, '.mcp.json', JSON.stringify(mergeMcpConfig({}, npx).merged));
assert.ok(listGeneratedPaths(root).includes('/.mcp.json'));
// regression: setup with a custom node <abs path> over an earlier default setup
const abs = path.resolve('bin', 'cli.js');
const node = buildDesiredConfig({ command: 'node', prefixArgs: [abs], portable: false });
const layered = mergeClaudeSettings(mergeClaudeSettings({}, desired).merged, node).merged;
setSettings(layered);
assert.ok(settingsListed());
setSettings({ ...layered, permissions: { ...layered.permissions, deny: [...layered.permissions.deny, 'Bash(ls *)'] } });
assert.ok(!settingsListed());
put(root, '.mcp.json', JSON.stringify(mergeMcpConfig({}, node).merged));
assert.ok(listGeneratedPaths(root).includes('/.mcp.json'));
put(root, '.mcp.json', JSON.stringify({ mcpServers: { nativ: { command: 'echo', args: ['hi'] } } }));
assert.ok(!listGeneratedPaths(root).includes('/.mcp.json'));
put(root, '.mcp.json', JSON.stringify({ mcpServers: { nativ: { command: 'nativ', args: ['mcp'], env: {} } } }));
assert.ok(!listGeneratedPaths(root).includes('/.mcp.json'));

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
