/** nativ · Pure aggregation of per-file style votes into project and folder entries. */

import type { CodeStyleFile, StyleLanguage, TraitEntry, TraitMap } from './style-types.js';

/** Counts per trait and value for one file, as the measurers return them. */
export type FileCounts = Record<string, Record<string, number>>;

export interface FileMeasure {
  /** Repo-relative POSIX path. */
  path: string;
  lang: StyleLanguage;
  counts: FileCounts;
}

export type StyleScope = Pick<CodeStyleFile, 'project' | 'folders'>;

const LANGUAGES: StyleLanguage[] = ['js', 'python'];
const MIXED = 'mixed';
const MIN_SHARE = 0.7;
const MIN_FOLDER_SAMPLES = 5;

type Votes = Record<string, number>;
type LangVotes = Record<string, Votes>;

/** The single top value of one file's counts, or null on no evidence or a tie. */
function fileVote(values: Record<string, number>): string | null {
  const ranked = Object.entries(values).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

function addFile(into: LangVotes, counts: FileCounts): void {
  for (const [trait, values] of Object.entries(counts)) {
    const vote = fileVote(values);
    if (vote === null) continue;
    const votes = (into[trait] ??= {});
    votes[vote] = (votes[vote] ?? 0) + 1;
  }
}

function toEntry(votes: Votes): TraitEntry {
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const samples = ranked.reduce((sum, [, n]) => sum + n, 0);
  const tie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
  const share = ranked[0][1] / samples;
  const value = tie || share < MIN_SHARE ? MIXED : ranked[0][0];
  return { value, share: Math.round(share * 100) / 100, samples };
}

function toMap(votes: LangVotes): TraitMap {
  const map: TraitMap = {};
  for (const trait of Object.keys(votes).sort()) map[trait] = toEntry(votes[trait]);
  return map;
}

function dirOf(filePath: string): string {
  return filePath.split('/').slice(0, -1).join('/');
}

/** Every ancestor directory of a path, shallowest first, without the root. */
function ancestors(filePath: string): string[] {
  const parts = filePath.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

function isInside(dir: string, folder: string): boolean {
  return dir === folder || dir.startsWith(`${folder}/`);
}

/** Nearest recorded ancestor entry for a trait, else the project entry. */
function parentEntry(
  scope: StyleScope, lang: StyleLanguage, folder: string, trait: string,
): TraitEntry | undefined {
  const parents = ancestors(`${folder}/x`).slice(0, -1).reverse();
  for (const dir of parents) {
    const found = scope.folders[dir]?.[lang]?.[trait];
    if (found) return found;
  }
  return scope.project[lang]?.[trait];
}

export function aggregateStyle(files: FileMeasure[]): StyleScope {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const scope: StyleScope = { project: {}, folders: {} };
  for (const lang of LANGUAGES) {
    const votes: LangVotes = {};
    for (const f of sorted) if (f.lang === lang) addFile(votes, f.counts);
    if (Object.keys(votes).length > 0) scope.project[lang] = toMap(votes);
  }
  recordFolders(scope, sorted);
  return scope;
}

function recordFolders(scope: StyleScope, files: FileMeasure[]): void {
  const folders = new Set(files.flatMap((f) => ancestors(f.path)));
  const ordered = [...folders].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );
  for (const folder of ordered) {
    for (const lang of LANGUAGES) {
      const votes: LangVotes = {};
      for (const f of files) {
        if (f.lang === lang && isInside(dirOf(f.path), folder)) addFile(votes, f.counts);
      }
      recordFolderLang(scope, folder, lang, toMap(votes));
    }
  }
}

function recordFolderLang(
  scope: StyleScope, folder: string, lang: StyleLanguage, map: TraitMap,
): void {
  const kept: TraitMap = {};
  for (const [trait, entry] of Object.entries(map)) {
    if (entry.samples < MIN_FOLDER_SAMPLES) continue;
    const parent = parentEntry(scope, lang, folder, trait);
    if (parent && parent.value === entry.value) continue;
    kept[trait] = entry;
  }
  if (Object.keys(kept).length === 0) return;
  (scope.folders[folder] ??= {})[lang] = kept;
}

/** Expected value per trait for a file; formatter-owned and mixed traits are left out. */
export function resolveExpected(
  style: StyleScope, filePath: string, lang: StyleLanguage,
): Record<string, string> {
  const dirs = ancestors(filePath).reverse();
  const traits = new Set(Object.keys(style.project[lang] ?? {}));
  for (const dir of dirs) {
    for (const t of Object.keys(style.folders[dir]?.[lang] ?? {})) traits.add(t);
  }
  const expected: Record<string, string> = {};
  for (const trait of [...traits].sort()) {
    const value = resolveTrait(style, dirs, lang, trait);
    if (value) expected[trait] = value;
  }
  return expected;
}

function resolveTrait(
  style: StyleScope, nearestFirst: string[], lang: StyleLanguage, trait: string,
): string | null {
  const project = style.project[lang]?.[trait];
  if (project?.owner) return null;
  for (const dir of nearestFirst) {
    const entry = style.folders[dir]?.[lang]?.[trait];
    if (entry && entry.value !== MIXED) return entry.owner ? null : entry.value;
  }
  return project && project.value !== MIXED ? project.value : null;
}
