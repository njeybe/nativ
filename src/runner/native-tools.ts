import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { NATIVE_TOOL_OUTPUT_LIMIT } from './types.js';
import { SECRET_ENV_PATTERN } from './cli-config.js';

/** Rejection returned to the model as an `is_error` tool result so it can adjust. */
export class ToolInputError extends Error {}

/** .env* (except .env.example), *.pem, *.key and .nativ|.agentj/*.local.json. */
export const SECRET_PATH_PATTERN =
  /(^|[\\/\s'"=])(\.env(?!\.example\b)[\w.-]*|[\w.-]+\.(pem|key)|\.(nativ|agentj)[\\/][\w.-]*\.local\.json)(?=$|[\s'";|&)])/i;

/** Top-level directories of POSIX, macOS and Git Bash (/c/, /d/ drive mounts) filesystems. */
export const FILESYSTEM_ROOT =
  /^\/(etc|usr|bin|sbin|lib|lib32|lib64|libx32|opt|var|tmp|home|root|proc|sys|dev|mnt|media|srv|boot|run|snap|private|System|Users|Volumes|Library|Applications|[A-Za-z])(\/|$)/;

export function buildToolEnv(...sources: Array<Record<string, string | undefined> | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined && !SECRET_ENV_PATTERN.test(key)) env[key] = value;
    }
  }
  return env;
}

/**
 * Best-effort policy for model-authored shell commands. The worktree is the
 * real boundary (as with the cli engine); this blocks the obvious escapes and
 * keeps every executable on an allowlist. Returns the rejection reason, or null.
 */
export function checkNativeBashCommand(command: string, allowed: ReadonlySet<string>): string | null {
  if (/`|\$\(/.test(command)) return 'Command substitution (backticks or $(...)) is not allowed.';
  if (/(^|[^&>])&(?![&>])/.test(command)) return 'Background jobs (&) are not allowed.';
  if (SECRET_PATH_PATTERN.test(command)) {
    return 'Secret files (.env, *.pem, *.key, .nativ/*.local.json) are off-limits; only .env.example may be read.';
  }
  if (/\bgit\s+push\b|\bnpm\s+publish\b/.test(command)) {
    return 'Publishing actions (git push, npm publish) are reserved for the operator.';
  }
  if (/(^|[\s'"=/\\])\.nativ[\\/]/i.test(command)) {
    return 'nativ settings (.nativ/) are off-limits to agents; ask the operator to change them.';
  }

  for (const token of command.split(/\s+/)) {
    const raw = token.replace(/^\d*[<>]+&?/, '');
    // Quoting must not smuggle a path past the checks: look through one layer of quotes.
    const quoted = /^['"]/.test(raw);
    const bare = raw.replace(/^['"]+|['"]+$/g, '');
    if (!bare || bare === '/dev/null') continue;
    if (/^(~|\$\{?(HOME|USERPROFILE)\}?|%USERPROFILE%)/i.test(bare)) {
      return `Home-directory path '${bare}' points outside the workspace; use paths relative to the workspace root.`;
    }
    // Unquoted slash paths are always paths. A quoted one may be a search pattern ("/api/events"),
    // so it is refused only when it starts at a real filesystem root.
    if (/^[A-Za-z]:[\\/]/.test(bare) || (bare.startsWith('/') && (!quoted || FILESYSTEM_ROOT.test(bare)))) {
      return `Absolute path '${bare}' points outside the workspace; use paths relative to the workspace root.`;
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(bare)) return `Parent-directory path '${bare}' escapes the workspace.`;
  }

  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (!words.length) continue;
    const bin = path.basename(words[0].replace(/^['"]|['"]$/g, '')).replace(/\.(exe|cmd|bat)$/i, '');
    if (!allowed.has(bin)) {
      return `'${bin}' is not on the command allowlist (${[...allowed].join(', ')}).`;
    }
  }
  return null;
}

/** POSIX bash for the model's commands; Git Bash on Windows, else the platform shell. */
export function resolveToolShell(): string | boolean {
  const override = process.env.NATIV_BASH_PATH;
  if (override && fs.existsSync(override)) return override;
  if (process.platform !== 'win32') return fs.existsSync('/bin/bash') ? '/bin/bash' : true;
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => fs.existsSync(p)) ?? true;
}

export function clipToolOutput(text: string, omitted = 0): string {
  const total = text.length + omitted;
  if (total <= NATIVE_TOOL_OUTPUT_LIMIT) return text;
  const head = Math.floor(NATIVE_TOOL_OUTPUT_LIMIT * 0.4);
  const tail = NATIVE_TOOL_OUTPUT_LIMIT - head;
  return `${text.slice(0, head)}\n\n[... ${total - NATIVE_TOOL_OUTPUT_LIMIT} characters omitted ...]\n\n${text.slice(-tail)}`;
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolves symlinks/junctions on the nearest existing ancestor of a possibly new path. */
export function canonicalize(target: string): string {
  let current = target;
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...rest);
  } catch {
    return target;
  }
}

/**
 * Confines a model-supplied editor path to the workspace. Reads may follow the
 * `.ai/` and `node_modules/` junctions the supervisor mounts into worktrees;
 * writes may not touch them at all.
 */
export function resolveEditorPath(workspace: string, projectRoot: string, raw: unknown, mode: 'read' | 'write'): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ToolInputError('"path" is required.');
  if (/%2e|%2f|%5c/i.test(raw)) throw new ToolInputError('URL-encoded path segments are not allowed.');

  const root = path.resolve(workspace);
  const target = path.resolve(root, raw);
  if (!isWithin(root, target)) throw new ToolInputError(`Path '${raw}' is outside the workspace.`);

  const rel = path.relative(root, target);
  if (SECRET_PATH_PATTERN.test(` ${rel}`)) {
    throw new ToolInputError('Secret files (.env, *.pem, *.key, .nativ/*.local.json) are off-limits; only .env.example may be read.');
  }
  const top = rel.split(/[\\/]/)[0];
  if (mode === 'write' && ['.ai', '.nativ', 'node_modules', '.git'].includes(top.toLowerCase())) {
    throw new ToolInputError(`'${top}/' is read-only; contract changes go through \`nativ task escalate\`.`);
  }

  const allowedRoots = [canonicalize(root)];
  if (mode === 'read') {
    allowedRoots.push(canonicalize(path.join(projectRoot, '.ai')), canonicalize(path.join(projectRoot, 'node_modules')));
  }
  if (!allowedRoots.some((r) => isWithin(r, canonicalize(target)))) {
    throw new ToolInputError(`Path '${raw}' resolves outside the workspace.`);
  }
  return target;
}

export function requireString(input: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw new ToolInputError(`"${key}" must be a${allowEmpty ? '' : ' non-empty'} string.`);
  }
  return value;
}

/** Client-side implementation of the text_editor_20250728 commands. */
export function runEditorCommand(workspace: string, projectRoot: string, input: Record<string, unknown>): string {
  const command = input.command;
  const rawPath = input.path;

  switch (command) {
    case 'view': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'read');
      if (!fs.existsSync(target)) throw new ToolInputError(`Path '${rawPath}' does not exist.`);
      if (fs.statSync(target).isDirectory()) {
        const entries = fs
          .readdirSync(target, { withFileTypes: true })
          .filter((e) => e.name !== '.git')
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        return entries.join('\n') || '(empty directory)';
      }
      const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
      let start = 1;
      let end = lines.length;
      if (input.view_range !== undefined) {
        const range = input.view_range;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isInteger)) {
          throw new ToolInputError('"view_range" must be [startLine, endLine] (endLine -1 reads to the end).');
        }
        start = Math.max(1, range[0]);
        end = range[1] === -1 ? lines.length : Math.min(lines.length, range[1]);
        if (start > end) throw new ToolInputError(`Invalid view_range [${range.join(', ')}] for a ${lines.length}-line file.`);
      }
      const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`).join('\n');
      return clipToolOutput(numbered);
    }

    case 'create': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'write');
      const text = requireString(input, 'file_text', true);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, 'utf8');
      return `File created successfully at: ${rawPath}`;
    }

    case 'str_replace': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'write');
      if (!fs.existsSync(target)) throw new ToolInputError(`File '${rawPath}' does not exist.`);
      const content = fs.readFileSync(target, 'utf8');
      let oldStr = requireString(input, 'old_str');
      let newStr = input.new_str === undefined ? '' : requireString(input, 'new_str', true);

      let count = content.split(oldStr).length - 1;
      if (count === 0 && content.includes('\r\n') && !oldStr.includes('\r\n')) {
        // The model writes LF; retry against CRLF files before reporting a miss.
        oldStr = oldStr.replace(/\n/g, '\r\n');
        newStr = newStr.replace(/\r?\n/g, '\r\n');
        count = content.split(oldStr).length - 1;
      }
      if (count === 0) {
        throw new ToolInputError('No match found for old_str. Check whitespace and indentation against a fresh view of the file.');
      }
      if (count > 1) {
        throw new ToolInputError(`Found ${count} matches for old_str; include more surrounding context so it is unique.`);
      }
      fs.writeFileSync(target, content.replace(oldStr, () => newStr), 'utf8');
      return 'Successfully replaced text at exactly one location.';
    }

    case 'insert': {
      const target = resolveEditorPath(workspace, projectRoot, rawPath, 'write');
      if (!fs.existsSync(target)) throw new ToolInputError(`File '${rawPath}' does not exist.`);
      const content = fs.readFileSync(target, 'utf8');
      const text = requireString(input, 'insert_text', true);
      const eol = content.includes('\r\n') ? '\r\n' : '\n';
      const lines = content.split(/\r?\n/);
      const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      const after = input.insert_line;
      if (typeof after !== 'number' || !Number.isInteger(after) || after < 0 || after > lineCount) {
        throw new ToolInputError(`"insert_line" must be an integer between 0 and ${lineCount}.`);
      }
      lines.splice(after, 0, ...text.split(/\r?\n/));
      fs.writeFileSync(target, lines.join(eol), 'utf8');
      return `Inserted text after line ${after}.`;
    }

    default:
      throw new ToolInputError(`Unsupported editor command '${String(command)}'. Use view, create, str_replace or insert.`);
  }
}

export const NATIVE_TOOLS: Anthropic.Beta.Messages.BetaToolUnion[] = [
  { type: 'bash_20250124', name: 'bash' },
  { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool', max_characters: NATIVE_TOOL_OUTPUT_LIMIT },
];
