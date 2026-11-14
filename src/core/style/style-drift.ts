/** nativ · Checks new and changed code against the recorded project style. */

import fs from 'node:fs';
import path from 'node:path';
import { resolveExpected } from './aggregate.js';
import { measureJs } from './measure-js.js';
import { measurePython } from './measure-python.js';
import { gitOutput } from './style-git.js';
import { langOf } from './style-scan.js';
import { loadCodeStyle } from './style-store.js';
import type { CodeShapeIssue } from '../code-shape.js';
import type { CodeStyleFile, StyleLanguage } from './style-types.js';

type Counts = Record<string, Record<string, number>>;
interface Line {
  no: number;
  text: string;
}

const LINE_TRAITS = ['indent', 'quotes', 'semicolons'];
const FILE_TRAITS = ['fileNaming', 'moduleSystem', 'exportStyle'];
const MIN_OCCURRENCES = 3;
const NOUNS: Record<string, string> = { quotes: 'strings', indent: 'indented lines' };
const FILE_LABELS: Record<string, string> = { moduleSystem: 'module system', exportStyle: 'export style' };

/** Lines added since HEAD in a tracked file, with their new line numbers. */
function addedLines(root: string, file: string, text: string): Line[] {
  const diff = gitOutput(root, ['diff', '-U0', 'HEAD', '--', file]);
  if (diff === null) return [];
  const lines = text.split(/\r?\n/);
  const out: Line[] = [];
  for (const m of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let no = start; no < start + count; no++) out.push({ no, text: lines[no - 1] ?? '' });
  }
  return out;
}

function measure(lang: StyleLanguage, file: string, text: string): Counts {
  return lang === 'js' ? measureJs(file, text) : measurePython(file, text);
}

/** Share recorded for the expected value: nearest folder entry, else the project entry. */
function shareOf(style: CodeStyleFile, file: string, lang: StyleLanguage, trait: string): number {
  const parts = file.split('/').slice(0, -1);
  for (let i = parts.length; i > 0; i--) {
    const entry = style.folders[parts.slice(0, i).join('/')]?.[lang]?.[trait];
    if (entry && entry.value !== 'mixed') return entry.share;
  }
  return style.project[lang]?.[trait]?.share ?? 0;
}

/** The most common value that differs from the expected one, or null when none wins. */
function dominantOther(values: Record<string, number>, expected: string) {
  const own = values[expected] ?? 0;
  const others = Object.entries(values).filter(([v, n]) => v !== expected && n > 0);
  others.sort((a, b) => b[1] - a[1]);
  if (others.length === 0 || others[0][1] <= own) return null;
  if (others.length > 1 && others[0][1] === others[1][1]) return null;
  return { value: others[0][0], count: others[0][1] };
}

function firstOffending(lang: StyleLanguage, file: string, lines: Line[], trait: string, expected: string) {
  for (const l of lines) {
    const values = measure(lang, file, l.text)[trait] ?? {};
    if (Object.entries(values).some(([v, n]) => v !== expected && n > 0)) return l.no;
  }
  return lines.length > 0 ? lines[0].no : 1;
}

interface Ctx {
  style: CodeStyleFile;
  file: string;
  lang: StyleLanguage;
  isNew: boolean;
  lines: Line[];
  counts: Counts;
}

function checkTrait(ctx: Ctx, trait: string, expected: string): CodeShapeIssue | null {
  const values = ctx.counts[trait] ?? {};
  const pct = Math.round(shareOf(ctx.style, ctx.file, ctx.lang, trait) * 100);
  const total = Object.values(values).reduce((a, b) => a + b, 0);
  const other = dominantOther(values, expected);
  if (!other) return null;
  const base = { file: ctx.file, kind: 'style-drift', category: 'drift' } as const;
  if (FILE_TRAITS.includes(trait)) {
    const label = trait === 'fileNaming' ? `file name ${path.basename(ctx.file)}` : FILE_LABELS[trait];
    const message = `${label} is ${other.value}; this folder uses ${expected} (${pct}%)`;
    return { ...base, line: 1, message };
  }
  if (total < MIN_OCCURRENCES) return null;
  const noun = NOUNS[trait] ?? `${trait} choices`;
  const scope = ctx.isNew ? 'new' : 'added';
  const message = `${other.count} of ${total} ${scope} ${noun} use ${other.value}; ` +
    `this folder uses ${expected} (${pct}%)`;
  const line = firstOffending(ctx.lang, ctx.file, ctx.lines, trait, expected);
  return { ...base, line, message };
}

function checkFile(root: string, style: CodeStyleFile, file: string): CodeShapeIssue[] {
  const lang = langOf(file);
  if (!lang) return [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    // A target file the task deleted has no new code to check
    return [];
  }
  const isNew = gitOutput(root, ['cat-file', '-e', `HEAD:${file}`]) === null;
  const all = text.split(/\r?\n/).map((t, i) => ({ no: i + 1, text: t }));
  const lines = isNew ? all : addedLines(root, file, text);
  if (lines.length === 0) return [];
  const counts = measure(lang, file, lines.map((l) => l.text).join('\n'));
  const ctx: Ctx = { style, file, lang, isNew, lines, counts };
  const expected = resolveExpected(style, file, lang);
  const issues: CodeShapeIssue[] = [];
  for (const [trait, value] of Object.entries(expected)) {
    if (!isNew && !LINE_TRAITS.includes(trait)) continue;
    const found = checkTrait(ctx, trait, value);
    if (found) issues.push(found);
  }
  return issues;
}

/** Drift findings for the given files; none without git or `.ai/code_style.json`. */
export function checkStyleDrift(root: string, targetFiles: string[]): CodeShapeIssue[] {
  const style = loadCodeStyle(root).file;
  if (!style || gitOutput(root, ['rev-parse', '--verify', 'HEAD']) === null) return [];
  const files = targetFiles.map((f) => f.replace(/\\/g, '/'));
  return files.flatMap((file) => checkFile(root, style, file));
}
