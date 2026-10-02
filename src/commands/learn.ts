import path from 'node:path';
import pc from 'picocolors';
import { resolveProjectRoot } from '../core/root-resolver.js';
import {
  proposeLearning,
  decideLearning,
  listLearnings,
  type Learning,
  type LearningStatus,
} from '../core/learnings.js';

export interface LearnProposeOptions {
  role?: string;
  files?: string;
  task?: string;
  details?: string;
  by?: string;
  json?: boolean;
}

function rootOf(targetDirArg?: string): string {
  return resolveProjectRoot(path.resolve(targetDirArg || process.cwd()));
}

function describe(item: Learning): string {
  const scope = [item.role ? `role ${item.role}` : '', item.files?.length ? `files ${item.files.join(', ')}` : '']
    .filter(Boolean)
    .join('; ');
  return `${pc.bold(item.id)} ${pc.dim(`[${item.status}]`)} ${item.insight}${scope ? pc.dim(` (${scope})`) : ''}`;
}

export async function runLearnPropose(insight: string, targetDirArg?: string, options: LearnProposeOptions = {}) {
  const root = rootOf(targetDirArg);
  let item: Learning;
  try {
    item = proposeLearning(root, {
      insight,
      details: options.details,
      role: options.role,
      files: options.files?.split(','),
      taskId: options.task,
      proposedBy: options.by ?? process.env.NATIV_ROLE,
    });
  } catch (err: any) {
    console.error(pc.red(`✖ ${err.message}`));
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(item, null, 2));
    return;
  }
  console.log(pc.green(`\n✔ Proposed ${describe(item)}`));
  console.log(pc.dim(`  A human approves it in a terminal: nativ learn approve ${item.id}\n`));
}

export async function runLearnDecide(
  id: string,
  decision: 'approved' | 'rejected',
  targetDirArg?: string,
  options: { note?: string } = {},
) {
  const result = decideLearning(rootOf(targetDirArg), id, decision, options.note);
  if (typeof result === 'string') {
    console.error(pc.red(`✖ ${result}`));
    process.exitCode = 1;
    return;
  }
  const after = decision === 'approved'
    ? 'Workers whose task matches its scope will now see it.'
    : 'It stays on record.';
  console.log(pc.green(`\n✔ ${describe(result)}`));
  console.log(pc.dim(`  ${after}\n`));
}

export async function runLearnList(
  targetDirArg?: string,
  options: { status?: string; role?: string; json?: boolean } = {},
) {
  const statuses: LearningStatus[] = ['proposed', 'approved', 'rejected'];
  const status = statuses.includes(options.status as LearningStatus) ? (options.status as LearningStatus) : undefined;
  const items = listLearnings(rootOf(targetDirArg), { status, role: options.role });
  if (options.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (!items.length) {
    console.log(pc.dim('\nNo learnings match.\n'));
    return;
  }
  console.log('');
  for (const item of items) console.log(`  ${describe(item)}`);
  const waiting = items.filter((i) => i.status === 'proposed').length;
  if (waiting) console.log(pc.yellow(`\n  ${waiting} waiting for approval: nativ learn approve <id> or reject <id>`));
  console.log('');
}
