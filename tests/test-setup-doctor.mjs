import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  planSetup,
  applySetup,
  buildDesiredConfig,
  resolveCliInvocation,
  mergeClaudeSettings,
  stampManaged,
  managedState,
  buildSessionContext,
  runSessionContext,
  AGENT_FILES,
} from '../dist/core/setup-assets.js';
import { runSetup } from '../dist/commands/setup.js';
import { runDoctor, analyzeMcpList } from '../dist/commands/doctor.js';
import { runInit } from '../dist/commands/init.js';

console.log('--- Starting Setup & Doctor Tests ---');

const NATIV = { command: 'nativ', hasBinary: () => true };
const offlineProviders = { hasBinary: () => false, env: {} };

function tempProject({ ai = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-setup-test-'));
  if (ai) {
    fs.mkdirSync(path.join(root, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.ai', 'master_plan.json'),
      JSON.stringify({
        version: '1.0.0',
        milestones: [
          {
            id: 'm1',
            name: 'M',
            status: 'in_progress',
            tasks: [
              { id: 'task-a', title: 'Do A', status: 'in_progress', dependencies: [], targetFiles: ['src/a.ts'], assignedSubagent: 'backend', description: '', verificationCommand: '' },
              { id: 'task-b', title: 'Do B', status: 'pending', dependencies: ['task-a'], targetFiles: ['src/b.ts'], assignedSubagent: 'backend', description: '', verificationCommand: '' },
            ],
          },
        ],
      }),
      'utf8',
    );
  }
  return root;
}
const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const readJson = (root, rel) => JSON.parse(read(root, rel));
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const actions = (result) => Object.fromEntries(result.changes.map((c) => [c.path, c.action]));

/** Runs a printing command with console output captured and the exit code restored. */
async function quiet(fn) {
  const lines = [];
  const real = { log: console.log, error: console.error };
  const exit = process.exitCode;
  console.log = console.error = (...a) => lines.push(a.join(' '));
  try {
    const value = await fn();
    return { value, text: lines.join('\n'), exitCode: process.exitCode };
  } finally {
    Object.assign(console, real);
    process.exitCode = exit;
  }
}

const doctorJson = async (root, options = {}) => {
  const { text } = await quiet(() => runDoctor(root, { ...NATIV, providerDeps: offlineProviders, runVersion: () => ({ ok: true, output: '1.0.0' }), json: true, ...options }));
  return JSON.parse(text);
};

// Test 1: a fresh project gets every asset, with the verified Claude Code formats
{
  const root = tempProject();
  const result = applySetup(root, NATIV);
  assert.deepEqual(actions(result), {
    '.mcp.json': 'created',
    '.claude/settings.json': 'created',
    '.claude/agents/architect.md': 'created',
    '.claude/agents/worker.md': 'created',
    '.claude/agents/verifier.md': 'created',
    'AGENTS.md': 'created',
    'CLAUDE.md': 'created',
    'GEMINI.md': 'created',
    '.nativ/config.json': 'created',
  });

  assert.deepEqual(readJson(root, '.mcp.json'), { mcpServers: { nativ: { command: 'nativ', args: ['mcp'] } } });

  const s = readJson(root, '.claude/settings.json');
  assert.deepEqual(s.permissions.allow, ['Bash(nativ *)', 'mcp__nativ__*'], 'Claude Code permission syntax, not shell:bash: forms');
  for (const rule of ['Bash(nativ task unlock *)', 'Bash(nativ db sync *)', 'Bash(nativ task complete * --no-verify)', 'Read(./.env)', 'Read(./**/*.pem)']) {
    assert.ok(s.permissions.deny.includes(rule), `deny must include ${rule}`);
  }
  assert.deepEqual(s.permissions.ask, ['Edit(./.ai/**)', 'Write(./.ai/**)'], 'contract writes always ask the human');
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'nativ hook check', timeout: 10 }] }]);
  assert.deepEqual(s.hooks.SessionStart, [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'nativ hook context', timeout: 10 }] }]);
  assert.deepEqual(s.enabledMcpjsonServers, ['nativ']);
  assert.ok(!JSON.stringify(s).includes('shell:') && !JSON.stringify(s).includes('mcp:'), 'no invented permission format');

  assert.deepEqual(readJson(root, '.nativ/config.json'), { enforcement: 'warn' });
  assert.equal(read(root, 'CLAUDE.md'), '# Claude Code directive\n\n@AGENTS.md\n', 'CLAUDE.md is a pointer at the canonical file');
  assert.match(read(root, 'GEMINI.md'), /@AGENTS\.md/);

  for (const file of AGENT_FILES) {
    const text = read(root, `.claude/agents/${file}`);
    assert.match(text, /^---\nname: (architect|worker|verifier)\n/, `${file} starts with frontmatter`);
    assert.equal(managedState(text), 'pristine', `${file} carries an intact managed marker`);
  }
  assert.match(read(root, '.claude/agents/verifier.md'), /tools: Read, Grep, Glob, Bash, mcp__nativ/, 'the verifier cannot edit');
  assert.ok(!/tools:.*\b(Edit|Write)\b/.test(read(root, '.claude/agents/verifier.md').split('---')[1]), 'no Edit or Write for the verifier');
  assert.match(read(root, 'AGENTS.md'), /# nativ Agent Directive/);
  cleanup(root);
  console.log('✔ Test 1: fresh setup writes every asset in the verified Claude Code formats');
}

// Test 2: existing user config is merged, never overwritten
{
  const root = tempProject();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const userSettings = {
    model: 'opus',
    env: { FOO: 'bar' },
    permissions: { allow: ['Bash(npm test)'], deny: ['Bash(rm -rf *)'], defaultMode: 'acceptEdits' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
    },
    enabledMcpjsonServers: ['github'],
  };
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(userSettings, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: [] } } }), 'utf8');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# My own directive\nKeep it.\n', 'utf8');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# My AGENTS.md\n', 'utf8');
  fs.mkdirSync(path.join(root, '.nativ'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nativ', 'config.json'), JSON.stringify({ providers: { triage: 'gemini' } }), 'utf8');

  const result = applySetup(root, NATIV);
  const s = readJson(root, '.claude/settings.json');
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.env, { FOO: 'bar' });
  assert.equal(s.permissions.defaultMode, 'acceptEdits', 'unrelated permission keys survive');
  assert.deepEqual(s.permissions.allow.slice(0, 1), ['Bash(npm test)'], 'the user allow rule stays first');
  assert.ok(s.permissions.allow.includes('Bash(nativ *)'));
  assert.ok(s.permissions.deny.includes('Bash(rm -rf *)') && s.permissions.deny.includes('Bash(nativ task unlock *)'));
  assert.equal(s.hooks.PreToolUse.length, 2, 'our group is added beside the user hook');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo user-hook', 'the user hook is untouched and first');
  assert.deepEqual(s.hooks.Stop, userSettings.hooks.Stop, 'other hook events are untouched');
  assert.deepEqual(s.enabledMcpjsonServers, ['github', 'nativ']);

  const mcp = readJson(root, '.mcp.json');
  assert.deepEqual(mcp.mcpServers.github, { command: 'gh-mcp', args: [] }, 'other MCP servers are untouched');
  assert.deepEqual(mcp.mcpServers.nativ, { command: 'nativ', args: ['mcp'] });

  assert.equal(read(root, 'CLAUDE.md'), '# My own directive\nKeep it.\n', 'an existing CLAUDE.md is never rewritten');
  assert.equal(read(root, 'AGENTS.md'), '# My AGENTS.md\n', 'an AGENTS.md nativ did not write is never overwritten');
  assert.equal(actions(result)['AGENTS.md'], 'skipped');
  assert.ok(result.warnings.some((w) => w.startsWith('AGENTS.md')), 'and the skip is reported');
  assert.deepEqual(readJson(root, '.nativ/config.json'), { providers: { triage: 'gemini' }, enforcement: 'warn' }, 'config keys are kept, the missing one added');
  cleanup(root);
  console.log('✔ Test 2: user settings, hooks, MCP servers, directives and config keys are preserved');
}

// Test 3: a second run changes nothing
{
  const root = tempProject();
  applySetup(root, NATIV);
  const snapshot = (rels) => Object.fromEntries(rels.map((r) => [r, read(root, r)]));
  const files = ['.mcp.json', '.claude/settings.json', '.claude/agents/architect.md', 'AGENTS.md', 'CLAUDE.md', '.nativ/config.json'];
  const before = snapshot(files);
  const again = applySetup(root, NATIV);
  assert.ok(again.changes.every((c) => c.action === 'unchanged'), `second run must be a no-op: ${JSON.stringify(actions(again))}`);
  assert.deepEqual(snapshot(files), before, 'no file content moved');
  assert.equal(planSetup(root, NATIV).writes.size, 0);
  cleanup(root);
  console.log('✔ Test 3: setup is idempotent');
}

// Test 4: dry run writes nothing but reports the same plan
{
  const root = tempProject();
  const result = applySetup(root, { ...NATIV, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changes.filter((c) => c.action === 'created').length, 9);
  for (const rel of ['.mcp.json', '.claude', 'AGENTS.md', 'CLAUDE.md', '.nativ']) assert.ok(!exists(root, rel), `${rel} must not exist after a dry run`);

  const shown = await quiet(() => runSetup(root, { command: 'nativ', dryRun: true }));
  assert.match(shown.text, /would be created/);
  assert.ok(!exists(root, '.mcp.json'));
  cleanup(root);
  console.log('✔ Test 4: dry run reports the plan and writes nothing');
}

// Test 5: managed agent files: update when pristine, keep when edited or foreign, replace with --force
{
  const root = tempProject();
  applySetup(root, NATIV);
  const worker = '.claude/agents/worker.md';
  const template = read(root, worker);

  // Pristine but from an older template: refreshed
  const old = stampManaged('---\nname: worker\ndescription: old\n---\nOld body\n');
  fs.writeFileSync(path.join(root, worker), old, 'utf8');
  assert.equal(actions(applySetup(root, NATIV))[worker], 'updated', 'an untouched managed file follows the template');
  assert.equal(read(root, worker), template);

  // Edited by hand: kept
  const edited = template.replace('Do that task and nothing else.', 'Do that task and ALSO my extra rule.');
  fs.writeFileSync(path.join(root, worker), edited, 'utf8');
  assert.equal(managedState(edited), 'modified');
  const kept = applySetup(root, NATIV);
  assert.equal(actions(kept)[worker], 'skipped');
  assert.equal(read(root, worker), edited, 'hand edits survive');
  assert.match(kept.warnings.join('\n'), /edited by hand/);

  // Foreign file with the same name: kept
  fs.writeFileSync(path.join(root, worker), '---\nname: worker\n---\nMine.\n', 'utf8');
  assert.equal(managedState(read(root, worker)), 'unmanaged');
  assert.equal(actions(applySetup(root, NATIV))[worker], 'skipped');
  assert.equal(read(root, worker), '---\nname: worker\n---\nMine.\n');

  // --force replaces both
  assert.equal(actions(applySetup(root, { ...NATIV, force: true }))[worker], 'updated');
  assert.equal(read(root, worker), template);
  cleanup(root);
  console.log('✔ Test 5: managed agent files refresh when untouched and are protected when edited or foreign');
}

// Test 6: an invalid JSON file is left alone, and the rest still proceeds
{
  const root = tempProject();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ this is: not json', 'utf8');
  const result = applySetup(root, NATIV);
  assert.equal(read(root, '.claude/settings.json'), '{ this is: not json', 'a file we cannot parse is never rewritten');
  assert.equal(actions(result)['.claude/settings.json'], 'skipped');
  assert.match(result.warnings.join('\n'), /not a valid JSON object/);
  assert.equal(actions(result)['.mcp.json'], 'created', 'other assets are still written');

  fs.writeFileSync(path.join(root, '.mcp.json'), '[1,2]', 'utf8');
  assert.equal(actions(applySetup(root, NATIV))['.mcp.json'], 'skipped', 'a JSON array is not an object we can merge into');
  cleanup(root);
  console.log('✔ Test 6: unparseable JSON is skipped with a warning, never overwritten');
}

// Test 7: drift in our own entries is repaired in place
{
  const root = tempProject();
  applySetup(root, NATIV);
  const mcp = readJson(root, '.mcp.json');
  mcp.mcpServers.nativ = { command: 'npx', args: ['@njeybe/nativ', 'mcp'], env: { KEEP: '1' } };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(mcp), 'utf8');
  const settings = readJson(root, '.claude/settings.json');
  settings.hooks.PreToolUse[0].matcher = 'Bash';
  settings.hooks.PreToolUse[0].hooks[0].command = 'nativ hook check --old';
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');

  const result = applySetup(root, NATIV);
  assert.equal(actions(result)['.mcp.json'], 'updated');
  assert.deepEqual(readJson(root, '.mcp.json').mcpServers.nativ, { command: 'nativ', args: ['mcp'], env: { KEEP: '1' } }, 'command fixed, extra keys kept');
  const fixed = readJson(root, '.claude/settings.json');
  assert.equal(fixed.hooks.PreToolUse.length, 1, 'the existing group is updated, not duplicated');
  assert.equal(fixed.hooks.PreToolUse[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  assert.equal(fixed.hooks.PreToolUse[0].hooks[0].command, 'nativ hook check');

  // A project that disabled the server keeps that choice
  settings.disabledMcpjsonServers = ['nativ'];
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  const disabled = applySetup(root, NATIV);
  assert.match(disabled.warnings.join('\n'), /disables the "nativ" MCP server/);
  assert.deepEqual(readJson(root, '.claude/settings.json').disabledMcpjsonServers, ['nativ'], 'the user choice is not undone');
  cleanup(root);
  console.log('✔ Test 7: drifted MCP and hook entries are repaired in place; a disabled server stays disabled');
}

// Test 8: CLI invocation choices
{
  assert.deepEqual(resolveCliInvocation({ hasBinary: () => true }), { command: 'nativ', prefixArgs: [], portable: true });
  assert.deepEqual(resolveCliInvocation({ command: 'npx -y @njeybe/nativ' }), { command: 'npx', prefixArgs: ['-y', '@njeybe/nativ'], portable: true });
  const fallback = resolveCliInvocation({ hasBinary: () => false });
  assert.equal(fallback.command, 'node');
  assert.equal(fallback.portable, false, 'an install-local path is not portable');
  assert.ok(fallback.prefixArgs[0].endsWith('bin/cli.js') && !fallback.prefixArgs[0].includes('\\'), 'forward slashes, so a shell cannot mangle it');

  const npx = buildDesiredConfig(resolveCliInvocation({ command: 'npx -y @njeybe/nativ' }));
  assert.deepEqual(npx.mcpServer, { command: 'npx', args: ['-y', '@njeybe/nativ', 'mcp'] });
  assert.equal(npx.preToolUse.command, 'npx -y @njeybe/nativ hook check');
  assert.ok(npx.allow.includes('Bash(npx -y @njeybe/nativ *)'));
  assert.ok(npx.deny.includes('Bash(npx -y @njeybe/nativ task unlock *)') && npx.deny.includes('Bash(nativ task unlock *)'), 'both spellings of unlock are denied');

  const root = tempProject();
  const plan = planSetup(root, { hasBinary: () => false });
  assert.ok(plan.warnings.some((w) => /not on PATH/.test(w)), 'a non-portable config is called out');
  assert.match(plan.writes.get('.mcp.json'), /cli\.js/);
  cleanup(root);
  console.log('✔ Test 8: the nativ command is auto-detected, overridable, and non-portable configs are flagged');
}

// Test 9: --enforcement sets the mode and is validated
{
  const root = tempProject();
  applySetup(root, { ...NATIV, enforcement: 'block' });
  assert.equal(readJson(root, '.nativ/config.json').enforcement, 'block');
  applySetup(root, NATIV);
  assert.equal(readJson(root, '.nativ/config.json').enforcement, 'block', 'a later plain run does not reset it');
  applySetup(root, { ...NATIV, enforcement: 'warn' });
  assert.equal(readJson(root, '.nativ/config.json').enforcement, 'warn');

  const bad = await quiet(() => runSetup(root, { command: 'nativ', enforcement: 'strict' }));
  assert.equal(bad.exitCode, 1);
  assert.match(bad.text, /--enforcement must be one of/);
  assert.equal(readJson(root, '.nativ/config.json').enforcement, 'warn', 'a bad value changes nothing');
  cleanup(root);
  console.log('✔ Test 9: --enforcement sets the mode, sticks, and is validated');
}

// Test 10: doctor is clean after setup, detects a deleted hook, and --fix restores it
{
  const root = tempProject();
  applySetup(root, NATIV);
  const clean = await doctorJson(root);
  assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((c) => c.status === 'fail')));
  assert.ok(clean.checks.some((c) => c.id === 'assets' && c.status === 'ok'));
  assert.ok(!clean.checks.some((c) => c.fixable), 'nothing to fix after a clean setup');

  const settings = readJson(root, '.claude/settings.json');
  delete settings.hooks.PreToolUse;
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  fs.rmSync(path.join(root, '.claude', 'agents', 'worker.md'));

  const broken = await doctorJson(root);
  const asset = (report, rel) => report.checks.find((c) => c.id === `asset:${rel}`);
  assert.equal(asset(broken, '.claude/settings.json').status, 'warn', 'a missing hook is drift in settings.json');
  assert.match(asset(broken, '.claude/settings.json').message, /PreToolUse/);
  assert.equal(asset(broken, '.claude/agents/worker.md').status, 'fail', 'a missing file is a failure');
  assert.equal(broken.ok, false);
  assert.ok(broken.checks.filter((c) => c.fixable).length >= 2);

  const fixedRun = await doctorJson(root, { fix: true });
  assert.deepEqual(fixedRun.fixed.sort(), ['.claude/agents/worker.md', '.claude/settings.json']);
  assert.equal(fixedRun.ok, true);
  assert.equal(readJson(root, '.claude/settings.json').hooks.PreToolUse[0].hooks[0].command, 'nativ hook check', 'the hook is back');
  assert.ok(exists(root, '.claude/agents/worker.md'));

  const second = await doctorJson(root, { fix: true });
  assert.deepEqual(second.fixed, [], 'a second --fix is a no-op');
  cleanup(root);
  console.log('✔ Test 10: doctor detects a deleted hook and agent, --fix restores them, and a second --fix is a no-op');
}

// Test 11: doctor reports environment problems with the right severity
{
  const root = tempProject();
  applySetup(root, NATIV);

  const noClaude = await doctorJson(root, { hasBinary: (name) => name !== 'claude' });
  assert.equal(noClaude.checks.find((c) => c.id === 'claude').status, 'warn');

  const brokenCli = await doctorJson(root, { runVersion: (command) => (command === 'claude' ? { ok: true, output: '2.1' } : { ok: false, output: 'not found' }) });
  const cliRuns = brokenCli.checks.find((c) => c.id === 'cli-runs');
  assert.equal(cliRuns.status, 'fail', 'hooks and MCP would fail if nativ cannot start');
  assert.equal(brokenCli.ok, false);

  const providers = (report) => report.checks.find((c) => c.id === 'providers');
  assert.equal(providers(await doctorJson(root)).status, 'warn', 'no provider available is a warning, not a failure');
  const withClaude = await doctorJson(root, { providerDeps: { hasBinary: () => true, env: {} } });
  assert.match(providers(withClaude).message, /claude-cli/);

  fs.writeFileSync(path.join(root, '.nativ', 'config.json'), JSON.stringify({ enforcement: 'off' }), 'utf8');
  assert.equal((await doctorJson(root)).checks.find((c) => c.id === 'enforcement').status, 'warn', 'off is called out');

  const noProject = tempProject({ ai: false });
  const missing = await doctorJson(noProject);
  assert.equal(missing.checks.find((c) => c.id === 'project').status, 'fail');
  assert.equal(missing.ok, false);
  cleanup(root);
  cleanup(noProject);
  console.log('✔ Test 11: doctor grades missing Claude, a dead nativ command, no providers, off mode and a non-nativ folder');
}

// Test 12: doctor reads Claude Code's own MCP view, including a shadowing scope
{
  const healthy = analyzeMcpList('Checking MCP server health…\n\nnativ: nativ mcp - ✔ Connected\n');
  assert.deepEqual(healthy.map((c) => [c.id, c.status]), [['mcp-connected', 'ok']]);

  const down = analyzeMcpList('nativ: nativ mcp - ✖ Failed to connect\n');
  assert.equal(down[0].status, 'fail');

  const absent = analyzeMcpList('other: x - ✔ Connected\n');
  assert.equal(absent[0].id, 'mcp-listed');
  assert.equal(absent[0].status, 'warn');

  const shadowed = analyzeMcpList(
    'nativ: npx @njeybe/nativ mcp - ✔ Connected\n\n[Conflicting scopes]\n├ Server "nativ" is defined in multiple scopes with different endpoints: project (nativ mcp), local (npx @njeybe/nativ mcp). OAuth tokens are stored per endpoint.\n',
  );
  const conflict = shadowed.find((c) => c.id === 'mcp-scope-conflict');
  assert.equal(conflict.status, 'warn');
  assert.match(conflict.message, /claude mcp remove nativ -s local/, 'the fix is spelled out');

  const root = tempProject();
  applySetup(root, NATIV);
  let asked = 0;
  const report = await doctorJson(root, { deep: true, mcpList: () => (asked++, 'nativ: nativ mcp - ✔ Connected') });
  assert.equal(asked, 1);
  assert.ok(report.checks.some((c) => c.id === 'mcp-connected' && c.status === 'ok'));
  asked = 0;
  await doctorJson(root, { mcpList: () => (asked++, null) });
  assert.equal(asked, 0, 'the live check only runs when asked for');
  const failed = await doctorJson(root, { deep: true, mcpList: () => null });
  assert.equal(failed.checks.find((c) => c.id === 'mcp-listed').status, 'warn', 'a listing that cannot run is a warning');
  cleanup(root);
  console.log('✔ Test 12: doctor interprets `claude mcp list`, including a shadowing scope, and only runs it on request');
}

// Test 13: SessionStart context
{
  const root = tempProject();
  const context = buildSessionContext(root, {});
  assert.match(context, /nativ project/);
  assert.match(context, /Session role: project manager\. Enforcement: warn/);
  assert.match(context, /In progress: task-a "Do A" \(targetFiles: src\/a\.ts\)/);
  assert.ok(buildSessionContext(root, { NATIV_ROLE: 'Architect' }).includes('Session role: architect'));

  const plan = readJson(root, '.ai/master_plan.json');
  plan.milestones[0].tasks[0].status = 'completed';
  fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify(plan), 'utf8');
  assert.match(buildSessionContext(root, {}), /Next available task: task-b "Do B"/, 'the next task is the first whose dependencies are done');
  plan.milestones[0].tasks[1].status = 'completed';
  fs.writeFileSync(path.join(root, '.ai', 'master_plan.json'), JSON.stringify(plan), 'utf8');
  assert.match(buildSessionContext(root, {}), /No task is in progress or ready/);

  let printed = '';
  runSessionContext(root, (t) => (printed += t));
  const out = JSON.parse(printed);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart', 'documented SessionStart JSON shape');
  assert.match(out.hookSpecificOutput.additionalContext, /nativ project/);
  assert.ok(out.hookSpecificOutput.additionalContext.length < 900, 'a short orientation, not a dump');

  const bare = tempProject({ ai: false });
  assert.equal(buildSessionContext(bare, {}), null, 'a non-nativ folder gets no context');
  let none = '';
  runSessionContext(bare, (t) => (none += t));
  assert.equal(none, '', 'and prints nothing');
  cleanup(root);
  cleanup(bare);
  console.log('✔ Test 13: SessionStart context is short, correct, and absent outside nativ projects');
}

// Test 14: init sets everything up in one go and is safe to repeat
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-init-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8');
  const first = await quiet(() => runInit(root, {}));
  assert.match(first.text, /Configuring Claude Code/);
  assert.match(first.text, /architect/, 'next steps name the architect role, not a specific vendor');
  assert.ok(!/Antigravity\)? \(Tier 1/.test(first.text), 'no vendor-specific next step');
  for (const rel of ['.ai/master_plan.json', '.mcp.json', '.claude/settings.json', '.claude/agents/architect.md', 'AGENTS.md', '.nativ/config.json']) {
    assert.ok(exists(root, rel), `init must create ${rel}`);
  }
  const settingsBefore = read(root, '.claude/settings.json');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Edited after init\n', 'utf8');
  await quiet(() => runInit(root, {}));
  assert.equal(read(root, '.claude/settings.json'), settingsBefore, 'a second init leaves the configuration alone');
  assert.equal(read(root, 'CLAUDE.md'), '# Edited after init\n', 'and never overwrites an edited directive');
  cleanup(root);
  console.log('✔ Test 14: init runs setup, names roles rather than vendors, and never overwrites on a repeat');
}

// Test 15: the merge helper is pure and the MCP surface is read-only
{
  const desired = buildDesiredConfig(resolveCliInvocation(NATIV));
  const input = { permissions: { allow: ['X'] } };
  const snapshot = JSON.stringify(input);
  const { merged, changes } = mergeClaudeSettings(input, desired);
  assert.equal(JSON.stringify(input), snapshot, 'the input object is not mutated');
  assert.ok(changes.length >= 5);
  assert.deepEqual(mergeClaudeSettings(merged, desired).changes, [], 'merging the result again reports no changes');

  const server = fs.readFileSync(path.resolve('dist', 'mcp', 'server.js'), 'utf8');
  assert.match(server, /'doctor'/, 'nativ_doctor is registered');
  assert.ok(!/runSetup|applySetup|fix:\s*true/.test(server), 'the MCP server exposes no repair or setup');
  console.log('✔ Test 15: merging is pure and repeatable; MCP exposes doctor read-only');
}

// Test 16: BOM-prefixed files are merged and read, and an unreadable plan is a loud doctor failure
{
  const bom = '﻿';
  const root = tempProject();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), bom + JSON.stringify({ model: 'opus' }), 'utf8');
  fs.writeFileSync(path.join(root, '.mcp.json'), bom + JSON.stringify({ mcpServers: { github: { command: 'gh' } } }), 'utf8');
  const result = applySetup(root, NATIV);
  assert.notEqual(actions(result)['.claude/settings.json'], 'skipped', 'a BOM is not "invalid JSON"');
  assert.equal(readJson(root, '.claude/settings.json').model, 'opus', 'user keys survive a BOM-prefixed file');
  assert.ok(readJson(root, '.mcp.json').mcpServers.github, 'and so do MCP servers');
  assert.ok(!read(root, '.claude/settings.json').startsWith(bom), 'the rewritten file has no BOM');

  const plan = path.join(root, '.ai', 'master_plan.json');
  fs.writeFileSync(plan, bom + fs.readFileSync(plan, 'utf8'), 'utf8');
  assert.match(buildSessionContext(root, {}), /In progress: task-a/, 'session context reads a BOM plan');
  const okReport = await doctorJson(root);
  assert.equal(okReport.checks.find((c) => c.id === 'project').status, 'ok', 'a BOM plan is readable');

  fs.writeFileSync(plan, '{ "milestones": [ this is broken', 'utf8');
  const broken = await doctorJson(root);
  const project = broken.checks.find((c) => c.id === 'project');
  assert.equal(project.status, 'fail', 'an unparseable plan is a failure, never a quiet state');
  assert.match(project.message, /cannot be parsed/);
  assert.match(project.message, /enforcement cannot see the active task/i);
  assert.equal(broken.ok, false);
  cleanup(root);
  console.log('✔ Test 16: BOM-prefixed files are merged and read; an unreadable plan is reported loudly');
}

// Test 17: user-facing text names the Architect role, not one vendor
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-wording-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }), 'utf8');
  const init = await quiet(() => runInit(root, {}));
  assert.ok(!/Antigravity Mission Control/.test(init.text), 'init no longer calls GEMINI.md the Antigravity directive');
  assert.match(init.text, /optional Gemini\/Antigravity architect adapter/);
  assert.match(read(root, '.ai/context.md'), /Awaiting specification from the architect intake interview/);
  for (const seed of ['.ai/context.md', '.ai/api_contracts.json', '.ai/db_schema.json']) {
    assert.ok(!/Antigravity/.test(read(root, seed)), `${seed} seeded into a new project has no vendor-first instruction`);
  }
  assert.match(read(root, '.ai/context.md'), /Strict Role Pipeline \(provider-agnostic\)/);
  JSON.parse(read(root, '.ai/api_contracts.json'));
  JSON.parse(read(root, '.ai/db_schema.json'));

  const cli = path.resolve('bin', 'cli.js');
  const escalate = spawnSync(process.execPath, [cli, 'task', 'escalate', 'task-01', '--type', 'schema_flaw', '--details', 'missing column', root], { encoding: 'utf8', cwd: root, timeout: 60_000 });
  assert.equal(escalate.status, 0, escalate.stderr);
  assert.match(escalate.stdout, /Escalated to the Architect/);
  assert.ok(!/Open Antigravity/.test(escalate.stdout), 'the next step is not Antigravity-only');
  assert.match(escalate.stdout, /architect agent/);

  const helpText = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 60_000 }).stdout;
  assert.ok(!/connecting Antigravity/.test(helpText), 'the CLI description is role-based');
  cleanup(root);
  console.log('✔ Test 17: init, escalate and help text name the Architect role instead of one vendor');
}

// Test 18: the configured command is kept unless --command says otherwise
{
  const root = tempProject();
  const NPX = { command: 'npx -y @njeybe/nativ', hasBinary: () => true };
  const noHint = { hasBinary: () => true };

  applySetup(root, NPX);
  assert.deepEqual(readJson(root, '.mcp.json').mcpServers.nativ, { command: 'npx', args: ['-y', '@njeybe/nativ', 'mcp'] });

  // A plain run, even where a global nativ exists, keeps the project's choice and changes nothing
  const plain = applySetup(root, noHint);
  assert.ok(plain.changes.every((c) => c.action === 'unchanged'), `a plain setup must be a no-op: ${JSON.stringify(actions(plain))}`);
  assert.equal(plain.invocation.command, 'npx');
  assert.equal(readJson(root, '.claude/settings.json').hooks.PreToolUse[0].hooks[0].command, 'npx -y @njeybe/nativ hook check');

  // A plain doctor sees no drift, and --fix does not swap the command back to `nativ`
  const report = await doctorJson(root, { command: undefined, hasBinary: () => true });
  assert.ok(!report.checks.some((c) => c.fixable), `doctor must not call a deliberate command drift: ${JSON.stringify(report.checks.filter((c) => c.fixable))}`);
  const fixed = await doctorJson(root, { command: undefined, hasBinary: () => true, fix: true });
  assert.deepEqual(fixed.fixed, []);
  assert.equal(readJson(root, '.mcp.json').mcpServers.nativ.command, 'npx', 'still npx after doctor --fix');

  // An explicit --command wins, and MCP, hooks and permission rules move together
  applySetup(root, { command: 'nativ', hasBinary: () => true });
  const s = readJson(root, '.claude/settings.json');
  assert.deepEqual(readJson(root, '.mcp.json').mcpServers.nativ, { command: 'nativ', args: ['mcp'] });
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'nativ hook check', 'one hook, rewritten in place');
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.ok(s.permissions.allow.includes('Bash(nativ *)'));
  assert.equal(applySetup(root, noHint).invocation.command, 'nativ', 'and the new choice is what a plain run keeps');

  // Unusable entries fall back to auto-detection
  for (const bad of [{ command: 'nativ' }, { command: 'nativ', args: ['serve'] }, { command: '', args: ['mcp'] }, { command: 'nativ', args: [1, 'mcp'] }, 'nativ mcp']) {
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { nativ: bad } }), 'utf8');
    assert.equal(planSetup(root, { hasBinary: () => true }).invocation.command, 'nativ', `${JSON.stringify(bad)} falls back to detection`);
  }
  fs.writeFileSync(path.join(root, '.mcp.json'), '{ nope', 'utf8');
  assert.equal(planSetup(root, { hasBinary: () => false }).invocation.command, 'node', 'unparseable .mcp.json falls back too');

  // The adopted command is marked non-portable when it is an absolute path
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { nativ: { command: 'node', args: ['C:/tools/nativ/bin/cli.js', 'mcp'] } } }), 'utf8');
  assert.equal(planSetup(root, { hasBinary: () => true }).invocation.portable, false);
  cleanup(root);
  console.log('✔ Test 18: setup and doctor keep the configured command; --command changes it everywhere at once');
}

// Test 19: agent frontmatter uses only known keys and the approved models, so a typo cannot be silently ignored
{
  const dir = path.resolve('templates', 'claude-agents');
  const KNOWN = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'permissionMode', 'maxTurns', 'skills', 'mcpServers', 'hooks', 'memory', 'background', 'effort', 'isolation', 'color']);
  const EXPECTED = { architect: 'opus', worker: 'sonnet', verifier: 'haiku' };
  for (const [agent, model] of Object.entries(EXPECTED)) {
    const text = fs.readFileSync(path.join(dir, `${agent}.md`), 'utf8').replace(/\r\n/g, '\n');
    const front = /^---\n([\s\S]*?)\n---/.exec(text);
    assert.ok(front, `${agent}.md has frontmatter`);
    const fields = Object.fromEntries(
      front[1].split('\n').filter((l) => /^\S/.test(l)).map((l) => {
        const i = l.indexOf(':');
        assert.ok(i > 0, `${agent}.md: "${l}" is not key: value`);
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
    for (const key of Object.keys(fields)) assert.ok(KNOWN.has(key), `${agent}.md has unknown frontmatter key "${key}"`);
    assert.equal(fields.model, model, `${agent} model`);
    assert.ok(['opus', 'sonnet', 'haiku'].includes(fields.model), 'only opus, sonnet and haiku are used');
    assert.ok(Number.isInteger(Number(fields.maxTurns)) && Number(fields.maxTurns) > 0, `${agent} has a positive maxTurns`);
    if (fields.effort !== undefined) assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(fields.effort), `${agent} effort`);
  }
  console.log('✔ Test 19: agent frontmatter has only known keys, approved models and a turn cap');
}

// Test 20: CRLF checkouts (Windows core.autocrlf) change nothing: output is identical LF and CRLF files are not "edits"
{
  const crlfTemplates = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-crlf-templates-'));
  const source = path.resolve('templates');
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) copy(a, b);
      else fs.writeFileSync(b, fs.readFileSync(a, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
    }
  };
  copy(source, crlfTemplates);
  assert.ok(fs.readFileSync(path.join(crlfTemplates, 'AGENTS.md'), 'utf8').includes('\r\n'), 'the fixture templates really are CRLF');

  const lfRoot = tempProject();
  const crlfRoot = tempProject();
  try {
    applySetup(lfRoot, { ...NATIV });
    applySetup(crlfRoot, { ...NATIV, templatesDir: crlfTemplates });
    for (const rel of ['AGENTS.md', '.claude/agents/architect.md', '.claude/agents/worker.md', '.claude/agents/verifier.md']) {
      const out = read(crlfRoot, rel);
      assert.ok(!out.includes('\r'), `${rel} is written with LF even from CRLF templates`);
      assert.equal(out, read(lfRoot, rel), `${rel} is byte-identical whatever the template line endings`);
    }

    // An editor or autocrlf turns a managed file into CRLF: that is not an edit, so setup still recognises and refreshes it
    const worker = path.join(crlfRoot, '.claude', 'agents', 'worker.md');
    fs.writeFileSync(worker, fs.readFileSync(worker, 'utf8').replace(/\n/g, '\r\n'), 'utf8');
    assert.equal(managedState(fs.readFileSync(worker, 'utf8')), 'pristine', 'a CRLF-converted managed file is still pristine');
    const replan = planSetup(crlfRoot, { ...NATIV });
    const change = replan.changes.find((c) => c.path === '.claude/agents/worker.md');
    assert.notEqual(change.action, 'skipped', 'it is not reported as edited by hand');
    applySetup(crlfRoot, { ...NATIV });
    assert.equal(read(crlfRoot, '.claude/agents/worker.md'), read(lfRoot, '.claude/agents/worker.md'));
    assert.deepEqual(planSetup(crlfRoot, { ...NATIV }).changes.filter((c) => c.action === 'created' || c.action === 'updated'), [], 'a second run changes nothing');
  } finally {
    cleanup(lfRoot);
    cleanup(crlfRoot);
    cleanup(crlfTemplates);
  }
  console.log('✔ Test 20: CRLF templates and CRLF managed files produce the same LF output and are not treated as edits');
}

console.log('\n🎉 ALL SETUP & DOCTOR TESTS PASSED!');
