import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDesiredConfig, mergeClaudeSettings, nativHookGroups } from '../dist/core/setup/config-merger.js';
import { resolveCliInvocation } from '../dist/core/setup/types.js';
import { buildRunnerPermissions } from '../dist/runner/cli-config.js';
import { evaluateHookPayload } from '../dist/core/enforcement.js';

console.log('--- Starting Activity Hooks Setup Tests ---');

const desired = buildDesiredConfig(resolveCliInvocation({ command: 'nativ' }));
const EVENTS = ['PreToolUse', 'SessionStart', 'PostToolUse', 'SubagentStart', 'SubagentStop'];

const groups = nativHookGroups(desired);
assert.deepEqual(Object.keys(groups).sort(), [...EVENTS].sort());
assert.equal(groups.PostToolUse.matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash|Agent|Task|mcp__nativ__.*');
assert.equal(groups.SubagentStart.matcher, '*');
assert.equal(groups.SubagentStop.matcher, '*');
assert.match(groups.PreToolUse.matcher, /Agent\|Task/);

// Fresh project: all five events, activity ones async with timeout 10.
const fresh = mergeClaudeSettings({}, desired).merged;
assert.deepEqual(Object.keys(fresh.hooks).sort(), [...EVENTS].sort());
for (const event of ['PostToolUse', 'SubagentStart', 'SubagentStop']) {
  const hook = fresh.hooks[event][0].hooks[0];
  assert.equal(hook.command, 'nativ hook event');
  assert.equal(hook.async, true);
  assert.equal(hook.timeout, 10);
}
for (const event of ['PreToolUse', 'SessionStart']) {
  assert.equal(fresh.hooks[event][0].hooks[0].async, undefined);
}

// Re-run changes nothing.
const again = mergeClaudeSettings(JSON.parse(JSON.stringify(fresh)), desired);
assert.deepEqual(again.changes.filter((c) => c.startsWith('hooks.')), []);
assert.deepEqual(again.merged, fresh);

// Older settings with two events (old matcher) gain the three groups; user groups survive.
const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
const older = {
  hooks: {
    PreToolUse: [
      userGroup,
      {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: 'nativ hook check', timeout: 10 }],
      },
    ],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'nativ hook context', timeout: 10 }] }],
    PostToolUse: [userGroup],
  },
};
const upgraded = mergeClaudeSettings(older, desired);
assert.deepEqual(upgraded.merged.hooks.PreToolUse[0], userGroup);
assert.match(upgraded.merged.hooks.PreToolUse[1].matcher, /Agent\|Task/);
assert.deepEqual(upgraded.merged.hooks.PostToolUse[0], userGroup);
assert.equal(upgraded.merged.hooks.PostToolUse.length, 2);
assert.equal(upgraded.merged.hooks.SubagentStart.length, 1);
assert.equal(upgraded.merged.hooks.SubagentStop.length, 1);

// The runner's settings keep only PreToolUse.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-activity-hooks-'));
const perms = buildRunnerPermissions({ verificationCommand: 'npm test' }, root);
assert.deepEqual(Object.keys(perms.hooks ?? {}), ['PreToolUse']);

// The wider PreToolUse matcher cannot change a decision: spawn tools are not write tools.
for (const tool_name of ['Agent', 'Task']) {
  const check = evaluateHookPayload({ tool_name, tool_input: { prompt: 'x' }, cwd: root });
  assert.equal(check.output, null);
}

fs.rmSync(root, { recursive: true, force: true });
console.log('--- Activity Hooks Setup Tests Passed ---');
