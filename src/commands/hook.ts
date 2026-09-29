import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  ARCHITECT_ROLE,
  ROLE_ENV,
  evaluateHookPayload,
  isTaskUnlocked,
  loadEnforcementMode,
  parseJsonLoose,
  type EnforcementMode,
} from '../core/enforcement.js';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { recordRoleViolation } from '../core/telemetry.js';

/** Payloads are a few hundred bytes; anything past this is not a hook call. */
const MAX_STDIN_BYTES = 1_000_000;

function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_STDIN_BYTES) done();
    });
    stream.on('end', done);
    stream.on('error', done);
  });
}

export interface HookCheckOptions {
  /** Stdin and stdout are injectable for tests. */
  input?: NodeJS.ReadableStream;
  output?: (text: string) => void;
  /** Forces a mode instead of reading .nativ/config.json. */
  mode?: EnforcementMode;
  role?: string;
}

/**
 * `nativ hook check`: the PreToolUse hook entry point. Reads Claude Code's JSON from stdin and prints the
 * hook decision to stdout. It always exits 0 and fails open: a broken payload, unreadable state or a bug
 * here must never stop an agent's tool call. Only `block` mode ever denies, and only on a real violation.
 */
export async function runHookCheck(targetDirArg?: string, options: HookCheckOptions = {}): Promise<void> {
  const write = options.output ?? ((text: string) => process.stdout.write(text));
  try {
    const raw = await readStdin(options.input ?? process.stdin);
    let payload: unknown;
    try {
      payload = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      process.stderr.write('nativ hook check: stdin was not JSON; allowing.\n');
      return;
    }

    const fallbackCwd = targetDirArg ? path.resolve(targetDirArg) : process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { output, result } = evaluateHookPayload(payload, { mode: options.mode, role: options.role, fallbackCwd });

    if (result && result.decision !== 'allow' && result.rule && result.relPath && fs.existsSync(path.join(result.root, '.ai'))) {
      const toolName = (payload as { tool_name?: string }).tool_name ?? 'unknown';
      await recordRoleViolation(result.root, {
        rule: result.rule,
        mode: result.mode === 'block' ? 'block' : 'warn',
        tool: toolName,
        path: result.relPath,
        taskIds: result.taskIds,
      });
    }
    if (output) write(JSON.stringify(output));
  } catch (err) {
    process.stderr.write(`nativ hook check: ${err instanceof Error ? err.message : String(err)}; allowing.\n`);
  }
}

export interface HookStatus {
  ok: true;
  root: string;
  mode: EnforcementMode;
  role: string;
  activeTasks: Array<{ id: string; targetFiles: string[]; unlocked: boolean }>;
}

/** `nativ hook status`: what the hook would enforce right now. Read-only. */
export function getHookStatus(targetDirArg?: string): HookStatus {
  const root = resolveProjectRoot(targetDirArg);
  const activeTasks: HookStatus['activeTasks'] = [];
  try {
    const plan = parseJsonLoose<{
      milestones?: Array<{ tasks?: Array<{ id?: string; status?: string; targetFiles?: string[] }> }>;
    }>(fs.readFileSync(path.join(root, '.ai', 'master_plan.json'), 'utf8'));
    for (const milestone of plan.milestones ?? []) {
      for (const task of milestone.tasks ?? []) {
        if (task.status === 'in_progress' && typeof task.id === 'string') {
          activeTasks.push({ id: task.id, targetFiles: task.targetFiles ?? [], unlocked: isTaskUnlocked(root, task.id) });
        }
      }
    }
  } catch {
    // No plan: nothing is in progress.
  }
  return { ok: true, root, mode: loadEnforcementMode(root), role: (process.env[ROLE_ENV] ?? '').toLowerCase() || 'worker', activeTasks };
}

export function runHookStatus(targetDirArg?: string, options: { json?: boolean } = {}): HookStatus {
  const status = getHookStatus(targetDirArg);
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return status;
  }
  const modeColor = status.mode === 'block' ? pc.red : status.mode === 'warn' ? pc.yellow : pc.dim;
  console.log(pc.bold('\nnativ role enforcement'));
  console.log(`  Mode:   ${modeColor(status.mode)}`);
  console.log(`  Role:   ${status.role}${status.role === ARCHITECT_ROLE ? pc.dim(' (may edit .ai/ contracts)') : ''}`);
  if (!status.activeTasks.length) {
    console.log(pc.dim('  No task is in progress: only contract and secret paths are protected.\n'));
  } else {
    for (const task of status.activeTasks) {
      console.log(`  Task:   ${pc.cyan(task.id)}${task.unlocked ? pc.yellow('  [unlocked]') : ''}`);
      console.log(pc.dim(`          ${task.targetFiles.join(', ') || 'no target files'}`));
    }
    console.log('');
  }
  return status;
}
