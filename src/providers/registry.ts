import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../core/lock-manager.js';
import { createClaudeApiProvider } from './claude-api.js';
import { createClaudeCliProvider, DEFAULT_LIMIT_COOLDOWN_MS } from './claude-cli.js';
import { createGeminiProvider } from './gemini.js';
import {
  ProviderError,
  type CompleteRequest,
  type Provider,
  type ProviderDeps,
  type ProviderId,
  type ProviderRole,
} from './types.js';

/** Subscription login first (no key needed), then API keys. Claude is the default for every role. */
export const DEFAULT_CHAIN: readonly ProviderId[] = ['claude-cli', 'claude-api', 'gemini'];

const CONFIG_FILE = path.join('.nativ', 'config.json');
const STATE_FILE = path.join('.nativ', 'provider-state.json');

export interface ProviderConfig {
  /** Per-role provider id, or an ordered list. Unknown ids are ignored. */
  providers?: Partial<Record<ProviderRole, ProviderId | ProviderId[]>>;
  /** Per-provider model override, e.g. { "claude-cli": "sonnet" }. */
  models?: Partial<Record<ProviderId, string>>;
}

export interface RegistryOptions {
  /** Explicit provider id(s); wins over config and the default chain. */
  provider?: ProviderId | ProviderId[];
  deps?: ProviderDeps;
  /** Inline config, used instead of reading .nativ/config.json (tests, programmatic callers). */
  config?: ProviderConfig;
}

export interface ChainResult {
  provider: ProviderId;
  model: string;
  text: string;
}

export function createProviders(deps: ProviderDeps = {}): Record<ProviderId, Provider> {
  return {
    'claude-cli': createClaudeCliProvider(deps),
    'claude-api': createClaudeApiProvider(deps),
    gemini: createGeminiProvider(deps),
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (DEFAULT_CHAIN as readonly string[]).includes(value);
}

function toIds(value: unknown): ProviderId[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.filter(isProviderId);
}

export function loadProviderConfig(root: string): ProviderConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as ProviderConfig;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

// ─── Cooldown: a provider that reported a limit is skipped until its reset ─────────────────────────

type CooldownState = Partial<Record<ProviderId, number>>;

function readCooldowns(root: string): CooldownState {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')) as { cooldownUntil?: CooldownState };
    return raw.cooldownUntil && typeof raw.cooldownUntil === 'object' ? raw.cooldownUntil : {};
  } catch {
    return {};
  }
}

function writeCooldowns(root: string, cooldownUntil: CooldownState): void {
  try {
    writeJsonAtomicSync(path.join(root, STATE_FILE), { cooldownUntil });
  } catch {
    // Cooldown is an optimisation; failing to persist it must never fail the call.
  }
}

export function setProviderCooldown(root: string, id: ProviderId, waitMs: number, now: number = Date.now()): void {
  const state = readCooldowns(root);
  state[id] = now + waitMs;
  writeCooldowns(root, state);
}

/** Milliseconds left on a provider's cooldown, or 0. Expired entries are pruned. */
export function providerCooldownRemaining(root: string, id: ProviderId, now: number = Date.now()): number {
  const state = readCooldowns(root);
  const until = state[id];
  if (typeof until !== 'number') return 0;
  if (until <= now) {
    delete state[id];
    writeCooldowns(root, state);
    return 0;
  }
  return until - now;
}

// ─── Resolution ────────────────────────────────────────────────────────────────────────────────────

function orderedIds(role: ProviderRole, root: string, options: RegistryOptions): ProviderId[] {
  const explicit = toIds(options.provider);
  if (explicit.length) return explicit;
  const configured = toIds((options.config ?? loadProviderConfig(root)).providers?.[role]);
  return configured.length ? configured : [...DEFAULT_CHAIN];
}

/**
 * Providers to try for a role, in order: those with credentials that are not cooling down.
 * An explicit or configured provider that is unavailable is skipped, not an error.
 */
export function resolveProviderChain(role: ProviderRole, root: string, options: RegistryOptions = {}): Provider[] {
  const providers = createProviders(options.deps);
  const now = options.deps?.now?.() ?? Date.now();
  return orderedIds(role, root, options)
    .map((id) => providers[id])
    .filter((provider) => provider.hasCredentials(root) && providerCooldownRemaining(root, provider.id, now) === 0);
}

export function resolveProvider(role: ProviderRole, root: string, options: RegistryOptions = {}): Provider | null {
  return resolveProviderChain(role, root, options)[0] ?? null;
}

/**
 * Runs the request against each provider in turn. A TRANSIENT failure (network, 5xx) is retried on the same
 * provider up to MAX_TRANSIENT_RETRIES times with jittered backoff. A rate limit puts that provider on cooldown, and
 * any other ProviderError falls through to the next one. Throws NO_CREDENTIALS when nothing is available and the
 * last error when every provider failed, so the caller can drop to its deterministic path.
 */
export const MAX_TRANSIENT_RETRIES = 2;

/** 0.5s, then 1s, each plus up to 50% jitter so parallel agents do not retry in lockstep. */
export function transientBackoffMs(attempt: number, random: () => number = Math.random): number {
  const base = 500 * 2 ** attempt;
  return Math.round(base + base * 0.5 * random());
}

export async function completeWithChain(
  role: ProviderRole,
  root: string,
  request: CompleteRequest,
  options: RegistryOptions = {},
): Promise<ChainResult> {
  const chain = resolveProviderChain(role, root, options);
  if (!chain.length) throw new ProviderError('NO_CREDENTIALS', 'No provider is available (no login, key or all cooling down).');

  const models = (options.config ?? loadProviderConfig(root)).models ?? {};
  const now = options.deps?.now ?? Date.now;
  let lastError: ProviderError | null = null;

  const sleep = options.deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (const provider of chain) {
    const model = request.model ?? models[provider.id] ?? provider.defaultModel;
    for (let attempt = 0; ; attempt++) {
      try {
        const text = await provider.complete({ ...request, model }, root);
        return { provider: provider.id, model, text };
      } catch (err) {
        const failure = err instanceof ProviderError ? err : new ProviderError('BAD_RESPONSE', err instanceof Error ? err.message : String(err));
        lastError = failure;
        if (failure.code === 'TRANSIENT' && attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(transientBackoffMs(attempt));
          continue;
        }
        if (failure.code === 'RATE_LIMITED') setProviderCooldown(root, provider.id, failure.retryAfterMs ?? DEFAULT_LIMIT_COOLDOWN_MS, now());
        break;
      }
    }
  }
  throw lastError ?? new ProviderError('BAD_RESPONSE', 'Every provider failed.');
}
