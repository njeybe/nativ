import Anthropic from '@anthropic-ai/sdk';
import { loadEnvFiles } from '../db/env-parser.js';
import {
  ProviderError,
  stripJsonFence,
  type AnthropicLike,
  type CompleteRequest,
  type Provider,
  type ProviderDeps,
} from './types.js';

export const CLAUDE_API_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Resolves the key from .env files or the environment. The value never leaves this module. */
export function resolveAnthropicApiKey(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const key = loadEnvFiles(root).ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
    if (typeof key === 'string' && key.trim().length > 0) return key.trim();
  } catch {
    // Air-gap guard: an unreadable env file means "no key", never an error that could echo its contents.
  }
  return null;
}

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: Record<string, string> | Headers } | null)?.headers;
  const raw = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export function createClaudeApiProvider(deps: ProviderDeps = {}): Provider {
  const env = deps.env ?? process.env;
  let client: AnthropicLike | null = null;

  const getClient = (root: string): AnthropicLike => {
    if (deps.anthropicClient) return deps.anthropicClient();
    if (!client) {
      const apiKey = resolveAnthropicApiKey(root, env);
      if (!apiKey) throw new ProviderError('NO_CREDENTIALS', 'ANTHROPIC_API_KEY is not set.');
      client = new Anthropic({ apiKey }) as unknown as AnthropicLike;
    }
    return client;
  };

  return {
    id: 'claude-api',
    defaultModel: CLAUDE_API_DEFAULT_MODEL,

    hasCredentials(root: string): boolean {
      return deps.anthropicClient !== undefined || resolveAnthropicApiKey(root, env) !== null;
    },

    async complete(request: CompleteRequest, root: string): Promise<string> {
      const sdk = getClient(root);
      const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        const reply = await sdk.messages.create(
          {
            model: request.model ?? CLAUDE_API_DEFAULT_MODEL,
            max_tokens: 2048,
            ...(request.system ? { system: request.system } : {}),
            messages: [{ role: 'user', content: request.prompt }],
          },
          { timeout },
        );
        const text = reply.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('');
        if (!text.trim()) throw new ProviderError('BAD_RESPONSE', 'Claude returned an empty result.');
        return request.json ? stripJsonFence(text) : text;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        const status = (err as { status?: number } | null)?.status;
        const name = (err as { name?: string } | null)?.name ?? '';
        const message = err instanceof Error ? err.message : String(err);
        if (status === 429 || status === 529) throw new ProviderError('RATE_LIMITED', message.slice(0, 300), retryAfterMs(err));
        if (status === 401 || status === 403) throw new ProviderError('NO_CREDENTIALS', 'The Anthropic API key was rejected.');
        if (/timeout|timed out/i.test(name + message)) throw new ProviderError('TIMEOUT', `Claude did not answer within ${timeout}ms.`);
        throw new ProviderError('BAD_RESPONSE', message.slice(0, 300));
      }
    },
  };
}
