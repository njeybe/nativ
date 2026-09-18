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
import { runDbStatus, runDbInspect, runDbDiff, runDbSync, runDbUi } from './commands/db.js';
import { runMcp } from './commands/mcp.js';
import { runVerify } from './commands/verify.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('nativ')
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

  program
    .command('verify [taskId] [targetDir]')
    .description('Execute task verification commands to prevent regressions and validate build health')
    .option('-a, --all', 'Run verification commands for all completed tasks in the project')
    .option('-m, --milestone <id>', 'Run verification commands for all tasks in a specific milestone')
    .option('--json', 'Output verification telemetry as JSON')
    .option('--timeout <ms>', 'Execution timeout in milliseconds per command (default 120000)', parseInt)
    .action(async (taskId, targetDir, options) => {
      await runVerify(taskId, targetDir, options);
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
    .description('Mark a task as completed (executes verification command unless --no-verify is passed)')
    .option('-n, --notes <notes>', 'Completion notes or summary')
    .option('--no-verify', 'Skip automated verification command execution')
    .option('--timeout <ms>', 'Verification execution timeout in milliseconds', parseInt)
    .action(async (taskId, targetDir, options) => {
      await runTaskComplete(taskId, targetDir, {
        notes: options.notes,
        skipVerify: options.verify === false,
        timeout: options.timeout,
      });
    });

  task
    .command('verify [taskId] [targetDir]')
    .description('Execute task verification commands to prevent regressions and validate build health')
    .option('-a, --all', 'Run verification commands for all completed tasks in the project')
    .option('-m, --milestone <id>', 'Run verification commands for all tasks in a specific milestone')
    .option('--json', 'Output verification telemetry as JSON')
    .option('--timeout <ms>', 'Execution timeout in milliseconds per command (default 120000)', parseInt)
    .action(async (taskId, targetDir, options) => {
      await runVerify(taskId, targetDir, options);
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

  const db = program
    .command('db')
    .description('Database telemetry, schema introspection, drift detection, and the local DB Studio (credentials never leave this process)');

  db
    .command('status [targetDir]')
    .description('Show Dev/Prod connection health, engine, ping latency, and table count (masked URLs only)')
    .option('--json', 'Output status as JSON')
    .action(async (targetDir, options) => {
      await runDbStatus(targetDir, options);
    });

  db
    .command('inspect [targetDir]')
    .description('Print introspected table structures (columns, types, keys, indexes)')
    .option('-e, --env <env>', 'Environment to inspect (dev or prod)', 'dev')
    .option('-t, --table <name>', 'Only show a single table')
    .option('--json', 'Output schema as JSON')
    .action(async (targetDir, options) => {
      await runDbInspect(targetDir, options);
    });

  db
    .command('diff [targetDir]')
    .description('Compute schema drift from Dev to Prod (or to .ai/db_schema.json with --target contract)')
    .option('--target <target>', 'Comparison target (prod or contract)', 'prod')
    .option('--json', 'Output diff as JSON')
    .option('--exit-code', 'Exit with code 1 when drift is detected (for CI)')
    .action(async (targetDir, options) => {
      await runDbDiff(targetDir, options);
    });

  db
    .command('sync [targetDir]')
    .description('Export a live schema (structure only) into .ai/db_schema.json; previews unless --yes is given')
    .option('-s, --source <env>', 'Source environment (dev or prod)', 'dev')
    .option('-y, --yes', 'Write .ai/db_schema.json instead of previewing')
    .action(async (targetDir, options) => {
      await runDbSync(targetDir, options);
    });

  db
    .command('ui [targetDir]')
    .description('Launch the local Nativ DB Studio web dashboard')
    .option('-p, --port <port>', 'Port to listen on (default 4983)')
    .option('--no-open', 'Do not open the browser automatically')
    .action(async (targetDir, options) => {
      await runDbUi(targetDir, options);
    });

  program
    .command('studio [targetDir]')
    .description('Launch the local Nativ DB Studio web dashboard (alias for `db ui`)')
    .option('-p, --port <port>', 'Port to listen on (default 4983)')
    .option('--no-open', 'Do not open the browser automatically')
    .action(async (targetDir, options) => {
      await runDbUi(targetDir, options);
    });

  program
    .command('mcp [targetDir]')
    .description('Run the native MCP (Model Context Protocol) server over stdio, exposing nativ tools and .ai/ contract resources')
    .action(async (targetDir) => {
      await runMcp(targetDir);
    });

  return program;
}

export async function run() {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
