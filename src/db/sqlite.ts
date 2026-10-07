/** `node:sqlite` ships with Node.js 22.5+; nativ itself supports Node 20, so SQLite projects get a clear message there. */
export const SQLITE_MIN_NODE = '22.5';

export async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(
      `SQLite databases need Node.js ${SQLITE_MIN_NODE} or newer (this is ${process.version}). Upgrade Node.js, or use Postgres, MySQL or MongoDB.`,
    );
  }
}
