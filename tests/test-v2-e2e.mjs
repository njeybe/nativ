import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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


console.log('--- Starting v2 End-to-End Scenario ---');

// One project, driven only through the real CLI and the hook commands exactly as Claude Code would run them:
// init -> setup -> doctor -> task in progress -> out-of-scope edit warns -> block denies -> unlock ->
// architect vs worker on a contract -> drift repaired -> triage with every provider unavailable.

const CLI = path.resolve('bin', 'cli.js').replace(/\\/g, '/');
if (/\s/.test(CLI)) {
  console.log(`- Skipped: the repository path contains whitespace (${CLI}), which \`setup --command\` cannot carry.`);
  process.exit(0);
}
const COMMAND = `node ${CLI}`;

// Every provider is switched off: NATIV_PROVIDER_CHILD disables the Claude login, and no keys are set.
const env = { ...process.env, NATIV_PROVIDER_CHILD: '1', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ANTHROPIC_API_KEY: '' };
delete env.NATIV_ROLE;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-v2-e2e-'));
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'e2e-demo', version: '1.0.0' }), 'utf8');

const nativ = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env, timeout: 120_000 });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const at = (...parts) => path.join(root, ...parts);

/** Runs a hook command string the way Claude Code does: through a shell, JSON on stdin. */
const runHook = (command, payload) => {
  const result = spawnSync(command, { shell: true, cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(result.status, 0, `a hook must always exit 0: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const settings = () => readJson('.claude/settings.json');
const hookCommand = (event) => settings().hooks[event][0].hooks[0].command;
const write = (filePath, extra = {}) => ({
  session_id: 'e2e',
  cwd: root,
  permission_mode: 'acceptEdits',
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: filePath, content: 'x' },
  tool_use_id: 'toolu_e2e',
  ...extra,
});
const doctor = (...extra) => {
  const result = nativ('doctor', root, '--no-deep', '--json', ...extra);
  return { ...JSON.parse(result.stdout), exit: result.status };
};

try {
  // 1. init scaffolds the workflow and the Claude Code configuration in one go
  const init = nativ('init', root);
  assert.equal(init.status, 0, init.stderr);
  for (const rel of ['.ai/master_plan.json', '.mcp.json', '.claude/settings.json', '.claude/agents/architect.md', '.claude/agents/worker.md', '.claude/agents/verifier.md', 'AGENTS.md', 'CLAUDE.md', '.nativ/config.json']) {
    assert.ok(exists(rel), `init must create ${rel}`);
  }
  assert.match(init.stdout, /architect/);
  console.log('✔ 1. init scaffolds .ai/ and the Claude Code configuration');

  // 2. point the generated config at this checkout, then a plain run must not undo that
  assert.equal(nativ('setup', root, '--command', COMMAND).status, 0);
  assert.equal(hookCommand('PreToolUse'), `${COMMAND} hook check`);
  assert.deepEqual(readJson('.mcp.json').mcpServers.nativ, { command: 'node', args: [CLI, 'mcp'] });
  const plain = JSON.parse(nativ('setup', root, '--json').stdout);
  assert.ok(plain.changes.every((c) => c.action === 'unchanged'), 'a plain setup keeps the chosen command and changes nothing');
  console.log('✔ 2. setup --command retargets the config and a plain run is a no-op');

  // 3. doctor is clean
  const clean = doctor();
  assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((c) => c.status === 'fail')));
  assert.ok(clean.checks.some((c) => c.id === 'cli-runs' && c.status === 'ok'), 'doctor proves the configured command actually runs');
  assert.ok(!clean.checks.some((c) => c.fixable));
  console.log('✔ 3. doctor reports a clean install');

  // 4. a task in progress defines the scope
  const add = nativ('task', 'add', 'Build the widget', '--files', 'src/widget.ts', '--verify', 'node -e 0', '--json');
  assert.equal(add.status, 0, add.stderr);
  const taskId = JSON.parse(add.stdout).task.id;
  assert.equal(nativ('task', 'start', taskId).status, 0);
  const status = JSON.parse(nativ('hook', 'status', root, '--json').stdout);
  assert.deepEqual(status.activeTasks.map((t) => [t.id, t.targetFiles]), [[taskId, ['src/widget.ts']]]);
  assert.equal(status.mode, 'warn');
  const orientation = runHook(hookCommand('SessionStart'), { hook_event_name: 'SessionStart', cwd: root });
  assert.match(orientation.hookSpecificOutput.additionalContext, new RegExp(`In progress: ${taskId}`), 'the session starts oriented on the active task');
  console.log('✔ 4. a started task defines the scope and the session starts oriented on it');

  // 5. warn mode: an out-of-scope edit is allowed, the agent is told, and it is logged
  assert.equal(runHook(hookCommand('PreToolUse'), write(at('src', 'widget.ts'))), null, 'an in-scope edit is silent');
  const warned = runHook(hookCommand('PreToolUse'), write(at('src', 'other.ts'), { agent_id: 'w1', agent_type: 'worker' }));
  assert.match(warned.hookSpecificOutput.additionalContext, /outside the target files of task/);
  assert.equal(warned.hookSpecificOutput.permissionDecision, undefined, 'warn mode never denies');
  const telemetry = readJson('.ai/telemetry.json');
  assert.deepEqual(telemetry.violations.map((v) => [v.rule, v.mode, v.path]), [['out_of_scope', 'warn', 'src/other.ts']]);
  assert.equal(telemetry.summary.roleViolations, 1);
  console.log('✔ 5. warn mode allows, tells the agent, and logs the violation');

  // 6. block mode denies; unlock lifts the scope rule only
  assert.equal(nativ('setup', root, '--enforcement', 'block').status, 0);
  const denied = runHook(hookCommand('PreToolUse'), write(at('src', 'other.ts')));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(nativ('task', 'unlock', taskId, '--reason', 'e2e').status, 1, 'agents cannot unlock headless');
  await asHuman(() => runTaskUnlock(taskId, root, { reason: 'e2e' }));
  assert.equal(runHook(hookCommand('PreToolUse'), write(at('src', 'other.ts'))), null, 'unlock lifts the scope rule');
  assert.equal(runHook(hookCommand('PreToolUse'), write(at('.env'))).hookSpecificOutput.permissionDecision, 'deny', 'secrets stay protected while unlocked');
  assert.equal(nativ('task', 'unlock', taskId, '--revoke').status, 0);
  assert.equal(runHook(hookCommand('PreToolUse'), write(at('src', 'other.ts'))).hookSpecificOutput.permissionDecision, 'deny', 're-locked');
  console.log('✔ 6. block mode denies; unlock lifts scope only and can be revoked');

  // 7. contracts: workers and the project manager are denied, the architect (project or plugin) is not
  const contract = at('.ai', 'db_schema.json');
  assert.equal(runHook(hookCommand('PreToolUse'), write(contract)).hookSpecificOutput.permissionDecision, 'deny', 'the project manager may not edit contracts');
  assert.equal(runHook(hookCommand('PreToolUse'), write(contract, { agent_id: 'w', agent_type: 'worker' })).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runHook(hookCommand('PreToolUse'), write(contract, { agent_id: 'a', agent_type: 'architect' })), null, 'the architect may');
  assert.equal(runHook(hookCommand('PreToolUse'), write(contract, { agent_id: 'a', agent_type: 'nativ:architect' })), null, "and so may the plugin's architect");
  assert.equal(runHook(hookCommand('PreToolUse'), write(contract, { agent_id: 'a', agent_type: 'evil:architect' })).hookSpecificOutput.permissionDecision, 'deny', "another plugin's architect may not");
  console.log('✔ 7. contract access follows the agent identity Claude Code reports');

  // 8. the generated permission rules protect the guardrails the hook cannot see
  const perms = settings().permissions;
  for (const rule of ['Bash(nativ task unlock *)', 'Bash(nativ db sync *)', 'Read(./.env)']) assert.ok(perms.deny.includes(rule), `deny includes ${rule}`);
  assert.ok(perms.ask.includes('Write(./.ai/**)') && perms.ask.includes('Edit(./.ai/**)'), 'contract writes always ask the human');
  assert.ok(!perms.allow.some((r) => /unlock|db sync/.test(r)), 'nothing allows the guardrail-lifting commands by name');
  console.log('✔ 8. permission rules deny unlock and db sync and make .ai/ writes ask');

  // 9. drift: a deleted hook is detected, repaired by --fix, and the repair keeps the chosen command
  const broken = settings();
  delete broken.hooks.PreToolUse;
  fs.writeFileSync(at('.claude', 'settings.json'), JSON.stringify(broken, null, 2), 'utf8');
  fs.rmSync(at('.claude', 'agents', 'verifier.md'));
  const drift = doctor();
  assert.equal(drift.ok, false, 'a missing agent file is a failure');
  assert.ok(drift.checks.some((c) => c.id === 'asset:.claude/settings.json' && /PreToolUse/.test(c.message)));
  const repaired = doctor('--fix');
  assert.deepEqual(repaired.fixed.sort(), ['.claude/agents/verifier.md', '.claude/settings.json']);
  assert.equal(repaired.ok, true);
  assert.equal(hookCommand('PreToolUse'), `${COMMAND} hook check`, 'the repair keeps the configured command');
  assert.deepEqual(doctor('--fix').fixed, [], 'a second --fix does nothing');
  console.log('✔ 9. doctor detects a deleted hook and agent, --fix repairs them, and repeating changes nothing');

  // 10. triage with every provider unavailable still answers, from the deterministic engine
  assert.equal(nativ('task', 'escalate', taskId, '--type', 'contract_drift', '--details', 'API contracts schema drift: missing sort param').status, 0);
  const triage = nativ('triage', '--all', '--json');
  assert.equal(triage.status, 0, triage.stderr);
  const evaluation = JSON.parse(triage.stdout).evaluations[0].evaluation;
  assert.equal(evaluation.ok, true, 'a provider outage never fails triage');
  assert.equal(evaluation.provider, 'deterministic');
  assert.equal(evaluation.source, 'deterministic');
  assert.equal(evaluation.classification, 'AUTO_RESOLVE');
  assert.equal(evaluation.riskLevel, 'low');
  assert.ok(!exists('.nativ/provider-state.json') || !/claude-cli/.test(fs.readFileSync(at('.nativ', 'provider-state.json'), 'utf8')), 'no provider was tried, so none was put on cooldown');
  console.log('✔ 10. triage with no provider available answers from the deterministic engine');

  // 11. a destructive escalation still requires a human, offline
  assert.equal(nativ('task', 'escalate', taskId, '--type', 'architectural_ambiguity', '--details', 'Cleanup wants to DROP COLUMN legacy_flag').status, 0);
  const destructive = JSON.parse(nativ('triage', 'esc-02', '--json').stdout).evaluations[0].evaluation;
  assert.equal(destructive.classification, 'REQUIRE_HUMAN_DECISION');
  assert.ok(destructive.humanCard.options.some((o) => o.recommended), 'a four-part decision card with a recommendation');
  console.log('✔ 11. a destructive change still requires a human decision, offline');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n🎉 ALL v2 END-TO-END CHECKS PASSED!');
