import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync, writeJsonAtomicSync } from './lock-manager.js';
import { matchesTarget } from './enforcement.js';

/**
 * nativ · Project learnings: `.ai/learnings.json`.
 *
 * A worker or the architect proposes a lesson the contracts do not capture ("the date picker needs
 * the locale set before mount"). Only a human approves it, from a terminal, so a lesson from a
 * failing worker never becomes a rule for every later worker by itself. Approved lessons travel
 * with `nativ task next`, filtered to the task's role and target files.
 */

export type LearningStatus = 'proposed' | 'approved' | 'rejected';

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
const MAX_TEXT = 500;

export function learningsPath(root: string): string {
  return path.join(root, '.ai', 'learnings.json');
}

export function loadLearnings(root: string): LearningsFile {
  try {
    const raw = fs.readFileSync(learningsPath(root), 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.learnings)) return parsed as LearningsFile;
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: '1.0.0', updatedAt: new Date().toISOString(), learnings: [] };
}

function mutateLearnings<T>(root: string, mutate: (data: LearningsFile) => T): T {
  const file = learningsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, () => {
    const data = loadLearnings(root);
    const result = mutate(data);
    data.updatedAt = new Date().toISOString();
    writeJsonAtomicSync(file, data);
    return result;
  });
}

function nextId(existing: Learning[]): string {
  const numbers = existing.map((l) => Number(/^learn-(\d+)$/.exec(l.id)?.[1] ?? 0));
  return `learn-${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}`;
}

function clean(text: string | undefined): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
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
  const insight = clean(input.insight);
  if (!insight) throw new Error('A learning needs a one-line insight.');
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
  return mutateLearnings(root, (data) => {
    const item: Learning = {
      id: nextId(data.learnings),
      status: 'proposed',
      insight,
      ...(clean(input.details) ? { details: clean(input.details) } : {}),
      ...(clean(input.role) ? { role: clean(input.role)!.toLowerCase() } : {}),
      ...(files.length ? { files } : {}),
      ...(clean(input.taskId) ? { taskId: clean(input.taskId) } : {}),
      ...(clean(input.proposedBy) ? { proposedBy: clean(input.proposedBy) } : {}),
      createdAt: new Date().toISOString(),
    };
    data.learnings.push(item);
    return item;
  });
}

/** Approves or rejects a proposed learning. Returns an error message, or the updated learning. */
export function decideLearning(
  root: string,
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Learning | string {
  return mutateLearnings(root, (data) => {
    const item = data.learnings.find((l) => l.id === id);
    if (!item) return `No learning ${id}.`;
    if (item.status === decision) return `${id} is already ${decision}.`;
    item.status = decision;
    item.decidedAt = new Date().toISOString();
    if (clean(note)) item.decisionNote = clean(note);
    else delete item.decisionNote;
    return item;
  });
}

export function listLearnings(root: string, filter: { status?: LearningStatus; role?: string } = {}): Learning[] {
  const role = filter.role?.toLowerCase();
  return loadLearnings(root).learnings.filter(
    (l) => (!filter.status || l.status === filter.status) && (!role || l.role === role),
  );
}

/**
 * Approved lessons for one task: those scoped to its files first, then to its role, then
 * project-wide ones, newest first within each, capped at MAX_TASK_LEARNINGS.
 */
export function learningsForTask(
  root: string,
  task: { assignedSubagent?: string; targetFiles?: string[] },
): Learning[] {
  const role = (task.assignedSubagent ?? '').toLowerCase();
  const targets = task.targetFiles ?? [];
  const scored: { item: Learning; score: number; order: number }[] = [];
  loadLearnings(root).learnings.forEach((item, order) => {
    if (item.status !== 'approved') return;
    if (item.role && item.role !== role) return;
    const fileMatch = item.files?.length
      ? targets.some((t) => item.files!.some((pattern) => matchesTarget(t, pattern)))
      : null;
    if (fileMatch === false) return;
    const score = (fileMatch ? 2 : 0) + (item.role ? 1 : 0);
    scored.push({ item, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || b.order - a.order)
    .slice(0, MAX_TASK_LEARNINGS)
    .map((s) => s.item);
}
