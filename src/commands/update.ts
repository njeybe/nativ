import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { detectProject } from '../scanner/detector.js';
import { applySetup, getTemplatesDir, planTemplateFile, type AssetChange } from '../core/setup-assets.js';
import { printSetupResult } from './setup.js';
import { runValidate } from './validate.js';

export interface UpdateOptions {
  /** Also replace directive and role-guide files that were edited by hand. */
  force?: boolean;
}

const ICON: Record<string, string> = { created: '+', updated: '~', unchanged: '=', skipped: '!' };

function printChange(change: AssetChange): void {
  const paint = change.action === 'created' ? pc.green : change.action === 'updated' ? pc.cyan : change.action === 'skipped' ? pc.yellow : pc.dim;
  const verb = change.action === 'skipped' ? 'kept' : change.action;
  console.log(paint(`  ${ICON[change.action]} ${change.path}`) + pc.dim(`  ${verb}${change.detail ? `: ${change.detail}` : ''}`));
}

/**
 * `nativ update`: brings a project up to the current templates without destroying its own work.
 *
 * - Directives (CLAUDE.md, GEMINI.md) and role guides (.ai/subagents/) are refreshed only when nativ wrote them
 *   and nobody edited them; anything edited is kept and reported. `--force` replaces those too.
 * - AGENTS.md, .claude/agents/, settings and the MCP entry follow the same merge rules as `nativ setup`,
 *   keeping the command already configured.
 * - Contracts, the plan and the project context are never touched. Missing contracts are backfilled.
 */
export async function runUpdate(targetDirArg?: string, options: UpdateOptions = {}) {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const templatesDir = getTemplatesDir();
  const aiDir = path.join(targetDir, '.ai');

  console.log(pc.bold(pc.cyan(`\nnativ update: synchronizing directives and agents in ${targetDir}\n`)));

  if (!fs.existsSync(aiDir)) {
    console.error(pc.red(`✖ No .ai/ directory found in: ${targetDir}`));
    console.log(pc.yellow('Run `nativ init` first to scaffold the initial environment.\n'));
    process.exitCode = 1;
    return;
  }

  const projectInfo = detectProject(targetDir);
  const timestamp = new Date().toISOString();

  // 1. Directives and role guides: refresh what nativ wrote, keep what a person edited
  const derived: Array<{ rel: string; template: string; dest: string; key: string }> = [
    { rel: 'CLAUDE.md', template: path.join(templatesDir, 'CLAUDE.md'), dest: path.join(targetDir, 'CLAUDE.md'), key: 'CLAUDE.md' },
    { rel: 'GEMINI.md', template: path.join(templatesDir, 'GEMINI.md'), dest: path.join(targetDir, 'GEMINI.md'), key: 'GEMINI.md' },
  ];
  const templatesSubagentDir = path.join(templatesDir, 'dot-ai', 'subagents');
  if (fs.existsSync(templatesSubagentDir)) {
    for (const file of fs.readdirSync(templatesSubagentDir).sort()) {
      const src = path.join(templatesSubagentDir, file);
      if (fs.statSync(src).isFile()) {
        derived.push({ rel: `.ai/subagents/${file}`, template: src, dest: path.join(aiDir, 'subagents', file), key: `subagents/${file}` });
      }
    }
  }

  console.log(pc.bold('Directives and role guides'));
  let kept = 0;
  for (const item of derived) {
    if (!fs.existsSync(item.template)) continue;
    const existing = fs.existsSync(item.dest) ? fs.readFileSync(item.dest, 'utf8') : null;
    const plan = planTemplateFile(existing, fs.readFileSync(item.template, 'utf8'), item.key, options.force === true);
    if (plan.content !== undefined) {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      fs.writeFileSync(item.dest, plan.content, 'utf8');
    }
    if (plan.action === 'skipped') kept++;
    printChange({ path: item.rel, action: plan.action, detail: plan.detail });
  }

  // 2. Everything `nativ setup` manages: AGENTS.md, .claude/agents/, settings, MCP server
  console.log(pc.bold('\nClaude Code configuration'));
  const setup = applySetup(targetDir, { force: options.force });
  printSetupResult(setup);

  // 3. Backfill missing core contracts safely (NEVER overwrite existing project state)
  console.log(pc.bold('\nContracts'));
  const apiContractsPath = path.join(aiDir, 'api_contracts.json');
  if (!fs.existsSync(apiContractsPath)) {
    const apiTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/api_contracts.json'), 'utf8');
    const apiContent = apiTemplate
      .replace(/\{\{PROJECT_NAME\}\}/g, projectInfo.projectName)
      .replace(/\{\{TIMESTAMP\}\}/g, timestamp);
    fs.writeFileSync(apiContractsPath, apiContent, 'utf8');
    console.log(pc.green('✔ Added missing contract: .ai/api_contracts.json'));
  } else {
    console.log(pc.dim('  • Preserved existing .ai/api_contracts.json'));
  }

  const dbPath = path.join(aiDir, 'db_schema.json');
  if (!fs.existsSync(dbPath)) {
    const dbTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/db_schema.json'), 'utf8');
    const dbContent = dbTemplate
      .replace(/\{\{PROJECT_NAME\}\}/g, projectInfo.projectName)
      .replace(/\{\{TIMESTAMP\}\}/g, timestamp)
      .replace(/\{\{DETECTED_DATABASE_ENGINE\}\}/g, projectInfo.databaseOrm !== 'None detected' ? projectInfo.databaseOrm : 'PostgreSQL');
    fs.writeFileSync(dbPath, dbContent, 'utf8');
    console.log(pc.green('✔ Added missing contract: .ai/db_schema.json'));
  } else {
    console.log(pc.dim('  • Preserved existing .ai/db_schema.json'));
  }

  const uiPath = path.join(aiDir, 'ui_specs.md');
  if (!fs.existsSync(uiPath)) {
    const uiTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/ui_specs.md'), 'utf8');
    fs.writeFileSync(uiPath, uiTemplate, 'utf8');
    console.log(pc.green('✔ Added missing spec: .ai/ui_specs.md'));
  } else {
    console.log(pc.dim('  • Preserved existing .ai/ui_specs.md'));
  }

  console.log(pc.dim('  • Preserved existing .ai/master_plan.json (active milestones intact)'));
  console.log(pc.dim('  • Preserved existing .ai/context.md (project context intact)'));

  if (kept > 0) {
    console.log(pc.yellow(`\n! ${kept} file(s) were kept because they were edited by hand. Compare them with the templates in the nativ package, or run \`nativ update --force\` to replace them.`));
  }
  console.log(pc.bold(pc.green('\n✨ Framework sync complete! Verifying updated project...\n')));
  await runValidate(targetDir);
}
