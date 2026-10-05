const MAX_ERROR_OUTPUT_CHARS = 4000;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function truncateOutput(text: string): string {
  return text.length > MAX_ERROR_OUTPUT_CHARS ? `${text.slice(0, MAX_ERROR_OUTPUT_CHARS)}…` : text;
}

let captureQueue: Promise<unknown> = Promise.resolve();

export interface CapturedRun<T> {
  result: T;
  /** Console output with ANSI colors stripped. */
  output: string;
  /** True when the handler set a non-zero process.exitCode. */
  failed: boolean;
}

/**
 * The CLI command handlers report through console.* and process.exitCode, which are process-global,
 * so captured runs are serialized (same approach as the MCP server).
 */
export function runCaptured<T>(fn: () => Promise<T>): Promise<CapturedRun<T>> {
  const run = async (): Promise<CapturedRun<T>> => {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = console.error = console.warn = console.info = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    try {
      const result = await fn();
      const failed = process.exitCode !== undefined && process.exitCode !== 0;
      return { result, failed, output: lines.join('\n').replace(ANSI_PATTERN, '').trim() };
    } finally {
      Object.assign(console, original);
      process.exitCode = previousExitCode;
    }
  };
  const result = captureQueue.then(run, run);
  captureQueue = result.catch(() => undefined);
  return result;
}

/** `--json` CLI handlers print `{ success: false, error }` on failure. */
export function jsonErrorMessage(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { error?: unknown } | null;
    return typeof parsed?.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}
