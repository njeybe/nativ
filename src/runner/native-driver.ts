import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { MasterPlanTask } from '../scanner/types.js';
import {
  computeActualCostUsd,
  emptyActualUsage,
  mergeActualUsage,
  type ActualTokenUsage,
} from '../core/telemetry.js';
import {
  NATIVE_MAX_OUTPUT_TOKENS,
  type ActiveRun,
  type RunnerRecord,
} from './types.js';
import { killProcessTree } from './process-utils.js';
import {
  NATIVE_TOOLS,
  ToolInputError,
  buildToolEnv,
  checkNativeBashCommand,
  clipToolOutput,
  requireString,
  runEditorCommand,
} from './native-tools.js';
import {
  NATIVE_SYSTEM_PROMPT,
  buildNativeTaskPrompt,
  supportsServerFallback,
} from './native-engine.js';

const NATIVE_TOOL_CAPTURE_LIMIT = 1024 * 1024;
const ROLE_GUIDE_LIMIT = 20_000;
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface NativeDriverContext {
  rootDir: string;
  nativeMaxTurns: number;
  nativeToolTimeoutMs: number;
  nativeAllowedCommands: ReadonlySet<string>;
  toolShell: string | boolean;
  appendLog: (run: ActiveRun, stream: 'stdout' | 'stderr', chunk: string) => void;
  onTurnUsage: (record: RunnerRecord, delta: ActualTokenUsage, model: string) => void;
}

export function readRoleGuide(rootDir: string, task: MasterPlanTask): string | null {
  if (!/^[\w-]+$/.test(task.assignedSubagent || '')) return null;
  try {
    const text = fs.readFileSync(path.join(rootDir, '.ai', 'subagents', `${task.assignedSubagent}.md`), 'utf8');
    return text.length > ROLE_GUIDE_LIMIT ? `${text.slice(0, ROLE_GUIDE_LIMIT)}\n[... truncated ...]` : text;
  } catch {
    return null;
  }
}

/**
 * Manual agentic loop over the Messages API: stream a turn, capture usage,
 * execute the requested local tools, repeat until the model ends its turn.
 */
export async function runNativeLoop(
  ctx: NativeDriverContext,
  run: ActiveRun,
  useWorktree: boolean
): Promise<void> {
  const native = run.native!;
  const { thinking } = native;
  const fallback = supportsServerFallback(native.model);
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: 'user', content: buildNativeTaskPrompt(run.task, readRoleGuide(ctx.rootDir, run.task), useWorktree, ctx.rootDir) },
  ];

  for (let turn = 1; ; turn++) {
    if (run.settled) return;
    if (turn > ctx.nativeMaxTurns) {
      throw new Error(`Native engine stopped after the ${ctx.nativeMaxTurns}-turn budget without finishing`);
    }

    const stream = native.client.beta.messages.stream(
      {
        model: native.model,
        max_tokens: NATIVE_MAX_OUTPUT_TOKENS,
        system: [{ type: 'text', text: NATIVE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        cache_control: { type: 'ephemeral' },
        tools: NATIVE_TOOLS,
        messages,
        ...(thinking.budgetTokens
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinking.budgetTokens } }
          : thinking.effort
            ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } }
            : {}),
        ...(thinking.effort ? { output_config: { effort: thinking.effort } } : {}),
        ...(fallback ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const } : {}),
      },
      { signal: native.controller.signal },
    );

    let streaming: 'text' | 'thinking' | null = null;
    const switchTo = (kind: 'text' | 'thinking') => {
      if (streaming === kind) return;
      ctx.appendLog(run, 'stdout', `${streaming ? '\n' : ''}${kind === 'thinking' ? '[native:thinking] ' : ''}`);
      streaming = kind;
    };
    stream.on('thinking', (delta) => {
      if (!delta) return;
      switchTo('thinking');
      ctx.appendLog(run, 'stdout', delta);
    });
    stream.on('text', (delta) => {
      switchTo('text');
      ctx.appendLog(run, 'stdout', delta);
    });

    const message = await stream.finalMessage();
    if (streaming) ctx.appendLog(run, 'stdout', '\n');
    if (run.settled) return;
    recordTurnUsage(ctx, run, message);

    if (message.stop_reason === 'refusal') {
      const category = message.stop_details?.category;
      throw new Error(`Model declined the task (refusal${category ? `: ${category}` : ''})`);
    }
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use',
    );
    if (message.stop_reason === 'max_tokens') {
      throw new Error(`Model output hit max_tokens (${NATIVE_MAX_OUTPUT_TOKENS}) mid-turn`);
    }
    if (toolUses.length === 0) return;

    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const block of toolUses) {
      if (run.settled) return;
      results.push(await executeNativeTool(ctx, run, block));
    }
    messages.push({ role: 'user', content: results });
  }
}

function recordTurnUsage(
  ctx: NativeDriverContext,
  run: ActiveRun,
  message: Anthropic.Beta.Messages.BetaMessage
): void {
  const { record } = run;
  const usage = message.usage;
  const model = message.model || run.native!.model;
  const details = (usage as { output_tokens_details?: { thinking_tokens?: number } | null }).output_tokens_details;
  const slice = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
  const delta: ActualTokenUsage = {
    model,
    turns: 1,
    ...slice,
    thinkingTokens: details?.thinking_tokens ?? 0,
    costUsd: computeActualCostUsd(model, slice),
  };
  record.usage = mergeActualUsage(record.usage ?? emptyActualUsage(model), delta);

  ctx.appendLog(
    run,
    'stdout',
    `[native] turn ${record.usage.turns}: in ${delta.inputTokens} · out ${delta.outputTokens}` +
      ` · cache read ${delta.cacheReadTokens} / write ${delta.cacheCreationTokens} · $${delta.costUsd.toFixed(4)}\n`,
  );
  ctx.onTurnUsage(record, delta, model);
}

async function executeNativeTool(
  ctx: NativeDriverContext,
  run: ActiveRun,
  block: Anthropic.Beta.Messages.BetaToolUseBlock,
): Promise<Anthropic.Beta.Messages.BetaToolResultBlockParam> {
  const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
  try {
    let content: string;
    if (block.name === 'bash') {
      content = await runBashTool(ctx, run, input);
    } else if (block.name === 'str_replace_based_edit_tool') {
      ctx.appendLog(run, 'stdout', `[native] edit ${String(input.command)} ${String(input.path)}\n`);
      content = runEditorCommand(run.record.worktreeDir, ctx.rootDir, input);
    } else {
      throw new ToolInputError(`Unknown tool '${block.name}'.`);
    }
    return { type: 'tool_result', tool_use_id: block.id, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.appendLog(run, 'stderr', `[native] ${block.name} error: ${message.split('\n')[0]}\n`);
    return { type: 'tool_result', tool_use_id: block.id, content: message, is_error: true };
  }
}

async function runBashTool(
  ctx: NativeDriverContext,
  run: ActiveRun,
  input: Record<string, unknown>
): Promise<string> {
  if (input.restart === true) return 'Shell restarted. Every command already starts in a fresh shell at the workspace root.';
  const command = requireString(input, 'command').trim();
  if (!command) throw new ToolInputError('"command" must be a non-empty string.');

  const rejection = checkNativeBashCommand(command, ctx.nativeAllowedCommands);
  if (rejection) throw new ToolInputError(`Command rejected: ${rejection}`);

  ctx.appendLog(run, 'stdout', `[native] $ ${command}\n`);
  const child = spawn(command, {
    cwd: run.record.worktreeDir,
    shell: ctx.toolShell,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...buildToolEnv(process.env, run.native?.env),
      NATIV_RUN_ID: run.record.runId,
      NATIV_TASK_ID: run.record.taskId,
      NATIV_PROJECT_ROOT: ctx.rootDir,
    },
  });
  run.toolPid = child.pid ?? null;

  let output = '';
  let omitted = 0;
  const capture = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.length > NATIVE_TOOL_CAPTURE_LIMIT) {
      const head = Math.floor(NATIVE_TOOL_CAPTURE_LIMIT * 0.2);
      const excess = output.length - NATIVE_TOOL_CAPTURE_LIMIT;
      output = output.slice(0, head) + output.slice(head + excess);
      omitted += excess;
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) killProcessTree(child.pid, 'SIGKILL');
  }, ctx.nativeToolTimeoutMs);
  timer.unref?.();

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      capture(Buffer.from(`\n${err.message}\n`));
      resolve(null);
    });
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  run.toolPid = null;

  const clipped = clipToolOutput(output, omitted);
  if (clipped) ctx.appendLog(run, 'stdout', clipped.endsWith('\n') ? clipped : `${clipped}\n`);
  if (timedOut) {
    throw new ToolInputError(
      `Command exceeded the ${Math.round(ctx.nativeToolTimeoutMs / 1000)}s tool budget and was terminated.\n${clipped}`,
    );
  }
  const body = clipped || '(no output)';
  return exitCode === 0 ? body : `${body}\n[exit code ${exitCode ?? 'unknown'}]`;
}
