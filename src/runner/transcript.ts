import fs from 'node:fs';
import path from 'node:path';
import { MASK } from '../db/env-parser.js';
import { redactSecrets } from '../core/redact.js';

export const TRANSCRIPT_VERSION = 1;
export const DEFAULT_MAX_TRANSCRIPTS = 200;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FIELD_CHARS = 20_000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 200;
const SECRET_KEY = /pass(word|wd)|pwd|secret|token|api[_-]?key|access[_-]?key|authorization/i;
const RESERVED = ['v', 'seq', 'at', 'type'];

export type TranscriptType =
  | 'run_start' | 'prompt' | 'session' | 'assistant_text' | 'thinking' | 'tool_call'
  | 'tool_result' | 'usage' | 'note' | 'truncated' | 'run_end';

export type TranscriptFields = Record<string, unknown>;
/** An event before the writer stamps it with a version, an order number and a time. */
export type TranscriptPart = [TranscriptType, TranscriptFields];
export type TranscriptEvent = TranscriptFields & { v: number; seq: number; at: string; type: string };

export const transcriptDir = (root: string): string => path.join(root, '.nativ', 'runs', 'transcripts');
export const transcriptFile = (root: string, runId: string): string =>
  path.join(transcriptDir(root), `${runId}.jsonl`);

/** On unless .nativ/config.json says `"transcripts": false`; an unreadable file keeps it on. */
export function transcriptsEnabled(root: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.nativ', 'config.json'), 'utf8'));
    return raw?.transcripts !== false;
  } catch {
    return true;
  }
}

/** Keeps the start and the end of long text: errors and results usually sit at the end. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-(max - head))}`;
}

interface ScrubContext {
  secrets: string[];
  maxChars: number;
}

function scrub(value: unknown, depth: number, ctx: ScrubContext): unknown {
  if (typeof value === 'string') return clip(redactSecrets(value, ctx.secrets), ctx.maxChars);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_DEPTH) return '[...]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((v) => scrub(v, depth + 1, ctx));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as object).slice(0, MAX_ITEMS)) {
    if (v === undefined) continue;
    // A field named like a credential is masked whole, since its value has no pattern to match.
    out[key] = typeof v === 'string' && SECRET_KEY.test(key) ? MASK : scrub(v, depth + 1, ctx);
  }
  return out;
}

export interface TranscriptOptions {
  /** Exact values (API keys) to mask wherever they appear. */
  secrets?: string[];
  maxBytes?: number;
  maxFieldChars?: number;
}

/**
 * Appends one JSON line per event. Recording is advisory: nothing here may throw into a run,
 * so a read-only folder or a full disk just stops the recording.
 */
export class TranscriptWriter {
  private seq = 0;
  private bytes = 0;
  private full = false;
  private closed = false;
  private broken = false;

  constructor(readonly file: string, private readonly options: TranscriptOptions = {}) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '', 'utf8');
    } catch {
      this.broken = true;
    }
  }

  write(type: TranscriptType, fields: TranscriptFields = {}): void {
    if (this.broken || this.closed) return;
    // The closing event always lands, so a capped transcript still says how the run ended.
    if (this.full && type !== 'run_end') return;
    const line = this.render(type, fields);
    if (line === null) return;
    const max = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (type !== 'run_end' && this.bytes + Buffer.byteLength(line, 'utf8') > max) {
      this.full = true;
      const marker = this.render('truncated', { reason: `The transcript reached ${max} bytes.` });
      if (marker) this.append(marker);
      return;
    }
    this.append(line);
    if (type === 'run_end') this.closed = true;
  }

  writeParts(parts: TranscriptPart[]): void {
    for (const [type, fields] of parts) this.write(type, fields);
  }

  private render(type: TranscriptType, fields: TranscriptFields): string | null {
    try {
      const ctx = { secrets: this.options.secrets ?? [], maxChars: this.options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS };
      const body = scrub(fields, 0, ctx) as TranscriptFields;
      for (const key of RESERVED) delete body[key];
      return `${JSON.stringify({ v: TRANSCRIPT_VERSION, seq: ++this.seq, at: new Date().toISOString(), type, ...body })}\n`;
    } catch {
      return null;
    }
  }

  private append(line: string): void {
    try {
      fs.appendFileSync(this.file, line, 'utf8');
      this.bytes += Buffer.byteLength(line, 'utf8');
    } catch {
      this.broken = true;
    }
  }
}

/** Deletes the oldest transcripts beyond `keep`, so recording never grows without bound. */
export function pruneTranscripts(dir: string, keep: number = DEFAULT_MAX_TRANSCRIPTS): number {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    let removed = 0;
    for (const { f } of files.slice(Math.max(0, keep))) {
      try {
        fs.rmSync(path.join(dir, f));
        removed++;
      } catch {
        // A file in use stays; the next run prunes again.
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

// ─── Mapping the two engines onto one event format ─────────────────────────────

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
}

/** Assistant content blocks. The Messages API and Claude Code's stream use the same shape. */
export function blockParts(blocks: unknown): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && String(block.text ?? '').trim()) parts.push(['assistant_text', { text: block.text }]);
    else if (block?.type === 'thinking' && String(block.thinking ?? '').trim()) parts.push(['thinking', { text: block.thinking }]);
    else if (block?.type === 'tool_use') parts.push(['tool_call', { id: block.id, name: block.name, input: block.input }]);
  }
  return parts;
}

function resultParts(content: unknown): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type !== 'tool_result') continue;
    parts.push(['tool_result', { id: block.tool_use_id, isError: Boolean(block.is_error), output: textOf(block.content) }]);
  }
  return parts;
}

/** One line of `claude -p --output-format stream-json` as events. Anything unrecognised is dropped. */
export function streamLineParts(line: string): TranscriptPart[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return [['note', { text: trimmed }]];
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return [['note', { text: trimmed }]];

  switch (event.type) {
    case 'system':
      if (event.subtype !== 'init') return [];
      return [['session', {
        model: event.model,
        tools: Array.isArray(event.tools) ? event.tools.length : undefined,
        sessionId: event.session_id,
      }]];
    case 'assistant':
      return blockParts(event.message?.content);
    case 'user':
      return resultParts(event.message?.content);
    case 'result': {
      const u = event.usage ?? {};
      return [['usage', {
        scope: 'run',
        subtype: event.subtype,
        isError: Boolean(event.is_error),
        turns: count(event.num_turns),
        durationMs: count(event.duration_ms),
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        inputTokens: count(u.input_tokens),
        outputTokens: count(u.output_tokens),
        cacheCreationTokens: count(u.cache_creation_input_tokens),
        cacheReadTokens: count(u.cache_read_input_tokens),
      }]];
    }
    default:
      return [];
  }
}
