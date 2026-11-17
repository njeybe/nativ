import fs from 'node:fs';
import readline from 'node:readline';
import { appendEvent } from '../core/activity/event-log.js';
import type { ActivityEvent, TokenCounts } from '../core/activity/event-types.js';
import { fromHookPayload } from '../core/activity/normalize.js';
import { resolveMainRoot } from '../core/root-resolver.js';

export const STDIN_CAP = 1024 * 1024;
export const TRANSCRIPT_CAP = 50 * 1024 * 1024;
export const GIVE_UP_MS = 2000;

const MODEL_CAP = 64;

interface Summary {
  tokens: TokenCounts;
  models: string[];
}

// Resolves with the input, or null when it is over the cap.
function readStdin(): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDIN_CAP) resolve(null);
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(null));
  });
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function addLine(line: string, sum: Summary): void {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const message = parsed?.message;
  if (!message || typeof message !== 'object') return;
  const usage = message.usage;
  if (usage && typeof usage === 'object') {
    sum.tokens.input += num(usage.input_tokens);
    sum.tokens.output += num(usage.output_tokens);
    sum.tokens.cacheRead += num(usage.cache_read_input_tokens);
    sum.tokens.cacheCreation += num(usage.cache_creation_input_tokens);
  }
  const model = message.model;
  if (typeof model === 'string' && /^[\w.:-]+$/.test(model) && !sum.models.includes(model)) {
    sum.models.push(model.slice(0, MODEL_CAP));
  }
}

/** Sums usage and collects model ids from a transcript; reads at most 50 MB. */
export async function summarizeTranscript(file: string): Promise<Summary | null> {
  const sum: Summary = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    models: [],
  };
  try {
    const stream = fs.createReadStream(file, { end: TRANSCRIPT_CAP - 1 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) addLine(line, sum);
    return sum;
  } catch {
    return null;
  }
}

async function withTranscript(event: ActivityEvent, payload: any): Promise<void> {
  const file = payload?.agent_transcript_path;
  if (event.kind !== 'agent' || event.data.phase !== 'stop' || typeof file !== 'string') return;
  const sum = await summarizeTranscript(file);
  if (!sum) return;
  event.data.tokens = sum.tokens;
  if (sum.models.length) event.data.models = sum.models;
}

async function record(targetDir?: string): Promise<void> {
  if (process.env.NATIV_RUN_ID) return;
  const text = await readStdin();
  if (!text) return;
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  const event = fromHookPayload(payload, process.env);
  if (!event) return;
  await withTranscript(event, payload);
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  appendEvent(resolveMainRoot(targetDir ?? cwd), event);
}

/** Hook entry: records one activity event; prints nothing and never fails. */
export async function runHookEvent(targetDir?: string): Promise<void> {
  const timer = setTimeout(() => process.exit(0), GIVE_UP_MS);
  try {
    await record(targetDir);
  } catch {
    // A hook must never fail the call it observes.
  }
  clearTimeout(timer);
  process.stdin.destroy();
}
