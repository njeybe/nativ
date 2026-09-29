import fs from 'node:fs';
import path from 'node:path';
import type {
  ComponentEngine,
  ConnectionComponents,
  DatabaseEngine,
  DatabaseEnv,
  DetectedTemplateKey,
  FirestoreConfig,
  FragmentedConfig,
  TemplateDetectionResult,
} from './types.js';

/**
 * Safe environment parser.
 * Reads .env files locally so connection strings stay in-memory inside the nativ
 * process. Nothing returned here for display purposes contains credentials —
 * always pass URLs through maskConnectionString() before rendering them.
 */

export const MASK = '••••••••';

/** Env files scanned in order; later files override earlier ones. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local'];

/** Template files scanned to detect project-specific connection variables. */
export const EXAMPLE_ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults'];

const DEV_KEYS = [
  'NATIV_DEV_DATABASE_URL',
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
  'NATIV_PROD_DATABASE_URL',
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
  detectedFromExample?: boolean;
  exampleFile?: string | null;
  suggestion?: string | null;
  /** True when assembled from fragmented DB_HOST/DB_DATABASE-style keys. */
  synthesized?: boolean;
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
 * Scans template environment files (.env.example, .env.sample, .env.template, .env.defaults, .env.dist)
 * to detect project-specific connection string variables, implied database engines, and whether
 * the variables are configured in the current environment.
 */
export function detectExampleDbKeys(cwd: string = process.cwd()): TemplateDetectionResult {
  let templateFile: string | null = null;
  let rawContent: string | null = null;

  for (const file of EXAMPLE_ENV_FILES) {
    const full = path.join(cwd, file);
    try {
      if (fs.existsSync(full)) {
        templateFile = file;
        rawContent = fs.readFileSync(full, 'utf8');
        break;
      }
    } catch {
      // Unreadable file — ignore safely.
    }
  }

  const fragmented = synthesizeConnectionFromComponents(loadComponentVars(cwd), 'dev');
  const fragmentedInfo = { fragmentedDetected: Boolean(fragmented), fragmentedConfig: fragmented?.config ?? null };

  if (!templateFile || !rawContent) {
    return {
      templateFound: false,
      templateFile: null,
      detectedKeys: [],
      missingKeys: [],
      ...fragmentedInfo,
    };
  }

  const envVars = loadEnvFiles(cwd);
  const detectedKeys: DetectedTemplateKey[] = [];
  const lines = rawContent.split(/\r?\n/);

  let lastComment = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      lastComment = '';
      continue;
    }
    if (line.startsWith('#')) {
      lastComment += ' ' + line.slice(1).trim();
      continue;
    }

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!match) {
      lastComment = '';
      continue;
    }

    const key = match[1];
    let exampleVal = match[2].trim();
    if ((exampleVal.startsWith('"') || exampleVal.startsWith("'") || exampleVal.startsWith('`')) && exampleVal.length > 1) {
      const quote = exampleVal[0];
      const end = exampleVal.indexOf(quote, 1);
      exampleVal = end === -1 ? exampleVal.slice(1) : exampleVal.slice(1, end);
    } else {
      const hash = exampleVal.search(/\s#/);
      if (hash !== -1) exampleVal = exampleVal.slice(0, hash).trim();
    }

    let engine: DatabaseEngine | null = null;
    let isDbKey = false;

    if (exampleVal) {
      engine = detectEngine(exampleVal);
      if (engine) isDbKey = true;
    }

    const upperKey = key.toUpperCase();
    const isProdKey = /PROD|PRODUCTION|LIVE/.test(upperKey);
    const targetEnv: DatabaseEnv = isProdKey ? 'prod' : 'dev';

    const isDbKeyword = /(?:^|_)(DB|DATABASE|MONGO|MONGODB|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|SQLITE|FIRESTORE)(?:_|$)/i.test(key);
    const isConnKeyword = /(URL|URI|DSN|CONN|CONNECTION|STRING|HOST|PATH|FILE)/i.test(key);

    if (isDbKeyword && (isConnKeyword || !exampleVal || upperKey.includes('URL') || upperKey.includes('URI'))) {
      isDbKey = true;
      if (!engine) {
        if (/MONGO/i.test(key)) engine = 'mongodb';
        else if (/POSTGRES|PG/i.test(key)) engine = 'postgresql';
        else if (/MYSQL|MARIADB/i.test(key)) engine = 'mysql';
        else if (/SQLITE/i.test(key)) engine = 'sqlite';
        else if (/FIRESTORE/i.test(key)) engine = 'firestore';
      }
    } else if (
      /^(DATABASE_URL|MONGO_URI|MONGODB_URI|MONGO_URL|POSTGRES_URL|POSTGRESQL_URL|PG_URL|MYSQL_URL|SQLITE_URL|SQLITE_DB|FIRESTORE_URL|DB_URL|DB_URI|DB_CONNECTION)$/i.test(
        key,
      )
    ) {
      isDbKey = true;
      if (!engine) {
        if (/MONGO/i.test(key)) engine = 'mongodb';
        else if (/POSTGRES|PG/i.test(key)) engine = 'postgresql';
        else if (/MYSQL/i.test(key)) engine = 'mysql';
        else if (/SQLITE/i.test(key)) engine = 'sqlite';
        else if (/FIRESTORE/i.test(key)) engine = 'firestore';
      }
    }

    if (isDbKey && !engine && lastComment) {
      if (/mongo/i.test(lastComment)) engine = 'mongodb';
      else if (/postgres/i.test(lastComment)) engine = 'postgresql';
      else if (/mysql/i.test(lastComment)) engine = 'mysql';
      else if (/sqlite/i.test(lastComment)) engine = 'sqlite';
      else if (/firestore/i.test(lastComment)) engine = 'firestore';
    }

    if (isDbKey) {
      const isConfigured = Boolean(envVars[key]?.trim() || process.env[key]?.trim());
      detectedKeys.push({
        key,
        targetEnv,
        engine,
        exampleValue: exampleVal || undefined,
        isConfiguredInEnv: isConfigured,
      });
    }

    lastComment = '';
  }

  const missingKeys = detectedKeys.filter((k) => !k.isConfiguredInEnv);

  return {
    templateFound: true,
    templateFile,
    detectedKeys,
    missingKeys,
    ...fragmentedInfo,
  };
}

/**
 * Fragmented connection key families (Laravel/XAMPP/PHP, Docker images, libpq), checked in order.
 * Each slot lists aliases; the first configured alias wins.
 */
interface ComponentKeyFamily {
  connection: string[];
  host: string[];
  port: string[];
  user: string[];
  password: string[];
  database: string[];
  /** Engine implied by the family itself (e.g. PG* keys), used when no connection key is set. */
  impliedEngine?: ComponentEngine;
}

const COMPONENT_FAMILIES: Record<DatabaseEnv, ComponentKeyFamily[]> = {
  dev: [
    {
      connection: ['DB_CONNECTION', 'DB_DRIVER', 'DB_ENGINE', 'DB_TYPE', 'DB_DIALECT'],
      host: ['DB_HOST', 'DB_HOSTNAME', 'DB_SERVER'],
      port: ['DB_PORT'],
      user: ['DB_USERNAME', 'DB_USER'],
      password: ['DB_PASSWORD', 'DB_PASS'],
      database: ['DB_DATABASE', 'DB_NAME'],
    },
    {
      connection: [],
      host: ['MYSQL_HOST'],
      port: ['MYSQL_PORT'],
      user: ['MYSQL_USER', 'MYSQL_USERNAME'],
      password: ['MYSQL_PASSWORD'],
      database: ['MYSQL_DATABASE', 'MYSQL_DB'],
      impliedEngine: 'mysql',
    },
    {
      connection: [],
      host: ['POSTGRES_HOST', 'PGHOST'],
      port: ['POSTGRES_PORT', 'PGPORT'],
      user: ['POSTGRES_USER', 'PGUSER'],
      password: ['POSTGRES_PASSWORD', 'PGPASSWORD'],
      database: ['POSTGRES_DB', 'POSTGRES_DATABASE', 'PGDATABASE'],
      impliedEngine: 'postgresql',
    },
  ],
  prod: [
    {
      connection: ['PROD_DB_CONNECTION', 'PROD_DB_DRIVER'],
      host: ['PROD_DB_HOST'],
      port: ['PROD_DB_PORT'],
      user: ['PROD_DB_USERNAME', 'PROD_DB_USER'],
      password: ['PROD_DB_PASSWORD', 'PROD_DB_PASS'],
      database: ['PROD_DB_DATABASE', 'PROD_DB_NAME'],
    },
  ],
};

/** Every key that can take part in synthesis, so process.env can override .env values for them. */
const ALL_COMPONENT_KEYS = [
  ...new Set(
    Object.values(COMPONENT_FAMILIES)
      .flat()
      .flatMap((f) => [...f.connection, ...f.host, ...f.port, ...f.user, ...f.password, ...f.database]),
  ),
];

export const DEFAULT_PORTS: Record<ComponentEngine, number> = { mysql: 3306, postgresql: 5432 };

/** Maps a DB_CONNECTION-style driver name (mysql, mariadb, pgsql, postgres…) to an engine. */
export function componentEngineFromDriver(driver: string | null | undefined): ComponentEngine | null {
  const d = (driver ?? '').trim().toLowerCase();
  if (!d) return null;
  if (/^(mysql|mysql2|mysqli|mariadb|pdo_mysql)$/.test(d)) return 'mysql';
  if (/^(pgsql|postgres|postgresql|pg|pdo_pgsql)$/.test(d)) return 'postgresql';
  return null;
}

/**
 * Assembles a connection URL from discrete parameters, percent-encoding credentials and database name.
 * The result contains the raw password: pass it through maskConnectionString() before display.
 */
export function connectionUrlFromComponents(components: ConnectionComponents): string {
  const engine = componentEngineFromDriver(components.engine);
  if (!engine) throw new Error(`Unsupported engine for parameter connection: ${String(components.engine)} (expected mysql or postgresql)`);
  const host = (components.host ?? '').trim();
  if (!host) throw new Error('Parameter connection requires a host');
  if (/[\s/@?#]/.test(host)) throw new Error('Host must not contain whitespace or URL delimiters');
  const port = components.port ?? DEFAULT_PORTS[engine];
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${String(components.port)}`);

  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const user = components.user?.trim() ?? '';
  const password = components.password ?? '';
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@` : '';
  const database = components.database?.trim() ?? '';
  const dbPart = database ? `/${encodeURIComponent(database)}` : '';
  const scheme = engine === 'mysql' ? 'mysql' : 'postgresql';
  return `${scheme}://${auth}${hostPart}:${port}${dbPart}`;
}

export interface SynthesizedConnection {
  /** Raw URL. Never log, print, or serialize this value. */
  url: string;
  engine: ComponentEngine;
  /** Primary key shown as the source (the host or database key). */
  sourceKey: string;
  config: FragmentedConfig;
}

/**
 * Detects fragmented DB_HOST / DB_PORT / DB_DATABASE / DB_USERNAME / DB_PASSWORD / DB_CONNECTION keys
 * (plus MYSQL_* and POSTGRES_* / PG* families) and assembles a MySQL or PostgreSQL URL in-memory.
 * Returns null when no family has a host or database configured, or the driver is not MySQL/PostgreSQL
 * (e.g. Laravel's DB_CONNECTION=sqlite).
 */
export function synthesizeConnectionFromComponents(
  vars: Record<string, string>,
  env: DatabaseEnv = 'dev',
): SynthesizedConnection | null {
  for (const family of COMPONENT_FAMILIES[env]) {
    const connection = pick(vars, family.connection);
    const host = pick(vars, family.host);
    const database = pick(vars, family.database);
    if (!host && !database) continue;

    const port = pick(vars, family.port);
    const portNum = port && /^\d+$/.test(port.value) ? Number(port.value) : undefined;

    let engine: ComponentEngine | null;
    if (connection) {
      engine = componentEngineFromDriver(connection.value);
      if (!engine) continue; // Explicit non-MySQL/PostgreSQL driver: not ours to synthesize.
    } else {
      engine = family.impliedEngine ?? (portNum === DEFAULT_PORTS.postgresql ? 'postgresql' : 'mysql');
    }

    const user = pick(vars, family.user);
    // Empty passwords are valid (XAMPP root), so read the raw value rather than pick().
    const passwordKey = family.password.find((k) => vars[k] !== undefined);
    const password = passwordKey ? vars[passwordKey] : undefined;

    const components: ConnectionComponents = {
      engine,
      host: host?.value || '127.0.0.1',
      ...(portNum ? { port: portNum } : {}),
      ...(user ? { user: user.value } : {}),
      ...(password ? { password } : {}),
      ...(database ? { database: database.value } : {}),
    };

    let url: string;
    try {
      url = connectionUrlFromComponents(components);
    } catch {
      continue;
    }

    const sourceKeys = [connection, host, port, user, database]
      .filter((x): x is { key: string; value: string } => Boolean(x))
      .map((x) => x.key);
    if (passwordKey) sourceKeys.push(passwordKey);

    return {
      url,
      engine,
      sourceKey: (host ?? database)!.key,
      config: {
        env,
        engine,
        host: components.host,
        port: components.port ?? DEFAULT_PORTS[engine],
        user: components.user ?? null,
        database: components.database ?? null,
        hasPassword: Boolean(password),
        sourceKeys,
        maskedUrl: maskConnectionString(url),
      },
    };
  }
  return null;
}

/** Merges .env files with process.env overrides for all fragmented component keys. */
function loadComponentVars(cwd: string): Record<string, string> {
  const vars = loadEnvFiles(cwd);
  for (const key of ALL_COMPONENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) vars[key] = value;
  }
  return vars;
}

export interface ResolvedConnectionsResult {
  dev: ResolvedConnection | null;
  prod: ResolvedConnection | null;
  templateInfo: TemplateDetectionResult;
}

/**
 * Resolves Dev and Prod connection URLs from .env files, with process.env taking precedence
 * and template files (.env.example) dynamically prioritizing custom keys.
 * Returns null for an environment with no configured or recognizable URL.
 */
export function resolveConnections(cwd: string = process.cwd()): ResolvedConnectionsResult {
  const templateInfo = detectExampleDbKeys(cwd);
  const vars: Record<string, string> = { ...loadEnvFiles(cwd) };

  const templateDevKeys = templateInfo.detectedKeys.filter((k) => k.targetEnv === 'dev').map((k) => k.key);
  const templateProdKeys = templateInfo.detectedKeys.filter((k) => k.targetEnv === 'prod').map((k) => k.key);

  const effectiveDevKeys = [...new Set([...templateDevKeys, ...DEV_KEYS])];
  const effectiveProdKeys = [...new Set([...templateProdKeys, ...PROD_KEYS])];

  for (const key of [...effectiveDevKeys, ...effectiveProdKeys, ...FIRESTORE_EMULATOR_KEYS]) {
    const value = process.env[key];
    if (value) vars[key] = value;
  }

  const toConnection = (env: DatabaseEnv, url: string, sourceKey: string): ResolvedConnection | null => {
    const engine = detectEngine(url);
    if (!engine) return null;
    const isFromExample = templateInfo.detectedKeys.some((k) => k.key === sourceKey);
    return {
      env,
      url,
      engine,
      maskedUrl: maskConnectionString(url),
      sourceKey,
      detectedFromExample: isFromExample,
      exampleFile: isFromExample ? templateInfo.templateFile : null,
    };
  };

  // Skip keys whose value is not a connection URL (e.g. a template's DB_HOST=127.0.0.1 or DB_CONNECTION=mysql).
  const build = (env: DatabaseEnv, keys: string[]): ResolvedConnection | null => {
    for (const key of keys) {
      const value = vars[key]?.trim();
      const conn = value ? toConnection(env, value, key) : null;
      if (conn) return conn;
    }
    return null;
  };

  const componentVars = loadComponentVars(cwd);
  const synthesize = (env: DatabaseEnv): ResolvedConnection | null => {
    const synthesized = synthesizeConnectionFromComponents(componentVars, env);
    const conn = synthesized ? toConnection(env, synthesized.url, synthesized.sourceKey) : null;
    return conn ? { ...conn, synthesized: true } : null;
  };

  let dev = build('dev', effectiveDevKeys);
  // Firestore emulator convention: FIRESTORE_EMULATOR_HOST + a project id implies a local Dev database.
  const emulatorHost = vars.FIRESTORE_EMULATOR_HOST?.trim();
  const projectId = (vars.FIRESTORE_PROJECT_ID || vars.GCLOUD_PROJECT || vars.GOOGLE_CLOUD_PROJECT || '').trim();
  if (!dev && emulatorHost && projectId) {
    dev = toConnection('dev', firestoreUrlFromConfig({ projectId, emulatorHost }), 'FIRESTORE_EMULATOR_HOST');
  }
  // No single URI configured: assemble one from fragmented DB_HOST / DB_DATABASE-style keys.
  dev ??= synthesize('dev');

  return { dev, prod: build('prod', effectiveProdKeys) ?? synthesize('prod'), templateInfo };
}
