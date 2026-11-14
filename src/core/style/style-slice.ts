/** nativ · Builds the short code style text a worker gets with its task. */

import path from 'node:path';
import { matchesTarget } from '../enforcement.js';
import { resolveExpected } from './aggregate.js';
import { loadCodeStyle, styleStaleness } from './style-store.js';
import { langOf } from './style-scan.js';
import { STYLE_RULES, type CodeStyleFile } from './style-types.js';

export const MAX_SLICE_CHARS = 600;
const FORMAT_TRAITS = ['indent', 'quotes', 'semicolons', 'trailingCommas'];

export interface StyleSlice {
  text: string;
  warnings: string[];
}

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const unique = (lines: string[]): string[] => [...new Set(lines)];

function decisionLines(style: CodeStyleFile): string[] {
  const lines: string[] = [];
  for (const d of style.decisions) {
    if (d.status === 'pending' && d.evidence.count === 0) continue;
    // loadCodeStyle rejects unknown rules, so every decision has a known title
    const title = STYLE_RULES.find((r) => r.id === d.rule)!.title;
    if (d.status === 'codebase') lines.push(`${title}: matching the existing code is allowed`);
    else lines.push(`${title}: follow nativ's rule`);
  }
  return lines;
}

function namingText(expected: Record<string, string>): string {
  const parts: string[] = [];
  if (expected.fileNaming) parts.push(`file names ${expected.fileNaming}`);
  if (expected.exportStyle) parts.push(`${expected.exportStyle} exports`);
  return parts.join(', ');
}

function namingLines(style: CodeStyleFile, files: string[]): string[] {
  const lines: string[] = [];
  for (const file of files) {
    const lang = langOf(file);
    const text = lang ? namingText(resolveExpected(style, file, lang)) : '';
    if (text) lines.push(`${path.posix.dirname(file)}: ${text}`);
  }
  return unique(lines);
}

function patternLines(style: CodeStyleFile, files: string[]): string[] {
  const lines: string[] = [];
  for (const p of style.patterns) {
    const hit = p.scope.length === 0 || files.some((f) => p.scope.some((s) => matchesTarget(f, s)));
    if (hit) lines.push(clean(p.text));
  }
  return lines.filter(Boolean);
}

function formattingLines(style: CodeStyleFile, files: string[]): string[] {
  const lines: string[] = [];
  for (const file of files) {
    const lang = langOf(file);
    if (!lang) continue;
    const owner = style.formatters.find(
      (f) => f.language === lang && f.owns.some((t) => FORMAT_TRAITS.includes(t)),
    );
    if (owner) {
      lines.push(`${owner.tool} owns formatting`);
      continue;
    }
    const expected = resolveExpected(style, file, lang);
    const parts = FORMAT_TRAITS.filter((t) => expected[t]).map((t) => `${t} ${expected[t]}`);
    if (parts.length) lines.push(`formatting: ${parts.join(', ')}`);
  }
  return unique(lines);
}

/** Keeps whole lines in priority order until the next one would pass the limit. */
function fit(lines: string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const next = size + line.length + (kept.length ? 1 : 0);
    if (next > MAX_SLICE_CHARS) break;
    kept.push(line);
    size = next;
  }
  return kept.join('\n');
}

function staleWarning(root: string, style: CodeStyleFile): string[] {
  const age = styleStaleness(root, style);
  if (!age?.stale) return [];
  if (age.gone) return ['The code style scan commit is not in this history. Run nativ style scan.'];
  return [`The code style scan is ${age.behind} commits behind HEAD. Run nativ style scan.`];
}

export function buildStyleSlice(root: string, task: { targetFiles?: string[] }): StyleSlice {
  const loaded = loadCodeStyle(root);
  if (!loaded.file) {
    const warnings = loaded.unreadable
      ? [`.ai/code_style.json is unreadable: ${loaded.problems[0]}`]
      : [];
    return { text: '', warnings };
  }
  const files = (task.targetFiles ?? []).map((f) => f.replace(/\\/g, '/'));
  const lines = [
    ...decisionLines(loaded.file),
    ...namingLines(loaded.file, files),
    ...patternLines(loaded.file, files),
    ...formattingLines(loaded.file, files),
  ];
  return { text: fit(lines), warnings: staleWarning(root, loaded.file) };
}
