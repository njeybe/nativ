import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { resolveMainRoot } from '../core/root-resolver.js';
import { confirm, refuseHeadless } from '../core/human-gate.js';
import { parseJsonLoose } from '../core/enforcement.js';
import {
  PLAN_CHANGE_STATUSES,
  proposePlanChange,
  decidePlanChange,
  listPlanChanges,
  loadPlanChanges,
  checkPlanChange,
  changeContent,
  isRefusal,
  type PlanChange,
  type PlanChangeDecision,
  type PlanChangeStatus,
} from '../core/plan-changes.js';
import type { MasterPlan } from '../scanner/types.js';

export interface PlanProposeOptions {
  reason?: string;
  task?: string;
  by?: string;
  addDeps?: string;
  removeDeps?: string;
  notes?: string;
  release?: boolean;
  drop?: boolean;
  replacedBy?: string;
  json?: boolean;
}

function rootOf(targetDirArg?: string): string {
  return resolveMainRoot(path.resolve(targetDirArg || process.cwd()));
}

function fail(message: string): void {
  console.error(pc.red(`✖ ${message}`));
  process.exitCode = 1;
}

const ids = (text?: string): string[] | undefined =>
  text ? text.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

function headline(c: PlanChange): string {
  return `${pc.bold(c.id)} ${pc.dim(`[${c.status}]`)} ${c.taskId}`;
}

function changeLines(c: PlanChange): string[] {
  const b = c.change;
  const lines: string[] = [];
  if (b.addDependencies) lines.push(`add dependencies ${b.addDependencies.join(', ')}`);
  if (b.removeDependencies) lines.push(`remove dependencies ${b.removeDependencies.join(', ')}`);
  if (b.release) lines.push('release: blocked to pending');
  if (b.notes !== undefined) lines.push(`notes become: ${b.notes}`);
  if (b.drop) {
    const to = b.drop.replacedBy ? `, replaced by ${b.drop.replacedBy}` : '';
    lines.push(`drop the task (${b.drop.reason}${to})`);
  }
  return lines;
}

function readPlan(root: string): MasterPlan | null {
  try {
    const plan = parseJsonLoose<MasterPlan>(fs.readFileSync(path.join(root, '.ai', 'master_plan.json'), 'utf8'));
    return plan && Array.isArray(plan.milestones) ? plan : null;
  } catch {
    return null;
  }
}

/** A fresh check of a proposed change against the live plan. */
function effectLines(root: string, c: PlanChange): string[] {
  if (c.status !== 'proposed') return c.effects?.rewired.map((r) => `${r.taskId} now depends on ${r.to}`) ?? [];
  const plan = readPlan(root);
  if (!plan) return [pc.red('the plan cannot be read')];
  const verdict = checkPlanChange(plan, c.taskId, c.change);
  if (typeof verdict === 'string') return [pc.red(`would be refused now: ${verdict}`)];
  const lines = [pc.green('passes the checks on the live plan')];
  for (const r of verdict.rewired) lines.push(`${r.taskId} depends on ${r.to} instead of ${r.from}`);
  return lines;
}

function fullText(root: string, c: PlanChange): string[] {
  const lines = [headline(c)];
  for (const l of changeLines(c)) lines.push(`    ${l}`);
  lines.push(pc.white(`    why: ${c.reason}`));
  const who = c.proposedBy ? `proposed by ${c.proposedBy}` : '';
  const from = c.fromTask ? `${who ? '; ' : ''}raised in ${c.fromTask}` : '';
  if (who || from) lines.push(pc.dim(`    ${who}${from}`));
  for (const l of effectLines(root, c)) lines.push(`    ${l}`);
  if (c.decidedBy) lines.push(pc.dim(`    decided by ${c.decidedBy}${c.decidedVia ? ` via ${c.decidedVia}` : ''}`));
  return lines;
}

export async function runPlanPropose(taskId: string, targetDirArg?: string, options: PlanProposeOptions = {}) {
  const root = rootOf(targetDirArg);
  const result = proposePlanChange(root, {
    taskId,
    addDependencies: ids(options.addDeps),
    removeDependencies: ids(options.removeDeps),
    notes: options.notes,
    release: options.release,
    drop: options.drop ? { reason: options.reason, replacedBy: options.replacedBy } : undefined,
    reason: options.reason ?? '',
    fromTask: options.task,
    by: options.by,
  });
  if (isRefusal(result)) {
    fail(result.message);
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(pc.green('\n✔ Proposed'));
  for (const line of fullText(root, result)) console.log(`  ${line}`);
  console.log(pc.dim(`  A human decides it in a terminal: nativ plan approve ${result.id}\n`));
}

export async function runPlanDecide(
  id: string,
  decision: PlanChangeDecision,
  targetDirArg?: string,
  options: { note?: string; yes?: boolean } = {},
) {
  if (refuseHeadless(`nativ plan ${decision === 'approved' ? 'approve' : 'reject'}`)) return;
  const root = rootOf(targetDirArg);
  const current = loadPlanChanges(root).changes.find((c) => c.id === id);
  if (!current) {
    fail(`No plan change ${id}.`);
    return;
  }
  console.log('');
  for (const line of fullText(root, current)) console.log(`  ${line}`);
  const verb = decision === 'approved' ? 'Approve' : 'Reject';
  if (!options.yes && !(await confirm(`\n  ${verb} ${id}? [y/N] `))) {
    console.log(pc.dim('  Nothing changed.\n'));
    return;
  }
  const result = decidePlanChange(root, id, decision, {
    note: options.note, seen: changeContent(current), via: 'cli',
  });
  if (isRefusal(result)) {
    fail(result.message);
    return;
  }
  const after = decision === 'approved' ? 'The plan has been changed.' : 'The plan is untouched.';
  console.log(pc.green(`\n✔ ${headline(result)}`));
  console.log(pc.dim(`  ${after}\n`));
}

export async function runPlanList(
  targetDirArg?: string,
  options: { status?: string; task?: string; json?: boolean } = {},
) {
  if (options.status && !(PLAN_CHANGE_STATUSES as readonly string[]).includes(options.status)) {
    fail(`Unknown status "${options.status}". Use one of: ${PLAN_CHANGE_STATUSES.join(', ')}.`);
    return;
  }
  const root = rootOf(targetDirArg);
  const status = options.status as PlanChangeStatus | undefined;
  const items = listPlanChanges(root, { status, taskId: options.task });
  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (!items.length) {
    console.log(pc.dim('\nNo plan changes match.\n'));
    return;
  }
  console.log('');
  for (const item of items) for (const line of fullText(root, item)) console.log(`  ${line}`);
  const waiting = items.filter((i) => i.status === 'proposed').length;
  if (waiting) console.log(pc.yellow(`\n  ${waiting} waiting: nativ plan approve <id> or reject <id>`));
  console.log('');
}
