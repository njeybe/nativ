// Folds activity events into lanes; see .ai/design/studio-activity.md#lane-fold. Pure: no fs, no clock.
import type { ActivityEvent, TokenCounts } from './event-types.js';
import type { ChangedFile } from './git-changes.js';
import type { MasterPlan, MasterPlanTask } from '../../scanner/types.js';
import { matchesTarget } from '../enforcement.js';
import { laneFiles, lastText } from './lane-text.js';

export { eventText } from './lane-text.js';

export type LaneKind = 'main' | 'subagent' | 'runner' | 'cli';
export type LaneStatus = 'active' | 'idle' | 'stopped' | 'failed' | 'paused';
export type LaneTaskVia = 'worktree' | 'env' | 'command' | 'only' | 'scope';

export interface LaneFile { path: string; added: number; removed: number }

export interface Lane {
  id: string;
  label: string;
  kind: LaneKind;
  role: string | null;
  model: string | null;
  status: LaneStatus;
  startedAt: string;
  lastAt: string;
  elapsedMs: number;
  task: { id: string; title: string | null; via: LaneTaskVia } | null;
  last: { at: string; text: string } | null;
  files: { count: number; source: 'git' | 'events'; top: LaneFile[] };
  tokens: (TokenCounts & { total: number }) | null;
  runId: string | null;
  sessionId: string | null;
}

export interface FoldOptions {
  windowMinutes: number;
  /** Git changes keyed by task id, used for lanes that hold that task. */
  gitFiles?: Record<string, ChangedFile[]>;
}

const ACTIVE_MS = 2 * 60 * 1000;
const ACTIVE_RUN = ['spawning_worktree', 'running', 'verifying', 'merging'];

interface Group {
  id: string;
  kind: LaneKind;
  events: ActivityEvent[];
  task: { id: string; via: LaneTaskVia } | null;
}

function laneKind(id: string): LaneKind {
  if (id.startsWith('run:')) return 'runner';
  if (id.startsWith('cli:')) return 'cli';
  return id.includes('/') ? 'subagent' : 'main';
}

function ms(at: string): number {
  return Date.parse(at);
}

function groupEvents(events: ActivityEvent[]): Group[] {
  const sorted = [...events].sort((a, b) => ms(a.at) - ms(b.at));
  const map = new Map<string, Group>();
  for (const e of sorted) {
    let g = map.get(e.lane.id);
    if (!g) {
      g = { id: e.lane.id, kind: laneKind(e.lane.id), events: [], task: null };
      map.set(e.lane.id, g);
    }
    g.events.push(e);
  }
  return [...map.values()];
}

function planTasks(plan: MasterPlan): MasterPlanTask[] {
  return plan.milestones.flatMap((m) => m.tasks ?? []);
}

function ownTask(events: ActivityEvent[]): Group['task'] {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].task;
    if (t) return { id: t.id, via: t.via };
  }
  return null;
}

function latestRole(g: Group): string | null {
  for (let i = g.events.length - 1; i >= 0; i--) {
    const r = g.events[i].lane.role ?? g.events[i].lane.agentType;
    if (r) return r;
  }
  return null;
}

// Rule 2: cli task/verify events move to the one non-cli lane holding their task.
function joinCliEvents(groups: Group[]): Group[] {
  const others = groups.filter((g) => g.kind !== 'cli');
  for (const cli of groups.filter((g) => g.kind === 'cli')) {
    const keep: ActivityEvent[] = [];
    for (const e of cli.events) {
      const holders = e.task && (e.kind === 'task' || e.kind === 'verify')
        ? others.filter((g) => g.task?.id === e.task!.id) : [];
      if (holders.length === 1) holders[0].events.push(e);
      else keep.push(e);
    }
    cli.events = keep;
    cli.task = ownTask(keep);
  }
  for (const g of others) g.events.sort((a, b) => ms(a.at) - ms(b.at));
  return groups.filter((g) => g.events.length > 0);
}

function scopeTask(g: Group, active: MasterPlanTask[]): string | null {
  const found = new Set<string>();
  for (const e of g.events) {
    if (e.kind !== 'tool' || !e.data.path || e.data.outside) continue;
    const path = e.data.path;
    const hits = active.filter((t) => t.targetFiles.some((tf) => matchesTarget(path, tf)));
    if (hits.length === 1) found.add(hits[0].id);
    else if (hits.length > 1) return null;
  }
  return found.size === 1 ? [...found][0] : null;
}

function attribute(groups: Group[], plan: MasterPlan): Group[] {
  for (const g of groups) g.task = ownTask(g.events);
  const joined = joinCliEvents(groups);
  const active = planTasks(plan).filter((t) => t.status === 'in_progress');
  for (const g of joined) {
    if (g.task) continue;
    if (latestRole(g) === 'worker' && active.length === 1) {
      g.task = { id: active[0].id, via: 'only' };
      continue;
    }
    const id = scopeTask(g, active);
    if (id) g.task = { id, via: 'scope' };
  }
  return joined;
}

function runStatus(events: ActivityEvent[]): string | null {
  let status: string | null = null;
  for (const e of events) if (e.kind === 'run') status = e.data.status;
  return status;
}

function laneStatus(g: Group, now: number): LaneStatus {
  const run = runStatus(g.events);
  if (run === 'failed') return 'failed';
  const stopped = g.events.some((e) => e.kind === 'agent' && e.data.phase === 'stop');
  if (stopped || run === 'completed' || run === 'aborted') return 'stopped';
  const last = ms(g.events[g.events.length - 1].at);
  if (now - last < ACTIVE_MS || (run !== null && ACTIVE_RUN.includes(run))) return 'active';
  return 'idle';
}

function withTotal(t: TokenCounts): TokenCounts & { total: number } {
  const total = t.input + t.output + t.cacheRead + t.cacheCreation;
  return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation, total };
}

function laneTokens(g: Group): Lane['tokens'] {
  if (g.kind === 'runner') {
    const usage = g.events.filter((e) => e.kind === 'usage');
    if (usage.length === 0) return null;
    const sum: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const e of usage) {
      if (e.kind !== 'usage') continue;
      sum.input += e.data.input;
      sum.output += e.data.output;
      sum.cacheRead += e.data.cacheRead;
      sum.cacheCreation += e.data.cacheCreation;
    }
    return withTotal(sum);
  }
  if (g.kind !== 'subagent') return null;
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.kind === 'agent' && e.data.phase === 'stop' && e.data.tokens) return withTotal(e.data.tokens);
  }
  return null;
}

function ownModel(g: Group): string | null {
  for (let i = g.events.length - 1; i >= 0; i--) {
    const e = g.events[i];
    if (e.lane.model) return e.lane.model;
    if (e.kind === 'run' && e.data.model) return e.data.model;
    if (e.kind === 'usage' && e.data.model) return e.data.model;
  }
  return null;
}

// Pairs spawns and subagent starts in order per session and agent type.
function spawnModels(groups: Group[]): Map<string, string | null> {
  const spawns = new Map<string, (string | null)[]>();
  const starts: { key: string; lane: string; at: number }[] = [];
  for (const g of groups) {
    for (const e of g.events) {
      const session = e.lane.session ?? null;
      if (e.kind === 'tool' && e.data.spawn && session) {
        const key = `${session}|${e.data.spawn.agentType}`;
        spawns.set(key, [...(spawns.get(key) ?? []), e.data.spawn.model ?? null]);
      }
      if (g.kind === 'subagent' && e.kind === 'agent' && e.data.phase === 'start' && session) {
        starts.push({ key: `${session}|${e.lane.agentType ?? ''}`, lane: g.id, at: ms(e.at) });
      }
    }
  }
  const out = new Map<string, string | null>();
  for (const s of starts.sort((a, b) => a.at - b.at)) {
    const queue = spawns.get(s.key);
    if (!queue || queue.length === 0 || out.has(s.lane)) continue;
    out.set(s.lane, queue.shift() ?? null);
  }
  return out;
}

function laneLabel(g: Group): string {
  if (g.kind === 'runner') return 'runner';
  if (g.kind === 'main') return 'main session';
  if (g.kind === 'cli') return 'terminal';
  return latestRole(g) ?? 'subagent';
}

function firstOf<T>(events: ActivityEvent[], pick: (e: ActivityEvent) => T | undefined): T | null {
  for (const e of events) {
    const v = pick(e);
    if (v !== undefined) return v;
  }
  return null;
}

function buildLane(g: Group, ctx: { now: number; titles: Map<string, string>; models: Map<string, string | null>;
  gitFiles?: Record<string, ChangedFile[]> }): Lane {
  const first = g.events[0];
  const last = g.events[g.events.length - 1];
  const status = laneStatus(g, ctx.now);
  const end = status === 'active' ? ctx.now : ms(last.at);
  const runId = firstOf(g.events, (e) => e.lane.runId ?? (e.kind === 'run' ? e.data.runId : undefined));
  return {
    id: g.id,
    label: laneLabel(g),
    kind: g.kind,
    role: g.kind === 'cli' ? null : latestRole(g),
    model: ownModel(g) ?? ctx.models.get(g.id) ?? null,
    status,
    startedAt: first.at,
    lastAt: last.at,
    elapsedMs: Math.max(0, end - ms(first.at)),
    task: g.task ? { ...g.task, title: ctx.titles.get(g.task.id) ?? null } : null,
    last: lastText(g.events),
    files: laneFiles(g.events, g.task, ctx.gitFiles),
    tokens: laneTokens(g),
    runId,
    sessionId: firstOf(g.events, (e) => e.lane.session),
  };
}

function hasActiveRun(g: Group): boolean {
  const run = runStatus(g.events);
  return run !== null && ACTIVE_RUN.includes(run);
}

/** Lanes in the window plus every active run; active first, then newest lastAt. */
export function foldLanes(events: ActivityEvent[], plan: MasterPlan, now: number, opts: FoldOptions): Lane[] {
  const groups = attribute(groupEvents(events), plan);
  const titles = new Map(planTasks(plan).map((t) => [t.id, t.title]));
  const models = spawnModels(groups);
  const since = now - opts.windowMinutes * 60 * 1000;
  const kept = groups.filter((g) => hasActiveRun(g) || ms(g.events[g.events.length - 1].at) >= since);
  const lanes = kept.map((g) => buildLane(g, { now, titles, models, gitFiles: opts.gitFiles }));
  return lanes.sort((a, b) => {
    const act = Number(b.status === 'active') - Number(a.status === 'active');
    return act || ms(b.lastAt) - ms(a.lastAt);
  });
}
