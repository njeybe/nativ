import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { listProjectEnvNames } from '../core/env-reads.js';
import { checkDocText, type CommandSpec } from '../core/checks/docs-check.js';

function specOf(cmd: Command): CommandSpec {
  const flags = cmd.options.flatMap((o) => [o.long, o.short].filter((f): f is string => !!f));
  const subs: Record<string, CommandSpec> = {};
  for (const sub of cmd.commands) subs[sub.name()] = specOf(sub);
  return { flags, subs };
}

export async function runCheckDocs(files: string[], options: { json?: boolean }): Promise<void> {
  const root = resolveProjectRoot(process.cwd());
  const { createProgram } = await import('../index.js');
  const ctx = { root, envNames: new Set(listProjectEnvNames(root)), program: specOf(createProgram()) };
  const findings = [];
  for (const f of files) {
    const full = path.resolve(process.cwd(), f);
    if (!fs.existsSync(full)) {
      console.error(`Cannot read ${f}`);
      process.exitCode = 1;
      return;
    }
    findings.push(...checkDocText(fs.readFileSync(full, 'utf8'), path.relative(root, full), ctx));
  }
  if (options.json) console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
  else if (findings.length === 0) console.log('Docs check: no problems found.');
  else for (const x of findings) console.log(`${x.file}:${x.line}  ${x.kind}  ${x.message}`);
  if (findings.length > 0) process.exitCode = 1;
}
