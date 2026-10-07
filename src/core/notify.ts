import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { writeJsonAtomicSync } from './lock-manager.js';

/**
 * nativ · Tells a person when the workflow needs them, through a webhook (Slack, Discord, ntfy, any JSON
 * endpoint) or a local command. Configured in `.nativ/config.json` (git-ignored, so a webhook secret stays
 * local) as `"notify": { "webhook": "...", "command": "...", "events": [...] }`, or NATIV_NOTIFY_WEBHOOK /
 * NATIV_NOTIFY_COMMAND. Delivery is best-effort and never fails the command that triggered it.
 */

export type NotifyEvent = 'human_decision' | 'circuit_breaker_tripped';
export const NOTIFY_EVENTS: readonly NotifyEvent[] = ['human_decision', 'circuit_breaker_tripped'];

export interface NotifyConfig {
  webhook?: string;
  command?: string;
  /** Set when a configured webhook was refused (not https, or plain http off this machine). */
  rejectedWebhook?: string;
  events: NotifyEvent[];
}

export interface NotifyInput {
  event: NotifyEvent;
  taskId: string;
  escalationId?: string;
  summary: string;
  question?: string;
  options?: string[];
}

export interface NotifyResult {
  sent: boolean;
  skipped?: 'not_configured' | 'event_disabled' | 'already_sent';
  errors: string[];
}

export interface NotifyDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Resend even when this event was already delivered (used by `nativ notify test`). */
  force?: boolean;
}

const WEBHOOK_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const stateFile = (root: string) => path.join(root, '.nativ', 'notify-state.json');

/** Plain http would send the payload, and often a token in the URL, in the clear; it is allowed only to this machine. */
export function isAllowedWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

export function loadNotifyConfig(root: string, env: NodeJS.ProcessEnv = process.env): NotifyConfig | null {
  let file: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.nativ', 'config.json'), 'utf8'));
    if (parsed && typeof parsed.notify === 'object' && parsed.notify) file = parsed.notify;
  } catch {
    // No config file, or an unreadable one: notifications stay off unless the environment sets them.
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const webhook = str(env.NATIV_NOTIFY_WEBHOOK) ?? str(file.webhook);
  const command = str(env.NATIV_NOTIFY_COMMAND) ?? str(file.command);
  const listed = Array.isArray(file.events) ? file.events.filter((e): e is NotifyEvent => NOTIFY_EVENTS.includes(e)) : [];
  if (!webhook && !command) return null;
  return {
    ...(webhook && isAllowedWebhook(webhook) ? { webhook } : {}),
    ...(webhook && !isAllowedWebhook(webhook) ? { rejectedWebhook: webhook } : {}),
    ...(command ? { command } : {}),
    events: listed.length ? listed : [...NOTIFY_EVENTS],
  };
}

function buildPayload(root: string, input: NotifyInput) {
  const project = path.basename(root);
  const nextStep = input.escalationId ? `nativ triage ${input.escalationId}` : `nativ status`;
  const lines = [`nativ [${project}] needs you: ${input.summary}`, `Task ${input.taskId}${input.escalationId ? `, ${input.escalationId}` : ''}.`];
  if (input.question) lines.push(input.question);
  if (input.options?.length) lines.push(`Options: ${input.options.join(' | ')}`);
  lines.push(`Next: ${nextStep}`);
  const text = lines.join('\n');
  // `text` suits Slack and ntfy, `content` suits Discord; the structured fields suit everything else.
  return { ...input, project, nextStep, at: new Date().toISOString(), text, content: text };
}

function readSent(root: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    return parsed && typeof parsed.sent === 'object' ? parsed.sent : {};
  } catch {
    return {};
  }
}

function runCommand(command: string, payload: object): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, NATIV_NOTIFY_JSON: body },
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve('command timed out');
    }, COMMAND_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`command failed: ${err.message}`);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : `command exited with ${code}`);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(body);
  });
}

export async function notifyHuman(root: string, input: NotifyInput, deps: NotifyDeps = {}): Promise<NotifyResult> {
  const config = loadNotifyConfig(root, deps.env);
  if (!config) return { sent: false, skipped: 'not_configured', errors: [] };
  if (!config.events.includes(input.event)) return { sent: false, skipped: 'event_disabled', errors: [] };

  const key = `${input.event}:${input.escalationId ?? input.taskId}`;
  const sent = readSent(root);
  if (sent[key] && !deps.force) return { sent: false, skipped: 'already_sent', errors: [] };

  const payload = buildPayload(root, input);
  const errors: string[] = config.rejectedWebhook ? ['webhook must be an https:// URL (plain http only to localhost)'] : [];
  let delivered = false;

  if (config.webhook) {
    try {
      const res = await (deps.fetch ?? fetch)(config.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (res.ok) delivered = true;
      else errors.push(`webhook answered ${res.status}`);
    } catch (err) {
      errors.push(`webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (config.command) {
    const error = await runCommand(config.command, payload);
    if (error) errors.push(error);
    else delivered = true;
  }

  try {
    const next = { ...readSent(root), ...(delivered ? { [key]: payload.at } : {}) };
    writeJsonAtomicSync(stateFile(root), { sent: next, ...(errors.length ? { lastError: { at: payload.at, errors } } : {}) });
  } catch {
    // The state file only prevents repeats; failing to write it must not fail the caller.
  }
  return { sent: delivered, errors };
}
