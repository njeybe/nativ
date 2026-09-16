import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { detectProject } from '../scanner/detector.js';
import { buildContextContent } from '../scanner/context-builder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTemplatesDir(): string {
  // In dist/commands/init.js -> ../../templates
  const candidate = path.resolve(__dirname, '../../templates');
  if (fs.existsSync(candidate)) return candidate;
  // Fallback for direct development: src/../templates
  return path.resolve(__dirname, '../templates');
}

export async function runInit(targetDirArg?: string, options: { force?: boolean } = {}) {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const templatesDir = getTemplatesDir();

  console.log(pc.bold(pc.cyan('\n🚀 AI-Agent-Workflow: Initializing Multi-Tier Pipeline...')));
  console.log(pc.dim(`Target directory: ${targetDir}`));

  // 1. Run scanner
  console.log(pc.yellow('🔍 Scanning repository structure & tech stack...'));
  const projectInfo = detectProject(targetDir);

  console.log(pc.green(`✔ Identified: ${pc.bold(projectInfo.projectName)} (${projectInfo.projectType})`));
  console.log(pc.dim(`  Runtime: ${projectInfo.runtime} | Framework: ${projectInfo.framework} | ORM: ${projectInfo.databaseOrm}`));

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

  // 5. Write .ai/ui_specs.md
  const uiTemplate = fs.readFileSync(path.join(templatesDir, 'dot-ai/ui_specs.md'), 'utf8');
  const uiPath = path.join(aiDir, 'ui_specs.md');
  if (!fs.existsSync(uiPath) || options.force) {
    fs.writeFileSync(uiPath, uiTemplate, 'utf8');
    console.log(pc.green('✔ Created .ai/ui_specs.md'));
  }

  // 6. Write .ai/master_plan.json
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
  const subagentFiles = ['backend.md', 'frontend.md', 'database.md', 'qa-tester.md'];
  for (const file of subagentFiles) {
    const src = path.join(templatesDir, 'dot-ai/subagents', file);
    const dest = path.join(subagentsDir, file);
    if (fs.existsSync(src) && (!fs.existsSync(dest) || options.force)) {
      fs.copyFileSync(src, dest);
      console.log(pc.green(`✔ Created .ai/subagents/${file}`));
    }
  }

  // 8. Write root CLAUDE.md
  const claudeSrc = path.join(templatesDir, 'CLAUDE.md');
  const claudeDest = path.join(targetDir, 'CLAUDE.md');
  if (fs.existsSync(claudeSrc) && (!fs.existsSync(claudeDest) || options.force)) {
    fs.copyFileSync(claudeSrc, claudeDest);
    console.log(pc.green('✔ Created CLAUDE.md (Project Manager Directive)'));
  }

  // 9. Write root GEMINI.md
  const geminiSrc = path.join(templatesDir, 'GEMINI.md');
  const geminiDest = path.join(targetDir, 'GEMINI.md');
  if (fs.existsSync(geminiSrc) && (!fs.existsSync(geminiDest) || options.force)) {
    fs.copyFileSync(geminiSrc, geminiDest);
    console.log(pc.green('✔ Created GEMINI.md (Antigravity Mission Control Directive)'));
  }

  console.log(pc.bold(pc.cyan('\n✨ Pipeline Scaffolding Completed Successfully!\n')));
  console.log(pc.bold('Next Steps in the 3-Tier Workflow:'));
  console.log(pc.white(` 1. Open ${pc.magenta('Antigravity')} (Tier 1 Macro-Architect) to conduct feature intake & design checkpoints.`));
  console.log(pc.white(` 2. Antigravity finalizes ${pc.cyan('.ai/db_schema.json')}, ${pc.cyan('.ai/ui_specs.md')}, and ${pc.cyan('.ai/master_plan.json')}.`));
  console.log(pc.white(` 3. Run ${pc.green('claude')} in this directory to let the Middle-Tier PM autonomously execute tasks with sub-agents!\n`));
}
