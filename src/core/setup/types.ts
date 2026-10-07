import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EnforcementMode } from '../enforcement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MCP_SERVER_NAME = 'nativ';
export const AGENT_FILES = ['architect.md', 'worker.md', 'verifier.md', 'explorer.md'] as const;

export const MANAGED_PREFIX = '<!-- nativ:managed sha256=';
export const MANAGED_PATTERN = /\n?<!-- nativ:managed sha256=([0-9a-f]{12}) -->\s*$/;

export const PRE_TOOL_USE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit';
export const SESSION_START_MATCHER = 'startup|resume|clear|compact';
export const HOOK_TIMEOUT_SECONDS = 10;

/** `.mcp.json` is shared between machines, so a path absolute on either OS ties it to one machine. */
export function isMachineBoundPath(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

export type AssetAction ='created' | 'updated' | 'unchanged' | 'skipped';

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
  /** How Claude Code should invoke nativ, e.g. `npx -y @njeybe/nativ`. Defaults to `nativ` when it is on PATH. */
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

export interface SetupResult {
  root: string;
  dryRun: boolean;
  invocation: CliInvocation;
  changes: AssetChange[];
  warnings: string[];
}

export interface TemplateFilePlan {
  action: AssetAction;
  detail?: string;
  /** The stamped content to write; absent when nothing should change. */
  content?: string;
}

export type ManagedState = 'pristine' | 'modified' | 'unmanaged';

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
    return { command, prefixArgs, portable: ![command, ...prefixArgs].some(isMachineBoundPath) };
  }
  if ((options.hasBinary ?? defaultHasBinary)('nativ')) return { command: 'nativ', prefixArgs: [], portable: true };
  // Not installed globally: fall back to this very build, which only works on this machine.
  const self = path.resolve(__dirname, '..', '..', '..', 'bin', 'cli.js').replace(/\\/g, '/');
  return { command: 'node', prefixArgs: [self], portable: false };
}

/** The invocation as a shell string, e.g. `npx -y @njeybe/nativ`, quoting parts that need it. */
export function cliString(invocation: CliInvocation): string {
  return [invocation.command, ...invocation.prefixArgs].map(quoteIfNeeded).join(' ');
}

export const shortHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

/** CRLF and a leading BOM to plain LF. */
export const toLf = (text: string): string => text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

/** Appends the marker that lets a later run tell "nativ wrote this, untouched" from "a person edited this". */
export function stampManaged(content: string): string {
  const body = toLf(content).replace(/\s+$/, '');
  return `${body}\n\n${MANAGED_PREFIX}${shortHash(body)} -->\n`;
}

export function managedState(content: string): ManagedState {
  const lf = toLf(content);
  const match = MANAGED_PATTERN.exec(lf);
  if (!match) return 'unmanaged';
  const body = lf.slice(0, match.index).replace(/\s+$/, '');
  return shortHash(body) === match[1] ? 'pristine' : 'modified';
}
