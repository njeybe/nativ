import crypto from 'node:crypto';
import type http from 'node:http';
import { HttpError } from './http-utils.js';

export const STUDIO_KEY_COOKIE = 'nativ_studio_key';
const KEY_BYTES = 32;

/** Proof that a person opened the Studio page. The key lives in a closure, never on a property. */
export interface HumanSession {
  /** False for a headless start: no key exists and every guarded route refuses. */
  readonly keyed: boolean;
  /** Constant-time check of a candidate key; false for a missing or wrong-length value. */
  matches(candidate: string | undefined | null): boolean;
  /** The launch link with the key, or the plain URL when headless. Only for the opener's terminal. */
  launchUrl(baseUrl: string): string;
  /** The Set-Cookie value that hands the key to the browser. Null when headless. */
  cookie(): string | null;
}

/** An interactive start makes 32 random bytes held in memory only; a headless one makes none. */
export function createStudioSession(options: { headless?: boolean } = {}): HumanSession {
  const key = options.headless ? null : crypto.randomBytes(KEY_BYTES).toString('hex');
  const expected = key ? Buffer.from(key, 'utf8') : null;
  return {
    keyed: key !== null,
    matches(candidate) {
      if (!expected || typeof candidate !== 'string') return false;
      const given = Buffer.from(candidate, 'utf8');
      // timingSafeEqual throws on unequal lengths, so a wrong-length value is refused first.
      if (given.length !== expected.length) return false;
      return crypto.timingSafeEqual(given, expected);
    },
    launchUrl(baseUrl) {
      if (!key) return baseUrl;
      const url = new URL(baseUrl);
      url.searchParams.set('key', key);
      return url.toString();
    },
    cookie() {
      return key ? `${STUDIO_KEY_COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/` : null;
    },
  };
}

/** Parses a Cookie header; the first value wins when a name repeats. */
export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = Array.isArray(header) ? header.join(';') : (header ?? '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

/** True when the request carries the session key cookie. */
export function hasHumanKey(req: http.IncomingMessage, session: HumanSession): boolean {
  return session.matches(parseCookies(req.headers.cookie).get(STUDIO_KEY_COOKIE));
}

/** Guard for decision routes: throws 403 HUMAN_KEY_REQUIRED unless the key cookie matches. */
export function requireHuman(req: http.IncomingMessage, session: HumanSession): void {
  if (!hasHumanKey(req, session)) {
    throw new HttpError(403, 'HUMAN_KEY_REQUIRED', 'This decision needs the Studio opened from its launch link');
  }
}

/** GET /api/pipeline/session body. */
export function sessionView(req: http.IncomingMessage, session: HumanSession) {
  return { ok: true, human: hasHumanKey(req, session) };
}

/** GET /?key=: a right key sets the cookie and 303s to / so the key leaves the address bar.
 * Returns false (serve the page, no cookie) for a missing or wrong key. */
export function acceptLaunchKey(res: http.ServerResponse, url: URL, session: HumanSession): boolean {
  const cookie = session.cookie();
  if (!cookie || !session.matches(url.searchParams.get('key'))) return false;
  res.writeHead(303, { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}
