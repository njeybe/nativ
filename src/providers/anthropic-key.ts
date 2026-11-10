import { loadEnvFiles } from '../db/env-parser.js';

/**
 * Finds an Anthropic key in .env files or the environment. nativ never calls the API with it for
 * triage; it only needs the value so it can be redacted from prompts that leave the machine.
 */
export function resolveAnthropicApiKey(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const key = loadEnvFiles(root).ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
    if (typeof key === 'string' && key.trim().length > 0) return key.trim();
  } catch {
    // Air-gap guard: an unreadable env file means "no key", never an error that could echo its contents.
  }
  return null;
}
