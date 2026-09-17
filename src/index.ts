import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';
import {
  runTaskList,
  runTaskNext,
  runTaskStart,
  runTaskComplete,
  runTaskBlock,
  runTaskEscalate,
} from './commands/task.js';
import {
  runWorktreeCreate,
  runWorktreeList,
  runWorktreeMerge,
} from './commands/worktree.js';
import { runUpdate } from './commands/update.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('agentj')
    .alias('ai-agent-workflow')
    .description('Multi-tier AI agent workflow harness connecting Antigravity, Claude Code, and autonomous sub-agents')
    .version('1.0.0');

  program
    .command('init [targetDir]')
    .description('Scaffold the multi-tier agent architecture (.ai/, CLAUDE.md, GEMINI.md) in the target directory')
    .option('-f, --force', 'Overwrite existing specification and directive files')
    .action(async (targetDir, options) => {
      await runInit(targetDir, options);
    });

  program
    .command('update [targetDir]')
    .description('Safely synchronize directives and sub-agents to the latest framework standards without touching project data')
    .action(async (targetDir) => {
      await runUpdate(targetDir);
    });

  program
    .command('status [targetDir]')
    .description('Inspect current execution progress from .ai/master_plan.json')
    .action(async (targetDir) => {
      await runStatus(targetDir);
    });

  program
    .command('validate [targetDir]')
    .description('Verify integrity of all .ai contracts, schemas, and agent profiles')
    .action(async (targetDir) => {
      await runValidate(targetDir);
    });

  program
    .command('tasks [targetDir]')
    .description('List all project tasks with optional filters (--available, --status, --milestone, --json)')
    .option('-a, --available', 'Show only available unblocked tasks ready for execution')
    .option('-s, --status <status>', 'Filter tasks by status (pending, in_progress, completed, blocked)')
    .option('-m, --milestone <id>', 'Filter tasks by milestone ID or name')
    .option('--json', 'Output filtered tasks as JSON')
    .action(async (targetDir, options) => {
      await runTaskList(targetDir, options);
    });

  const task = program
    .command('task')
    .description('Manage task lifecycle and JIT context slicing in .ai/master_plan.json');

  task
    .command('list [targetDir]')
    .description('List all project tasks with optional filters (--available, --status, --milestone, --json)')
    .option('-a, --available', 'Show only available unblocked tasks ready for execution')
    .option('-s, --status <status>', 'Filter tasks by status (pending, in_progress, completed, blocked)')
    .option('-m, --milestone <id>', 'Filter tasks by milestone ID or name')
    .option('--json', 'Output filtered tasks as JSON')
    .action(async (targetDir, options) => {
      await runTaskList(targetDir, options);
    });

  task
    .command('next [targetDir]')
    .description('Inspect the next executable task and its JIT contract slice')
    .option('--json', 'Output task information as JSON')
    .action(async (targetDir, options) => {
      await runTaskNext(targetDir, options);
    });

  task
    .command('start <taskId> [targetDir]')
    .description('Mark a task as in_progress')
    .action(async (taskId, targetDir) => {
      await runTaskStart(taskId, targetDir);
    });

  task
    .command('complete <taskId> [targetDir]')
    .description('Mark a task as completed and advance milestone when ready')
    .option('-n, --notes <notes>', 'Completion notes or summary')
    .action(async (taskId, targetDir, options) => {
      await runTaskComplete(taskId, targetDir, options);
    });

  task
    .command('block <taskId> [targetDir]')
    .description('Mark a task as blocked with a required reason')
    .requiredOption('-r, --reason <reason>', 'Reason why the task is blocked')
    .action(async (taskId, targetDir, options) => {
      await runTaskBlock(taskId, options.reason, targetDir);
    });

  task
    .command('escalate <taskId> [targetDir]')
    .description('Escalate an architectural/contract blocker back to Antigravity (.ai/escalation.json)')
    .option('-t, --type <type>', 'Escalation type (contract_drift, schema_flaw, missing_credential, dependency_conflict, architectural_ambiguity)')
    .option('-d, --details <details>', 'Detailed explanation of the blocker')
    .option('-a, --affected <contracts>', 'Comma-separated affected contracts')
    .action(async (taskId, targetDir, options) => {
      await runTaskEscalate(taskId, targetDir, options);
    });

  const worktree = program
    .command('worktree')
    .description('Manage isolated git worktrees for parallel agent execution');

  worktree
    .command('create <taskId> [targetDir]')
    .description('Create an isolated git worktree branch for a task')
    .action(async (taskId, targetDir) => {
      await runWorktreeCreate(taskId, targetDir);
    });

  worktree
    .command('list [targetDir]')
    .description('List active agent git worktrees')
    .action(async (targetDir) => {
      await runWorktreeList(targetDir);
    });

  worktree
    .command('merge <taskId> [targetDir]')
    .description('Merge and cleanup an agent git worktree branch')
    .action(async (taskId, targetDir) => {
      await runWorktreeMerge(taskId, targetDir);
    });

  return program;
}

export async function run() {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
