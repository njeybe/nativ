import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withFileLockSync, writeJsonAtomicSync } from './lock-manager.js';
import { matchesTarget, parseJsonLoose } from './enforcement.js';
import { SUBAGENT_TYPES } from '../scanner/types.js';
import { resolveMainRoot } from './root-resolver.js';

/**
 * nativ · Project learnings in `.ai/learnings.json`. Agents propose; only a human approves, and each
 * approval is signed with a key agents cannot read, so a lesson flipped or rewritten later is not served.
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
  /** HMAC of the approved content; checked before the lesson reaches a worker. */
  signature?: string;
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

/** `.nativ/*.local.json` is a secret path: agents are denied reading it everywhere nativ enforces. */
export function approvalKeyPath(root: string): string {
  return path.join(resolveMainRoot(root), '.nativ', 'approval.local.json');
}

const empty = (): LearningsFile => ({ version: '1.0.0', updatedAt: new Date().toISOString(), learnings: [] });

/** Drops entries a hand edit left malformed, so one bad record never breaks task selection. */
function sanitize(raw: unknown): Learning[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is Learning => {
    if (!l || typeof l !== 'object') return false;
    const item = l as Learning;
    if (typeof item.id !== 'string' || typeof item.insight !== 'string') return false;
    if (!(LEARNING_STATUSES as readonly string[]).includes(item.status)) return false;
    if (item.files !== undefined && !(Array.isArray(item.files) && item.files.every((f) => typeof f === 'string'))) {
      return false;
    }
    return item.role === undefined || typeof item.role === 'string';
  });
}

/** Reads the file. `corrupt` is true when it exists with content that does not parse. */
function readLearnings(root: string): { data: LearningsFile; corrupt: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(learningsPath(root), 'utf8');
  } catch {
    return { data: empty(), corrupt: false };
  }
  if (!raw.trim()) return { data: empty(), corrupt: false };
  try {
    const parsed = parseJsonLoose<Partial<LearningsFile>>(raw);
    if (!parsed || !Array.isArray(parsed.learnings)) return { data: empty(), corrupt: true };
    const learnings = sanitize(parsed.learnings);
    return { data: { version: '1.0.0', updatedAt: String(parsed.updatedAt ?? ''), learnings }, corrupt: false };
  } catch {
    return { data: empty(), corrupt: true };
  }
}

export function loadLearnings(root: string): LearningsFile {
  return readLearnings(root).data;
}

function mutateLearnings<T>(root: string, mutate: (data: LearningsFile) => T): T {
  const file = learningsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, () => {
    const { data, corrupt } = readLearnings(root);
    if (corrupt) {
      const rel = path.relative(root, file);
      throw new Error(`${rel} cannot be read, so nothing was changed. Fix or move it, then retry.`);
    }
    const result = mutate(data);
    data.updatedAt = new Date().toISOString();
    writeJsonAtomicSync(file, data);
    return result;
  });
}

function nextId(existing: Learning[]): string {
  const max = existing.reduce((m, l) => Math.max(m, Number(/^learn-(\d+)$/.exec(l.id)?.[1] ?? 0)), 0);
  return `learn-${String(max + 1).padStart(2, '0')}`;
}

/** Trims, removes control characters that could hide text in a terminal, and caps the length. */
function clean(text: string | undefined, max: number, keepNewlines = false): string | undefined {
  const controls = keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g;
  const t = text?.replace(controls, keepNewlines ? '' : ' ').trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Maps role aliases (`backend-agent`, `qa`) to the role names tasks use, or null when unknown. */
export function canonicalRole(role: string | undefined): string | null {
  const r = (role ?? '').trim().toLowerCase();
  if (!r) return null;
  const known = SUBAGENT_TYPES as readonly string[];
  const candidates = [r, r.replace(/-agent$/, ''), r === 'qa' || r === 'qa-agent' ? 'qa-tester' : '', `${r}-agent`];
  const hit = candidates.find((c) => c && known.includes(c));
  return hit ? hit.replace(/^(backend|frontend|database)-agent$/, '$1').replace(/^qa-agent$/, 'qa-tester') : null;
}

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
  return mutateLearnings(root, (data) => {
    const pending = data.learnings.filter((l) => l.status === 'proposed').length;
    if (pending >= MAX_PENDING) {
      throw new Error(`${pending} lessons already wait for approval. Approve or reject some before proposing more.`);
    }
    const item: Learning = {
      id: nextId(data.learnings),
      status: 'proposed',
      insight,
      ...(details ? { details } : {}),
      ...(role ? { role } : {}),
      ...(files.length ? { files } : {}),
      ...(taskId ? { taskId } : {}),
      ...(proposedBy ? { proposedBy } : {}),
      createdAt: new Date().toISOString(),
    };
    data.learnings.push(item);
    return item;
  });
}

function readKey(root: string): Buffer | null {
  try {
    const key = parseJsonLoose<{ key?: unknown }>(fs.readFileSync(approvalKeyPath(root), 'utf8')).key;
    return typeof key === 'string' && /^[0-9a-f]{64}$/.test(key) ? Buffer.from(key, 'hex') : null;
  } catch {
    return null;
  }
}

function readOrCreateKey(root: string): Buffer {
  const existing = readKey(root);
  if (existing) return existing;
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(approvalKeyPath(root)), { recursive: true });
  const text = `${JSON.stringify({ key: key.toString('hex') }, null, 2)}\n`;
  fs.writeFileSync(approvalKeyPath(root), text, { mode: 0o600 });
  return key;
}

/** Signs exactly what a worker will receive, so any later edit to it voids the approval. */
function sign(key: Buffer, l: Learning): string {
  const content = JSON.stringify([l.id, 'approved', l.insight, l.details ?? '', l.role ?? '', l.files ?? []]);
  return crypto.createHmac('sha256', key).update(content).digest('hex');
}

export function hasValidSignature(root: string, l: Learning, key: Buffer | null = readKey(root)): boolean {
  if (!key || l.status !== 'approved' || typeof l.signature !== 'string') return false;
  const expected = Buffer.from(sign(key, l), 'hex');
  const actual = Buffer.from(l.signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Approves or rejects a lesson. Returns an error message, or the updated lesson. */
export function decideLearning(root: string, id: string, decision: LearningDecision, note?: string): Learning | string {
  return mutateLearnings(root, (data) => {
    const item = data.learnings.find((l) => l.id === id);
    if (!item) return `No learning ${id}.`;
    if (item.status === decision && (decision === 'rejected' || hasValidSignature(root, item))) {
      return `${id} is already ${decision}.`;
    }
    item.status = decision;
    item.decidedAt = new Date().toISOString();
    const cleanNote = clean(note, MAX_DETAILS);
    if (cleanNote) item.decisionNote = cleanNote;
    else delete item.decisionNote;
    if (decision === 'approved') item.signature = sign(readOrCreateKey(root), item);
    else delete item.signature;
    return item;
  });
}

export function listLearnings(root: string, filter: { status?: LearningStatus; role?: string } = {}): Learning[] {
  const role = filter.role ? canonicalRole(filter.role) ?? filter.role.toLowerCase() : undefined;
  return loadLearnings(root).learnings.filter(
    (l) => (!filter.status || l.status === filter.status) && (!role || l.role === role),
  );
}

/** Approved lessons whose signature no longer matches: edited or flipped after approval. */
export function unverifiedApprovals(root: string): Learning[] {
  const key = readKey(root);
  return loadLearnings(root).learnings.filter((l) => l.status === 'approved' && !hasValidSignature(root, l, key));
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
 * Approved, correctly signed lessons for one task: those scoped to its files first, then to its
 * role, then project-wide ones, newest first within each, capped at MAX_TASK_LEARNINGS.
 */
export function learningsForTask(
  root: string,
  task: { assignedSubagent?: string; targetFiles?: string[] },
): Learning[] {
  const key = readKey(root);
  if (!key) return [];
  const role = canonicalRole(task.assignedSubagent);
  const targets = Array.isArray(task.targetFiles) ? task.targetFiles.filter((t) => typeof t === 'string') : [];
  const scored: { item: Learning; score: number; order: number }[] = [];
  loadLearnings(root).learnings.forEach((item, order) => {
    if (!hasValidSignature(root, item, key)) return;
    if (item.role && item.role !== role) return;
    const fileMatch = item.files?.length ? targets.some((t) => item.files!.some((p) => overlaps(t, p))) : null;
    if (fileMatch === false) return;
    scored.push({ item, score: (fileMatch ? 2 : 0) + (item.role ? 1 : 0), order });
  });
  return scored
    .sort((a, b) => b.score - a.score || b.order - a.order)
    .slice(0, MAX_TASK_LEARNINGS)
    .map((s) => s.item);
}
