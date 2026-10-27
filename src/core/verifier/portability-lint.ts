import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_DIR = /(^|\/)(test|tests|__tests__|scripts)\//;
const TEST_NAME = /(\.test\.|\.spec\.)|(^|\/)test_[^/]*\.py$|_test\.go$/;
const LITERAL = /(["'`])([^"'`\n$]{3,200}?)\1/g;
const SPAWN_NATIV = /(spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]nativ\b/;
const AI_HINT = 'track a fixture copy in the repo instead';

export function isPortabilityTarget(file: string): boolean {
  const f = file.split(String.fromCharCode(92)).join('/');
  return TEST_DIR.test(f) || TEST_NAME.test(f);
}

function looksLikePath(s: string): boolean {
  if (/^[a-z]+:\/\//i.test(s) || /\s/.test(s) || s.startsWith('-')) return false;
  return /^\.{0,2}\/?[\w.@-]+(\/[\w.@-]+)+\/?$/.test(s) || /^\.[\w-]+(\/|$)/.test(s);
}

interface Hit { file: string; line: number; lit: string }

function scan(cwd: string, file: string, hits: Hit[], spawns: string[]): void {
  let text: string;
  try { text = fs.readFileSync(path.join(cwd, file), 'utf8'); } catch { return; }
  text.split(/\r?\n/).forEach((line, i) => {
    if (SPAWN_NATIV.test(line)) spawns.push(`${file}:${i + 1} spawns nativ, which may not be installed in CI`);
    for (const m of line.matchAll(LITERAL)) {
      if (looksLikePath(m[2])) hits.push({ file, line: i + 1, lit: m[2] });
    }
  });
}

function ignoredSet(cwd: string, paths: string[]): Set<string> | null {
  const r = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd, input: paths.join('\n'), encoding: 'utf8',
  });
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return new Set(r.stdout.split(/\r?\n/).filter(Boolean));
}

// Cheap warning pass: findings only, never changes a result.
export function lintPortability(cwd: string, targetFiles: string[]): string[] {
  const files = targetFiles.map((f) => f.split(String.fromCharCode(92)).join('/')).filter(isPortabilityTarget);
  if (!files.length) return [];
  const hits: Hit[] = [];
  const out: string[] = [];
  for (const f of files) scan(cwd, f, hits, out);
  const uniq = [...new Set(hits.map((h) => h.lit.replace(/^\.\//, '')))];
  const ignored = uniq.length ? ignoredSet(cwd, uniq) : new Set<string>();
  if (!ignored) return [];
  for (const h of hits) {
    const key = h.lit.replace(/^\.\//, '');
    if (!ignored.has(key) && !ignored.has(`${key}/`)) continue;
    const hint = key.startsWith('.ai/') ? `; ${AI_HINT}` : '';
    out.push(`${h.file}:${h.line} reads ${h.lit}, which is gitignored: this check cannot run in CI${hint}`);
  }
  return out;
}
