import path from 'node:path';
import pc from 'picocolors';
import { applySetup, type SetupOptions, type SetupResult } from '../core/setup-assets.js';
import type { EnforcementMode } from '../core/enforcement.js';

export interface SetupCommandOptions {
  command?: string;
  enforcement?: string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  /** Suppresses the report; `nativ init` prints its own. */
  quiet?: boolean;
}

const MODES: EnforcementMode[] = ['off', 'warn', 'block'];

const ICON: Record<string, string> = { created: '+', updated: '~', unchanged: '=', skipped: '!' };

export function printSetupResult(result: SetupResult): void {
  const paint = (action: string, text: string) =>
    action === 'created' ? pc.green(text) : action === 'updated' ? pc.cyan(text) : action === 'skipped' ? pc.yellow(text) : pc.dim(text);
  for (const change of result.changes) {
    const verb = result.dryRun && (change.action === 'created' || change.action === 'updated') ? `would be ${change.action}` : change.action;
    console.log(paint(change.action, `  ${ICON[change.action]} ${change.path}`) + pc.dim(`  ${verb}${change.detail ? `: ${change.detail}` : ''}`));
  }
  for (const warning of result.warnings) console.log(pc.yellow(`\n⚠ ${warning}`));
}

/**
 * `nativ setup`: writes the Claude Code configuration (.mcp.json, .claude/settings.json, .claude/agents/,
 * AGENTS.md, .nativ/config.json), merging into what exists and never overwriting user-authored content.
 * Safe to run any number of times.
 */
export async function runSetup(targetDirArg?: string, options: SetupCommandOptions = {}): Promise<SetupResult | null> {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  if (options.enforcement !== undefined && !MODES.includes(options.enforcement as EnforcementMode)) {
    const message = `--enforcement must be one of: ${MODES.join(', ')}`;
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(pc.red(`\n✖ ${message}\n`));
    process.exitCode = 1;
    return null;
  }

  const setupOptions: SetupOptions & { dryRun?: boolean } = {
    command: options.command,
    enforcement: options.enforcement as EnforcementMode | undefined,
    force: options.force,
    dryRun: options.dryRun,
  };
  const result = applySetup(targetDir, setupOptions);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, root: result.root, dryRun: result.dryRun, cli: result.invocation, changes: result.changes, warnings: result.warnings }, null, 2));
    return result;
  }
  if (options.quiet) return result;

  console.log(pc.bold(pc.cyan(`\nnativ setup${result.dryRun ? ' (dry run)' : ''}`)) + pc.dim(`  ${result.root}`));
  printSetupResult(result);
  const changed = result.changes.filter((c) => c.action === 'created' || c.action === 'updated').length;
  console.log(
    changed
      ? pc.green(`\n✔ ${result.dryRun ? `${changed} change(s) pending` : `${changed} file(s) written`}.`) + pc.dim(' Restart Claude Code (or run /hooks) to load the hooks.\n')
      : pc.green('\n✔ Everything is already set up. Nothing changed.\n'),
  );
  return result;
}
