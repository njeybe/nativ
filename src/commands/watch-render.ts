// Pure text rendering for `nativ watch`; no clock, no fs.
import type { ActivityEvent } from '../core/activity/event-types.js';
import { eventText, type Lane } from '../core/activity/lanes.js';

export const EMPTY_MESSAGE =
  'No agent activity yet. Chat agents are recorded after nativ setup; Studio runs always are.';

const COLS = ['LANE', 'TASK', 'STATUS', 'LAST', 'FILES', 'TOKENS', 'TIME'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0 || text.length <= width) return text;
  return width > 3 ? `${text.slice(0, width - 3)}...` : text.slice(0, width);
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad2(s % 60)}s`;
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function renderHeader(laneCount: number, windowMinutes: number, now: number): string {
  return `nativ watch   ${laneCount} lanes   window ${windowMinutes}m   ${clock(now)}`;
}

export function laneRow(lane: Lane): string[] {
  const label = lane.model ? `${lane.label} (${lane.model})` : lane.label;
  return [
    label,
    lane.task?.id ?? '-',
    lane.status,
    lane.last?.text ?? '-',
    String(lane.files.count),
    formatTokens(lane.tokens?.total),
    formatElapsed(lane.elapsedMs),
  ];
}

export function renderTable(lanes: Lane[], width: number): string[] {
  const rows = [COLS, ...lanes.map(laneRow)];
  const widths = COLS.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => truncate(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd(), width));
}

export function eventLine(e: ActivityEvent, lanes: Lane[]): string | null {
  const text = eventText(e);
  if (text === null) return null;
  const label = lanes.find((l) => l.id === e.lane.id)?.label ?? e.lane.role ?? '-';
  return `${clock(Date.parse(e.at))}  ${label}  ${e.task?.id ?? '-'}  ${text}`;
}

export function recentEventLines(events: ActivityEvent[], lanes: Lane[], count = 10): string[] {
  const lines: string[] = [];
  for (const e of events) {
    const line = eventLine(e, lanes);
    if (line !== null) lines.push(line);
  }
  return lines.slice(-count);
}

export function renderScreen(
  lanes: Lane[],
  events: ActivityEvent[],
  opts: { width: number; windowMinutes: number; now: number },
): string {
  const head = renderHeader(lanes.length, opts.windowMinutes, opts.now);
  if (events.length === 0) return [truncate(head, opts.width), '', truncate(EMPTY_MESSAGE, opts.width)].join('\n');
  const recent = recentEventLines(events, lanes).map((l) => truncate(l, opts.width));
  return [truncate(head, opts.width), '', ...renderTable(lanes, opts.width), '', ...recent].join('\n');
}

// Keep lanes whose folded task matches, and events on those lanes or tagged with the task.
export function filterByTask(
  lanes: Lane[],
  events: ActivityEvent[],
  taskId: string | undefined,
): { lanes: Lane[]; events: ActivityEvent[] } {
  if (!taskId) return { lanes, events };
  const kept = lanes.filter((l) => l.task?.id === taskId);
  const ids = new Set(kept.map((l) => l.id));
  return { lanes: kept, events: events.filter((e) => ids.has(e.lane.id) || e.task?.id === taskId) };
}

export interface PollState { cursor: string | null; events: ActivityEvent[] }

// Append new events; on a read error keep the cursor so the next call retries.
export function pollStep(
  read: (cursor: string | null) => { events: ActivityEvent[]; cursor: string | null },
  state: PollState,
): ActivityEvent[] {
  try {
    const r = read(state.cursor);
    state.cursor = r.cursor;
    state.events.push(...r.events);
    return r.events;
  } catch {
    return [];
  }
}
