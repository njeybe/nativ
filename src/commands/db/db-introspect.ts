import type { DatabaseEnv, DatabaseStatus, SchemaDiff, TableSchema } from '../../db/types.js';
import { resolveConnections } from '../../db/env-parser.js';
import { disconnectedStatus, introspectDatabase, type IntrospectionResult } from '../../db/introspector.js';

export const ENGINE_LABEL: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  mongodb: 'MongoDB',
  firestore: 'Firebase Firestore',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Actionable hint when a local MySQL/PostgreSQL server refuses the connection, e.g. MySQL not started in
 * the XAMPP Control Panel. Only host/port are read from the URL; credentials are never touched.
 */
export function localStackDiagnostic(url: string, engine: string, status: DatabaseStatus, fragmentedKeys?: string[]): string | null {
  if (engine !== 'mysql' && engine !== 'postgresql') return null;
  if (!/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|connection refused/i.test(status.error ?? '')) return null;
  let host = '';
  let port = engine === 'mysql' ? 3306 : 5432;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    if (parsed.port) port = Number(parsed.port);
  } catch {
    return null;
  }
  const label = ENGINE_LABEL[engine];
  const isLocal = LOCAL_HOSTS.has(host);
  const action =
    engine === 'mysql'
      ? isLocal
        ? 'Ensure MySQL is started in XAMPP Control Panel.'
        : `Ensure the MySQL server at ${host}:${port} is running and reachable.`
      : `Ensure the PostgreSQL service is running on ${host}:${port}.`;

  if (fragmentedKeys?.length) {
    const shown = fragmentedKeys.filter((k) => /HOST|DATABASE|_DB$|DB_NAME$/.test(k));
    return `Detected fragmented ${label} config (${(shown.length ? shown : fragmentedKeys).join(', ')}). ${action}`;
  }
  return isLocal ? `${label} refused connections on ${host}:${port}. ${action}` : null;
}

export async function introspectEnv(targetDir: string, env: DatabaseEnv): Promise<IntrospectionResult> {
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
  if (conn.synthesized) result.status.synthesized = true;
  if (!result.status.connected) {
    const fragmentedKeys = env === 'dev' && conn.synthesized ? conns.templateInfo.fragmentedConfig?.sourceKeys : undefined;
    const diagnostic = localStackDiagnostic(conn.url, conn.engine, result.status, fragmentedKeys ?? (conn.synthesized ? [conn.sourceKey] : undefined));
    if (diagnostic) result.status.suggestion = diagnostic;
  }
  return result;
}

/** DB_HOST -> DB_*, PROD_DB_HOST -> PROD_DB_*, PGHOST -> PG*. */
export function keyFamily(key: string): string {
  const m = /^(.*_)[^_]*$/.exec(key);
  return m ? `${m[1]}*` : `${key.slice(0, 2)}*`;
}
