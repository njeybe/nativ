import path from 'node:path';
import readline from 'node:readline/promises';
import pc from 'picocolors';
import { resolveMainRoot } from '../core/root-resolver.js';
import {
  LEARNING_STATUSES,
  proposeLearning,
  decideLearning,
  listLearnings,
  loadLearnings,
  type Learning,
  type LearningDecision,
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
  return resolveMainRoot(path.resolve(targetDirArg || process.cwd()));
}

function fail(message: string): void {
  console.error(pc.red(`✖ ${message}`));
  process.exitCode = 1;
}

function headline(item: Learning): string {
  return `${pc.bold(item.id)} ${pc.dim(`[${item.status}]`)} ${item.insight}`;
}

/** Everything a worker would receive, so the human approves exactly that. */
function fullText(item: Learning): string[] {
  const lines = [headline(item)];
  if (item.details) lines.push(...item.details.split('\n').map((l) => pc.white(`    ${l}`)));
  const scope = [
    item.role ? `role ${item.role}` : 'every role',
    item.files?.length ? `files ${item.files.join(', ')}` : 'any file',
  ];
  lines.push(pc.dim(`    for ${scope.join('; ')}${item.proposedBy ? `; proposed by ${item.proposedBy}` : ''}`));
  return lines;
}

export async function runLearnPropose(insight: string, targetDirArg?: string, options: LearnProposeOptions = {}) {
  let item: Learning;
  try {
    item = proposeLearning(rootOf(targetDirArg), {
      insight,
      details: options.details,
      role: options.role,
      files: options.files?.split(','),
      taskId: options.task,
      proposedBy: options.by ?? process.env.NATIV_ROLE,
    });
  } catch (err: any) {
    fail(err.message);
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(item, null, 2));
    return;
  }
  console.log(pc.green('\n✔ Proposed'));
  for (const line of fullText(item)) console.log(`  ${line}`);
  console.log(pc.dim(`  A human approves it in a terminal: nativ learn approve ${item.id}\n`));
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export async function runLearnDecide(
  id: string,
  decision: LearningDecision,
  targetDirArg?: string,
  options: { note?: string; yes?: boolean } = {},
) {
  // A headless agent has no terminal, so this gate holds even where no permission rule is installed.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const command = decision === 'approved' ? 'approve' : 'reject';
    fail(`nativ learn ${command} needs an interactive terminal; agents cannot run it.`);
    return;
  }
  const root = rootOf(targetDirArg);
  const current = loadLearnings(root).learnings.find((l) => l.id === id);
  if (!current) {
    fail(`No learning ${id}.`);
    return;
  }
  console.log('');
  for (const line of fullText(current)) console.log(`  ${line}`);
  const verb = decision === 'approved' ? 'Approve' : 'Reject';
  if (!options.yes && !(await confirm(`\n  ${verb} ${id}? [y/N] `))) {
    console.log(pc.dim('  Nothing changed.\n'));
    return;
  }
  let result: Learning | string;
  try {
    result = decideLearning(root, id, decision, options.note);
  } catch (err: any) {
    fail(err.message);
    return;
  }
  if (typeof result === 'string') {
    fail(result);
    return;
  }
  const after = decision === 'approved'
    ? 'Workers whose task matches its scope will now see it.'
    : 'It stays on record.';
  console.log(pc.green(`\n✔ ${headline(result)}`));
  console.log(pc.dim(`  ${after}\n`));
}

export async function runLearnList(
  targetDirArg?: string,
  options: { status?: string; role?: string; json?: boolean } = {},
) {
  if (options.status && !(LEARNING_STATUSES as readonly string[]).includes(options.status)) {
    fail(`Unknown status "${options.status}". Use one of: ${LEARNING_STATUSES.join(', ')}.`);
    return;
  }
  const status = options.status as LearningStatus | undefined;
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
  for (const item of items) for (const line of fullText(item)) console.log(`  ${line}`);
  const waiting = items.filter((i) => i.status === 'proposed').length;
  if (waiting) console.log(pc.yellow(`\n  ${waiting} waiting for approval: nativ learn approve <id> or reject <id>`));
  console.log('');
}
