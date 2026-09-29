/**
 * nativ-cli · Single source for every file `nativ setup` generates.
 *
 * `planSetup` computes what each asset should contain and whether that differs from disk; `applySetup`
 * writes the differences; `nativ doctor` reuses the same plan to detect drift. Everything merges into
 * existing files: user-authored settings, servers and agent files are never overwritten.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLE_ENV, loadEnforcementMode, parseJsonLoose, type EnforcementMode } from './enforcement.js';
import { resolveProjectRoot } from './root-resolver.js';
import { isLegacyTemplate, normalizeForHash } from './legacy-templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MCP_SERVER_NAME = 'nativ';
export const AGENT_FILES = ['architect.md', 'worker.md', 'verifier.md'] as const;

const MANAGED_PREFIX = '<!-- nativ:managed sha256=';
const MANAGED_PATTERN = /\n?<!-- nativ:managed sha256=([0-9a-f]{12}) -->\s*$/;

const PRE_TOOL_USE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
const SESSION_START_MATCHER = 'startup|resume|clear|compact';
const HOOK_TIMEOUT_SECONDS = 10;

export type AssetAction = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface AssetChange {
  /** Path relative to the project root, forward slashes. */
  path: string;
  action: AssetAction;
  detail?: string;
}

export interface CliInvocation {
  command: string;
  prefixArgs: string[];
  /** False when the command embeds an absolute path, which will not work on another machine. */
  portable: boolean;
}

export interface SetupOptions {
  /** How Claude Code should invoke nativ, e.g. `npx -y nativ-cli`. Defaults to `nativ` when it is on PATH. */
  command?: string;
  enforcement?: EnforcementMode;
  /** Also overwrite agent files that were edited by hand or are not nativ's. */
  force?: boolean;
  hasBinary?: (name: string) => boolean;
  templatesDir?: string;
}

export interface SetupPlan {
  root: string;
  invocation: CliInvocation;
  changes: AssetChange[];
  warnings: string[];
  /** Full new content per changed path, keyed by the same relative path. */
  writes: Map<string, string>;
}

// ─── CLI invocation ────────────────────────────────────────────────────────────────────────────────

export function defaultHasBinary(name: string): boolean {
  try {
    return spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function quoteIfNeeded(part: string): string {
  return /[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part;
}

export function resolveCliInvocation(options: { command?: string; hasBinary?: (name: string) => boolean } = {}): CliInvocation {
  const explicit = options.command?.trim();
  if (explicit) {
    const [command, ...prefixArgs] = explicit.split(/\s+/);
    return { command, prefixArgs, portable: ![command, ...prefixArgs].some((p) => path.isAbsolute(p)) };
  }
  if ((options.hasBinary ?? defaultHasBinary)('nativ')) return { command: 'nativ', prefixArgs: [], portable: true };
  // Not installed globally: fall back to this very build, which only works on this machine.
  const self = path.resolve(__dirname, '..', '..', 'bin', 'cli.js').replace(/\\/g, '/');
  return { command: 'node', prefixArgs: [self], portable: false };
}

/** The invocation as a shell string, e.g. `npx -y nativ-cli`, quoting parts that need it. */
export function cliString(invocation: CliInvocation): string {
  return [invocation.command, ...invocation.prefixArgs].map(quoteIfNeeded).join(' ');
}

// ─── Desired settings ──────────────────────────────────────────────────────────────────────────────

/** Secret files an agent must not read. Mirrors the env files the air-gap protects. */
const SECRET_READ_DENY = [
  'Read(./.env)',
  'Read(./.env.local)',
  'Read(./.env.development)',
  'Read(./.env.development.local)',
  'Read(./.env.production)',
  'Read(./.env.production.local)',
  'Read(./**/*.pem)',
  'Read(./**/*.key)',
];

export interface DesiredClaudeConfig {
  cli: string;
  mcpServer: { command: string; args: string[] };
  allow: string[];
  deny: string[];
  ask: string[];
  preToolUse: { matcher: string; command: string; timeout: number };
  sessionStart: { matcher: string; command: string; timeout: number };
}

export function buildDesiredConfig(invocation: CliInvocation): DesiredClaudeConfig {
  const cli = cliString(invocation);
  const prefixes = [...new Set([cli, 'nativ'])];
  return {
    cli,
    mcpServer: { command: invocation.command, args: [...invocation.prefixArgs, 'mcp'] },
    allow: [`Bash(${cli} *)`, `mcp__${MCP_SERVER_NAME}__*`],
    // Deny beats allow, so the broad `nativ *` allow cannot be used to lift a guardrail or write a contract.
    deny: [
      ...prefixes.flatMap((p) => [
        `Bash(${p} task unlock *)`,
        `Bash(${p} db sync *)`,
        `Bash(${p} task complete * --no-verify)`,
        `Bash(${p} task complete * --no-verify *)`,
      ]),
      ...SECRET_READ_DENY,
    ],
    // Contract edits always need a human's yes, whichever agent asks.
    ask: ['Edit(./.ai/**)', 'Write(./.ai/**)'],
    preToolUse: { matcher: PRE_TOOL_USE_MATCHER, command: `${cli} hook check`, timeout: HOOK_TIMEOUT_SECONDS },
    sessionStart: { matcher: SESSION_START_MATCHER, command: `${cli} hook context`, timeout: HOOK_TIMEOUT_SECONDS },
  };
}

// ─── JSON merging ──────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unionStrings(existing: unknown, wanted: string[]): { list: string[]; added: string[] } {
  const list = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === 'string') : [];
  const added = wanted.filter((w) => !list.includes(w));
  return { list: [...list, ...added], added };
}

const isNativHookCommand = (command: unknown, kind: 'check' | 'context'): boolean =>
  typeof command === 'string' && new RegExp(`\\bhook ${kind}\\b`).test(command) && /nativ|cli\.js/.test(command);

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Updates our hook in place when there is one, appends a group when there is not, leaves every other group alone. */
function mergeHook(groups: unknown, kind: 'check' | 'context', want: { matcher: string; command: string; timeout: number }): { groups: HookGroup[]; changed: boolean } {
  const list: HookGroup[] = Array.isArray(groups) ? (groups.filter(isObject) as HookGroup[]) : [];
  const desiredHook = { type: 'command', command: want.command, timeout: want.timeout };
  for (const group of list) {
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    const index = hooks.findIndex((h) => isNativHookCommand(h?.command, kind));
    if (index === -1) continue;
    const before = JSON.stringify([group.matcher, hooks[index]]);
    group.matcher = want.matcher;
    hooks[index] = { ...hooks[index], ...desiredHook };
    group.hooks = hooks;
    return { groups: list, changed: JSON.stringify([group.matcher, hooks[index]]) !== before };
  }
  list.push({ matcher: want.matcher, hooks: [desiredHook] });
  return { groups: list, changed: true };
}

export interface MergeResult {
  merged: Json;
  changes: string[];
  warnings: string[];
}

export function mergeClaudeSettings(existing: Json, desired: DesiredClaudeConfig): MergeResult {
  const merged: Json = { ...existing };
  const changes: string[] = [];
  const warnings: string[] = [];

  const permissions: Json = isObject(merged.permissions) ? { ...merged.permissions } : {};
  for (const [key, wanted] of [['allow', desired.allow], ['deny', desired.deny], ['ask', desired.ask]] as const) {
    const { list, added } = unionStrings(permissions[key], wanted);
    if (added.length) {
      permissions[key] = list;
      changes.push(`permissions.${key}: +${added.length}`);
    }
  }
  merged.permissions = permissions;

  const hooks: Json = isObject(merged.hooks) ? { ...merged.hooks } : {};
  const pre = mergeHook(hooks.PreToolUse, 'check', desired.preToolUse);
  hooks.PreToolUse = pre.groups;
  if (pre.changed) changes.push('hooks.PreToolUse (nativ hook check)');
  const start = mergeHook(hooks.SessionStart, 'context', desired.sessionStart);
  hooks.SessionStart = start.groups;
  if (start.changed) changes.push('hooks.SessionStart (nativ hook context)');
  merged.hooks = hooks;

  const enabled = unionStrings(merged.enabledMcpjsonServers, [MCP_SERVER_NAME]);
  if (enabled.added.length) {
    merged.enabledMcpjsonServers = enabled.list;
    changes.push('enabledMcpjsonServers: +nativ');
  }
  if (Array.isArray(merged.disabledMcpjsonServers) && merged.disabledMcpjsonServers.includes(MCP_SERVER_NAME)) {
    warnings.push(`.claude/settings.json disables the "${MCP_SERVER_NAME}" MCP server; leaving that choice alone.`);
  }
  return { merged, changes, warnings };
}

export function mergeMcpConfig(existing: Json, desired: DesiredClaudeConfig): { merged: Json; changed: boolean } {
  const servers: Json = isObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  const current = servers[MCP_SERVER_NAME];
  const want = { command: desired.mcpServer.command, args: desired.mcpServer.args };
  const same =
    isObject(current) && current.command === want.command && JSON.stringify(current.args) === JSON.stringify(want.args);
  if (!same) servers[MCP_SERVER_NAME] = isObject(current) ? { ...current, ...want } : want;
  return { merged: { ...existing, mcpServers: servers }, changed: !same };
}

// ─── Managed markdown files ────────────────────────────────────────────────────────────────────────

const shortHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

/** CRLF and a leading BOM to plain LF. */
export const toLf = (text: string): string => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** Appends the marker that lets a later run tell "nativ wrote this, untouched" from "a person edited this". */
export function stampManaged(content: string): string {
  // Always LF: a Windows checkout (core.autocrlf) or an editor may hand us CRLF, and neither is an edit.
  const body = toLf(content).replace(/\s+$/, '');
  return `${body}\n\n${MANAGED_PREFIX}${shortHash(body)} -->\n`;
}

export type ManagedState = 'pristine' | 'modified' | 'unmanaged';

export function managedState(content: string): ManagedState {
  const lf = toLf(content);
  const match = MANAGED_PATTERN.exec(lf);
  if (!match) return 'unmanaged';
  const body = lf.slice(0, match.index).replace(/\s+$/, '');
  return shortHash(body) === match[1] ? 'pristine' : 'modified';
}

export interface TemplateFilePlan {
  action: AssetAction;
  detail?: string;
  /** The stamped content to write; absent when nothing should change. */
  content?: string;
}

/**
 * Decides what to do with a file derived from a template (a directive or a role guide).
 * Missing files are created; files nativ wrote and nobody edited (marker intact, or matching a template nativ
 * shipped before markers existed) follow the template; anything edited by hand is kept unless `force` is set.
 * `legacyKey` names the file in LEGACY_TEMPLATE_HASHES.
 */
export function planTemplateFile(existing: string | null, template: string, legacyKey: string, force = false): TemplateFilePlan {
  const next = stampManaged(template);
  if (existing === null) return { action: 'created', content: next };
  if (existing === next) return { action: 'unchanged' };

  const state = managedState(existing);
  if (state === 'pristine') return { action: 'updated', detail: 'template updated', content: next };
  if (state === 'unmanaged') {
    if (normalizeForHash(existing) === normalizeForHash(template)) return { action: 'updated', detail: 'now tracked by nativ', content: next };
    if (isLegacyTemplate(legacyKey, existing)) return { action: 'updated', detail: 'refreshed from an earlier nativ template', content: next };
  }
  if (force) return { action: 'updated', detail: 'forced', content: next };
  return {
    action: 'skipped',
    detail:
      state === 'modified'
        ? 'edited by hand (use --force to replace)'
        : 'not an untouched nativ template, so treated as edited by hand (use --force to replace)',
  };
}

// ─── Planning ──────────────────────────────────────────────────────────────────────────────────────

export function getTemplatesDir(): string {
  const candidate = path.resolve(__dirname, '..', '..', 'templates');
  return fs.existsSync(candidate) ? candidate : path.resolve(__dirname, '..', 'templates');
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
    return { command: server.command, prefixArgs, portable: ![server.command, ...prefixArgs].some((p) => path.isAbsolute(p)) };
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
        'Install it globally (npm i -g nativ-cli) or pass --command "npx -y nativ-cli" so the config works for your team.',
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

export interface SetupResult {
  root: string;
  dryRun: boolean;
  invocation: CliInvocation;
  changes: AssetChange[];
  warnings: string[];
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

// ─── SessionStart context ──────────────────────────────────────────────────────────────────────────

interface PlanTask {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  targetFiles: string[];
}

function readPlanTasks(root: string): PlanTask[] {
  try {
    const plan = parseJsonLoose<{ milestones?: Array<{ tasks?: Array<Partial<PlanTask>> }> }>(
      fs.readFileSync(path.join(root, '.ai', 'master_plan.json'), 'utf8'),
    );
    const tasks: PlanTask[] = [];
    for (const milestone of plan.milestones ?? []) {
      for (const t of milestone.tasks ?? []) {
        if (typeof t.id === 'string') {
          tasks.push({
            id: t.id,
            title: typeof t.title === 'string' ? t.title : '',
            status: typeof t.status === 'string' ? t.status : 'pending',
            dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
            targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles : [],
          });
        }
      }
    }
    return tasks;
  } catch {
    return [];
  }
}

/** A few lines of orientation for a new Claude Code session, or null when this is not a nativ project. */
export function buildSessionContext(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = resolveProjectRoot(cwd);
  if (!fs.existsSync(path.join(root, '.ai', 'master_plan.json'))) return null;

  const tasks = readPlanTasks(root);
  const active = tasks.filter((t) => t.status === 'in_progress');
  const done = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id));
  const next = tasks.find((t) => t.status === 'pending' && t.dependencies.every((d) => done.has(d)));
  const role = (env[ROLE_ENV] ?? '').trim().toLowerCase() || 'project manager';

  const lines = [
    'This is a nativ project (role-based multi-agent workflow).',
    `Session role: ${role}. Enforcement: ${loadEnforcementMode(root)}. Edits outside the active task's targetFiles are flagged, and .ai/ contracts are architect-only.`,
  ];
  if (active.length) {
    for (const t of active) lines.push(`In progress: ${t.id} "${t.title}" (targetFiles: ${t.targetFiles.join(', ') || 'none'})`);
  } else if (next) {
    lines.push(`Next available task: ${next.id} "${next.title}". Run \`nativ task next\` to load its context.`);
  } else {
    lines.push('No task is in progress or ready.');
  }
  lines.push('Prefer the nativ_* MCP tools (or the `nativ` CLI). Do not edit .ai/ directly: escalate contract gaps with `nativ task escalate`.');
  return lines.join('\n');
}


/** `nativ hook context`: prints the SessionStart hook output. Never throws and always prints valid JSON or nothing. */
export function runSessionContext(targetDirArg?: string, write: (text: string) => void = (t) => process.stdout.write(t)): void {
  try {
    const context = buildSessionContext(targetDirArg ? path.resolve(targetDirArg) : process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (context) write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  } catch {
    // Orientation is a convenience; a failure must never disturb session start.
  }
}
