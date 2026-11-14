import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync, writeJsonAtomicSync } from '../lock-manager.js';
import { parseJsonLoose } from '../enforcement.js';
import {
  DECISION_STATUSES,
  MAX_PATTERN_TEXT,
  STALE_COMMITS,
  STYLE_RULES,
  type CodeStyleFile,
  type LoadedCodeStyle,
  type StyleDecision,
  type Staleness,
} from './style-types.js';

export function codeStylePath(root: string): string {
  return path.join(root, '.ai', 'code_style.json');
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const unsafePath = (p: unknown): boolean =>
  typeof p !== 'string' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p);

function checkTraits(where: string, traits: unknown, out: string[]): void {
  if (!isObject(traits)) return void out.push(`${where} must be an object.`);
  for (const [lang, map] of Object.entries(traits)) {
    for (const [name, t] of Object.entries(isObject(map) ? map : {})) {
      const share = t?.share;
      if (typeof share !== 'number' || share < 0 || share > 1) {
        out.push(`${where} ${lang} ${name}: share must be a number from 0 to 1.`);
      }
    }
  }
}

function checkDecision(d: any, i: number, out: string[]): void {
  const at = `Decision ${i + 1}`;
  if (!STYLE_RULES.some((r) => r.id === d?.rule)) out.push(`${at}: unknown rule "${d?.rule}".`);
  if (!(DECISION_STATUSES as readonly string[]).includes(d?.status)) {
    out.push(`${at}: status must be one of ${DECISION_STATUSES.join(', ')}.`);
  }
  const files = d?.evidence?.files;
  if (!Array.isArray(files) || files.some(unsafePath)) {
    out.push(`${at}: evidence files must be relative paths inside the project.`);
  }
}

function checkPatterns(patterns: unknown, out: string[]): void {
  const seen = new Set<string>();
  for (const p of Array.isArray(patterns) ? patterns : []) {
    if (typeof p?.id !== 'string' || !/^pat-\d+$/.test(p.id)) out.push(`Pattern id "${p?.id}" must look like pat-01.`);
    else if (seen.has(p.id)) out.push(`Pattern id ${p.id} is used twice.`);
    else seen.add(p.id);
    if (typeof p?.text !== 'string' || p.text.length > MAX_PATTERN_TEXT) {
      out.push(`Pattern ${p?.id}: text must be at most ${MAX_PATTERN_TEXT} characters.`);
    }
    if (!Array.isArray(p?.evidence) || p.evidence.some(unsafePath)) {
      out.push(`Pattern ${p?.id}: evidence paths must be relative paths inside the project.`);
    }
  }
}

/** Plain-language problems with a parsed file; an empty list means it is usable. */
export function validateCodeStyle(doc: unknown): string[] {
  const out: string[] = [];
  if (!isObject(doc)) return ['The file must hold one JSON object.'];
  if (doc.version !== 1) out.push(`Version must be 1, found ${JSON.stringify(doc.version)}.`);
  checkTraits('Project traits', doc.project ?? {}, out);
  for (const [folder, traits] of Object.entries(isObject(doc.folders) ? doc.folders : {})) {
    checkTraits(`Folder ${folder}`, traits, out);
  }
  if (!Array.isArray(doc.decisions)) out.push('Decisions must be a list.');
  else doc.decisions.forEach((d, i) => checkDecision(d, i, out));
  checkPatterns(doc.patterns, out);
  return out;
}

/** Never throws: a missing, malformed or invalid file comes back as `file: null`. */
export function loadCodeStyle(root: string): LoadedCodeStyle {
  let raw: string;
  try {
    raw = fs.readFileSync(codeStylePath(root), 'utf8');
  } catch {
    return { file: null, unreadable: false, problems: [] };
  }
  try {
    const doc = parseJsonLoose<unknown>(raw);
    const problems = validateCodeStyle(doc);
    return { file: problems.length ? null : (doc as CodeStyleFile), unreadable: problems.length > 0, problems };
  } catch {
    return { file: null, unreadable: true, problems: ['The file is not valid JSON.'] };
  }
}

export function saveCodeStyle(root: string, file: CodeStyleFile): void {
  const target = codeStylePath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  withFileLockSync(target, () => writeJsonAtomicSync(target, file));
}

/** A fresh scan on top of the saved file: decisions and patterns survive, evidence is refreshed. */
export function mergeScan(prev: CodeStyleFile | null, scan: CodeStyleFile): CodeStyleFile {
  const decisions: StyleDecision[] = scan.decisions.map((d) => {
    const old = prev?.decisions.find((p) => p.rule === d.rule);
    return old ? { ...d, status: old.status, decidedAt: old.decidedAt } : d;
  });
  for (const old of prev?.decisions ?? []) {
    const decided = old.status !== 'pending';
    if (decided && !decisions.some((d) => d.rule === old.rule)) {
      decisions.push({ ...old, evidence: { count: 0, files: [] } });
    }
  }
  return { ...scan, decisions, patterns: prev?.patterns ?? scan.patterns };
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Null outside git or without a scanned commit; otherwise how far the scan is behind HEAD. */
export function styleStaleness(root: string, style: CodeStyleFile): Staleness | null {
  const commit = style.scannedAt?.commit;
  if (!commit || git(root, ['rev-parse', '--git-dir']) === null) return null;
  const known = git(root, ['cat-file', '-e', `${commit}^{commit}`]) !== null;
  const ancestor = known && git(root, ['merge-base', '--is-ancestor', commit, 'HEAD']) !== null;
  if (!ancestor) return { behind: 0, gone: true, stale: true };
  const behind = Number(git(root, ['rev-list', '--count', `${commit}..HEAD`]) ?? 0);
  return { behind, gone: false, stale: behind >= STALE_COMMITS };
}

/** Settles one conflict rule under the store lock; throws on an unknown rule or missing decision. */
export function decideStyleRule(root: string, rule: string, follow: string): CodeStyleFile {
  if (!STYLE_RULES.some((r) => r.id === rule)) throw new Error(`Unknown rule "${rule}".`);
  if (follow !== 'nativ' && follow !== 'codebase') {
    throw new Error(`Choice must be "nativ" or "codebase", found "${follow}".`);
  }
  const target = codeStylePath(root);
  return withFileLockSync(target, () => {
    const file = loadCodeStyle(root).file;
    const found = file?.decisions.find((d) => d.rule === rule);
    if (!file || !found) throw new Error(`No decision recorded for rule "${rule}"; run nativ style scan.`);
    found.status = follow;
    found.decidedAt = new Date().toISOString().slice(0, 10);
    writeJsonAtomicSync(target, file);
    return file;
  });
}
