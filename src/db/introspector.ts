import { performance } from 'node:perf_hooks';
import type { ColumnSchema, DatabaseEngine, DatabaseStatus, ForeignKeySchema, IndexSchema, MediaFieldInfo, TableSchema } from './types.js';
import { isNoSqlEngine } from './types.js';
import {
  databaseNameFromUrl,
  detectEngine,
  maskConnectionString,
  MASK,
  parseFirestoreUrl,
  redactMediaUrl,
  sqlitePathFromUrl,
} from './env-parser.js';

/**
 * Multi-engine schema introspector.
 * Reads structural metadata only (tables, columns, types, nullability, keys, indexes).
 * Never issues data-reading queries against user tables.
 *
 * Drivers are imported lazily so plain CLI commands don't pay for pg/mysql2 load time
 * or trigger node:sqlite's ExperimentalWarning.
 */

const CONNECT_TIMEOUT_MS = 8000;

export interface IntrospectionResult {
  status: DatabaseStatus;
  tables: TableSchema[];
}

interface Driver {
  ping(): Promise<void>;
  databaseName(): Promise<string>;
  tables(): Promise<TableSchema[]>;
  close(): Promise<void>;
}

// ─── Shared helpers ────────────────────────────────────────────────────────────

class TableBuilder {
  private readonly map = new Map<string, TableSchema>();

  get(name: string): TableSchema {
    let table = this.map.get(name);
    if (!table) {
      table = { name, columns: [], indexes: [], foreignKeys: [] };
      this.map.set(name, table);
    }
    return table;
  }

  build(): TableSchema[] {
    return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Removes any trace of the raw connection string or password from driver error text. */
function sanitizeError(err: unknown, url: string): string {
  let message = err instanceof Error ? err.message : String(err);
  if (!message) message = 'Unknown database error';
  message = message.split(url).join(maskConnectionString(url));
  try {
    const password = new URL(url).password;
    if (password) {
      message = message.split(password).join(MASK);
      const decoded = decodeURIComponent(password);
      if (decoded) message = message.split(decoded).join(MASK);
    }
  } catch {
    // Non-URL (e.g. SQLite path) — nothing further to scrub.
  }
  return message;
}

// ─── PostgreSQL ────────────────────────────────────────────────────────────────

const PG_ON_DELETE: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

function formatPgType(row: {
  data_type: string;
  udt_name: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}): string {
  const dataType = row.data_type.toLowerCase();
  if (dataType === 'user-defined') return row.udt_name.toUpperCase();
  if (dataType === 'array') return `${row.udt_name.replace(/^_/, '').toUpperCase()}[]`;
  const aliases: Record<string, string> = {
    'character varying': 'VARCHAR',
    character: 'CHAR',
    'timestamp without time zone': 'TIMESTAMP',
    'time without time zone': 'TIME',
  };
  const base = aliases[dataType] ?? dataType.toUpperCase();
  if (row.character_maximum_length != null) return `${base}(${row.character_maximum_length})`;
  if (dataType === 'numeric' && row.numeric_precision != null) {
    return row.numeric_scale ? `${base}(${row.numeric_precision},${row.numeric_scale})` : `${base}(${row.numeric_precision})`;
  }
  return base;
}

async function createPostgresDriver(url: string): Promise<Driver> {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS, statement_timeout: 15000 });
  await client.connect();

  return {
    async ping() {
      await client.query('SELECT 1');
    },
    async databaseName() {
      const res = await client.query<{ db: string }>('SELECT current_database() AS db');
      return res.rows[0]?.db ?? '';
    },
    async tables() {
      const builder = new TableBuilder();

      const tables = await client.query<{ table_name: string; description: string | null }>(`
        SELECT t.table_name, obj_description(format('%I.%I', t.table_schema, t.table_name)::regclass, 'pg_class') AS description
        FROM information_schema.tables t
        WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`);
      for (const row of tables.rows) {
        const table = builder.get(row.table_name);
        if (row.description) table.description = row.description;
      }

      const pks = await client.query<{ table_name: string; column_name: string }>(`
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY'`);
      const pkSet = new Set(pks.rows.map((r) => `${r.table_name}.${r.column_name}`));

      const columns = await client.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        udt_name: string;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
        is_nullable: string;
        column_default: string | null;
      }>(`
        SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.character_maximum_length,
               c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = current_schema()
        ORDER BY c.table_name, c.ordinal_position`);
      for (const row of columns.rows) {
        builder.get(row.table_name).columns.push({
          name: row.column_name,
          type: formatPgType(row),
          primaryKey: pkSet.has(`${row.table_name}.${row.column_name}`),
          nullable: row.is_nullable === 'YES',
          default: row.column_default,
        });
      }

      // information_schema has no index view — pg_catalog is the only source.
      const indexes = await client.query<{ table_name: string; index_name: string; is_unique: boolean; columns: string[] | null }>(`
        SELECT t.relname AS table_name, i.relname AS index_name, ix.indisunique AS is_unique,
               (SELECT array_agg(a.attname::text ORDER BY k.ord)
                  FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS columns
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema() AND NOT ix.indisprimary AND t.relkind IN ('r', 'p')
        ORDER BY t.relname, i.relname`);
      for (const row of indexes.rows) {
        builder.get(row.table_name).indexes.push({ name: row.index_name, columns: row.columns ?? [], unique: row.is_unique });
      }

      const fks = await client.query<{
        constraint_name: string;
        table_name: string;
        column_name: string;
        ref_table: string;
        ref_column: string;
        on_delete: string;
      }>(`
        SELECT con.conname AS constraint_name, cl.relname AS table_name, a.attname AS column_name,
               fcl.relname AS ref_table, fa.attname AS ref_column, con.confdeltype AS on_delete
        FROM pg_constraint con
        JOIN pg_class cl ON cl.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
        JOIN pg_class fcl ON fcl.oid = con.confrelid
        CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, fattnum)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.fattnum
        WHERE n.nspname = current_schema() AND con.contype = 'f'
        ORDER BY cl.relname, con.conname`);
      for (const row of fks.rows) {
        builder.get(row.table_name).foreignKeys.push({
          name: row.constraint_name,
          column: row.column_name,
          referencedTable: row.ref_table,
          referencedColumn: row.ref_column,
          onDelete: PG_ON_DELETE[row.on_delete] ?? 'NO ACTION',
        });
      }

      return builder.build();
    },
    async close() {
      await client.end().catch(() => undefined);
    },
  };
}

// ─── MySQL / MariaDB ──────────────────────────────────────────────────────────

async function createMysqlDriver(url: string): Promise<Driver> {
  const mysql = (await import('mysql2/promise')).default;
  const normalizedUrl = url.replace(/^(mysql2|mariadb):\/\//i, 'mysql://');
  const conn = await mysql.createConnection({ uri: normalizedUrl, connectTimeout: CONNECT_TIMEOUT_MS });

  const rows = async <T>(sql: string): Promise<T[]> => {
    const [result] = await conn.query(sql);
    return result as T[];
  };

  return {
    async ping() {
      await conn.query('SELECT 1');
    },
    async databaseName() {
      const [row] = await rows<{ db: string | null }>('SELECT DATABASE() AS db');
      return row?.db ?? '';
    },
    async tables() {
      const builder = new TableBuilder();

      for (const row of await rows<{ table_name: string; table_comment: string }>(`
        SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME`)) {
        const table = builder.get(row.table_name);
        if (row.table_comment) table.description = row.table_comment;
      }

      for (const row of await rows<{
        table_name: string;
        column_name: string;
        column_type: string;
        is_nullable: string;
        column_default: string | null;
        column_key: string;
      }>(`
        SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type,
               c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.COLUMN_KEY AS column_key
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t
          ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
        WHERE c.TABLE_SCHEMA = DATABASE()
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)) {
        builder.get(row.table_name).columns.push({
          name: row.column_name,
          type: String(row.column_type).toUpperCase(),
          primaryKey: row.column_key === 'PRI',
          nullable: row.is_nullable === 'YES',
          default: row.column_default == null ? null : String(row.column_default),
        });
      }

      const indexMap = new Map<string, { table: string; index: IndexSchema }>();
      for (const row of await rows<{ table_name: string; index_name: string; non_unique: number | string; column_name: string | null }>(`
        SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY'
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)) {
        const key = `${row.table_name}.${row.index_name}`;
        let entry = indexMap.get(key);
        if (!entry) {
          entry = { table: row.table_name, index: { name: row.index_name, columns: [], unique: Number(row.non_unique) === 0 } };
          indexMap.set(key, entry);
        }
        if (row.column_name) entry.index.columns.push(row.column_name);
      }
      for (const { table, index } of indexMap.values()) builder.get(table).indexes.push(index);

      for (const row of await rows<{
        constraint_name: string;
        table_name: string;
        column_name: string;
        ref_table: string;
        ref_column: string;
        delete_rule: string;
      }>(`
        SELECT k.CONSTRAINT_NAME AS constraint_name, k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name,
               k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column, r.DELETE_RULE AS delete_rule
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`)) {
        builder.get(row.table_name).foreignKeys.push({
          name: row.constraint_name,
          column: row.column_name,
          referencedTable: row.ref_table,
          referencedColumn: row.ref_column,
          onDelete: row.delete_rule,
        });
      }

      return builder.build();
    },
    async close() {
      await conn.end().catch(() => undefined);
    },
  };
}

// ─── SQLite (node:sqlite) ─────────────────────────────────────────────────────

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function createSqliteDriver(url: string): Promise<Driver> {
  const { DatabaseSync } = await import('node:sqlite');
  const filePath = sqlitePathFromUrl(url);
  // readOnly: never create a database file or mutate one while introspecting.
  const db = filePath === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(filePath, { readOnly: true });

  return {
    async ping() {
      db.prepare('SELECT 1').get();
    },
    async databaseName() {
      return databaseNameFromUrl(url);
    },
    async tables() {
      const builder = new TableBuilder();
      const tableRows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>;

      for (const { name } of tableRows) {
        const table = builder.get(name);
        const ident = quoteIdent(name);

        const cols = db.prepare(`PRAGMA table_info(${ident})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }>;
        table.columns = cols.map<ColumnSchema>((c) => ({
          name: c.name,
          type: (c.type || 'ANY').toUpperCase(),
          primaryKey: Number(c.pk) > 0,
          // SQLite allows NULL in non-INTEGER primary keys unless NOT NULL is declared; report declared constraint.
          nullable: Number(c.notnull) === 0 && Number(c.pk) === 0,
          default: c.dflt_value ?? null,
        }));

        const idxList = db.prepare(`PRAGMA index_list(${ident})`).all() as Array<{ name: string; unique: number; origin: string }>;
        for (const idx of idxList) {
          if (idx.origin === 'pk') continue;
          const idxCols = db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ seqno: number; name: string | null }>;
          table.indexes.push({
            name: idx.name,
            columns: idxCols.sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((c) => c.name ?? '').filter(Boolean),
            unique: Number(idx.unique) === 1,
          });
        }

        const fkList = db.prepare(`PRAGMA foreign_key_list(${ident})`).all() as Array<{
          id: number;
          table: string;
          from: string;
          to: string | null;
          on_delete: string;
        }>;
        table.foreignKeys = fkList.map<ForeignKeySchema>((fk) => ({
          // SQLite doesn't retain FK constraint names; synthesize a stable one.
          name: `fk_${name}_${fk.from}`,
          column: fk.from,
          referencedTable: fk.table,
          referencedColumn: fk.to ?? 'rowid',
          onDelete: fk.on_delete,
        }));
      }

      return builder.build();
    },
    async close() {
      db.close();
    },
  };
}

// ─── Media / image detection ──────────────────────────────────────────────────

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|heic|tiff?)$/i;
const IMAGE_FIELD_HINT = /avatar|photo|image|img|picture|pic|thumbnail|thumb|logo|icon|banner|cover|selfie|portrait/i;
const IMAGE_HOSTS = /(^|\.)(gravatar\.com|images\.unsplash\.com|res\.cloudinary\.com|imgix\.net|i\.imgur\.com)$/i;
/** Only the first bytes are needed to sniff format and dimensions. */
const SNIFF_BYTES = 64 * 1024;

interface SniffResult {
  mimeType: string;
  width: number | null;
  height: number | null;
}

/** Identifies an image from its magic bytes and reads dimensions from the header (PNG/GIF/JPEG/WebP/BMP). */
function sniffImage(bytes: Uint8Array): SniffResult | null {
  const b = bytes;
  const len = b.length;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le32 = (i: number) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

  if (len >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return { mimeType: 'image/png', width: len >= 24 ? be32(16) : null, height: len >= 24 ? be32(20) : null };
  }
  if (len >= 6 && ascii(0, 4) === 'GIF8') {
    return { mimeType: 'image/gif', width: len >= 10 ? le16(6) : null, height: len >= 10 ? le16(8) : null };
  }
  if (len >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < len) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mimeType: 'image/jpeg', width: be16(i + 7), height: be16(i + 5) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + be16(i + 2);
    }
    return { mimeType: 'image/jpeg', width: null, height: null };
  }
  if (len >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ' && len >= 30) return { mimeType: 'image/webp', width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === 'VP8L' && len >= 25) {
      return {
        mimeType: 'image/webp',
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      };
    }
    if (chunk === 'VP8X' && len >= 30) {
      return { mimeType: 'image/webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    return { mimeType: 'image/webp', width: null, height: null };
  }
  if (len >= 26 && ascii(0, 2) === 'BM') return { mimeType: 'image/bmp', width: le32(18), height: Math.abs(le32(22) | 0) };
  if (len >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { mimeType: 'image/x-icon', width: null, height: null };
  const head = ascii(0, Math.min(len, 256)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { mimeType: 'image/svg+xml', width: null, height: null };
  return null;
}

function mimeFromPath(pathname: string): string | null {
  const match = pathname.match(IMAGE_EXT);
  return match ? IMAGE_EXT_MIME[match[1].toLowerCase()] ?? null : null;
}

function bytesMedia(bytes: Uint8Array): MediaFieldInfo | null {
  const sniff = sniffImage(bytes.subarray(0, SNIFF_BYTES));
  if (!sniff) return null;
  return { source: 'bytes', mimeType: sniff.mimeType, sizeBytes: bytes.length, width: sniff.width, height: sniff.height, sampleUrl: null, base64Head: null };
}

/** Decodes only a prefix of a base64 payload: enough to sniff, never the whole image. */
function base64Prefix(payload: string): Uint8Array {
  const chunk = payload.slice(0, Math.ceil((SNIFF_BYTES * 4) / 3 / 4) * 4);
  return new Uint8Array(Buffer.from(chunk, 'base64'));
}

function base64Size(payload: string): number {
  const clean = payload.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Classifies a sampled value as an image when it is image Bytes, a Base64 image,
 * an image URL, or a gs:// Cloud Storage URI. Returns metadata only.
 */
function detectMedia(fieldName: string, value: unknown): MediaFieldInfo | null {
  if (value instanceof Uint8Array) return bytesMedia(value);

  const bson = value as { _bsontype?: string; sub_type?: number; buffer?: unknown } | null;
  if (bson && typeof bson === 'object' && bson._bsontype === 'Binary' && bson.sub_type !== 4 && bson.buffer instanceof Uint8Array) {
    return bytesMedia(bson.buffer);
  }

  if (typeof value !== 'string' || value.length < 5) return null;
  const s = value.trim();
  const nameHint = IMAGE_FIELD_HINT.test(fieldName);

  const dataUri = s.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if (dataUri) {
    const payload = s.slice(dataUri[0].length);
    const sniff = sniffImage(base64Prefix(payload));
    return {
      source: 'base64',
      mimeType: sniff?.mimeType ?? dataUri[1].toLowerCase(),
      sizeBytes: base64Size(payload),
      width: sniff?.width ?? null,
      height: sniff?.height ?? null,
      sampleUrl: null,
      base64Head: `${s.slice(0, dataUri[0].length + 16)}…`,
    };
  }

  if (s.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/.test(s.slice(0, 4096).replace(/\s/g, ''))) {
    const sniff = sniffImage(base64Prefix(s));
    if (sniff) {
      return { source: 'base64', mimeType: sniff.mimeType, sizeBytes: base64Size(s), width: sniff.width, height: sniff.height, sampleUrl: null, base64Head: `${s.slice(0, 24)}…` };
    }
    return null;
  }

  if (/^gs:\/\//i.test(s)) {
    const mime = mimeFromPath(s.split(/[?#]/)[0]);
    if (!mime && !nameHint) return null;
    return { source: 'gcs', mimeType: mime, sizeBytes: null, width: null, height: null, sampleUrl: s, base64Head: null };
  }

  if (/^https?:\/\//i.test(s)) {
    let parsed: URL;
    try {
      parsed = new URL(s);
    } catch {
      return null;
    }
    let pathname = parsed.pathname;
    try {
      // Firebase Storage encodes object paths: /o/avatars%2Fu1.png
      pathname = decodeURIComponent(pathname);
    } catch {
      // keep raw pathname
    }
    const mime = mimeFromPath(pathname);
    if (!mime && !nameHint && !IMAGE_HOSTS.test(parsed.hostname)) return null;
    return { source: 'url', mimeType: mime, sizeBytes: null, width: null, height: null, sampleUrl: redactMediaUrl(s), base64Head: null };
  }

  return null;
}

// ─── NoSQL document field inference ───────────────────────────────────────────

/** Max documents read per collection, purely to infer field types (see .ai/context.md guardrails). */
export const NOSQL_SAMPLE_LIMIT = 50;
const SUBCOLLECTION_PROBE_DOCS = 10;

interface FieldStats {
  count: number;
  nullCount: number;
  types: Map<string, number>;
  mediaHits: number;
  media: MediaFieldInfo | null;
  refTargets: Map<string, number>;
}

class FieldCollector {
  private readonly fields = new Map<string, FieldStats>();
  private docs = 0;

  constructor(private readonly typeOf: (value: unknown) => string) {}

  get sampled(): number {
    return this.docs;
  }

  observe(doc: Record<string, unknown>, refTarget?: (value: unknown) => string | null): void {
    this.docs++;
    for (const [name, value] of Object.entries(doc)) {
      let stats = this.fields.get(name);
      if (!stats) {
        stats = { count: 0, nullCount: 0, types: new Map(), mediaHits: 0, media: null, refTargets: new Map() };
        this.fields.set(name, stats);
      }
      stats.count++;
      const type = this.typeOf(value);
      if (type === 'NULL') {
        stats.nullCount++;
        continue;
      }
      stats.types.set(type, (stats.types.get(type) ?? 0) + 1);
      const media = detectMedia(name, value);
      if (media) {
        stats.mediaHits++;
        // Prefer a sample that can actually be previewed.
        if (!stats.media || (!stats.media.sampleUrl && media.sampleUrl)) stats.media = media;
      }
      const target = refTarget?.(value);
      if (target) stats.refTargets.set(target, (stats.refTargets.get(target) ?? 0) + 1);
    }
  }

  build(primaryKey: string, primaryKeyType?: string): { columns: ColumnSchema[]; references: Array<{ column: string; table: string }> } {
    const columns: ColumnSchema[] = [];
    const references: Array<{ column: string; table: string }> = [];
    const docs = Math.max(this.docs, 1);

    for (const [name, stats] of this.fields) {
      const nonNull = stats.count - stats.nullCount;
      const observed = [...stats.types.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
      let type = observed.length === 0 ? 'NULL' : observed.length === 1 ? observed[0] : 'MIXED';
      const isMedia = nonNull > 0 && stats.mediaHits >= Math.max(1, Math.ceil(nonNull * 0.5));
      if (isMedia && stats.media && (stats.media.source === 'url' || stats.media.source === 'gcs') && type === 'STRING') type = 'IMAGE_URL';

      const presence = Math.round((stats.count / docs) * 100) / 100;
      const column: ColumnSchema = {
        name,
        type,
        primaryKey: false,
        nullable: stats.nullCount > 0 || stats.count < this.docs,
        default: null,
        presence,
      };
      if (observed.length > 1) column.observedTypes = observed;
      if (isMedia && stats.media) {
        column.isMedia = true;
        column.media = stats.media;
      }
      columns.push(column);

      const [topRef] = [...stats.refTargets.entries()].sort((a, b) => b[1] - a[1]);
      if (topRef) references.push({ column: name, table: topRef[0] });
    }

    let pk = columns.find((c) => c.name === primaryKey);
    if (!pk) {
      pk = { name: primaryKey, type: primaryKeyType ?? 'STRING', primaryKey: true, nullable: false, default: null, presence: 1 };
      columns.unshift(pk);
    } else {
      columns.splice(columns.indexOf(pk), 1);
      columns.unshift(pk);
    }
    pk.primaryKey = true;
    pk.nullable = false;
    if (primaryKeyType) pk.type = primaryKeyType;

    return { columns, references };
  }
}

function mongoType(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  switch (typeof value) {
    case 'string':
      return 'STRING';
    case 'number':
    case 'bigint':
      return 'NUMBER';
    case 'boolean':
      return 'BOOLEAN';
  }
  if (value instanceof Date) return 'TIMESTAMP';
  if (Array.isArray(value)) return 'ARRAY';
  if (value instanceof RegExp) return 'REGEX';
  const bson = (value as { _bsontype?: string; sub_type?: number })._bsontype;
  if (bson) {
    if (bson === 'ObjectId' || bson === 'ObjectID') return 'OBJECTID';
    if (bson === 'Binary') return (value as { sub_type?: number }).sub_type === 4 ? 'UUID' : 'BYTES';
    if (['Decimal128', 'Long', 'Int32', 'Double'].includes(bson)) return 'NUMBER';
    if (bson === 'Timestamp') return 'TIMESTAMP';
    if (bson === 'BSONRegExp') return 'REGEX';
    return bson.toUpperCase();
  }
  return 'MAP';
}

function firestoreType(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  switch (typeof value) {
    case 'string':
      return 'STRING';
    case 'number':
    case 'bigint':
      return 'NUMBER';
    case 'boolean':
      return 'BOOLEAN';
  }
  if (value instanceof Uint8Array) return 'BYTES';
  if (Array.isArray(value)) return 'ARRAY';
  switch ((value as object).constructor?.name) {
    case 'Timestamp':
      return 'TIMESTAMP';
    case 'GeoPoint':
      return 'GEOPOINT';
    case 'DocumentReference':
      return 'REFERENCE';
    case 'VectorValue':
      return 'VECTOR';
  }
  return 'MAP';
}

// ─── MongoDB ───────────────────────────────────────────────────────────────────

async function createMongoDriver(url: string): Promise<Driver> {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(url, {
    serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    appName: 'agentj-studio',
  });
  await client.connect();
  const db = client.db();

  return {
    async ping() {
      await db.command({ ping: 1 });
    },
    async databaseName() {
      return db.databaseName;
    },
    async tables() {
      const infos = await db.listCollections({}, { nameOnly: false }).toArray();
      const names = infos
        .filter((c) => (c.type === 'collection' || c.type === 'timeseries' || !c.type) && !c.name.startsWith('system.'))
        .map((c) => c.name)
        .sort((a, b) => a.localeCompare(b));

      return Promise.all(
        names.map(async (name): Promise<TableSchema> => {
          const coll = db.collection(name);
          const [documentCount, docs, indexInfo] = await Promise.all([
            coll.estimatedDocumentCount().catch(() => undefined),
            // Bounded sample for type inference only — never a full scan or dump.
            coll.find({}, { limit: NOSQL_SAMPLE_LIMIT, maxTimeMS: 10000 }).toArray(),
            coll.indexes().catch(() => [] as Array<{ name?: string; key: Record<string, unknown>; unique?: boolean }>),
          ]);

          const collector = new FieldCollector(mongoType);
          for (const doc of docs) collector.observe(doc as Record<string, unknown>);
          const { columns } = collector.build('_id', docs.length ? undefined : 'OBJECTID');

          return {
            name,
            entityType: 'collection',
            columns,
            indexes: indexInfo
              .filter((i) => i.name && i.name !== '_id_')
              .map((i) => ({ name: i.name as string, columns: Object.keys(i.key), unique: Boolean(i.unique) })),
            foreignKeys: [],
            ...(documentCount !== undefined ? { documentCount } : {}),
            sampledDocuments: collector.sampled,
          };
        }),
      );
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

// ─── Firebase Firestore ───────────────────────────────────────────────────────

async function createFirestoreDriver(url: string): Promise<Driver> {
  const config = parseFirestoreUrl(url);
  const { Firestore } = await import('@google-cloud/firestore');
  // Emulator: plain-text gRPC with the emulator's owner token. Real projects: Application
  // Default Credentials resolved by the SDK — agentj never reads or stores key files.
  const firestore = new Firestore({
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    ...(config.emulatorHost ? { host: config.emulatorHost, ssl: false } : {}),
  });

  return {
    async ping() {
      await firestore.listCollections();
    },
    async databaseName() {
      return databaseNameFromUrl(url);
    },
    async tables() {
      const collections = await firestore.listCollections();
      const tables = await Promise.all(
        collections.map(async (col): Promise<TableSchema> => {
          const [snapshot, countSnap] = await Promise.all([
            // Bounded sample for type inference only.
            col.limit(NOSQL_SAMPLE_LIMIT).get(),
            col.count().get().catch(() => null),
          ]);

          const collector = new FieldCollector(firestoreType);
          const refTarget = (value: unknown) =>
            firestoreType(value) === 'REFERENCE' ? ((value as { parent?: { id?: string } }).parent?.id ?? null) : null;
          for (const doc of snapshot.docs) collector.observe({ id: doc.id, ...doc.data() }, refTarget);
          const { columns, references } = collector.build('id', 'DOCUMENT_ID');

          // Probe the first few documents for nested subcollections.
          const probe = snapshot.docs.slice(0, SUBCOLLECTION_PROBE_DOCS);
          const subCounts = new Map<string, number>();
          const subLists = await Promise.all(probe.map((d) => d.ref.listCollections().catch(() => [])));
          for (const list of subLists) for (const sub of list) subCounts.set(sub.id, (subCounts.get(sub.id) ?? 0) + 1);
          for (const [subName, count] of [...subCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            columns.push({
              name: subName,
              type: 'SUBCOLLECTION',
              primaryKey: false,
              nullable: count < probe.length,
              default: null,
              isSubcollection: true,
              presence: Math.round((count / Math.max(probe.length, 1)) * 100) / 100,
            });
          }

          const documentCount = countSnap?.data().count;
          return {
            name: col.id,
            entityType: 'collection',
            columns,
            // Composite indexes are only visible through the Firestore Admin API, not the data SDK.
            indexes: [],
            foreignKeys: references.map((r) => ({
              name: `ref_${col.id}_${r.column}`,
              column: r.column,
              referencedTable: r.table,
              referencedColumn: 'id',
            })),
            ...(typeof documentCount === 'number' ? { documentCount } : {}),
            sampledDocuments: collector.sampled,
          };
        }),
      );
      return tables.sort((a, b) => a.name.localeCompare(b.name));
    },
    async close() {
      await firestore.terminate().catch(() => undefined);
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

const PING_TIMEOUT_MS = 12000;
const INTROSPECT_TIMEOUT_MS = 60000;

/** Bounds SDK calls that retry internally for a long time (gRPC backoff) when a host is unreachable. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openDriver(url: string, engine: DatabaseEngine): Promise<Driver> {
  switch (engine) {
    case 'postgresql':
      return createPostgresDriver(url);
    case 'mysql':
      return createMysqlDriver(url);
    case 'sqlite':
      return createSqliteDriver(url);
    case 'mongodb':
      return createMongoDriver(url);
    case 'firestore':
      return createFirestoreDriver(url);
  }
}

/** Status for an environment with no usable connection configured. */
export function disconnectedStatus(
  error: string,
  engine: DatabaseEngine = 'postgresql',
  url = '',
  meta?: { sourceKey?: string; detectedFromExample?: boolean; exampleFile?: string | null; suggestion?: string | null },
): DatabaseStatus {
  return {
    connected: false,
    engine,
    database: url ? databaseNameFromUrl(url) : '',
    maskedUrl: maskConnectionString(url),
    pingMs: 0,
    entityCount: 0,
    entityType: isNoSqlEngine(engine) ? 'collection' : 'table',
    tableCount: 0,
    error,
    ...(meta?.sourceKey ? { sourceKey: meta.sourceKey } : {}),
    ...(meta?.detectedFromExample !== undefined ? { detectedFromExample: meta.detectedFromExample } : {}),
    ...(meta?.exampleFile ? { exampleFile: meta.exampleFile } : {}),
    ...(meta?.suggestion ? { suggestion: meta.suggestion } : {}),
  };
}

/**
 * Connects, measures ping latency, and introspects the full table structure.
 * Never throws: failures are reported through `status.error` with credentials scrubbed.
 */
export async function introspectDatabase(url: string): Promise<IntrospectionResult> {
  const engine = detectEngine(url);
  if (!engine) {
    return {
      status: disconnectedStatus(
        'Unrecognized connection URL scheme (expected postgres://, mysql://, sqlite:, file:, mongodb://, mongodb+srv:// or firestore://)',
        'postgresql',
        url,
      ),
      tables: [],
    };
  }

  let driver: Driver | null = null;
  try {
    driver = await withTimeout(openDriver(url, engine), PING_TIMEOUT_MS, 'Connection');
    const start = performance.now();
    await withTimeout(driver.ping(), PING_TIMEOUT_MS, 'Ping');
    const pingMs = Math.round((performance.now() - start) * 100) / 100;
    const [database, tables] = await withTimeout(Promise.all([driver.databaseName(), driver.tables()]), INTROSPECT_TIMEOUT_MS, 'Schema introspection');
    return {
      status: {
        connected: true,
        engine,
        database,
        maskedUrl: maskConnectionString(url),
        pingMs,
        entityCount: tables.length,
        entityType: isNoSqlEngine(engine) ? 'collection' : 'table',
        tableCount: tables.length,
        error: null,
      },
      tables,
    };
  } catch (err) {
    return { status: disconnectedStatus(sanitizeError(err, url), engine, url), tables: [] };
  } finally {
    // Firestore's terminate() waits on in-flight gRPC retries; don't let cleanup stall the response.
    if (driver) await withTimeout(driver.close(), 3000, 'Close').catch(() => undefined);
  }
}

/** Connection health only (ping + table count); same shape as GET /api/status entries. */
export async function getDatabaseStatus(url: string): Promise<DatabaseStatus> {
  return (await introspectDatabase(url)).status;
}
