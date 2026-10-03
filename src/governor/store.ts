import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withFileLockSync, writeJsonAtomicSync } from '../core/lock-manager.js';
import type { EscalationFile, EscalationRecord } from '../scanner/types.js';

/**
 * Shared on-disk state of the governor: `.ai/.governor_ledger.json` and `.ai/escalation.json`.
 * Parallel agents in separate worktrees share one `.ai/`, so every read-modify-write here holds
 * a file lock and replaces the file atomically.
 */

export interface LedgerEntry {
  consecutiveFailures: number;
  lastFailureTime: string;
  lastRuleId?: string;
  lastViolation?: string;
  patchCount: number;
  /** Commit recorded at `nativ task start`; the test-integrity guard diffs against it. */
  baselineRef?: string;
  baselineRecordedAt?: string;
}

export type TaskFailureLedger = Record<string, LedgerEntry>;

export function ledgerPath(targetDir: string): string {
  return path.join(targetDir, '.ai', '.governor_ledger.json');
}

export function escalationPath(targetDir: string): string {
  return path.join(targetDir, '.ai', 'escalation.json');
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // The lock helpers create an empty placeholder before the first write.
    return raw.trim() ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadLedger(targetDir: string): TaskFailureLedger {
  return readJson<TaskFailureLedger>(ledgerPath(targetDir), {});
}

/** Locked read-modify-write of the ledger; the mutator's return value is passed through. */
export function mutateLedger<T>(targetDir: string, mutator: (ledger: TaskFailureLedger) => T): T {
  const file = ledgerPath(targetDir);
  return withFileLockSync(file, () => {
    const ledger = readJson<TaskFailureLedger>(file, {});
    const result = mutator(ledger);
    writeJsonAtomicSync(file, ledger);
    return result;
  });
}

export function loadEscalationFile(targetDir: string, projectName: string): EscalationFile {
  const empty: EscalationFile = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    version: '1.0.0',
    projectName,
    lastUpdated: new Date().toISOString(),
    escalations: [],
  };
  const file = readJson<EscalationFile>(escalationPath(targetDir), empty);
  if (!Array.isArray(file.escalations)) file.escalations = [];
  return file;
}

export type EscalationIdStyle = 'sequential' | 'unique';

/**
 * Picks an id no existing record uses. `sequential` keeps the human-friendly `esc-NN` of
 * `nativ task escalate`; `unique` (circuit-breaker trips) adds random bits to a timestamp so two
 * trips in the same millisecond still get different ids.
 */
function nextEscalationId(existing: Set<string>, style: EscalationIdStyle): string {
  if (style === 'sequential') {
    const numbers = [...existing].map((id) => /^esc-(\d+)$/.exec(id)?.[1]).filter(Boolean).map(Number);
    let n = numbers.length ? Math.max(...numbers) + 1 : 1;
    while (existing.has(`esc-${String(n).padStart(2, '0')}`)) n++;
    return `esc-${String(n).padStart(2, '0')}`;
  }
  for (;;) {
    const id = `esc-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
}

/**
 * Appends an escalation under the file lock. The id is assigned inside the lock, so concurrent
 * writers can neither collide nor overwrite each other's records. Returns the id.
 */
export function appendEscalation(
  targetDir: string,
  build: (id: string) => EscalationRecord,
  options: { style: EscalationIdStyle; position?: 'first' | 'last'; projectName?: string },
): string {
  const file = escalationPath(targetDir);
  return withFileLockSync(file, () => {
    const data = loadEscalationFile(targetDir, options.projectName ?? path.basename(targetDir));
    const id = nextEscalationId(new Set(data.escalations.map((e) => e?.id).filter(Boolean)), options.style);
    const record = build(id);
    if (options.position === 'last') data.escalations.push(record);
    else data.escalations.unshift(record);
    data.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(file, data);
    return id;
  });
}

export interface EscalationHistoryEntry {
  id: string;
  type: string;
  status: 'resolved' | 'dismissed';
  summary: string;
  resolutionNotes?: string;
  resolvedAt?: string;
}

const HISTORY_TEXT_LIMIT = 400;

/** Plain single-line text: control characters could hide words in a terminal or a prompt. */
function clip(value: unknown): string {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return text.length > HISTORY_TEXT_LIMIT ? `${text.slice(0, HISTORY_TEXT_LIMIT)}...` : text;
}

const sortKey = (e: EscalationRecord): string => String(e.resolvedAt ?? e.timestamp ?? '');

/**
 * The closed escalations of one task, oldest first, so the worker who picks the task up again
 * learns how each gap was settled instead of raising it a second time.
 */
export function taskEscalationHistory(targetDir: string, taskId: string, limit = 3): EscalationHistoryEntry[] {
  const records = loadEscalationFile(targetDir, path.basename(targetDir)).escalations;
  return records
    .filter((e) => e && typeof e === 'object' && e.taskId === taskId)
    .filter((e) => e.status === 'resolved' || e.status === 'dismissed')
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .slice(-limit)
    .map((e) => ({
      id: clip(e.id),
      type: clip(e.type),
      status: e.status as 'resolved' | 'dismissed',
      summary: clip(e.summary),
      ...(e.resolutionNotes ? { resolutionNotes: clip(e.resolutionNotes) } : {}),
      ...(e.resolvedAt ? { resolvedAt: clip(e.resolvedAt) } : {}),
    }));
}

/**
 * Closes the pending escalations of a task that has just completed: the question was settled one way
 * or another, so it should not keep asking for a decision. Returns the ids it closed.
 */
export function closeEscalationsForTask(targetDir: string, taskId: string, note: string): string[] {
  const file = escalationPath(targetDir);
  if (!fs.existsSync(file)) return [];
  return withFileLockSync(file, () => {
    const data = loadEscalationFile(targetDir, path.basename(targetDir));
    const closed: string[] = [];
    for (const e of data.escalations) {
      if (!e || e.taskId !== taskId || (e.status && e.status !== 'pending_review')) continue;
      e.status = 'resolved';
      e.resolutionNotes = note;
      e.resolvedAt = new Date().toISOString();
      closed.push(e.id);
    }
    if (closed.length) {
      data.lastUpdated = new Date().toISOString();
      writeJsonAtomicSync(file, data);
    }
    return closed;
  });
}
