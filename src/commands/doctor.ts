import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { spawnSync } from 'node:child_process';
import { loadEnforcementMode, parseJsonLoose } from '../core/enforcement.js';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { applySetup, defaultHasBinary, planSetup, type SetupOptions } from '../core/setup-assets.js';
import { createProviders, providerCooldownRemaining } from '../providers/index.js';
import type { ProviderDeps } from '../providers/index.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  /** True when `nativ doctor --fix` (which runs setup) can repair it. */
  fixable?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  root: string;
  fixed: string[];
  checks: DoctorCheck[];
}

export interface DoctorOptions extends SetupOptions {
  fix?: boolean;
  json?: boolean;
  /** Also ask Claude Code itself (`claude mcp list`, a few seconds) whether the nativ server connects and is not shadowed. */
  deep?: boolean;
  /** Returns the text of `claude mcp list`, or null when it could not run; injectable for tests. */
  mcpList?: (cwd: string) => string | null;
  /** Runs `<command> --version`; injectable so tests need no real binaries. */
  runVersion?: (command: string, args: string[]) => { ok: boolean; output: string };
  providerDeps?: ProviderDeps;
}

function defaultRunVersion(command: string, args: string[]): { ok: boolean; output: string } {
  try {
    // The Windows shims (nativ.cmd, npx.cmd) only start through a shell.
    const result = spawnSync(command, [...args, '--version'], { encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32' });
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/)[0] ?? '' };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

function defaultMcpList(cwd: string): string | null {
  try {
    const result = spawnSync('claude', ['mcp', 'list'], { cwd, encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' });
    return result.status === 0 ? `${result.stdout ?? ''}` : null;
  } catch {
    return null;
  }
}

/**
 * Reads Claude Code's own view of the nativ MCP server. A `nativ` server registered in the user's local or
 * user scope silently shadows the project's `.mcp.json`, so setup can succeed while Claude runs something else.
 */
export function analyzeMcpList(text: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const line = text.split(/\r?\n/).find((l) => /^nativ:/.test(l.trim()));
  if (!line) {
    checks.push({ id: 'mcp-listed', status: 'warn', message: 'Claude Code does not list a "nativ" MCP server here. Check that the project .mcp.json is approved (enabledMcpjsonServers) and the workspace is trusted.' });
  } else if (/Connected/.test(line)) {
    checks.push({ id: 'mcp-connected', status: 'ok', message: `Claude Code connects to the nativ MCP server (${line.replace(/\s+-\s+.*$/, '').trim()})` });
  } else {
    checks.push({ id: 'mcp-connected', status: 'fail', message: `Claude Code lists the nativ MCP server but it is not connected: ${line.trim()}` });
  }
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
  const conflict = /Server "nativ" is defined in multiple scopes[^\n]*/.exec(plain);
  if (conflict) {
    checks.push({
      id: 'mcp-scope-conflict',
      status: 'warn',
      message: `${conflict[0].trim()} The other scope wins over the project .mcp.json. Remove the one you do not want, e.g. \`claude mcp remove nativ -s local\`.`,
    });
  }
  return checks;
}

/** Collects every check without changing anything. */
export function collectChecks(root: string, options: DoctorOptions = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: CheckStatus, message: string, fixable = false) => checks.push({ id, status, message, fixable });
  const hasBinary = options.hasBinary ?? defaultHasBinary;
  const runVersion = options.runVersion ?? defaultRunVersion;

  const planFile = path.join(root, '.ai', 'master_plan.json');
  if (!fs.existsSync(planFile)) {
    add('project', 'fail', 'No .ai/master_plan.json. Run `nativ init` first.');
  } else {
    try {
      parseJsonLoose(fs.readFileSync(planFile, 'utf8'));
      add('project', 'ok', '.ai/ workflow found');
    } catch (err) {
      // Enforcement cannot see the active task in a plan it cannot read, so this must never be a quiet state.
      add('project', 'fail', `.ai/master_plan.json cannot be parsed (${err instanceof Error ? err.message : String(err)}). Role enforcement cannot see the active task until it is fixed.`);
    }
  }

  // Claude Code itself
  if (hasBinary('claude')) {
    const version = runVersion('claude', []);
    add('claude', version.ok ? 'ok' : 'warn', version.ok ? `Claude Code found (${version.output})` : 'The claude executable is on PATH but did not run.');
  } else {
    add('claude', 'warn', 'Claude Code (`claude`) is not on PATH. Install it from https://claude.com/claude-code; nativ still works without it for the CLI.');
  }

  // How the generated config will start nativ
  const plan = planSetup(root, options);
  const invocation = plan.invocation;
  const cli = [invocation.command, ...invocation.prefixArgs];
  if (!invocation.portable) {
    add('cli-portable', 'warn', 'The nativ command points at an absolute path on this machine. Install nativ globally or run `nativ setup --command "npx -y nativ-cli"`.');
  }
  const version = runVersion(invocation.command, invocation.prefixArgs);
  add('cli-runs', version.ok ? 'ok' : 'fail', version.ok ? `\`${cli.join(' ')}\` runs (${version.output})` : `\`${cli.join(' ')}\` does not run: ${version.output || 'no output'}. The hooks and MCP server would fail.`);

  // Generated assets: whatever setup would still change is drift
  for (const change of plan.changes) {
    if (change.action === 'created') add(`asset:${change.path}`, 'fail', `${change.path} is missing`, true);
    else if (change.action === 'updated') add(`asset:${change.path}`, 'warn', `${change.path} is out of date${change.detail ? ` (${change.detail})` : ''}`, true);
    else if (change.action === 'skipped') add(`asset:${change.path}`, 'warn', `${change.path}: ${change.detail ?? 'not managed by nativ'}`);
    else if (change.detail) add(`asset:${change.path}`, 'info', `${change.path}: ${change.detail}`);
  }
  if (!plan.changes.some((c) => c.action === 'created' || c.action === 'updated')) add('assets', 'ok', 'MCP server, hooks, permissions, agents and directives are in place');

  // Claude Code's own view (opt-in: it connects to every configured MCP server)
  if (options.deep && hasBinary('claude')) {
    const listing = (options.mcpList ?? defaultMcpList)(root);
    if (listing === null) add('mcp-listed', 'warn', '`claude mcp list` could not run, so the live MCP connection was not checked.');
    else for (const c of analyzeMcpList(listing)) checks.push(c);
  }

  // Trust: Claude Code ignores a project's permissions.allow (and may skip its hooks) until the folder is trusted
  add('trust', 'info', 'Open Claude Code in this folder once and accept the trust dialog, otherwise project permissions.allow entries are ignored.');

  // Enforcement
  const mode = loadEnforcementMode(root);
  add('enforcement', mode === 'off' ? 'warn' : 'ok', mode === 'off' ? 'Role enforcement is off: nothing stops an agent editing outside its task.' : `Role enforcement is ${mode}`);

  // Providers
  const providers = createProviders(options.providerDeps);
  const usable: string[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    const cooling = providerCooldownRemaining(root, id as keyof typeof providers);
    if (provider.hasCredentials(root) && !cooling) usable.push(id);
    else if (cooling) add(`provider:${id}`, 'info', `${id} is cooling down after a limit (${Math.ceil(cooling / 60_000)} min left)`);
  }
  if (usable.length) add('providers', 'ok', `Triage can use: ${usable.join(', ')}`);
  else add('providers', 'warn', 'No AI provider is available for triage (sign in to Claude Code or set ANTHROPIC_API_KEY or GEMINI_API_KEY). The offline rules engine will be used.');

  return checks;
}

export function runDoctor(targetDirArg?: string, options: DoctorOptions = {}): DoctorReport {
  const root = resolveProjectRoot(targetDirArg);
  const fixed: string[] = [];

  if (options.fix) {
    const before = collectChecks(root, options).filter((c) => c.fixable);
    if (before.length) {
      const result = applySetup(root, options);
      for (const change of result.changes) if (change.action === 'created' || change.action === 'updated') fixed.push(change.path);
    }
  }

  const checks = collectChecks(root, options);
  const report: DoctorReport = { ok: !checks.some((c) => c.status === 'fail'), root, fixed, checks };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(pc.bold(pc.cyan('\nnativ doctor')) + pc.dim(`  ${root}`));
    const paint: Record<CheckStatus, (s: string) => string> = { ok: pc.green, warn: pc.yellow, fail: pc.red, info: pc.dim };
    const mark: Record<CheckStatus, string> = { ok: '✔', warn: '⚠', fail: '✖', info: '·' };
    for (const c of checks) console.log(paint[c.status](`  ${mark[c.status]} ${c.message}`) + (c.fixable && !options.fix ? pc.dim('  (fixable)') : ''));
    if (fixed.length) console.log(pc.green(`\n✔ Repaired: ${fixed.join(', ')}`));
    const fixable = checks.filter((c) => c.fixable).length;
    console.log(
      report.ok
        ? pc.green(`\n✔ Healthy${checks.some((c) => c.status === 'warn') ? ' (with warnings)' : ''}.\n`)
        : pc.red(`\n✖ Problems found.${fixable ? ' Run `nativ doctor --fix` to repair what can be repaired.' : ''}\n`),
    );
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}
