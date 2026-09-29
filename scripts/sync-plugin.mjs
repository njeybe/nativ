#!/usr/bin/env node
/**
 * Renders the Claude Code plugin (plugin/) and its marketplace entry (.claude-plugin/marketplace.json)
 * from the same sources `nativ setup` uses, so the two can never drift apart:
 *
 *   hooks and MCP server   <- buildDesiredConfig() in dist/core/setup-assets.js
 *   agents                 <- templates/claude-agents/*.md
 *   skill                  <- templates/AGENTS.md
 *   name, version, links   <- package.json
 *
 * Usage: node scripts/sync-plugin.mjs [--out <root>] [--check]
 *   --out <root>  write under <root> instead of the repository root (tests use a temp dir)
 *   --check       write nothing; exit 1 if the committed files differ from what would be rendered
 *
 * Run `npm run build` first: the hook and MCP settings come from the compiled setup module.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PLUGIN_NAME = 'nativ';
export const PLUGIN_DIR = 'plugin';

const AGENT_FILES = ['architect.md', 'worker.md', 'verifier.md'];

const json = (value) => JSON.stringify(value, null, 2) + '\n';

/** Generated files are always LF. A Windows checkout with core.autocrlf hands us CRLF, which is not a change. */
const toLf = (text) => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
const readLf = (file) => toLf(fs.readFileSync(file, 'utf8'));

/** `git+https://github.com/owner/repo.git` -> { url: 'https://github.com/owner/repo', owner: 'owner' } */
function parseRepository(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw ?? '');
  return match ? { url: `https://github.com/${match[1]}/${match[2]}`, owner: match[1] } : null;
}

/** Returns Map<repo-relative path, content> for every generated file. */
export async function renderPlugin(root = repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { buildDesiredConfig, resolveCliInvocation } = await import(pathToFileURL(path.join(root, 'dist', 'core', 'setup-assets.js')).href);

  // A plugin cannot know where nativ lives, so it always calls the bare `nativ` command (npm i -g @njeybe/nativ).
  const desired = buildDesiredConfig(resolveCliInvocation({ command: 'nativ' }));
  const repo = parseRepository(pkg);
  const authorName = (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name) || repo?.owner || null;
  const files = new Map();

  files.set(
    `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
    json({
      name: PLUGIN_NAME,
      displayName: 'nativ',
      version: pkg.version,
      description: 'Role-based multi-agent workflow for Claude Code: architect, worker and verifier agents, task-scope enforcement, and the nativ MCP server.',
      ...(authorName ? { author: { name: authorName } } : {}),
      // The repository may be private, in which case package.json carries no link and neither does the plugin.
      ...(repo ? { homepage: repo.url, repository: repo.url } : {}),
      license: pkg.license ?? 'MIT',
      keywords: ['multi-agent', 'workflow', 'contracts', 'orchestration'],
    }),
  );

  files.set(
    `${PLUGIN_DIR}/hooks/hooks.json`,
    json({
      hooks: {
        PreToolUse: [{ matcher: desired.preToolUse.matcher, hooks: [{ type: 'command', command: desired.preToolUse.command, timeout: desired.preToolUse.timeout }] }],
        SessionStart: [{ matcher: desired.sessionStart.matcher, hooks: [{ type: 'command', command: desired.sessionStart.command, timeout: desired.sessionStart.timeout }] }],
      },
    }),
  );

  files.set(`${PLUGIN_DIR}/.mcp.json`, json({ mcpServers: { [PLUGIN_NAME]: { command: desired.mcpServer.command, args: desired.mcpServer.args } } }));

  // Inside a plugin, Claude Code names the MCP server's tools mcp__plugin_<plugin>_<server>__*, not mcp__<server>__*
  // (verified against Claude Code 2.1.284), so the agents' tool lists must use the plugin form.
  for (const file of AGENT_FILES) {
    const template = readLf(path.join(root, 'templates', 'claude-agents', file));
    files.set(`${PLUGIN_DIR}/agents/${file}`, template.replace(/\bmcp__nativ\b/g, `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}`));
  }

  // The skill is the canonical directive, so an installed plugin and `nativ setup` teach the same rules.
  const directive = readLf(path.join(root, 'templates', 'AGENTS.md')).replace(/^# .*\n+/, '');
  files.set(
    `${PLUGIN_DIR}/skills/nativ/SKILL.md`,
    [
      '---',
      'name: nativ',
      'description: Use in any project that has a .ai/ folder or uses nativ: run the role-based task loop (task next, start, verify, complete), respect contracts, escalate gaps, and keep to the active task scope.',
      '---',
      '',
      '# nativ workflow',
      '',
      '> This plugin supplies the agents, the enforcement hooks, the MCP server and this guide. It calls the `nativ` command, so install it once with `npm i -g @njeybe/nativ`.',
      '> A plugin cannot ship permission rules. Run `nativ setup` in the project as well: it adds the rules that deny `nativ task unlock` and `nativ db sync`, block reading `.env*` files, and make Claude Code ask before any write under `.ai/`. `nativ doctor` checks both.',
      '',
      directive.trimEnd(),
      '',
    ].join('\n'),
  );

  files.set(
    '.claude-plugin/marketplace.json',
    json({
      name: PLUGIN_NAME,
      description: 'nativ: role-based multi-agent workflow for Claude Code',
      owner: { name: authorName ?? 'nativ' },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: `./${PLUGIN_DIR}`,
          description: 'Architect, worker and verifier agents, task-scope enforcement hooks, the nativ MCP server and the task-loop skill.',
          version: pkg.version,
        },
      ],
    }),
  );

  return files;
}

/** Repo-relative paths of files under plugin/ that are not in `expected`, so stale files can be reported. */
export function findStaleFiles(root, expected) {
  const stale = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (!expected.has(rel)) stale.push(rel);
      }
    }
  };
  walk(path.join(root, PLUGIN_DIR));
  return stale;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIndex = args.indexOf('--out');
  const outRoot = outIndex >= 0 ? path.resolve(args[outIndex + 1] ?? '') : repoRoot;

  const files = await renderPlugin(repoRoot);
  const drift = [];
  for (const [rel, content] of files) {
    const target = path.join(outRoot, ...rel.split('/'));
    // Compared byte for byte: Claude Code cannot parse CRLF frontmatter, so a CRLF file on disk is drift.
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    drift.push(rel);
    if (!check) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
  }
  const stale = findStaleFiles(outRoot, new Set(files.keys()));
  if (!check) for (const rel of stale) fs.rmSync(path.join(outRoot, ...rel.split('/')), { force: true });

  if (check) {
    if (drift.length || stale.length) {
      console.error(`Plugin files are out of sync. Run \`npm run sync-plugin\`.\n  changed: ${drift.join(', ') || 'none'}\n  stale: ${stale.join(', ') || 'none'}`);
      process.exitCode = 1;
    } else console.log(`Plugin is in sync (${files.size} files).`);
    return;
  }
  console.log(drift.length || stale.length ? `Plugin synced: ${drift.length} written, ${stale.length} stale removed (${files.size} files).` : `Plugin already in sync (${files.size} files).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
