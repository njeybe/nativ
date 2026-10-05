import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { sendPipelineError } from './http-utils.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;
export const EVENT_DEBOUNCE_MS = 100;
export const WATCH_POLL_INTERVAL_MS = 1000;

export type PipelineEventName = 'plan_change' | 'telemetry_change';

/** Files in .ai/ that drive /api/events, mapped to the event a change emits. Anything else (tmp/lock files) is ignored. */
export const WATCHED_FILES = new Map<string, PipelineEventName>([
  ['master_plan.json', 'plan_change'],
  ['escalation.json', 'plan_change'],
  ['.governor_ledger.json', 'plan_change'],
  ['context.md', 'plan_change'],
  ['db_schema.json', 'plan_change'],
  ['api_contracts.json', 'plan_change'],
  ['ui_specs.md', 'plan_change'],
  ['telemetry.json', 'telemetry_change'],
  ['benchmark_report.json', 'telemetry_change'],
]);

/**
 * Fan-out for GET /api/events. Watches .ai/ only while a client is connected, coalesces write bursts
 * (tmp file + atomic rename + lock files) into one event per type, and sends heartbeats so idle
 * streams survive proxies and sleep/wake.
 *
 * Frames: `event: plan_change` / `event: telemetry_change` with `data: {"files":[...],"at":"<ISO>"}`,
 * and `event: heartbeat` with `data: {"at":"<ISO>"}`.
 */
export class PipelineEventHub {
  private readonly clients = new Set<http.ServerResponse>();
  private readonly pending = new Map<PipelineEventName, Set<string>>();
  private watcher: fs.FSWatcher | null = null;
  private pollers: Array<{ file: string; listener: (curr: fs.Stats, prev: fs.Stats) => void }> = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly aiDir: string,
    private readonly heartbeatMs: number,
    private readonly onFileChange?: (file: string) => void,
  ) {
    this.startWatcher();
  }

  subscribe(res: http.ServerResponse): void {
    if (this.closed) {
      sendPipelineError(res, 503, 'SHUTTING_DOWN', 'Studio server is shutting down');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.socket?.setNoDelay(true);
    // Reconnect delay for EventSource; the comment line flushes the headers right away.
    res.write('retry: 3000\n: connected\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    });
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.broadcast('heartbeat', { at: new Date().toISOString() }), this.heartbeatMs);
      this.heartbeat.unref();
    }
    this.startWatcher();
  }

  /** Pushes an agent-supervisor event (`runner_status`, `runner_log`, `runner_token_usage`) to every connected client. */
  publish(event: 'runner_status' | 'runner_log' | 'runner_token_usage', data: unknown): void {
    if (this.closed || this.clients.size === 0) return;
    this.broadcast(event, data);
  }

  publishPlanChange(files: string[] = ['escalation.json']): void {
    if (this.closed || this.clients.size === 0) return;
    this.broadcast('plan_change', { files, at: new Date().toISOString() });
  }

  /** SSE responses never finish on their own; drop them so http.Server#close() can complete. */
  close(): void {
    this.closed = true;
    for (const res of this.clients) res.destroy();
    this.clients.clear();
    this.stop();
  }

  private start(): void {
    this.startWatcher();
  }

  private startWatcher(): void {
    if (this.watcher || this.pollers.length) return;
    try {
      this.watcher = fs.watch(this.aiDir, { persistent: false }, (_event, filename) => {
        if (filename) this.queue(String(filename));
      });
      this.watcher.on('error', () => {
        this.closeWatcher();
        this.startPolling();
      });
    } catch {
      // .ai/ is missing (studio started before `nativ init`) or not watchable: poll the files instead.
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollers.length) return;
    for (const file of WATCHED_FILES.keys()) {
      // Missing files report zeroed stats, so an unchanged mtime means nothing happened.
      const listener = (curr: fs.Stats, prev: fs.Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs) this.queue(file);
      };
      fs.watchFile(path.join(this.aiDir, file), { interval: WATCH_POLL_INTERVAL_MS, persistent: false }, listener);
      this.pollers.push({ file, listener });
    }
  }

  private stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.heartbeat = this.flushTimer = null;
    this.pending.clear();
    this.closeWatcher();
    for (const { file, listener } of this.pollers) fs.unwatchFile(path.join(this.aiDir, file), listener);
    this.pollers = [];
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private queue(file: string): void {
    try {
      this.onFileChange?.(file);
    } catch {
      // Ignore consumer callback error
    }
    const event = WATCHED_FILES.get(file);
    if (!event) return;
    const files = this.pending.get(event) ?? new Set<string>();
    files.add(file);
    this.pending.set(event, files);
    this.flushTimer ??= setTimeout(() => this.flush(), EVENT_DEBOUNCE_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const at = new Date().toISOString();
    for (const [event, files] of this.pending) this.broadcast(event, { files: [...files], at });
    this.pending.clear();
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }
}
