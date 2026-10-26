import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SECRET_READ_DENY, isObject } from './config-merger.js';
import type { Json } from './config-merger.js';
import { AGENT_FILES, MCP_SERVER_NAME, managedState } from './types.js';

export const BLOCK_START = '# >>> nativ (managed) >>>';
export const BLOCK_END = '# <<< nativ (managed) <<<';

export type GitVisibility = 'hidden' | 'shared';

/** Secret and machine-local paths: ignored even when the team shares nativ's files. */
export const SHARED_PATHS = [
  '/.nativ/*.local.json',
  '/.nativ/logs/',
  '/.nativ/*.log',
  '/.nativ/notify-state.json',
  '/.worktrees/',
] as const;

const read = (root: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

/** Exactly what older nativ versions wrote for CLAUDE.md / GEMINI.md. */
function isOldPointer(text: string): boolean {
  const lf = text.replace(/\r\n/g, '\n');
  return ['Claude Code', 'Gemini / Antigravity'].some((t) => lf === `# ${t} directive\n\n@AGENTS.md\n`);
}

function isNativOwnedFile(text: string | null, allowPointer: boolean): boolean {
  if (text === null) return false;
  if (managedState(text) !== 'unmanaged') return true;
  return allowPointer && isOldPointer(text);
}

const parseObject = (text: string | null): Json | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

function onlyNativMcp(root: string): boolean {
  const json = parseObject(read(root, '.mcp.json'));
  if (!json) return false;
  const keys = Object.keys(json).filter((k) => k !== 'mcpServers');
  if (keys.length || !isObject(json.mcpServers)) return false;
  const names = Object.keys(json.mcpServers);
  return names.length > 0 && names.every((n) => n === MCP_SERVER_NAME);
}

const ownedPermission = (entry: unknown): boolean =>
  typeof entry === 'string' &&
  (/nativ|cli\.js/.test(entry) || /^(Edit|Write)\(\.\/\.(ai|nativ)\/\*\*\)$/.test(entry) ||
    (SECRET_READ_DENY as readonly string[]).includes(entry));

function ownedHooks(hooks: unknown): boolean {
  if (!isObject(hooks)) return false;
  return Object.values(hooks).every((groups) => Array.isArray(groups) && groups.every((g) => {
    const list: unknown = isObject(g) ? g.hooks : null;
    return Array.isArray(list) && list.every((h) => isObject(h) && /nativ|cli\.js/.test(String(h.command)));
  }));
}

function onlyNativSettings(root: string): boolean {
  const json = parseObject(read(root, '.claude/settings.json'));
  if (!json) return false;
  const allowed = new Set(['permissions', 'hooks', 'enabledMcpjsonServers']);
  if (Object.keys(json).some((k) => !allowed.has(k))) return false;
  if (json.permissions !== undefined) {
    const perms = json.permissions;
    if (!isObject(perms)) return false;
    for (const [k, v] of Object.entries(perms)) {
      if (!['allow', 'deny', 'ask'].includes(k) || !Array.isArray(v) || !v.every(ownedPermission)) return false;
    }
  }
  if (json.hooks !== undefined && !ownedHooks(json.hooks)) return false;
  const enabled = json.enabledMcpjsonServers;
  return enabled === undefined || (Array.isArray(enabled) && enabled.every((s) => s === MCP_SERVER_NAME));
}

/** Root-anchored paths nativ generated in this project, per the git-visibility choice. */
export function listGeneratedPaths(root: string, visibility: GitVisibility = 'hidden'): string[] {
  if (visibility === 'shared') return [...SHARED_PATHS];
  const paths = ['/.ai/', '/.nativ/', '/.worktrees/'];
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    if (isNativOwnedFile(read(root, file), true)) paths.push(`/${file}`);
  }
  for (const file of AGENT_FILES) {
    const rel = `.claude/agents/${file}`;
    if (isNativOwnedFile(read(root, rel), false)) paths.push(`/${rel}`);
  }
  if (onlyNativMcp(root)) paths.push('/.mcp.json');
  if (onlyNativSettings(root)) paths.push('/.claude/settings.json');
  return paths;
}

export function renderBlock(paths: string[], eol = '\n'): string {
  return [BLOCK_START, ...paths, BLOCK_END].join(eol);
}

/** Inserts or replaces the managed block; text outside it and its line endings stay as they were. */
export function applyBlock(existing: string | null, paths: string[]): string {
  const text = existing ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = renderBlock(paths, eol);
  const start = text.indexOf(BLOCK_START);
  const endAt = start === -1 ? -1 : text.indexOf(BLOCK_END, start);
  if (start !== -1 && endAt !== -1) {
    return text.slice(0, start) + block + text.slice(endAt + BLOCK_END.length);
  }
  if (text.trim() === '') return block + eol;
  const sep = text.endsWith('\n') ? eol : eol + eol;
  return text + sep + block + eol;
}

export interface TrackedResult {
  tracked: string[];
  /** Command for the human to run; nativ never runs it. */
  command: string;
}

/** Lists generated paths that git already tracks. Non-git folders give an empty list. */
export function trackedNativPaths(root: string, paths: string[]): TrackedResult {
  const none = { tracked: [], command: '' };
  const specs = paths.map((p) => p.replace(/^\//, '')).filter((p) => !p.includes('*'));
  if (!specs.length) return none;
  const out = spawnSync('git', ['ls-files', '-z', '--', ...specs], { cwd: root, encoding: 'utf8' });
  if (out.status !== 0 || !out.stdout) return none;
  const files = out.stdout.split('\0').filter(Boolean);
  const tracked = specs.filter((s) => files.some((f) => f === s || f.startsWith(s.endsWith('/') ? s : `${s}/`)));
  if (!tracked.length) return none;
  return { tracked, command: `git rm --cached -r -- ${tracked.join(' ')}` };
}
