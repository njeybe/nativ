import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { detectProject } from '../scanner/detector.js';
import { runValidate } from './validate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getTemplatesDir(): string {
  const candidate = path.resolve(__dirname, '../../templates');
  if (fs.existsSync(candidate)) return candidate;
  return path.resolve(__dirname, '../templates');
}

export async function runUpdate(targetDirArg?: string) {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const templatesDir = getTemplatesDir();
  const aiDir = path.join(targetDir, '.ai');

  console.log(pc.bold(pc.cyan(`\n🔄 AgentJ: Synchronizing Framework & Directives in: ${targetDir}\n`)));

  if (!fs.existsSync(aiDir)) {
    console.error(pc.red(`✖ No .ai/ directory found in: ${targetDir}`));
    console.log(pc.yellow('Run `agentj init` first to scaffold the initial environment.\n'));
    process.exitCode = 1;
    return;
  }

  const projectInfo = detectProject(targetDir);
  const timestamp = new Date().toISOString();

  // 1. Update CLAUDE.md directive
  const claudeSrc = path.join(templatesDir, 'CLAUDE.md');
  const claudeDest = path.join(targetDir, 'CLAUDE.md');
  if (fs.existsSync(claudeSrc)) {
    fs.copyFileSync(claudeSrc, claudeDest);
    console.log(pc.green('✔ Updated CLAUDE.md (Project Manager Directive)'));
  }

  // 2. Update GEMINI.md directive
  const geminiSrc = path.join(templatesDir, 'GEMINI.md');
  const geminiDest = path.join(targetDir, 'GEMINI.md');
  if (fs.existsSync(geminiSrc)) {
    fs.copyFileSync(geminiSrc, geminiDest);
    console.log(pc.green('✔ Updated GEMINI.md (Antigravity Mission Control Directive)'));
  }

  // 3. Update Sub-agent specifications
  const subagentsDir = path.join(aiDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });

  const templatesSubagentDir = path.join(templatesDir, 'dot-ai/subagents');
  if (fs.existsSync(templatesSubagentDir)) {
    const files = fs.readdirSync(templatesSubagentDir);
    for (const file of files) {
      const src = path.join(templatesSubagentDir, file);
      const dest = path.join(subagentsDir, file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, dest);
        console.log(pc.green(`✔ Updated .ai/subagents/${file}`));
      }
    }
  }

  // 4. Backfill missing core contracts safely (NEVER overwrite existing project state)
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

  console.log(pc.bold(pc.green('\n✨ Framework sync complete! Verifying updated project...\n')));
  await runValidate(targetDir);
}
