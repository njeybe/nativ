import { execFile } from 'node:child_process';
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
import { generateContractTests, TestGenError } from '../core/test-generator.js';
import { isTestFramework, TEST_FRAMEWORKS, type TestGenResult } from '../core/test-generator-types.js';
import { loadPlan, withFileLock, withPlanLock } from '../core/lock-manager.js';
import {
  cacheHitRate,
  emptyActualUsage,
  loadTelemetry,
  mergeActualUsage,
  resolveModelPricing,
  type ActualTokenUsage,
  type TaskTelemetryRecord,
} from '../core/telemetry.js';
import { resolveProjectRoot } from '../core/root-resolver.js';
import type { BenchmarkReport } from '../core/benchmark.js';
import {
  CircuitBreaker,
  applySelfHealingProposal,
  type ProposalApplication,
  type SelfHealingEscalationRecord,
} from '../governor/index.js';
import { runTaskBlock, runTaskComplete, runTaskStart } from '../commands/task.js';
import { runWorktreeMerge, runWorktreeRemove, type WorktreeInfo } from '../commands/worktree.js';
import { runBench } from '../commands/bench.js';
import { finalizeTriage, triageBlocker } from '../commands/triage.js';
import { Tier1Liaison, type Tier1LiaisonOptions, type TriageEvaluation } from '../core/tier1-liaison.js';
import {
  AgentSupervisor,
  SupervisorError,
  type AgentSupervisorOptions,
  type RunnerEngine,
  type RunnerRecord,
  type RunnerStatus,
  type RunnerTokenUsageEvent,
} from '../runner/agent-supervisor.js';
import type { EscalationFile, MasterPlan, MasterPlanMilestone, MasterPlanTask } from '../scanner/types.js';

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
  /** Interval between `heartbeat` events on /api/events. Defaults to 15s. */
  heartbeatMs?: number;
  /** Agent supervisor tuning (runner command, timeout budget, log buffer size). `cwd` is always the project root. */
  supervisor?: Omit<AgentSupervisorOptions, 'cwd'>;
  /** Tier 1 strategist transport (API key, model, fetch). Defaults to GEMINI_API_KEY and native fetch. */
  triage?: Tier1LiaisonOptions;
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

/** /api/pipeline/* errors use the contract's `{ ok: false, error }` envelope. */
function sendPipelineError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: message, code });
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

const TEST_GEN_ERROR_STATUS: Record<string, number> = {
  INVALID_FRAMEWORK: 400,
  INVALID_BASE_URL: 400,
  INVALID_OUTPUT_PATH: 400,
  NO_CONTRACTS: 404,
  OUTPUT_CONFLICT: 409,
  INVALID_CONTRACT: 422,
};

/** POST /api/tests/generate. Output is confined to the project directory. */
function handleTestGenerate(cwd: string, body: Record<string, unknown>): TestGenResult {
  const { outputDir, framework, baseUrl, dryRun } = body;
  if (outputDir !== undefined && typeof outputDir !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"outputDir" must be a string');
  }
  if (framework !== undefined && (typeof framework !== 'string' || !isTestFramework(framework))) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"framework" must be one of: ${TEST_FRAMEWORKS.join(', ')}`);
  }
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"baseUrl" must be a string');
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"dryRun" must be a boolean');
  }
  if (outputDir) {
    const rel = path.relative(cwd, path.resolve(cwd, outputDir));
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new HttpError(400, 'VALIDATION_ERROR', '"outputDir" must be a subdirectory of the project');
    }
  }

  try {
    return generateContractTests({ targetDir: cwd, outputDir, framework, baseUrl, dryRun });
  } catch (err) {
    if (err instanceof TestGenError) throw new HttpError(TEST_GEN_ERROR_STATUS[err.code] ?? 400, err.code, err.message);
    throw err;
  }
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

// ─── Pipeline (Mission Control) ────────────────────────────────────────────────

const AI_DIR = '.ai';
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_REASON_LENGTH = 1000;
const MAX_ERROR_OUTPUT_CHARS = 4000;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
export const DEFAULT_HEARTBEAT_MS = 15_000;
const EVENT_DEBOUNCE_MS = 100;
const WATCH_POLL_INTERVAL_MS = 1000;

type PipelineEventName = 'plan_change' | 'telemetry_change';

/** Files in .ai/ that drive /api/events, mapped to the event a change emits. Anything else (tmp/lock files) is ignored. */
const WATCHED_FILES = new Map<string, PipelineEventName>([
  ['master_plan.json', 'plan_change'],
  ['escalation.json', 'plan_change'],
  ['.governor_ledger.json', 'plan_change'],
  ['context.md', 'plan_change'],
  ['db_schema.json', 'plan_change'],
  ['api_contracts.json', 'plan_change'],
  ['ui_specs.md', 'plan_change'],
  ['telemetry.json', 'telemetry_change'],
  ['benchmark_report.json', 'telemetry_change'],
]);

const CONTRACT_FILES = {
  masterPlanExists: 'master_plan.json',
  contextExists: 'context.md',
  dbSchemaExists: 'db_schema.json',
  apiContractsExists: 'api_contracts.json',
  uiSpecsExists: 'ui_specs.md',
} as const;

const TASK_ACTION_STATUS = { start: 'in_progress', complete: 'completed', block: 'blocked' } as const;
type TaskAction = keyof typeof TASK_ACTION_STATUS;

let cachedVersion: string | null = null;

function packageVersion(): string {
  if (cachedVersion === null) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
      cachedVersion = pkg.version ?? 'unknown';
    } catch {
      cachedVersion = 'unknown';
    }
  }
  return cachedVersion;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Telemetry is hand-editable JSON: coerce every counter so one bad record cannot NaN the totals. */
function sanitizeUsage(value: unknown): ActualTokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  const u = value as Partial<ActualTokenUsage>;
  const n = (v: unknown) => Math.max(0, finiteOr(v, 0));
  return {
    model: typeof u.model === 'string' ? u.model : 'unknown',
    turns: n(u.turns),
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheCreationTokens: n(u.cacheCreationTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    thinkingTokens: n(u.thinkingTokens),
    costUsd: n(u.costUsd),
  };
}

function aggregateActualUsage(records: TaskTelemetryRecord[]): ActualTokenUsage {
  let total = emptyActualUsage('');
  for (const record of records) {
    const usage = sanitizeUsage(record?.actualUsage);
    if (usage) total = mergeActualUsage(total, usage);
  }
  return total;
}

/** Usage as served by the API: the stored counters plus the derived cache hit rate. */
function usageView(usage: ActualTokenUsage | null) {
  return usage ? { ...usage, costUsd: roundUsd(usage.costUsd), cacheHitRate: cacheHitRate(usage) } : null;
}

function truncateOutput(text: string): string {
  return text.length > MAX_ERROR_OUTPUT_CHARS ? `${text.slice(0, MAX_ERROR_OUTPUT_CHARS)}…` : text;
}

function readPlan(root: string): MasterPlan | null {
  return loadPlan(path.join(root, AI_DIR, 'master_plan.json'), { silent: true, retries: 3 });
}

/** Milestones with a usable task list; tolerates hand-edited or half-written plans. */
function planMilestones(plan: MasterPlan | null): MasterPlanMilestone[] {
  const milestones = plan?.milestones;
  if (!Array.isArray(milestones)) return [];
  return milestones.filter((m) => m && Array.isArray(m.tasks));
}

function findTask(plan: MasterPlan | null, taskId: string): MasterPlanTask | null {
  for (const m of planMilestones(plan)) {
    const task = m.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return null;
}

/** Task ids reach git branch names and shell commands in the worktree handlers, so the charset is strict. */
function parseTaskId(value: unknown): string {
  const taskId = typeof value === 'string' ? value.trim() : '';
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"taskId" must be a task id (letters, digits, ".", "_" or "-")');
  }
  return taskId;
}

// The CLI command handlers report through console.* and process.exitCode, which are process-global,
// so captured runs are serialized (same approach as the MCP server).
let captureQueue: Promise<unknown> = Promise.resolve();

interface CapturedRun<T> {
  result: T;
  /** Console output with ANSI colors stripped. */
  output: string;
  /** True when the handler set a non-zero process.exitCode. */
  failed: boolean;
}

function runCaptured<T>(fn: () => Promise<T>): Promise<CapturedRun<T>> {
  const run = async (): Promise<CapturedRun<T>> => {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = console.error = console.warn = console.info = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    try {
      const result = await fn();
      const failed = process.exitCode !== undefined && process.exitCode !== 0;
      return { result, failed, output: lines.join('\n').replace(ANSI_PATTERN, '').trim() };
    } finally {
      Object.assign(console, original);
      process.exitCode = previousExitCode;
    }
  };
  const result = captureQueue.then(run, run);
  captureQueue = result.catch(() => undefined);
  return result;
}

/** `--json` CLI handlers print `{ success: false, error }` on failure. */
function jsonErrorMessage(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { error?: unknown } | null;
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/** GET /api/pipeline/status: contract matrix, milestone/task burndown and telemetry KPIs. */
function handlePipelineStatus(root: string) {
  const aiDir = path.join(root, AI_DIR);
  const contracts = Object.fromEntries(
    Object.entries(CONTRACT_FILES).map(([key, file]) => [key, fs.existsSync(path.join(aiDir, file))]),
  ) as Record<keyof typeof CONTRACT_FILES, boolean>;

  const milestones = planMilestones(readPlan(root));
  const tasks = milestones.flatMap((m) => m.tasks);
  const count = (items: Array<{ status: string }>, status: string) => items.filter((i) => i.status === status).length;
  const completedTasks = count(tasks, 'completed');
  const { summary, tasks: trackedTasks } = loadTelemetry(path.join(aiDir, 'telemetry.json'));
  const actual = aggregateActualUsage(trackedTasks);

  return {
    ok: true,
    pipeline: {
      version: packageVersion(),
      contracts,
      milestones: {
        total: milestones.length,
        completed: count(milestones, 'completed'),
        inProgress: count(milestones, 'in_progress'),
        pending: count(milestones, 'pending'),
      },
      tasks: {
        total: tasks.length,
        completed: completedTasks,
        inProgress: count(tasks, 'in_progress'),
        pending: count(tasks, 'pending'),
        blocked: count(tasks, 'blocked'),
        progressPercentage: percent(completedTasks, tasks.length),
      },
      telemetry: {
        totalTokens: finiteOr(summary?.estimatedTotalTokens, 0),
        estimatedCostUsd: finiteOr(summary?.estimatedTotalCostUsd, 0),
        // Grounded in API-reported usage (native runs), summed from the task records so a
        // stale summary written by an older nativ can never under-report spend.
        actualSpendUsd: roundUsd(actual.costUsd),
        cacheReadTokens: actual.cacheReadTokens,
        cacheCreationTokens: actual.cacheCreationTokens,
        thinkingTokens: actual.thinkingTokens,
        cacheHitRate: cacheHitRate(actual),
        totalTasksTracked: trackedTasks.length,
        // Ratio in [0, 1], as stored in telemetry.json.
        passRate: finiteOr(summary?.verificationPassRate, 1),
        circuitBreakerTrips: finiteOr(summary?.circuitBreakerTrips, 0),
      },
    },
  };
}

/** GET /api/pipeline/tasks: milestones with per-task dependency readiness and circuit-breaker attempts. */
function handlePipelineTasks(root: string) {
  const plan = readPlan(root);
  const milestones = planMilestones(plan);
  const completedIds = new Set(
    milestones.flatMap((m) => m.tasks).filter((t) => t.status === 'completed').map((t) => t.id),
  );
  return {
    ok: true,
    projectName: plan?.projectName ?? null,
    overallStatus: plan?.overallStatus ?? null,
    activeMilestoneId: plan?.activeMilestoneId ?? null,
    milestones: milestones.map((m) => ({
      ...m,
      progressPercentage: percent(m.tasks.filter((t) => t.status === 'completed').length, m.tasks.length),
      tasks: m.tasks.map((t) => ({
        ...t,
        // Same readiness rule as `nativ task list --available`.
        isAvailable:
          (t.status === 'pending' || t.status === 'in_progress') &&
          (t.dependencies ?? []).every((d) => completedIds.has(d)),
        circuitBreaker: CircuitBreaker.getStatus(root, t.id),
      })),
    })),
  };
}

/** POST /api/pipeline/tasks/action: the same lock-guarded transitions as `nativ task start|complete|block`. */
async function handleTaskAction(root: string, body: Record<string, unknown>) {
  const { action } = body;
  if (typeof action !== 'string' || !Object.hasOwn(TASK_ACTION_STATUS, action)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"action" must be one of: ${Object.keys(TASK_ACTION_STATUS).join(', ')}`);
  }
  const taskAction = action as TaskAction;
  const taskId = parseTaskId(body.taskId);
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"reason" must be a string');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  }
  if (taskAction === 'block' && !reason) throw new HttpError(400, 'VALIDATION_ERROR', '"reason" is required when blocking a task');

  const task = findTask(readPlan(root), taskId);
  if (!task) throw new HttpError(400, 'TASK_NOT_FOUND', `Task "${taskId}" not found in .ai/master_plan.json`);
  if (task.status === TASK_ACTION_STATUS[taskAction]) {
    throw new HttpError(400, 'INVALID_TRANSITION', `Task "${taskId}" is already ${task.status}`);
  }

  // `complete` runs the task's verificationCommand as a gatekeeper, exactly like the CLI.
  const { failed, output } = await runCaptured(async () => {
    if (taskAction === 'start') await runTaskStart(taskId, root);
    else if (taskAction === 'complete') await runTaskComplete(taskId, root);
    else await runTaskBlock(taskId, reason, root);
  });
  if (failed) throw new HttpError(400, 'TASK_ACTION_FAILED', truncateOutput(output || `Task ${taskAction} failed`));

  return { ok: true, task: findTask(readPlan(root), taskId) ?? task };
}

interface PipelineWorktree extends WorktreeInfo {
  taskStatus: MasterPlanTask['status'] | null;
  mergeEligible: boolean;
  mergeBlockedReason: string | null;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** Async twin of `nativ worktree list --json` (which blocks on execSync and prints to the console). */
async function listGitWorktrees(root: string): Promise<WorktreeInfo[]> {
  let raw: string;
  try {
    raw = await git(root, ['worktree', 'list', '--porcelain']);
  } catch {
    return []; // Not a git repository, or git is unavailable.
  }

  const worktrees: WorktreeInfo[] = [];
  for (const block of raw.trim().split(/\r?\n\r?\n/)) {
    let wtPath = '';
    let head = '';
    let branch = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) wtPath = line.slice(9).trim();
      else if (line.startsWith('HEAD ')) head = line.slice(5).trim();
      else if (line.startsWith('branch ')) branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    }
    if (!wtPath) continue;
    worktrees.push({
      path: wtPath,
      head,
      branch: branch || 'detached',
      isAgentWorktree: wtPath.includes('.worktrees') || branch.startsWith('agent/task-'),
      taskId: /^agent\/task-(.+)$/.exec(branch)?.[1],
    });
  }
  return worktrees;
}

/**
 * GET /api/pipeline/worktrees. Merge eligibility mirrors the `nativ worktree merge` gatekeeper (task completed,
 * circuit breaker not tripped), and additionally requires the task to be declared in the plan.
 */
async function describeWorktrees(root: string): Promise<PipelineWorktree[]> {
  const statusById = new Map(planMilestones(readPlan(root)).flatMap((m) => m.tasks.map((t) => [t.id, t.status] as const)));
  return (await listGitWorktrees(root)).map((wt) => {
    const taskStatus = (wt.taskId && statusById.get(wt.taskId)) || null;
    let mergeBlockedReason: string | null = null;
    if (!wt.isAgentWorktree || !wt.taskId) mergeBlockedReason = 'Not an agent task worktree';
    else if (!taskStatus) mergeBlockedReason = `Task "${wt.taskId}" is not declared in .ai/master_plan.json`;
    else if (taskStatus !== 'completed') mergeBlockedReason = `Task status is '${taskStatus}'; only completed tasks may be merged`;
    else if (CircuitBreaker.getStatus(root, wt.taskId).tripped) mergeBlockedReason = 'Circuit breaker is tripped; resolve the escalation before merging';
    return { ...wt, taskStatus, mergeEligible: mergeBlockedReason === null, mergeBlockedReason };
  });
}

/** POST /api/pipeline/worktrees/action: `nativ worktree merge|remove`, never forced past the merge gatekeeper. */
async function handleWorktreeAction(root: string, body: Record<string, unknown>) {
  const { action } = body;
  if (action !== 'merge' && action !== 'remove') throw new HttpError(400, 'VALIDATION_ERROR', '"action" must be one of: merge, remove');
  const taskId = parseTaskId(body.taskId);

  const worktree = (await describeWorktrees(root)).find((wt) => wt.isAgentWorktree && wt.taskId === taskId);
  if (!worktree) throw new HttpError(400, 'WORKTREE_NOT_FOUND', `No agent worktree found for task "${taskId}"`);
  if (action === 'merge' && !worktree.mergeEligible) {
    throw new HttpError(400, 'MERGE_REJECTED', worktree.mergeBlockedReason ?? 'Merge rejected by the gatekeeper');
  }

  const { result, failed, output } = await runCaptured<{ message: string } | null>(() =>
    action === 'merge' ? runWorktreeMerge(taskId, root, { json: true }) : runWorktreeRemove(taskId, root, { json: true }),
  );
  if (failed || !result) {
    throw new HttpError(400, 'WORKTREE_ACTION_FAILED', jsonErrorMessage(output) ?? truncateOutput(output || `Worktree ${action} failed`));
  }
  return { ok: true, message: result.message };
}

/** GET /api/pipeline/worktrees/diff: uncommitted changes and unified diff for an agent worktree. */
async function handleWorktreeDiff(root: string, searchParams: URLSearchParams) {
  const rawTaskId = searchParams.get('taskId');
  if (!rawTaskId) throw new HttpError(400, 'VALIDATION_ERROR', '"taskId" query parameter is required');
  const taskId = parseTaskId(rawTaskId);

  const worktree = (await describeWorktrees(root)).find((wt) => wt.isAgentWorktree && wt.taskId === taskId);
  if (!worktree || !fs.existsSync(worktree.path)) {
    throw new HttpError(400, 'WORKTREE_NOT_FOUND', `No agent worktree found for task "${taskId}"`);
  }

  let statusOut: string;
  try {
    // -z keeps paths unquoted and unambiguous; -uall lists the files inside untracked directories.
    statusOut = await git(worktree.path, ['status', '--porcelain', '-z', '--untracked-files=all']);
  } catch {
    throw new HttpError(400, 'WORKTREE_INVALID', `Failed to read git status in the worktree for task "${taskId}"`);
  }

  const filesChanged: string[] = [];
  const untracked: string[] = [];
  const entries = statusOut.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    filesChanged.push(file);
    if (xy === '??') untracked.push(file);
    // Renames and copies carry the original path in the next field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }

  let diff = '';
  try {
    diff = await git(worktree.path, ['diff', 'HEAD']);
  } catch {
    diff = await git(worktree.path, ['diff']).catch(() => '');
  }
  // `git diff HEAD` skips untracked files; render them as additions without touching the index.
  for (const file of untracked) {
    diff += (await gitNoIndexDiff(worktree.path, file)) || `+++ b/${file} (untracked)\n`;
  }

  return {
    ok: true,
    taskId,
    branch: worktree.branch,
    hasChanges: filesChanged.length > 0,
    filesChanged,
    diff: diff.trim(),
  };
}

/** `git diff --no-index` exits 1 when the inputs differ, so stdout is also read from that "error". */
function gitNoIndexDiff(cwd: string, file: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['diff', '--no-index', '--', '/dev/null', file],
      { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(!err || (err as { code?: unknown }).code === 1 ? String(stdout) : ''),
    );
  });
}

// ─── Autonomous agent dispatch (/api/pipeline/tasks/dispatch|abort|runs|logs) ──

const MAX_RUNNER_COMMAND_LENGTH = 2000;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 5000;

/** Supervisor guard rails (unmet dependencies, already running, unknown task) map to the contract's 400 envelope. */
function toHttpError(err: unknown): never {
  if (err instanceof SupervisorError) throw new HttpError(err.status, err.code, err.message);
  throw err;
}

function parseRunnerCommand(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', '"runnerCommand" must be a string');
  const command = value.trim();
  if (!command) throw new HttpError(400, 'VALIDATION_ERROR', '"runnerCommand" must not be empty');
  if (command.length > MAX_RUNNER_COMMAND_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"runnerCommand" must be at most ${MAX_RUNNER_COMMAND_LENGTH} characters`);
  }
  return command;
}

function parseTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_SECONDS) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"timeoutSeconds" must be a number between 1 and ${MAX_TIMEOUT_SECONDS}`);
  }
  return Math.floor(value);
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', `"${field}" must be a boolean`);
  return value;
}

/** Query strings carry booleans as text: `?activeOnly=1|true|yes`. */
function parseBooleanParam(value: string | null): boolean {
  return value !== null && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseTailLines(value: string | null): number {
  if (value === null || value === '') return DEFAULT_TAIL_LINES;
  const tail = Number(value);
  if (!Number.isFinite(tail) || tail <= 0 || tail > MAX_TAIL_LINES) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"tailLines" must be a number between 1 and ${MAX_TAIL_LINES}`);
  }
  return Math.floor(tail);
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][\w.:@-]{0,127}$/;
const MAX_THINKING_BUDGET = 1_000_000;

function parseRunnerEngine(value: unknown): RunnerEngine | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'native' && value !== 'cli') throw new HttpError(400, 'VALIDATION_ERROR', `"runnerEngine" must be 'native' or 'cli'`);
  return value;
}

function parseThinkingBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  // 0 is valid: "as little thinking as the model allows" (the Studio's None chip).
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_THINKING_BUDGET) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"thinkingBudget" must be a number between 0 and ${MAX_THINKING_BUDGET}`);
  }
  return Math.floor(value);
}

function parseModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !MODEL_ID_PATTERN.test(value.trim())) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"model" must be a model ID such as claude-opus-5-5');
  }
  return value.trim();
}

/**
 * POST /api/pipeline/tasks/dispatch: hands a task to a background runner, either the native
 * Messages API engine or a CLI command (Claude Code by default), in an isolated worktree.
 */
async function handleTaskDispatch(supervisor: AgentSupervisor, body: Record<string, unknown>) {
  const taskId = parseTaskId(body.taskId);
  const runnerEngine = parseRunnerEngine(body.runnerEngine);
  const runnerCommand = parseRunnerCommand(body.runnerCommand);
  const thinkingBudget = parseThinkingBudget(body.thinkingBudget);
  const model = parseModel(body.model);
  const timeoutSeconds = parseTimeoutSeconds(body.timeoutSeconds);
  const useWorktree = parseOptionalBoolean(body.useWorktree, 'useWorktree');
  const verify = parseOptionalBoolean(body.verify, 'verify');
  const autoMerge = parseOptionalBoolean(body.autoMerge, 'autoMerge');

  let run: RunnerRecord;
  try {
    run = await supervisor.dispatch({
      taskId,
      runnerEngine,
      runnerCommand,
      thinkingBudget,
      model,
      timeoutSeconds,
      useWorktree,
      verify,
      autoMerge,
    });
  } catch (err) {
    toHttpError(err);
  }
  return { ok: true, run: runView(run) };
}

/** Runner records as served by the API: usage gains its derived cache hit rate. */
function runView(run: RunnerRecord) {
  return { ...run, usage: usageView(sanitizeUsage(run.usage)) };
}

/** POST /api/pipeline/tasks/abort: terminates the runner's process tree and settles the run as aborted. */
async function handleTaskAbort(supervisor: AgentSupervisor, body: Record<string, unknown>) {
  const taskId = parseTaskId(body.taskId);
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"reason" must be a string');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"reason" must be at most ${MAX_REASON_LENGTH} characters`);
  }

  try {
    const { status, message } = await supervisor.abort(taskId, reason || undefined);
    return { ok: true, taskId, status, message };
  } catch (err) {
    toHttpError(err);
  }
}

/** GET /api/pipeline/tasks/runs: active and recent runs, newest first. */
function handleTaskRuns(supervisor: AgentSupervisor, searchParams: URLSearchParams) {
  const rawTaskId = searchParams.get('taskId');
  const taskId = rawTaskId === null || rawTaskId === '' ? undefined : parseTaskId(rawTaskId);
  const runs = supervisor.listRuns({ taskId, activeOnly: parseBooleanParam(searchParams.get('activeOnly')) });
  return { ok: true, runs: runs.map(runView) };
}

/** GET /api/pipeline/tasks/logs: tail of a runner's streaming log buffer. */
function handleTaskLogs(supervisor: AgentSupervisor, searchParams: URLSearchParams) {
  const taskId = parseTaskId(searchParams.get('taskId'));
  const { status, totalBytes, log, runId, truncated } = supervisor.getLogs(taskId, parseTailLines(searchParams.get('tailLines')));
  if (status === null) throw new HttpError(400, 'RUN_NOT_FOUND', `No runner history for task "${taskId}"`);
  return { ok: true, taskId, runId, status, totalBytes, log, truncated };
}

/** GET /api/pipeline/benchmarks: the cached report written by `nativ bench` or benchmarks/run. */
function handleBenchmarks(root: string) {
  let report: unknown = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, AI_DIR, 'benchmark_report.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) report = parsed;
  } catch {
    // No benchmark has been run yet, or the report is unreadable.
  }
  return { ok: true, report };
}

// ─── Grounded telemetry & self-healing escalations ─────────────────────────────

/**
 * GET /api/pipeline/telemetry/detailed: per-task financial audit. Each breakdown pairs the heuristic
 * estimate with API-reported usage and lists the task's runs (engine, model, per-run usage).
 */
function handleTelemetryDetailed(root: string, supervisor: AgentSupervisor) {
  const telemetry = loadTelemetry(path.join(root, AI_DIR, 'telemetry.json'));
  const records = telemetry.tasks.filter((t): t is TaskTelemetryRecord => Boolean(t) && typeof t.taskId === 'string');
  const planTasks = new Map(planMilestones(readPlan(root)).flatMap((m) => m.tasks).map((t) => [t.id, t] as const));

  const runsByTask = new Map<string, RunnerRecord[]>();
  for (const run of supervisor.listRuns()) {
    const list = runsByTask.get(run.taskId) ?? [];
    list.push(run);
    runsByTask.set(run.taskId, list);
  }

  const taskIds = [...new Set([...records.map((r) => r.taskId), ...runsByTask.keys()])];
  const taskBreakdowns = taskIds
    .map((taskId) => {
      const record = records.find((r) => r.taskId === taskId);
      const planTask = planTasks.get(taskId);
      const actual = sanitizeUsage(record?.actualUsage);
      const estimate = record?.tokens;
      const estimated = estimate
        ? {
            inputTokens: finiteOr(estimate.inputEstimated, 0),
            outputTokens: finiteOr(estimate.outputEstimated, 0),
            totalTokens: finiteOr(estimate.totalEstimated, 0),
            costUsd: finiteOr(estimate.costUsdEstimated, 0),
          }
        : null;
      return {
        taskId,
        title: record?.title ?? planTask?.title ?? taskId,
        assignedSubagent: record?.assignedSubagent ?? planTask?.assignedSubagent ?? null,
        status: planTask?.status ?? record?.status ?? null,
        startedAt: record?.startedAt ?? null,
        completedAt: record?.completedAt ?? null,
        durationMs: finiteOr(record?.durationMs, 0),
        verification: record?.verification ?? null,
        estimated,
        actual: usageView(actual),
        // Positive: the task cost more than estimated.
        varianceUsd: actual && estimated ? roundUsd(actual.costUsd - estimated.costUsd) : null,
        runs: (runsByTask.get(taskId) ?? []).map((run) => ({
          runId: run.runId,
          engine: run.engine,
          model: run.model,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          durationMs: run.durationMs,
          thinking: run.thinking,
          usage: usageView(sanitizeUsage(run.usage)),
        })),
      };
    })
    // Most expensive first; tasks without grounded usage keep their telemetry order at the end.
    .sort((a, b) => (b.actual?.costUsd ?? -1) - (a.actual?.costUsd ?? -1));

  const byModel = new Map<string, ActualTokenUsage>();
  for (const record of records) {
    const usage = sanitizeUsage(record.actualUsage);
    if (!usage) continue;
    byModel.set(usage.model, mergeActualUsage(byModel.get(usage.model) ?? emptyActualUsage(usage.model), usage));
  }

  const { summary } = telemetry;
  const actual = aggregateActualUsage(records);
  return {
    ok: true,
    summary: {
      projectName: telemetry.projectName,
      lastUpdated: telemetry.lastUpdated,
      modelTierDefault: telemetry.modelTierDefault,
      tasksTracked: records.length,
      totalTasksCompleted: finiteOr(summary?.totalTasksCompleted, 0),
      totalDurationMs: finiteOr(summary?.totalDurationMs, 0),
      estimated: {
        totalTokens: finiteOr(summary?.estimatedTotalTokens, 0),
        costUsd: finiteOr(summary?.estimatedTotalCostUsd, 0),
      },
      actual: {
        turns: actual.turns,
        inputTokens: actual.inputTokens,
        outputTokens: actual.outputTokens,
        cacheReadTokens: actual.cacheReadTokens,
        cacheCreationTokens: actual.cacheCreationTokens,
        thinkingTokens: actual.thinkingTokens,
        spendUsd: roundUsd(actual.costUsd),
        cacheHitRate: cacheHitRate(actual),
        // What the cache reads would have cost at each model's full input rate, minus what they did cost.
        cacheSavingsUsd: roundUsd(
          [...byModel.values()].reduce((sum, u) => {
            const rates = resolveModelPricing(u.model);
            return sum + (u.cacheReadTokens * (rates.inputPerM - rates.cacheReadPerM)) / 1_000_000;
          }, 0),
        ),
      },
      byModel: [...byModel.values()].map(usageView).sort((a, b) => b!.costUsd - a!.costUsd),
      verification: {
        passRate: finiteOr(summary?.verificationPassRate, 1),
        runs: finiteOr(summary?.totalVerificationsRun, 0),
        passed: finiteOr(summary?.totalVerificationsPassed, 0),
      },
      circuitBreakerTrips: finiteOr(summary?.circuitBreakerTrips, 0),
    },
    taskBreakdowns,
  };
}

const ESCALATION_FILTERS = ['pending_review', 'resolved', 'all'] as const;
type EscalationFilter = (typeof ESCALATION_FILTERS)[number];

/** Escalation records as the resolve endpoint leaves them. */
interface ResolvedEscalationRecord extends SelfHealingEscalationRecord {
  resolvedAt?: string;
  resolution?: {
    decision: 'approve' | 'reject';
    proposalApplied: boolean;
    ruleId: string | null;
    unblockedTaskId: string | null;
  };
}

function escalationFilePath(root: string): string {
  return path.join(root, AI_DIR, 'escalation.json');
}

/** Null when no escalation has ever been filed. */
function readEscalationFile(root: string): EscalationFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(escalationFilePath(root), 'utf8');
  } catch {
    return null;
  }
  // withFileLock creates the file empty when it takes the first lock.
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as EscalationFile;
    if (!Array.isArray(parsed?.escalations)) parsed.escalations = [];
    return parsed;
  } catch {
    throw new HttpError(500, 'ESCALATION_FILE_CORRUPT', '.ai/escalation.json is not valid JSON');
  }
}

/** tmp-file + rename so the SSE watcher and concurrent readers never observe a half-written file. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY')) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * GET /api/pipeline/escalations?status=pending_review|resolved|all: escalations newest first, each
 * with its optional self-healing `proposedPatch`. `resolved` covers every closed record (approved or rejected).
 */
function handleEscalations(root: string, searchParams: URLSearchParams) {
  const rawFilter = searchParams.get('status') || 'all';
  if (!(ESCALATION_FILTERS as readonly string[]).includes(rawFilter)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"status" must be one of: ${ESCALATION_FILTERS.join(', ')}`);
  }
  const filter = rawFilter as EscalationFilter;
  const escalations = (readEscalationFile(root)?.escalations ?? [])
    .filter((e) => e && typeof e.id === 'string')
    .filter((e) => filter === 'all' || (filter === 'pending_review' ? e.status === 'pending_review' : e.status !== 'pending_review'))
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  return { ok: true, escalations };
}

/** Moves a blocked task back to pending so it can be dispatched again. False when it was not blocked. */
async function unblockTask(root: string, taskId: string, note: string): Promise<boolean> {
  const planPath = path.join(root, AI_DIR, 'master_plan.json');
  if (!fs.existsSync(planPath)) return false;
  const result = await withPlanLock(planPath, (plan, ctx) => {
    const task = findTask(plan, taskId);
    if (!task || task.status !== 'blocked') {
      ctx.abort();
      return false;
    }
    task.status = 'pending';
    task.notes = note;
    return true;
  });
  return result === true;
}

/** Test restorations run where the task's files live: its agent worktree if one exists, else the project. */
function taskWorkspace(root: string, taskId: string): string {
  const worktree = path.join(root, '.worktrees', `task-${taskId}`);
  return fs.existsSync(path.join(worktree, '.git')) ? worktree : root;
}

/**
 * POST /api/pipeline/escalations/resolve: `approve` applies the self-healing proposal (re-checked
 * against the live contract), resets the circuit breaker and unblocks the task; `reject` dismisses
 * the escalation and leaves the task blocked. A proposal that no longer applies leaves the
 * escalation pending and returns 400.
 */
async function handleEscalationResolve(root: string, body: Record<string, unknown>) {
  const escalationId = typeof body.escalationId === 'string' ? body.escalationId.trim() : '';
  if (!TASK_ID_PATTERN.test(escalationId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"escalationId" must be an escalation id such as esc-01');
  }
  const { decision } = body;
  if (decision !== 'approve' && decision !== 'reject') {
    throw new HttpError(400, 'VALIDATION_ERROR', `"decision" must be 'approve' or 'reject'`);
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"notes" must be a string');
  }
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > MAX_REASON_LENGTH) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"notes" must be at most ${MAX_REASON_LENGTH} characters`);
  }

  const file = escalationFilePath(root);
  if (!readEscalationFile(root)) throw new HttpError(400, 'ESCALATION_NOT_FOUND', `Escalation "${escalationId}" not found`);

  // One resolution at a time per project: a double-click must not apply a proposal twice.
  return withFileLock(file, async () => {
    const data = readEscalationFile(root);
    const record = data?.escalations.find((e) => e?.id === escalationId) as ResolvedEscalationRecord | undefined;
    if (!data || !record) throw new HttpError(400, 'ESCALATION_NOT_FOUND', `Escalation "${escalationId}" not found`);
    if (record.status !== 'pending_review') {
      throw new HttpError(400, 'ESCALATION_ALREADY_RESOLVED', `Escalation "${escalationId}" is already ${record.status}`);
    }

    const proposal = record.proposedPatch;
    const now = new Date().toISOString();
    let applied: ProposalApplication | null = null;
    let unblockedTaskId: string | null = null;
    let message: string;

    if (decision === 'approve') {
      if (proposal) {
        const workspace = proposal.kind === 'restore_tests' ? taskWorkspace(root, record.taskId) : root;
        applied = applySelfHealingProposal(workspace, record.taskId, proposal);
        if (!applied.applied) {
          throw new HttpError(400, applied.ruleId, `Proposal ${proposal.proposalId} was not applied: ${applied.message}`);
        }
      } else {
        CircuitBreaker.recordSuccess(root, record.taskId);
      }
      const unblocked = await unblockTask(root, record.taskId, `Unblocked by escalation ${escalationId}${notes ? `: ${notes}` : ''}`);
      unblockedTaskId = unblocked ? record.taskId : null;
      record.status = 'resolved';
      record.resolutionNotes = notes || applied?.message || 'Approved by operator';
      message = [
        applied ? `${applied.message}.` : `Escalation ${escalationId} approved.`,
        unblocked ? `Task ${record.taskId} is unblocked and pending.` : `Task ${record.taskId} was not blocked.`,
      ].join(' ');
    } else {
      record.status = 'dismissed';
      record.resolutionNotes = notes || (proposal ? `Proposal ${proposal.proposalId} rejected by operator` : 'Rejected by operator');
      message = `Escalation ${escalationId} rejected; task ${record.taskId} stays blocked.`;
    }

    record.resolvedAt = now;
    record.resolution = {
      decision,
      proposalApplied: Boolean(applied?.applied),
      ruleId: applied?.ruleId ?? null,
      unblockedTaskId,
    };
    data.lastUpdated = now;
    writeJsonAtomic(file, data);
    return { ok: true, message, unblockedTaskId };
  });
}

// ─── Tier 1 triage ─────────────────────────────────────────────────────────────

/** The contract's evaluate body; the full verdict (patch, proof, guardrails) is stored on the escalation. */
function triageView(result: TriageEvaluation) {
  return {
    ok: true,
    escalationId: result.escalationId,
    provider: result.provider,
    model: result.model,
    source: result.source,
    latencyMs: result.latencyMs,
    classification: result.classification,
    reasoning: result.reasoning,
    autoPatchApplied: result.autoPatchApplied,
    ...(result.humanCard ? { humanCard: result.humanCard } : {}),
  };
}

/**
 * POST /api/pipeline/triage/evaluate: runs the Tier 1 strategist on one escalation. A proven additive
 * patch is written only while auto-triage is enabled, and then unblocks the task. Concurrent requests
 * for the same escalation share one evaluation, so a double-click cannot apply or count twice.
 */
function handleTriageEvaluate(
  root: string,
  liaison: Tier1Liaison,
  inFlight: Map<string, Promise<ReturnType<typeof triageView>>>,
  body: Record<string, unknown>,
) {
  const escalationId = typeof body.escalationId === 'string' ? body.escalationId.trim() : '';
  if (!TASK_ID_PATTERN.test(escalationId)) {
    throw new HttpError(400, 'VALIDATION_ERROR', '"escalationId" must be an escalation id such as esc-01');
  }
  const running = inFlight.get(escalationId);
  if (running) return running;

  const evaluation = (async () => {
    const blocker = triageBlocker(root, escalationId);
    if (blocker) throw new HttpError(400, 'TRIAGE_REJECTED', blocker);
    const result = await liaison.evaluate(escalationId);
    if (!result.ok) throw new HttpError(400, 'TRIAGE_REJECTED', result.error);
    await finalizeTriage(root, result);
    return triageView(result);
  })().finally(() => inFlight.delete(escalationId));
  inFlight.set(escalationId, evaluation);
  return evaluation;
}

const RISK_THRESHOLDS = ['safe_contracts_only', 'all_non_destructive'];

/** POST /api/pipeline/triage/config: session-only auto-triage settings, validated before they reach the liaison. */
function handleTriageConfig(liaison: Tier1Liaison, body: Record<string, unknown>) {
  if (typeof body.autoTriageEnabled !== 'boolean') {
    throw new HttpError(400, 'VALIDATION_ERROR', '"autoTriageEnabled" must be a boolean');
  }
  if (body.riskThreshold !== undefined && !RISK_THRESHOLDS.includes(body.riskThreshold as string)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `"riskThreshold" must be one of: ${RISK_THRESHOLDS.join(', ')}`);
  }
  const result = liaison.updateConfig({ autoTriageEnabled: body.autoTriageEnabled, riskThreshold: body.riskThreshold });
  if (!result.ok) throw new HttpError(400, 'VALIDATION_ERROR', result.error);
  return result;
}

/**
 * Fan-out for GET /api/events. Watches .ai/ only while a client is connected, coalesces write bursts
 * (tmp file + atomic rename + lock files) into one event per type, and sends heartbeats so idle
 * streams survive proxies and sleep/wake.
 *
 * Frames: `event: plan_change` / `event: telemetry_change` with `data: {"files":[...],"at":"<ISO>"}`,
 * and `event: heartbeat` with `data: {"at":"<ISO>"}`.
 */
class PipelineEventHub {
  private readonly clients = new Set<http.ServerResponse>();
  private readonly pending = new Map<PipelineEventName, Set<string>>();
  private watcher: fs.FSWatcher | null = null;
  private pollers: Array<{ file: string; listener: (curr: fs.Stats, prev: fs.Stats) => void }> = [];
  private heartbeat: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly aiDir: string,
    private readonly heartbeatMs: number,
  ) {}

  subscribe(res: http.ServerResponse): void {
    if (this.closed) {
      sendPipelineError(res, 503, 'SHUTTING_DOWN', 'Studio server is shutting down');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.socket?.setNoDelay(true);
    // Reconnect delay for EventSource; the comment line flushes the headers right away.
    res.write('retry: 3000\n: connected\n\n');
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stop();
    });
    this.start();
  }

  /** Pushes an agent-supervisor event (`runner_status`, `runner_log`, `runner_token_usage`) to every connected client. */
  publish(event: 'runner_status' | 'runner_log' | 'runner_token_usage', data: unknown): void {
    if (this.closed || this.clients.size === 0) return;
    this.broadcast(event, data);
  }

  /** SSE responses never finish on their own; drop them so http.Server#close() can complete. */
  close(): void {
    this.closed = true;
    for (const res of this.clients) res.destroy();
    this.clients.clear();
    this.stop();
  }

  private start(): void {
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.broadcast('heartbeat', { at: new Date().toISOString() }), this.heartbeatMs);
      this.heartbeat.unref();
    }
    if (this.watcher || this.pollers.length) return;
    try {
      this.watcher = fs.watch(this.aiDir, { persistent: false }, (_event, filename) => {
        if (filename) this.queue(String(filename));
      });
      this.watcher.on('error', () => {
        this.closeWatcher();
        if (this.clients.size) this.startPolling();
      });
    } catch {
      // .ai/ is missing (studio started before `nativ init`) or not watchable: poll the files instead.
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollers.length) return;
    for (const file of WATCHED_FILES.keys()) {
      // Missing files report zeroed stats, so an unchanged mtime means nothing happened.
      const listener = (curr: fs.Stats, prev: fs.Stats) => {
        if (curr.mtimeMs !== prev.mtimeMs) this.queue(file);
      };
      fs.watchFile(path.join(this.aiDir, file), { interval: WATCH_POLL_INTERVAL_MS, persistent: false }, listener);
      this.pollers.push({ file, listener });
    }
  }

  private stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.heartbeat = this.flushTimer = null;
    this.pending.clear();
    this.closeWatcher();
    for (const { file, listener } of this.pollers) fs.unwatchFile(path.join(this.aiDir, file), listener);
    this.pollers = [];
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private queue(file: string): void {
    const event = WATCHED_FILES.get(file);
    if (!event) return;
    const files = this.pending.get(event) ?? new Set<string>();
    files.add(file);
    this.pending.set(event, files);
    this.flushTimer ??= setTimeout(() => this.flush(), EVENT_DEBOUNCE_MS);
  }

  private flush(): void {
    this.flushTimer = null;
    const at = new Date().toISOString();
    for (const [event, files] of this.pending) this.broadcast(event, { files: [...files], at });
    this.pending.clear();
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }
}

/**
 * Interactive simulation engine for Mission Control Studio.
 * Broadcasts realistic multi-agent execution steps over the SSE stream
 * without modifying workspace files or invoking external model APIs.
 */
class SimulationController {
  private activeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private currentId: string | null = null;

  constructor(private readonly events: PipelineEventHub) {}

  start(body: Record<string, unknown> = {}) {
    this.stop();
    const id = `sim-${Date.now()}`;
    this.currentId = id;
    this.running = true;
    const speed = Math.max(1, Math.min(5, Number(body.speedMultiplier) || 1));
    const scenario = String(body.scenario || 'default');

    type Step = {
      taskId: string;
      phase: RunnerStatus;
      stream?: 'stdout' | 'stderr';
      log?: string;
      delay: number;
    };

    const steps: Step[] = [
      // Step 1: Foundation task (qa-tester)
      { taskId: 'task-01', phase: 'spawning_worktree', log: '[qa-tester] Provisioning isolated worktree branch for task-01...\n', delay: 400 },
      { taskId: 'task-01', phase: 'running', log: '[qa-tester] Validating dependencies, project manifest and baseline checks...\n', delay: 600 },
      { taskId: 'task-01', phase: 'verifying', log: '[gatekeeper] Running verification command: npm test\n✔ Baseline contracts validated\n', delay: 600 },
      { taskId: 'task-01', phase: 'completed', log: '[qa-tester] Task task-01 passed verification and merged.\n', delay: 400 },

      // Step 2: Parallel execution (backend & frontend)
      { taskId: 'task-studio-sse-api', phase: 'spawning_worktree', log: '[backend] Initializing git worktree .nativ/worktrees/task-studio-sse-api...\n', delay: 300 },
      { taskId: 'task-studio-light-ui', phase: 'spawning_worktree', log: '[frontend] Initializing git worktree .nativ/worktrees/task-studio-light-ui...\n', delay: 300 },
      { taskId: 'task-studio-sse-api', phase: 'running', log: '[backend] Implementing real-time event pipeline fanout & simulation endpoints in studio-server.ts...\n', delay: 700 },
      { taskId: 'task-studio-light-ui', phase: 'running', log: '[frontend] Constructing SVG Workflow Canvas with Bezier cables and floating playback bar...\n', delay: 700 },
      { taskId: 'task-studio-sse-api', phase: 'verifying', log: '[gatekeeper] Executing test-studio-pipeline-api.mjs...\n✔ All API endpoints passed\n', delay: 600 },
      { taskId: 'task-studio-sse-api', phase: 'merging', log: '[backend] Merging worktree branch to main...\n', delay: 300 },
      { taskId: 'task-studio-sse-api', phase: 'completed', log: '[backend] SSE pipeline stream online.\n', delay: 400 },

      { taskId: 'task-studio-light-ui', phase: 'verifying', log: '[gatekeeper] Executing test-studio-light-ui.mjs...\n✔ Zero-emoji compliance and Canvas DOM validated\n', delay: 600 },
      { taskId: 'task-studio-light-ui', phase: 'merging', log: '[frontend] Merging worktree branch to main...\n', delay: 300 },
      { taskId: 'task-studio-light-ui', phase: 'completed', log: '[frontend] Workflow Canvas ready.\n', delay: 400 },

      // Step 3: End-to-end integration & verification
      { taskId: 'task-studio-e2e-verify', phase: 'spawning_worktree', log: '[qa-tester] Spawning E2E integration test runner...\n', delay: 300 },
      { taskId: 'task-studio-e2e-verify', phase: 'running', log: '[qa-tester] Running comprehensive integration test matrix...\n', delay: 800 },
      ...(scenario === 'circuit_breaker_heal'
        ? [
            { taskId: 'task-studio-e2e-verify', phase: 'failed' as RunnerStatus, stream: 'stderr' as const, log: '[qa-tester] Invariant violation detected: test mock failure. Circuit breaker tripped.\n', delay: 600 },
          ]
        : [
            { taskId: 'task-studio-e2e-verify', phase: 'verifying' as RunnerStatus, log: '[gatekeeper] Full E2E suite passed.\n', delay: 600 },
            { taskId: 'task-studio-e2e-verify', phase: 'completed' as RunnerStatus, log: '[qa-tester] All milestones verified.\n', delay: 400 },
          ]),
    ];

    let stepIndex = 0;
    const runNext = () => {
      if (!this.running || stepIndex >= steps.length) {
        this.running = false;
        return;
      }
      const step = steps[stepIndex++];
      const record: RunnerRecord = {
        runId: `${id}-${step.taskId}`,
        taskId: step.taskId,
        status: step.phase,
        engine: 'native',
        model: 'claude-opus-5-5 (simulation)',
        thinking: { budget: 2048, effort: 'medium', budgetTokens: 2048 },
        usage: {
          model: 'claude-opus-5-5 (simulation)',
          turns: 3,
          inputTokens: 1400,
          outputTokens: 380,
          cacheCreationTokens: 500,
          cacheReadTokens: 4000,
          thinkingTokens: 120,
          costUsd: 0.011,
        },
        pid: 99000 + stepIndex,
        branch: `nativ/${step.taskId}`,
        worktreeDir: `.nativ/worktrees/${step.taskId}`,
        command: 'simulation',
        startedAt: new Date(Date.now() - 2000).toISOString(),
        endedAt: step.phase === 'completed' || step.phase === 'failed' ? new Date().toISOString() : null,
        durationMs: 2500,
        exitCode: step.phase === 'completed' ? 0 : step.phase === 'failed' ? 1 : null,
        signal: null,
        timeoutSeconds: 300,
        timedOut: false,
        logBytes: (step.log || '').length,
        logFile: `.nativ/logs/${step.taskId}.log`,
        error: step.phase === 'failed' ? (step.log || 'Task failed') : null,
        abortReason: null,
        verification: step.phase === 'completed' ? { command: 'npm test', success: true, exitCode: 0, durationMs: 400, skipped: false } : null,
      };

      this.events.publish('runner_status', runView(record));
      if (step.log) {
        this.events.publish('runner_log', {
          runId: `${id}-${step.taskId}`,
          taskId: step.taskId,
          stream: step.stream ?? 'stdout',
          chunk: step.log,
          at: new Date().toISOString(),
        });
      }

      this.activeTimer = setTimeout(runNext, Math.max(80, Math.round(step.delay / speed)));
    };

    this.activeTimer = setTimeout(runNext, Math.round(150 / speed));

    return {
      ok: true,
      simulationId: id,
      scenario,
      speed,
      status: 'running',
    };
  }

  stop() {
    if (this.activeTimer) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    const wasRunning = this.running;
    this.running = false;
    this.currentId = null;
    return { ok: true, status: 'stopped', wasRunning };
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
    return options.html ?? '<!doctype html><title>nativ DB Studio</title><p>Studio API is running. See /api/status.</p>';
  };

  // Pipeline endpoints read the project that owns .ai/ (climbing out of .worktrees/task-* when needed).
  const root = resolveProjectRoot(cwd);
  const heartbeatMs = options.heartbeatMs && options.heartbeatMs > 0 ? options.heartbeatMs : DEFAULT_HEARTBEAT_MS;
  const events = new PipelineEventHub(path.join(root, AI_DIR), heartbeatMs);

  // Background agent runs: lifecycle phases, stdout/stderr chunks and per-turn token usage
  // (native engine) fan out over /api/events.
  const supervisor = new AgentSupervisor({ ...options.supervisor, cwd: root });
  supervisor.on('runner_status', (record: RunnerRecord) => events.publish('runner_status', runView(record)));
  supervisor.on('runner_log', (entry: unknown) => events.publish('runner_log', entry));
  supervisor.on('runner_token_usage', (usage: RunnerTokenUsageEvent) => events.publish('runner_token_usage', usage));

  const simulation = new SimulationController(events);

  // Tier 1 strategist: settings and counters live for this server session only.
  const liaison = new Tier1Liaison(root, options.triage);
  const triageInFlight = new Map<string, Promise<ReturnType<typeof triageView>>>();

  // Concurrent "Run Benchmark" requests share one in-flight run.
  let benchmarkRun: Promise<BenchmarkReport> | null = null;
  const runBenchmarkSuite = (): Promise<BenchmarkReport> => {
    benchmarkRun ??= runCaptured(() => runBench(root, { json: true }))
      .then(({ result, output }) => {
        if (!result) throw new HttpError(500, 'BENCHMARK_FAILED', truncateOutput(output || 'Benchmark suite failed to run'));
        return result;
      })
      .finally(() => {
        benchmarkRun = null;
      });
    return benchmarkRun;
  };

  const server = http.createServer(async (req, res) => {
    let pathname = '';
    try {
      assertLocalRequest(req);
      const url = new URL(req.url ?? '/', 'http://localhost');
      pathname = url.pathname;
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
        case 'POST /api/tests/generate':
          return sendJson(res, 200, handleTestGenerate(cwd, await readJsonBody(req)));
        case 'GET /api/events':
          events.subscribe(res);
          return;
        case 'GET /api/pipeline/status':
          return sendJson(res, 200, handlePipelineStatus(root));
        case 'GET /api/pipeline/tasks':
          return sendJson(res, 200, handlePipelineTasks(root));
        case 'POST /api/pipeline/tasks/action':
          return sendJson(res, 200, await handleTaskAction(root, await readJsonBody(req)));
        case 'POST /api/pipeline/tasks/dispatch':
          return sendJson(res, 200, await handleTaskDispatch(supervisor, await readJsonBody(req)));
        case 'POST /api/pipeline/tasks/abort':
          return sendJson(res, 200, await handleTaskAbort(supervisor, await readJsonBody(req)));
        case 'GET /api/pipeline/tasks/runs':
          return sendJson(res, 200, handleTaskRuns(supervisor, url.searchParams));
        case 'GET /api/pipeline/tasks/logs':
          return sendJson(res, 200, handleTaskLogs(supervisor, url.searchParams));
        case 'GET /api/pipeline/worktrees':
          return sendJson(res, 200, { ok: true, worktrees: await describeWorktrees(root) });
        case 'POST /api/pipeline/worktrees/action':
          return sendJson(res, 200, await handleWorktreeAction(root, await readJsonBody(req)));
        case 'GET /api/pipeline/worktrees/diff':
          return sendJson(res, 200, await handleWorktreeDiff(root, url.searchParams));
        case 'GET /api/pipeline/benchmarks':
          return sendJson(res, 200, handleBenchmarks(root));
        case 'POST /api/pipeline/benchmarks/run':
          return sendJson(res, 200, { ok: true, report: await runBenchmarkSuite() });
        case 'GET /api/pipeline/telemetry/detailed':
          return sendJson(res, 200, handleTelemetryDetailed(root, supervisor));
        case 'GET /api/pipeline/escalations':
          return sendJson(res, 200, handleEscalations(root, url.searchParams));
        case 'POST /api/pipeline/escalations/resolve':
          return sendJson(res, 200, await handleEscalationResolve(root, await readJsonBody(req)));
        case 'POST /api/pipeline/simulation/start':
          return sendJson(res, 200, simulation.start(await readJsonBody(req)));
        case 'POST /api/pipeline/simulation/stop':
          return sendJson(res, 200, simulation.stop());
        case 'POST /api/pipeline/triage/evaluate':
          return sendJson(res, 200, await handleTriageEvaluate(root, liaison, triageInFlight, await readJsonBody(req)));
        case 'GET /api/pipeline/triage/status':
          return sendJson(res, 200, liaison.getStatus());
        case 'POST /api/pipeline/triage/config':
          return sendJson(res, 200, handleTriageConfig(liaison, await readJsonBody(req)));
        case 'GET /favicon.ico':
          res.writeHead(204).end();
          return;
      }

      if (url.pathname.startsWith('/api/')) {
        const known = [
          '/api/status', '/api/env-info', '/api/schema', '/api/diff', '/api/connect', '/api/export-contract', '/api/data', '/api/tests/generate',
          '/api/events', '/api/pipeline/status', '/api/pipeline/tasks', '/api/pipeline/tasks/action', '/api/pipeline/tasks/dispatch',
          '/api/pipeline/tasks/abort', '/api/pipeline/tasks/runs', '/api/pipeline/tasks/logs', '/api/pipeline/worktrees',
          '/api/pipeline/worktrees/action', '/api/pipeline/worktrees/diff', '/api/pipeline/benchmarks', '/api/pipeline/benchmarks/run',
          '/api/pipeline/telemetry/detailed', '/api/pipeline/escalations', '/api/pipeline/escalations/resolve',
          '/api/pipeline/simulation/start', '/api/pipeline/simulation/stop', '/api/pipeline/triage/evaluate',
          '/api/pipeline/triage/status', '/api/pipeline/triage/config',
        ];
        if (known.includes(url.pathname.replace(/\/+$/, ''))) throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed on ${url.pathname}`);
        throw new HttpError(404, 'NOT_FOUND', `No route for ${url.pathname}`);
      }
      throw new HttpError(404, 'NOT_FOUND', 'Not found');
    } catch (err) {
      const send = pathname.startsWith('/api/pipeline/') ? sendPipelineError : sendError;
      if (err instanceof HttpError) return send(res, err.status, err.code, err.message);
      // Unexpected failures: generic message only, to avoid echoing anything credential-bearing.
      session.invalidate();
      return send(res, 500, 'INTERNAL_ERROR', 'Unexpected studio server error');
    }
  });

  // Open SSE streams and in-flight agent runners would otherwise keep close() waiting forever.
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    simulation.stop();
    supervisor.shutdown('Studio server shutting down');
    events.close();
    return closeServer(callback);
  }) as typeof server.close;

  return server;
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
