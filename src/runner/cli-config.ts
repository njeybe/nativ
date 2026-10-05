import fs from 'node:fs';
import path from 'node:path';
import type { MasterPlanTask } from '../scanner/types.js';
import {
  buildDesiredConfig,
  cliString,
  configuredInvocation,
  resolveCliInvocation,
} from '../core/setup-assets.js';

/** Credentials never reach the model's shell: it could print them. */
export const SECRET_ENV_PATTERN = /^ANTHROPIC_|^CLAUDE_CODE_OAUTH|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|DATABASE_URL|_DSN$|CREDENTIAL/i;
export const CLAUDE_CODE_AUTH_ENV = /^(ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|CUSTOM_HEADERS|BETAS|VERTEX_PROJECT_ID)|CLAUDE_CODE_[A-Z0-9_]+|CLAUDE_CONFIG_DIR|CLOUD_ML_REGION|VERTEX_REGION_[A-Z0-9_]+)$/;
export const AWS_ENV = /^AWS_[A-Z0-9_]+$/;

/**
 * What a dispatched agent may run without asking. `claude -p` cannot prompt, so anything not listed here is
 * denied and the agent blocks or escalates instead of running it.
 */
export const RUNNER_BASE_ALLOWED_TOOLS = [
  'Bash(nativ *)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git checkout -- *)',
];

/** The pieces of a compound command as Claude Code matches them: each must satisfy an allow rule on its own. */
export function splitCompoundCommand(command: string): string[] {
  return [...new Set(command.split(/&&|\|\||[;|\n]/).map((part) => part.trim()).filter(Boolean))];
}

/** Operator-supplied extra rules from NATIV_RUNNER_ALLOW, comma separated, e.g. `Bash(pnpm test *),Bash(cargo test *)`. */
export function parseRunnerAllowList(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((rule) => rule.trim())
    .filter((rule) => /^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$/.test(rule));
}

export interface RunnerPermissions {
  permissions: { allow: string[]; deny: string[]; ask: string[] };
  /** Omitted when the project's own settings already run the enforcement hook, so it never runs (and logs) twice. */
  hooks?: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string; timeout: number }> }> };
}

/** True when `.claude/settings.json` already registers a nativ `hook check` command. */
export function projectHasEnforcementHook(rootDir: string): boolean {
  try {
    const text = fs.readFileSync(path.join(rootDir, '.claude', 'settings.json'), 'utf8');
    return /"command"\s*:\s*"[^"]*\bhook check\b/.test(text);
  } catch {
    return false;
  }
}

/**
 * Settings handed to a dispatched agent with `--settings`. The deny and ask rules and the enforcement hook come
 * from the same source as `nativ setup`, so a dispatched agent is guarded even in a project where setup never ran.
 */
export function buildRunnerPermissions(
  task: Pick<MasterPlanTask, 'verificationCommand'>,
  rootDir: string,
  extraAllowed: readonly string[] = [],
): RunnerPermissions {
  const invocation = configuredInvocation(rootDir) ?? resolveCliInvocation({});
  const desired = buildDesiredConfig(invocation);
  const cli = cliString(invocation);

  const allow = [
    ...RUNNER_BASE_ALLOWED_TOOLS,
    ...(cli === 'nativ' ? [] : [`Bash(${cli} *)`]),
    ...splitCompoundCommand(task.verificationCommand ?? '').map((command) => `Bash(${command})`),
    ...extraAllowed,
  ];
  return {
    permissions: { allow: [...new Set(allow)], deny: desired.deny, ask: desired.ask },
    ...(projectHasEnforcementHook(rootDir)
      ? {}
      : { hooks: { PreToolUse: [{ matcher: desired.preToolUse.matcher, hooks: [{ type: 'command' as const, command: desired.preToolUse.command, timeout: desired.preToolUse.timeout }] }] } }),
  };
}

/** Where a task's runner settings live: a subdirectory, because run history parses every top-level .json in runs/. */
export function runnerSettingsPath(runsDir: string, taskId: string): string {
  return path.join(runsDir, 'permissions', `${taskId}.json`).replace(/\\/g, '/');
}

export function writeRunnerSettings(runsDir: string, taskId: string, settings: RunnerPermissions): string {
  const file = runnerSettingsPath(runsDir, taskId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return file;
}

/** The instructions text handed to the agent on its standard input. */
export function buildRunnerPrompt(task: MasterPlanTask): string {
  return [
    `Execute task ${task.id} (${task.title}).`,
    task.description ? `Description: ${task.description}.` : '',
    task.verificationCommand ? `Verify your work using: ${task.verificationCommand}.` : '',
    `Start by running: nativ task start ${task.id}. When finished and verified, run: nativ task complete ${task.id}.`,
    `If blocked, follow the Human-Centric Communication Protocol in CLAUDE.md: explain the user experience symptom, root cause in plain English, and clear options without technical jargon.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Arguments for Claude Code CLI to run headless. The prompt goes on stdin, never in this string:
 * quotes or symbols in task text would break the shell.
 *
 * It runs in `acceptEdits` mode with the rules in `settingsFile` (see buildRunnerPermissions); it does not bypass
 * permissions. Without a settings file only the file-edit tools and read-only commands are pre-approved.
 */
export function buildDefaultClaudeCommand(_task: MasterPlanTask, model?: string | null, settingsFile?: string): string {
  const modelFlag = model ? ` --model ${model}` : '';
  // Plain `claude -p` prints nothing until it finishes; stream-json emits every message and tool call as it happens.
  const settingsFlag = settingsFile ? ` --settings "${settingsFile}"` : '';
  return `claude -p${modelFlag} --output-format stream-json --verbose --permission-mode acceptEdits${settingsFlag}`;
}

/** True when a runner command asks Claude Code for its line-delimited JSON event stream. */
export function usesClaudeStreamJson(command: string): boolean {
  return /--output-format(?:=|\s+)stream-json\b/.test(command);
}

/** Final `result` event of a Claude Code stream: grounded usage for cli runs. */
export interface ClaudeStreamResult {
  isError: boolean;
  turns: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ClaudeStreamLine {
  /** Human-readable log text (newline-terminated), or null when the event is not worth showing. */
  text: string | null;
  model?: string;
  result?: ClaudeStreamResult;
}

function firstLine(text: unknown, max = 200): string {
  const line = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}...` : line.trim();
}

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description;
  return typeof pick === 'string' ? firstLine(pick, 160) : firstLine(JSON.stringify(input), 160);
}

const finiteCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Turns one line of `claude -p --output-format stream-json` into a log line. Anything that is not
 * a recognised event (warnings, custom runners, future event types) passes through or is dropped,
 * never thrown on.
 */
export function formatClaudeStreamLine(line: string): ClaudeStreamLine {
  const trimmed = line.trim();
  if (!trimmed) return { text: null };
  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { text: `${line}\n` };
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { text: `${line}\n` };

  switch (event.type) {
    case 'system': {
      if (event.subtype !== 'init') return { text: null };
      const model = typeof event.model === 'string' ? event.model : undefined;
      const tools = Array.isArray(event.tools) ? ` · ${event.tools.length} tools` : '';
      return { text: `[claude] session started · model ${model ?? 'default'}${tools}\n`, model };
    }
    case 'assistant': {
      const lines: string[] = [];
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type === 'text' && String(block.text ?? '').trim()) lines.push(String(block.text).trim());
        else if (block?.type === 'thinking' && String(block.thinking ?? '').trim()) lines.push(`[claude:thinking] ${firstLine(block.thinking, 300)}`);
        else if (block?.type === 'tool_use') lines.push(`[claude] ${block.name}: ${describeToolInput(block.input)}`);
      }
      return { text: lines.length ? `${lines.join('\n')}\n` : null };
    }
    case 'user': {
      const lines: string[] = [];
      for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
        if (block?.type !== 'tool_result') continue;
        const body = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content) ? block.content.map((c: any) => c?.text ?? '').join('\n') : '';
        const summary = firstLine(body, 160);
        if (block.is_error) lines.push(`[claude]   error: ${summary || 'tool failed'}`);
        else if (summary) lines.push(`[claude]   ${summary}`);
      }
      return { text: lines.length ? `${lines.join('\n')}\n` : null };
    }
    case 'result': {
      const usage = event.usage ?? {};
      const cost = typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null;
      const turns = finiteCount(event.num_turns);
      const seconds = finiteCount(event.duration_ms) ? ` · ${Math.round(event.duration_ms / 1000)}s` : '';
      const kind = event.subtype && event.subtype !== 'success' ? ` (${event.subtype})` : '';
      const text =
        `[claude] ${event.is_error ? 'finished with an error' : 'finished'}${kind}` +
        (turns ? ` · ${turns} turns` : '') + (cost !== null ? ` · $${cost.toFixed(4)}` : '') + seconds + '\n';
      return {
        text,
        result: {
          isError: Boolean(event.is_error),
          turns,
          costUsd: cost,
          inputTokens: finiteCount(usage.input_tokens),
          outputTokens: finiteCount(usage.output_tokens),
          cacheCreationTokens: finiteCount(usage.cache_creation_input_tokens),
          cacheReadTokens: finiteCount(usage.cache_read_input_tokens),
        },
      };
    }
    default:
      return { text: null };
  }
}

/**
 * Environment for cli runners. The agent inside can run the commands its allowlist permits (and any custom
 * runner command runs unrestricted), so it can print anything it inherits: credential-looking variables are
 * withheld, except the ones Claude Code itself authenticates with (and AWS credentials when it is configured for Bedrock).
 * NATIV_RUNNER_PASS_ENV="NAME1,NAME2" passes extra variables through deliberately; variables an
 * operator hands to dispatch() explicitly are also passed as-is.
 */
export function buildRunnerEnv(base: NodeJS.ProcessEnv, explicit?: Record<string, string>): NodeJS.ProcessEnv {
  const passThrough = new Set(
    String(base.NATIV_RUNNER_PASS_ENV ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const bedrock = Boolean(base.CLAUDE_CODE_USE_BEDROCK);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const allowed =
      !SECRET_ENV_PATTERN.test(key) || CLAUDE_CODE_AUTH_ENV.test(key) || passThrough.has(key) || (bedrock && AWS_ENV.test(key));
    if (allowed) env[key] = value;
  }
  return { ...env, ...explicit };
}
