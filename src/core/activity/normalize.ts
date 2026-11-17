import { toProjectRelative } from '../enforcement.js';
import { redactSecrets } from '../redact.js';
import { resolveMainRoot } from '../root-resolver.js';
import {
  EVENT_LOG_VERSION,
  type ActivityEvent,
  type EventLane,
  type EventTaskRef,
  type ToolData,
} from './event-types.js';

const STRING_CAP = 64;
const PATH_CAP = 300;
const PROGRAM_RE = /^[\w.-]{1,32}$/;
const TASK_ID_RE = /^[A-Za-z][\w-]{0,63}$/;
const TASK_ACTIONS = new Set(['start', 'complete', 'block']);
const MCP_TASK_CALL = /^mcp__nativ__(?:nativ_)?task_(start|complete|block)$/;

type Json = Record<string, unknown>;

export interface ToolCall {
  name: string;
  input?: unknown;
  ok?: boolean;
}

export interface ToolCallContext {
  root: string;
  runId: string;
  cwd?: string;
  role?: string;
  model?: string;
  taskId?: string;
  now?: Date;
}

interface Where {
  root: string;
  cwd: string;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// A string is kept only when redaction leaves it unchanged; otherwise it is dropped.
function clean(value: unknown, cap = STRING_CAP): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (redactSecrets(value) !== value) return undefined;
  return value.slice(0, cap);
}

/** Caps a string at 64 characters; undefined when empty or when redaction would change it. */
export function cleanText(value: unknown): string | undefined {
  return clean(value);
}

/** Same rule with the 300-character path cap. */
export function cleanPath(value: unknown): string | undefined {
  return clean(value, PATH_CAP);
}

function compact<T extends object>(obj: T): T {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

function lineCount(text: unknown): number {
  if (typeof text !== 'string' || text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

function patchCounts(response: unknown): { added: number; removed: number } | null {
  const hunks = isObj(response) ? response.structuredPatch : null;
  if (!Array.isArray(hunks) || hunks.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const lines = isObj(hunk) && Array.isArray(hunk.lines) ? hunk.lines : [];
    for (const line of lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

function inputCounts(name: string, input: Json): { added?: number; removed?: number } {
  if (name === 'Write') return { added: lineCount(input.content) };
  if (name === 'Edit') {
    return { removed: lineCount(input.old_string), added: lineCount(input.new_string) };
  }
  if (name !== 'MultiEdit' || !Array.isArray(input.edits)) return {};
  let added = 0;
  let removed = 0;
  for (const edit of input.edits) {
    if (!isObj(edit)) continue;
    removed += lineCount(edit.old_string);
    added += lineCount(edit.new_string);
  }
  return { added, removed };
}

function lineCounts(name: string, input: Json, response: unknown) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(name)) return {};
  return patchCounts(response) ?? inputCounts(name, input);
}

function programName(word: string): string | undefined {
  const base = word.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase();
  return PROGRAM_RE.test(name) ? name : undefined;
}

interface BashFacts {
  program?: string;
  nativ?: string;
  taskId?: string;
  commandTask?: string;
}

function parseBash(command: unknown): BashFacts {
  if (typeof command !== 'string') return {};
  const words = command.trim().split(/\s+/);
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) words.shift();
  const program = words.length ? programName(words[0]) : undefined;
  if (!program) return {};
  let rest = words.slice(1);
  const viaNode = program === 'node' && /(^|[\\/])cli\.js$/.test(rest[0] ?? '');
  if (program !== 'nativ' && !viaNode) return { program };
  if (viaNode) rest = rest.slice(1);
  const subs: string[] = [];
  while (subs.length < 2 && /^[A-Za-z-]+$/.test(rest[0] ?? '')) subs.push(rest.shift()!);
  const next = rest[0];
  const takesId = subs[0] === 'task' || subs[0] === 'verify';
  const taskId = takesId && next && TASK_ID_RE.test(next) ? next : undefined;
  const nativ = subs.length ? subs.join(' ') : undefined;
  const isTask = subs[0] === 'task' && TASK_ACTIONS.has(subs[1] ?? '');
  return compact({ program, nativ, taskId, commandTask: isTask ? taskId : undefined });
}

function pathFacts(where: Where, input: Json): Pick<ToolData, 'path' | 'outside'> {
  const raw = [input.file_path, input.notebook_path, input.path].find((p) => typeof p === 'string' && p);
  if (typeof raw !== 'string') return {};
  const rel = toProjectRelative(where.root, raw, where.cwd);
  if (rel === null) return { outside: true };
  const safe = clean(rel, PATH_CAP);
  return safe ? { path: safe } : {};
}

function toolData(name: string, input: Json, response: unknown, ok: boolean, where: Where) {
  const data: ToolData = { name: clean(name) ?? 'unknown', ok };
  Object.assign(data, pathFacts(where, input), lineCounts(name, input, response));
  let commandTask: string | undefined;
  if (name === 'Bash') {
    const bash = parseBash(input.command);
    commandTask = bash.commandTask;
    Object.assign(data, compact({ program: bash.program, nativ: bash.nativ, taskId: bash.taskId }));
  }
  if (name.startsWith('mcp__nativ__')) {
    const id = clean(input.taskId);
    if (id) data.taskId = id;
    if (id && MCP_TASK_CALL.test(name)) commandTask = id;
  }
  if (name === 'Agent' || name === 'Task') {
    const agentType = clean(input.subagent_type);
    if (agentType) data.spawn = compact({ agentType, model: clean(input.model) });
  }
  return { data, commandTask };
}

function worktreeTask(cwd: string): string | undefined {
  const match = /(?:^|\/)\.worktrees\/task-([^/]+)/.exec(cwd.replace(/\\/g, '/'));
  return match ? match[1] : undefined;
}

function taskRef(id: string | undefined, via: EventTaskRef['via']): EventTaskRef | undefined {
  const safe = clean(id);
  return safe ? { id: safe, via } : undefined;
}

function base(now: Date | undefined, src: 'hook' | 'runner', lane: EventLane, task?: EventTaskRef) {
  const at = (now ?? new Date()).toISOString();
  return compact({ v: EVENT_LOG_VERSION, at, src, lane, task });
}

function hookLane(p: Json, env: NodeJS.ProcessEnv): EventLane | null {
  const session = clean(p.session_id);
  if (!session) return null;
  const agent = clean(p.agent_id);
  const agentType = clean(p.agent_type);
  if (!agent && !agentType) {
    return compact({ id: `s:${session}`, session, role: clean(env.NATIV_ROLE) ?? 'main' });
  }
  const id = agent ? `s:${session}/a:${agent}` : `s:${session}/t:${agentType}`;
  return compact({ id, session, agent, agentType, role: agentType });
}

/** Turns a PostToolUse, SubagentStart or SubagentStop payload into an event; null when unknown. */
export function fromHookPayload(
  payload: unknown,
  env: NodeJS.ProcessEnv,
  now?: Date,
): ActivityEvent | null {
  if (!isObj(payload)) return null;
  const lane = hookLane(payload, env);
  if (!lane) return null;
  const event = payload.hook_event_name;
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    const phase = event === 'SubagentStart' ? 'start' : 'stop';
    return { ...base(now, 'hook', lane), kind: 'agent', data: { phase } } as ActivityEvent;
  }
  if (event !== 'PostToolUse' || typeof payload.tool_name !== 'string') return null;
  // Chat spawns are recorded once, from PreToolUse.
  if (payload.tool_name === 'Agent' || payload.tool_name === 'Task') return null;
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const where = { root: resolveMainRoot(cwd), cwd };
  const { data, commandTask } = toolData(payload.tool_name, input, payload.tool_response, true, where);
  const task = taskRef(worktreeTask(cwd), 'worktree') ?? taskRef(commandTask, 'command');
  return { ...base(now, 'hook', lane, task), kind: 'tool', data } as ActivityEvent;
}

/** The tool event data and task for a chat spawn seen at PreToolUse; null when it is not one. */
export function spawnFacts(
  payload: unknown,
): { data: ToolData; task?: EventTaskRef } | null {
  if (!isObj(payload) || payload.hook_event_name !== 'PreToolUse') return null;
  const name = payload.tool_name;
  if (name !== 'Agent' && name !== 'Task') return null;
  const input = isObj(payload.tool_input) ? payload.tool_input : {};
  const agentType = clean(input.subagent_type);
  if (!agentType) return null;
  const spawn = compact({ agentType, model: clean(input.model) });
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  return { data: { name, ok: true, spawn }, task: taskRef(worktreeTask(cwd), 'worktree') };
}

/** Turns a runner tool_use block into the same tool event a chat call gives. */
export function fromToolCall(call: ToolCall, context: ToolCallContext): ActivityEvent {
  const runId = clean(context.runId) ?? 'unknown';
  const lane: EventLane = compact({
    id: `run:${runId}`,
    runId,
    role: clean(context.role),
    model: clean(context.model),
  });
  const cwd = context.cwd ?? context.root;
  const input = isObj(call.input) ? call.input : {};
  const where = { root: resolveMainRoot(context.root), cwd };
  const { data, commandTask } = toolData(call.name, input, undefined, call.ok !== false, where);
  const task =
    taskRef(worktreeTask(cwd), 'worktree') ??
    taskRef(context.taskId, 'env') ??
    taskRef(commandTask, 'command');
  return { ...base(context.now, 'runner', lane, task), kind: 'tool', data } as ActivityEvent;
}
