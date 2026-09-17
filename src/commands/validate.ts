import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

export async function runValidate(targetDirArg?: string) {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  console.log(pc.bold(pc.cyan(`\n🔍 Validating AI Agent Workflow Contracts in: ${targetDir}\n`)));

  let hasErrors = false;

  function checkFile(relPath: string, isJson = false) {
    const fullPath = path.join(targetDir, relPath);
    if (!fs.existsSync(fullPath)) {
      console.log(pc.red(`  ✖ Missing: ${relPath}`));
      hasErrors = true;
      return null;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.trim().length === 0) {
      console.log(pc.yellow(`  ⚠ Empty file: ${relPath}`));
      return null;
    }
    if (isJson) {
      try {
        const parsed = JSON.parse(content);
        console.log(pc.green(`  ✔ Valid JSON: ${relPath}`));
        return parsed;
      } catch (err: any) {
        console.log(pc.red(`  ✖ Malformed JSON in ${relPath}: ${err.message}`));
        hasErrors = true;
        return null;
      }
    }
    console.log(pc.green(`  ✔ Present: ${relPath}`));
    return content;
  }

  console.log(pc.bold('1. Directives:'));
  checkFile('CLAUDE.md');
  checkFile('GEMINI.md');

  console.log(pc.bold('\n2. Core Specification Contracts:'));
  checkFile('.ai/context.md');
  checkFile('.ai/db_schema.json', true);
  checkFile('.ai/api_contracts.json', true);
  checkFile('.ai/ui_specs.md');
  const plan = checkFile('.ai/master_plan.json', true);

  if (plan) {
    if (!Array.isArray(plan.milestones)) {
      console.log(pc.red('  ✖ .ai/master_plan.json missing `milestones` array'));
      hasErrors = true;
    }
  }

  const escalationPath = path.join(targetDir, '.ai/escalation.json');
  if (fs.existsSync(escalationPath)) {
    const escData = checkFile('.ai/escalation.json', true);
    if (escData && !Array.isArray(escData.escalations)) {
      console.log(pc.red('  ✖ .ai/escalation.json missing `escalations` array'));
      hasErrors = true;
    }
  }

  console.log(pc.bold('\n3. Sub-agent Profiles:'));
  console.log(pc.dim('  Core Units:'));
  checkFile('.ai/subagents/database.md');
  checkFile('.ai/subagents/backend.md');
  checkFile('.ai/subagents/frontend.md');
  checkFile('.ai/subagents/qa-tester.md');

  console.log(pc.dim('  Specialized Units:'));
  const specializedProfiles = [
    'flutter-developer.md',
    'devops-agent.md',
    'security-auditor.md',
    'db-migration.md',
  ];
  for (const profile of specializedProfiles) {
    const rel = `.ai/subagents/${profile}`;
    if (fs.existsSync(path.join(targetDir, rel))) {
      checkFile(rel);
    }
  }

  if (hasErrors) {
    console.log(pc.bold(pc.red('\n✖ Workflow contracts validation failed with errors.')));
    process.exitCode = 1;
  } else {
    console.log(pc.bold(pc.green('\n✔ All contracts and specifications are valid and orchestration-ready!\n')));
  }
}
