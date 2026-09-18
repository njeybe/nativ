/**
 * Database telemetry & schema types.
 * Shapes conform to .ai/api_contracts.json (status/schema/diff/connect/export-contract)
 * and the table model in .ai/db_schema.json.
 */

export type SqlEngine = 'postgresql' | 'mysql' | 'sqlite';

export type NoSqlEngine = 'mongodb' | 'firestore';

export type DatabaseEngine = SqlEngine | NoSqlEngine;

export const NOSQL_ENGINES: readonly NoSqlEngine[] = ['mongodb', 'firestore'];

export function isNoSqlEngine(engine: string): engine is NoSqlEngine {
  return (NOSQL_ENGINES as readonly string[]).includes(engine);
}

/** SQL engines expose tables; document stores expose collections. */
export type EntityType = 'table' | 'collection';

export type DatabaseEnv = 'dev' | 'prod';

/** Per-environment telemetry returned by GET /api/status. */
export interface DatabaseStatus {
  connected: boolean;
  engine: DatabaseEngine;
  database: string;
  maskedUrl: string;
  pingMs: number;
  /** Number of tables or collections (contract field). */
  entityCount?: number;
  entityType?: EntityType;
  /** @deprecated Legacy alias of entityCount, kept for existing CLI/studio consumers. */
  tableCount: number;
  error: string | null;
}

export interface StatusResponse {
  dev: DatabaseStatus;
  prod: DatabaseStatus;
}

/** Where a detected image field's value lives. */
export type MediaSource = 'url' | 'gcs' | 'base64' | 'bytes';

/**
 * Metadata about a detected image/media field, taken from sampled documents.
 * Raw binary never appears here: bytes/base64 fields only report MIME type, size,
 * dimensions and a short truncated prefix. URLs have credential-like query params redacted.
 */
export interface MediaFieldInfo {
  source: MediaSource;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  /** Redacted http(s) URL or gs:// URI of one sampled value, for thumbnail preview. */
  sampleUrl: string | null;
  /** First few characters of a base64 value (display only, never decodable into the image). */
  base64Head: string | null;
}

export interface ColumnSchema {
  name: string;
  /** SQL type (VARCHAR(255), UUID…) or NoSQL type (STRING, NUMBER, MAP, ARRAY, OBJECTID, DOCUMENT_ID, BYTES, IMAGE_URL…). */
  type: string;
  primaryKey: boolean;
  nullable: boolean;
  default: string | null;
  /** True when the field holds images (URL, gs:// URI, Base64 data URI, or Bytes). */
  isMedia?: boolean;
  /** True when this entry is a Firestore nested subcollection rather than a document field. */
  isSubcollection?: boolean;
  media?: MediaFieldInfo;
  /** NoSQL only: fraction (0–1) of sampled documents that contain this field. */
  presence?: number;
  /** NoSQL only: all distinct types observed across samples when a field is polymorphic. */
  observedTypes?: string[];
}

export interface IndexSchema {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeySchema {
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete?: string;
}

export interface TableSchema {
  name: string;
  /** 'collection' for MongoDB/Firestore; absent or 'table' for SQL engines. */
  entityType?: EntityType;
  description?: string;
  /** For collections, `columns` are the document fields inferred from sampled documents. */
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  /** NoSQL only: estimated number of documents in the collection. */
  documentCount?: number;
  /** NoSQL only: number of documents sampled (≤ 50) to infer fields. */
  sampledDocuments?: number;
}

/** GET /api/schema response. */
export interface SchemaResponse {
  devTables: TableSchema[];
  prodTables: TableSchema[];
}

/** A column present on both sides whose definition differs. */
export interface ColumnChange {
  name: string;
  before: ColumnSchema;
  after: ColumnSchema;
  changedFields: Array<keyof Omit<ColumnSchema, 'name'>>;
}

export interface TableDiff {
  name: string;
  addedColumns: ColumnSchema[];
  droppedColumns: ColumnSchema[];
  alteredColumns: ColumnChange[];
  addedIndexes: IndexSchema[];
  droppedIndexes: IndexSchema[];
  addedForeignKeys: ForeignKeySchema[];
  droppedForeignKeys: ForeignKeySchema[];
  isDestructive: boolean;
}

export interface SchemaDiffSummary {
  addedTablesCount: number;
  alteredTablesCount: number;
  droppedTablesCount: number;
  unchangedTablesCount: number;
  hasDestructiveChanges: boolean;
}

/** GET /api/diff response. */
export interface SchemaDiff {
  summary: SchemaDiffSummary;
  addedTables: TableSchema[];
  droppedTables: TableSchema[];
  alteredTables: TableDiff[];
  unchangedTables: string[];
}

export type DiffTarget = 'prod' | 'contract';

/** Firestore connection settings (credentials come from Application Default Credentials, never from here). */
export interface FirestoreConfig {
  projectId: string;
  /** host:port of a local Firestore emulator, e.g. "localhost:8080". */
  emulatorHost?: string;
  /** Firestore database id for multi-database projects (defaults to "(default)"). */
  databaseId?: string;
}

/** POST /api/connect */
export interface ConnectRequest {
  env: DatabaseEnv;
  engine?: DatabaseEngine;
  /** Required for SQL engines and MongoDB; optional for Firestore when firestoreConfig is given. */
  connectionUrl?: string;
  firestoreConfig?: FirestoreConfig;
}

export interface ConnectResponse {
  success: boolean;
  pingMs: number;
  engine: string;
  entityCount?: number;
  /** @deprecated Legacy alias of entityCount. */
  tableCount: number;
  maskedUrl: string;
  error: string | null;
}

/** POST /api/export-contract */
export interface ExportContractRequest {
  sourceEnv: DatabaseEnv;
}

export interface ExportContractResponse {
  success: boolean;
  filePath: string;
  exportedEntitiesCount?: number;
  /** @deprecated Legacy alias of exportedEntitiesCount. */
  exportedTablesCount: number;
}
