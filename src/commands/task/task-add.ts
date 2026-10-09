import pc from 'picocolors';
import {
  isSubagentType,
  MasterPlan,
  MasterPlanMilestone,
  MasterPlanTask,
  TaskComplexity,
  SUBAGENT_TYPES,
  validateMasterPlanTask,
} from '../../scanner/types.js';
import { withPlanLock } from '../../core/lock-manager.js';
import {
  getPlanPath,
  getRoleGuide,
  TaskAddOptions,
  TaskAddResult,
} from './task-common.js';

export const FAST_PATH_MILESTONE_NAME = 'Fast-Path Tasks';

/** Next `<prefix><n>` after the highest existing number, keeping that ID's zero-padding. */
function nextNumberedId(ids: string[], prefix: string, defaultWidth: number): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  let width = defaultWidth;
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match && Number(match[1]) >= max) {
      max = Number(match[1]);
      width = match[1].length;
    }
  }
  const taken = new Set(ids);
  let n = max + 1;
  let candidate = `${prefix}${String(n).padStart(width, '0')}`;
  while (taken.has(candidate)) candidate = `${prefix}${String(++n).padStart(width, '0')}`;
  return candidate;
}

export function generateNextTaskId(plan: MasterPlan): string {
  return nextNumberedId(plan.milestones.flatMap((m) => m.tasks.map((t) => t.id)), 'task-', 2);
}

export function generateNextMilestoneId(plan: MasterPlan): string {
  return nextNumberedId(plan.milestones.map((m) => m.id), 'm', 1);
}

function splitList(value: string | string[] | undefined): string[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function failTaskAdd(code: string, message: string, json?: boolean): null {
  if (json) console.log(JSON.stringify({ error: { code, message } }, null, 2));
  else console.error(pc.red(`\n✖ ${message}\n`));
  process.exitCode = 1;
  return null;
}

/** Resolves a milestone by exact ID, exact name, or a unique partial name (all case-insensitive). */
function findMilestone(plan: MasterPlan, query: string): MasterPlanMilestone | MasterPlanMilestone[] | null {
  const q = query.trim().toLowerCase();
  const exact = plan.milestones.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase() === q);
  if (exact) return exact;
  const partial = plan.milestones.filter((m) => m.name.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  return partial.length > 1 ? partial : null;
}

/**
 * Appends a task to .ai/master_plan.json with an auto-incremented ID.
 * Routing: --milestone wins; otherwise fast-path tasks go to the fast-path milestone (created on
 * first use) and planned tasks to the active milestone. Completed milestones are reopened.
 */
export async function runTaskAdd(title: string, targetDirArg?: string, options: TaskAddOptions = {}): Promise<TaskAddResult | null> {
  const { planPath } = getPlanPath(targetDirArg);
  return withPlanLock(planPath, (plan, ctx) => {
    if (!Array.isArray(plan.milestones)) {
      ctx.abort();
      return failTaskAdd('INVALID_PLAN', '.ai/master_plan.json is missing its "milestones" array', options.json);
    }

    const cleanTitle = (title ?? '').trim();
    if (!cleanTitle) {
      ctx.abort();
      return failTaskAdd('INVALID_TITLE', 'A task title is required', options.json);
    }

    const agent = (options.agent ?? 'backend').trim();
    if (!isSubagentType(agent)) {
      ctx.abort();
      return failTaskAdd('INVALID_AGENT', `Unknown sub-agent "${agent}". Expected one of: ${SUBAGENT_TYPES.join(', ')}`, options.json);
    }

    const existingIds = new Set(plan.milestones.flatMap((m) => m.tasks.map((t) => t.id)));
    const deps = [...new Set(splitList(options.deps))];
    const unknownDeps = deps.filter((d) => !existingIds.has(d));
    if (unknownDeps.length) {
      ctx.abort();
      return failTaskAdd('UNKNOWN_DEPENDENCY', `Unknown dependency task ID(s): ${unknownDeps.join(', ')}`, options.json);
    }

    const fastPath = options.fastPath === true;
    let milestone: MasterPlanMilestone | undefined;
    let createdMilestone = false;

    if (options.milestone) {
      const found = findMilestone(plan, options.milestone);
      if (Array.isArray(found)) {
        ctx.abort();
        return failTaskAdd('AMBIGUOUS_MILESTONE', `"${options.milestone}" matches several milestones: ${found.map((m) => m.id).join(', ')}`, options.json);
      }
      if (!found) {
        ctx.abort();
        return failTaskAdd('UNKNOWN_MILESTONE', `Milestone "${options.milestone}" not found`, options.json);
      }
      milestone = found;
    } else if (fastPath) {
      milestone = plan.milestones.find((m) => m.fastPath === true);
      if (!milestone) {
        milestone = { id: generateNextMilestoneId(plan), name: FAST_PATH_MILESTONE_NAME, status: 'pending', fastPath: true, tasks: [] };
        plan.milestones.push(milestone);
        createdMilestone = true;
      }
    } else {
      const active = plan.milestones.find((m) => m.id === plan.activeMilestoneId);
      milestone = active && active.status !== 'completed' ? active : plan.milestones.find((m) => m.status !== 'completed');
      if (!milestone) {
        ctx.abort();
        return failTaskAdd('NO_OPEN_MILESTONE', 'Every milestone is completed. Pass --milestone <id> to reopen one, or --fast-path', options.json);
      }
    }

    const specRefs = [...new Set(splitList(options.specRefs))];
    const acceptanceCriteria = (Array.isArray(options.accept) ? options.accept : options.accept ? [options.accept] : [])
      .flatMap((item) => item.split('|'))
      .map((item) => item.trim())
      .filter(Boolean);
    const complexity = options.complexity?.trim().toLowerCase();

    const task: MasterPlanTask = {
      id: generateNextTaskId(plan),
      title: cleanTitle,
      description: (options.description ?? '').trim(),
      assignedSubagent: agent,
      dependencies: deps,
      targetFiles: splitList(options.files),
      status: 'pending',
      verificationCommand: (options.verify ?? '').trim(),
      notes: (options.notes ?? '').trim(),
      ...(fastPath ? { fastPath: true } : {}),
      ...(specRefs.length ? { specRefs } : {}),
      ...(complexity ? { complexity: complexity as TaskComplexity } : {}),
      ...(acceptanceCriteria.length ? { acceptanceCriteria } : {}),
    };

    const problems = validateMasterPlanTask(task);
    if (problems.length) {
      ctx.abort();
      return failTaskAdd('INVALID_TASK', problems.join('; '), options.json);
    }

    milestone.tasks.push(task);
    const reopenedMilestone = milestone.status === 'completed';
    if (reopenedMilestone) milestone.status = 'in_progress';
    if (plan.overallStatus === 'completed') plan.overallStatus = 'in_progress';

    const result: TaskAddResult = { task, milestoneId: milestone.id, milestoneName: milestone.name, createdMilestone, reopenedMilestone };

    if (options.json) {
      console.log(JSON.stringify(result));
      return result;
    }

    const track = fastPath ? pc.magenta(' [fast path]') : '';
    console.log(pc.green(`\n✔ Task [${pc.bold(task.id)}] added to [${milestone.id}] ${milestone.name}`) + track);
    if (createdMilestone) console.log(pc.cyan(`  Created fast-path milestone [${milestone.id}]`));
    if (reopenedMilestone) console.log(pc.yellow(`  Reopened completed milestone [${milestone.id}]`));
    console.log(pc.dim('  Title:    ') + task.title);
    console.log(pc.dim('  Agent:    ') + pc.magenta(`[${task.assignedSubagent}]`) + pc.dim(` -> ${getRoleGuide(task.assignedSubagent)}`));
    console.log(pc.dim('  Files:    ') + (task.targetFiles.length ? pc.cyan(task.targetFiles.join(', ')) : pc.dim('none')));
    console.log(pc.dim('  Verify:   ') + (task.verificationCommand ? pc.yellow(`\`${task.verificationCommand}\``) : pc.dim('none (completion will not be gated)')));
    if (task.dependencies.length) console.log(pc.dim('  Deps:     ') + task.dependencies.join(', '));
    console.log(pc.dim('\n  Start it: ') + pc.white(`nativ task start ${task.id}\n`));
    return result;
  });
}
