import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pc from 'picocolors';
import type { DatabaseEnv, TableSchema } from '../db/types.js';
import { diffSchemas, loadContractTables } from '../db/diff.js';
import { DEFAULT_STUDIO_PORT, startStudioServer, writeContractSchema } from '../server/studio-server.js';
import { renderStudioHtml } from '../server/studio-ui.js';
import { refuseHeadless } from '../core/human-gate.js';
import { resolveConnections } from '../db/env-parser.js';
import { introspectEnv, keyFamily } from './db/db-introspect.js';
import { printStatusLine, printDiff, printInspectTables } from './db/db-formatter.js';

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

export async function runDbStatus(targetDirArg?: string, options: { json?: boolean } = {}): Promise<void> {
  const targetDir = resolveDir(targetDirArg);
  const [dev, prod] = await Promise.all([introspectEnv(targetDir, 'dev'), introspectEnv(targetDir, 'prod')]);

  if (options.json) {
    console.log(JSON.stringify({ dev: dev.status, prod: prod.status }, null, 2));
    return;
  }

  console.log(pc.bold(pc.cyan('\nnativ Database Telemetry')));
  printStatusLine('dev', dev.status);
  printStatusLine('prod', prod.status);
  console.log('');
  if (!dev.status.connected && !prod.status.connected) process.exitCode = 1;
}

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

  printInspectTables(env, result.status.maskedUrl, tables, entityWord, isCollection);
}

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
  if (refuseHeadless('nativ db sync --yes')) return;

  const filePath = writeContractSchema(targetDir, result.status, result.tables);
  const count = result.tables.length;
  const isCollection = result.status.entityType === 'collection';
  const entityWord = isCollection ? (count === 1 ? 'collection' : 'collections') : (count === 1 ? 'table' : 'tables');
  console.log(pc.green(`✔ Wrote ${count} ${entityWord} (structure only, no credentials) to ${path.relative(targetDir, filePath)}\n`));
}

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
  console.log(pc.bold(pc.cyan(`\nNativ DB Studio v${version}`)));
  const describeSource = (c: typeof conns.dev): string =>
    !c
      ? ''
      : c.synthesized
        ? ` [synthesized from ${keyFamily(c.sourceKey)}]`
        : c.detectedFromExample
          ? ` (from ${c.sourceKey} in ${c.exampleFile ?? '.env.example'})`
          : c.sourceKey
            ? ` (${c.sourceKey})`
            : '';
  const devSource = describeSource(conns.dev);
  const prodSource = describeSource(conns.prod);
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
