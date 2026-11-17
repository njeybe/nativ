import type http from 'node:http';
import {
  changeContent,
  checkPlanChange,
  decidePlanChange,
  isRefusal,
  loadPlanChanges,
  type PlanChange,
  type PlanChangeDecision,
  type PlanChangeRefusalCode,
} from '../../core/plan-changes.js';
import { resolvePerson } from '../../core/identity.js';
import { HttpError } from '../http-utils.js';
import { readPlan } from '../plan-utils.js';
import { hasHumanKey, type HumanSession } from '../studio-session.js';

const MAX_NOTE_LENGTH = 500;
const DECISIONS: Record<string, PlanChangeDecision> = { approve: 'approved', reject: 'rejected' };

function withCheck(change: PlanChange, plan: ReturnType<typeof readPlan>) {
  const seen = changeContent(change);
  if (change.status !== 'proposed') return { ...change, seen };
  const verdict = plan
    ? checkPlanChange(plan, change.taskId, change.change)
    : 'The plan (.ai/master_plan.json) cannot be read.';
  if (typeof verdict === 'string') {
    return { ...change, seen, check: { ok: false, reason: verdict }, effects: { rewired: [] } };
  }
  return { ...change, seen, check: { ok: true, reason: null }, effects: verdict };
}

/** GET /api/pipeline/plan-changes: newest first, proposed ones with a fresh check. */
export function handlePlanChanges(
  root: string, searchParams: URLSearchParams, req: http.IncomingMessage, human: HumanSession,
) {
  const status = searchParams.get('status') ?? 'proposed';
  if (status !== 'proposed' && status !== 'all') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"status" must be proposed or all');
  }
  const { changes, unreadable } = loadPlanChanges(root);
  if (unreadable) throw new HttpError(500, 'PLAN_CHANGES_UNREADABLE', '.ai/plan_changes.json cannot be read');
  const plan = readPlan(root);
  const shown = changes.filter((c) => status === 'all' || c.status === 'proposed').reverse();
  return { ok: true, changes: shown.map((c) => withCheck(c, plan)), human: hasHumanKey(req, human) };
}

// Unreadable files are a server fault; the change codes are the caller's.
const UNREADABLE: PlanChangeRefusalCode[] = ['PLAN_CHANGES_UNREADABLE', 'PLAN_UNREADABLE'];

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"${field}" is required`);
  }
  return value;
}

/** POST /api/pipeline/plan-changes/decide: the key check happens in the caller, before the body is read. */
export function handlePlanChangeDecide(root: string, body: Record<string, unknown>) {
  const id = requiredString(body.id, 'id').trim();
  const word = requiredString(body.decision, 'decision');
  if (!Object.hasOwn(DECISIONS, word)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"decision" must be approve or reject');
  }
  const seen = requiredString(body.seen, 'seen');
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"note" must be a string');
  }
  const note = typeof body.note === 'string' ? body.note : undefined;
  if (note && note.length > MAX_NOTE_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"note" must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  const result = decidePlanChange(root, id, DECISIONS[word], {
    note, seen, by: resolvePerson(root), via: 'studio',
  });
  if (isRefusal(result)) {
    throw new HttpError(UNREADABLE.includes(result.code) ? 500 : 400, result.code, result.message);
  }
  return { ok: true, change: result, message: `${id} ${result.status}.` };
}
