import pc from 'picocolors';
import { resolveProjectRoot } from '../core/root-resolver.js';
import {
  findTranscript,
  formatTranscript,
  listTranscripts,
  readTranscript,
  type TranscriptSummary,
} from '../runner/transcript-view.js';

const DEFAULT_LIMIT = 20;

function fail(message: string): void {
  console.error(pc.red(`✖ ${message}`));
  process.exitCode = 1;
}

const when = (iso: string | null): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '-');
const took = (ms: number | null): string => (ms === null ? '-' : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

function row(s: TranscriptSummary): string[] {
  return [
    s.runId.slice(0, 8),
    s.taskId ?? '-',
    s.engine ?? '-',
    s.model ?? '-',
    s.status ?? 'unfinished',
    when(s.startedAt),
    took(s.durationMs),
    s.costUsd === null ? '-' : `$${s.costUsd.toFixed(4)}`,
  ];
}

/** `nativ runs list`: recorded runs, newest first. */
export function runRunsList(
  targetDirArg?: string,
  options: { task?: string; limit?: number; json?: boolean } = {},
): void {
  const root = resolveProjectRoot(targetDirArg);
  const runs = listTranscripts(root, { task: options.task, limit: options.limit ?? DEFAULT_LIMIT });
  if (options.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (!runs.length) {
    console.log(pc.dim('\nNo recorded runs. A run is recorded when an agent is dispatched from Studio.\n'));
    return;
  }
  const head = ['RUN', 'TASK', 'ENGINE', 'MODEL', 'STATUS', 'STARTED (UTC)', 'TIME', 'COST'];
  const rows = runs.map(row);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => `  ${cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()}`;
  console.log('');
  console.log(pc.dim(line(head)));
  for (const r of rows) console.log(line(r));
  console.log(pc.dim('\n  nativ runs show <run> replays one. A task id shows that task\'s latest run.\n'));
}

/** `nativ runs show`: replay one recorded run. */
export function runRunsShow(
  id: string,
  targetDirArg?: string,
  options: { json?: boolean; full?: boolean } = {},
): void {
  const root = resolveProjectRoot(targetDirArg);
  const found = findTranscript(root, id);
  if ('error' in found) {
    fail(found.error);
    return;
  }
  let data;
  try {
    data = readTranscript(found.summary.file);
  } catch (err) {
    fail(`Could not read the transcript: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (options.json) {
    console.log(JSON.stringify({ summary: found.summary, skipped: data.skipped, events: data.events }, null, 2));
    return;
  }
  console.log(`\nRun ${found.summary.runId}\n`);
  console.log(formatTranscript(data.events, { full: options.full }));
  if (data.skipped) console.log(pc.yellow(`\n${data.skipped} unreadable line(s) were skipped.`));
  console.log('');
}
