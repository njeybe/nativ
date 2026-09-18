import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  ComponentEngine,
  ConnectionComponents,
  ConnectResponse,
  DatabaseEngine,
  DatabaseEnv,
  DatabaseStatus,
  ExportContractResponse,
  FirestoreConfig,
  SchemaResponse,
  StatusResponse,
  TableSchema,
} from '../db/types.js';
import {
  connectionUrlFromComponents,
  detectEngine,
  detectExampleDbKeys,
  firestoreUrlFromConfig,
  maskConnectionString,
  resolveConnections,
} from '../db/env-parser.js';
import { disconnectedStatus, introspectDatabase, type IntrospectionResult } from '../db/introspector.js';
import {
  CONTRACT_SCHEMA_PATH,
  diffSchemas,
  loadContractEngine,
  loadContractTables,
  toContractDiff,
  type ContractSchemaDiff,
} from '../db/diff.js';
import { fetchData, insertRecord, updateRecord, deleteRecord } from '../db/data-engine.js';

/**
 * Embedded Studio HTTP server (native node:http).
 * Serves the REST endpoints from .ai/api_contracts.json plus the dashboard page.
 *
 * Air-gap rules: binds to loopback only, keeps raw connection URLs in this process's
 * memory, and only ever returns masked URLs in responses.
 */

export const DEFAULT_STUDIO_PORT = 4983;
const MAX_BODY_BYTES = 64 * 1024;
const CACHE_TTL_MS = 5000;
const ENVS: DatabaseEnv[] = ['dev', 'prod'];

export interface StudioServerOptions {
  port?: number;
  host?: string;
  cwd?: string;
  /** Dashboard HTML served at `/`. */
  html?: string | (() => string);
  /** Pre-seeded connection URLs; defaults to those resolved from .env files. */
  connections?: Partial<Record<DatabaseEnv, string | null>>;
}

export interface StudioServerHandle {
  server: http.Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where a session URL came from; shown as badges in status output. */
interface ConnectionMeta {
  sourceKey?: string;
  detectedFromExample?: boolean;
  exampleFile?: string | null;
  synthesized?: boolean;
}

/** In-memory studio session: raw URLs never leave this object except to database drivers. */
class StudioSession {
  private readonly urls: Record<DatabaseEnv, string | null> = { dev: null, prod: null };
  private readonly meta = new Map<DatabaseEnv, ConnectionMeta>();
  private readonly cache = new Map<DatabaseEnv, { at: number; result: IntrospectionResult }>();
  private readonly cwd: string;

  constructor(
    initial: Partial<Record<DatabaseEnv, string | null>>,
    cwd: string = process.cwd(),
    initialMeta?: Partial<Record<DatabaseEnv, ConnectionMeta | null>>,
  ) {
    this.cwd = cwd;
    for (const env of ENVS) {
      this.urls[env] = initial[env] ?? null;
      if (initialMeta?.[env]) this.meta.set(env, initialMeta[env]!);
    }
  }

  set(
    env: DatabaseEnv,
    url: string,
    result: IntrospectionResult,
    meta?: ConnectionMeta,
  ): void {
    this.urls[env] = url;
    if (meta) this.meta.set(env, meta);
    else this.meta.delete(env);
    this.cache.set(env, { at: Date.now(), result });
  }

  getUrl(env: DatabaseEnv): string | null {
    return this.urls[env];
  }

  invalidate(): void {
    this.cache.clear();
  }

  async introspect(env: DatabaseEnv, fresh = false): Promise<IntrospectionResult> {
    const url = this.urls[env];
    if (!url) {
      const conns = resolveConnections(this.cwd);
      const missingKey = conns.templateInfo?.missingKeys.find((k) => k.targetEnv === env);
      if (missingKey) {
        const engineLabel = missingKey.engine ? ` (${missingKey.engine})` : '';
        const templateName = conns.templateInfo?.templateFile ?? '.env.example';
        const suggestion = `Found "${missingKey.key}"${engineLabel} in ${templateName}, but it is not set in your .env`;
        return {
          status: disconnectedStatus(
            `No ${env === 'dev' ? 'Dev' : 'Prod'} database configured. ${suggestion}`,
            missingKey.engine ?? 'postgresql',
            '',
            {
              sourceKey: missingKey.key,
              detectedFromExample: true,
              exampleFile: templateName,
              suggestion,
            },
          ),
          tables: [],
        };
      }
      return {
        status: disconnectedStatus(
          `No ${env === 'dev' ? 'Dev' : 'Prod'} database configured. Use Connection Settings or set ${env.toUpperCase()}_DATABASE_URL.`,
        ),
        tables: [],
      };
    }
    const cached = this.cache.get(env);
    if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;
    const result = await introspectDatabase(url);
    const m = this.meta.get(env);
    if (m) {
      result.status.sourceKey = m.sourceKey;
      result.status.detectedFromExample = m.detectedFromExample;
      result.status.exampleFile = m.exampleFile;
      if (m.synthesized) result.status.synthesized = true;
    }
    this.cache.set(env, { at: Date.now(), result });
    return result;
  }
}

// ─── Request helpers ───────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 64KB');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }
}

function parseEnv(value: unknown, field: string): DatabaseEnv {
  if (value === 'dev' || value === 'prod') return value;
  throw new HttpError(400, 'VALIDATION_ERROR', `"${field}" must be 'dev' or 'prod'`);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
}

/** Blocks DNS-rebinding and cross-site requests: only loopback Host/Origin are accepted. */
function assertLocalRequest(req: http.IncomingMessage): void {
  const host = hostnameOf(String(req.headers.host ?? ''));
  if (!LOOPBACK_HOSTS.has(host)) throw new HttpError(403, 'FORBIDDEN_HOST', 'Studio only accepts requests addressed to localhost');
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !LOOPBACK_HOSTS.has(hostnameOf(origin))) {
    throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Cross-origin requests are not allowed');
  }
}

// ─── Route handlers ────────────────────────────────────────────────────────────

async function handleStatus(session: StudioSession, fresh: boolean): Promise<StatusResponse> {
  const [dev, prod] = await Promise.all(ENVS.map((env) => session.introspect(env, fresh)));
  return { dev: dev.status, prod: prod.status };
}

async function handleSchema(session: StudioSession, envParam: string | null, fresh: boolean): Promise<SchemaResponse> {
  const env = envParam ? parseEnv(envParam, 'env') : null;
  const [devTables, prodTables] = await Promise.all(
    ENVS.map(async (e) => (!env || env === e ? (await session.introspect(e, fresh)).tables : [])),
  );
  return { devTables, prodTables };
}

/**
 * GET /api/diff: contract keys (added/dropped/altered/unchanged, summary.*Count + engine,
 * migrationScript) plus legacy *Tables aliases. The script targets the engine being migrated:
 * Prod's engine, or the contract's declared engine (falling back to Dev's).
 */
async function handleDiff(session: StudioSession, cwd: string, targetParam: string | null, fresh: boolean): Promise<ContractSchemaDiff> {
  const target = targetParam ?? 'prod';
  if (target !== 'prod' && target !== 'contract') {
    throw new HttpError(400, 'VALIDATION_ERROR', `"target" must be 'prod' or 'contract'`);
  }
  const dev = await session.introspect('dev', fresh);
  if (!dev.status.connected) throw new HttpError(409, 'DEV_NOT_CONNECTED', dev.status.error ?? 'Dev database is not connected');

  if (target === 'contract') {
    const engine = loadContractEngine(cwd) ?? dev.status.engine;
    return toContractDiff(diffSchemas(dev.tables, loadContractTables(cwd)), engine, '.ai/db_schema.json');
  }

  const prod = await session.introspect('prod', fresh);
  if (!prod.status.connected) throw new HttpError(409, 'PROD_NOT_CONNECTED', prod.status.error ?? 'Prod database is not connected');
  return toContractDiff(diffSchemas(dev.tables, prod.tables), prod.status.engine, 'Prod');
}

const ENGINES: DatabaseEngine[] = ['postgresql', 'mysql', 'sqlite', 'mongodb', 'firestore'];

function parseFirestoreConfig(value: unknown): FirestoreConfig | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'VALIDATION_ERROR', '"firestoreConfig" must be an object');
  const raw = value as Record<string, unknown>;
  const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(projectId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"firestoreConfig.projectId" must be a valid Firestore project id');
  }
  const config: FirestoreConfig = { projectId };
  if (raw.emulatorHost !== undefined && raw.emulatorHost !== '') {
    const host = typeof raw.emulatorHost === 'string' ? raw.emulatorHost.trim() : '';
    if (!/^[A-Za-z0-9.\-[\]:]+:\d{1,5}$/.test(host)) throw new HttpError(400, 'VALIDATION_ERROR', '"firestoreConfig.emulatorHost" must look like host:port');
    config.emulatorHost = host;
  }
  if (raw.databaseId !== undefined && raw.databaseId !== '') {
    const db = typeof raw.databaseId === 'string' ? raw.databaseId.trim() : '';
    if (!/^[a-z0-9()][a-z0-9-()]{0,62}$/.test(db)) throw new HttpError(400, 'VALIDATION_ERROR', '"firestoreConfig.databaseId" is invalid');
    config.databaseId = db;
  }
  return config;
}

const COMPONENT_ENGINES: ComponentEngine[] = ['mysql', 'postgresql'];

function optionalString(raw: Record<string, unknown>, field: string): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', `"components.${field}" must be a string`);
  return value;
}

/** Validates the `components` payload ({ engine, host, port, user, password, database }). */
function parseComponents(value: unknown, topLevelEngine: DatabaseEngine | null): ConnectionComponents | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'VALIDATION_ERROR', '"components" must be an object');
  const raw = value as Record<string, unknown>;

  const engine = raw.engine ?? topLevelEngine;
  if (typeof engine !== 'string' || !COMPONENT_ENGINES.includes(engine as ComponentEngine)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"components.engine" must be one of ${COMPONENT_ENGINES.join(', ')}`);
  }
  if (topLevelEngine && topLevelEngine !== engine) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"engine" is "${topLevelEngine}" but "components.engine" is "${engine}"`);
  }

  const host = (optionalString(raw, 'host') ?? '').trim();
  if (!/^[A-Za-z0-9._:[\]-]{1,253}$/.test(host)) throw new HttpError(400, 'VALIDATION_ERROR', '"components.host" must be a hostname or IP address');

  let port: number | undefined;
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    port = typeof raw.port === 'number' ? raw.port : typeof raw.port === 'string' && /^\d+$/.test(raw.port.trim()) ? Number(raw.port) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, 'VALIDATION_ERROR', '"components.port" must be an integer between 1 and 65535');
    }
  }

  const user = optionalString(raw, 'user')?.trim();
  const password = optionalString(raw, 'password');
  const database = optionalString(raw, 'database')?.trim();
  return {
    engine: engine as ComponentEngine,
    host,
    ...(port ? { port } : {}),
    ...(user ? { user } : {}),
    ...(password ? { password } : {}),
    ...(database ? { database } : {}),
  };
}

/**
 * POST /api/connect. Accepts `connectionUrl`, `components` (parameter / XAMPP form, assembled
 * in-memory), or (for Firestore) `firestoreConfig` alone. When `engine` is given it must agree
 * with the URL's scheme.
 */
async function handleConnect(session: StudioSession, body: Record<string, unknown>): Promise<ConnectResponse> {
  const env = parseEnv(body.env, 'env');
  let engine: DatabaseEngine | null = null;
  if (body.engine !== undefined) {
    if (typeof body.engine !== 'string' || !ENGINES.includes(body.engine as DatabaseEngine)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `"engine" must be one of ${ENGINES.join(', ')}`);
    }
    engine = body.engine as DatabaseEngine;
  }
  const firestoreConfig = parseFirestoreConfig(body.firestoreConfig);

  let connectionUrl = typeof body.connectionUrl === 'string' ? body.connectionUrl.trim() : '';
  const components = connectionUrl ? null : parseComponents(body.components, engine);
  if (!connectionUrl && components) {
    try {
      connectionUrl = connectionUrlFromComponents(components);
    } catch (err) {
      throw new HttpError(400, 'VALIDATION_ERROR', (err as Error).message);
    }
  }
  if (!connectionUrl && firestoreConfig) {
    if (engine && engine !== 'firestore') throw new HttpError(400, 'VALIDATION_ERROR', '"firestoreConfig" requires engine "firestore"');
    connectionUrl = firestoreUrlFromConfig(firestoreConfig);
  }
  if (!connectionUrl) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"connectionUrl" or "components" is required (or "firestoreConfig" for Firestore)');
  }
  const detected = detectEngine(connectionUrl);
  if (!detected) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unsupported connection URL (expected postgres://, mysql://, sqlite:, file:, mongodb://, mongodb+srv:// or firestore://)');
  }
  if (engine && engine !== detected) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"engine" is "${engine}" but the connection URL is for ${detected}`);
  }

  const result = await introspectDatabase(connectionUrl);
  // Only persist to the in-memory session once the connection is proven to work.
  if (result.status.connected) session.set(env, connectionUrl, result);

  const count = result.status.entityCount ?? result.status.tableCount;
  return {
    success: result.status.connected,
    pingMs: result.status.pingMs,
    engine: result.status.engine,
    entityCount: count,
    tableCount: count,
    maskedUrl: maskConnectionString(connectionUrl),
    error: result.status.error,
  };
}

/** Writes structure-only table metadata into .ai/db_schema.json, preserving other contract fields. */
export function writeContractSchema(cwd: string, status: DatabaseStatus, tables: TableSchema[]): string {
  const filePath = path.join(cwd, CONTRACT_SCHEMA_PATH);
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    // Missing or unreadable contract — start fresh.
  }

  const previousDescriptions = new Map<string, string>();
  for (const t of (existing.tables as Array<{ name?: string; description?: string }> | undefined) ?? []) {
    if (t?.name && t.description) previousDescriptions.set(t.name.toLowerCase(), t.description);
  }

  // Rebuild each table field-by-field so nothing beyond structural metadata can leak in.
  // Sampled values (media URLs, Base64 prefixes, document counts) are deliberately left out.
  const sanitizedTables = tables.map((t) => {
    const description = t.description ?? previousDescriptions.get(t.name.toLowerCase());
    return {
      name: t.name,
      ...(t.entityType ? { entityType: t.entityType } : {}),
      ...(description ? { description } : {}),
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        primaryKey: c.primaryKey,
        nullable: c.nullable,
        default: c.default,
        ...(c.isMedia ? { isMedia: true } : {}),
        ...(c.isSubcollection ? { isSubcollection: true } : {}),
      })),
      indexes: t.indexes.map((i) => ({ name: i.name, columns: [...i.columns], unique: i.unique })),
      foreignKeys: t.foreignKeys.map((f) => ({
        name: f.name,
        column: f.column,
        referencedTable: f.referencedTable,
        referencedColumn: f.referencedColumn,
        ...(f.onDelete ? { onDelete: f.onDelete } : {}),
      })),
    };
  });

  const contract = {
    $schema: existing.$schema ?? 'http://json-schema.org/draft-07/schema#',
    version: existing.version ?? '1.0.0',
    projectName: existing.projectName ?? path.basename(cwd),
    updatedAt: new Date().toISOString(),
    engine: status.engine,
    tables: sanitizedTables,
    migrations: existing.migrations ?? [],
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8');
  return filePath;
}

async function handleExportContract(session: StudioSession, cwd: string, body: Record<string, unknown>): Promise<ExportContractResponse> {
  const sourceEnv = parseEnv(body.sourceEnv, 'sourceEnv');
  const result = await session.introspect(sourceEnv, true);
  if (!result.status.connected) {
    throw new HttpError(409, `${sourceEnv.toUpperCase()}_NOT_CONNECTED`, result.status.error ?? 'Source database is not connected');
  }
  writeContractSchema(cwd, result.status, result.tables);
  return {
    success: true,
    filePath: CONTRACT_SCHEMA_PATH.split(path.sep).join('/'),
    exportedEntitiesCount: result.tables.length,
    exportedTablesCount: result.tables.length,
  };
}

function logProdAudit(
  cwd: string,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  entity: string,
  primaryKey: string | number | null,
  details: Record<string, unknown>,
  req: http.IncomingMessage,
): void {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      env: 'prod',
      action,
      entity,
      primaryKey,
      clientIp: req.socket.remoteAddress ?? '127.0.0.1',
      details,
    };
    const dir = path.join(cwd, '.nativ');
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, 'prod_audit.log');
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');

    const legacyDir = path.join(cwd, '.agentj');
    if (fs.existsSync(legacyDir)) {
      try { fs.appendFileSync(path.join(legacyDir, 'prod_audit.log'), `${JSON.stringify(entry)}\n`, 'utf8'); } catch {}
    }
  } catch (err) {
    console.error('Failed to append to prod_audit.log:', err);
  }
}

async function handleDataGet(session: StudioSession, searchParams: URLSearchParams): Promise<unknown> {
  const env = parseEnv(searchParams.get('env'), 'env');
  const entity = searchParams.get('entity')?.trim();
  if (!entity) throw new HttpError(400, 'VALIDATION_ERROR', '"entity" query parameter is required');

  const page = searchParams.has('page') ? parseInt(searchParams.get('page')!, 10) : undefined;
  const limit = searchParams.has('limit') ? parseInt(searchParams.get('limit')!, 10) : undefined;
  const sort = searchParams.get('sort')?.trim() || undefined;
  const rawOrder = searchParams.get('order')?.toLowerCase();
  const order = rawOrder === 'desc' ? 'desc' : rawOrder === 'asc' ? 'asc' : undefined;
  const search = searchParams.get('search')?.trim() || undefined;

  const url = session.getUrl(env);
  if (!url) {
    throw new HttpError(409, `${env.toUpperCase()}_NOT_CONNECTED`, `No ${env === 'dev' ? 'Dev' : 'Prod'} database configured.`);
  }

  try {
    return await fetchData(url, entity, { page, limit, sort, order, search });
  } catch (err) {
    throw new HttpError(500, 'DATA_QUERY_ERROR', (err as Error).message);
  }
}

async function handleDataPost(session: StudioSession, cwd: string, body: Record<string, unknown>, req: http.IncomingMessage): Promise<unknown> {
  const env = parseEnv(body.env, 'env');
  const entity = typeof body.entity === 'string' ? body.entity.trim() : '';
  if (!entity) throw new HttpError(400, 'VALIDATION_ERROR', '"entity" is required');

  if (typeof body.record !== 'object' || body.record === null || Array.isArray(body.record)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"record" must be an object');
  }
  const record = body.record as Record<string, unknown>;

  if (env === 'prod') {
    if (body.confirmProd !== true || typeof body.challengePhrase !== 'string' || body.challengePhrase.trim() !== entity) {
      throw new HttpError(403, 'PROD_CHALLENGE_REQUIRED', `Production insert requires confirmProd=true and challengePhrase matching "${entity}"`);
    }
  }

  const url = session.getUrl(env);
  if (!url) {
    throw new HttpError(409, `${env.toUpperCase()}_NOT_CONNECTED`, `No ${env === 'dev' ? 'Dev' : 'Prod'} database configured.`);
  }

  try {
    const result = await insertRecord(url, entity, record);
    if (env === 'prod') {
      logProdAudit(cwd, 'INSERT', entity, result.insertedId, { record }, req);
    }
    return result;
  } catch (err) {
    throw new HttpError(500, 'DATA_MUTATION_ERROR', (err as Error).message);
  }
}

async function handleDataPut(session: StudioSession, cwd: string, body: Record<string, unknown>, req: http.IncomingMessage): Promise<unknown> {
  const env = parseEnv(body.env, 'env');
  const entity = typeof body.entity === 'string' ? body.entity.trim() : '';
  if (!entity) throw new HttpError(400, 'VALIDATION_ERROR', '"entity" is required');

  const primaryKey = body.primaryKey as string | number;
  if (primaryKey === undefined || primaryKey === null || primaryKey === '') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"primaryKey" is required for updates');
  }

  if (typeof body.updates !== 'object' || body.updates === null || Array.isArray(body.updates)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"updates" must be an object');
  }
  const updates = body.updates as Record<string, unknown>;

  if (env === 'prod') {
    if (body.confirmProd !== true || typeof body.challengePhrase !== 'string' || body.challengePhrase.trim() !== entity) {
      throw new HttpError(403, 'PROD_CHALLENGE_REQUIRED', `Production update requires confirmProd=true and challengePhrase matching "${entity}"`);
    }
  }

  const url = session.getUrl(env);
  if (!url) {
    throw new HttpError(409, `${env.toUpperCase()}_NOT_CONNECTED`, `No ${env === 'dev' ? 'Dev' : 'Prod'} database configured.`);
  }

  try {
    const result = await updateRecord(url, entity, primaryKey, updates);
    if (env === 'prod') {
      logProdAudit(cwd, 'UPDATE', entity, primaryKey, { updates }, req);
    }
    return result;
  } catch (err) {
    throw new HttpError(500, 'DATA_MUTATION_ERROR', (err as Error).message);
  }
}

async function handleDataDelete(session: StudioSession, cwd: string, body: Record<string, unknown>, req: http.IncomingMessage): Promise<unknown> {
  const env = parseEnv(body.env, 'env');
  const entity = typeof body.entity === 'string' ? body.entity.trim() : '';
  if (!entity) throw new HttpError(400, 'VALIDATION_ERROR', '"entity" is required');

  const primaryKey = body.primaryKey as string | number;
  if (primaryKey === undefined || primaryKey === null || primaryKey === '') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"primaryKey" is required for deletion');
  }

  if (env === 'prod') {
    if (body.confirmProd !== true || typeof body.challengePhrase !== 'string' || body.challengePhrase.trim() !== entity) {
      throw new HttpError(403, 'PROD_CHALLENGE_REQUIRED', `Production deletion requires confirmProd=true and challengePhrase matching "${entity}"`);
    }
  }

  const url = session.getUrl(env);
  if (!url) {
    throw new HttpError(409, `${env.toUpperCase()}_NOT_CONNECTED`, `No ${env === 'dev' ? 'Dev' : 'Prod'} database configured.`);
  }

  try {
    const result = await deleteRecord(url, entity, primaryKey);
    if (env === 'prod') {
      logProdAudit(cwd, 'DELETE', entity, primaryKey, {}, req);
    }
    return result;
  } catch (err) {
    throw new HttpError(500, 'DATA_MUTATION_ERROR', (err as Error).message);
  }
}

// ─── Server ────────────────────────────────────────────────────────────────────

export function createStudioServer(options: StudioServerOptions = {}): http.Server {
  const cwd = options.cwd ?? process.cwd();
  const resolved = options.connections ? null : resolveConnections(cwd);
  const initialMeta = resolved
    ? {
        dev: resolved.dev
          ? {
              sourceKey: resolved.dev.sourceKey,
              detectedFromExample: resolved.dev.detectedFromExample,
              exampleFile: resolved.dev.exampleFile,
              synthesized: resolved.dev.synthesized,
            }
          : null,
        prod: resolved.prod
          ? {
              sourceKey: resolved.prod.sourceKey,
              detectedFromExample: resolved.prod.detectedFromExample,
              exampleFile: resolved.prod.exampleFile,
              synthesized: resolved.prod.synthesized,
            }
          : null,
      }
    : undefined;
  const session = new StudioSession(
    options.connections ?? { dev: resolved?.dev?.url ?? null, prod: resolved?.prod?.url ?? null },
    cwd,
    initialMeta,
  );

  const renderHtml = () => {
    if (typeof options.html === 'function') return options.html();
    return options.html ?? '<!doctype html><title>AgentJ DB Studio</title><p>Studio API is running. See /api/status.</p>';
  };

  return http.createServer(async (req, res) => {
    try {
      assertLocalRequest(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const fresh = url.searchParams.get('refresh') === '1';
      const route = `${req.method ?? 'GET'} ${url.pathname.replace(/\/+$/, '') || '/'}`;

      switch (route) {
        case 'GET /':
        case 'GET /index.html': {
          const html = renderHtml();
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(html),
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            // https: images are allowed for media thumbnails; never leak the studio URL to those hosts.
            'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy':
              "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
          });
          res.end(html);
          return;
        }
        case 'GET /api/status':
          return sendJson(res, 200, await handleStatus(session, fresh));
        case 'GET /api/env-info': {
          // fragmentedConfig is display-safe: host, port, user, database, hasPassword and a masked URL only.
          const info = detectExampleDbKeys(cwd);
          return sendJson(res, 200, { ...info, fragmentedDetected: info.fragmentedDetected ?? false, fragmentedConfig: info.fragmentedConfig ?? null });
        }
        case 'GET /api/schema':
          return sendJson(res, 200, await handleSchema(session, url.searchParams.get('env'), fresh));
        case 'GET /api/diff':
          return sendJson(res, 200, await handleDiff(session, cwd, url.searchParams.get('target'), fresh));
        case 'POST /api/connect':
          return sendJson(res, 200, await handleConnect(session, await readJsonBody(req)));
        case 'POST /api/export-contract':
          return sendJson(res, 200, await handleExportContract(session, cwd, await readJsonBody(req)));
        case 'GET /api/data':
          return sendJson(res, 200, await handleDataGet(session, url.searchParams));
        case 'POST /api/data':
          return sendJson(res, 200, await handleDataPost(session, cwd, await readJsonBody(req), req));
        case 'PUT /api/data':
          return sendJson(res, 200, await handleDataPut(session, cwd, await readJsonBody(req), req));
        case 'DELETE /api/data':
          return sendJson(res, 200, await handleDataDelete(session, cwd, await readJsonBody(req), req));
        case 'GET /favicon.ico':
          res.writeHead(204).end();
          return;
      }

      if (url.pathname.startsWith('/api/')) {
        const known = ['/api/status', '/api/env-info', '/api/schema', '/api/diff', '/api/connect', '/api/export-contract', '/api/data'];
        if (known.includes(url.pathname.replace(/\/+$/, ''))) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed on ${url.pathname}`);
        throw new HttpError(404, 'NOT_FOUND', `No route for ${url.pathname}`);
      }
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      // Unexpected failures: generic message only, to avoid echoing anything credential-bearing.
      session.invalidate();
      return sendError(res, 500, 'INTERNAL_ERROR', 'Unexpected studio server error');
    }
  });
}

/** Starts the studio on loopback, trying up to 10 consecutive ports if the preferred one is busy. */
export async function startStudioServer(options: StudioServerOptions = {}): Promise<StudioServerHandle> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(hostnameOf(host))) throw new Error('Studio server may only bind to a loopback address');
  const basePort = options.port ?? DEFAULT_STUDIO_PORT;
  const server = createStudioServer(options);

  for (let attempt = 0; attempt < 10; attempt++) {
    const port = basePort === 0 ? 0 : basePort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const actualPort = (server.address() as AddressInfo).port;
      return {
        server,
        port: actualPort,
        url: `http://localhost:${actualPort}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || basePort === 0) throw err;
    }
  }
  throw new Error(`No free port found in range ${basePort}-${basePort + 9}`);
}
