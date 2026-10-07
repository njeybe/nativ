import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planTemplateFile, stampManaged, managedState } from '../dist/core/setup-assets.js';
import { isLegacyTemplate, legacyTemplateHash, LEGACY_TEMPLATE_HASHES, normalizeForHash } from '../dist/core/legacy-templates.js';

console.log('--- Starting nativ update Tests ---');

const CLI = path.resolve('bin', 'cli.js');
const TEMPLATES = path.resolve('templates');
const nativ = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (root, rel, text) => {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const template = (rel) => fs.readFileSync(path.join(TEMPLATES, ...rel.split('/')), 'utf8');

/** A project that went through init, with the configuration pointed at this checkout so update is deterministic. */
function freshProject() {
  const root = tmp('nativ-update-test-');
  write(root, 'package.json', JSON.stringify({ name: 'demo', version: '1.0.0' }));
  assert.equal(nativ(root, 'init', root).status, 0);
  assert.equal(nativ(root, 'setup', root, '--command', `node ${CLI.replace(/\\/g, '/')}`).status, 0);
  return root;
}

const line = (out, rel) => out.split('\n').find((l) => l.includes(rel)) ?? '';

// Test 1: the planner's decision table
{
  const tpl = '# Template\nBody v2\n';
  const stampedOld = stampManaged('# Template\nBody v1\n');
  const stampedNew = stampManaged(tpl);
  const subKey = 'subagents/backend.md';
  const legacyBackend = template('dot-ai/subagents/backend.md');

  assert.equal(planTemplateFile(null, tpl, 'CLAUDE.md').action, 'created', 'missing -> created');
  assert.equal(planTemplateFile(null, tpl, 'CLAUDE.md').content, stampedNew, 'and created stamped');
  assert.equal(planTemplateFile(stampedNew, tpl, 'CLAUDE.md').action, 'unchanged');
  assert.equal(planTemplateFile(stampedNew, tpl, 'CLAUDE.md').content, undefined, 'unchanged writes nothing');

  const older = planTemplateFile(stampedOld, tpl, 'CLAUDE.md');
  assert.equal(older.action, 'updated', 'an untouched stamped file follows the template');
  assert.equal(older.content, stampedNew);

  const handEdited = stampedOld.replace('Body v1', 'Body v1 plus my rule');
  assert.equal(managedState(handEdited), 'modified');
  const kept = planTemplateFile(handEdited, tpl, 'CLAUDE.md');
  assert.equal(kept.action, 'skipped', 'an edited stamped file is kept');
  assert.match(kept.detail, /edited by hand/);
  assert.equal(kept.content, undefined);
  assert.equal(planTemplateFile(handEdited, tpl, 'CLAUDE.md', true).action, 'updated', '--force replaces it');

  assert.equal(planTemplateFile('# My own file\n', tpl, 'CLAUDE.md').action, 'skipped', 'a file nativ never wrote is kept');
  assert.equal(planTemplateFile('# My own file\n', tpl, 'CLAUDE.md', true).action, 'updated');

  // Unstamped copies from before markers existed: recognised by fingerprint, regardless of line endings
  assert.equal(planTemplateFile(legacyBackend, legacyBackend + '\n', subKey).action, 'updated', 'identical to the template but unstamped: adopted');
  const legacyKnown = planTemplateFile(legacyBackend, 'A newer body\n', subKey);
  assert.equal(legacyKnown.action, 'updated', 'a known earlier template is refreshed');
  assert.match(legacyKnown.detail, /earlier nativ template/);
  assert.equal(planTemplateFile(legacyBackend.replace(/\r?\n/g, '\r\n'), 'A newer body\n', subKey).action, 'updated', 'CRLF checkout of an earlier template still matches');
  assert.equal(planTemplateFile('﻿' + legacyBackend + '   \n\n', 'A newer body\n', subKey).action, 'updated', 'BOM and trailing whitespace are not edits');
  assert.equal(planTemplateFile(legacyBackend + '\nMy extra rule.\n', 'A newer body\n', subKey).action, 'skipped', 'one added line makes it an edit');
  console.log('✔ Test 1: the planner creates, refreshes untouched files (stamped or known-legacy) and keeps edited ones');
}

// Test 2: the fingerprint table is sound
{
  for (const [key, hashes] of Object.entries(LEGACY_TEMPLATE_HASHES)) {
    assert.ok(hashes.length >= 1, `${key} has at least one shipped version`);
    for (const h of hashes) assert.match(h, /^[0-9a-f]{16}$/, `${key} hash shape`);
  }
  // Guides added once files carried the managed marker (v2.0, f3afb4c) are stamped when written, so need no fingerprint.
  const STAMPED_FROM_THE_START = new Set(['architect.md']);
  for (const file of fs.readdirSync(path.join(TEMPLATES, 'dot-ai', 'subagents'))) {
    if (STAMPED_FROM_THE_START.has(file)) {
      assert.ok(!(`subagents/${file}` in LEGACY_TEMPLATE_HASHES), `subagents/${file} never shipped unmarked`);
      continue;
    }
    assert.ok(`subagents/${file}` in LEGACY_TEMPLATE_HASHES, `subagents/${file} is covered`);
  }
  assert.equal(legacyTemplateHash('a\r\nb  \n'), legacyTemplateHash('a\nb'), 'hashing normalises line endings and trailing space');
  assert.equal(normalizeForHash('﻿x\r\n'), 'x');

  // Since v2.0 every CLAUDE.md nativ writes is stamped, so the copy a project got from HEAD upgrades through its stamp,
  // not through the legacy table (skipped when git history is unavailable).
  const head = spawnSync('git', ['show', 'HEAD:templates/CLAUDE.md'], { encoding: 'utf8', cwd: path.resolve('.') });
  if (head.status === 0 && head.stdout.trim()) {
    const current = template('CLAUDE.md');
    const upgraded = planTemplateFile(stampManaged(head.stdout), current, 'CLAUDE.md');
    assert.equal(upgraded.action, legacyTemplateHash(head.stdout) === legacyTemplateHash(current) ? 'unchanged' : 'updated', 'the CLAUDE.md shipped at HEAD follows the template');
  } else {
    console.log('  (git history not available: HEAD fingerprint check skipped)');
  }
  assert.equal(isLegacyTemplate('CLAUDE.md', '# Something I wrote\n'), false);
  assert.equal(isLegacyTemplate('no-such-key', template('CLAUDE.md')), false);
  console.log('✔ Test 2: every template is fingerprinted, hashing is whitespace-tolerant, and unknown content is not legacy');
}

// Test 3: a project straight from init is already current, and update is idempotent
{
  const root = freshProject();
  const first = nativ(root, 'update', root);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(!/created|updated/.test(first.stdout.split('Contracts')[0].replace(/nativ update: synchronizing[^\n]*/, '')), `nothing to change on a fresh project:\n${first.stdout}`);
  const snapshot = ['CLAUDE.md', 'GEMINI.md', 'AGENTS.md', '.ai/subagents/backend.md', '.claude/agents/worker.md', '.claude/settings.json', '.mcp.json'].map((r) => [r, read(root, r)]);
  const second = nativ(root, 'update', root);
  assert.equal(second.status, 0);
  for (const [rel, content] of snapshot) assert.equal(read(root, rel), content, `${rel} unchanged by a second update`);
  assert.match(read(root, 'CLAUDE.md'), /nativ:managed sha256=/, 'init stamps the directives it writes');
  assert.match(read(root, '.ai/subagents/backend.md'), /nativ:managed sha256=/, 'and the role guides');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 3: init stamps what it writes; update on a fresh project and a repeat update change nothing');
}

// Test 4: older, unstamped projects are refreshed; hand-edited files are kept; --force replaces them
{
  const root = freshProject();

  // Simulate a project created by an older nativ: unstamped role guides (one with CRLF endings)
  write(root, '.ai/subagents/backend.md', template('dot-ai/subagents/backend.md'));
  write(root, '.ai/subagents/database.md', template('dot-ai/subagents/database.md').replace(/\r?\n/g, '\r\n'));
  // And two that were edited by hand
  const edited = template('dot-ai/subagents/qa-tester.md') + '\nMy team rule: always run the linter.\n';
  write(root, '.ai/subagents/qa-tester.md', edited);
  write(root, 'CLAUDE.md', '# Our own CLAUDE.md\nDo it our way.\n');

  const run = nativ(root, 'update', root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(line(run.stdout, '.ai/subagents/backend.md'), /updated/, 'an untouched pre-marker role guide is refreshed');
  assert.match(line(run.stdout, '.ai/subagents/database.md'), /updated/, 'including a CRLF checkout of it');
  assert.match(read(root, '.ai/subagents/backend.md'), /nativ:managed sha256=/, 'and now stamped');

  assert.equal(read(root, '.ai/subagents/qa-tester.md'), edited, 'an edited role guide is kept byte for byte');
  assert.match(line(run.stdout, '.ai/subagents/qa-tester.md'), /kept: .*edited by hand/);
  assert.equal(read(root, 'CLAUDE.md'), '# Our own CLAUDE.md\nDo it our way.\n', 'an edited CLAUDE.md is kept byte for byte');
  assert.match(line(run.stdout, 'CLAUDE.md'), /kept/);
  assert.match(run.stdout, /2 file\(s\) were kept because they were edited by hand/);
  assert.match(run.stdout, /nativ update --force/, 'the way to replace them is spelled out');

  const again = nativ(root, 'update', root);
  assert.equal(read(root, '.ai/subagents/qa-tester.md'), edited, 'still kept on the next run');
  assert.equal(read(root, 'CLAUDE.md'), '# Our own CLAUDE.md\nDo it our way.\n');

  const forced = nativ(root, 'update', root, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(read(root, '.ai/subagents/qa-tester.md'), stampManaged(template('dot-ai/subagents/qa-tester.md')), '--force replaces the edited role guide');
  assert.equal(read(root, 'CLAUDE.md'), stampManaged(template('CLAUDE.md')), 'and the edited directive');
  assert.ok(!/kept because they were edited/.test(forced.stdout));
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 4: pre-marker files are refreshed, edited ones kept byte for byte, and --force replaces them');
}

// Test 5: the previous directive that shipped in git history is refreshed to the new one (needs git history)
{
  const head = spawnSync('git', ['show', 'HEAD:templates/CLAUDE.md'], { encoding: 'utf8', cwd: path.resolve('.') });
  const headGemini = spawnSync('git', ['show', 'HEAD:templates/GEMINI.md'], { encoding: 'utf8', cwd: path.resolve('.') });
  if (head.status !== 0 || headGemini.status !== 0) {
    console.log('- Test 5: skipped (git history not available)');
  } else if (legacyTemplateHash(head.stdout) === legacyTemplateHash(template('CLAUDE.md'))) {
    console.log('- Test 5: skipped (HEAD already holds the current template)');
  } else {
    const root = freshProject();
    // Since v2.0 nativ stamps what it writes, so a project holds the HEAD directive stamped (CRLF on a Windows checkout).
    write(root, 'CLAUDE.md', stampManaged(head.stdout).replace(/\r?\n/g, '\r\n'));
    write(root, 'GEMINI.md', headGemini.stdout);
    const run = nativ(root, 'update', root);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(read(root, 'CLAUDE.md'), stampManaged(template('CLAUDE.md')), 'the directive shipped at HEAD is replaced by the current one');
    assert.match(read(root, 'CLAUDE.md'), /@AGENTS\.md/, 'and it now imports the canonical AGENTS.md');
    assert.match(line(run.stdout, 'CLAUDE.md'), /template updated/);
    fs.rmSync(root, { recursive: true, force: true });
    console.log('✔ Test 5: the directive that shipped before this change is refreshed to the new one, CRLF or not');
  }
}

// Test 6: contracts, plan and context are never touched; missing ones are backfilled
{
  const root = freshProject();
  const mine = {
    '.ai/context.md': '# My context\nHand written.\n',
    '.ai/master_plan.json': JSON.stringify({ projectName: 'mine', milestones: [] }),
    '.ai/db_schema.json': JSON.stringify({ tables: [{ name: 'users' }] }),
    '.ai/api_contracts.json': JSON.stringify({ endpoints: [{ id: 'mine' }] }),
    '.ai/ui_specs.md': '# My UI\n',
  };
  for (const [rel, text] of Object.entries(mine)) write(root, rel, text);
  assert.equal(nativ(root, 'update', root, '--force').status, 0, 'even --force must not touch contracts');
  for (const [rel, text] of Object.entries(mine)) assert.equal(read(root, rel), text, `${rel} untouched, even with --force`);

  fs.rmSync(path.join(root, '.ai', 'ui_specs.md'));
  fs.rmSync(path.join(root, '.ai', 'db_schema.json'));
  const run = nativ(root, 'update', root);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(exists(root, '.ai/ui_specs.md') && exists(root, '.ai/db_schema.json'), 'missing contracts are backfilled');
  assert.match(run.stdout, /Added missing contract: \.ai\/db_schema\.json/);
  assert.equal(read(root, '.ai/master_plan.json'), mine['.ai/master_plan.json'], 'the plan is still untouched');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 6: contracts, plan and context are never modified, even with --force; missing ones are backfilled');
}

// Test 7: update refreshes what nativ setup manages, and keeps the configured command
{
  const root = freshProject();
  const configured = JSON.parse(read(root, '.mcp.json')).mcpServers.nativ;
  fs.rmSync(path.join(root, 'AGENTS.md'));
  fs.rmSync(path.join(root, '.claude', 'agents', 'worker.md'));
  const settings = JSON.parse(read(root, '.claude/settings.json'));
  delete settings.hooks.SessionStart;
  write(root, '.claude/settings.json', JSON.stringify(settings, null, 2));
  const editedAgent = read(root, '.claude/agents/architect.md').replace('You are the **Architect**', 'You are OUR architect');
  write(root, '.claude/agents/architect.md', editedAgent);

  const run = nativ(root, 'update', root);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(exists(root, 'AGENTS.md'), 'a missing AGENTS.md is restored');
  assert.ok(exists(root, '.claude/agents/worker.md'), 'a missing agent is restored');
  assert.ok(JSON.parse(read(root, '.claude/settings.json')).hooks.SessionStart, 'a deleted hook is restored');
  assert.equal(read(root, '.claude/agents/architect.md'), editedAgent, 'an edited agent file is kept');
  assert.deepEqual(JSON.parse(read(root, '.mcp.json')).mcpServers.nativ, configured, 'the configured nativ command survives an update');
  assert.equal(JSON.parse(read(root, '.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command, `node ${CLI.replace(/\\/g, '/')} hook check`);

  assert.equal(nativ(root, 'update', root, '--force').status, 0);
  assert.notEqual(read(root, '.claude/agents/architect.md'), editedAgent, '--force replaces the edited agent file');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 7: update restores AGENTS.md, agents and hooks, keeps edits and the configured command');
}

// Test 8: update outside a nativ project fails cleanly and writes nothing
{
  const root = tmp('nativ-update-empty-');
  const run = nativ(root, 'update', root);
  assert.equal(run.status, 1);
  assert.match(run.stderr + run.stdout, /No \.ai\/ directory found/);
  assert.deepEqual(fs.readdirSync(root), [], 'nothing was created');
  fs.rmSync(root, { recursive: true, force: true });
  console.log('✔ Test 8: update without .ai/ fails cleanly and creates nothing');
}

console.log('\n🎉 ALL nativ update TESTS PASSED!');
