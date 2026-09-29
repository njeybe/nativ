/**
 * nativ-cli · Provider adapter contract.
 *
 * Every LLM call made by nativ itself goes through a `Provider`. Adding a vendor means adding one
 * file in this directory and one entry in registry.ts; nothing outside src/providers/ changes.
 */

export type ProviderId = 'claude-cli' | 'claude-api' | 'gemini';

/** Roles a provider can be assigned to in `.nativ/config.json`. */
export type ProviderRole = 'architect' | 'pm' | 'worker' | 'verifier' | 'triage';

export type ProviderErrorCode = 'NO_CREDENTIALS' | 'TIMEOUT' | 'RATE_LIMITED' | 'BAD_RESPONSE';

/** Typed failure so callers can fall through the provider chain without string matching. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    /** For RATE_LIMITED: how long the provider asked us to wait, when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface CompleteRequest {
  system?: string;
  prompt: string;
  /** Ask for a single JSON document; providers strip code fences from the reply. */
  json?: boolean;
  /** Overrides the provider's default model. */
  model?: string;
  /** Hard ceiling for the call. Defaults are provider-specific. */
  timeoutMs?: number;
}

export interface Provider {
  readonly id: ProviderId;
  readonly defaultModel: string;
  /** True when a call could plausibly succeed: a login, a binary on PATH, or an API key. Never reads the secret out. */
  hasCredentials(root: string): boolean;
  complete(request: CompleteRequest, root: string): Promise<string>;
}

export interface SpawnRequest {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the executable could not be started at all (ENOENT). */
  notFound?: boolean;
}

/** Everything a provider touches outside the process, injectable so tests never hit a network or a real binary. */
export interface ProviderDeps {
  spawn?: (command: string, args: string[], request: SpawnRequest) => Promise<SpawnResult>;
  hasBinary?: (name: string) => boolean;
  fetch?: typeof fetch;
  /** Minimal shape of the Anthropic SDK client used by claude-api. */
  anthropicClient?: () => AnthropicLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface AnthropicLike {
  messages: {
    create(
      body: Record<string, unknown>,
      options?: { timeout?: number },
    ): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

/** Strips a surrounding ```json fence, which models add even when told not to. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}
