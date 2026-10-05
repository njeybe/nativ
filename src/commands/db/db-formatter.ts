import pc from 'picocolors';
import type { DatabaseEnv, DatabaseStatus, SchemaDiff, TableSchema } from '../../db/types.js';
import { ENGINE_LABEL, keyFamily } from './db-introspect.js';

export function printStatusLine(env: DatabaseEnv, s: DatabaseStatus): void {
  const label = pc.bold(env.toUpperCase().padEnd(4));
  const synthBadge = s.synthesized && s.sourceKey ? ` ${pc.magenta(`[synthesized from ${keyFamily(s.sourceKey)}]`)}` : '';
  if (!s.connected) {
    console.log(`  ${pc.red('●')} ${label} ${pc.red('[OFFLINE]')}${synthBadge} ${pc.dim(s.error ?? 'Unknown error')}`);
    if (s.suggestion) {
      const isDiagnostic = /Ensure (MySQL|the MySQL|the PostgreSQL)/.test(s.suggestion);
      console.log(`         ${pc.yellow(isDiagnostic ? `[DIAGNOSTIC] ${s.suggestion}` : `Tip: ${s.suggestion}`)}`);
    }
    if (s.maskedUrl) console.log(pc.dim(`         ${s.maskedUrl}`));
    return;
  }
  const count = s.entityCount ?? s.tableCount;
  const isCollection = s.entityType === 'collection';
  const entityWord = isCollection ? (count === 1 ? 'collection' : 'collections') : (count === 1 ? 'table' : 'tables');
  const sourceInfo = synthBadge
    ? synthBadge
    : s.detectedFromExample && s.sourceKey
      ? pc.cyan(` (via ${s.sourceKey} from ${s.exampleFile ?? '.env.example'})`)
      : s.sourceKey
        ? pc.dim(` (via ${s.sourceKey})`)
        : '';
  console.log(
    `  ${pc.green('●')} ${label} ${pc.green('[ONLINE]')} ${ENGINE_LABEL[s.engine] ?? s.engine}` +
      `${s.database ? ` · ${s.database}` : ''} ${pc.dim(`(${s.pingMs}ms)`)} – ${count} ${entityWord}${sourceInfo}`,
  );
  console.log(pc.dim(`         ${s.maskedUrl}`));
}

export function describeColumn(c: TableSchema['columns'][number]): string {
  const flags: string[] = [];
  if (c.primaryKey) flags.push('PK');
  if (c.isMedia) flags.push('[IMAGE]');
  if (c.isSubcollection) flags.push('[SUBCOLLECTION]');
  const flagStr = flags.length ? ` ${pc.magenta(flags.join(' '))}` : '';
  return `${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default != null ? ` DEFAULT ${c.default}` : ''}${flagStr}`;
}

export function printDiff(diff: SchemaDiff, targetLabel: string): void {
  const s = diff.summary;
  console.log(pc.bold(pc.cyan(`\nSchema Drift: Dev → ${targetLabel}`)));
  console.log(
    `  ${pc.green(`+${s.addedTablesCount} added`)}  ${pc.yellow(`~${s.alteredTablesCount} altered`)}  ` +
      `${pc.red(`-${s.droppedTablesCount} dropped`)}  ${pc.dim(`${s.unchangedTablesCount} unchanged`)}`,
  );

  if (!s.addedTablesCount && !s.alteredTablesCount && !s.droppedTablesCount) {
    console.log(pc.green(`\n✔ In sync: Dev matches ${targetLabel}.\n`));
    return;
  }

  for (const t of diff.addedTables) {
    const isCol = t.entityType === 'collection';
    const tag = isCol ? '[NEW COLLECTION]' : '[NEW TABLE]';
    const fieldWord = isCol ? 'fields' : 'columns';
    console.log(`\n  ${pc.green(tag)} ${pc.bold(t.name)} ${pc.dim(`(${t.columns.length} ${fieldWord})`)}`);
  }

  for (const t of diff.alteredTables) {
    console.log(`\n  ${pc.yellow('[ALTERED]')} ${pc.bold(t.name)}${t.isDestructive ? ` ${pc.red('[DESTRUCTIVE]')}` : ''}`);
    for (const c of t.addedColumns) console.log(pc.green(`    + ${c.name}: ${describeColumn(c)}`));
    for (const ch of t.alteredColumns) {
      console.log(pc.yellow(`    ~ ${ch.name} (${ch.changedFields.join(', ')}): ${describeColumn(ch.before)} → ${describeColumn(ch.after)}`));
    }
    for (const c of t.droppedColumns) console.log(pc.red(`    - ${c.name}: ${describeColumn(c)}`));
    for (const i of t.addedIndexes) console.log(pc.green(`    + index ${i.name} (${i.columns.join(', ')})${i.unique ? ' unique' : ''}`));
    for (const i of t.droppedIndexes) console.log(pc.red(`    - index ${i.name} (${i.columns.join(', ')})`));
    for (const f of t.addedForeignKeys) console.log(pc.green(`    + FK ${f.column} → ${f.referencedTable}.${f.referencedColumn}`));
    for (const f of t.droppedForeignKeys) console.log(pc.red(`    - FK ${f.column} → ${f.referencedTable}.${f.referencedColumn}`));
  }

  for (const t of diff.droppedTables) {
    const isCol = t.entityType === 'collection';
    const tag = isCol ? '[DROPPED COLLECTION]' : '[DROPPED]';
    const fieldWord = isCol ? 'fields' : 'columns';
    console.log(`\n  ${pc.red(tag)} ${pc.bold(t.name)} ${pc.dim(`(${t.columns.length} ${fieldWord})`)}`);
  }

  if (s.hasDestructiveChanges) {
    console.log(
      pc.bgRed(pc.white(pc.bold(' HIGH SEVERITY '))) +
        pc.red(` Destructive changes detected against ${targetLabel}. Applying them would drop data or fail on existing rows.`),
    );
  }
  console.log('');
}

export function printInspectTables(
  env: DatabaseEnv,
  maskedUrl: string,
  tables: TableSchema[],
  entityWord: string,
  isCollection: boolean
): void {
  console.log(pc.bold(pc.cyan(`\n${env.toUpperCase()} Schema (${entityWord})`)) + pc.dim(` · ${maskedUrl}`));
  for (const t of tables) {
    const isCol = t.entityType === 'collection' || isCollection;
    const fieldWord = isCol ? 'fields' : 'columns';
    const tag = isCol ? pc.green('[COLLECTION] ') : '';
    console.log(`\n  ${tag}${pc.bold(t.name)} ${pc.dim(`(${t.columns.length} ${fieldWord})`)}`);
    if (t.description) console.log(pc.dim(`    ${t.description}`));
    const fkByColumn = new Map(t.foreignKeys.map((f) => [f.column.toLowerCase(), f]));
    const nameWidth = Math.max(...t.columns.map((c) => c.name.length), 4);
    for (const c of t.columns) {
      const fk = fkByColumn.get(c.name.toLowerCase());
      const flags: string[] = [];
      if (c.primaryKey) flags.push(pc.magenta('PK'));
      if (c.isMedia) flags.push(pc.magenta('[IMAGE]'));
      if (c.isSubcollection) flags.push(pc.cyan('[SUBCOLLECTION]'));
      if (fk) flags.push(pc.cyan(`FK→${fk.referencedTable}.${fk.referencedColumn}`));
      const tags = flags.join(' ');
      console.log(
        `    ${c.name.padEnd(nameWidth)}  ${c.type}${c.nullable ? '' : pc.dim(' NOT NULL')}` +
          `${c.default != null ? pc.dim(` DEFAULT ${c.default}`) : ''}${tags ? `  ${tags}` : ''}`,
      );
    }
    for (const i of t.indexes) console.log(pc.dim(`    index ${i.name} (${i.columns.join(', ')})${i.unique ? ' unique' : ''}`));
  }
  console.log('');
}

