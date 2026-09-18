import { detectEngine, maskConnectionString, MASK, parseFirestoreUrl, sqlitePathFromUrl } from './env-parser.js';
import type { DatabaseEngine } from './types.js';

/**
 * Multi-Engine Live Data Studio Query and Mutation Engine.
 * Supports PostgreSQL, MySQL, SQLite, MongoDB, and Firebase Firestore.
 *
 * Adheres strictly to Zero-Credential Air-Gap rules:
 * - Direct execution within local process memory.
 * - Raw credentials and connection URLs are never written to disk or returned in responses.
 * - Errors are sanitized to remove credentials and passwords before bubbling up.
 */

export interface FetchDataOptions {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
}

export interface FetchDataResult {
  entity: string;
  entityType: 'table' | 'collection';
  primaryKey: string;
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
  rows: Record<string, unknown>[];
}

export interface InsertRecordResult {
  success: boolean;
  insertedId: string | number;
  record: Record<string, unknown>;
}

export interface UpdateRecordResult {
  success: boolean;
  updatedCount: number;
  record: Record<string, unknown>;
}

export interface DeleteRecordResult {
  success: boolean;
  deletedCount: number;
}

/** Validates entity and identifier names to guard against SQL injection in DDL/identifiers. */
function assertValidIdentifier(name: string, label = 'Identifier'): void {
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name.trim())) {
    throw new Error(`Invalid ${label}: "${name}" contains disallowed characters`);
  }
}

/** Removes raw credentials or passwords from driver error messages. */
function sanitizeError(err: unknown, url: string): Error {
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
    // Non-URL (e.g. SQLite path)
  }
  return new Error(message);
}

/** Recursively serializes driver-specific objects (BSON ObjectId, Dates, Buffers, Timestamps) to pure JSON. */
export function serializeValue(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') return Number(val);
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    const buf = Buffer.from(val);
    if (buf.length <= 512 * 1024) {
      return `data:application/octet-stream;base64,${buf.toString('base64')}`;
    }
    return `[Binary data ${buf.length} bytes]`;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyVal = val as any;
  if (anyVal._bsontype === 'ObjectId' || (anyVal.constructor && anyVal.constructor.name === 'ObjectId')) {
    return anyVal.toString();
  }
  if (anyVal._bsontype === 'Decimal128') {
    return parseFloat(anyVal.toString());
  }
  if (typeof anyVal.toDate === 'function') {
    try {
      return anyVal.toDate().toISOString();
    } catch {
      // Ignore
    }
  }
  if (Array.isArray(val)) {
    return val.map(serializeValue);
  }
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return val;
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = serializeValue(value);
  }
  return result;
}

// ─── PostgreSQL Driver ─────────────────────────────────────────────────────────

async function postgresFetch(url: string, entity: string, options: FetchDataOptions): Promise<FetchDataResult> {
  assertValidIdentifier(entity, 'table name');
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
  await client.connect();

  try {
    // 1. Detect primary key
    const pkRes = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
       WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
       LIMIT 1`,
      [entity],
    );
    const primaryKey = pkRes.rows[0]?.column_name ?? 'id';

    // 2. Detect searchable text columns
    const colRes = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1`,
      [entity],
    );
    const allCols = colRes.rows.map((r) => r.column_name);

    // 3. Build search clause
    const search = options.search?.trim();
    let whereClause = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any[] = [];
    if (search && allCols.length > 0) {
      const searchConditions = allCols.map((col) => `"${col.replace(/"/g, '""')}"::text ILIKE $1`);
      whereClause = ` WHERE (${searchConditions.join(' OR ')})`;
      params.push(`%${search}%`);
    }

    // 4. Count total matching rows
    const countQuery = `SELECT COUNT(*) AS total FROM "${entity.replace(/"/g, '""')}"${whereClause}`;
    const countRes = await client.query<{ total: string }>(countQuery, params);
    const totalCount = parseInt(countRes.rows[0]?.total || '0', 10);

    // 5. Pagination and sorting
    const limit = Math.max(1, Math.min(100, options.limit ?? 25));
    const page = Math.max(1, options.page ?? 1);
    const offset = (page - 1) * limit;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    let sortCol = primaryKey;
    if (options.sort && allCols.includes(options.sort)) {
      sortCol = options.sort;
    }
    const order = options.order === 'desc' ? 'DESC' : 'ASC';

    const dataParams = [...params, limit, offset];
    const dataQuery = `SELECT * FROM "${entity.replace(/"/g, '""')}"${whereClause} ORDER BY "${sortCol.replace(/"/g, '""')}" ${order} LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
    const dataRes = await client.query<Record<string, unknown>>(dataQuery, dataParams);

    return {
      entity,
      entityType: 'table',
      primaryKey,
      page,
      limit,
      totalCount,
      totalPages,
      rows: dataRes.rows.map(serializeRow),
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function postgresInsert(url: string, entity: string, record: Record<string, unknown>): Promise<InsertRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
  await client.connect();

  try {
    const keys = Object.keys(record);
    if (keys.length === 0) {
      const res = await client.query<Record<string, unknown>>(`INSERT INTO "${entity.replace(/"/g, '""')}" DEFAULT VALUES RETURNING *`);
      const row = res.rows[0] ?? {};
      const insertedId = (row.id as string | number) ?? 1;
      return { success: true, insertedId, record: serializeRow(row) };
    }

    for (const k of keys) assertValidIdentifier(k, 'column name');
    const cols = keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map((k) => record[k]);

    const query = `INSERT INTO "${entity.replace(/"/g, '""')}" (${cols}) VALUES (${placeholders}) RETURNING *`;
    const res = await client.query<Record<string, unknown>>(query, values);
    const row = res.rows[0] ?? {};
    const insertedId = (row.id as string | number) ?? (row._id as string | number) ?? 'unknown';
    return { success: true, insertedId, record: serializeRow(row) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function postgresUpdate(url: string, entity: string, primaryKey: string | number, updates: Record<string, unknown>): Promise<UpdateRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
  await client.connect();

  try {
    const pkRes = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
       WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
       LIMIT 1`,
      [entity],
    );
    const pkCol = pkRes.rows[0]?.column_name ?? 'id';

    const keys = Object.keys(updates).filter((k) => k !== pkCol);
    if (keys.length === 0) {
      throw new Error('No updatable columns provided');
    }
    for (const k of keys) assertValidIdentifier(k, 'column name');

    const setClause = keys.map((k, i) => `"${k.replace(/"/g, '""')}" = $${i + 1}`).join(', ');
    const values = keys.map((k) => updates[k]);
    values.push(primaryKey);

    const query = `UPDATE "${entity.replace(/"/g, '""')}" SET ${setClause} WHERE "${pkCol.replace(/"/g, '""')}" = $${values.length} RETURNING *`;
    const res = await client.query<Record<string, unknown>>(query, values);
    if (res.rowCount === 0) {
      throw new Error(`Record with primary key "${primaryKey}" was not found in ${entity}`);
    }
    return { success: true, updatedCount: res.rowCount ?? 1, record: serializeRow(res.rows[0]) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function postgresDelete(url: string, entity: string, primaryKey: string | number): Promise<DeleteRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
  await client.connect();

  try {
    const pkRes = await client.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
       WHERE tc.table_schema = current_schema() AND tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1
       LIMIT 1`,
      [entity],
    );
    const pkCol = pkRes.rows[0]?.column_name ?? 'id';

    const query = `DELETE FROM "${entity.replace(/"/g, '""')}" WHERE "${pkCol.replace(/"/g, '""')}" = $1`;
    const res = await client.query(query, [primaryKey]);
    if (res.rowCount === 0) {
      throw new Error(`Record with primary key "${primaryKey}" was not found in ${entity}`);
    }
    return { success: true, deletedCount: res.rowCount ?? 1 };
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ─── MySQL Driver ─────────────────────────────────────────────────────────────

async function mysqlFetch(url: string, entity: string, options: FetchDataOptions): Promise<FetchDataResult> {
  assertValidIdentifier(entity, 'table name');
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 8000 });

  try {
    // 1. Detect primary key
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [pkRows] = (await conn.query(
      `SELECT COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
       LIMIT 1`,
      [entity],
    )) as any;
    const primaryKey = pkRows[0]?.COLUMN_NAME ?? 'id';

    // 2. Detect column names
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [colRows] = (await conn.query(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [entity],
    )) as any;
    const allCols = colRows.map((r: { COLUMN_NAME: string }) => r.COLUMN_NAME);

    // 3. Search clause
    const search = options.search?.trim();
    let whereClause = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any[] = [];
    if (search && allCols.length > 0) {
      const searchConditions = allCols.map((col: string) => `\`${col.replace(/`/g, '``')}\` LIKE ?`);
      whereClause = ` WHERE (${searchConditions.join(' OR ')})`;
      for (let i = 0; i < allCols.length; i++) params.push(`%${search}%`);
    }

    // 4. Count total
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [countRows] = (await conn.query(`SELECT COUNT(*) AS total FROM \`${entity.replace(/`/g, '``')}\`${whereClause}`, params)) as any;
    const totalCount = parseInt(countRows[0]?.total || '0', 10);

    const limit = Math.max(1, Math.min(100, options.limit ?? 25));
    const page = Math.max(1, options.page ?? 1);
    const offset = (page - 1) * limit;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    let sortCol = primaryKey;
    if (options.sort && allCols.includes(options.sort)) {
      sortCol = options.sort;
    }
    const order = options.order === 'desc' ? 'DESC' : 'ASC';

    const dataParams = [...params, limit, offset];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [dataRows] = (await conn.query(
      `SELECT * FROM \`${entity.replace(/`/g, '``')}\`${whereClause} ORDER BY \`${sortCol.replace(/`/g, '``')}\` ${order} LIMIT ? OFFSET ?`,
      dataParams,
    )) as any;

    return {
      entity,
      entityType: 'table',
      primaryKey,
      page,
      limit,
      totalCount,
      totalPages,
      rows: (dataRows as Record<string, unknown>[]).map(serializeRow),
    };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function mysqlInsert(url: string, entity: string, record: Record<string, unknown>): Promise<InsertRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 8000 });

  try {
    const keys = Object.keys(record);
    for (const k of keys) assertValidIdentifier(k, 'column name');

    const cols = keys.map((k) => `\`${k.replace(/`/g, '``')}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const values = keys.map((k) => record[k]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [res] = (await conn.query(
      `INSERT INTO \`${entity.replace(/`/g, '``')}\` (${cols}) VALUES (${placeholders})`,
      values,
    )) as any;

    const insertedId = res.insertId ?? 1;
    return { success: true, insertedId, record: serializeRow({ ...record, id: insertedId }) };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function mysqlUpdate(url: string, entity: string, primaryKey: string | number, updates: Record<string, unknown>): Promise<UpdateRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 8000 });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [pkRows] = (await conn.query(
      `SELECT COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
       LIMIT 1`,
      [entity],
    )) as any;
    const pkCol = pkRows[0]?.COLUMN_NAME ?? 'id';

    const keys = Object.keys(updates).filter((k) => k !== pkCol);
    if (keys.length === 0) throw new Error('No updatable columns provided');
    for (const k of keys) assertValidIdentifier(k, 'column name');

    const setClause = keys.map((k) => `\`${k.replace(/`/g, '``')}\` = ?`).join(', ');
    const values = [...keys.map((k) => updates[k]), primaryKey];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [res] = (await conn.query(
      `UPDATE \`${entity.replace(/`/g, '``')}\` SET ${setClause} WHERE \`${pkCol.replace(/`/g, '``')}\` = ?`,
      values,
    )) as any;

    if (res.affectedRows === 0) {
      throw new Error(`Record with primary key "${primaryKey}" was not found in ${entity}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [updatedRows] = (await conn.query(
      `SELECT * FROM \`${entity.replace(/`/g, '``')}\` WHERE \`${pkCol.replace(/`/g, '``')}\` = ? LIMIT 1`,
      [primaryKey],
    )) as any;

    return { success: true, updatedCount: res.affectedRows, record: serializeRow(updatedRows[0] || updates) };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

async function mysqlDelete(url: string, entity: string, primaryKey: string | number): Promise<DeleteRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const mysql = await import('mysql2/promise');
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 8000 });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [pkRows] = (await conn.query(
      `SELECT COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
       LIMIT 1`,
      [entity],
    )) as any;
    const pkCol = pkRows[0]?.COLUMN_NAME ?? 'id';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [res] = (await conn.query(
      `DELETE FROM \`${entity.replace(/`/g, '``')}\` WHERE \`${pkCol.replace(/`/g, '``')}\` = ?`,
      [primaryKey],
    )) as any;

    if (res.affectedRows === 0) {
      throw new Error(`Record with primary key "${primaryKey}" was not found in ${entity}`);
    }
    return { success: true, deletedCount: res.affectedRows };
  } finally {
    await conn.end().catch(() => undefined);
  }
}

// ─── SQLite Driver (node:sqlite) ──────────────────────────────────────────────

async function sqliteFetch(url: string, entity: string, options: FetchDataOptions): Promise<FetchDataResult> {
  assertValidIdentifier(entity, 'table name');
  const { DatabaseSync } = await import('node:sqlite');
  const filePath = sqlitePathFromUrl(url);
  const db = filePath === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(filePath, { readOnly: true });

  try {
    const ident = `"${entity.replace(/"/g, '""')}"`;
    const cols = db.prepare(`PRAGMA table_info(${ident})`).all() as Array<{ name: string; pk: number }>;
    const pkCol = cols.find((c) => Number(c.pk) > 0)?.name ?? 'id';
    const allCols = cols.map((c) => c.name);

    const search = options.search?.trim();
    let whereClause = '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any[] = [];
    if (search && allCols.length > 0) {
      const conditions = allCols.map((c) => `"${c.replace(/"/g, '""')}" LIKE ?`);
      whereClause = ` WHERE (${conditions.join(' OR ')})`;
      for (let i = 0; i < allCols.length; i++) params.push(`%${search}%`);
    }

    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM ${ident}${whereClause}`).get(...params) as { total: number };
    const totalCount = Number(countRow?.total ?? 0);

    const limit = Math.max(1, Math.min(100, options.limit ?? 25));
    const page = Math.max(1, options.page ?? 1);
    const offset = (page - 1) * limit;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    let sortCol = pkCol;
    if (options.sort && allCols.includes(options.sort)) {
      sortCol = options.sort;
    }
    const order = options.order === 'desc' ? 'DESC' : 'ASC';

    const dataRows = db
      .prepare(`SELECT * FROM ${ident}${whereClause} ORDER BY "${sortCol.replace(/"/g, '""')}" ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      entity,
      entityType: 'table',
      primaryKey: pkCol,
      page,
      limit,
      totalCount,
      totalPages,
      rows: dataRows.map(serializeRow),
    };
  } finally {
    db.close();
  }
}

async function sqliteInsert(url: string, entity: string, record: Record<string, unknown>): Promise<InsertRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const { DatabaseSync } = await import('node:sqlite');
  const filePath = sqlitePathFromUrl(url);
  const db = filePath === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(filePath);

  try {
    const ident = `"${entity.replace(/"/g, '""')}"`;
    const keys = Object.keys(record);
    for (const k of keys) assertValidIdentifier(k, 'column name');

    let insertedId: string | number = 1;
    let insertedRow: Record<string, unknown> = record;

    if (keys.length === 0) {
      const res = db.prepare(`INSERT INTO ${ident} DEFAULT VALUES RETURNING *`).get() as Record<string, unknown> | undefined;
      if (res) {
        insertedRow = res;
        insertedId = (res.id as string | number) ?? 1;
      }
    } else {
      const cols = keys.map((k) => `"${k.replace(/"/g, '""')}"`).join(', ');
      const placeholders = keys.map(() => '?').join(', ');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values: any[] = keys.map((k) => record[k]);

      try {
        const res = db.prepare(`INSERT INTO ${ident} (${cols}) VALUES (${placeholders}) RETURNING *`).get(...values) as Record<string, unknown> | undefined;
        if (res) {
          insertedRow = res;
          insertedId = (res.id as string | number) ?? 1;
        }
      } catch {
        // Fallback for older SQLite versions without RETURNING
        const info = db.prepare(`INSERT INTO ${ident} (${cols}) VALUES (${placeholders})`).run(...values) as { lastInsertRowid?: number | bigint };
        insertedId = Number(info.lastInsertRowid ?? 1);
        insertedRow = { ...record, id: insertedId };
      }
    }

    return { success: true, insertedId, record: serializeRow(insertedRow) };
  } finally {
    db.close();
  }
}

async function sqliteUpdate(url: string, entity: string, primaryKey: string | number, updates: Record<string, unknown>): Promise<UpdateRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const { DatabaseSync } = await import('node:sqlite');
  const filePath = sqlitePathFromUrl(url);
  const db = filePath === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(filePath);

  try {
    const ident = `"${entity.replace(/"/g, '""')}"`;
    const cols = db.prepare(`PRAGMA table_info(${ident})`).all() as Array<{ name: string; pk: number }>;
    const pkCol = cols.find((c) => Number(c.pk) > 0)?.name ?? 'id';

    const keys = Object.keys(updates).filter((k) => k !== pkCol);
    if (keys.length === 0) throw new Error('No updatable columns provided');
    for (const k of keys) assertValidIdentifier(k, 'column name');

    const setClause = keys.map((k) => `"${k.replace(/"/g, '""')}" = ?`).join(', ');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: any[] = [...keys.map((k) => updates[k]), primaryKey];

    const stmt = db.prepare(`UPDATE ${ident} SET ${setClause} WHERE "${pkCol.replace(/"/g, '""')}" = ?`);
    const info = stmt.run(...values) as { changes?: number };
    const changes = Number(info.changes ?? 0);
    if (changes === 0) {
      throw new Error(`Record with primary key "${primaryKey}" was not found in ${entity}`);
    }

    const updatedRow = db.prepare(`SELECT * FROM ${ident} WHERE "${pkCol.replace(/"/g, '""')}" = ? LIMIT 1`).get(primaryKey) as Record<string, unknown>;
    return { success: true, updatedCount: changes, record: serializeRow(updatedRow || updates) };
  } finally {
    db.close();
  }
}

async function sqliteDelete(url: string, entity: string, primaryKey: string | number): Promise<DeleteRecordResult> {
  assertValidIdentifier(entity, 'table name');
  const { DatabaseSync } = await import('node:sqlite');
  const filePath = sqlitePathFromUrl(url);
  const db = filePath === ':memory:' ? new DatabaseSync(':memory:') : new DatabaseSync(filePath);

  try {
    const ident = `"${entity.replace(/"/g, '""')}"`;
    const cols = db.prepare(`PRAGMA table_info(${ident})`).all() as Array<{ name: string; pk: number }>;
    const pkCol = cols.find((c) => Number(c.pk) > 0)?.name ?? 'id';

    const stmt = db.prepare(`DELETE FROM ${ident} WHERE "${pkCol.replace(/"/g, '""')}" = ?`);
    const info = stmt.run(primaryKey) as { changes?: number };
    const changes = Number(info.changes ?? 0);
    if (changes === 0) {
      throw new Error(`Record with primary key "${primaryKey}" was not found in ${entity}`);
    }
    return { success: true, deletedCount: changes };
  } finally {
    db.close();
  }
}

// ─── MongoDB Driver ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveMongoId(id: string | number, ObjectIdClass?: any): any {
  if (ObjectIdClass && typeof id === 'string' && ObjectIdClass.isValid(id)) {
    try {
      return new ObjectIdClass(id);
    } catch {
      // fallback to raw id
    }
  }
  return id;
}

async function mongoFetch(url: string, entity: string, options: FetchDataOptions): Promise<FetchDataResult> {
  assertValidIdentifier(entity, 'collection name');
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'agentj-data' });
  await client.connect();

  try {
    const db = client.db();
    const col = db.collection(entity);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: any = {};
    const search = options.search?.trim();
    if (search) {
      // Find sampled docs to get string keys for search
      const sample = await col.find({}).limit(10).toArray();
      const keys = new Set<string>();
      for (const d of sample) {
        for (const [k, v] of Object.entries(d)) {
          if (typeof v === 'string') keys.add(k);
        }
      }
      if (keys.size > 0) {
        filter.$or = [...keys].map((k) => ({ [k]: { $regex: search, $options: 'i' } }));
      }
    }

    const totalCount = await col.countDocuments(filter);
    const limit = Math.max(1, Math.min(100, options.limit ?? 25));
    const page = Math.max(1, options.page ?? 1);
    const offset = (page - 1) * limit;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sortObj: Record<string, any> = {};
    const sortCol = options.sort || '_id';
    sortObj[sortCol] = options.order === 'desc' ? -1 : 1;

    const docs = await col.find(filter).sort(sortObj).skip(offset).limit(limit).toArray();

    return {
      entity,
      entityType: 'collection',
      primaryKey: '_id',
      page,
      limit,
      totalCount,
      totalPages,
      rows: docs.map((d) => serializeRow(d as Record<string, unknown>)),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function mongoInsert(url: string, entity: string, record: Record<string, unknown>): Promise<InsertRecordResult> {
  assertValidIdentifier(entity, 'collection name');
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'agentj-data' });
  await client.connect();

  try {
    const db = client.db();
    const col = db.collection(entity);

    const res = await col.insertOne(record);
    const insertedId = String(res.insertedId);
    return { success: true, insertedId, record: serializeRow({ ...record, _id: res.insertedId }) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function mongoUpdate(url: string, entity: string, primaryKey: string | number, updates: Record<string, unknown>): Promise<UpdateRecordResult> {
  assertValidIdentifier(entity, 'collection name');
  const { MongoClient, ObjectId } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'agentj-data' });
  await client.connect();

  try {
    const db = client.db();
    const col = db.collection(entity);

    const filterId = resolveMongoId(primaryKey, ObjectId);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, id, ...cleanUpdates } = updates;
    if (Object.keys(cleanUpdates).length === 0) throw new Error('No updatable fields provided');

    const res = await col.updateOne({ _id: filterId }, { $set: cleanUpdates });
    if (res.matchedCount === 0) {
      throw new Error(`Document with _id "${primaryKey}" was not found in collection ${entity}`);
    }

    const updatedDoc = await col.findOne({ _id: filterId });
    return { success: true, updatedCount: res.modifiedCount, record: serializeRow((updatedDoc as Record<string, unknown>) || cleanUpdates) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function mongoDelete(url: string, entity: string, primaryKey: string | number): Promise<DeleteRecordResult> {
  assertValidIdentifier(entity, 'collection name');
  const { MongoClient, ObjectId } = await import('mongodb');
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, appName: 'agentj-data' });
  await client.connect();

  try {
    const db = client.db();
    const col = db.collection(entity);

    const filterId = resolveMongoId(primaryKey, ObjectId);
    const res = await col.deleteOne({ _id: filterId });
    if (res.deletedCount === 0) {
      throw new Error(`Document with _id "${primaryKey}" was not found in collection ${entity}`);
    }
    return { success: true, deletedCount: res.deletedCount };
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ─── Firestore Driver ─────────────────────────────────────────────────────────

async function firestoreFetch(url: string, entity: string, options: FetchDataOptions): Promise<FetchDataResult> {
  assertValidIdentifier(entity, 'collection name');
  const config = parseFirestoreUrl(url);
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    ...(config.emulatorHost ? { host: config.emulatorHost, ssl: false } : {}),
  });

  const col = firestore.collection(entity);
  const countSnap = await col.count().get().catch(() => null);
  const totalCount = countSnap ? countSnap.data().count : 0;

  const limit = Math.max(1, Math.min(100, options.limit ?? 25));
  const page = Math.max(1, options.page ?? 1);
  const offset = (page - 1) * limit;
  const totalPages = Math.ceil(totalCount / limit) || 1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = col;
  if (options.sort && options.sort !== 'id') {
    query = query.orderBy(options.sort, options.order === 'desc' ? 'desc' : 'asc');
  }
  if (offset > 0) {
    query = query.offset(offset);
  }
  query = query.limit(limit);

  const snapshot = await query.get();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = snapshot.docs.map((d: any) => serializeRow({ id: d.id, ...d.data() }));

  return {
    entity,
    entityType: 'collection',
    primaryKey: 'id',
    page,
    limit,
    totalCount,
    totalPages,
    rows,
  };
}

async function firestoreInsert(url: string, entity: string, record: Record<string, unknown>): Promise<InsertRecordResult> {
  assertValidIdentifier(entity, 'collection name');
  const config = parseFirestoreUrl(url);
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    ...(config.emulatorHost ? { host: config.emulatorHost, ssl: false } : {}),
  });

  const col = firestore.collection(entity);
  const { id, ...data } = record;
  const docRef = id ? col.doc(String(id)) : col.doc();
  await docRef.set(data);

  return { success: true, insertedId: docRef.id, record: serializeRow({ id: docRef.id, ...data }) };
}

async function firestoreUpdate(url: string, entity: string, primaryKey: string | number, updates: Record<string, unknown>): Promise<UpdateRecordResult> {
  assertValidIdentifier(entity, 'collection name');
  const config = parseFirestoreUrl(url);
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    ...(config.emulatorHost ? { host: config.emulatorHost, ssl: false } : {}),
  });

  const col = firestore.collection(entity);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, ...data } = updates;
  if (Object.keys(data).length === 0) throw new Error('No updatable fields provided');

  const docRef = col.doc(String(primaryKey));
  await docRef.update(data);
  const updatedSnap = await docRef.get();

  return { success: true, updatedCount: 1, record: serializeRow({ id: docRef.id, ...updatedSnap.data() }) };
}

async function firestoreDelete(url: string, entity: string, primaryKey: string | number): Promise<DeleteRecordResult> {
  assertValidIdentifier(entity, 'collection name');
  const config = parseFirestoreUrl(url);
  const { Firestore } = await import('@google-cloud/firestore');
  const firestore = new Firestore({
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {}),
    ...(config.emulatorHost ? { host: config.emulatorHost, ssl: false } : {}),
  });

  const col = firestore.collection(entity);
  const docRef = col.doc(String(primaryKey));
  await docRef.delete();
  return { success: true, deletedCount: 1 };
}

// ─── Unified Data Engine Facade ───────────────────────────────────────────────

export async function fetchData(url: string, entity: string, options: FetchDataOptions = {}): Promise<FetchDataResult> {
  const engine = detectEngine(url);
  try {
    switch (engine) {
      case 'postgresql':
        return await postgresFetch(url, entity, options);
      case 'mysql':
        return await mysqlFetch(url, entity, options);
      case 'sqlite':
        return await sqliteFetch(url, entity, options);
      case 'mongodb':
        return await mongoFetch(url, entity, options);
      case 'firestore':
        return await firestoreFetch(url, entity, options);
      default:
        throw new Error(`Unsupported database engine for live data queries: "${engine}"`);
    }
  } catch (err) {
    throw sanitizeError(err, url);
  }
}

export async function insertRecord(url: string, entity: string, record: Record<string, unknown>): Promise<InsertRecordResult> {
  const engine = detectEngine(url);
  try {
    switch (engine) {
      case 'postgresql':
        return await postgresInsert(url, entity, record);
      case 'mysql':
        return await mysqlInsert(url, entity, record);
      case 'sqlite':
        return await sqliteInsert(url, entity, record);
      case 'mongodb':
        return await mongoInsert(url, entity, record);
      case 'firestore':
        return await firestoreInsert(url, entity, record);
      default:
        throw new Error(`Unsupported database engine for insertions: "${engine}"`);
    }
  } catch (err) {
    throw sanitizeError(err, url);
  }
}

export async function updateRecord(url: string, entity: string, primaryKey: string | number, updates: Record<string, unknown>): Promise<UpdateRecordResult> {
  const engine = detectEngine(url);
  try {
    switch (engine) {
      case 'postgresql':
        return await postgresUpdate(url, entity, primaryKey, updates);
      case 'mysql':
        return await mysqlUpdate(url, entity, primaryKey, updates);
      case 'sqlite':
        return await sqliteUpdate(url, entity, primaryKey, updates);
      case 'mongodb':
        return await mongoUpdate(url, entity, primaryKey, updates);
      case 'firestore':
        return await firestoreUpdate(url, entity, primaryKey, updates);
      default:
        throw new Error(`Unsupported database engine for updates: "${engine}"`);
    }
  } catch (err) {
    throw sanitizeError(err, url);
  }
}

export async function deleteRecord(url: string, entity: string, primaryKey: string | number): Promise<DeleteRecordResult> {
  const engine = detectEngine(url);
  try {
    switch (engine) {
      case 'postgresql':
        return await postgresDelete(url, entity, primaryKey);
      case 'mysql':
        return await mysqlDelete(url, entity, primaryKey);
      case 'sqlite':
        return await sqliteDelete(url, entity, primaryKey);
      case 'mongodb':
        return await mongoDelete(url, entity, primaryKey);
      case 'firestore':
        return await firestoreDelete(url, entity, primaryKey);
      default:
        throw new Error(`Unsupported database engine for deletions: "${engine}"`);
    }
  } catch (err) {
    throw sanitizeError(err, url);
  }
}
