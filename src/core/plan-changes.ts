import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync, withPlanLockSync, writeJsonAtomicSync } from './lock-manager.js';
import { parseJsonLoose } from './enforcement.js';
import { HIDDEN_AND_NEWLINE } from './learnings.js';
import { resolvePerson } from './identity.js';
import { isSettled, settleMilestone } from './plan-status.js';
import { checkPlanChange, indexPlan } from './plan-change-checks.js';
import { CircuitBreaker } from '../governor/circuit-breaker.js';
import { closeEscalationsForTask } from '../governor/store.js';
import type { MasterPlan, MasterPlanTask } from '../scanner/types.js';

/** nativ · Proposed plan changes in `.ai/plan_changes.json`; only a human decides them.
 * Approval re-checks the live plan under the plan lock before applying. */

export { checkPlanChange };

export const PLAN_CHANGE_STATUSES = ['proposed', 'approved', 'rejected'] as const;
export type PlanChangeStatus = (typeof PLAN_CHANGE_STATUSES)[number];
export type PlanChangeDecision = Exclude<PlanChangeStatus, 'proposed'>;

export interface PlanChangeBody {
  addDependencies?: string[];
  removeDependencies?: string[];
  notes?: string;
  release?: true;
  drop?: { reason: string; replacedBy?: string };
}

export type PlanChangeRefusalCode =
  | 'CHANGE_NOT_FOUND' | 'CHANGE_ALREADY_DECIDED' | 'CHANGE_EDITED'
  | 'CHANGE_REFUSED' | 'PLAN_CHANGES_UNREADABLE' | 'PLAN_UNREADABLE';

/** Why a propose or decide did nothing; the code is stable, the message is for people. */
export interface PlanChangeRefusal { code: PlanChangeRefusalCode; message: string }

const refuse = (code: PlanChangeRefusalCode, message: string): PlanChangeRefusal => ({ code, message });

export const isRefusal = (v: unknown): v is PlanChangeRefusal =>
  !!v && typeof v === 'object' && 'code' in v && 'message' in v;

export interface Rewire { taskId: string; from: string; to: string }

export interface PlanChange {
  id: string;
  status: PlanChangeStatus;
  taskId: string;
  change: PlanChangeBody;
  reason: string;
  fromTask?: string;
  proposedBy?: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decidedVia?: 'cli' | 'studio';
  decisionNote?: string;
  effects?: { rewired: Rewire[] };
}

export interface ProposePlanChangeInput {
  taskId: string;
  addDependencies?: string[];
  removeDependencies?: string[];
  notes?: string;
  release?: boolean;
  drop?: { reason?: string; replacedBy?: string };
  reason: string;
  fromTask?: string;
  by?: string;
}

const MAX_REASON = 500;
const MAX_NOTES = 2000;
const MAX_ID = 64;
const MAX_PENDING = 50;
export function planChangesPath(root: string): string {
  return path.join(root, '.ai', 'plan_changes.json');
}

const planPath = (root: string): string => path.join(root, '.ai', 'master_plan.json');

// Hidden characters become a space; notes keep newlines and drop other hidden ones.
function hiddenReplacement(c: string, keepNewlines: boolean): string {
  if (!keepNewlines) return ' ';
  return c === '\n' ? c : '';
}

function clean(text: string | undefined, max: number, keepNewlines = false): string | undefined {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(HIDDEN_AND_NEWLINE, (c) => hiddenReplacement(c, keepNewlines)).trim();
  return t ? t.slice(0, max) : undefined;
}

const isIds = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

function isPlanChange(r: unknown): r is PlanChange {
  if (!r || typeof r !== 'object') return false;
  const c = r as PlanChange;
  if (typeof c.id !== 'string' || typeof c.taskId !== 'string' || typeof c.reason !== 'string') return false;
  if (!(PLAN_CHANGE_STATUSES as readonly string[]).includes(c.status)) return false;
  const b = c.change;
  if (!b || typeof b !== 'object' || !isIds(b.addDependencies) || !isIds(b.removeDependencies)) return false;
  return !b.drop || typeof b.drop.reason === 'string';
}

interface RawFile { doc: Record<string, unknown>; records: unknown[]; corrupt: boolean }

function readRaw(root: string): RawFile {
  const fresh = (corrupt = false): RawFile => ({ doc: { version: '1.0.0' }, records: [], corrupt });
  let raw: string;
  try {
    raw = fs.readFileSync(planChangesPath(root), 'utf8');
  } catch {
    return fresh();
  }
  if (!raw.trim()) return fresh();
  try {
    const doc = parseJsonLoose<Record<string, unknown>>(raw);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.changes)) return fresh(true);
    return { doc, records: doc.changes as unknown[], corrupt: false };
  } catch {
    return fresh(true);
  }
}

export function loadPlanChanges(root: string): { changes: PlanChange[]; unreadable: boolean } {
  const { records, corrupt } = readRaw(root);
  return { changes: records.filter(isPlanChange), unreadable: corrupt };
}

export function listPlanChanges(
  root: string, f: { status?: PlanChangeStatus; taskId?: string } = {},
): PlanChange[] {
  return loadPlanChanges(root).changes.filter(
    (c) => (!f.status || c.status === f.status) && (!f.taskId || c.taskId === f.taskId),
  );
}

/** Runs `fn` under the changes lock; it returns its result and whether the file must be written. */
function mutateChanges<T>(
  root: string, fn: (records: unknown[]) => [T, boolean],
): T | PlanChangeRefusal {
  const file = planChangesPath(root);
  return withFileLockSync(file, () => {
    const { doc, records, corrupt } = readRaw(root);
    if (corrupt) {
      return refuse(
        'PLAN_CHANGES_UNREADABLE',
        `${path.relative(root, file)} cannot be read, so nothing was changed. Fix or move it.`,
      );
    }
    const [result, write] = fn(records);
    const updatedAt = new Date().toISOString();
    if (write) writeJsonAtomicSync(file, { ...doc, version: '1.0.0', updatedAt, changes: records });
    return result;
  });
}

function nextId(records: unknown[]): string {
  const max = records.reduce<number>((m, r) => {
    const id = r && typeof r === 'object' ? (r as { id?: unknown }).id : undefined;
    return Math.max(m, Number(typeof id === 'string' ? /^pc-(\d+)$/.exec(id)?.[1] ?? 0 : 0));
  }, 0);
  return `pc-${String(max + 1).padStart(2, '0')}`;
}

/** What the human reviews; a decision applies only if the record still matches it. */
export function changeContent(r: Pick<PlanChange, 'taskId' | 'change' | 'reason'>): string {
  return JSON.stringify([r.taskId, r.change, r.reason]);
}

function cleanIds(ids: string[] | undefined): string[] | undefined {
  const out = [...new Set((ids ?? []).map((i) => clean(i, MAX_ID)).filter((i): i is string => !!i))];
  return out.length ? out : undefined;
}

function buildBody(input: ProposePlanChangeInput): PlanChangeBody | PlanChangeRefusal {
  const no = (m: string) => refuse('CHANGE_REFUSED', m);
  const add = cleanIds(input.addDependencies);
  const remove = cleanIds(input.removeDependencies);
  const notes = clean(input.notes, MAX_NOTES, true);
  if (input.drop) {
    if (add || remove || notes !== undefined || input.release) return no('--drop excludes every other change option.');
    const reason = clean(input.drop.reason, MAX_REASON);
    if (!reason) return no('A drop needs a reason.');
    const replacedBy = clean(input.drop.replacedBy, MAX_ID);
    return { drop: { reason, ...(replacedBy ? { replacedBy } : {}) } };
  }
  const body: PlanChangeBody = {
    ...(add ? { addDependencies: add } : {}),
    ...(remove ? { removeDependencies: remove } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(input.release ? { release: true as const } : {}),
  };
  return Object.keys(body).length ? body : no('A plan change needs at least one change.');
}

export function proposePlanChange(root: string, input: ProposePlanChangeInput): PlanChange | PlanChangeRefusal {
  const no = (m: string) => refuse('CHANGE_REFUSED', m);
  const taskId = clean(input.taskId, MAX_ID);
  const reason = clean(input.reason, MAX_REASON);
  if (!taskId) return no('A plan change needs a task id.');
  if (!reason) return no('A plan change needs a reason.');
  const change = buildBody(input);
  if (isRefusal(change)) return change;
  const plan = readPlan(root);
  if (isRefusal(plan)) return plan;
  const verdict = checkPlanChange(plan, taskId, change);
  if (typeof verdict === 'string') return no(verdict);
  const fromTask = clean(input.fromTask, MAX_ID);
  const proposedBy = clean(input.by ?? process.env.NATIV_AGENT_ID ?? process.env.NATIV_ROLE, MAX_ID);
  return mutateChanges<PlanChange | PlanChangeRefusal>(root, (records) => {
    const open = records.filter((r): r is PlanChange => isPlanChange(r) && r.status === 'proposed');
    if (open.length >= MAX_PENDING) return [no(`${open.length} plan changes already wait for a decision.`), false];
    const same = JSON.stringify(change);
    const dup = open.find((r) => r.taskId === taskId && JSON.stringify(r.change) === same);
    if (dup) return [no(`${dup.id} already proposes this change to ${taskId}.`), false];
    const item: PlanChange = {
      id: nextId(records), status: 'proposed', taskId, change, reason,
      ...(fromTask ? { fromTask } : {}), ...(proposedBy ? { proposedBy } : {}),
      createdAt: new Date().toISOString(),
    };
    records.push(item);
    return [item, true];
  });
}

const unreadablePlan = (): PlanChangeRefusal =>
  refuse('PLAN_UNREADABLE', 'The plan (.ai/master_plan.json) cannot be read.');

function readPlan(root: string): MasterPlan | PlanChangeRefusal {
  try {
    const plan = parseJsonLoose<MasterPlan>(fs.readFileSync(planPath(root), 'utf8'));
    if (plan && Array.isArray(plan.milestones)) return plan;
  } catch { /* reported below */ }
  return unreadablePlan();
}

/** True when a crash left the plan changed but the record proposed. */
function inEffect(task: MasterPlanTask | undefined, r: PlanChange): boolean {
  const c = r.change;
  if (!task) return false;
  if (c.drop) return task.status === 'dropped' && task.drop?.changeId === r.id;
  if (c.release && task.status !== 'pending') return false;
  if (c.notes !== undefined && task.notes !== c.notes) return false;
  if (!(c.addDependencies ?? []).every((d) => task.dependencies.includes(d))) return false;
  return !(c.removeDependencies ?? []).some((d) => task.dependencies.includes(d));
}

function unclaim(task: MasterPlanTask): void {
  delete task.claimedBy;
  delete task.claimedAt;
}

function applyChange(plan: MasterPlan, r: PlanChange, rewired: Rewire[]): void {
  const c = r.change;
  const milestone = plan.milestones.find((m) => m.tasks.some((t) => t.id === r.taskId))!;
  const task = milestone.tasks.find((t) => t.id === r.taskId)!;
  const remove = new Set(c.removeDependencies ?? []);
  task.dependencies = [...new Set([...task.dependencies.filter((d) => !remove.has(d)), ...(c.addDependencies ?? [])])];
  if (c.notes !== undefined) task.notes = c.notes;
  if (c.release) {
    task.status = 'pending';
    if (c.notes === undefined) task.notes = `Released by plan change ${r.id}`;
    unclaim(task);
  }
  if (!c.drop) return;
  const at = new Date().toISOString();
  task.status = 'dropped';
  const replacedBy = c.drop.replacedBy;
  task.drop = { reason: c.drop.reason, ...(replacedBy ? { replacedBy } : {}), changeId: r.id, at };
  unclaim(task);
  const byId = new Map(plan.milestones.flatMap((m) => m.tasks.map((t) => [t.id, t] as const)));
  for (const w of rewired) {
    const t = byId.get(w.taskId)!;
    t.dependencies = [...new Set(t.dependencies.map((d) => (d === w.from ? w.to : d)))];
  }
  if (milestone.status !== 'completed' && milestone.tasks.every(isSettled)) settleMilestone(plan, milestone);
}

export interface DecideOptions { note?: string; seen?: string; by?: string; via?: 'cli' | 'studio' }

/** Approves or rejects a change; returns a refusal or the updated record. */
export function decidePlanChange(
  root: string, id: string, decision: PlanChangeDecision, opts: DecideOptions = {},
): PlanChange | PlanChangeRefusal {
  const result = mutateChanges<PlanChange | PlanChangeRefusal>(root, (records) => {
    const r = records.find((x): x is PlanChange => isPlanChange(x) && x.id === id);
    if (!r) return [refuse('CHANGE_NOT_FOUND', `No plan change ${id}.`), false];
    if (r.status !== 'proposed') return [refuse('CHANGE_ALREADY_DECIDED', `${id} is already ${r.status}.`), false];
    if (opts.seen !== undefined && opts.seen !== changeContent(r)) {
      const edited = `${id} was edited while you were reviewing it. Nothing was decided; look again.`;
      return [refuse('CHANGE_EDITED', edited), false];
    }
    if (decision === 'approved') {
      const refusal = approveInPlan(root, r);
      if (refusal) return [refusal, false];
    }
    stamp(root, r, decision, opts);
    return [r, true];
  });
  if (!isRefusal(result) && result.status === 'approved') afterApprove(root, result);
  return result;
}

function approveInPlan(root: string, r: PlanChange): PlanChangeRefusal | null {
  const out = withPlanLockSync(planPath(root), (plan, ctx) => {
    const task = indexPlan(plan).live.get(r.taskId);
    if (inEffect(task, r)) {
      ctx.abort();
      return { refusal: null };
    }
    const verdict = checkPlanChange(plan, r.taskId, r.change);
    if (typeof verdict === 'string') {
      ctx.abort();
      return { refusal: refuse('CHANGE_REFUSED', verdict) };
    }
    applyChange(plan, r, verdict.rewired);
    if (r.change.drop) r.effects = { rewired: verdict.rewired };
    return { refusal: null };
  });
  return out ? out.refusal : unreadablePlan();
}

function stamp(root: string, r: PlanChange, decision: PlanChangeDecision, opts: DecideOptions): void {
  r.status = decision;
  r.decidedAt = new Date().toISOString();
  const by = clean(opts.by ?? resolvePerson(root), MAX_ID);
  if (by) r.decidedBy = by;
  if (opts.via) r.decidedVia = opts.via;
  const note = clean(opts.note, MAX_REASON);
  if (note) r.decisionNote = note;
}

/** Side effects outside the plan, run after both locks are released. */
function afterApprove(root: string, r: PlanChange): void {
  if (r.change.release) CircuitBreaker.recordSuccess(root, r.taskId);
  if (r.change.drop) closeEscalationsForTask(root, r.taskId, `Closed: task dropped by ${r.id}`);
}
