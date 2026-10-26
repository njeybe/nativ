import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Scans source text for environment-variable reads (JS/TS, Python, Go) and marks reads that
 * silently fall back to an empty value. Language is chosen by file extension.
 */
export interface EnvRead {
  name: string;
  line: number;
  fallback: boolean;
}

type Lang = 'js' | 'py' | 'go';

const ALLOW_MARKER = 'nativ-allow-fallback';
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);
const MAX_FILE_BYTES = 1024 * 1024;
const Q = `['"\`]`;

const EXT_LANG: Record<string, Lang> = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py', '.go': 'go',
};

const id = String.raw`([A-Za-z_]\w*)`;
const rx = (src: string) => new RegExp(src, 'g');

const PATTERNS: Record<Lang, RegExp[]> = {
  js: [
    rx(String.raw`\b(?:process\.env|import\.meta\.env|Bun\.env)\.` + id),
    rx(String.raw`\b(?:process\.env|import\.meta\.env|Bun\.env)\[\s*${Q}` + id + String.raw`${Q}\s*\]`),
    rx(String.raw`\bDeno\.env\.get\(\s*${Q}` + id + String.raw`${Q}\s*\)`),
  ],
  py: [
    rx(String.raw`\bos\.environ\[\s*${Q}` + id + String.raw`${Q}\s*\]`),
    rx(String.raw`\bos\.(?:environ\.get|getenv)\(\s*${Q}` + id + Q),
  ],
  go: [rx(String.raw`\bos\.(?:Getenv|LookupEnv)\(\s*"` + id + String.raw`"\s*\)`)],
};

const JS_FALLBACK = /^\s*(?:\?\?|\|\|)\s*(?:''|""|``|null|undefined)(?![\w$])/;
const PY_DEFAULT = /^\s*,\s*(?:''|""|None)\s*\)/;
const PY_OR = /^\s*or\s+(?:''|""|None)(?![\w])/;
const GO_CMP = /(?:[=!]=\s*""|""\s*[=!]=)/;

export function langForFile(file: string): Lang | null {
  return EXT_LANG[path.extname(file).toLowerCase()] ?? null;
}

function isFallback(lang: Lang, rest: string, lines: string[], i: number, call: string): boolean {
  if (lang === 'js') return JS_FALLBACK.test(rest);
  if (lang === 'py') {
    if (call.includes('environ[')) return false;
    if (rest.startsWith(')')) return PY_OR.test(rest.slice(1));
    return PY_DEFAULT.test(rest);
  }
  if (call.includes('LookupEnv')) return false;
  return !lines.slice(i, i + 4).some((l) => GO_CMP.test(l));
}

export function scanEnvReads(text: string, file: string): EnvRead[] {
  const lang = langForFile(file);
  if (!lang) return [];
  const lines = text.split(/\r?\n/);
  const out: EnvRead[] = [];
  lines.forEach((line, i) => {
    const seen = new Set<number>();
    for (const re of PATTERNS[lang]) {
      re.lastIndex = 0;
      for (let m = re.exec(line); m; m = re.exec(line)) {
        if (seen.has(m.index)) continue;
        seen.add(m.index);
        const rest = line.slice(m.index + m[0].length);
        const allowed = line.includes(ALLOW_MARKER);
        const fallback = !allowed && isFallback(lang, rest, lines, i, m[0]);
        out.push({ name: m[1], line: i + 1, fallback });
      }
    }
  });
  return out.sort((a, b) => a.line - b.line);
}

function gitFiles(root: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8',
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, next));
    else if (e.isFile()) out.push(next);
  }
  return out;
}

function skipped(rel: string): boolean {
  return rel.split('/').some((p) => SKIP_DIRS.has(p));
}

function exampleNames(root: string): string[] {
  const file = path.join(root, '.env.example');
  if (!fs.existsSync(file)) return [];
  const names: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Variable names read in source files, plus names declared in .env.example (no other .env*). */
export function listProjectEnvNames(root: string): string[] {
  const names = new Set<string>(exampleNames(root));
  const files = (gitFiles(root) ?? walk(root)).filter((f) => !skipped(f));
  for (const rel of files) {
    if (!langForFile(rel)) continue;
    const full = path.join(root, rel);
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      for (const r of scanEnvReads(fs.readFileSync(full, 'utf8'), rel)) names.add(r.name);
    } catch {
      // unreadable or removed file: skip
    }
  }
  return [...names].sort();
}
