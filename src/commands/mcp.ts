import path from 'node:path';
import { startMcpServer } from '../mcp/server.js';

/**
 * `nativ mcp` — runs the native MCP server over stdio.
 * Nothing may be written to stdout here: it carries the JSON-RPC stream. Diagnostics go to stderr.
 */
export async function runMcp(targetDirArg?: string): Promise<void> {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  try {
    await startMcpServer(targetDir);
  } catch (err) {
    process.stderr.write(`✖ Failed to start Nativ MCP server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
