import { Command } from 'commander';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runValidate } from './commands/validate.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('ai-agent-workflow')
    .description('Multi-tier AI agent workflow harness connecting Antigravity, Claude Code, and autonomous sub-agents')
    .version('1.0.0');

  program
    .command('init [targetDir]')
    .description('Scaffold the multi-tier agent architecture (.ai/, CLAUDE.md, GEMINI.md) in the target directory')
    .option('-f, --force', 'Overwrite existing specification and directive files')
    .action(async (targetDir, options) => {
      await runInit(targetDir, options);
    });

  program
    .command('status [targetDir]')
    .description('Inspect current execution progress from .ai/master_plan.json')
    .action(async (targetDir) => {
      await runStatus(targetDir);
    });

  program
    .command('validate [targetDir]')
    .description('Verify integrity of all .ai contracts, schemas, and agent profiles')
    .action(async (targetDir) => {
      await runValidate(targetDir);
    });

  return program;
}

export async function run() {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
