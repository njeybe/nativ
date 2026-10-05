import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  checkWrite,
  evaluateHookPayload,
  extractWritePath,
  matchesTarget,
  isSecretPath,
  addTaskUnlock,
  isTaskUnlocked,
  toProjectRelative,
} from '../dist/core/enforcement.js';
import { runHookCheck, getHookStatus } from '../dist/commands/hook.js';
import { runTaskUnlock } from '../dist/commands/task.js';

/** Runs fn as if from an interactive terminal: the human-only commands refuse to run headless. */
async function asHuman(fn) {
  const before = [process.stdin.isTTY, process.stdout.isTTY];
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
  try {
    return await fn();
  } finally {
    [process.stdin.isTTY, process.stdout.isTTY] = before;
  }
}

/** Runs fn as if without an interactive terminal: verifies human-only commands refuse to run headless. */
async function asHeadless(fn) {
  const before = [process.stdin.isTTY, process.stdout.isTTY];
  process.stdin.isTTY = false;
  process.stdout.isTTY = false;
  try {
    return await fn();
  } finally {
    [process.stdin.isTTY, process.stdout.isTTY] = before;
  }
}

import { recordRoleViolation, MAX_ROLE_VIOLATIONS } from '../dist/core/telemetry.js';

console.log('--- Starting Role Enforcement Tests ---');

// Enforcement reads NATIV_ROLE; keep the ambient environment from deciding any result.
delete process.env.NATIV_ROLE;

const CLI = path.resolve('bin', 'cli.js');

function project({ tasks, mode } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-enforce-'));
  fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
  const defaults = [
    { id: 'task-a', status: 'in_progress', targetFiles: ['src/a.ts', 'docs/', 'tests/*.mjs', 'lib/**/*.ts'] },
    { id: 'task-b', status: 'pending', targetFiles: ['src/b.ts'] },
  ];
  fs.writeFileSync(
    path.join(root, '.ai', 'master_plan.json'),
    JSON.stringify({ version: '1.0.0', projectName: 'p', milestones: [{ id: 'm1', name: 'M', status: 'in_progress', tasks: tasks ?? defaults }] }, null, 2),
    'utf8',
  );
  if (mode) {
    fs.mkdirSync(path.join(root, '.nativ'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nativ', 'config.json'), JSON.stringify({ enforcement: mode }), 'utf8');
  }
  return root;
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const at = (root, ...parts) => path.join(root, ...parts);

/** Exactly the shape Claude Code delivered to a PreToolUse hook when captured live (file_path, not path). */
const payload = (root, tool, filePath, extra = {}) => ({
  session_id: 'bf4dde4b-5d97-47f2-bba8-bc3ea1e45039',
  transcript_path: at(root, 'transcript.jsonl'),
  cwd: root,
  permission_mode: 'acceptEdits',
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: tool === 'Edit' ? { file_path: filePath, old_string: 'hello', new_string: 'world', replace_all: false } : { file_path: filePath, content: 'hi' },
  tool_use_id: 'toolu_01BUqYha38YZ3hotjDHnjDMe',
  ...extra,
});

// Test 1: in-scope writes are allowed: exact file, directory prefix, glob, recursive glob
{
  const root = project();
  for (const rel of ['src/a.ts', 'docs/guide.md', 'docs/deep/er/page.md', 'tests/x.mjs', 'lib/one/two/mod.ts']) {
    const r = checkWrite({ filePath: at(root, ...rel.split('/')), toolName: 'Write', cwd: root });
    assert.equal(r.decision, 'allow', `${rel} must be allowed (${r.reason})`);
    assert.deepEqual(r.taskIds, ['task-a']);
  }
  assert.equal(checkWrite({ filePath: 'src/a.ts', toolName: 'Edit', cwd: root }).decision, 'allow', 'relative paths resolve against cwd');
  assert.ok(matchesTarget('docs/guide.md', 'docs/') && !matchesTarget('docsx/a.md', 'docs/'), 'directory prefix needs the slash boundary');
  assert.ok(!matchesTarget('tests/sub/x.mjs', 'tests/*.mjs'), 'a single * does not cross directories');
  cleanup(root);
  console.log('✔ Test 1: exact files, directories and globs in targetFiles are allowed');
}

// Test 2: out-of-scope writes warn by default and say what to do instead
{
  const root = project();
  const r = checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root });
  assert.equal(r.decision, 'warn', 'warn is the default mode');
  assert.equal(r.mode, 'warn');
  assert.equal(r.rule, 'out_of_scope');
  assert.equal(r.relPath, 'src/other.ts');
  assert.match(r.reason, /task-a/);
  assert.match(r.reason, /nativ task escalate/, 'the agent is told to escalate instead');

  const { output, result } = evaluateHookPayload(payload(root, 'Write', at(root, 'src', 'other.ts')));
  assert.equal(result.decision, 'warn');
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /outside the target files of task task-a/);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined, 'warn never denies');
  cleanup(root);
  console.log('✔ Test 2: an out-of-scope write warns with additionalContext and never denies');
}

// Test 3: block mode denies with the reason Claude Code shows the model
{
  const root = project({ mode: 'block' });
  const { output, result } = evaluateHookPayload(payload(root, 'Edit', at(root, 'src', 'other.ts')));
  assert.equal(result.decision, 'deny');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /outside the target files/);
  assert.equal(evaluateHookPayload(payload(root, 'Edit', at(root, 'src', 'a.ts'))).output, null, 'in-scope stays silent in block mode');

  assert.equal(checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root, mode: 'off' }).decision, 'allow', 'an explicit mode overrides config');
  fs.writeFileSync(at(root, '.nativ', 'config.json'), JSON.stringify({ enforcement: 'off' }), 'utf8');
  assert.equal(checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root }).decision, 'allow', 'off disables the check');
  fs.writeFileSync(at(root, '.nativ', 'config.json'), '{nope', 'utf8');
  assert.equal(checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root }).mode, 'warn', 'a corrupt config falls back to warn');
  cleanup(root);
  console.log('✔ Test 3: block denies, off disables, a bad config falls back to warn');
}

// Test 4: contracts are protected from workers, open to the architect, and traversal cannot dodge it
{
  const root = project({ mode: 'block' });
  for (const rel of ['.ai/db_schema.json', '.ai/api_contracts.json', '.ai/ui_specs.md', '.ai/master_plan.json', '.ai/context.md', '.ai/subagents/backend.md']) {
    const r = checkWrite({ filePath: at(root, ...rel.split('/')), toolName: 'Write', cwd: root });
    assert.equal(r.decision, 'deny', `${rel} must be protected`);
    assert.equal(r.rule, 'protected_path');
    assert.match(r.reason, /propose-patch|escalate/);
  }
  assert.equal(checkWrite({ filePath: at(root, 'src', '..', '.ai', 'db_schema.json'), toolName: 'Write', cwd: root }).rule, 'protected_path', '.. segments are resolved first');
  for (const role of [undefined, 'architect']) {
    const r = checkWrite({ filePath: at(root, '.nativ', 'config.json'), toolName: 'Edit', cwd: root, role });
    assert.equal(r.decision, 'deny', `nativ settings are protected from ${role ?? 'workers'}`);
    assert.match(r.reason, /only the operator changes/);
  }
  if (process.platform === 'win32') {
    assert.equal(checkWrite({ filePath: at(root, '.AI', 'DB_SCHEMA.JSON'), toolName: 'Write', cwd: root }).rule, 'protected_path', 'case-insensitive filesystems');
  }
  assert.equal(checkWrite({ filePath: at(root, '.ai', 'db_schema.json'), toolName: 'Write', cwd: root, role: 'architect' }).decision, 'allow', 'the architect edits contracts');
  process.env.NATIV_ROLE = 'Architect';
  assert.equal(checkWrite({ filePath: at(root, '.ai', 'db_schema.json'), toolName: 'Write', cwd: root }).decision, 'allow', 'NATIV_ROLE selects the architect (case-insensitive)');
  assert.equal(checkWrite({ filePath: at(root, 'src', 'anything.ts'), toolName: 'Write', cwd: root }).decision, 'allow', 'the architect is not bound to a worker task scope');
  delete process.env.NATIV_ROLE;
  assert.equal(checkWrite({ filePath: at(root, '.ai', 'db_schema.json'), toolName: 'Write', cwd: root, role: 'worker' }).decision, 'deny');
  cleanup(root);
  console.log('✔ Test 4: .ai/ is protected from workers, open to the architect, and immune to traversal');
}

// Test 5: secret files are protected for every role; example env files are not
{
  const root = project({ mode: 'block' });
  for (const rel of ['.env', '.env.local', '.env.production', 'config/.env', '.nativ/db.local.json', '.agentj/x.local.json', 'certs/server.pem', 'certs/private.key']) {
    for (const role of ['worker', 'architect']) {
      const r = checkWrite({ filePath: at(root, ...rel.split('/')), toolName: 'Write', cwd: root, role });
      assert.equal(r.decision, 'deny', `${rel} must be protected for ${role}`);
      assert.equal(r.rule, 'secret_path');
    }
  }
  for (const rel of ['.env.example', '.env.sample', '.env.template', 'src/environment.ts']) {
    assert.equal(isSecretPath(rel), false, `${rel} is not a secret`);
  }
  cleanup(root);
  console.log('✔ Test 5: secret files are off limits to everyone; example env files are fine');
}

// Test 6: with no task in progress only contracts and secrets are protected
{
  const root = project({ tasks: [{ id: 'task-a', status: 'pending', targetFiles: ['src/a.ts'] }], mode: 'block' });
  assert.equal(checkWrite({ filePath: at(root, 'src', 'anything.ts'), toolName: 'Write', cwd: root }).decision, 'allow');
  assert.equal(checkWrite({ filePath: at(root, '.ai', 'context.md'), toolName: 'Write', cwd: root }).decision, 'deny');
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-enforce-bare-'));
  assert.equal(checkWrite({ filePath: at(bare, 'x.ts'), toolName: 'Write', cwd: bare }).decision, 'allow', 'a directory with no plan at all');
  cleanup(root);
  cleanup(bare);
  console.log('✔ Test 6: no active task means no scope rule');
}

// Test 7: worktree agents are judged by their own task, at the same relative paths
{
  const root = project({
    mode: 'block',
    tasks: [
      { id: 'task-a', status: 'in_progress', targetFiles: ['src/a.ts'] },
      { id: 'task-b', status: 'in_progress', targetFiles: ['src/b.ts'] },
    ],
  });
  const wt = at(root, '.worktrees', 'task-task-b');
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });

  assert.equal(toProjectRelative(root, at(wt, 'src', 'b.ts'), wt), 'src/b.ts', 'a worktree path maps to the main-tree path');
  assert.equal(checkWrite({ filePath: at(wt, 'src', 'b.ts'), toolName: 'Write', cwd: wt }).decision, 'allow', 'task-b may edit src/b.ts in its worktree');
  const cross = checkWrite({ filePath: at(wt, 'src', 'a.ts'), toolName: 'Write', cwd: wt });
  assert.equal(cross.decision, 'deny', "task-b's worktree agent may not edit task-a's file");
  assert.deepEqual(cross.taskIds, ['task-b'], 'judged against its own task only');
  assert.equal(checkWrite({ filePath: at(wt, '.ai', 'context.md'), toolName: 'Write', cwd: wt }).rule, 'protected_path', 'the linked .ai/ is still protected');

  // From the main checkout, either task's files are fine
  assert.equal(checkWrite({ filePath: at(root, 'src', 'a.ts'), toolName: 'Write', cwd: root }).decision, 'allow');
  assert.equal(checkWrite({ filePath: at(root, 'src', 'b.ts'), toolName: 'Write', cwd: root }).decision, 'allow');
  cleanup(root);
  console.log('✔ Test 7: worktree agents are scoped to their own task');
}

// Test 8: outside the project is none of our business
{
  const root = project({ mode: 'block' });
  const elsewhere = path.join(os.tmpdir(), 'nativ-elsewhere', 'notes.txt');
  assert.equal(checkWrite({ filePath: elsewhere, toolName: 'Write', cwd: root }).decision, 'allow');
  assert.equal(checkWrite({ filePath: elsewhere, toolName: 'Write', cwd: root }).relPath, null);
  assert.equal(checkWrite({ filePath: path.join('..', 'sibling', 'x.ts'), toolName: 'Write', cwd: root }).decision, 'allow');
  cleanup(root);
  console.log('✔ Test 8: paths outside the project are allowed');
}

// Test 9: unlock lifts scope only, for in-progress tasks, and can be revoked
{
  const root = project({ mode: 'block' });
  const out = () => checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root });
  assert.equal(out().decision, 'deny');

  const logs = [];
  const realLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    process.exitCode = undefined;
    await asHeadless(() => runTaskUnlock('task-a', root, { reason: 'headless' }));
    assert.equal(process.exitCode, 1, 'a headless unlock is refused');
    assert.equal(isTaskUnlocked(root, 'task-a'), false);
    process.exitCode = undefined;
    await asHuman(() => runTaskUnlock('task-a', root, { reason: 'refactor touches shared file' }));
    assert.equal(isTaskUnlocked(root, 'task-a'), true);
    assert.equal(out().decision, 'allow', 'an unlocked task may edit outside targetFiles');
    assert.equal(checkWrite({ filePath: at(root, '.ai', 'context.md'), toolName: 'Write', cwd: root }).decision, 'deny', 'contracts stay protected');
    assert.equal(checkWrite({ filePath: at(root, '.env'), toolName: 'Write', cwd: root }).decision, 'deny', 'secrets stay protected');
    assert.equal(getHookStatus(root).activeTasks[0].unlocked, true);
    assert.match(fs.readFileSync(at(root, '.nativ', 'unlocks.json'), 'utf8'), /refactor touches shared file/);

    await runTaskUnlock('task-a', root, { revoke: true });
    assert.equal(out().decision, 'deny', 're-locked');
    process.exitCode = undefined;
    await asHuman(() => runTaskUnlock('task-missing', root, {}));
    assert.equal(process.exitCode, 1, 'unknown task is an error');
    process.exitCode = undefined;
  } finally {
    console.log = realLog;
  }

  // An unlock on a task that is no longer in progress does nothing
  const plan = JSON.parse(fs.readFileSync(at(root, '.ai', 'master_plan.json'), 'utf8'));
  plan.milestones[0].tasks[0].status = 'completed';
  fs.writeFileSync(at(root, '.ai', 'master_plan.json'), JSON.stringify(plan), 'utf8');
  addTaskUnlock(root, 'task-a');
  assert.equal(out().decision, 'allow', 'no task in progress: nothing to enforce');
  cleanup(root);

  const server = fs.readFileSync(path.resolve('dist', 'mcp', 'server.js'), 'utf8');
  assert.ok(!/unlock/i.test(server), 'unlock must not be exposed through MCP: an agent could remove its own guardrail');
  console.log('✔ Test 9: unlock lifts scope only, is revocable, and is not an MCP tool');
}

// Test 10: tolerant of path field variants, ignores tools that do not write
{
  const root = project({ mode: 'block' });
  assert.equal(extractWritePath({ file_path: 'a' }), 'a');
  assert.equal(extractWritePath({ notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(extractWritePath({ path: 'p' }), 'p', 'the unverified `path` field is still tolerated');
  assert.equal(extractWritePath({ file_path: '  ' }), null);
  assert.equal(extractWritePath('nope'), null);

  const nb = evaluateHookPayload({ ...payload(root, 'Write', ''), tool_name: 'NotebookEdit', tool_input: { notebook_path: at(root, 'nb', 'x.ipynb'), new_source: '1' } });
  assert.equal(nb.result.decision, 'deny', 'NotebookEdit is checked via notebook_path');
  const multi = evaluateHookPayload({ ...payload(root, 'Write', ''), tool_name: 'MultiEdit', tool_input: { file_path: at(root, 'src', 'other.ts'), edits: [] } });
  assert.equal(multi.result.decision, 'deny', 'MultiEdit is checked');

  for (const tool of ['Read', 'Bash', 'Grep', 'WebFetch']) {
    const r = evaluateHookPayload({ ...payload(root, 'Write', at(root, '.env')), tool_name: tool });
    assert.deepEqual(r, { output: null, result: null }, `${tool} is not a write tool`);
  }
  cleanup(root);
  console.log('✔ Test 10: path field variants handled; non-write tools ignored');
}

// Test 11: malformed input never throws or blocks
{
  for (const bad of [null, undefined, 42, 'str', [], {}, { tool_name: 'Write' }, { tool_name: 'Write', tool_input: null }, { tool_name: 'Write', tool_input: { file_path: 5 } }]) {
    assert.deepEqual(evaluateHookPayload(bad), { output: null, result: null }, `payload ${JSON.stringify(bad)} is ignored`);
  }
  for (const stdin of ['', '   ', 'not json {{{', '{"tool_name":', 'null', '[]']) {
    let printed = '';
    await runHookCheck(undefined, { input: Readable.from([stdin]), output: (t) => (printed += t) });
    assert.equal(printed, '', `stdin ${JSON.stringify(stdin)} produces no decision`);
  }
  console.log('✔ Test 11: malformed or empty input fails open with no output');
}

// Test 12: the hook records violations to telemetry and stays quiet for legitimate edits
{
  const root = project({ mode: 'warn' });
  const run = async (filePath, tool = 'Write') => {
    let printed = '';
    await runHookCheck(undefined, { input: Readable.from([JSON.stringify(payload(root, tool, filePath))]), output: (t) => (printed += t) });
    return printed;
  };
  const telemetryFile = at(root, '.ai', 'telemetry.json');

  assert.equal(await run(at(root, 'src', 'a.ts')), '', 'in-scope edits print nothing');
  assert.ok(!fs.existsSync(telemetryFile) || !JSON.parse(fs.readFileSync(telemetryFile, 'utf8') || '{}').violations, 'and log nothing');

  const printed = await run(at(root, 'src', 'other.ts'), 'Edit');
  assert.match(JSON.parse(printed).hookSpecificOutput.additionalContext, /outside the target files/);
  await run(at(root, '.env'));

  const telemetry = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
  assert.equal(telemetry.violations.length, 2);
  assert.deepEqual(telemetry.violations.map((v) => [v.rule, v.mode, v.tool, v.path]), [
    ['out_of_scope', 'warn', 'Edit', 'src/other.ts'],
    ['secret_path', 'warn', 'Write', '.env'],
  ]);
  assert.deepEqual(telemetry.violations[0].taskIds, ['task-a']);
  assert.equal(telemetry.summary.roleViolations, 2);
  assert.ok(!('content' in telemetry.violations[0]) && !JSON.stringify(telemetry).includes('"hi"'), 'file contents are never logged');
  cleanup(root);

  // A project that does not use nativ is never touched
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-enforce-none-'));
  let bareOut = '';
  await runHookCheck(undefined, { input: Readable.from([JSON.stringify(payload(bare, 'Write', at(bare, '.env')))]), output: (t) => (bareOut += t) });
  assert.ok(bareOut.includes('secret'), 'the secret write is still flagged');
  assert.ok(!fs.existsSync(at(bare, '.ai')), 'no .ai/ directory is created in a non-nativ project');
  cleanup(bare);
  console.log('✔ Test 12: violations are logged (paths only); legitimate edits and non-nativ projects are untouched');
}

// Test 13: the violation log is capped
{
  const root = project();
  for (let i = 0; i < MAX_ROLE_VIOLATIONS + 5; i++) {
    await recordRoleViolation(root, { rule: 'out_of_scope', mode: 'warn', tool: 'Write', path: `f${i}.ts`, taskIds: ['task-a'] });
  }
  const telemetry = JSON.parse(fs.readFileSync(at(root, '.ai', 'telemetry.json'), 'utf8'));
  assert.equal(telemetry.violations.length, MAX_ROLE_VIOLATIONS);
  assert.equal(telemetry.violations[0].path, 'f5.ts', 'the oldest entries age out');
  assert.equal(telemetry.summary.roleViolations, MAX_ROLE_VIOLATIONS + 5, 'the counter keeps the true total');
  cleanup(root);
  console.log('✔ Test 13: the violation log is capped while the counter keeps the total');
}

// Test 14: the real CLI, over stdin, exits 0 whatever it is fed
{
  const root = project({ mode: 'block' });
  const run = (input, args = ['hook', 'check', root]) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', cwd: root, timeout: 30_000 });

  const started = Date.now();
  const denied = run(JSON.stringify(payload(root, 'Write', at(root, 'src', 'other.ts'))));
  const elapsed = Date.now() - started;
  assert.equal(denied.status, 0, `exit code must be 0 even when denying: ${denied.stderr}`);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  console.log(`  (hook round-trip through the CLI: ${elapsed}ms)`);

  const allowed = run(JSON.stringify(payload(root, 'Write', at(root, 'src', 'a.ts'))));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');

  const garbage = run('this is not json');
  assert.equal(garbage.status, 0, 'garbage input still exits 0');
  assert.equal(garbage.stdout, '');
  assert.match(garbage.stderr, /not JSON/);

  const status = run('', ['hook', 'status', root, '--json']);
  assert.equal(status.status, 0);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.mode, 'block');
  assert.deepEqual(parsed.activeTasks.map((t) => t.id), ['task-a']);

  const headless = run('', ['task', 'unlock', 'task-a', root, '--reason', 'cli test']);
  assert.equal(headless.status, 1, 'the CLI refuses a headless unlock');
  await asHuman(() => runTaskUnlock('task-a', root, { reason: 'cli test' }));
  assert.equal(JSON.parse(run(JSON.stringify(payload(root, 'Write', at(root, 'src', 'other.ts')))).stdout || '{}').hookSpecificOutput, undefined, 'unlocked through the CLI');
  cleanup(root);
  console.log('✔ Test 14: the CLI hook answers over stdin, always exits 0, and unlock works end to end');
}

// Test 15: inside a subagent the payload's agent_type decides the role
{
  const root = project({ mode: 'block' });
  const contract = at(root, '.ai', 'db_schema.json');
  const as = (agentType, tool = 'Write') => evaluateHookPayload(payload(root, tool, contract, agentType ? { agent_id: 'a1b2c3', agent_type: agentType } : {}));

  assert.equal(as('architect').result.decision, 'allow', 'an architect subagent may edit contracts');
  for (const other of ['worker', 'verifier', 'general-purpose']) {
    assert.equal(as(other).result.decision, 'deny', `${other} is judged as a worker`);
  }
  assert.equal(as(undefined).result.decision, 'deny', 'the main session is not the architect');

  // Identity beats the environment in both directions
  process.env.NATIV_ROLE = 'architect';
  assert.equal(as('worker').result.decision, 'deny', 'a worker spawned from an architect session stays a worker');
  assert.equal(as(undefined).result.decision, 'allow', 'with no subagent identity NATIV_ROLE still applies');
  delete process.env.NATIV_ROLE;

  assert.equal(evaluateHookPayload(payload(root, 'Write', contract, { agent_type: '  ' }), {}).result.decision, 'deny', 'a blank agent_type is ignored');
  assert.equal(evaluateHookPayload(payload(root, 'Write', contract, { agent_type: 'worker' }), { role: 'architect' }).result.decision, 'allow', 'an explicit role option wins');

  // The architect is still bound by secrets, and a worker subagent by its task scope
  assert.equal(evaluateHookPayload(payload(root, 'Write', at(root, '.env'), { agent_type: 'architect' })).result.rule, 'secret_path');
  assert.equal(evaluateHookPayload(payload(root, 'Write', at(root, 'src', 'other.ts'), { agent_type: 'worker' })).result.rule, 'out_of_scope');
  cleanup(root);
  console.log('✔ Test 15: the subagent identity in the payload decides the role, and beats NATIV_ROLE');
}

// Test 16: `hook check` and `hook context` skip loading the whole CLI
{
  const root = project({ mode: 'block' });
  const run = (args, input = '') => {
    const started = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', cwd: root, timeout: 30_000 });
    return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
  };
  const best = (args, input) => Math.min(...[0, 1, 2].map(() => run(args, input).ms));

  const deny = payload(root, 'Write', at(root, 'src', 'other.ts'));
  const fast = run(['hook', 'check', root], JSON.stringify(deny));
  assert.equal(fast.result.status, 0);
  assert.equal(JSON.parse(fast.result.stdout).hookSpecificOutput.permissionDecision, 'deny', 'the fast path gives the same decision');
  assert.equal(run(['hook', 'check', root], 'garbage').result.status, 0, 'and still fails open with exit 0');
  assert.equal(run(['hook', 'check', root], '').result.stdout, '');

  const ctx = run(['hook', 'context', root]);
  assert.equal(ctx.result.status, 0);
  assert.equal(JSON.parse(ctx.result.stdout).hookSpecificOutput.hookEventName, 'SessionStart', 'context takes the fast path too');

  // Other commands still reach the full program
  const version = run(['--version']);
  assert.equal(version.result.status, 0);
  assert.match(version.result.stdout, /\d+\.\d+\.\d+/, 'the full CLI still runs for every other command');
  assert.match(run(['hook', 'status', root, '--json']).result.stdout, /"mode": "block"/, 'hook status is not swallowed by the fast path');

  const fastMs = best(['hook', 'check', root], JSON.stringify(deny));
  const fullMs = best(['--version']);
  console.log(`  (best of 3: hook check ${Math.round(fastMs)}ms vs full CLI ${Math.round(fullMs)}ms)`);
  assert.ok(fastMs < fullMs * 0.75, `the hook path must be materially faster than loading the whole CLI (${Math.round(fastMs)}ms vs ${Math.round(fullMs)}ms)`);
  cleanup(root);
  console.log('✔ Test 16: hook check and context skip loading the full CLI, and everything else is unchanged');
}

// Test 17: agents from the nativ plugin arrive namespaced; only nativ's own architect counts
{
  const root = project({ mode: 'block' });
  const contract = at(root, '.ai', 'db_schema.json');
  const as = (agentType) => evaluateHookPayload(payload(root, 'Write', contract, { agent_id: 'x1', agent_type: agentType })).result.decision;

  assert.equal(as('nativ:architect'), 'allow', "the plugin's architect may edit contracts");
  assert.equal(as('architect'), 'allow', 'the project-scope architect still may');
  assert.equal(as('nativ:worker'), 'deny');
  assert.equal(as('nativ:verifier'), 'deny');
  for (const impostor of ['evil:architect', 'other-plugin:architect', 'nativ:architect:extra', 'Architect2', 'architect-x', 'not-nativ:architect']) {
    assert.equal(as(impostor), 'deny', `${impostor} must not gain contract access`);
  }
  assert.equal(evaluateHookPayload(payload(root, 'Write', at(root, 'src', 'other.ts'), { agent_type: 'nativ:worker' })).result.rule, 'out_of_scope', 'a plugin worker is still bound to its task');
  cleanup(root);
  console.log('✔ Test 17: nativ:architect is recognised; other plugins’ architects and near-misses are not');
}

// Test 18: a BOM (Windows PowerShell, many editors) never turns enforcement off silently
{
  const bom = '﻿';
  const root = project({ mode: 'block' });
  for (const rel of ['.ai/master_plan.json', '.nativ/config.json']) {
    const file = at(root, ...rel.split('/'));
    fs.writeFileSync(file, bom + fs.readFileSync(file, 'utf8'), 'utf8');
  }
  const r = checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root });
  assert.equal(r.decision, 'deny', 'a BOM-prefixed plan and config are still read');
  assert.deepEqual(r.taskIds, ['task-a']);
  assert.equal(getHookStatus(root).mode, 'block');
  assert.deepEqual(getHookStatus(root).activeTasks.map((t) => t.id), ['task-a'], 'the status diagnostic agrees with the guard');

  fs.mkdirSync(path.join(root, '.nativ'), { recursive: true });
  fs.writeFileSync(at(root, '.nativ', 'unlocks.json'), bom + JSON.stringify({ unlocks: [{ taskId: 'task-a', at: 'now' }] }), 'utf8');
  assert.equal(isTaskUnlocked(root, 'task-a'), true, 'a BOM-prefixed unlock file is read');
  assert.equal(checkWrite({ filePath: at(root, 'src', 'other.ts'), toolName: 'Write', cwd: root }).decision, 'allow');
  cleanup(root);
  console.log('✔ Test 18: BOM-prefixed plan, config and unlock files are still enforced');
}

console.log('\n🎉 ALL ROLE ENFORCEMENT TESTS PASSED!');
