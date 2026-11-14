import path from 'node:path';
import pc from 'picocolors';
import { resolveMainRoot } from '../core/root-resolver.js';
import { scanStyle } from '../core/style/style-scan.js';
import { loadCodeStyle } from '../core/style/style-store.js';
import type { CodeStyleFile } from '../core/style/style-types.js';

export interface StyleScanOptions {
  dryRun?: boolean;
  json?: boolean;
}

export interface StyleShowOptions {
  json?: boolean;
}

function rootOf(targetDirArg?: string): string {
  return resolveMainRoot(path.resolve(targetDirArg || process.cwd()));
}

function fail(message: string): void {
  console.error(pc.red(`✖ ${message}`));
  process.exitCode = 1;
}

export function mixedTraits(style: CodeStyleFile): string[] {
  const out: string[] = [];
  for (const [lang, map] of Object.entries(style.project)) {
    for (const [trait, e] of Object.entries(map ?? {})) {
      if (e.value === 'mixed') out.push(`${lang}.${trait}`);
    }
  }
  return out;
}

function summary(style: CodeStyleFile): string[] {
  const tools = [...new Set(style.formatters.map((f) => f.tool))];
  const mixed = mixedTraits(style);
  const pending = style.decisions.filter((d) => d.status === 'pending').length;
  return [
    `Languages: ${style.languages.join(', ') || 'none'}`,
    `Formatter: ${tools.join(', ') || 'none'}`,
    `Mixed traits: ${mixed.join(', ') || 'none'}`,
    `Pending decisions: ${pending}`,
  ];
}

export async function runStyleScan(targetDirArg?: string, options: StyleScanOptions = {}) {
  const result = scanStyle(rootOf(targetDirArg), !!options.dryRun);
  if (!result.style) return fail(`Style scan skipped: ${result.reason}`);
  if (options.json) return console.log(JSON.stringify(result.style, null, 2));
  const at = result.style.scannedAt;
  const verb = result.written ? 'Scanned' : 'Scanned (dry run, nothing written)';
  console.log(pc.green(`✔ ${verb}: ${at.files} files at ${at.commit || 'no commit'}`));
  for (const line of summary(result.style)) console.log(`  ${line}`);
}

function showTraits(style: CodeStyleFile): void {
  for (const [lang, map] of Object.entries(style.project)) {
    console.log(pc.bold(lang));
    for (const [trait, e] of Object.entries(map ?? {})) {
      const owner = e.owner ? pc.dim(` (owned by ${e.owner})`) : '';
      const stat = pc.dim(`${Math.round(e.share * 100)}% of ${e.samples}`);
      console.log(`  ${trait}: ${e.value} ${stat}${owner}`);
    }
  }
}

export async function runStyleShow(targetDirArg?: string, options: StyleShowOptions = {}) {
  const loaded = loadCodeStyle(rootOf(targetDirArg));
  if (!loaded.file) {
    const why = loaded.unreadable ? loaded.problems.join(' ') : 'Run `nativ style scan` first.';
    return fail(`No usable code style file. ${why}`);
  }
  if (options.json) return console.log(JSON.stringify(loaded.file, null, 2));
  showTraits(loaded.file);
  for (const line of summary(loaded.file)) console.log(pc.dim(line));
}
