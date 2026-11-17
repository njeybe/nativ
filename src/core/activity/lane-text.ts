// Last-action text and changed-file summaries for a lane; pure, used by lanes.ts.
import type { ActivityEvent } from './event-types.js';
import type { ChangedFile } from './git-changes.js';
import type { Lane, LaneFile } from './lanes.js';

const PATH_MAX = 48;

function shortPath(p: string): string {
  return p.length > PATH_MAX ? `...${p.slice(-PATH_MAX)}` : p;
}

function toolText(d: Extract<ActivityEvent, { kind: 'tool' }>['data']): string {
  let text: string;
  if (d.spawn) text = `Agent ${d.spawn.agentType}`;
  else if (d.nativ) text = ['nativ', d.nativ, d.taskId].filter(Boolean).join(' ');
  else if (d.program) text = `${d.name} ${d.program}`;
  else if (d.path) {
    const counts = d.added !== undefined || d.removed !== undefined
      ? ` +${d.added ?? 0} -${d.removed ?? 0}` : '';
    text = `${d.name} ${shortPath(d.path)}${counts}`;
  } else text = d.name;
  return d.ok ? text : `${text} failed`;
}

/** One-line structural summary of an event; null for bookkeeping events. */
export function eventText(e: ActivityEvent): string | null {
  switch (e.kind) {
    case 'tool': return toolText(e.data);
    case 'verify':
      return e.data.pass ? 'verify passed' : `verify failed (${e.data.failedPhase ?? 'unknown'})`;
    case 'task': return `task ${e.data.action}`;
    case 'run': return `run ${e.data.status}`;
    case 'agent': return `agent ${e.data.phase}`;
    case 'violation': return `violation ${e.data.rule}`;
    default: return null;
  }
}

export function lastText(events: ActivityEvent[]): Lane['last'] {
  for (let i = events.length - 1; i >= 0; i--) {
    const text = eventText(events[i]);
    if (text) return { at: events[i].at, text };
  }
  return null;
}

function topFiles(list: LaneFile[]): LaneFile[] {
  return [...list]
    .sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path))
    .slice(0, 3);
}

export function laneFiles(
  events: ActivityEvent[],
  task: { id: string } | null,
  gitFiles?: Record<string, ChangedFile[]>,
): Lane['files'] {
  const git = task && gitFiles ? gitFiles[task.id] : undefined;
  if (git) {
    const list = git.map((f) => ({ path: f.path, added: f.added, removed: f.removed }));
    return { count: list.length, source: 'git', top: topFiles(list) };
  }
  const byPath = new Map<string, LaneFile>();
  for (const e of events) {
    if (e.kind !== 'tool' || !e.data.path) continue;
    const f = byPath.get(e.data.path) ?? { path: e.data.path, added: 0, removed: 0 };
    f.added += e.data.added ?? 0;
    f.removed += e.data.removed ?? 0;
    byPath.set(f.path, f);
  }
  const list = [...byPath.values()];
  return { count: list.length, source: 'events', top: topFiles(list) };
}
