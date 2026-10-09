import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderPlugin, findStaleFiles, PLUGIN_NAME, PLUGIN_DIR } from '../scripts/sync-plugin.mjs';
import { buildDesiredConfig, resolveCliInvocation } from '../dist/core/setup-assets.js';

console.log('--- Starting Plugin Manifest Tests ---');

const root = path.resolve('.');
// LF whatever the checkout uses: a Windows clone with core.autocrlf has CRLF on disk, which is not a difference.
const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const readJson = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const SYNC = path.join(root, 'scripts', 'sync-plugin.mjs');
const runSync = (...args) => spawnSync(process.execPath, [SYNC, ...args], { encoding: 'utf8', cwd: root, timeout: 60_000 });

const pkg = readJson('package.json');
const rendered = await renderPlugin(root);
const frontmatter = (text) => Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

// Test 1: the committed plugin is exactly what the generator renders, with nothing stale
{
  for (const [rel, content] of rendered) {
    assert.ok(exists(rel), `${rel} must be committed: run \`npm run sync-plugin\``);
    assert.equal(read(rel), content, `${rel} is out of sync with its source: run \`npm run sync-plugin\``);
  }
  assert.deepEqual(findStaleFiles(root, new Set(rendered.keys())), [], 'no file under plugin/ that the generator does not produce');
  const check = runSync('--check');
  assert.equal(check.status, 0, `--check must pass on a synced tree: ${check.stderr}`);
  console.log(`✔ Test 1: all ${rendered.size} plugin files match what the generator renders`);
}

// Test 2: the generator writes to a chosen root, and --check catches drift and stale files
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-plugin-out-'));
  const first = runSync('--out', out);
  assert.equal(first.status, 0, first.stderr);
  for (const [rel, content] of rendered) assert.equal(fs.readFileSync(path.join(out, ...rel.split('/')), 'utf8'), content, `${rel} rendered into the temp root`);
  assert.match(runSync('--out', out).stdout, /already in sync/, 'a second run changes nothing');
  assert.equal(runSync('--out', out, '--check').status, 0);

  fs.appendFileSync(path.join(out, PLUGIN_DIR, 'hooks', 'hooks.json'), ' ');
  const drift = runSync('--out', out, '--check');
  assert.equal(drift.status, 1, 'drift fails --check');
  assert.match(drift.stderr, /hooks\/hooks\.json/);

  fs.writeFileSync(path.join(out, PLUGIN_DIR, 'agents', 'leftover.md'), 'stale', 'utf8');
  assert.equal(runSync('--out', out, '--check').status, 1, 'a stale file fails --check');
  assert.equal(runSync('--out', out).status, 0);
  assert.ok(!fs.existsSync(path.join(out, PLUGIN_DIR, 'agents', 'leftover.md')), 'a normal run removes the stale file');
  assert.equal(runSync('--out', out, '--check').status, 0, 'and the tree is in sync again');
  fs.rmSync(out, { recursive: true, force: true });
  console.log('✔ Test 2: --out relocates output; --check catches drift and stale files; a run repairs both');
}

// Test 3: plugin.json follows package.json and the documented manifest shape
{
  const manifest = readJson(`${PLUGIN_DIR}/.claude-plugin/plugin.json`);
  assert.equal(manifest.name, PLUGIN_NAME);
  assert.match(manifest.name, /^[a-z0-9-]+$/, 'kebab-case');
  assert.equal(manifest.version, pkg.version, 'the plugin version follows package.json');
  assert.ok(manifest.description.length > 20 && manifest.author?.name && manifest.license);
  // The repository is private, so package.json has no link to give the plugin; when there is one it must parse as a URL.
  if (manifest.homepage !== undefined) assert.match(manifest.homepage, /^https:\/\//, 'homepage must parse as a URL or the plugin fails to load');
  assert.deepEqual(Object.keys(manifest).filter((k) => ['hooks', 'mcpServers', 'agents', 'skills', 'commands'].includes(k)), [], 'components use their default locations, not manifest keys');
  console.log('✔ Test 3: plugin.json is valid, kebab-case, and versioned from package.json');
}

// Test 4: hooks and MCP come from the same source as `nativ setup`
{
  const desired = buildDesiredConfig(resolveCliInvocation({ command: 'nativ' }));
  const hooks = readJson(`${PLUGIN_DIR}/hooks/hooks.json`);
  assert.deepEqual(Object.keys(hooks), ['hooks'], 'a plugin hooks file wraps the events in a top-level hooks key');
  assert.deepEqual(hooks.hooks.PreToolUse, [{ matcher: desired.preToolUse.matcher, hooks: [{ type: 'command', command: 'nativ hook check', timeout: 10 }] }]);
  assert.deepEqual(hooks.hooks.SessionStart, [{ matcher: desired.sessionStart.matcher, hooks: [{ type: 'command', command: 'nativ hook context', timeout: 10 }] }]);
  assert.ok(!JSON.stringify(hooks).includes('CLAUDE_PLUGIN_ROOT'), 'nothing in the plugin depends on files bundled inside it');

  const mcp = readJson(`${PLUGIN_DIR}/.mcp.json`);
  assert.deepEqual(mcp, { mcpServers: { nativ: { command: 'nativ', args: ['mcp'] } } });
  console.log('✔ Test 4: hooks.json and .mcp.json match the setup generator');
}

// Test 5: agents follow the templates, with the plugin's MCP tool prefix
{
  for (const file of ['architect.md', 'worker.md', 'verifier.md', 'explorer.md']) {
    const agent = read(`${PLUGIN_DIR}/agents/${file}`);
    const template = read(`templates/claude-agents/${file}`);
    const fm = frontmatter(agent);
    assert.equal(fm.name, file.replace('.md', ''), `${file} name`);
    assert.ok(fm.description.length > 30, `${file} has a description that tells Claude when to delegate`);
    if (/\bmcp__nativ(?=__|\b)/.test(template)) {
      assert.match(fm.tools, /mcp__plugin_nativ_nativ(?=__|\b)/, `${file} uses the plugin's MCP tool prefix (mcp__plugin_<plugin>_<server>)`);
    }
    assert.ok(!/\bmcp__nativ(?=__|\b)/.test(fm.tools), `${file} must not use the project-scope prefix, which matches nothing inside a plugin`);
    assert.equal(agent, template.replace(/\bmcp__nativ(?=__|\b)/g, 'mcp__plugin_nativ_nativ'), `${file} differs from its template only by the tool prefix`);
  }
  for (const agent of ['verifier', 'explorer']) {
    const tools = frontmatter(read(`${PLUGIN_DIR}/agents/${agent}.md`)).tools;
    assert.ok(!/\b(Edit|Write|MultiEdit|NotebookEdit)\b/.test(tools), `the ${agent} stays read-only`);
  }
  assert.equal(frontmatter(read(`${PLUGIN_DIR}/agents/explorer.md`)).tools, 'Read, Grep, Glob', 'the explorer cannot run commands or nativ tools');
  console.log('✔ Test 5: plugin agents mirror the templates and use the plugin MCP prefix');
}

// Test 6: the skill carries the directive and says what a plugin cannot do
{
  const skill = read(`${PLUGIN_DIR}/skills/nativ/SKILL.md`);
  const fm = frontmatter(skill);
  assert.equal(fm.name, 'nativ');
  assert.ok(fm.description.length > 40, 'a skill description drives when Claude loads it');
  for (const marker of ['## Roles', '## Task loop', '## When the contract is wrong', '## Air-gap (critical)', '## Code style']) assert.ok(skill.includes(marker), `skill includes ${marker} from AGENTS.md`);
  assert.match(skill, /`recommendedModel`.*`model` parameter/, 'skill tells the manager to pass the recommended model');
  assert.match(skill, /`specSlices`, read those first/, 'skill tells workers to read spec slices first');
  assert.match(read(`${PLUGIN_DIR}/agents/worker.md`), /`specSlices`, read those first/, 'worker reads spec slices first');
  assert.match(skill, /npm i -g @njeybe\/nativ/, 'says the plugin needs nativ installed');
  assert.match(skill, /A plugin cannot ship permission rules\. Run `nativ setup`/, 'says permissions come from nativ setup');
  assert.equal(skill.split('# nativ Agent Directive').length, 1, 'the directive title is not duplicated');
  assert.ok(!exists(`${PLUGIN_DIR}/settings.json`), 'a plugin cannot carry permission rules, so none are pretended');
  console.log('✔ Test 6: the skill carries the AGENTS.md rules and the plugin limits');
}

// Test 7: the marketplace entry points at the plugin, and names agree
{
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, PLUGIN_NAME);
  assert.ok(marketplace.owner?.name, 'owner is required');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.source, './plugin', 'a relative path from the marketplace root');
  assert.ok(exists(`${PLUGIN_DIR}/.claude-plugin/plugin.json`), 'the source directory holds the manifest');
  assert.equal(entry.name, readJson(`${PLUGIN_DIR}/.claude-plugin/plugin.json`).name, 'entry name equals manifest name, or installs by manifest name fail');
  assert.equal(entry.version, pkg.version);
  assert.ok(!entry.source.includes('..'));
  console.log('✔ Test 7: the marketplace entry resolves to the plugin and the names agree');
}

// Test 8: packaging
{
  assert.equal(pkg.scripts['sync-plugin'], 'node scripts/sync-plugin.mjs');
  assert.ok(pkg.files.includes('plugin'), 'the plugin ships in the npm package');
  assert.ok(!/antigravity/i.test(pkg.description), 'the package description is no longer vendor-specific');
  console.log('✔ Test 8: package.json exposes sync-plugin and ships the plugin');
}

// Test 9: Claude Code's own validator accepts both, strictly (skipped when Claude Code is not installed)
{
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    console.log('- Test 9: skipped (claude is not on PATH)');
  } else {
    const validate = (target) => spawnSync('claude', ['plugin', 'validate', target, '--strict'], { encoding: 'utf8', cwd: root, timeout: 120_000, shell: process.platform === 'win32' });
    for (const target of ['./plugin', '.']) {
      const result = validate(target);
      assert.equal(result.status, 0, `claude plugin validate ${target} --strict failed:\n${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Validation passed/);
    }
    console.log('✔ Test 9: `claude plugin validate --strict` accepts the plugin and the marketplace');
  }
}

// Test 10: one version everywhere, and the publishing metadata is complete
{
  const pkg = readJson('package.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json has a plain semver version');
  const cli = spawnSync(process.execPath, [path.join(root, 'bin', 'cli.js'), '--version'], { encoding: 'utf8' });
  assert.equal(cli.stdout.trim(), pkg.version, '`nativ --version` reports the package.json version');
  assert.equal(readJson('plugin/.claude-plugin/plugin.json').version, pkg.version, 'plugin.json version');
  assert.equal(readJson('.claude-plugin/marketplace.json').plugins[0].version, pkg.version, 'marketplace version');
  assert.ok(pkg.author && typeof pkg.author === 'string', 'package.json names an author');
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.engines?.node ?? '', /^>=\d+/, 'package.json declares the supported Node version');
  assert.match(pkg.scripts.prepublishOnly, /build/, 'publishing rebuilds first');
  assert.match(pkg.scripts.prepublishOnly, /sync-plugin\.mjs --check/, 'publishing fails if the plugin is out of sync');
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.ok(license.includes(pkg.author), 'the LICENSE names the package author');
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}\\b`, 'm'), 'the changelog has an entry for this version');
  console.log('✔ Test 10: one version across CLI, plugin and marketplace; license, author, engines and changelog are in place');

  // What npm would actually publish
  const pack = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(pack.status, 0, `npm pack --dry-run failed: ${pack.stderr}`);
  const packed = JSON.parse(pack.stdout)[0].files.map((f) => f.path);
  for (const required of ['LICENSE', 'CHANGELOG.md', 'README.md', 'package.json', 'bin/cli.js', 'plugin/.claude-plugin/plugin.json', 'templates/AGENTS.md', 'templates/claude-agents/worker.md', 'dist/index.js']) {
    assert.ok(packed.includes(required), `the published package includes ${required}`);
  }
  assert.ok(!packed.some((f) => /^(tests|\.ai|\.nativ|\.claude|\.worktrees)\//.test(f) || f === '.env'), 'no tests, project state or secrets are published');
  console.log('✔ Test 11: the npm package contains the license, changelog, plugin and templates, and no project state');

  // The package is published under the author's scope; the unscoped name belongs to someone else.
  assert.equal(pkg.name, '@njeybe/nativ', 'package name');
  assert.equal(pkg.publishConfig?.access, 'public', 'a scoped package is restricted unless publishConfig.access is public');
  assert.deepEqual(Object.keys(pkg.bin), ['nativ'], 'the command stays nativ whatever the package is called');
  assert.equal(readJson('package-lock.json').name, pkg.name, 'the lockfile names the same package');
  for (const rel of ['README.md', 'docs/installation.md', 'templates/GEMINI.md', 'plugin/skills/nativ/SKILL.md']) {
    assert.ok(read(rel).includes('@njeybe/nativ') || rel === 'templates/GEMINI.md' || rel === 'plugin/skills/nativ/SKILL.md', `${rel} names the package`);
    assert.ok(!/\bnativ-cli\b/.test(read(rel)), `${rel} must not point users at the old nativ-cli package`);
  }
  assert.ok(read('CHANGELOG.md').includes('@njeybe/nativ'), 'the changelog explains the rename');
  console.log('✔ Test 12: published as @njeybe/nativ (public), command still nativ, no stale nativ-cli in user-facing files');

  // The source repository is private: nothing a user reads may depend on it, and the npm page must not link to it.
  for (const key of ['repository', 'homepage', 'bugs']) assert.equal(pkg[key], undefined, `package.json must not declare ${key} while the repository is private`);
  assert.equal(readJson('package-lock.json').version, pkg.version, 'the lockfile carries the package version');
  assert.equal(readJson('package-lock.json').packages[''].version, pkg.version, 'and so does its root package entry');
  for (const rel of ['README.md', 'docs/installation.md', 'templates/GEMINI.md', 'templates/AGENTS.md', 'plugin/skills/nativ/SKILL.md']) {
    const text = read(rel);
    assert.ok(!/github:njeybe|github\.com\/njeybe|marketplace add/i.test(text), `${rel} must not tell users to reach the private repository`);
  }
  const owner = readJson('.claude-plugin/marketplace.json').owner.name;
  assert.equal(owner, pkg.author, 'the marketplace owner is the package author');
  console.log('✔ Test 13: no install path or link depends on the private repository');
}

console.log('\n🎉 ALL PLUGIN MANIFEST TESTS PASSED!');
