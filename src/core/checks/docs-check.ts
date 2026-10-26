import fs from 'node:fs';
import path from 'node:path';

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
const PATHY = /^[\w.@~-][\w./@~-]*$/;

function isPathLike(t: string): boolean {
  if (t.includes('://') || !PATHY.test(t) || t.startsWith('-')) return false;
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
  text.split(/\r?\n/).forEach((raw, i) => {
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
        const msg = checkFlags(words, ctx.program);
        if (msg) add(l.line, 'flag', t, msg);
      } else if (PLACEHOLDER.test(t)) {
        const f = paraFile.get(l.para);
        if (f && !fs.readFileSync(f, 'utf8').includes(t)) {
          const name = path.basename(f);
          add(l.line, 'placeholder', t, `${t} does not appear in ${name}, which this paragraph describes`);
        }
      } else if (isPathLike(t)) {
        if (!pathExists(t, ctx.root, docDir)) add(l.line, 'path', t, `${t} does not exist`);
      } else if (SETTING.test(t)) {
        const name = t.split('=')[0];
        const msg = `${name} is not read by the code or listed in .env.example`;
        if (!ctx.envNames.has(name)) add(l.line, 'setting', t, msg);
      }
    }
  }
  return findings;
}
