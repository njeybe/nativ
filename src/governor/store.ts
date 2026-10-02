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

function clip(text: string): string {
  return text.length > HISTORY_TEXT_LIMIT ? `${text.slice(0, HISTORY_TEXT_LIMIT)}...` : text;
}

/**
 * The closed escalations of one task, oldest first, so the worker who picks the task up again
 * learns how each gap was settled instead of raising it a second time.
 */
export function taskEscalationHistory(targetDir: string, taskId: string, limit = 3): EscalationHistoryEntry[] {
  const records = loadEscalationFile(targetDir, path.basename(targetDir)).escalations;
  return records
    .filter((e) => e?.taskId === taskId && (e.status === 'resolved' || e.status === 'dismissed'))
    .sort((a, b) => (a.resolvedAt ?? a.timestamp ?? '').localeCompare(b.resolvedAt ?? b.timestamp ?? ''))
    .slice(-limit)
    .map((e) => ({
      id: e.id,
      type: e.type,
      status: e.status as 'resolved' | 'dismissed',
      summary: clip(String(e.summary ?? '')),
      ...(e.resolutionNotes ? { resolutionNotes: clip(e.resolutionNotes) } : {}),
      ...(e.resolvedAt ? { resolvedAt: e.resolvedAt } : {}),
    }));
}
