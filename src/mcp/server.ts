import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  runTaskList,
  runTaskNext,
  runTaskStart,
  runTaskComplete,
  runTaskBlock,
  runTaskEscalate,
  runTaskAdd,
  runTaskProposePatch,
} from '../commands/task.js';
import { SUBAGENT_TYPES } from '../scanner/types.js';
import { runInit } from '../commands/init.js';
import { runStatus } from '../commands/status.js';
import { runDoctor } from '../commands/doctor.js';
import {
  runWorktreeCreate,
  runWorktreeList,
  runWorktreeMerge,
  runWorktreeRemove,
} from '../commands/worktree.js';
import { runDbStatus, runDbInspect, runDbDiff } from '../commands/db.js';
import { runVerify } from '../commands/verify.js';
import { runTestGen } from '../commands/test-gen.js';
import { runBench } from '../commands/bench.js';
import { TEST_FRAMEWORKS } from '../core/test-generator-types.js';
import { packageVersion } from '../core/version.js';

/**
 * Native MCP (Model Context Protocol) server for Nativ over stdio.
 *
 * stdout is reserved for JSON-RPC frames, so the existing CLI handlers (which print via console.*)
 * run inside `captureOutput`, which collects their output and returns it as tool content.
 * Air-gap: only masked, structure-only commands are exposed. `db sync`, `db ui` and `init --force`
 * are intentionally absent, and every tool is bound to the server's project root.
 */

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const ESCALATION_TYPES = [
  'contract_drift',
  'schema_flaw',
  'missing_credential',
  'dependency_conflict',
  'architectural_ambiguity',
] as const;

const RESOURCES = [
  { name: 'context', uris: ['nativ://context'], file: 'context.md', mimeType: 'text/markdown', description: 'Project context, tech stack and guardrails (.ai/context.md)' },
  { name: 'master-plan', uris: ['nativ://master-plan'], file: 'master_plan.json', mimeType: 'application/json', description: 'Milestones, tasks and their status (.ai/master_plan.json)' },
  { name: 'db-schema', uris: ['nativ://db-schema'], file: 'db_schema.json', mimeType: 'application/json', description: 'Database schema contract (.ai/db_schema.json)' },
  { name: 'api-contracts', uris: ['nativ://api-contracts'], file: 'api_contracts.json', mimeType: 'application/json', description: 'API route and schema contracts (.ai/api_contracts.json)' },
  { name: 'escalation', uris: ['nativ://escalation'], file: 'escalation.json', mimeType: 'application/json', description: 'Tier-1 escalation records (.ai/escalation.json)' },
  { name: 'telemetry', uris: ['nativ://telemetry'], file: 'telemetry.json', mimeType: 'application/json', description: 'Execution duration, token usage and cost telemetry (.ai/telemetry.json)' },
] as const;

// Handlers share global console/process.exitCode state, so captured runs are serialized.
let captureQueue: Promise<unknown> = Promise.resolve();

function captureOutput(fn: () => Promise<unknown>, options: { errorOnExitCode?: boolean } = {}): Promise<CallToolResult> {
  const run = async (): Promise<CallToolResult> => {
    const lines: string[] = [];
    const collect = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' '));
    };
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = console.error = console.warn = console.info = collect;

    let failed = false;
    try {
      await fn();
      failed = options.errorOnExitCode !== false && process.exitCode !== undefined && process.exitCode !== 0;
    } catch (err) {
      failed = true;
      lines.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      Object.assign(console, original);
      process.exitCode = previousExitCode;
    }

    const text = lines.join('\n').replace(ANSI_PATTERN, '').trim() || '(no output)';
    return { content: [{ type: 'text', text }], isError: failed || undefined };
  };

  const result = captureQueue.then(run, run);
  captureQueue = result.catch(() => undefined);
  return result;
}

export function createMcpServer(targetDirArg?: string): McpServer {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const server = new McpServer({ name: 'nativ', version: packageVersion() });

  function registerNativTool(
    baseName: string,
    meta: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: any) => Promise<CallToolResult>,
  ) {
    server.registerTool(`nativ_${baseName}`, meta as any, handler);
  }

  // ─── Task lifecycle tools ──────────────────────────────────────────────────

  registerNativTool(
    'task_next',
    {
      description: 'Get the next executable task in the active milestone, with its role guide and JIT contract slice (JSON).',
      inputSchema: {},
    },
    () => captureOutput(() => runTaskNext(targetDir, { json: true })),
  );

  registerNativTool(
    'task_list',
    {
      description: 'List project tasks from .ai/master_plan.json with optional filters (JSON).',
      inputSchema: {
        available: z.boolean().optional().describe('Only tasks that are unblocked and ready for execution'),
        status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).optional().describe('Filter by task status'),
        milestone: z.string().optional().describe('Filter by milestone ID or name'),
        fastPath: z.boolean().optional().describe('Only fast-path tasks'),
      },
    },
    ({ available, status, milestone, fastPath }) =>
      captureOutput(() => runTaskList(targetDir, { available, status, milestone, fastPath, json: true })),
  );

  registerNativTool(
    'task_add',
    {
      description:
        'Append a task to .ai/master_plan.json with an auto-incremented ID (JSON). Goes to the given milestone, else the active one; ' +
        'fastPath routes it to the fast-path milestone (created on first use).',
      inputSchema: {
        title: z.string().min(1).describe('Task title'),
        description: z.string().optional().describe('What the task must accomplish'),
        assignedSubagent: z.enum(SUBAGENT_TYPES as [string, ...string[]]).optional().describe('Sub-agent role (default backend)'),
        milestone: z.string().optional().describe('Target milestone ID or name'),
        verificationCommand: z.string().optional().describe('Command the task complete gatekeeper runs'),
        targetFiles: z.array(z.string()).optional().describe('Files the task may modify'),
        dependencies: z.array(z.string()).optional().describe('Task IDs that must be completed first'),
        fastPath: z.boolean().optional().describe('Route to the fast-path track'),
        specRefs: z.array(z.string()).optional().describe('Spec anchors, e.g. ui_specs.md#appointment-list'),
        complexity: z.string().optional().describe('simple, standard or complex'),
        acceptanceCriteria: z.array(z.string()).optional().describe('Plain-language "done when" lines'),
      },
    },
    ({ title, description, assignedSubagent, milestone, verificationCommand, targetFiles, dependencies, fastPath, specRefs, complexity, acceptanceCriteria }) =>
      captureOutput(() =>
        runTaskAdd(title, targetDir, {
          description,
          agent: assignedSubagent,
          milestone,
          verify: verificationCommand,
          files: targetFiles,
          deps: dependencies,
          fastPath,
          specRefs,
          complexity,
          accept: acceptanceCriteria,
          json: true,
        }),
      ),
  );

  registerNativTool(
    'task_start',
    {
      description: 'Mark a task as in_progress.',
      inputSchema: { taskId: z.string().min(1).describe('Task ID, e.g. task-12') },
    },
    ({ taskId }) => captureOutput(() => runTaskStart(taskId, targetDir)),
  );

  registerNativTool(
    'task_complete',
    {
      description: "Mark a task as completed (always executes its verificationCommand; verification cannot be skipped over MCP). Advances the milestone when all its tasks are done.",
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
        notes: z.string().optional().describe('Completion notes or summary'),
        skipVerify: z.unknown().optional().describe('Not accepted: only a human at a terminal may skip'),
      },
    },
    ({ taskId, notes, skipVerify }) =>
      captureOutput(async () => {
        // Kept in the schema so a stray value is refused instead of silently dropped.
        if (skipVerify !== undefined) {
          throw new Error('skipVerify is not allowed over MCP. Only a human at a terminal can skip verification.');
        }
        await runTaskComplete(taskId, targetDir, { notes });
      }),
  );

  registerNativTool(
    'verify',
    {
      description: "Run verification commands on demand for a task, milestone, or all completed tasks without changing task status.",
      inputSchema: {
        taskId: z.string().optional().describe('Task ID to verify. Defaults to active in_progress task.'),
        milestone: z.string().optional().describe('Filter by milestone ID or name'),
        all: z.boolean().optional().describe('Run verification commands for all completed tasks to detect regressions'),
      },
    },
    ({ taskId, milestone, all }) => captureOutput(() => runVerify(taskId, targetDir, { milestone, all, json: true })),
  );

  registerNativTool(
    'task_block',
    {
      description: 'Mark a task as blocked with a required reason (e.g. verification failed after 3 attempts).',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
        reason: z.string().min(1).describe('Why the task is blocked'),
      },
    },
    ({ taskId, reason }) => captureOutput(() => runTaskBlock(taskId, reason, targetDir)),
  );

  registerNativTool(
    'task_escalate',
    {
      description: 'Escalate a contract or architectural blocker to the Architect (writes .ai/escalation.json and blocks the task).',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
        type: z.enum(ESCALATION_TYPES).describe('Escalation type'),
        details: z.string().min(1).describe('Explanation of the contract gap or blocker'),
        affected: z.array(z.string()).optional().describe('Affected contract paths, e.g. [".ai/db_schema.json"]'),
      },
    },
    ({ taskId, type, details, affected }) =>
      captureOutput(() => runTaskEscalate(taskId, targetDir, { type, details, affected: affected?.join(',') })),
  );

  registerNativTool(
    'task_propose_patch',
    {
      description:
        'Propose an atomic modification to .ai/db_schema.json or .ai/api_contracts.json. ' +
        'Evaluated deterministically by the Contract Governor. Additive changes are auto-approved; ' +
        'destructive changes are rejected and trip the Circuit Breaker on 3 failures.',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
        target: z.enum(['db_schema', 'api_contracts']).describe('Target contract to patch'),
        operation: z.enum(['ADD', 'ALTER', 'DROP', 'RENAME']).describe('Operation type'),
        path: z.string().min(1).describe('Dot-notation path to modify (e.g. users.columns.phone)'),
        value: z.any().optional().describe('Value or schema definition to apply'),
        reason: z.string().min(1).describe('Technical rationale for proposing this patch'),
        baseHash: z.string().optional().describe('Base schema hash to prevent concurrent dirty writes'),
      },
    },
    ({ taskId, target, operation, path: targetPath, value, reason, baseHash }) =>
      captureOutput(() =>
        runTaskProposePatch(targetDir, {
          taskId,
          target,
          operation,
          path: targetPath,
          value,
          reason,
          baseHash,
          json: true,
        }),
      ),
  );

  // ─── Worktree lifecycle tools ──────────────────────────────────────────────

  registerNativTool(
    'worktree_create',
    {
      description: 'Create an isolated Git worktree branch for a task with mounted .ai/ contracts (JSON).',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
      },
    },
    ({ taskId }) => captureOutput(() => runWorktreeCreate(taskId, targetDir, { json: true })),
  );

  registerNativTool(
    'worktree_list',
    {
      description: 'List active agent Git worktrees and their branch mapping (JSON).',
      inputSchema: {},
    },
    () => captureOutput(() => runWorktreeList(targetDir, { json: true })),
  );

  registerNativTool(
    'worktree_merge',
    {
      description: 'Merge an agent worktree branch into the base branch (enforces Safe Merge Gatekeeper unless force is true).',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
        force: z.boolean().optional().describe('Bypass Safe Merge Gatekeeper checks'),
      },
    },
    ({ taskId, force }) => captureOutput(() => runWorktreeMerge(taskId, targetDir, { force, json: true })),
  );

  registerNativTool(
    'worktree_remove',
    {
      description: 'Safely remove an agent worktree and discard its branch without merging.',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID, e.g. task-12'),
        force: z.boolean().optional().describe('Force removal'),
      },
    },
    ({ taskId, force }) => captureOutput(() => runWorktreeRemove(taskId, targetDir, { force, json: true })),
  );

  // ─── Workspace tools ───────────────────────────────────────────────────────

  registerNativTool(
    'init',
    {
      description: 'Scaffold the .ai/ workflow (contracts, master plan, sub-agents, directives). Never overwrites existing files.',
      inputSchema: {},
    },
    () => captureOutput(() => runInit(targetDir, { force: false })),
  );

  registerNativTool(
    'status',
    {
      description: 'Summarize execution progress across all milestones and tasks.',
      inputSchema: {},
    },
    () => captureOutput(() => runStatus(targetDir)),
  );

  registerNativTool(
    'doctor',
    {
      description:
        'Read-only health check of the Claude Code integration: MCP server, hooks, permissions, agents, enforcement mode and provider availability (JSON). ' +
        'Reports drift but never repairs it; repairing is `nativ doctor --fix` in a terminal.',
      inputSchema: {},
    },
    // A report that lists problems is still a successful report, not a tool failure.
    () => captureOutput(async () => runDoctor(targetDir, { json: true }), { errorOnExitCode: false }),
  );

  // ─── Database telemetry tools (masked, structure-only) ─────────────────────

  registerNativTool(
    'db_status',
    {
      description: 'Dev/Prod database connection health, engine, latency and table count. URLs are masked; no credentials are returned.',
      inputSchema: {},
    },
    // An offline database is a valid status report, not a tool failure.
    () => captureOutput(() => runDbStatus(targetDir, { json: true }), { errorOnExitCode: false }),
  );

  registerNativTool(
    'db_inspect',
    {
      description: 'Introspect live database structure (tables, columns, types, keys, indexes). Structure only; never reads row data.',
      inputSchema: {
        env: z.enum(['dev', 'prod']).optional().describe('Environment to inspect (default dev)'),
        table: z.string().optional().describe('Only return a single table or collection'),
      },
    },
    ({ env, table }) => captureOutput(() => runDbInspect(targetDir, { env: env ?? 'dev', table, json: true })),
  );

  registerNativTool(
    'db_diff',
    {
      description: 'Compute schema drift from the Dev database to .ai/db_schema.json (target "contract", default) or to Prod.',
      inputSchema: {
        target: z.enum(['contract', 'prod']).optional().describe('Comparison target (default contract)'),
      },
    },
    ({ target }) => captureOutput(() => runDbDiff(targetDir, { target: target ?? 'contract', json: true })),
  );

  // ─── Test generation ─────────────────────────────────────────────────────

  registerNativTool(
    'test_gen',
    {
      description:
        'Generate API contract and DB integrity test suites from .ai/api_contracts.json and .ai/db_schema.json (JSON result). ' +
        'Writes into the project unless dryRun is true; never overwrites files it did not generate.',
      inputSchema: {
        output: z.string().optional().describe('Output directory relative to the project (default tests/contract)'),
        framework: z.enum(TEST_FRAMEWORKS as [string, ...string[]]).optional().describe('Test framework (default vitest)'),
        baseUrl: z.string().optional().describe('Base URL the API suites call (default http://localhost:3000)'),
        dryRun: z.boolean().optional().describe('Return the generated files without writing them'),
      },
    },
    async ({ output, framework, baseUrl, dryRun }) => {
      if (output) {
        const rel = path.relative(targetDir, path.resolve(targetDir, output));
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
          return { content: [{ type: 'text', text: 'Error: output must be a subdirectory of the project.' }], isError: true };
        }
      }
      return captureOutput(() => runTestGen(targetDir, { output, framework, baseUrl, dryRun, json: true }));
    },
  );

  // ─── Synthetic Benchmark Matrix ──────────────────────────────────────────

  registerNativTool(
    'bench',
    {
      description:
        'Run synthetic evaluation benchmarks across concurrency, invariants, verifications, and telemetry (JSON report).',
      inputSchema: {
        scenario: z
          .enum(['all', 'concurrency', 'governor', 'verification', 'telemetry', 'e2e'])
          .optional()
          .describe('Target scenario to benchmark (default all)'),
        concurrency: z.number().optional().describe('Number of simulated concurrent agent workers (default 6)'),
      },
    },
    async ({ scenario, concurrency }) =>
      captureOutput(() => runBench(targetDir, { scenario, concurrency, json: true })),
  );

  // ─── Contract resources ────────────────────────────────────────────────────

  for (const res of RESOURCES) {
    for (const uriStr of res.uris) {
      server.registerResource(
        res.name,
        uriStr,
        { mimeType: res.mimeType, description: res.description },
        async (uri): Promise<ReadResourceResult> => {
          const filePath = path.join(targetDir, '.ai', res.file);
          let text: string;
          if (fs.existsSync(filePath)) {
            text = fs.readFileSync(filePath, 'utf8');
          } else if (res.name === 'escalation') {
            text = JSON.stringify({ escalations: [] }, null, 2);
          } else if (res.name === 'telemetry') {
            text = JSON.stringify(
              {
                version: '1.0.0',
                summary: {
                  totalTasksCompleted: 0,
                  totalDurationMs: 0,
                  estimatedTotalTokens: 0,
                  estimatedTotalCostUsd: 0,
                  verificationPassRate: 1.0,
                  circuitBreakerTrips: 0,
                },
                tasks: [],
              },
              null,
              2
            );
          } else {
            throw new Error(`.ai/${res.file} not found in ${targetDir}. Run nativ_init first.`);
          }
          return { contents: [{ uri: uri.href, mimeType: res.mimeType, text }] };
        },
      );
    }
  }

  return server;
}

export async function startMcpServer(targetDirArg?: string): Promise<void> {
  // Keep stray console.log calls off stdout, which carries the JSON-RPC stream.
  console.log = console.info = console.error;

  const server = createMcpServer(targetDirArg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Nativ MCP server running on stdio (project: ${path.resolve(targetDirArg || process.cwd())})`);
}
