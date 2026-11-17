import path from 'node:path';
import type { ActivityEvent } from '../core/activity/event-types.js';
import { readEvents, pruneEvents } from '../core/activity/event-log.js';
import { foldLanes, type Lane } from '../core/activity/lanes.js';
import { taskChanges, type ChangedFile } from '../core/activity/git-changes.js';
import { loadPlan } from '../core/lock-manager.js';
import type { MasterPlan } from '../scanner/types.js';
import { EMPTY_MESSAGE, eventLine, filterByTask, pollStep, renderScreen } from './watch-render.js';

export interface WatchOptions {
  plain?: boolean;
  json?: boolean;
  task?: string;
  window?: string | number;
}

const TICK_MS = 1000;
const GIT_MS = 5000;
const PLAN_MS = 5000;
const PRUNE_MS = 60 * 60 * 1000;

export function parseWindow(value: string | number | undefined): number {
  if (value === undefined) return 30;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    throw new Error(`--window must be a whole number of minutes from 1 to 1440 (got "${value}")`);
  }
  return n;
}

function quietPrune(root: string): void {
  try { pruneEvents(root); } catch { /* retried next hour */ }
}

export async function runWatch(targetDirArg?: string, options: WatchOptions = {}): Promise<void> {
  const root = path.resolve(targetDirArg || process.cwd());
  let windowMinutes: number;
  try {
    windowMinutes = parseWindow(options.window);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  const loadFresh = (): MasterPlan | null =>
    loadPlan(path.join(root, '.ai', 'master_plan.json'), { silent: true });
  let plan = loadFresh() ?? ({ milestones: [] } as unknown as MasterPlan);
  let planAt = Date.now();
  const currentPlan = (): MasterPlan => {
    if (Date.now() - planAt >= PLAN_MS) {
      planAt = Date.now();
      try { plan = loadFresh() ?? plan; } catch { /* keep the last good plan */ }
    }
    return plan;
  };
  const tty = !!process.stdout.isTTY && !options.plain && !options.json;
  const state = { cursor: null as string | null, events: [] as ActivityEvent[] };
  const git: Record<string, ChangedFile[]> = {};
  let printed = 0;
  let gitBusy = false;

  const allLanes = (): Lane[] =>
    foldLanes(state.events, currentPlan(), Date.now(), { windowMinutes, gitFiles: git });
  const view = () => filterByTask(allLanes(), state.events, options.task);
  const poll = (): ActivityEvent[] => {
    const fresh = pollStep((c) => readEvents(root, c), state);
    return filterByTask(allLanes(), fresh, options.task).events;
  };
  const refreshGit = async (): Promise<void> => {
    if (gitBusy) return;
    gitBusy = true;
    try {
      const ids = new Set(allLanes().flatMap((l) => (l.task ? [l.task.id] : [])));
      for (const id of ids) {
        try { git[id] = (await taskChanges(root, id)).files; } catch { delete git[id]; }
      }
    } finally { gitBusy = false; }
  };

  const draw = (): void => {
    const width = process.stdout.columns || 80;
    const v = view();
    const screen = renderScreen(v.lanes, v.events, { width, windowMinutes, now: Date.now() });
    process.stdout.write(`\x1b[H\x1b[2J${screen}\n`);
  };
  const emit = (fresh: ActivityEvent[]): void => {
    if (options.json) {
      for (const e of fresh) console.log(JSON.stringify(e));
      return;
    }
    const { lanes } = view();
    for (const e of fresh) {
      const line = eventLine(e, lanes);
      if (line !== null) console.log(line);
    }
  };

  quietPrune(root);
  const first = poll();
  if (tty) process.stdout.write('\x1b[?25l');
  else if (state.events.length === 0 && !options.json) console.log(EMPTY_MESSAGE);
  else emit(first.slice(-10));
  printed = state.events.length;
  await refreshGit();
  if (tty) draw();

  const timers = [
    setInterval(() => {
      const fresh = poll();
      if (tty) draw();
      else if (state.events.length > printed) { emit(fresh); printed = state.events.length; }
    }, TICK_MS),
    setInterval(() => { void refreshGit(); }, GIT_MS),
    setInterval(() => quietPrune(root), PRUNE_MS),
  ];
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      timers.forEach(clearInterval);
      if (tty) process.stdout.write('\x1b[?25h\n');
      resolve();
    });
  });
  process.exit(0);
}
