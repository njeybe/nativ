import fs from 'node:fs';
import { eventsDir, pruneEvents, readEvents } from '../core/activity/event-log.js';
import type { ActivityEvent } from '../core/activity/event-types.js';
import { foldLanes, type Lane } from '../core/activity/lanes.js';
import type { MasterPlan } from '../scanner/types.js';
import { readPlan } from './plan-utils.js';

export const FEED_MAX_EVENTS = 20_000;
export const FEED_DEBOUNCE_MS = 250;
export const FEED_POLL_MS = 1000;
export const FEED_PRUNE_MS = 60 * 60 * 1000;
const KEEP_MS = 24 * 60 * 60 * 1000;

export interface ActivitySnapshotOptions {
  windowMinutes?: number;
  limit?: number;
  since?: string | null;
}

export interface ActivitySnapshot {
  ok: true;
  cursor: string | null;
  windowMinutes: number;
  lanes: Lane[];
  events: ActivityEvent[];
  truncated: boolean;
}

interface Held {
  ev: ActivityEvent;
  end: { name: string; offset: number };
}

function parseCursor(cursor: string | null | undefined): { name: string; offset: number } | null {
  const idx = cursor ? cursor.lastIndexOf(':') : -1;
  if (!cursor || idx === -1) return null;
  const offset = Number(cursor.slice(idx + 1));
  return Number.isFinite(offset) ? { name: cursor.slice(0, idx), offset } : null;
}

// Segment names sort by date then part, so a plain string compare orders positions.
function isAfter(a: { name: string; offset: number }, b: { name: string; offset: number }): boolean {
  return a.name === b.name ? a.offset > b.offset : a.name > b.name;
}

/** In-memory view of the last 24 hours of the event log, kept fresh by a watcher plus polling. */
export class ActivityFeed {
  private held: Held[] = [];
  private cursor: string | null;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private pendingCount = 0;
  private closed = false;

  constructor(private readonly root: string, private readonly onChange: (count: number) => void) {
    pruneEvents(root);
    const day = new Date(Date.now() - KEEP_MS).toISOString().slice(0, 10);
    this.cursor = `events-${day}-00.jsonl:0`;
    this.readNew(false);
    this.attachWatcher();
    this.pollTimer = setInterval(() => this.tick(), FEED_POLL_MS);
    this.pruneTimer = setInterval(() => this.prune(), FEED_PRUNE_MS);
    this.pollTimer.unref();
    this.pruneTimer.unref();
  }

  /** Builds the GET /api/pipeline/activity body from the held events. */
  snapshot(options: ActivitySnapshotOptions = {}): ActivitySnapshot {
    const windowMinutes = options.windowMinutes ?? 30;
    const limit = options.limit ?? 50;
    const since = parseCursor(options.since);
    const matched = since ? this.held.filter((h) => isAfter(h.end, since)) : this.held;
    const plan = readPlan(this.root) ?? ({ milestones: [] } as unknown as MasterPlan);
    const lanes = foldLanes(this.held.map((h) => h.ev), plan, Date.now(), { windowMinutes });
    return {
      ok: true,
      cursor: this.held.length ? this.cursor : null,
      windowMinutes,
      lanes,
      events: matched.slice(-limit).map((h) => h.ev),
      truncated: matched.length > limit,
    };
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    for (const t of [this.pollTimer, this.pruneTimer, this.debounce]) {
      if (t) clearTimeout(t);
    }
    this.pollTimer = this.pruneTimer = this.debounce = null;
  }

  private attachWatcher(): void {
    if (this.watcher || this.closed) return;
    try {
      this.watcher = fs.watch(eventsDir(this.root), { persistent: false }, () => this.readNew(true));
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // The directory does not exist yet; the poll tick attaches once it does.
    }
  }

  private tick(): void {
    this.attachWatcher();
    this.readNew(true);
  }

  // Reads only bytes after the cursor; a torn last line stays unread until it is complete.
  private readNew(notify: boolean): void {
    if (this.closed) return;
    let result;
    try {
      result = readEvents(this.root, this.cursor);
    } catch {
      return;
    }
    this.cursor = result.cursor;
    const end = parseCursor(result.cursor);
    const floor = Date.now() - KEEP_MS;
    const fresh = result.events.filter((e) => Date.parse(e.at) >= floor);
    if (!end || fresh.length === 0) return;
    for (const ev of fresh) this.held.push({ ev, end });
    if (this.held.length > FEED_MAX_EVENTS) this.held.splice(0, this.held.length - FEED_MAX_EVENTS);
    if (notify) this.schedule(fresh.length);
  }

  private schedule(count: number): void {
    this.pendingCount += count;
    this.debounce ??= setTimeout(() => {
      const total = this.pendingCount;
      this.debounce = null;
      this.pendingCount = 0;
      try {
        this.onChange(total);
      } catch {
        // A failing consumer must not stop the feed.
      }
    }, FEED_DEBOUNCE_MS);
  }

  private prune(): void {
    const floor = Date.now() - KEEP_MS;
    this.held = this.held.filter((h) => Date.parse(h.ev.at) >= floor);
    pruneEvents(this.root);
  }
}
