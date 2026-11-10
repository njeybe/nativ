import { MASK } from '../db/env-parser.js';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Connection strings: scheme://user:password@host keeps everything but the password.
  // The user may be empty (redis://:password@host) and raw passwords may contain '/'.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"']*:)[^\s@"']+@/gi, `$1${MASK}@`],
  // key=value / "key": "value" credentials, including prefixed and suffixed names such as DB_PASSWORD,
  // dbPassword or SECRET_KEY; contract field declarations such as "token": "string" stay readable.
  [/\b(\w*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\w*["']?\s*[:=]\s*["']?)(?!(?:string|number|boolean|integer|object|array|null|true|false)\b)[^\s"'&,;]+/gi, `$1${MASK}`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, `$1${MASK}`],
  // JSON Web Tokens: header.payload.signature, each part base64url.
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
];

/**
 * Masks connection-string passwords, credential assignments and well-known key formats before
 * text leaves the machine. `extraSecrets` (e.g. the Gemini key itself) are masked verbatim.
 */
export function redactSecrets(text: string, extraSecrets: string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join(MASK);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
