import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import type { DatabaseEnv, DatabaseStatus, SchemaDiff, TableSchema } from '../db/types.js';
import { resolveConnections } from '../db/env-parser.js';
import { disconnectedStatus, introspectDatabase, type IntrospectionResult } from '../db/introspector.js';
import { diffSchemas, loadContractTables } from '../db/diff.js';
import { DEFAULT_STUDIO_PORT, startStudioServer, writeContractSchema } from '../server/studio-server.js';
import { renderStudioHtml } from '../server/studio-ui.js';

/**
 * `agentj db` command handlers.
 * Air-gap: raw connection URLs are resolved in-process and never printed; all output
 * (text and --json) uses masked URLs and structural metadata only.
 */

const ENGINE_LABEL: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  firestore: 'Firebase Firestore',
};

function resolveDir(targetDirArg?: string): string {
  return path.resolve(targetDirArg || process.cwd());
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function parseEnvOption(value: string | undefined, fallback: DatabaseEnv): DatabaseEnv | null {
  if (!value) return fallback;
  const v = value.toLowerCase();
  if (v === 'dev' || v === 'prod') return v;
  console.error(pc.red(`\n✖ Invalid environment "${value}". Use 'dev' or 'prod'.\n`));
  process.exitCode = 1;
  return null;
}

async function introspectEnv(targetDir: string, env: DatabaseEnv): Promise<IntrospectionResult> {
  const conns = resolveConnections(targetDir);
  const conn = conns[env];
  if (!conn) {
    const missingKey = conns.templateInfo?.missingKeys.find((k) => k.targetEnv === env);
    if (missingKey) {
      const engineLabel = missingKey.engine ? ` (${ENGINE_LABEL[missingKey.engine] ?? missingKey.engine})` : '';
      const templateName = conns.templateInfo?.templateFile ?? '.env.example';
      const suggestion = `Found "${missingKey.key}"${engineLabel} in ${templateName}, but it is not set in your .env`;
      return {
        status: disconnectedStatus(
          `No ${env} database configured. ${suggestion}`,
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
    const key = env === 'dev' ? 'DEV_DATABASE_URL (or DATABASE_URL)' : 'PROD_DATABASE_URL';
    return { status: disconnectedStatus(`No ${env} database configured. Set ${key} in .env`), tables: [] };
  }
  const result = await introspectDatabase(conn.url);
  result.status.sourceKey = conn.sourceKey;
  result.status.detectedFromExample = conn.detectedFromExample;
  result.status.exampleFile = conn.exampleFile;
  return result;
}

function printStatusLine(env: DatabaseEnv, s: DatabaseStatus): void {
  const label = pc.bold(env.toUpperCase().padEnd(4));
  if (!s.connected) {
    console.log(`  ${pc.red('●')} ${label} ${pc.red('[OFFLINE]')} ${pc.dim(s.error ?? 'Unknown error')}`);
    if (s.suggestion) {
      console.log(`         ${pc.yellow(`Tip: ${s.suggestion}`)}`);
    }
    if (s.maskedUrl) console.log(pc.dim(`         ${s.maskedUrl}`));
    return;
  }
  const count = s.entityCount ?? s.tableCount;
  const isCollection = s.entityType === 'collection';
  const entityWord = isCollection ? (count === 1 ? 'collection' : 'collections') : (count === 1 ? 'table' : 'tables');
  const sourceInfo =
    s.detectedFromExample && s.sourceKey
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

function describeColumn(c: TableSchema['columns'][number]): string {
  const flags: string[] = [];
  if (c.primaryKey) flags.push('PK');
  if (c.isMedia) flags.push('[IMAGE]');
  if (c.isSubcollection) flags.push('[SUBCOLLECTION]');
  const flagStr = flags.length ? ` ${pc.magenta(flags.join(' '))}` : '';
  return `${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default != null ? ` DEFAULT ${c.default}` : ''}${flagStr}`;
}

function printDiff(diff: SchemaDiff, targetLabel: string): void {
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

// ─── agentj db status ─────────────────────────────────────────────────────────

export async function runDbStatus(targetDirArg?: string, options: { json?: boolean } = {}): Promise<void> {
  const targetDir = resolveDir(targetDirArg);
  const [dev, prod] = await Promise.all([introspectEnv(targetDir, 'dev'), introspectEnv(targetDir, 'prod')]);

  if (options.json) {
    console.log(JSON.stringify({ dev: dev.status, prod: prod.status }, null, 2));
    return;
  }

  console.log(pc.bold(pc.cyan('\nAgentJ Database Telemetry')));
  printStatusLine('dev', dev.status);
  printStatusLine('prod', prod.status);
  console.log('');
  if (!dev.status.connected && !prod.status.connected) process.exitCode = 1;
}

// ─── agentj db inspect ────────────────────────────────────────────────────────

export async function runDbInspect(
  targetDirArg?: string,
  options: { env?: string; table?: string; json?: boolean } = {},
): Promise<void> {
  const env = parseEnvOption(options.env, 'dev');
  if (!env) return;
  const targetDir = resolveDir(targetDirArg);
  const result = await introspectEnv(targetDir, env);

  if (!result.status.connected) {
    if (options.json) console.log(JSON.stringify({ status: result.status, tables: [] }, null, 2));
    else console.error(pc.red(`\n✖ ${env.toUpperCase()} database unavailable: ${result.status.error}\n`));
    process.exitCode = 1;
    return;
  }

  const isCollection = result.status.entityType === 'collection';
  const entityWord = isCollection ? 'Collections' : 'Tables';
  const singleEntityWord = isCollection ? 'Collection' : 'Table';

  let tables = result.tables;
  if (options.table) {
    const wanted = options.table.toLowerCase();
    tables = tables.filter((t) => t.name.toLowerCase() === wanted);
    if (!tables.length) {
      console.error(pc.red(`\n✖ ${singleEntityWord} "${options.table}" not found in ${env.toUpperCase()}.\n`));
      process.exitCode = 1;
      return;
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ status: result.status, tables }, null, 2));
    return;
  }

  console.log(pc.bold(pc.cyan(`\n${env.toUpperCase()} Schema (${entityWord})`)) + pc.dim(` · ${result.status.maskedUrl}`));
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

// ─── agentj db diff ───────────────────────────────────────────────────────────

export async function runDbDiff(
  targetDirArg?: string,
  options: { target?: string; json?: boolean; exitCode?: boolean } = {},
): Promise<void> {
  const target = (options.target ?? 'prod').toLowerCase();
  if (target !== 'prod' && target !== 'contract') {
    console.error(pc.red(`\n✖ Invalid --target "${options.target}". Use 'prod' or 'contract'.\n`));
    process.exitCode = 1;
    return;
  }
  const targetDir = resolveDir(targetDirArg);

  const dev = await introspectEnv(targetDir, 'dev');
  if (!dev.status.connected) {
    console.error(pc.red(`\n✖ Dev database unavailable: ${dev.status.error}\n`));
    process.exitCode = 1;
    return;
  }

  let targetTables: TableSchema[];
  let targetLabel: string;
  if (target === 'contract') {
    targetTables = loadContractTables(targetDir);
    targetLabel = '.ai/db_schema.json';
  } else {
    const prod = await introspectEnv(targetDir, 'prod');
    if (!prod.status.connected) {
      console.error(pc.red(`\n✖ Prod database unavailable: ${prod.status.error}`));
      console.log(pc.yellow('  Tip: use --target contract to compare Dev against .ai/db_schema.json instead.\n'));
      process.exitCode = 1;
      return;
    }
    targetTables = prod.tables;
    targetLabel = 'Prod';
  }

  const diff = diffSchemas(dev.tables, targetTables);
  if (options.json) console.log(JSON.stringify(diff, null, 2));
  else printDiff(diff, targetLabel);

  const s = diff.summary;
  if (options.exitCode && s.addedTablesCount + s.alteredTablesCount + s.droppedTablesCount > 0) process.exitCode = 1;
}

// ─── agentj db sync ───────────────────────────────────────────────────────────

/** Exports a live schema into .ai/db_schema.json. Previews unless --yes is passed. */
export async function runDbSync(targetDirArg?: string, options: { source?: string; yes?: boolean } = {}): Promise<void> {
  const source = parseEnvOption(options.source, 'dev');
  if (!source) return;
  const targetDir = resolveDir(targetDirArg);

  const result = await introspectEnv(targetDir, source);
  if (!result.status.connected) {
    console.error(pc.red(`\n✖ ${source.toUpperCase()} database unavailable: ${result.status.error}\n`));
    process.exitCode = 1;
    return;
  }

  const diff = diffSchemas(result.tables, loadContractTables(targetDir));
  const s = diff.summary;
  const changed = s.addedTablesCount + s.alteredTablesCount + s.droppedTablesCount;

  console.log(pc.bold(pc.cyan(`\nSync ${source.toUpperCase()} schema → .ai/db_schema.json`)) + pc.dim(` · ${result.status.maskedUrl}`));
  if (!changed) {
    console.log(pc.green('✔ Contract already matches the live schema. Nothing to write.\n'));
    return;
  }
  printDiff(diff, '.ai/db_schema.json');

  if (!options.yes) {
    console.log(pc.yellow('Dry run: no files were changed. Re-run with --yes to write .ai/db_schema.json.\n'));
    return;
  }

  const filePath = writeContractSchema(targetDir, result.status, result.tables);
  const count = result.tables.length;
  const isCollection = result.status.entityType === 'collection';
  const entityWord = isCollection ? (count === 1 ? 'collection' : 'collections') : (count === 1 ? 'table' : 'tables');
  console.log(pc.green(`✔ Wrote ${count} ${entityWord} (structure only, no credentials) to ${path.relative(targetDir, filePath)}\n`));
}

// ─── agentj db ui ─────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Headless environment — the URL is printed anyway.
  }
}

export async function runDbUi(targetDirArg?: string, options: { port?: string; open?: boolean } = {}): Promise<void> {
  const targetDir = resolveDir(targetDirArg);
  const port = options.port ? Number.parseInt(options.port, 10) : DEFAULT_STUDIO_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(pc.red(`\n✖ Invalid --port "${options.port}".\n`));
    process.exitCode = 1;
    return;
  }

  const version = packageVersion();
  let handle;
  try {
    handle = await startStudioServer({ port, cwd: targetDir, html: () => renderStudioHtml({ version }) });
  } catch (err) {
    console.error(pc.red(`\n✖ Failed to start DB Studio: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
    return;
  }

  const conns = resolveConnections(targetDir);
  console.log(pc.bold(pc.cyan(`\nAgentJ DB Studio v${version}`)));
  const devSource = conns.dev?.detectedFromExample ? ` (from ${conns.dev.sourceKey} in ${conns.dev.exampleFile ?? '.env.example'})` : conns.dev?.sourceKey ? ` (${conns.dev.sourceKey})` : '';
  const prodSource = conns.prod?.detectedFromExample ? ` (from ${conns.prod.sourceKey} in ${conns.prod.exampleFile ?? '.env.example'})` : conns.prod?.sourceKey ? ` (${conns.prod.sourceKey})` : '';
  console.log(pc.dim(`  Dev:  ${conns.dev ? `${conns.dev.maskedUrl}${devSource}` : 'not configured'}`));
  console.log(pc.dim(`  Prod: ${conns.prod ? `${conns.prod.maskedUrl}${prodSource}` : 'not configured'}`));
  console.log(pc.dim('  Credentials stay in this process only. Press Ctrl+C to stop.\n'));

  if (options.open !== false) openBrowser(handle.url);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      console.log(pc.dim('\nStopping DB Studio…'));
      handle.server.closeAllConnections?.();
      handle.close().then(resolve, resolve);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
