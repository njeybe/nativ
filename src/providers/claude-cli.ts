import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProviderError,
  stripJsonFence,
  type CompleteRequest,
  type Provider,
  type ProviderDeps,
  type SpawnRequest,
  type SpawnResult,
} from './types.js';

/** Alias understood by `claude --model`; cheap and fast enough for background triage. */
export const CLAUDE_CLI_DEFAULT_MODEL = 'haiku';

const DEFAULT_TIMEOUT_MS = 60_000;

/** Set on every child so a nested nativ hook, MCP server or provider never recurses into another call. */
export const PROVIDER_CHILD_ENV = 'NATIV_PROVIDER_CHILD';

let neutralCwd: string | null = null;

/**
 * A scratch directory with no project files. Running from here keeps the child from loading this
 * project's CLAUDE.md, hooks, settings and MCP servers, which would slow the call and could loop back into nativ.
 */
function neutralWorkingDirectory(): string {
  if (neutralCwd && fs.existsSync(neutralCwd)) return neutralCwd;
  neutralCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-provider-'));
  return neutralCwd;
}

function defaultHasBinary(name: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(probe, [name], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function defaultSpawn(command: string, args: string[], request: SpawnRequest): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // No shell: the prompt travels over stdin and arguments are passed verbatim, so nothing is re-quoted or interpreted.
    const child = spawn(command, args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish({ code: null, stdout, stderr: err.message, timedOut: false, notFound: err.code === 'ENOENT' }),
    );
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.input);
  });
}

/** Default wait when the CLI reports a usage limit without saying when it resets. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 20 * 60_000;

const LIMIT_PATTERN = /usage limit|rate.?limit|limit reached|too many requests|overloaded|quota/i;

/**
 * Pulls a reset time out of a limit message when there is one: an epoch after a pipe
 * ("Claude usage limit reached|1760000000"), the format Claude Code has used for subscription limits.
 */
export function parseLimitRetryAfter(text: string, now: number): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (!epoch) return undefined;
  const wait = Number(epoch[1]) * 1000 - now;
  return wait > 0 ? wait : undefined;
}

interface CliResult {
  is_error?: boolean;
  result?: unknown;
  api_error_status?: number | null;
  subtype?: string;
}

export function createClaudeCliProvider(deps: ProviderDeps = {}): Provider {
  const run = deps.spawn ?? defaultSpawn;
  const hasBinary = deps.hasBinary ?? defaultHasBinary;
  const now = deps.now ?? Date.now;
  const baseEnv = deps.env ?? process.env;

  return {
    id: 'claude-cli',
    defaultModel: CLAUDE_CLI_DEFAULT_MODEL,

    // A Claude Code login lives in the CLI's own store; the binary being present is the best offline signal we have.
    hasCredentials(): boolean {
      if (baseEnv[PROVIDER_CHILD_ENV] === '1') return false;
      return hasBinary('claude');
    },

    async complete(request: CompleteRequest): Promise<string> {
      if (baseEnv[PROVIDER_CHILD_ENV] === '1') {
        throw new ProviderError('NO_CREDENTIALS', 'Refusing to start Claude from inside a nativ provider call.');
      }

      const args = [
        '-p',
        '--output-format', 'json',
        '--model', request.model ?? CLAUDE_CLI_DEFAULT_MODEL,
        '--tools', '',
        '--strict-mcp-config',
        '--no-session-persistence',
      ];
      if (request.system) args.push('--system-prompt', request.system);

      const result = await run('claude', args, {
        cwd: neutralWorkingDirectory(),
        env: { ...baseEnv, [PROVIDER_CHILD_ENV]: '1' },
        input: request.prompt,
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      if (result.notFound) throw new ProviderError('NO_CREDENTIALS', 'The claude executable was not found on PATH.');
      if (result.timedOut) throw new ProviderError('TIMEOUT', `Claude did not answer within ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);

      let parsed: CliResult | null = null;
      try {
        parsed = JSON.parse(result.stdout) as CliResult;
      } catch {
        parsed = null;
      }

      const text = typeof parsed?.result === 'string' ? parsed.result : '';
      const failed = result.code !== 0 || parsed === null || parsed.is_error === true;

      if (failed) {
        const detail = `${text} ${result.stderr}`.trim();
        if (parsed?.api_error_status === 429 || LIMIT_PATTERN.test(detail)) {
          throw new ProviderError(
            'RATE_LIMITED',
            detail.slice(0, 300) || 'Claude usage limit reached.',
            parseLimitRetryAfter(detail, now()) ?? DEFAULT_LIMIT_COOLDOWN_MS,
          );
        }
        if (/not logged in|please run .*login|invalid api key|authentication/i.test(detail)) {
          throw new ProviderError('NO_CREDENTIALS', 'Claude Code is not logged in. Run `claude` once to sign in.');
        }
        throw new ProviderError('BAD_RESPONSE', (detail || `claude exited with code ${result.code}`).slice(0, 300));
      }

      if (!text.trim()) throw new ProviderError('BAD_RESPONSE', 'Claude returned an empty result.');
      return request.json ? stripJsonFence(text) : text;
    },
  };
}
