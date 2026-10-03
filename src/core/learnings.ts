import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync, writeJsonAtomicSync } from './lock-manager.js';
import { matchesTarget, parseJsonLoose } from './enforcement.js';
import { SUBAGENT_TYPES } from '../scanner/types.js';

/**
 * nativ · Project learnings in `.ai/learnings.json`. Agents propose; only a human approves, from an
 * interactive terminal. The file is protected like the contracts, by the hook and the ask rules.
 */

export const LEARNING_STATUSES = ['proposed', 'approved', 'rejected'] as const;
export type LearningStatus = (typeof LEARNING_STATUSES)[number];
export type LearningDecision = Exclude<LearningStatus, 'proposed'>;

export interface Learning {
  id: string;
  status: LearningStatus;
  insight: string;
  details?: string;
  /** Applies to this role only; absent means every role. */
  role?: string;
  /** Applies when a task targets a matching file (exact, `dir/` or glob); absent means any file. */
  files?: string[];
  taskId?: string;
  proposedBy?: string;
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface LearningsFile {
  version: '1.0.0';
  updatedAt: string;
  learnings: Learning[];
}

/** The most lessons one task carries, so a long list never crowds out the contracts. */
export const MAX_TASK_LEARNINGS = 5;
const MAX_INSIGHT = 300;
const MAX_DETAILS = 500;
const MAX_FILES = 10;
const MAX_FILE_PATTERN = 200;
const MAX_PENDING = 100;

export function learningsPath(root: string): string {
  return path.join(root, '.ai', 'learnings.json');
}

function isLearning(l: unknown): l is Learning {
  if (!l || typeof l !== 'object') return false;
  const item = l as Learning;
  if (typeof item.id !== 'string' || typeof item.insight !== 'string') return false;
  if (!(LEARNING_STATUSES as readonly string[]).includes(item.status)) return false;
  if (item.files !== undefined && !(Array.isArray(item.files) && item.files.every((f) => typeof f === 'string'))) {
    return false;
  }
  return item.role === undefined || item.role === null || typeof item.role === 'string';
}

/**
 * The file as stored. Records a hand edit left malformed stay in `records` untouched, so writing
 * never deletes them; only valid ones are served.
 */
interface RawFile {
  doc: Record<string, unknown>;
  records: unknown[];
  corrupt: boolean;
}

function readRaw(root: string): RawFile {
  const fresh = (): RawFile => ({ doc: { version: '1.0.0' }, records: [], corrupt: false });
  let raw: string;
  try {
    raw = fs.readFileSync(learningsPath(root), 'utf8');
  } catch {
    return fresh();
  }
  if (!raw.trim()) return fresh();
  try {
    const doc = parseJsonLoose<Record<string, unknown>>(raw);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.learnings)) return { ...fresh(), corrupt: true };
    return { doc, records: doc.learnings as unknown[], corrupt: false };
  } catch {
    return { ...fresh(), corrupt: true };
  }
}

export function loadLearnings(root: string): LearningsFile & { unreadable: boolean } {
  const { doc, records, corrupt } = readRaw(root);
  return {
    version: '1.0.0',
    updatedAt: String(doc.updatedAt ?? ''),
    learnings: records.filter(isLearning),
    unreadable: corrupt,
  };
}

function mutateLearnings<T>(root: string, mutate: (records: unknown[]) => T): T {
  const file = learningsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, () => {
    const { doc, records, corrupt } = readRaw(root);
    if (corrupt) {
      const rel = path.relative(root, file);
      throw new Error(`${rel} cannot be read, so nothing was changed. Fix or move it, then retry.`);
    }
    const result = mutate(records);
    writeJsonAtomicSync(file, { ...doc, version: '1.0.0', updatedAt: new Date().toISOString(), learnings: records });
    return result;
  });
}

/** Ids already used by any record, valid or not, so a new lesson never takes an old one's id. */
function nextId(records: unknown[]): string {
  const max = records.reduce<number>((m, r) => {
    const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined;
    return Math.max(m, Number(typeof id === 'string' ? /^learn-(\d+)$/.exec(id)?.[1] ?? 0 : 0));
  }, 0);
  return `learn-${String(max + 1).padStart(2, '0')}`;
}

// Control characters, bidi overrides, zero-width marks and line/paragraph separators can make the
// text a human approves read differently from what a worker receives.
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const HIDDEN_AND_NEWLINE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

function clean(text: string | undefined, max: number, keepNewlines = false): string | undefined {
  const t = text?.replace(keepNewlines ? HIDDEN : HIDDEN_AND_NEWLINE, keepNewlines ? '' : ' ').trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Maps role aliases (`backend-agent`, `qa`) to the role names tasks use, or null when unknown. */
export function canonicalRole(role: string | null | undefined): string | null {
  const r = (role ?? '').trim().toLowerCase();
  if (!r) return null;
  const known = SUBAGENT_TYPES as readonly string[];
  const candidates = [r, r.replace(/-agent$/, ''), r === 'qa' || r === 'qa-agent' ? 'qa-tester' : '', `${r}-agent`];
  const hit = candidates.find((c) => c && known.includes(c));
  return hit ? hit.replace(/^(backend|frontend|database)-agent$/, '$1').replace(/^qa-agent$/, 'qa-tester') : null;
}

/** A lesson's role in canonical form, also for records saved before roles were normalised. */
const roleOf = (l: Learning): string | null => (l.role ? canonicalRole(l.role) ?? l.role.toLowerCase() : null);

function normalizePattern(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function cleanFiles(files: string[] | undefined): string[] {
  const out: string[] = [];
  for (const f of files ?? []) {
    const p = normalizePattern(f);
    if (!p) continue;
    if (p.length > MAX_FILE_PATTERN) {
      throw new Error(`File pattern is longer than ${MAX_FILE_PATTERN} characters: ${p.slice(0, 40)}...`);
    }
    if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || /(^|\/)\.\.(\/|$)/.test(p)) {
      throw new Error(`File patterns must be relative to the project: ${p}`);
    }
    out.push(p);
  }
  if (out.length > MAX_FILES) throw new Error(`A lesson can name at most ${MAX_FILES} file patterns.`);
  return out;
}

export interface ProposeInput {
  insight: string;
  details?: string;
  role?: string;
  files?: string[];
  taskId?: string;
  proposedBy?: string;
}

export function proposeLearning(root: string, input: ProposeInput): Learning {
  const insight = clean(input.insight, MAX_INSIGHT);
  if (!insight) throw new Error('A learning needs a one-line insight.');
  const details = clean(input.details, MAX_DETAILS, true);
  const role = input.role?.trim() ? canonicalRole(input.role) : undefined;
  if (role === null) throw new Error(`Unknown role "${input.role}". Use one of: ${SUBAGENT_TYPES.join(', ')}.`);
  const files = cleanFiles(input.files);
  const taskId = clean(input.taskId, 64);
  const proposedBy = clean(input.proposedBy, 64);
  return mutateLearnings(root, (records) => {
    const pending = records.filter((r) => isLearning(r) && r.status === 'proposed').length;
    if (pending >= MAX_PENDING) {
      throw new Error(`${pending} lessons already wait for approval. Approve or reject some before proposing more.`);
    }
    const item: Learning = {
      id: nextId(records),
      status: 'proposed',
      insight,
      ...(details ? { details } : {}),
      ...(role ? { role } : {}),
      ...(files.length ? { files } : {}),
      ...(taskId ? { taskId } : {}),
      ...(proposedBy ? { proposedBy } : {}),
      createdAt: new Date().toISOString(),
    };
    records.push(item);
    return item;
  });
}

/** What a worker receives from a lesson; a decision applies only if this is what the human saw. */
export function lessonContent(l: Pick<Learning, 'insight' | 'details' | 'role' | 'files'>): string {
  return JSON.stringify([l.insight, l.details ?? '', l.role ?? '', l.files ?? []]);
}

/**
 * Approves or rejects a lesson. Pass `seen` (from lessonContent) to refuse when the lesson changed
 * after the human looked at it. Returns an error message, or the updated lesson.
 */
export function decideLearning(
  root: string,
  id: string,
  decision: LearningDecision,
  note?: string,
  seen?: string,
): Learning | string {
  return mutateLearnings(root, (records) => {
    const item = records.find((r): r is Learning => isLearning(r) && r.id === id);
    if (!item) return `No learning ${id}.`;
    if (seen !== undefined && lessonContent(item) !== seen) {
      return `${id} changed while you were reviewing it. Nothing was decided; run the command again.`;
    }
    if (item.status === decision) return `${id} is already ${decision}.`;
    item.status = decision;
    item.decidedAt = new Date().toISOString();
    const cleanNote = clean(note, MAX_DETAILS);
    if (cleanNote) item.decisionNote = cleanNote;
    else delete item.decisionNote;
    return item;
  });
}

export function listLearnings(root: string, filter: { status?: LearningStatus; role?: string } = {}): Learning[] {
  const role = filter.role ? canonicalRole(filter.role) ?? filter.role.toLowerCase() : undefined;
  return loadLearnings(root).learnings.filter(
    (l) => (!filter.status || l.status === filter.status) && (!role || roleOf(l) === role),
  );
}

const globBase = (p: string): string => p.split(/[*?[{]/)[0];

/** True when a task target and a lesson pattern overlap, whichever of them is the wider one. */
function overlaps(target: string, pattern: string): boolean {
  const t = normalizePattern(target);
  if (matchesTarget(t, pattern) || matchesTarget(pattern, t)) return true;
  const [tb, pb] = [globBase(t).toLowerCase(), globBase(pattern).toLowerCase()];
  const targetIsWide = t.endsWith('/') || t.length !== tb.length;
  const patternIsWide = pattern.endsWith('/') || pattern.length !== pb.length;
  return (targetIsWide && tb !== '' && pattern.toLowerCase().startsWith(tb))
    || (patternIsWide && pb !== '' && t.toLowerCase().startsWith(pb));
}

/**
 * Approved lessons for one task: those scoped to its files first, then to its role, then
 * project-wide ones, newest first within each, capped at MAX_TASK_LEARNINGS.
 */
export function learningsForTask(
  root: string,
  task: { assignedSubagent?: string; targetFiles?: string[] },
): Learning[] {
  const role = canonicalRole(task.assignedSubagent);
  const targets = Array.isArray(task.targetFiles) ? task.targetFiles.filter((t) => typeof t === 'string') : [];
  const scored: { item: Learning; score: number; order: number }[] = [];
  loadLearnings(root).learnings.forEach((item, order) => {
    if (item.status !== 'approved') return;
    const itemRole = roleOf(item);
    if (itemRole && itemRole !== role) return;
    const fileMatch = item.files?.length ? targets.some((t) => item.files!.some((p) => overlaps(t, p))) : null;
    if (fileMatch === false) return;
    scored.push({ item, score: (fileMatch ? 2 : 0) + (itemRole ? 1 : 0), order });
  });
  return scored
    .sort((a, b) => b.score - a.score || b.order - a.order)
    .slice(0, MAX_TASK_LEARNINGS)
    .map((s) => s.item);
}
