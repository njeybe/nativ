import fs from 'node:fs';
import path from 'node:path';
import { resolveMainRoot } from '../root-resolver.js';
import { EVENT_LOG_VERSION, type ActivityEvent, type EventKind } from './event-types.js';

export const MAX_LINE_BYTES = 2048;
export const PART_MAX_BYTES = 8 * 1024 * 1024;
export const RETAIN_DAYS = 14;
export const RETAIN_MAX_BYTES = 100 * 1024 * 1024;

const SEGMENT_RE = /^events-(\d{4}-\d{2}-\d{2})-(\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Data fields a kind cannot lose; anything else may be dropped to fit a line.
const REQUIRED_DATA: Record<EventKind, string[]> = {
  tool: ['name', 'ok'],
  agent: ['phase'],
  run: ['runId', 'status', 'engine'],
  task: ['action'],
  verify: ['pass', 'durationMs'],
  violation: ['rule', 'mode', 'tool', 'path'],
  usage: ['model', 'turns', 'input', 'output', 'cacheRead', 'cacheCreation'],
};

export function eventsDir(root: string): string {
  return path.join(resolveMainRoot(root), '.nativ', 'events');
}

export function segmentName(date: Date, part: number): string {
  return `events-${date.toISOString().slice(0, 10)}-${String(part).padStart(2, '0')}.jsonl`;
}

export function listSegments(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => SEGMENT_RE.test(n)).sort();
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Highest part of today's date, or the next one once it reaches the part cap.
export function currentSegment(dir: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const today = listSegments(dir).filter((n) => n.startsWith(`events-${day}-`));
  if (today.length === 0) return segmentName(now, 0);
  const last = today[today.length - 1];
  const part = Number(SEGMENT_RE.exec(last)![2]);
  return fileSize(path.join(dir, last)) >= PART_MAX_BYTES ? segmentName(now, part + 1) : last;
}

// Drops optional data fields (paths last) until the line fits, else returns null.
export function fitLine(event: ActivityEvent): string | null {
  let line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const data: Record<string, unknown> = { ...(event.data as object) };
  const required = REQUIRED_DATA[event.kind] ?? [];
  const optional = Object.keys(data).filter((k) => !required.includes(k));
  optional.sort((a, b) => Number(a === 'path') - Number(b === 'path'));
  for (const key of optional) {
    delete data[key];
    line = `${JSON.stringify({ ...event, data })}\n`;
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  }
  return null;
}

/** Appends one event line to the main root's log; never throws. */
export function appendEvent(root: string, event: ActivityEvent): boolean {
  try {
    const main = resolveMainRoot(root);
    const hasState = ['.ai', '.nativ'].some((d) => fs.existsSync(path.join(main, d)));
    if (!hasState) return false;
    const line = fitLine(event);
    if (line === null) return false;
    const dir = path.join(main, '.nativ', 'events');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, currentSegment(dir)), line);
    return true;
  } catch {
    return false;
  }
}

export interface PruneOptions {
  beforeDelete?: (file: string) => void;
}

/** Deletes whole oldest segments beyond 14 days or 100 MB; returns deleted names. */
export function pruneEvents(root: string, options: PruneOptions = {}): string[] {
  const deleted: string[] = [];
  try {
    const dir = eventsDir(root);
    const cutoff = Date.now() - RETAIN_DAYS * DAY_MS;
    let total = 0;
    for (const name of listSegments(dir).reverse()) {
      const file = path.join(dir, name);
      total += fileSize(file);
      const day = Date.parse(`${SEGMENT_RE.exec(name)![1]}T00:00:00Z`);
      if (day + DAY_MS > cutoff && total <= RETAIN_MAX_BYTES) continue;
      if (tryDelete(file, options.beforeDelete)) deleted.push(name);
    }
  } catch {
    // A failed prune is retried on the next run.
  }
  return deleted;
}

function tryDelete(file: string, beforeDelete?: (file: string) => void): boolean {
  try {
    beforeDelete?.(file);
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export interface ReadResult {
  events: ActivityEvent[];
  cursor: string | null;
}

function parseCursor(cursor: string | null | undefined): { name: string; offset: number } | null {
  if (!cursor) return null;
  const idx = cursor.lastIndexOf(':');
  if (idx === -1) return null;
  const offset = Number(cursor.slice(idx + 1));
  return { name: cursor.slice(0, idx), offset: Number.isFinite(offset) ? offset : 0 };
}

function parseLine(text: string): ActivityEvent | null {
  try {
    const ev = JSON.parse(text);
    if (!ev || typeof ev !== 'object' || typeof ev.v !== 'number') return null;
    return ev.v > EVENT_LOG_VERSION ? null : (ev as ActivityEvent);
  } catch {
    return null;
  }
}

function readFrom(file: string, offset: number): { lines: string[]; consumed: number } {
  const size = fileSize(file);
  if (size <= offset) return { lines: [], consumed: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a);
    if (end === -1) return { lines: [], consumed: 0 };
    return { lines: buf.subarray(0, end).toString('utf8').split('\n'), consumed: end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads complete lines after `cursor` (`<file name>:<byte offset>`) across parts. */
export function readEvents(root: string, cursor?: string | null): ReadResult {
  const dir = eventsDir(root);
  const names = listSegments(dir);
  const start = parseCursor(cursor);
  const events: ActivityEvent[] = [];
  let next: string | null = cursor ?? null;
  const todo = start ? names.filter((n) => n >= start.name) : names;
  todo.forEach((name, i) => {
    const offset = start && name === start.name ? start.offset : 0;
    const { lines, consumed } = readFrom(path.join(dir, name), offset);
    for (const text of lines) {
      const ev = parseLine(text);
      if (ev) events.push(ev);
    }
    // An older part is finished; a newer part takes over the cursor.
    if (i < todo.length - 1) return;
    next = `${name}:${offset + consumed}`;
  });
  return { events, cursor: next };
}
