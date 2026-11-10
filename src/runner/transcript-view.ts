import fs from 'node:fs';
import path from 'node:path';
import { transcriptDir, type TranscriptEvent } from './transcript.js';

const EDGE_BYTES = 64 * 1024;

export interface TranscriptSummary {
  runId: string;
  taskId: string | null;
  engine: string | null;
  model: string | null;
  /** Null while the run is going, or when it stopped without writing its closing event. */
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  turns: number | null;
  bytes: number;
  file: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseEvent(line: string): TranscriptEvent | null {
  try {
    const event = JSON.parse(line);
    const ok = event && typeof event === 'object' && typeof event.type === 'string' && typeof event.at === 'string';
    return ok ? (event as TranscriptEvent) : null;
  } catch {
    return null;
  }
}

/** Reads every event. A damaged line is counted and skipped, so a crash mid-write loses one line. */
export function readTranscript(file: string): { events: TranscriptEvent[]; skipped: number } {
  const events: TranscriptEvent[] = [];
  let skipped = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (event) events.push(event);
    else skipped++;
  }
  return { events, skipped };
}

/** The first and last line only, so listing many large transcripts stays cheap. */
function edgeLines(file: string): { first: string | null; last: string | null; bytes: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, EDGE_BYTES);
    const readAt = (position: number): string => {
      const buffer = Buffer.alloc(len);
      fs.readSync(fd, buffer, 0, len, position);
      return buffer.toString('utf8');
    };
    const first = readAt(0).split('\n')[0] || null;
    const lines = readAt(size - len).split('\n').filter((l) => l.trim());
    return { first, last: lines.length ? lines[lines.length - 1] : null, bytes: size };
  } finally {
    fs.closeSync(fd);
  }
}

export function summarizeTranscript(file: string): TranscriptSummary | null {
  try {
    const { first, last, bytes } = edgeLines(file);
    const start = first ? parseEvent(first) : null;
    const end = last ? parseEvent(last) : null;
    const closing = end?.type === 'run_end' ? end : null;
    const usage = (closing?.usage ?? null) as Record<string, unknown> | null;
    return {
      runId: path.basename(file, '.jsonl'),
      taskId: str(start?.taskId),
      engine: str(start?.engine),
      // A cli run without an explicit model only learns it from Claude Code, which the usage totals keep.
      model: str(start?.model) ?? str(usage?.model),
      status: str(closing?.status),
      startedAt: start ? start.at : null,
      durationMs: num(closing?.durationMs),
      costUsd: num(usage?.costUsd),
      turns: num(usage?.turns),
      bytes,
      file,
    };
  } catch {
    return null;
  }
}

/** Recorded runs, newest first. */
export function listTranscripts(root: string, filter: { task?: string; limit?: number } = {}): TranscriptSummary[] {
  const dir = transcriptDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const all = names
    .map((f) => summarizeTranscript(path.join(dir, f)))
    .filter((s): s is TranscriptSummary => s !== null)
    .filter((s) => !filter.task || s.taskId === filter.task)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return filter.limit ? all.slice(0, filter.limit) : all;
}

export type FindResult = { summary: TranscriptSummary } | { error: string };

/** A run id, a task id (its latest run) or a unique run id prefix. */
export function findTranscript(root: string, id: string): FindResult {
  const all = listTranscripts(root);
  const exact = all.find((s) => s.runId === id);
  if (exact) return { summary: exact };
  const forTask = all.filter((s) => s.taskId === id);
  if (forTask.length) return { summary: forTask[0] };
  const prefixed = id.length >= 4 ? all.filter((s) => s.runId.startsWith(id)) : [];
  if (prefixed.length === 1) return { summary: prefixed[0] };
  if (prefixed.length > 1) {
    const ids = prefixed.slice(0, 5).map((s) => s.runId.slice(0, 12)).join(', ');
    return { error: `"${id}" matches ${prefixed.length} runs; use more characters (${ids}).` };
  }
  return { error: `No recorded run matches "${id}". "nativ runs list" shows what is recorded.` };
}

// ─── Readable replay ───────────────────────────────────────────────────────────

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const pad = (v: number): string => String(v).padStart(2, '0');

function stamp(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `[${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}]`;
}

function limit(body: string, maxLines: number, maxChars: number): string {
  const lines = body.replace(/\s+$/, '').split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}...`;
  const hidden = lines.length - maxLines;
  return hidden > 0 ? `${out}\n... ${hidden} more line${hidden === 1 ? '' : 's'}` : out;
}

function entry(at: string, head: string, body?: string): string {
  if (!body) return `${at} ${head}`;
  if (!body.includes('\n') && body.length <= 100) return `${at} ${head}: ${body}`;
  return `${at} ${head}\n${body.split('\n').map((l) => `        ${l}`).join('\n')}`;
}

function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if (typeof i.command === 'string' && typeof i.path === 'string') return `${i.command} ${i.path}`;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description;
  const first = (typeof pick === 'string' ? pick : JSON.stringify(input)).split('\n')[0];
  return first.length > 160 ? `${first.slice(0, 160)}...` : first;
}

function renderUsage(e: TranscriptEvent, at: string): string {
  const tokens = `in ${n(e.inputTokens)} · out ${n(e.outputTokens)}`
    + ` · cache read ${n(e.cacheReadTokens)} / write ${n(e.cacheCreationTokens)}`;
  const cost = typeof e.costUsd === 'number' ? ` · $${e.costUsd.toFixed(4)}` : '';
  if (e.scope !== 'turn') return `${at} run total · ${n(e.turns)} turns · ${tokens}${cost}`;
  const ms = n(e.latencyMs) ? ` · ${n(e.latencyMs)} ms` : '';
  return `${at} turn ${n(e.turn)} · ${text(e.model)} · ${text(e.stopReason) || 'no stop reason'} · ${tokens}${cost}${ms}`;
}

function renderEvent(e: TranscriptEvent, startMs: number, full: boolean): string {
  const at = stamp(Date.parse(e.at) - startMs);
  const lines = (maxLines: number, maxChars: number) => (full ? [Infinity, Infinity] : [maxLines, maxChars]);
  switch (e.type) {
    case 'run_start':
      return `${at} start · task ${text(e.taskId)} · ${text(e.engine)} engine · ${text(e.model) || 'default model'}`;
    case 'prompt':
      return entry(at, `prompt (${text(e.text).length} characters)`, full ? text(e.text) : undefined);
    case 'session':
      return `${at} session · model ${text(e.model) || 'default'}${e.tools ? ` · ${n(e.tools)} tools` : ''}`;
    case 'assistant_text': {
      const [l, c] = lines(12, 1200);
      return entry(at, 'says', limit(text(e.text), l, c));
    }
    case 'thinking': {
      const [l, c] = lines(3, 300);
      return entry(at, 'thinks', limit(text(e.text), l, c));
    }
    case 'tool_call': {
      const head = `call ${text(e.name)}: ${describeInput(e.input)}`;
      return entry(at, head, full ? JSON.stringify(e.input, null, 2) : undefined);
    }
    case 'tool_result': {
      const [l, c] = lines(4, 400);
      const head = `result ${e.isError ? 'ERROR' : 'ok'}${n(e.latencyMs) ? ` (${n(e.latencyMs)} ms)` : ''}`;
      return entry(at, head, limit(text(e.output), l, c) || undefined);
    }
    case 'usage':
      return renderUsage(e, at);
    case 'note':
      return entry(at, 'note', limit(text(e.text), 3, 300));
    case 'truncated':
      return `${at} recording stopped: ${text(e.reason)}`;
    case 'run_end': {
      const seconds = n(e.durationMs) ? ` · ${Math.round(n(e.durationMs) / 1000)}s` : '';
      const error = text(e.error) ? `\n        ${limit(text(e.error), 3, 300)}` : '';
      return `${at} end · ${text(e.status)}${seconds}${error}`;
    }
    default:
      return `${at} ${e.type}`;
  }
}

/** One event per entry, with time since the first event. Long output is cut unless `full`. */
export function formatTranscript(events: TranscriptEvent[], options: { full?: boolean } = {}): string {
  if (!events.length) return 'This transcript has no events.';
  const startMs = Date.parse(events[0].at);
  return events.map((e) => renderEvent(e, startMs, options.full === true)).join('\n');
}
