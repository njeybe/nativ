import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MCP_SERVER_NAME,
  AGENT_FILES,
  AssetChange,
  CliInvocation,
  SetupOptions,
  SetupPlan,
  SetupResult,
  resolveCliInvocation,
  isMachineBoundPath,
  stampManaged,
  managedState,
} from './types.js';
import {
  buildDesiredConfig,
  mergeClaudeSettings,
  mergeMcpConfig,
  isObject,
  Json,
} from './config-merger.js';
import { loadEnforcementMode, parseJsonLoose } from '../enforcement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getTemplatesDir(): string {
  const candidate = path.resolve(__dirname, '..', '..', '..', 'templates');
  return fs.existsSync(candidate) ? candidate : path.resolve(__dirname, '..', '..', 'templates');
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * The command already registered for the nativ MCP server in `.mcp.json`, when it has the shape setup writes
 * (`<command> <args...> mcp`). Reusing it keeps hooks and permissions in step with what the project chose, so a
 * plain `nativ setup` or `nativ doctor --fix` never silently swaps a deliberate `--command` for auto-detection.
 */
export function configuredInvocation(root: string): CliInvocation | null {
  const text = readText(path.join(root, '.mcp.json'));
  if (text === null) return null;
  try {
    const parsed = parseJsonLoose(text);
    const server = isObject(parsed) && isObject(parsed.mcpServers) ? parsed.mcpServers[MCP_SERVER_NAME] : undefined;
    if (!isObject(server) || typeof server.command !== 'string' || !server.command.trim()) return null;
    const args = Array.isArray(server.args) ? server.args : [];
    if (args.length === 0 || args[args.length - 1] !== 'mcp' || !args.every((a) => typeof a === 'string')) return null;
    const prefixArgs = args.slice(0, -1) as string[];
    return { command: server.command, prefixArgs, portable: ![server.command, ...prefixArgs].some(isMachineBoundPath) };
  } catch {
    return null;
  }
}

/** Computes what `nativ setup` would do, without touching disk. */
export function planSetup(rootArg: string, options: SetupOptions = {}): SetupPlan {
  const root = path.resolve(rootArg);
  const invocation = options.command?.trim()
    ? resolveCliInvocation({ command: options.command, hasBinary: options.hasBinary })
    : configuredInvocation(root) ?? resolveCliInvocation({ hasBinary: options.hasBinary });
  const desired = buildDesiredConfig(invocation);
  const templatesDir = options.templatesDir ?? getTemplatesDir();
  const changes: AssetChange[] = [];
  const warnings: string[] = [];
  const writes = new Map<string, string>();

  if (!invocation.portable) {
    warnings.push(
      'nativ is not on PATH, so the generated config points at this machine\'s install. ' +
        'Install it globally (npm i -g @njeybe/nativ) or pass --command "npx -y @njeybe/nativ" so the config works for your team.',
    );
  }

  const record = (rel: string, existing: string | null, next: string, detail?: string) => {
    if (existing === null) {
      changes.push({ path: rel, action: 'created', detail });
      writes.set(rel, next);
    } else if (existing === next) {
      changes.push({ path: rel, action: 'unchanged' });
    } else {
      changes.push({ path: rel, action: 'updated', detail });
      writes.set(rel, next);
    }
  };

  const skip = (rel: string, detail: string) => {
    changes.push({ path: rel, action: 'skipped', detail });
    warnings.push(`${rel}: ${detail}`);
  };

  /** Reads a JSON file for merging. Returns null (after recording a skip) when it exists but is not valid JSON. */
  const readJsonObject = (rel: string): { text: string | null; value: Json } | null => {
    const text = readText(path.join(root, rel));
    if (text === null || !text.trim()) return { text, value: {} };
    try {
      const parsed = parseJsonLoose(text);
      if (isObject(parsed)) return { text, value: parsed };
    } catch {
      // Fall through.
    }
    skip(rel, 'exists but is not a valid JSON object; not modified. Fix or delete it and re-run.');
    return null;
  };

  // .mcp.json
  const mcp = readJsonObject('.mcp.json');
  if (mcp) {
    const { merged, changed } = mergeMcpConfig(mcp.value, desired);
    record('.mcp.json', mcp.text, changed || mcp.text === null ? serializeJson(merged) : mcp.text, changed ? `${MCP_SERVER_NAME} server -> ${desired.cli} mcp` : undefined);
  }

  // .claude/settings.json
  const settings = readJsonObject('.claude/settings.json');
  if (settings) {
    const { merged, changes: settingChanges, warnings: settingWarnings } = mergeClaudeSettings(settings.value, desired);
    warnings.push(...settingWarnings);
    record(
      '.claude/settings.json',
      settings.text,
      settingChanges.length || settings.text === null ? serializeJson(merged) : (settings.text ?? ''),
      settingChanges.join('; ') || undefined,
    );
  }

  // .claude/agents/*.md: written only when missing, pristine, or forced
  for (const file of AGENT_FILES) {
    const rel = `.claude/agents/${file}`;
    const template = readText(path.join(templatesDir, 'claude-agents', file));
    if (template === null) {
      skip(rel, `template templates/claude-agents/${file} is missing from this nativ install.`);
      continue;
    }
    const next = stampManaged(template);
    const existing = readText(path.join(root, rel));
    if (existing === null || existing === next) {
      record(rel, existing, next);
      continue;
    }
    const state = managedState(existing);
    if (state === 'pristine' || options.force) record(rel, existing, next, state === 'pristine' ? 'template updated' : 'forced');
    else skip(rel, state === 'modified' ? 'was edited by hand; not overwritten (use --force to replace).' : 'exists and is not managed by nativ; not overwritten (use --force to replace).');
  }

  // AGENTS.md is the canonical directive; CLAUDE.md and GEMINI.md only ever get a pointer, and only when absent
  const agents = readText(path.join(templatesDir, 'AGENTS.md'));
  if (agents === null) {
    skip('AGENTS.md', 'template templates/AGENTS.md is missing from this nativ install.');
  } else {
    const next = stampManaged(agents);
    const existing = readText(path.join(root, 'AGENTS.md'));
    if (existing === null || existing === next) record('AGENTS.md', existing, next);
    else if (managedState(existing) === 'pristine' || options.force) record('AGENTS.md', existing, next, 'template updated');
    else skip('AGENTS.md', 'exists and was not written by nativ (or was edited); not overwritten (use --force to replace).');
  }
  for (const [file, title] of [['CLAUDE.md', 'Claude Code'], ['GEMINI.md', 'Gemini / Antigravity']] as const) {
    const existing = readText(path.join(root, file));
    if (existing === null) record(file, null, `# ${title} directive\n\n@AGENTS.md\n`);
    else changes.push({ path: file, action: 'unchanged', detail: /AGENTS\.md/.test(existing) ? undefined : 'exists; does not reference AGENTS.md' });
  }

  // .nativ/config.json
  const config = readJsonObject('.nativ/config.json');
  if (config) {
    const next: Json = { ...config.value };
    let detail: string | undefined;
    if (options.enforcement && next.enforcement !== options.enforcement) {
      next.enforcement = options.enforcement;
      detail = `enforcement=${options.enforcement}`;
    } else if (next.enforcement === undefined) {
      next.enforcement = loadEnforcementMode(root);
      detail = `enforcement=${String(next.enforcement)}`;
    }
    record('.nativ/config.json', config.text, detail || config.text === null ? serializeJson(next) : (config.text ?? ''), detail);
  }

  return { root, invocation, changes, warnings, writes };
}

/** Writes the planned differences. Idempotent: applying twice changes nothing the second time. */
export function applySetup(rootArg: string, options: SetupOptions & { dryRun?: boolean } = {}): SetupResult {
  const plan = planSetup(rootArg, options);
  if (!options.dryRun) {
    for (const [rel, content] of plan.writes) {
      const file = path.join(plan.root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, file);
    }
  }
  return { root: plan.root, dryRun: options.dryRun === true, invocation: plan.invocation, changes: plan.changes, warnings: plan.warnings };
}
