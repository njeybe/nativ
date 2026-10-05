import fs from 'node:fs';
import path from 'node:path';

export interface OrmDetectionResult {
  detectedOrmConfig: string;
  databaseOrm: string;
}

export function detectOrm(
  resolvedTarget: string,
  fileExists: (relPath: string) => boolean,
  initialOrm: string
): OrmDetectionResult {
  let detectedOrmConfig = '';
  let databaseOrm = initialOrm;

  if (fileExists('prisma/schema.prisma')) {
    detectedOrmConfig = 'prisma/schema.prisma';
    databaseOrm = 'Prisma ORM';
  } else if (fileExists('schema.prisma')) {
    detectedOrmConfig = 'schema.prisma';
    databaseOrm = 'Prisma ORM';
  }

  if (fileExists('drizzle.config.ts')) {
    detectedOrmConfig = 'drizzle.config.ts';
    databaseOrm = 'Drizzle ORM';
  } else if (fileExists('drizzle.config.js')) {
    detectedOrmConfig = 'drizzle.config.js';
    databaseOrm = 'Drizzle ORM';
  } else if (fileExists('drizzle.config.json')) {
    detectedOrmConfig = 'drizzle.config.json';
    databaseOrm = 'Drizzle ORM';
  }

  if (fileExists('knexfile.js')) {
    detectedOrmConfig = 'knexfile.js';
    databaseOrm = 'Knex';
  } else if (fileExists('knexfile.ts')) {
    detectedOrmConfig = 'knexfile.ts';
    databaseOrm = 'Knex';
  }

  if (fileExists('alembic.ini')) {
    detectedOrmConfig = 'alembic.ini';
    databaseOrm = databaseOrm === 'None detected' ? 'SQLAlchemy (Alembic)' : `${databaseOrm} (Alembic)`;
  }

  if (fileExists('database/migrations')) {
    try {
      const isDir = fs.statSync(path.join(resolvedTarget, 'database/migrations')).isDirectory();
      if (isDir) {
        detectedOrmConfig = 'database/migrations';
        if (databaseOrm === 'None detected') databaseOrm = 'SQL Migrations';
      }
    } catch {
      // ignore
    }
  }

  if (fileExists('ormconfig.json')) {
    detectedOrmConfig = 'ormconfig.json';
    databaseOrm = 'TypeORM';
  }

  return {
    detectedOrmConfig,
    databaseOrm,
  };
}
