import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  archiveMilestones,
  ArchiveRefusal,
  restoreMilestone,
  DEFAULT_SUITE_TIMEOUT_MS,
} from '../core/milestone-archive.js';

export interface MilestoneArchiveOptions {
  summary?: string;
  summaries?: string;
  check?: string;
  timeout?: number;
}

function readSummaries(file: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    throw new ArchiveRefusal(`--summaries file cannot be read (${err?.message}).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ArchiveRefusal('--summaries file must be a JSON object of milestone id to summary.');
  }
  return parsed as Record<string, string>;
}

function collectSummaries(
  ids: string[],
  options: MilestoneArchiveOptions,
): Record<string, string> {
  if (options.summary !== undefined && options.summaries) {
    throw new ArchiveRefusal('Use --summary or --summaries, not both.');
  }
  if (options.summaries) return readSummaries(options.summaries);
  if (options.summary === undefined) return {};
  if (ids.length > 1) throw new ArchiveRefusal('Several milestones need --summaries <file.json>.');
  return { [ids[0]]: options.summary };
}

async function report<T>(work: () => Promise<T>, onDone: (result: T) => void): Promise<void> {
  try {
    onDone(await work());
  } catch (err: any) {
    if (!(err instanceof ArchiveRefusal)) throw err;
    console.error(pc.red(`\n✖ ${err.message}\n`));
    process.exitCode = 1;
  }
}

export async function runMilestoneArchive(
  idList: string,
  targetDirArg: string | undefined,
  options: MilestoneArchiveOptions,
): Promise<void> {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const ids = idList.split(',').map((id) => id.trim()).filter(Boolean);
  await report(
    async () => archiveMilestones(targetDir, {
      ids,
      summaries: collectSummaries(ids, options),
      check: options.check,
      timeout: options.timeout,
    }),
    (result) => {
      for (const m of result.archived) {
        console.log(pc.green(`\n✔ Archived [${m.id}]: ${m.taskCount} tasks moved to ${m.file}`));
      }
      console.log(pc.dim(`  Active milestone: ${result.activeMilestoneId}\n`));
      result.warnings.forEach((w) => console.log(pc.yellow(`⚠ ${w}`)));
    },
  );
}

export async function runMilestoneRestore(id: string, targetDirArg?: string): Promise<void> {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  await report(
    () => restoreMilestone(targetDir, id),
    (result) => {
      console.log(pc.green(`\n✔ Restored [${result.id}]: ${result.taskCount} tasks are back\n`));
      result.warnings.forEach((w) => console.log(pc.yellow(`⚠ ${w}`)));
    },
  );
}

export function registerMilestoneCommands(program: Command): void {
  const milestone = program
    .command('milestone')
    .description('Move finished milestones out of .ai/master_plan.json and back');

  milestone
    .command('archive <ids> [targetDir]')
    .description('Archive finished milestones (comma-separated ids) after the test suite passes')
    .option('--summary <text>', 'What the milestone delivered (required for one milestone)')
    .option('--summaries <file>', 'JSON file of milestone id to summary, for several milestones')
    .option('--check <command>', 'Suite to run; saved as regressionCommand in .nativ/config.json')
    .option('--timeout <ms>', `Suite timeout in ms (default ${DEFAULT_SUITE_TIMEOUT_MS})`, parseInt)
    .action(async (ids, targetDir, options) => {
      await runMilestoneArchive(ids, targetDir, options);
    });

  milestone
    .command('restore <id> [targetDir]')
    .description('Put an archived milestone and its tasks back into the plan')
    .action(async (id, targetDir) => {
      await runMilestoneRestore(id, targetDir);
    });
}
