import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pc from 'picocolors';
import { detectProject } from '../scanner/detector.js';
import { buildContextContent } from '../scanner/context-builder.js';
import { runSetup, printSetupResult } from './setup.js';
import { stampManaged } from '../core/setup-assets.js';
import { DESIGN_PROFILES } from '../core/design-rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTemplatesDir(): string {
  // In dist/commands/init.js -> ../../templates
  const candidate = path.resolve(__dirname, '../../templates');
  if (fs.existsSync(candidate)) return candidate;
  // Fallback for direct development: src/../templates
  return path.resolve(__dirname, '../templates');
}

// Sets the Profile line, and the Digest line for taste profiles, in the ui_specs template.
function applyDesignProfile(spec: string, profile: string): string {
  let out = spec.replace(/^(- \*\*Profile:\*\*).*$/m, `$1 ${profile}`);
  if (profile.startsWith('taste-')) {
    const digest = `.ai/design/taste/${profile.slice('taste-'.length)}/DIGEST.md`;
    out = out.replace(/^(- \*\*Digest:\*\*).*$/m, `$1 ${digest}`);
  }
  return out;
}

function listBundle(dir: string, base = dir, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listBundle(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function installTasteBundle(templatesDir: string, aiDir: string, force?: boolean) {
  const src = path.join(templatesDir, 'design', 'taste');
  const manifestPath = path.join(aiDir, 'design', 'taste', '.manifest.json');
  let manifest: Record<string, string> = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch { /* none yet */ }
  for (const rel of listBundle(src)) {
    const dest = path.join(aiDir, 'design', 'taste', rel);
    if (fs.existsSync(dest) && !force) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(src, rel), dest);
    const text = fs.readFileSync(dest, 'utf8').replace(/\r/g, '');
    manifest[rel.split(path.sep).join('/')] = createHash('sha256').update(text).digest('hex');
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(pc.green('✔ Installed design bundle .ai/design/taste/'));
}

export async function runInit(
  targetDirArg?: string,
  options: { force?: boolean; design?: string; gitVisibility?: 'hidden' | 'shared' } = {},
) {
  if (options.design !== undefined && !(DESIGN_PROFILES as readonly string[]).includes(options.design)) {
    const list = DESIGN_PROFILES.join(', ');
    console.error(pc.red(`✖ Unknown design profile "${options.design}". Use one of: ${list}`));
    process.exitCode = 1;
    return;
  }
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const templatesDir = getTemplatesDir();

  console.log(pc.bold(pc.cyan('\nNativ: Initializing Multi-Tier Pipeline...')));
  console.log(pc.dim(`Target directory: ${targetDir}`));

  // 1. Run scanner
  console.log(pc.yellow('Scanning repository structure & tech stack...'));
  const projectInfo = detectProject(targetDir);

  console.log(pc.green(`✔ Identified: ${pc.bold(projectInfo.projectName)} (${pc.cyan(projectInfo.repositoryType)})`));
  console.log(pc.dim('  ├─ Workspace Topology: ') + pc.white(projectInfo.repositoryType));
  if (projectInfo.monorepoWorkspaces.length > 0) {
    console.log(pc.dim('  │  └─ Workspaces: ') + pc.white(projectInfo.monorepoWorkspaces.join(', ')));
  }
  console.log(pc.dim('  ├─ Runtime & Language: ') + pc.white(projectInfo.runtime));
  console.log(pc.dim('  ├─ Framework: ') + pc.white(projectInfo.framework));
  const ormDisplay = projectInfo.detectedOrmConfig
    ? `${projectInfo.databaseOrm} (${projectInfo.detectedOrmConfig})`
    : projectInfo.databaseOrm;
  console.log(pc.dim('  ├─ Database & ORM: ') + pc.white(ormDisplay));
  if (projectInfo.ecosystemManifests.length > 0) {
    console.log(pc.dim('  ├─ Manifests Scanned: ') + pc.dim(projectInfo.ecosystemManifests.join(', ')));
  }
  console.log(pc.dim('  └─ Verification Gate: ') + pc.cyan(projectInfo.verificationCommand));
  console.log();

  // 2. Prepare directories
  const aiDir = path.join(targetDir, '.ai');
  const subagentsDir = path.join(aiDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const timestamp = new Date().toISOString();

  // 3. Write .ai/context.md
  const contextTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/context.md'), 'utf8');
  const contextContent = buildContextContent(contextTemplate, projectInfo);
  const contextPath = path.join(aiDir, 'context.md');
  if (!fs.existsSync(contextPath) || options.force) {
    fs.writeFileSync(contextPath, contextContent, 'utf8');
    console.log(pc.green('✔ Created .ai/context.md'));
  } else {
    console.log(pc.dim('- Skipped existing .ai/context.md'));
  }

  // 4. Write .ai/db_schema.json
  const dbTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/db_schema.json'), 'utf8');
  const dbContent = dbTemplate
    .replace(/\{\{PROJECT_NAME\}\}/g, projectInfo.projectName)
    .replace(/\{\{TIMESTAMP\}\}/g, timestamp)
    .replace(/\{\{DETECTED_DATABASE_ENGINE\}\}/g, projectInfo.databaseOrm !== 'None detected' ? projectInfo.databaseOrm : 'PostgreSQL');
  const dbPath = path.join(aiDir, 'db_schema.json');
  if (!fs.existsSync(dbPath) || options.force) {
    fs.writeFileSync(dbPath, dbContent, 'utf8');
    console.log(pc.green('✔ Created .ai/db_schema.json'));
  }

  // 5. Write .ai/api_contracts.json
  const apiTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/api_contracts.json'), 'utf8');
  const apiContent = apiTemplate
    .replace(/\{\{PROJECT_NAME\}\}/g, projectInfo.projectName)
    .replace(/\{\{TIMESTAMP\}\}/g, timestamp);
  const apiPath = path.join(aiDir, 'api_contracts.json');
  if (!fs.existsSync(apiPath) || options.force) {
    fs.writeFileSync(apiPath, apiContent, 'utf8');
    console.log(pc.green('✔ Created .ai/api_contracts.json'));
  }

  // 6. Write .ai/ui_specs.md
  const uiTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/ui_specs.md'), 'utf8');
  const uiPath = path.join(aiDir, 'ui_specs.md');
  if (!fs.existsSync(uiPath) || options.force) {
    const uiContent = options.design ? applyDesignProfile(uiTemplate, options.design) : uiTemplate;
    fs.writeFileSync(uiPath, uiContent, 'utf8');
    console.log(pc.green('✔ Created .ai/ui_specs.md'));
  }
  installTasteBundle(templatesDir, aiDir, options.force);

  // 7. Write .ai/master_plan.json
  const planTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/master_plan.json'), 'utf8');
  const planContent = planTemplate
    .replace(/\{\{PROJECT_NAME\}\}/g, projectInfo.projectName)
    .replace(/\{\{TIMESTAMP\}\}/g, timestamp)
    .replace(/\{\{VERIFICATION_COMMAND\}\}/g, projectInfo.verificationCommand);
  const planPath = path.join(aiDir, 'master_plan.json');
  if (!fs.existsSync(planPath) || options.force) {
    fs.writeFileSync(planPath, planContent, 'utf8');
    console.log(pc.green('✔ Created .ai/master_plan.json'));
  }

  // 7. Write Sub-agent specifications
  const guidesDir = path.join(templatesDir, 'dot-ai/subagents');
  const subagentFiles = fs.existsSync(guidesDir) ? fs.readdirSync(guidesDir).filter((f) => f.endsWith('.md')).sort() : [];
  for (const file of subagentFiles) {
    const src = path.join(templatesDir, 'dot-ai/subagents', file);
    const dest = path.join(subagentsDir, file);
    if (fs.existsSync(src) && (!fs.existsSync(dest) || options.force)) {
      // Stamped so a later `nativ update` can tell an untouched guide from one a person edited.
      fs.writeFileSync(dest, stampManaged(fs.readFileSync(src, 'utf8')), 'utf8');
      console.log(pc.green(`✔ Created .ai/subagents/${file}`));
    }
  }

  // 8. Write root CLAUDE.md
  const claudeSrc = path.join(templatesDir, 'CLAUDE.md');
  const claudeDest = path.join(targetDir, 'CLAUDE.md');
  if (fs.existsSync(claudeSrc) && (!fs.existsSync(claudeDest) || options.force)) {
    fs.writeFileSync(claudeDest, stampManaged(fs.readFileSync(claudeSrc, 'utf8')), 'utf8');
    console.log(pc.green('✔ Created CLAUDE.md (Project Manager Directive)'));
  }

  // 9. Write root GEMINI.md
  const geminiSrc = path.join(templatesDir, 'GEMINI.md');
  const geminiDest = path.join(targetDir, 'GEMINI.md');
  if (fs.existsSync(geminiSrc) && (!fs.existsSync(geminiDest) || options.force)) {
    fs.writeFileSync(geminiDest, stampManaged(fs.readFileSync(geminiSrc, 'utf8')), 'utf8');
    console.log(pc.green('✔ Created GEMINI.md (optional Gemini/Antigravity architect adapter)'));
  }

  // 10. Claude Code configuration: MCP server, hooks, permissions, agents, AGENTS.md. Merges; never overwrites.
  console.log(pc.yellow('Configuring Claude Code (MCP server, hooks, agents)...'));
  const setup = await runSetup(targetDir, { quiet: true, gitVisibility: options.gitVisibility });
  if (setup) {
    printSetupResult(setup);
  }

  console.log(pc.bold(pc.cyan('\n✨ Pipeline Scaffolding Completed Successfully!\n')));
  console.log(pc.bold('Next Steps:'));
  console.log(pc.white(` 1. Run ${pc.green('claude')} in this directory and ask the ${pc.magenta('architect')} agent to design your contracts (database, API, UI). You approve each step.`));
  console.log(pc.white(` 2. The architect writes ${pc.cyan('.ai/db_schema.json')}, ${pc.cyan('.ai/api_contracts.json')}, ${pc.cyan('.ai/ui_specs.md')}, and ${pc.cyan('.ai/master_plan.json')}.`));
  console.log(pc.white(` 3. Ask Claude to run ${pc.green('nativ task next')} and delegate each task to a ${pc.magenta('worker')} agent; use ${pc.magenta('verifier')} for an independent check.`));
  console.log(pc.white(` On existing code, ask for the ${pc.magenta('explorer')} agent first: it maps the code for the architect.`));
  console.log(pc.dim(` Run ${pc.white('nativ doctor')} any time, and after updating Claude Code, to confirm the integration is intact.\n`));
}
