import fs from 'node:fs';
import path from 'node:path';
import type {
  ColumnChange,
  ColumnSchema,
  DatabaseEngine,
  ForeignKeySchema,
  IndexSchema,
  SchemaDiff,
  SchemaDiffSummary,
  TableDiff,
  TableSchema,
} from './types.js';

/**
 * Schema diff & drift engine.
 *
 * Direction: `source` is the desired schema (Dev, or a live DB when comparing to the contract),
 * `target` is the schema it would be applied to (Prod, or .ai/db_schema.json).
 *   - addedTables:   exist in source only
 *   - droppedTables: exist in target only (applying source would drop them → destructive)
 *   - alteredTables: exist in both but differ
 * For altered columns, `before` is the target definition and `after` the source definition.
 */

// ─── Normalization ─────────────────────────────────────────────────────────────

const TYPE_ALIASES: Record<string, string> = {
  INT: 'INTEGER',
  INT4: 'INTEGER',
  INT2: 'SMALLINT',
  INT8: 'BIGINT',
  SERIAL: 'INTEGER',
  SERIAL4: 'INTEGER',
  BIGSERIAL: 'BIGINT',
  SERIAL8: 'BIGINT',
  BOOL: 'BOOLEAN',
  FLOAT4: 'REAL',
  FLOAT8: 'DOUBLE PRECISION',
  DECIMAL: 'NUMERIC',
  TIMESTAMPTZ: 'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP',
  TIMETZ: 'TIME WITH TIME ZONE',
  'TIME WITHOUT TIME ZONE': 'TIME',
  'CHARACTER VARYING': 'VARCHAR',
  CHARACTER: 'CHAR',
};

export function normalizeType(type: string): string {
  const upper = type.trim().toUpperCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');
  const match = upper.match(/^([A-Z0-9_ ]+?)(\(.*\))?(\[\])?$/);
  if (!match) return upper;
  const [, base, args = '', array = ''] = match;
  return `${TYPE_ALIASES[base] ?? base}${args}${array}`;
}

export function normalizeDefault(value: string | null | undefined): string | null {
  if (value == null) return null;
  let v = value.trim();
  if (!v || v.toUpperCase() === 'NULL') return null;
  // Strip Postgres casts like 'user'::character varying or '{}'::jsonb.
  v = v.replace(/::[a-z_][a-z0-9_ ]*(\[\])?(\([^)]*\))?/gi, '');
  while (v.startsWith('(') && v.endsWith(')')) v = v.slice(1, -1).trim();
  const lower = v.toLowerCase();
  if (lower === 'current_timestamp' || lower === 'current_timestamp()' || lower === 'now()') return 'now()';
  return lower;
}

const key = (name: string) => name.toLowerCase();

function indexBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyOf(item), item);
  return map;
}

// ─── Comparison ────────────────────────────────────────────────────────────────

/** A field counts as an image field when flagged by introspection or declared as IMAGE_URL. */
const isMediaColumn = (c: ColumnSchema) => c.isMedia === true || normalizeType(c.type) === 'IMAGE_URL';

function compareColumns(before: ColumnSchema, after: ColumnSchema): ColumnChange | null {
  const changedFields: ColumnChange['changedFields'] = [];
  if (normalizeType(before.type) !== normalizeType(after.type)) changedFields.push('type');
  if (before.nullable !== after.nullable) changedFields.push('nullable');
  if (before.primaryKey !== after.primaryKey) changedFields.push('primaryKey');
  if (normalizeDefault(before.default) !== normalizeDefault(after.default)) changedFields.push('default');
  if (isMediaColumn(before) !== isMediaColumn(after)) changedFields.push('isMedia');
  return changedFields.length ? { name: after.name, before, after, changedFields } : null;
}

/**
 * Changes that can lose data or fail against existing rows. Document stores have no
 * NOT NULL constraint, so nullability changes are only destructive for SQL tables.
 */
function isDestructiveColumnChange(change: ColumnChange, isCollection: boolean): boolean {
  return (
    change.changedFields.includes('type') ||
    change.changedFields.includes('primaryKey') ||
    (!isCollection && change.changedFields.includes('nullable') && change.before.nullable && !change.after.nullable)
  );
}

const indexSignature = (idx: IndexSchema) => `${idx.unique ? 'U' : 'N'}:${idx.columns.map(key).join(',')}`;
// FK names are engine-specific (SQLite synthesizes them), so match on structure instead.
const fkSignature = (fk: ForeignKeySchema) =>
  `${key(fk.column)}->${key(fk.referencedTable)}.${key(fk.referencedColumn)}:${(fk.onDelete ?? 'NO ACTION').toUpperCase()}`;

export function diffTable(source: TableSchema, target: TableSchema): TableDiff {
  const sourceCols = indexBy(source.columns, (c) => key(c.name));
  const targetCols = indexBy(target.columns, (c) => key(c.name));

  const addedColumns = source.columns.filter((c) => !targetCols.has(key(c.name)));
  const droppedColumns = target.columns.filter((c) => !sourceCols.has(key(c.name)));
  const alteredColumns: ColumnChange[] = [];
  for (const col of source.columns) {
    const before = targetCols.get(key(col.name));
    const change = before && compareColumns(before, col);
    if (change) alteredColumns.push(change);
  }

  // Indexes match by name; a same-named index with a different definition is dropped and re-added.
  const sourceIdx = indexBy(source.indexes ?? [], (i) => key(i.name));
  const targetIdx = indexBy(target.indexes ?? [], (i) => key(i.name));
  const addedIndexes = (source.indexes ?? []).filter((i) => {
    const t = targetIdx.get(key(i.name));
    return !t || indexSignature(t) !== indexSignature(i);
  });
  const droppedIndexes = (target.indexes ?? []).filter((i) => {
    const s = sourceIdx.get(key(i.name));
    return !s || indexSignature(s) !== indexSignature(i);
  });

  const sourceFks = new Set((source.foreignKeys ?? []).map(fkSignature));
  const targetFks = new Set((target.foreignKeys ?? []).map(fkSignature));
  const addedForeignKeys = (source.foreignKeys ?? []).filter((fk) => !targetFks.has(fkSignature(fk)));
  const droppedForeignKeys = (target.foreignKeys ?? []).filter((fk) => !sourceFks.has(fkSignature(fk)));

  const isCollection = source.entityType === 'collection' || target.entityType === 'collection';
  // Adding a NOT NULL column without a default fails on populated SQL tables; schemaless stores don't care.
  const addsRequiredColumn =
    !isCollection && addedColumns.some((c) => !c.nullable && normalizeDefault(c.default) === null && !c.primaryKey);

  return {
    name: source.name,
    addedColumns,
    droppedColumns,
    alteredColumns,
    addedIndexes,
    droppedIndexes,
    addedForeignKeys,
    droppedForeignKeys,
    isDestructive:
      droppedColumns.length > 0 || alteredColumns.some((c) => isDestructiveColumnChange(c, isCollection)) || addsRequiredColumn,
  };
}

function hasChanges(diff: TableDiff): boolean {
  return (
    diff.addedColumns.length +
      diff.droppedColumns.length +
      diff.alteredColumns.length +
      diff.addedIndexes.length +
      diff.droppedIndexes.length +
      diff.addedForeignKeys.length +
      diff.droppedForeignKeys.length >
    0
  );
}

/** Computes the GET /api/diff payload for `source` applied onto `target`. */
export function diffSchemas(source: TableSchema[], target: TableSchema[]): SchemaDiff {
  const sourceMap = indexBy(source, (t) => key(t.name));
  const targetMap = indexBy(target, (t) => key(t.name));

  const addedTables = source.filter((t) => !targetMap.has(key(t.name)));
  const droppedTables = target.filter((t) => !sourceMap.has(key(t.name)));
  const alteredTables: TableDiff[] = [];
  const unchangedTables: string[] = [];

  for (const table of source) {
    const counterpart = targetMap.get(key(table.name));
    if (!counterpart) continue;
    const diff = diffTable(table, counterpart);
    if (hasChanges(diff)) alteredTables.push(diff);
    else unchangedTables.push(table.name);
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  addedTables.sort(byName);
  droppedTables.sort(byName);
  alteredTables.sort(byName);
  unchangedTables.sort((a, b) => a.localeCompare(b));

  return {
    summary: {
      addedTablesCount: addedTables.length,
      alteredTablesCount: alteredTables.length,
      droppedTablesCount: droppedTables.length,
      unchangedTablesCount: unchangedTables.length,
      hasDestructiveChanges: droppedTables.length > 0 || alteredTables.some((t) => t.isDestructive),
    },
    addedTables,
    droppedTables,
    alteredTables,
    unchangedTables,
  };
}

// ─── API contract shape (GET /api/diff) ───────────────────────────────────────

export type MigrationLanguage = 'sql' | 'mongodb-js' | 'firestore-json';

export interface ContractDiffSummary extends SchemaDiffSummary {
  addedCount: number;
  alteredCount: number;
  droppedCount: number;
  unchangedCount: number;
  /** Engine the migration script targets. */
  engine: DatabaseEngine;
}

/**
 * GET /api/diff response per .ai/api_contracts.json. The legacy *Tables keys are kept
 * alongside the contract keys so existing studio/CLI consumers keep working.
 */
export interface ContractSchemaDiff extends SchemaDiff {
  summary: ContractDiffSummary;
  added: TableSchema[];
  dropped: TableSchema[];
  altered: TableDiff[];
  unchanged: string[];
  migrationScript: string;
  migrationLanguage: MigrationLanguage;
}

export function toContractDiff(diff: SchemaDiff, engine: DatabaseEngine, targetLabel: string): ContractSchemaDiff {
  const { script, language } = generateMigrationScript(diff, engine, targetLabel);
  return {
    ...diff,
    summary: {
      ...diff.summary,
      addedCount: diff.summary.addedTablesCount,
      alteredCount: diff.summary.alteredTablesCount,
      droppedCount: diff.summary.droppedTablesCount,
      unchangedCount: diff.summary.unchangedTablesCount,
      engine,
    },
    added: diff.addedTables,
    dropped: diff.droppedTables,
    altered: diff.alteredTables,
    unchanged: diff.unchangedTables,
    migrationScript: script,
    migrationLanguage: language,
  };
}

// ─── Migration script generation (SQL DDL / MongoDB shell / Firestore index JSON) ──

function hasDrift(d: SchemaDiff): boolean {
  return d.addedTables.length + d.alteredTables.length + d.droppedTables.length > 0;
}

function generateSql(d: SchemaDiff, dialect: 'postgresql' | 'mysql' | 'sqlite', targetLabel: string): string {
  const q = (name: string) => (dialect === 'mysql' ? `\`${name.split('`').join('``')}\`` : `"${name.split('"').join('""')}"`);
  const colDef = (c: ColumnSchema) => `${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default != null ? ` DEFAULT ${c.default}` : ''}`;
  const fkDef = (f: ForeignKeySchema) =>
    `CONSTRAINT ${q(f.name)} FOREIGN KEY (${q(f.column)}) REFERENCES ${q(f.referencedTable)} (${q(f.referencedColumn)})${f.onDelete ? ` ON DELETE ${f.onDelete}` : ''}`;
  const idxDef = (t: string, i: IndexSchema) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${q(i.name)} ON ${q(t)} (${i.columns.map(q).join(', ')});`;
  const dropIdx = (t: string, i: IndexSchema) => (dialect === 'mysql' ? `DROP INDEX ${q(i.name)} ON ${q(t)};` : `DROP INDEX ${q(i.name)};`);
  const label = dialect === 'postgresql' ? 'PostgreSQL' : dialect === 'mysql' ? 'MySQL' : 'SQLite';
  const out = [
    `-- nativ migration preview: Dev → ${targetLabel} (${label} dialect)`,
    '-- Generated from structural metadata only. Review carefully; nothing is executed automatically.',
    '',
  ];

  for (const t of d.addedTables) {
    const lines = t.columns.map((c) => `  ${colDef(c)}`);
    const pks = t.columns.filter((c) => c.primaryKey).map((c) => q(c.name));
    if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
    for (const f of t.foreignKeys ?? []) lines.push(`  ${fkDef(f)}`);
    out.push(`-- [NEW TABLE] ${t.name}`, `CREATE TABLE ${q(t.name)} (\n${lines.join(',\n')}\n);`);
    for (const i of t.indexes ?? []) out.push(idxDef(t.name, i));
    out.push('');
  }

  for (const t of d.alteredTables) {
    const T = `ALTER TABLE ${q(t.name)} `;
    out.push(`-- [ALTERED] ${t.name}${t.isDestructive ? '  ⚠ DESTRUCTIVE' : ''}`);
    for (const f of t.droppedForeignKeys) {
      out.push(dialect === 'sqlite' ? `-- SQLite cannot drop constraints in place; rebuild ${t.name} to remove FK ${f.name}` : `${T}${dialect === 'mysql' ? 'DROP FOREIGN KEY' : 'DROP CONSTRAINT'} ${q(f.name)};`);
    }
    for (const i of t.droppedIndexes) out.push(dropIdx(t.name, i));
    for (const c of t.addedColumns) out.push(`${T}ADD COLUMN ${colDef(c)};`);
    for (const ch of t.alteredColumns) {
      const c = ch.after;
      const f = ch.changedFields.filter((x) => x !== 'isMedia');
      if (!f.length) continue;
      if (dialect === 'mysql') {
        out.push(`${T}MODIFY COLUMN ${colDef(c)};`);
        continue;
      }
      if (dialect === 'sqlite') {
        out.push(`-- SQLite cannot ALTER COLUMN ${t.name}.${c.name} (${f.join(', ')}); a table rebuild is required.`);
        continue;
      }
      if (f.includes('type')) out.push(`${T}ALTER COLUMN ${q(c.name)} TYPE ${c.type} USING ${q(c.name)}::${c.type};`);
      if (f.includes('nullable')) out.push(`${T}ALTER COLUMN ${q(c.name)} ${c.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
      if (f.includes('default')) out.push(`${T}ALTER COLUMN ${q(c.name)} ${c.default == null ? 'DROP DEFAULT' : `SET DEFAULT ${c.default}`};`);
      if (f.includes('primaryKey')) out.push(`-- Primary key membership changed for ${t.name}.${c.name}; recreate the PRIMARY KEY constraint manually.`);
    }
    for (const c of t.droppedColumns) out.push('-- ⚠ DESTRUCTIVE: drops column data', `${T}DROP COLUMN ${q(c.name)};`);
    for (const i of t.addedIndexes) out.push(idxDef(t.name, i));
    for (const f of t.addedForeignKeys) {
      out.push(dialect === 'sqlite' ? `-- SQLite cannot add constraints in place; rebuild ${t.name} to add FK ${f.column} → ${f.referencedTable}` : `${T}ADD ${fkDef(f)};`);
    }
    out.push('');
  }

  for (const t of d.droppedTables) {
    out.push(`-- ⚠ DESTRUCTIVE [DROPPED] ${t.name}: permanently deletes the table and all rows`, `DROP TABLE ${q(t.name)};`, '');
  }

  if (!hasDrift(d)) out.push('-- No schema drift. Nothing to migrate.');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function generateMongo(d: SchemaDiff, targetLabel: string): string {
  const coll = (name: string) => `db.getCollection(${JSON.stringify(name)})`;
  const keySpec = (i: IndexSchema) => `{ ${i.columns.map((c) => `${JSON.stringify(c)}: 1`).join(', ')} }`;
  const createIdx = (t: string, i: IndexSchema) =>
    `${coll(t)}.createIndex(${keySpec(i)}, { name: ${JSON.stringify(i.name)}${i.unique ? ', unique: true' : ''} });`;
  const out = [
    `// nativ migration preview: Dev → ${targetLabel} (MongoDB shell)`,
    '// Generated from structural metadata only. Review carefully; nothing is executed automatically.',
    '',
  ];

  for (const t of d.addedTables) {
    out.push(`// [NEW COLLECTION] ${t.name}`, `db.createCollection(${JSON.stringify(t.name)});`);
    for (const i of t.indexes ?? []) out.push(createIdx(t.name, i));
    out.push('');
  }

  for (const t of d.alteredTables) {
    out.push(`// [ALTERED] ${t.name}${t.isDestructive ? '  ⚠ DESTRUCTIVE' : ''}`);
    for (const i of t.droppedIndexes) out.push(`${coll(t.name)}.dropIndex(${JSON.stringify(i.name)});`);
    for (const c of t.addedColumns) {
      if (c.isSubcollection) {
        out.push(`// + subcollection ${JSON.stringify(c.name)} (Firestore-only concept; model as a separate collection or embedded array)`);
        continue;
      }
      const f = JSON.stringify(c.name);
      out.push(
        `// + field ${f} (${c.type}): schemaless, no DDL needed. Optional backfill:`,
        `// ${coll(t.name)}.updateMany({ ${f}: { $exists: false } }, { $set: { ${f}: null } });`,
      );
    }
    for (const ch of t.alteredColumns) {
      out.push(`// ~ field ${JSON.stringify(ch.name)}: ${ch.before.type} → ${ch.after.type} (${ch.changedFields.join(', ')}); convert existing values with a data migration.`);
    }
    for (const c of t.droppedColumns) {
      out.push('// ⚠ DESTRUCTIVE: removes field data from every document', `${coll(t.name)}.updateMany({}, { $unset: { ${JSON.stringify(c.name)}: "" } });`);
    }
    for (const i of t.addedIndexes) out.push(createIdx(t.name, i));
    out.push('');
  }

  for (const t of d.droppedTables) {
    out.push(`// ⚠ DESTRUCTIVE [DROPPED] ${t.name}: permanently deletes the collection and all documents`, `${coll(t.name)}.drop();`, '');
  }

  if (!hasDrift(d)) out.push('// No schema drift. Nothing to migrate.');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** Firestore: deployable index definitions (firestore.indexes.json shape) plus data-migration steps. */
function generateFirestore(d: SchemaDiff, targetLabel: string): string {
  const indexes: unknown[] = [];
  const fieldOverrides: unknown[] = [];
  const steps: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const addIndex = (collection: string, i: IndexSchema) => {
    if (i.unique) {
      warnings.push(`Firestore has no unique indexes: enforce uniqueness of ${collection}.${i.columns.join('+')} (${i.name}) in application code or security rules.`);
    }
    if (i.columns.length > 1) {
      indexes.push({ collectionGroup: collection, queryScope: 'COLLECTION', fields: i.columns.map((f) => ({ fieldPath: f, order: 'ASCENDING' })) });
    } else if (i.columns.length === 1) {
      fieldOverrides.push({ collectionGroup: collection, fieldPath: i.columns[0], indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION' }] });
    }
  };

  for (const t of d.addedTables) {
    steps.push({ op: 'createCollection', collection: t.name, note: 'Collections are created implicitly by the first document write.' });
    for (const i of t.indexes ?? []) addIndex(t.name, i);
  }
  for (const t of d.alteredTables) {
    for (const c of t.addedColumns) {
      steps.push(c.isSubcollection ? { op: 'addSubcollection', collection: t.name, subcollection: c.name } : { op: 'addField', collection: t.name, field: c.name, type: c.type });
    }
    for (const ch of t.alteredColumns) {
      steps.push({ op: 'changeField', collection: t.name, field: ch.name, from: ch.before.type, to: ch.after.type, changed: ch.changedFields });
    }
    for (const c of t.droppedColumns) steps.push({ op: 'deleteField', collection: t.name, field: c.name, destructive: true });
    for (const i of t.addedIndexes) addIndex(t.name, i);
    for (const i of t.droppedIndexes) steps.push({ op: 'removeIndex', collection: t.name, index: i.name, fields: i.columns });
  }
  for (const t of d.droppedTables) {
    steps.push({ op: 'deleteCollection', collection: t.name, destructive: true, note: 'Permanently deletes every document (e.g. firebase firestore:delete --recursive).' });
  }

  const doc: Record<string, unknown> = {
    _nativ: `Preview Dev → ${targetLabel} (Firestore). Nothing runs automatically.`,
    _deploy: 'indexes + fieldOverrides: firebase deploy --only firestore:indexes; dataMigrations: apply with a script',
    indexes,
    fieldOverrides,
    dataMigrations: steps,
  };
  if (warnings.length) doc.warnings = warnings;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Builds the migration script for the engine being migrated (the diff target's engine). */
export function generateMigrationScript(
  diff: SchemaDiff,
  engine: DatabaseEngine,
  targetLabel: string,
): { script: string; language: MigrationLanguage } {
  switch (engine) {
    case 'mongodb':
      return { script: generateMongo(diff, targetLabel), language: 'mongodb-js' };
    case 'firestore':
      return { script: generateFirestore(diff, targetLabel), language: 'firestore-json' };
    default:
      return { script: generateSql(diff, engine, targetLabel), language: 'sql' };
  }
}

// ─── Contract source ──────────────────────────────────────────────────────────

export const CONTRACT_SCHEMA_PATH = path.join('.ai', 'db_schema.json');

/** Engine declared in .ai/db_schema.json, if valid. */
export function loadContractEngine(cwd: string = process.cwd()): DatabaseEngine | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, CONTRACT_SCHEMA_PATH), 'utf8')) as { engine?: string };
    const engines: DatabaseEngine[] = ['postgresql', 'mysql', 'sqlite', 'mongodb', 'firestore'];
    return engines.includes(parsed.engine as DatabaseEngine) ? (parsed.engine as DatabaseEngine) : null;
  } catch {
    return null;
  }
}

/** Reads table/collection definitions from .ai/db_schema.json for Live-vs-Contract drift checks. */
export function loadContractTables(cwd: string = process.cwd()): TableSchema[] {
  const filePath = path.join(cwd, CONTRACT_SCHEMA_PATH);
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { tables?: Partial<TableSchema>[] };
  return (parsed.tables ?? [])
    .filter((t): t is Partial<TableSchema> & { name: string } => typeof t?.name === 'string')
    .map((t) => ({
      name: t.name,
      ...(t.entityType === 'collection' || t.entityType === 'table' ? { entityType: t.entityType } : {}),
      ...(t.description ? { description: t.description } : {}),
      columns: (t.columns ?? []).map((c) => ({
        name: c.name,
        type: c.type,
        primaryKey: Boolean(c.primaryKey),
        nullable: c.nullable !== false,
        default: c.default ?? null,
        ...(c.isMedia ? { isMedia: true } : {}),
        ...(c.isSubcollection ? { isSubcollection: true } : {}),
      })),
      indexes: t.indexes ?? [],
      foreignKeys: t.foreignKeys ?? [],
    }));
}
