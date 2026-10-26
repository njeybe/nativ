import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** One nativ command: its own flags and its subcommands. */
export interface CommandSpec {
  flags: string[];
  subs: Record<string, CommandSpec>;
}

export interface DocFinding {
  file: string;
  line: number;
  kind: 'path' | 'placeholder' | 'setting' | 'flag';
  token: string;
  message: string;
}

export interface DocsContext {
  root: string;
  envNames: Set<string>;
  program: CommandSpec;
}

const EXTS = [
  '.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.sh', '.py', '.yml', '.yaml', '.toml', '.sql', '.example',
];
const TOKEN = /`([^`\n]+)`/g;
const PLACEHOLDER = /^<[\w-]+>$/;
const SETTING = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z][A-Z0-9_]*(?==))/;
const SETTING_USE = /^(?:([A-Z][A-Z0-9_]*)=|\$\{?([A-Z][A-Z0-9_]*)\}?$)/;
const SCOPED = /^@[\w.-]+\/[\w.-]+$/;
// Created by nativ in the user's project, so absent here is fine.
const RUNTIME_DIRS = ['.ai', '.nativ', '.worktrees', '.claude', 'tests/contract'];
const RUNTIME_FILES = new Set([
  'db_schema.json', 'api_contracts.json', 'master_plan.json', 'ui_specs.md', 'context.md', '.env.example',
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.mcp.json', 'SKILL.md', 'DIGEST.md',
]);
const CODE_EXTS = /\.(?:ts|js|mjs|cjs|py|sh)$/;
const codeCache = new Map<string, string>();

/** Source text of tracked code files, joined; used to find string literals. */
function codeText(root: string): string {
  const hit = codeCache.get(root);
  if (hit !== undefined) return hit;
  let files: string[] = [];
  try {
    const opts = { cwd: root, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as const };
    files = execFileSync('git', ['ls-files'], { ...opts, stdio: [...opts.stdio] })
      .split(/\r?\n/).filter((f) => CODE_EXTS.test(f));
  } catch {
    files = [];
  }
  const parts: string[] = [];
  for (const f of files) {
    try { parts.push(fs.readFileSync(path.join(root, f), 'utf8')); } catch { /* removed file */ }
  }
  const text = parts.join('\n');
  codeCache.set(root, text);
  return text;
}

function hasLiteral(name: string, root: string): boolean {
  return new RegExp(`(['"\`])${name}\\1`).test(codeText(root));
}

function isRuntimePath(t: string): boolean {
  const clean = t.replace(/^\.\//, '').replace(/\/$/, '');
  if (RUNTIME_DIRS.some((d) => clean === d || clean.startsWith(`${d}/`))) return true;
  if (/^[\w.-]+\/$/.test(t)) return true; // a bare folder name is an example
  return !clean.includes('/') && RUNTIME_FILES.has(clean);
}
const PATHY = /^[\w.@~-][\w./@~-]*$/;

function isPathLike(t: string): boolean {
  if (t.includes('://') || SCOPED.test(t) || !PATHY.test(t) || t.startsWith('-')) return false;
  return t.includes('/') || EXTS.some((e) => t.toLowerCase().endsWith(e));
}

function findFile(t: string, root: string, docDir: string): string | null {
  const clean = t.replace(/^\.?\//, '');
  for (const base of [root, docDir]) {
    const full = path.join(base, clean);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

function pathExists(t: string, root: string, docDir: string): boolean {
  const clean = t.replace(/^\.?\//, '').replace(/\/$/, '');
  return [root, docDir].some((b) => fs.existsSync(path.join(b, clean)));
}

function checkFlags(words: string[], program: CommandSpec): string | null {
  let spec = program;
  const names: string[] = [];
  for (const w of words.slice(1)) {
    if (w.startsWith('-') || !spec.subs[w]) break;
    spec = spec.subs[w];
    names.push(w);
  }
  if (names.length === 0) return null;
  for (const w of words.slice(1)) {
    if (!w.startsWith('-')) continue;
    const flag = w.split('=')[0];
    if (['--help', '-h'].includes(flag) || spec.flags.includes(flag)) continue;
    return `nativ ${names.join(' ')} has no option ${flag}`;
  }
  return null;
}

/** Lines of prose with their paragraph index; fenced code blocks are skipped. */
function proseLines(text: string): { line: number; text: string; para: number }[] {
  const out: { line: number; text: string; para: number }[] = [];
  let fenced = false;
  let para = 0;
  let skipNext = false;
  let ignoring = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    if (skipNext) { skipNext = false; return; }
    if (/<!--\s*nativ-check-ignore-end\s*-->/.test(raw)) { ignoring = false; return; }
    if (/<!--\s*nativ-check-ignore-start\s*-->/.test(raw)) { ignoring = true; return; }
    if (/^\s*<!--\s*nativ-check-ignore\s*-->\s*$/.test(raw)) { skipNext = true; return; }
    if (ignoring) return;
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; return; }
    if (fenced) return;
    if (raw.trim() === '') { para += 1; return; }
    out.push({ line: i + 1, text: raw, para });
  });
  return out;
}

export function checkDocText(text: string, docFile: string, ctx: DocsContext): DocFinding[] {
  const findings: DocFinding[] = [];
  const docDir = path.dirname(path.resolve(ctx.root, docFile));
  const rel = path.relative(ctx.root, path.resolve(ctx.root, docFile)).split(path.sep).join('/');
  const lines = proseLines(text);
  const add = (line: number, kind: DocFinding['kind'], token: string, message: string) =>
    findings.push({ file: rel, line, kind, token, message });

  // The file a paragraph names: the first path-like token that exists.
  const paraFile = new Map<number, string>();
  for (const l of lines) {
    for (const m of l.text.matchAll(TOKEN)) {
      const t = m[1].trim();
      if (paraFile.has(l.para) || !isPathLike(t)) continue;
      const f = findFile(t, ctx.root, docDir);
      if (f) paraFile.set(l.para, f);
    }
  }

  for (const l of lines) {
    for (const m of l.text.matchAll(TOKEN)) {
      const t = m[1].trim();
      const words = t.split(/\s+/);
      if (words[0] === 'nativ') {
        const bare = t.replace(/"[^"]*"|'[^']*'/g, ' ').trim().split(/\s+/);
        const msg = checkFlags(bare, ctx.program);
        if (msg) add(l.line, 'flag', t, msg);
      } else if (PLACEHOLDER.test(t)) {
        const f = paraFile.get(l.para);
        if (f && !fs.readFileSync(f, 'utf8').includes(t)) {
          const name = path.basename(f);
          add(l.line, 'placeholder', t, `${t} does not appear in ${name}, which this paragraph describes`);
        }
      } else if (isPathLike(t)) {
        if (!isRuntimePath(t) && !pathExists(t, ctx.root, docDir)) add(l.line, 'path', t, `${t} does not exist`);
      } else {
        const use = SETTING_USE.exec(t);
        const name = use ? use[1] ?? use[2] : '';
        const msg = `${name} is not read by the code or listed in .env.example`;
        if (name && !ctx.envNames.has(name) && !hasLiteral(name, ctx.root)) {
          add(l.line, 'setting', t, msg);
        }
      }
    }
  }
  return findings;
}
