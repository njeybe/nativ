import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

// Handlers share global console/process.exitCode state, so captured runs are serialized.
let captureQueue: Promise<unknown> = Promise.resolve();

export function captureOutput(
  fn: () => Promise<unknown>,
  options: { errorOnExitCode?: boolean } = {}
): Promise<CallToolResult> {
  const run = async (): Promise<CallToolResult> => {
    const lines: string[] = [];
    const collect = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' '));
    };
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = console.error = console.warn = console.info = collect;

    let failed = false;
    try {
      await fn();
      failed = options.errorOnExitCode !== false && process.exitCode !== undefined && process.exitCode !== 0;
    } catch (err) {
      failed = true;
      lines.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      Object.assign(console, original);
      process.exitCode = previousExitCode;
    }

    const text = lines.join('\n').replace(ANSI_PATTERN, '').trim() || '(no output)';
    return { content: [{ type: 'text', text }], isError: failed || undefined };
  };

  const result = captureQueue.then(run, run);
  captureQueue = result.catch(() => undefined);
  return result;
}
