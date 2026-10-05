import {
  MCP_SERVER_NAME,
  PRE_TOOL_USE_MATCHER,
  SESSION_START_MATCHER,
  HOOK_TIMEOUT_SECONDS,
  CliInvocation,
  cliString,
} from './types.js';

/** Secret files an agent must not read. Mirrors the env files the air-gap protects. */
export const SECRET_READ_DENY = [
  'Read(./.env)',
  'Read(./.env.local)',
  'Read(./.env.development)',
  'Read(./.env.development.local)',
  'Read(./.env.production)',
  'Read(./.env.production.local)',
  'Read(./**/*.pem)',
  'Read(./**/*.key)',
  'Read(./.nativ/*.local.json)',
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
        `Bash(${p} learn approve *)`,
        `Bash(${p} learn reject *)`,
        `Bash(${p} db sync *)`,
        `Bash(${p} task complete * --no-verify)`,
        `Bash(${p} task complete * --no-verify *)`,
      ]),
      ...SECRET_READ_DENY,
    ],
    // Contract edits always need a human's yes, whichever agent asks.
    ask: ['Edit(./.ai/**)', 'Write(./.ai/**)', 'Edit(./.nativ/**)', 'Write(./.nativ/**)'],
    preToolUse: { matcher: PRE_TOOL_USE_MATCHER, command: `${cli} hook check`, timeout: HOOK_TIMEOUT_SECONDS },
    sessionStart: { matcher: SESSION_START_MATCHER, command: `${cli} hook context`, timeout: HOOK_TIMEOUT_SECONDS },
  };
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function unionStrings(existing: unknown, wanted: string[]): { list: string[]; added: string[] } {
  const list = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === 'string') : [];
  const added = wanted.filter((w) => !list.includes(w));
  return { list: [...list, ...added], added };
}

const isNativHookCommand = (command: unknown, kind: 'check' | 'context'): boolean =>
  typeof command === 'string' && new RegExp(`\\bhook ${kind}\\b`).test(command) && /nativ|cli\.js/.test(command);

export interface HookGroup {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Updates our hook in place when there is one, appends a group when there is not, leaves every other group alone. */
export function mergeHook(groups: unknown, kind: 'check' | 'context', want: { matcher: string; command: string; timeout: number }): { groups: HookGroup[]; changed: boolean } {
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
