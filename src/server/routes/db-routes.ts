import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
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
} from '../../db/types.js';
import {
  connectionUrlFromComponents,
  detectEngine,
  detectExampleDbKeys,
  firestoreUrlFromConfig,
  maskConnectionString,
  resolveConnections,
} from '../../db/env-parser.js';
import { disconnectedStatus, introspectDatabase, type IntrospectionResult } from '../../db/introspector.js';
import {
  CONTRACT_SCHEMA_PATH,
  diffSchemas,
  loadContractEngine,
  loadContractTables,
  toContractDiff,
  type ContractSchemaDiff,
} from '../../db/diff.js';
import { fetchData, insertRecord, updateRecord, deleteRecord } from '../../db/data-engine.js';
import { generateContractTests, TestGenError } from '../../core/test-generator.js';
import { isTestFramework, TEST_FRAMEWORKS, type TestGenResult } from '../../core/test-generator-types.js';
import { HttpError, parseEnv } from '../http-utils.js';

export const CACHE_TTL_MS = 5000;
export const ENVS: DatabaseEnv[] = ['dev', 'prod'];

/** Where a session URL came from; shown as badges in status output. */
export interface ConnectionMeta {
  sourceKey?: string;
  detectedFromExample?: boolean;
  exampleFile?: string | null;
  synthesized?: boolean;
}

/** In-memory studio session: raw URLs never leave this object except to database drivers. */
export class StudioSession {
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

export async function handleStatus(session: StudioSession, fresh: boolean): Promise<StatusResponse> {
  const [dev, prod] = await Promise.all(ENVS.map((env) => session.introspect(env, fresh)));
  return { dev: dev.status, prod: prod.status };
}

export async function handleSchema(session: StudioSession, envParam: string | null, fresh: boolean): Promise<SchemaResponse> {
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
export async function handleDiff(session: StudioSession, cwd: string, targetParam: string | null, fresh: boolean): Promise<ContractSchemaDiff> {
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

export const ENGINES: DatabaseEngine[] = ['postgresql', 'mysql', 'sqlite', 'mongodb', 'firestore'];

export function parseFirestoreConfig(value: unknown): FirestoreConfig | null {
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

export const COMPONENT_ENGINES: ComponentEngine[] = ['mysql', 'postgresql'];

export function optionalString(raw: Record<string, unknown>, field: string): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', `"components.${field}" must be a string`);
  return value;
}

/** Validates the `components` payload ({ engine, host, port, user, password, database }). */
export function parseComponents(value: unknown, topLevelEngine: DatabaseEngine | null): ConnectionComponents | null {
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
export async function handleConnect(session: StudioSession, body: Record<string, unknown>): Promise<ConnectResponse> {
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

export async function handleExportContract(session: StudioSession, cwd: string, body: Record<string, unknown>): Promise<ExportContractResponse> {
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

export const TEST_GEN_ERROR_STATUS: Record<string, number> = {
  INVALID_FRAMEWORK: 400,
  INVALID_BASE_URL: 400,
  INVALID_OUTPUT_PATH: 400,
  NO_CONTRACTS: 404,
  OUTPUT_CONFLICT: 409,
  INVALID_CONTRACT: 422,
};

/** POST /api/tests/generate. Output is confined to the project directory. */
export function handleTestGenerate(cwd: string, body: Record<string, unknown>): TestGenResult {
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

export function logProdAudit(
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

export async function handleDataGet(session: StudioSession, searchParams: URLSearchParams): Promise<unknown> {
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
    throw new HttpError(500, 'DATA_FETCH_ERROR', (err as Error).message);
  }
}

export async function handleDataPost(session: StudioSession, cwd: string, body: Record<string, unknown>, req: http.IncomingMessage): Promise<unknown> {
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
      const pk = (result as { id?: string | number })?.id ?? null;
      logProdAudit(cwd, 'INSERT', entity, pk, { record }, req);
    }
    return result;
  } catch (err) {
    throw new HttpError(500, 'DATA_MUTATION_ERROR', (err as Error).message);
  }
}

export async function handleDataPut(session: StudioSession, cwd: string, body: Record<string, unknown>, req: http.IncomingMessage): Promise<unknown> {
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

export async function handleDataDelete(session: StudioSession, cwd: string, body: Record<string, unknown>, req: http.IncomingMessage): Promise<unknown> {
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
