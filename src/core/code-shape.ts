import fs from 'node:fs';
import path from 'node:path';

/**
 * Code-shape check: flags over-long lines and long comment blocks in a task's target files.
 * Settings live under `codeStyle` in .nativ/config.json. Default mode is 'warn'.
 * Exempt: a license/header comment at the top of a file, and JSDoc directly above an export.
 */
export type CodeShapeMode = 'warn' | 'block' | 'off';

export interface CodeShapeSettings {
  mode: CodeShapeMode;
  maxLineLength: number;
  maxCommentLines: number;
}

export interface CodeShapeIssue {
  file: string;
  line: number;
  kind: 'long-line' | 'long-comment';
  message: string;
}

export interface CodeShapeReport {
  mode: CodeShapeMode;
  issues: CodeShapeIssue[];
}

const DEFAULTS: CodeShapeSettings = { mode: 'warn', maxLineLength: 120, maxCommentLines: 2 };
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.dart',
  '.c', '.cc', '.cpp', '.h', '.cs', '.rb', '.php', '.swift', '.vue', '.svelte', '.css', '.scss',
]);
const SKIPPED_DIRS = ['dist', 'build', 'node_modules', 'generated', '.next', 'coverage'];
const MAX_SHOWN = 10;

export function loadCodeShapeSettings(targetDir: string): CodeShapeSettings {
  const settings = { ...DEFAULTS };
  try {
    const raw = fs.readFileSync(path.join(targetDir, '.nativ', 'config.json'), 'utf8');
    const style = JSON.parse(raw)?.codeStyle;
    if (!style || typeof style !== 'object') return settings;
    if (['warn', 'block', 'off'].includes(style.mode)) settings.mode = style.mode;
    if (Number.isInteger(style.maxLineLength) && style.maxLineLength > 0) {
      settings.maxLineLength = style.maxLineLength;
    }
    if (Number.isInteger(style.maxCommentLines) && style.maxCommentLines > 0) {
      settings.maxCommentLines = style.maxCommentLines;
    }
  } catch {
    // Missing or unreadable config: use defaults.
  }
  return settings;
}

function isCheckable(file: string): boolean {
  const parts = file.split(/[\\/]/);
  if (parts.some((p) => SKIPPED_DIRS.includes(p))) return false;
  const base = parts[parts.length - 1];
  if (/\.(min|generated|g)\./.test(base) || base.endsWith('.d.ts')) return false;
  return SOURCE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

/** Returns the comment-block runs as { start, length, exempt } (start is a 1-based line number). */
function findCommentBlocks(lines: string[]) {
  const blocks: { start: number; length: number; exempt: boolean }[] = [];
  let inBlock = false;
  let current: { start: number; length: number; jsdoc: boolean } | null = null;
  let seenCode = false;

  const close = (endIndex: number) => {
    if (!current) return;
    const next = lines.slice(endIndex + 1).find((l) => l.trim() !== '') ?? '';
    const header = !seenCode && current.start <= 3;
    const exportedDoc = current.jsdoc && /^\s*export\b/.test(next);
    blocks.push({ start: current.start, length: current.length, exempt: header || exportedDoc });
    current = null;
  };

  lines.forEach((line, i) => {
    const t = line.trim();
    const isComment = inBlock || t.startsWith('//') || t.startsWith('/*');
    if (isComment) {
      current ??= { start: i + 1, length: 0, jsdoc: t.startsWith('/**') };
      current.length++;
      if (t.startsWith('/*') && !t.includes('*/')) inBlock = true;
      if (inBlock && t.includes('*/')) inBlock = false;
      return;
    }
    close(i - 1);
    if (t !== '') seenCode = true;
  });
  close(lines.length - 1);
  return blocks;
}

export function checkFileShape(file: string, text: string, s: CodeShapeSettings): CodeShapeIssue[] {
  const issues: CodeShapeIssue[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > s.maxLineLength) {
      issues.push({
        file, line: i + 1, kind: 'long-line',
        message: `line is ${line.length} characters (max ${s.maxLineLength})`,
      });
    }
  });
  for (const b of findCommentBlocks(lines)) {
    if (b.length > s.maxCommentLines && !b.exempt) {
      issues.push({
        file, line: b.start, kind: 'long-comment',
        message: `comment block is ${b.length} lines (max ${s.maxCommentLines})`,
      });
    }
  }
  return issues;
}

export function checkCodeShape(targetDir: string, targetFiles: string[] = []): CodeShapeReport {
  const settings = loadCodeShapeSettings(targetDir);
  const report: CodeShapeReport = { mode: settings.mode, issues: [] };
  if (settings.mode === 'off') return report;
  for (const file of targetFiles) {
    if (!isCheckable(file)) continue;
    const full = path.resolve(targetDir, file);
    try {
      if (!fs.statSync(full).isFile()) continue;
      report.issues.push(...checkFileShape(file, fs.readFileSync(full, 'utf8'), settings));
    } catch {
      // File missing or unreadable: skip.
    }
  }
  return report;
}

/** Short plain-language summary; empty string when there is nothing to report. */
export function formatCodeShapeReport(report: CodeShapeReport): string {
  if (report.mode === 'off' || report.issues.length === 0) return '';
  const total = report.issues.length;
  const head = report.mode === 'block'
    ? `Code shape: ${total} issue(s) must be fixed before this task can pass.`
    : `Code shape: ${total} style warning(s). Verification is not affected.`;
  const shown = report.issues.slice(0, MAX_SHOWN).map((i) => `  ${i.file}:${i.line} ${i.message}`);
  const more = total > MAX_SHOWN ? [`  ...and ${total - MAX_SHOWN} more`] : [];
  return [head, ...shown, ...more].join('\n');
}
