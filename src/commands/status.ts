import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { MasterPlan } from '../scanner/types.js';

export async function runStatus(targetDirArg?: string) {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const planPath = path.join(targetDir, '.ai', 'master_plan.json');

  if (!fs.existsSync(planPath)) {
    console.error(pc.red(`\n✖ No .ai/master_plan.json found in: ${targetDir}`));
    console.log(pc.yellow('Run `nativ init` first to scaffold the environment.\n'));
    process.exitCode = 1;
    return;
  }

  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    const plan: MasterPlan = JSON.parse(raw);

    console.log(pc.bold(pc.cyan(`\n📊 AI Agent Workflow Status: ${plan.projectName}`)));
    console.log(pc.dim(`Overall Status: ${plan.overallStatus.toUpperCase()} | Active Milestone: ${plan.activeMilestoneId}`));

    let totalTasks = 0;
    let completedTasks = 0;
    let inProgressTasks = 0;
    let blockedTasks = 0;

    for (const m of plan.milestones) {
      console.log(pc.bold(`\n🚩 Milestone [${m.id}]: ${m.name} (${m.status})`));
      for (const t of m.tasks) {
        totalTasks++;
        let statusBadge = pc.gray('○ pending');
        if (t.status === 'completed') {
          completedTasks++;
          statusBadge = pc.green('✔ completed');
        } else if (t.status === 'in_progress') {
          inProgressTasks++;
          statusBadge = pc.yellow('▶ in_progress');
        } else if (t.status === 'blocked') {
          blockedTasks++;
          statusBadge = pc.red('✖ blocked');
        }

        console.log(`  ${statusBadge} ${pc.bold(t.id)}: ${t.title}`);
        console.log(pc.dim(`    Agent: [${t.assignedSubagent}] | Verify: \`${t.verificationCommand || 'none'}\``));
        if (t.notes) {
          console.log(pc.red(`    Note: ${t.notes}`));
        }
      }
    }

    const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    console.log(pc.bold(pc.cyan(`\n📈 Completion: ${completedTasks}/${totalTasks} tasks (${pct}%)\n`)));
  } catch (err: any) {
    console.error(pc.red(`✖ Failed to read or parse .ai/master_plan.json: ${err.message}`));
    process.exitCode = 1;
  }
}
