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
  runTaskAdd,
  runTaskProposePatch,
  runTaskUnlock,
} from './commands/task.js';
import { runHookCheck, runHookStatus } from './commands/hook.js';
import { runSetup } from './commands/setup.js';
import { runDoctor } from './commands/doctor.js';
import { runSessionContext } from './core/setup-assets.js';
import {
  runWorktreeCreate,
  runWorktreeList,
  runWorktreeMerge,
  runWorktreeRemove,
} from './commands/worktree.js';
import { runUpdate } from './commands/update.js';
import { runDbStatus, runDbInspect, runDbDiff, runDbSync, runDbUi } from './commands/db.js';
import { runMcp } from './commands/mcp.js';
import { runVerify } from './commands/verify.js';
import { runTestGen, TEST_GEN_FRAMEWORK_HELP } from './commands/test-gen.js';
import { runBench } from './commands/bench.js';
import { runTriage } from './commands/triage.js';
import { runLearnPropose, runLearnDecide, runLearnList } from './commands/learn.js';
import { packageVersion } from './core/version.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('nativ')
    .description('Role-based multi-agent workflow harness: Claude Code by default, other AI agents pluggable')
    .version(packageVersion());

  program
    .command('init [targetDir]')
    .description('Scaffold the workflow (.ai/, AGENTS.md, directives) and the Claude Code configuration in the target directory')
    .option('-f, --force', 'Overwrite existing specification and directive files')
    .action(async (targetDir, options) => {
      await runInit(targetDir, options);
    });

  program
    .command('setup [targetDir]')
    .description('Write the Claude Code configuration (.mcp.json, .claude/settings.json, agents, AGENTS.md), merging without overwriting your own settings')
    .option('--command <cli>', 'How Claude Code should start nativ, e.g. "npx -y @njeybe/nativ" (default: nativ when installed globally)')
    .option('--enforcement <mode>', 'Role enforcement mode: warn (default), block or off')
    .option('--dry-run', 'Show what would change without writing anything')
    .option('-f, --force', 'Also overwrite agent and directive files that were edited by hand')
    .option('--json', 'Output the result as JSON')
    .action(async (targetDir, options) => {
      await runSetup(targetDir, { command: options.command, enforcement: options.enforcement, dryRun: options.dryRun, force: options.force, json: options.json });
    });

  program
    .command('doctor [targetDir]')
    .description('Check the Claude Code integration for drift (MCP server, hooks, permissions, agents, providers) and repair it with --fix')
    .option('--fix', 'Repair missing or out-of-date files (runs setup)')
    .option('--command <cli>', 'How Claude Code should start nativ (see setup)')
    .option('--no-deep', 'Skip asking Claude Code itself (`claude mcp list`, a few seconds) whether the MCP server connects')
    .option('--json', 'Output the report as JSON')
    .action((targetDir, options) => {
      runDoctor(targetDir, { fix: options.fix, command: options.command, json: options.json, deep: options.deep !== false });
    });

  program
    .command('update [targetDir]')
    .description('Refresh directives, role guides and the Claude Code configuration to the latest templates. Files you edited are kept; contracts and the plan are never touched')
    .option('-f, --force', 'Also replace directive and role-guide files that were edited by hand')
    .action(async (targetDir, options) => {
      await runUpdate(targetDir, { force: options.force });
    });

  program
    .command('status [targetDir]')
    .description('Inspect current execution progress and telemetry from .ai/master_plan.json')
    .option('-t, --telemetry', 'Display token usage, duration, and cost estimation telemetry')
    .option('--json', 'Output project status and telemetry as JSON')
    .action(async (targetDir, options) => {
      await runStatus(targetDir, options);
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
    .option('--fast-path', 'Show only fast-path tasks')
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

  program
    .command('bench [targetDir]')
    .description('Run synthetic evaluation benchmarks across concurrency, invariants, verifications, and telemetry')
    .option('-s, --scenario <scenario>', 'Target scenario to benchmark (concurrency, governor, verification, telemetry, e2e, all)', 'all')
    .option('-c, --concurrency <number>', 'Number of simulated concurrent agent workers', parseInt)
    .option('-o, --output <file>', 'Path to write the JSON benchmark report')
    .option('--json', 'Output raw benchmark metrics as JSON')
    .action(async (targetDir, options) => {
      await runBench(targetDir, options);
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
    .option('--fast-path', 'Show only fast-path tasks')
    .option('--json', 'Output filtered tasks as JSON')
    .action(async (targetDir, options) => {
      await runTaskList(targetDir, options);
    });

  task
    .command('add <title> [targetDir]')
    .description('Append a task to .ai/master_plan.json with an auto-incremented ID (planned or --fast-path track)')
    .option('-m, --milestone <id>', 'Target milestone ID or name (default: active milestone, or the fast-path milestone with --fast-path)')
    .option('-a, --agent <name>', 'Assigned sub-agent (default backend)')
    .option('-v, --verify <command>', 'Verification command run by the task complete gatekeeper')
    .option('-f, --files <paths>', 'Comma-separated target files')
    .option('-d, --description <text>', 'Task description')
    .option('--fast-path', 'Route to the fast-path milestone (created on first use) and flag the task as fast path')
    .option('--deps <ids>', 'Comma-separated dependency task IDs')
    .option('--spec-refs <refs>', 'Comma-separated spec anchors, e.g. ui_specs.md#appointment-list')
    .option('--complexity <level>', 'Task complexity: simple, standard or complex')
    .option(
      '--accept <text>',
      'Acceptance ("done when") line; repeatable or "|"-separated',
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option('--json', 'Output the created task as JSON')
    .action(async (title, targetDir, options) => {
      await runTaskAdd(title, targetDir, options);
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
    .description('Escalate an architectural/contract blocker to the Architect role (.ai/escalation.json)')
    .option('-t, --type <type>', 'Escalation type (contract_drift, schema_flaw, missing_credential, dependency_conflict, architectural_ambiguity)')
    .option('-d, --details <details>', 'Detailed explanation of the blocker')
    .option('-a, --affected <contracts>', 'Comma-separated affected contracts')
    .action(async (taskId, targetDir, options) => {
      await runTaskEscalate(taskId, targetDir, options);
    });

  task
    .command('propose-patch <taskId> [targetDir]')
    .description('Propose a modification to .ai/db_schema.json or .ai/api_contracts.json through the Contract Governor')
    .requiredOption('--target <target>', 'Target contract (db_schema or api_contracts)')
    .requiredOption('--op <operation>', 'Operation (ADD, ALTER, DROP, RENAME)')
    .requiredOption('--path <path>', 'Dot-notation or pointer path to modify (e.g. users.columns.status)')
    .option('--value <jsonOrString>', 'Value or schema definition to apply')
    .requiredOption('-r, --reason <reason>', 'Technical rationale for proposing this patch')
    .option('--base-hash <hash>', 'Base schema hash to prevent concurrent dirty writes')
    .option('--json', 'Output evaluation verdict as JSON')
    .action(async (taskId, targetDir, options) => {
      await runTaskProposePatch(targetDir, {
        taskId,
        target: options.target,
        operation: options.op,
        path: options.path,
        value: options.value,
        reason: options.reason,
        baseHash: options.baseHash,
        json: options.json,
      });
    });

  task
    .command('unlock <taskId> [targetDir]')
    .description('Emergency override: let the task edit files outside its targetFiles (contracts and secrets stay protected)')
    .option('-r, --reason <reason>', 'Why enforcement is being lifted')
    .option('--revoke', 'Re-lock the task to its target files')
    .action(async (taskId, targetDir, options) => {
      await runTaskUnlock(taskId, targetDir, { reason: options.reason, revoke: options.revoke });
    });

  const learn = program
    .command('learn')
    .description('Project lessons the contracts do not capture: agents propose, a human approves');

  learn
    .command('propose <insight> [targetDir]')
    .description('Propose a lesson for later workers (it waits for a human to approve it)')
    .option('--role <role>', 'Only workers with this role see it')
    .option('--files <globs>', 'Comma-separated files, dirs or globs; only tasks touching them see it')
    .option('--task <taskId>', 'The task where it came up')
    .option('-d, --details <details>', 'Longer explanation')
    .option('--by <who>', 'Who proposes it (defaults to NATIV_ROLE)')
    .option('--json', 'Output the stored learning as JSON')
    .action(async (insight, targetDir, options) => {
      await runLearnPropose(insight, targetDir, options);
    });

  learn
    .command('approve <id> [targetDir]')
    .description('Approve a proposed lesson so matching tasks carry it (interactive terminal only)')
    .option('-n, --note <note>', 'Why it was approved')
    .option('-y, --yes', 'Skip the confirmation question (still needs a terminal)')
    .action(async (id, targetDir, options) => {
      await runLearnDecide(id, 'approved', targetDir, options);
    });

  learn
    .command('reject <id> [targetDir]')
    .description('Reject a proposed or approved lesson (interactive terminal only)')
    .option('-n, --note <note>', 'Why it was rejected')
    .option('-y, --yes', 'Skip the confirmation question (still needs a terminal)')
    .action(async (id, targetDir, options) => {
      await runLearnDecide(id, 'rejected', targetDir, options);
    });

  learn
    .command('list [targetDir]')
    .description('List lessons')
    .option('-s, --status <status>', 'proposed, approved or rejected')
    .option('--role <role>', 'Only lessons scoped to this role')
    .option('--json', 'Output as JSON')
    .action(async (targetDir, options) => {
      await runLearnList(targetDir, options);
    });

  const hook = program
    .command('hook')
    .description('Claude Code hook entry points for role enforcement');

  hook
    .command('check [targetDir]')
    .description('PreToolUse hook: read the tool call from stdin and warn or deny writes outside the active task scope')
    .action(async (targetDir) => {
      await runHookCheck(targetDir);
    });

  hook
    .command('context [targetDir]')
    .description('SessionStart hook: print a short orientation for a new Claude Code session')
    .action((targetDir) => {
      runSessionContext(targetDir);
    });

  hook
    .command('status [targetDir]')
    .description('Show the enforcement mode, role and active task scope')
    .option('--json', 'Output status as JSON')
    .action((targetDir, options) => {
      runHookStatus(targetDir, { json: options.json });
    });

  const worktree = program
    .command('worktree')
    .description('Manage isolated git worktrees for parallel agent execution');

  worktree
    .command('create <taskId> [targetDir]')
    .description('Create an isolated git worktree branch for a task with mounted .ai/ contracts')
    .option('--json', 'Output result as JSON')
    .action(async (taskId, targetDir, options) => {
      await runWorktreeCreate(taskId, targetDir, options);
    });

  worktree
    .command('list [targetDir]')
    .description('List active agent git worktrees')
    .option('--json', 'Output worktree list as JSON')
    .action(async (targetDir, options) => {
      await runWorktreeList(targetDir, options);
    });

  worktree
    .command('merge <taskId> [targetDir]')
    .description('Merge and cleanup an agent git worktree branch (Safe Merge Gatekeeper enforced)')
    .option('-f, --force', 'Bypass Safe Merge Gatekeeper checks')
    .option('--json', 'Output result as JSON')
    .action(async (taskId, targetDir, options) => {
      await runWorktreeMerge(taskId, targetDir, options);
    });

  worktree
    .command('remove <taskId> [targetDir]')
    .alias('cleanup')
    .description('Safely remove an agent worktree and discard its branch without merging')
    .option('-f, --force', 'Force removal of worktree and branch')
    .option('--json', 'Output result as JSON')
    .action(async (taskId, targetDir, options) => {
      await runWorktreeRemove(taskId, targetDir, options);
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

  const test = program
    .command('test')
    .description('Generate contract and database integrity tests from .ai/ contracts');

  test
    .command('gen [targetDir]')
    .description('Synthesize API contract and DB integrity test suites from .ai/api_contracts.json and .ai/db_schema.json')
    .option('-o, --output <dir>', 'Output directory, relative to the project (default tests/contract)')
    .option('-f, --framework <name>', `${TEST_GEN_FRAMEWORK_HELP} (default vitest)`)
    .option('-b, --base-url <url>', 'Base URL the API suites call (default http://localhost:3000)')
    .option('--dry-run', 'Show what would be generated without writing files')
    .option('--json', 'Output the generation result as JSON')
    .action(async (targetDir, options) => {
      await runTestGen(targetDir, options);
    });

  program
    .command('triage [escalationId] [targetDir]')
    .description('Run the Tier 1 AI Strategist (Claude by default, Gemini optional) on pending escalations: auto-resolve safe contract fixes or present a decision card')
    .option('-a, --all', 'Triage every pending escalation (report only, no prompts)')
    .option('--apply', 'Write sandbox-proven additive patches to the contracts and unblock their tasks')
    .option('--threshold <policy>', "Risk threshold: 'safe_contracts_only' (default) or 'all_non_destructive'")
    .option('--json', 'Output evaluations as JSON (no prompts)')
    .action(async (escalationId, targetDir, options) => {
      await runTriage(escalationId, targetDir, options);
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
