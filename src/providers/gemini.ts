import { loadEnvFiles } from '../db/env-parser.js';
import { ProviderError, stripJsonFence, type CompleteRequest, type Provider, type ProviderDeps } from './types.js';

export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';

/** A stalled call aborts here and the caller falls through to the next provider. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Resolves the Google/Gemini API key from .env files or the environment.
 * Zero-credential air-gap: the returned key is never stored in contracts or responses.
 */
export function resolveGeminiApiKey(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const envVars = loadEnvFiles(root);
    const key = envVars.GEMINI_API_KEY || envVars.GOOGLE_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    if (typeof key === 'string' && key.trim().length > 0) return key.trim();
  } catch {
    // Air-gap guard: suppress file read errors
  }
  return null;
}

interface GeminiBody {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export function createGeminiProvider(deps: ProviderDeps = {}): Provider {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? globalThis.fetch;

  return {
    id: 'gemini',
    defaultModel: GEMINI_DEFAULT_MODEL,

    hasCredentials(root: string): boolean {
      return resolveGeminiApiKey(root, env) !== null;
    },

    async complete(request: CompleteRequest, root: string): Promise<string> {
      const apiKey = resolveGeminiApiKey(root, env);
      if (!apiKey) throw new ProviderError('NO_CREDENTIALS', 'GEMINI_API_KEY is not set.');

      const model = request.model ?? GEMINI_DEFAULT_MODEL;
      const timeout = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const text = request.system ? `${request.system}\n\n${request.prompt}` : request.prompt;

      let res: Response;
      try {
        // The key travels in a header, never the URL, so it cannot leak through logged or proxied URLs.
        res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{ parts: [{ text }] }],
            generationConfig: { ...(request.json ? { responseMimeType: 'application/json' } : {}), temperature: 0.2 },
          }),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name ?? '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('TIMEOUT', `Gemini did not answer within ${timeout}ms.`);
        throw new ProviderError('BAD_RESPONSE', err instanceof Error ? err.message : String(err));
      }

      if (res.status === 429) {
        const seconds = Number(res.headers.get('retry-after'));
        throw new ProviderError('RATE_LIMITED', 'Gemini rate limit reached.', Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
      }
      if (res.status === 401 || res.status === 403) throw new ProviderError('NO_CREDENTIALS', 'The Gemini API key was rejected.');
      if (!res.ok) throw new ProviderError('BAD_RESPONSE', `Gemini responded with HTTP ${res.status}.`);

      let body: GeminiBody;
      try {
        body = (await res.json()) as GeminiBody;
      } catch {
        throw new ProviderError('BAD_RESPONSE', 'Gemini returned a body that is not JSON.');
      }
      const out = body.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!out) throw new ProviderError('BAD_RESPONSE', 'Gemini returned no text.');
      return request.json ? stripJsonFence(out) : out;
    },
  };
}
