import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { detectConflicts, type SourceFile } from './conflicts.js';
import { aggregateStyle, type FileMeasure } from './aggregate.js';
import { detectFormatters } from './formatters.js';
import { measureJs } from './measure-js.js';
import { measurePython } from './measure-python.js';
import { listStyleSources } from './style-sources.js';
import { loadCodeStyle, mergeScan, saveCodeStyle } from './style-store.js';
import type {
  CodeStyleFile, StyleDecision, StyleFormatter, StyleLanguage, TraitMap,
} from './style-types.js';

export interface StyleScanResult {
  available: boolean;
  reason?: string;
  style?: CodeStyleFile;
  written?: boolean;
}

const LANGUAGES: StyleLanguage[] = ['js', 'python'];

function langOf(file: string): StyleLanguage | null {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return 'js';
  return file.endsWith('.py') ? 'python' : null;
}

function readSources(root: string, files: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  for (const file of files) {
    try {
      out.push({ path: file, text: fs.readFileSync(path.join(root, file), 'utf8') });
    } catch {
      // an unreadable file is skipped, like a missing one
    }
  }
  return out;
}

function measureFile(f: SourceFile): FileMeasure | null {
  const lang = langOf(f.path);
  if (!lang) return null;
  const counts = lang === 'js' ? measureJs(f.path, f.text) : measurePython(f.path, f.text);
  return { path: f.path, lang, counts };
}

function pendingDecisions(sources: SourceFile[]): StyleDecision[] {
  return detectConflicts(sources).map((c) => ({
    rule: c.rule,
    status: 'pending',
    evidence: { count: c.count, files: c.files },
    decidedAt: null,
  }));
}

function headCommit(root: string): string {
  try {
    const args = ['rev-parse', '--short', 'HEAD'];
    const stdio: ['ignore', 'pipe', 'ignore'] = ['ignore', 'pipe', 'ignore'];
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio }).trim();
  } catch {
    return '';
  }
}

// aggregateStyle never sets owner, so the scan marks formatter-owned traits here.
function markOwners(map: TraitMap | undefined, formatters: StyleFormatter[], lang: StyleLanguage) {
  for (const f of formatters.filter((x) => x.language === lang)) {
    for (const trait of f.owns) if (map?.[trait] && !map[trait].owner) map[trait].owner = f.tool;
  }
}

/** Measures the repository and builds a fresh file; nothing is written. */
export function buildStyleScan(root: string): StyleScanResult {
  const sources = listStyleSources(root);
  if (!sources.available) return { available: false, reason: sources.reason };
  const texts = readSources(root, sources.files);
  const measures = texts
    .map(measureFile)
    .filter((m): m is FileMeasure => m !== null);
  const scope = aggregateStyle(measures);
  const formatters = detectFormatters(root);
  for (const lang of LANGUAGES) {
    markOwners(scope.project[lang], formatters, lang);
    for (const folder of Object.values(scope.folders)) markOwners(folder[lang], formatters, lang);
  }
  const style: CodeStyleFile = {
    version: 1,
    scannedAt: {
      commit: headCommit(root),
      date: new Date().toISOString().slice(0, 10),
      files: measures.length,
    },
    languages: LANGUAGES.filter((l) => measures.some((m) => m.lang === l)),
    formatters,
    ...scope,
    decisions: pendingDecisions(texts),
    patterns: [],
  };
  return { available: true, style };
}

/** Scans and, unless dry, saves through mergeScan so decisions and patterns survive. */
export function scanStyle(root: string, dryRun = false): StyleScanResult {
  const result = buildStyleScan(root);
  if (!result.style) return result;
  const merged = mergeScan(loadCodeStyle(root).file, result.style);
  if (!dryRun) saveCodeStyle(root, merged);
  return { available: true, style: merged, written: !dryRun };
}
