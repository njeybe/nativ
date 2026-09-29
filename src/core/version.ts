import fs from 'node:fs';

/**
 * The installed package's version, read from package.json so `nativ --version`, the MCP server info and the
 * plugin can never disagree with what was published. Works from dist/ (dist/core/version.js -> ../../package.json).
 */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
