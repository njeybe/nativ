import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseEngine, DatabaseEnv, FirestoreConfig } from './types.js';

/**
 * Safe environment parser.
 * Reads .env files locally so connection strings stay in-memory inside the agentj
 * process. Nothing returned here for display purposes contains credentials —
 * always pass URLs through maskConnectionString() before rendering them.
 */

export const MASK = '••••••••';

/** Env files scanned in order; later files override earlier ones. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local'];

const DEV_KEYS = [
  'AGENTJ_DEV_DATABASE_URL',
  'DEV_DATABASE_URL',
  'DATABASE_URL_DEV',
  'DEV_MONGODB_URI',
  'DEV_FIRESTORE_URL',
  'DATABASE_URL',
  'MONGODB_URI',
  'MONGO_URL',
  'FIRESTORE_URL',
];
const PROD_KEYS = [
  'AGENTJ_PROD_DATABASE_URL',
  'PROD_DATABASE_URL',
  'DATABASE_URL_PROD',
  'PRODUCTION_DATABASE_URL',
  'PROD_MONGODB_URI',
  'PROD_FIRESTORE_URL',
];
/** Standard Firestore emulator variables: used to build a Dev URL when no explicit one is set. */
const FIRESTORE_EMULATOR_KEYS = ['FIRESTORE_EMULATOR_HOST', 'FIRESTORE_PROJECT_ID', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'];

export interface ResolvedConnection {
  env: DatabaseEnv;
  /** Raw URL. Never log, print, or serialize this value. */
  url: string;
  engine: DatabaseEngine;
  maskedUrl: string;
  sourceKey: string;
}

/** Parses dotenv-formatted text into key/value pairs without touching process.env. */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.length > 1) {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/** Loads and merges all known .env files in `cwd`. Missing/unreadable files are skipped. */
export function loadEnvFiles(cwd: string = process.cwd()): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of ENV_FILES) {
    const full = path.join(cwd, file);
    try {
      if (!fs.existsSync(full)) continue;
      Object.assign(merged, parseEnvContent(fs.readFileSync(full, 'utf8')));
    } catch {
      // Unreadable env file — ignore rather than surface its contents in an error.
    }
  }
  return merged;
}

/** Infers the database engine from a connection URL or file path. */
export function detectEngine(url: string): DatabaseEngine | null {
  const lower = url.trim().toLowerCase();
  if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return 'postgresql';
  if (lower.startsWith('mysql://') || lower.startsWith('mysql2://') || lower.startsWith('mariadb://')) return 'mysql';
  if (lower.startsWith('mongodb://') || lower.startsWith('mongodb+srv://')) return 'mongodb';
  if (lower.startsWith('firestore://')) return 'firestore';
  if (lower.startsWith('sqlite:') || lower.startsWith('file:') || /\.(db|sqlite|sqlite3)$/.test(lower) || lower === ':memory:') {
    return 'sqlite';
  }
  return null;
}

/** Resolves a SQLite URL (`sqlite:./x.db`, `file:./x.db`, or plain path) to a filesystem path. */
export function sqlitePathFromUrl(url: string, cwd: string = process.cwd()): string {
  let p = url.trim().replace(/^sqlite:(\/\/)?/i, '').replace(/^file:(\/\/)?/i, '');
  p = p.split('?')[0];
  if (p === ':memory:') return p;
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

/**
 * Firestore connection URL: `firestore://<projectId>[/<databaseId>][?emulator=<host:port>]`.
 * Credentials are never part of it: real projects use Application Default Credentials.
 */
export function parseFirestoreUrl(url: string): FirestoreConfig {
  const parsed = new URL(url.trim());
  const projectId = decodeURIComponent(parsed.hostname);
  if (!projectId) throw new Error('Firestore URL must include a project id: firestore://<projectId>');
  const databaseId = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, '')) || undefined;
  const emulatorHost = parsed.searchParams.get('emulator') || undefined;
  return { projectId, ...(databaseId ? { databaseId } : {}), ...(emulatorHost ? { emulatorHost } : {}) };
}

export function firestoreUrlFromConfig(config: FirestoreConfig): string {
  const db = config.databaseId && config.databaseId !== '(default)' ? `/${encodeURIComponent(config.databaseId)}` : '';
  const emulator = config.emulatorHost ? `?emulator=${config.emulatorHost}` : '';
  return `firestore://${encodeURIComponent(config.projectId)}${db}${emulator}`;
}

/** Query parameters that may carry credentials or signed-URL secrets. */
const SENSITIVE_PARAM = /pass|pwd|secret|token|key|auth|sig|signature|credential/i;

/**
 * Redacts credentials from a connection string.
 * `postgres://user:secret@host:5432/db?password=x` -> `postgres://user:••••••••@host:5432/db?password=••••••••`
 */
export function maskConnectionString(url: string | null | undefined): string {
  if (!url) return '';
  const trimmed = url.trim();
  if (detectEngine(trimmed) === 'sqlite') return trimmed.replace(/([?&](?:password|pwd|key)=)[^&]*/gi, `$1${MASK}`);

  try {
    const parsed = new URL(trimmed);
    if (parsed.password) parsed.password = 'MASKED_PLACEHOLDER';
    for (const key of [...parsed.searchParams.keys()]) {
      // authSource / authMechanism are non-secret MongoDB options; keep them readable.
      if (SENSITIVE_PARAM.test(key) && !/^auth(source|mechanism)$/i.test(key)) parsed.searchParams.set(key, 'MASKED_PLACEHOLDER');
    }
    return parsed.toString().replace(/MASKED_PLACEHOLDER/g, MASK);
  } catch {
    // Unparseable — fall back to regex redaction of anything between ':' and '@' after the scheme.
    return trimmed
      .replace(/(\/\/[^:/@]*:)[^@]*@/, `$1${MASK}@`)
      .replace(/([?&](?:password|pwd|secret|token|key|sig|signature)=)[^&]*/gi, `$1${MASK}`);
  }
}

/** Redacts signed-URL tokens from a media URL (e.g. Firebase Storage `?token=`, GCS `X-Goog-Signature`). */
export function redactMediaUrl(url: string): string {
  return maskConnectionString(url);
}

/** Extracts the database name (or SQLite file name / Firestore project) from a connection URL for display. */
export function databaseNameFromUrl(url: string): string {
  const engine = detectEngine(url);
  if (engine === 'sqlite') return path.basename(sqlitePathFromUrl(url));
  if (engine === 'firestore') {
    try {
      const cfg = parseFirestoreUrl(url);
      return cfg.databaseId ? `${cfg.projectId}/${cfg.databaseId}` : cfg.projectId;
    } catch {
      return '';
    }
  }
  try {
    return decodeURIComponent(new URL(url.trim()).pathname.replace(/^\//, '')) || '';
  } catch {
    // Multi-host URIs (mongodb://h1,h2/db) aren't WHATWG-parseable; take the path after the host list.
    const match = url.trim().match(/^[a-z0-9+.-]+:\/\/[^/?]*\/([^?#]*)/i);
    try {
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return match ? match[1] : '';
    }
  }
}

function pick(vars: Record<string, string>, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = vars[key];
    if (value && value.trim()) return { key, value: value.trim() };
  }
  return null;
}

/**
 * Resolves Dev and Prod connection URLs from .env files, with process.env taking precedence.
 * Returns null for an environment with no configured or recognizable URL.
 */
export function resolveConnections(cwd: string = process.cwd()): Record<DatabaseEnv, ResolvedConnection | null> {
  const vars: Record<string, string> = { ...loadEnvFiles(cwd) };
  for (const key of [...DEV_KEYS, ...PROD_KEYS, ...FIRESTORE_EMULATOR_KEYS]) {
    const value = process.env[key];
    if (value) vars[key] = value;
  }

  const toConnection = (env: DatabaseEnv, url: string, sourceKey: string): ResolvedConnection | null => {
    const engine = detectEngine(url);
    if (!engine) return null;
    return { env, url, engine, maskedUrl: maskConnectionString(url), sourceKey };
  };

  const build = (env: DatabaseEnv, keys: string[]): ResolvedConnection | null => {
    const found = pick(vars, keys);
    return found ? toConnection(env, found.value, found.key) : null;
  };

  let dev = build('dev', DEV_KEYS);
  // Firestore emulator convention: FIRESTORE_EMULATOR_HOST + a project id implies a local Dev database.
  const emulatorHost = vars.FIRESTORE_EMULATOR_HOST?.trim();
  const projectId = (vars.FIRESTORE_PROJECT_ID || vars.GCLOUD_PROJECT || vars.GOOGLE_CLOUD_PROJECT || '').trim();
  if (!dev && emulatorHost && projectId) {
    dev = toConnection('dev', firestoreUrlFromConfig({ projectId, emulatorHost }), 'FIRESTORE_EMULATOR_HOST');
  }

  return { dev, prod: build('prod', PROD_KEYS) };
}
