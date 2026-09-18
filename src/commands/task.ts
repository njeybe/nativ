import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import {
  MasterPlan,
  MasterPlanTask,
  SubagentType,
  EscalationFile,
  EscalationRecord,
  EscalationType,
} from '../scanner/types.js';
import { executeVerification } from '../core/verifier.js';

function getPlanPath(targetDirArg?: string): { targetDir: string; planPath: string } {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const planPath = path.join(targetDir, '.ai', 'master_plan.json');
  return { targetDir, planPath };
}

function loadPlan(planPath: string): MasterPlan | null {
  if (!fs.existsSync(planPath)) {
    console.error(pc.red(`\n✖ No .ai/master_plan.json found at: ${planPath}`));
    console.log(pc.yellow('Run `nativ init` first to scaffold the workflow.\n'));
    return null;
  }

  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    return JSON.parse(raw) as MasterPlan;
  } catch (err: any) {
    console.error(pc.red(`\n✖ Failed to parse .ai/master_plan.json: ${err.message}\n`));
    return null;
  }
}

function savePlan(planPath: string, plan: MasterPlan): boolean {
  try {
    plan.lastUpdated = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');
    return true;
  } catch (err: any) {
    console.error(pc.red(`\n✖ Failed to save .ai/master_plan.json: ${err.message}\n`));
    return false;
  }
}

export function getRoleGuide(assignedSubagent: SubagentType): string {
  const normalized = assignedSubagent
    .replace(/-agent$/, '')
    .replace(/^qa$/, 'qa-tester');

  const fileMap: Record<string, string> = {
    backend: 'backend.md',
    frontend: 'frontend.md',
    database: 'database.md',
    'qa-tester': 'qa-tester.md',
    'flutter-developer': 'flutter-developer.md',
    'devops-agent': 'devops-agent.md',
    'security-auditor': 'security-auditor.md',
    'db-migration': 'db-migration.md',
  };

  const filename = fileMap[assignedSubagent] || fileMap[normalized] || `${normalized}.md`;
  return `.ai/subagents/${filename}`;
}

export function getRecommendedContractSlice(assignedSubagent: SubagentType): string {
  const sub = assignedSubagent.toLowerCase();
  if (sub.includes('frontend') || sub.includes('flutter')) {
    return '.ai/ui_specs.md (UI tokens & hierarchy) + .ai/api_contracts.json (Client endpoint integration)';
  }
  if (sub.includes('backend')) {
    return '.ai/api_contracts.json (Endpoint routes, request/response schemas) + .ai/db_schema.json (Models)';
  }
  if (sub.includes('database') || sub.includes('db-migration')) {
    return '.ai/db_schema.json (Database schema contract & models)';
  }
  if (sub.includes('devops')) {
    return '.ai/context.md (Infrastructure, runtime & deployment guardrails)';
  }
  if (sub.includes('security')) {
    return 'Target files & dependency manifests (.ai/context.md security guardrails)';
  }
  if (sub.includes('qa')) {
    return 'Target files, .ai/api_contracts.json, and verification test suite';
  }
  return '.ai/context.md';
}

export async function runTaskList(
  targetDirArg?: string,
  options: {
    available?: boolean;
    status?: string;
    milestone?: string;
    json?: boolean;
  } = {}
) {
  const { planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  const completedTaskIds = new Set<string>();
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      if (t.status === 'completed') {
        completedTaskIds.add(t.id);
      }
    }
  }

  const results: Array<{
    task: MasterPlanTask;
    milestoneId: string;
    milestoneName: string;
    isAvailable: boolean;
  }> = [];

  for (const m of plan.milestones) {
    if (options.milestone && m.id !== options.milestone && !m.name.toLowerCase().includes(options.milestone.toLowerCase())) {
      continue;
    }

    for (const t of m.tasks) {
      const deps = t.dependencies || [];
      const depsSatisfied = deps.every((d) => completedTaskIds.has(d));
      const isAvailable = (t.status === 'pending' || t.status === 'in_progress') && depsSatisfied;

      if (options.available && !isAvailable) {
        continue;
      }
      if (options.status && t.status !== options.status) {
        continue;
      }

      results.push({
        task: t,
        milestoneId: m.id,
        milestoneName: m.name,
        isAvailable,
      });
    }
  }

  if (options.json) {
    const jsonOutput = results.map(({ task, milestoneId, milestoneName, isAvailable }) => ({
      ...task,
      milestoneId,
      milestoneName,
      isAvailable,
      roleGuide: getRoleGuide(task.assignedSubagent),
      contractSlice: getRecommendedContractSlice(task.assignedSubagent),
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  console.log(pc.bold(pc.cyan(`\n📋 AgentJ Tasks: ${plan.projectName}`)));
  console.log(pc.dim(`Overall Status: ${plan.overallStatus.toUpperCase()} | Active Milestone: ${plan.activeMilestoneId}\n`));

  if (results.length === 0) {
    console.log(pc.yellow('  No tasks match the specified filters.\n'));
    return;
  }

  const grouped = new Map<string, typeof results>();
  for (const item of results) {
    const key = `[${item.milestoneId}] ${item.milestoneName}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(item);
  }

  for (const [milestoneTitle, items] of grouped.entries()) {
    console.log(pc.bold(`🚩 Milestone ${milestoneTitle}`));
    for (const { task: t, isAvailable } of items) {
      let statusBadge = pc.gray('○ pending');
      if (t.status === 'completed') {
        statusBadge = pc.green('✔ completed');
      } else if (t.status === 'in_progress') {
        statusBadge = pc.yellow('▶ in_progress');
      } else if (t.status === 'blocked') {
        statusBadge = pc.red('✖ blocked');
      }

      const readyBadge = isAvailable && t.status === 'pending' ? pc.bgGreen(pc.black(' READY ')) + ' ' : '';
      console.log(`  ${statusBadge} ${readyBadge}${pc.bold(t.id)}: ${t.title}`);
      const depText = t.dependencies && t.dependencies.length > 0 ? pc.dim(`deps: ${t.dependencies.join(', ')}`) : pc.dim('no deps');
      const filesText = t.targetFiles && t.targetFiles.length > 0 ? pc.cyan(t.targetFiles.join(', ')) : pc.dim('none');
      console.log(pc.dim(`    Agent: `) + pc.magenta(`[${t.assignedSubagent}]`) + pc.dim(` | ${depText} | Files: ${filesText}`));
      if (t.notes) {
        console.log(pc.dim(`    Note: `) + (t.status === 'blocked' ? pc.red(t.notes) : pc.dim(t.notes)));
      }
    }
    console.log();
  }

  const completedCount = results.filter((r) => r.task.status === 'completed').length;
  const inProgressCount = results.filter((r) => r.task.status === 'in_progress').length;
  const pendingCount = results.filter((r) => r.task.status === 'pending').length;
  const blockedCount = results.filter((r) => r.task.status === 'blocked').length;

  console.log(pc.dim(`Showing ${results.length} tasks: `) +
    pc.green(`${completedCount} completed`) + pc.dim(', ') +
    pc.yellow(`${inProgressCount} in progress`) + pc.dim(', ') +
    pc.gray(`${pendingCount} pending`) + pc.dim(', ') +
    pc.red(`${blockedCount} blocked`) + '\n');
}

export async function runTaskNext(targetDirArg?: string, options: { json?: boolean } = {}) {
  const { planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  // Completed task lookup for dependency check
  const completedTaskIds = new Set<string>();
  for (const m of plan.milestones) {
    for (const t of m.tasks) {
      if (t.status === 'completed') {
        completedTaskIds.add(t.id);
      }
    }
  }

  let activeMilestone = plan.milestones.find((m) => m.id === plan.activeMilestoneId);
  if (!activeMilestone || activeMilestone.status === 'completed') {
    activeMilestone = plan.milestones.find((m) => m.status !== 'completed');
    if (activeMilestone) {
      plan.activeMilestoneId = activeMilestone.id;
      savePlan(planPath, plan);
    }
  }

  if (!activeMilestone) {
    if (options.json) {
      console.log(JSON.stringify({ status: 'all_milestones_completed', activeTask: null }, null, 2));
    } else {
      console.log(pc.bold(pc.green('\n🎉 All milestones and tasks are completed!\n')));
      console.log(pc.dim('Run `ai-agent-workflow status` to inspect final project statistics.\n'));
    }
    return;
  }

  // 1. Look for in_progress task first
  let targetTask = activeMilestone.tasks.find((t) => t.status === 'in_progress');

  // 2. If none in progress, find first pending task whose dependencies are satisfied
  if (!targetTask) {
    targetTask = activeMilestone.tasks.find((t) => {
      if (t.status !== 'pending') return false;
      const deps = t.dependencies || [];
      return deps.every((depId) => completedTaskIds.has(depId));
    });
  }

  // 3. If still none found, check if milestone has blocked tasks or waiting dependencies
  if (!targetTask) {
    const hasBlocked = activeMilestone.tasks.some((t) => t.status === 'blocked');
    if (options.json) {
      console.log(JSON.stringify({
        status: hasBlocked ? 'milestone_blocked' : 'waiting_dependencies',
        milestoneId: activeMilestone.id,
        milestoneName: activeMilestone.name,
        activeTask: null,
      }, null, 2));
    } else {
      if (hasBlocked) {
        console.log(pc.bold(pc.red(`\n✖ Milestone [${activeMilestone.id}] has blocked tasks.`)));
        console.log(pc.yellow('Run `ai-agent-workflow status` to review blockers.\n'));
      } else {
        console.log(pc.bold(pc.yellow(`\n⚠ Milestone [${activeMilestone.id}] has no immediately executable tasks due to unresolved dependencies.\n`)));
      }
    }
    return;
  }

  const roleGuide = getRoleGuide(targetTask.assignedSubagent);
  const contractSlice = getRecommendedContractSlice(targetTask.assignedSubagent);

  if (options.json) {
    console.log(JSON.stringify({
      status: 'ready',
      milestoneId: activeMilestone.id,
      milestoneName: activeMilestone.name,
      task: {
        ...targetTask,
        roleGuide,
        recommendedContractSlice: contractSlice,
      }
    }, null, 2));
    return;
  }

  console.log(pc.bold(pc.cyan(`\n⚡ Next Executable Task in [${activeMilestone.id} - ${activeMilestone.name}]:`)));
  console.log(pc.bold(`\n  Task ID:           `) + pc.yellow(targetTask.id));
  console.log(pc.bold(`  Title:             `) + pc.white(targetTask.title));
  console.log(pc.bold(`  Status:            `) + (targetTask.status === 'in_progress' ? pc.yellow('▶ in_progress') : pc.gray('○ pending')));
  console.log(pc.bold(`  Assigned Role:     `) + pc.magenta(`[${targetTask.assignedSubagent}]`) + pc.dim(` -> ${roleGuide}`));
  console.log(pc.bold(`  JIT Contract Slice:`) + pc.green(` ${contractSlice}`));
  console.log(pc.bold(`  Target Files:      `) + (targetTask.targetFiles.length > 0 ? pc.cyan(targetTask.targetFiles.join(', ')) : pc.dim('none specified')));
  console.log(pc.bold(`  Verification Cmd:  `) + pc.yellow(`\`${targetTask.verificationCommand || 'none'}\``));
  if (targetTask.dependencies && targetTask.dependencies.length > 0) {
    console.log(pc.bold(`  Dependencies:      `) + pc.dim(targetTask.dependencies.join(', ')));
  }
  if (targetTask.notes) {
    console.log(pc.bold(`  Notes:             `) + pc.red(targetTask.notes));
  }

  console.log(pc.dim('\n─── Quick CLI Actions ──────────────────────────────────────────'));
  console.log(pc.dim('  Start task:   ') + pc.white(`nativ task start ${targetTask.id}`));
  console.log(pc.dim('  Complete task:') + pc.white(`nativ task complete ${targetTask.id}`));
  console.log(pc.dim('  Block task:   ') + pc.white(`nativ task block ${targetTask.id} --reason "..."`));
  console.log(pc.dim('  Escalate task:') + pc.white(`nativ task escalate ${targetTask.id} --type schema_flaw --details "..."\n`));
}

export async function runTaskStart(taskId: string, targetDirArg?: string) {
  const { planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  let foundTask: MasterPlanTask | null = null;
  let foundMilestone: any = null;

  for (const m of plan.milestones) {
    const t = m.tasks.find((task) => task.id === taskId);
    if (t) {
      foundTask = t;
      foundMilestone = m;
      break;
    }
  }

  if (!foundTask) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }

  foundTask.status = 'in_progress';
  if (foundMilestone.status === 'pending') {
    foundMilestone.status = 'in_progress';
  }
  if (plan.overallStatus === 'pending') {
    plan.overallStatus = 'in_progress';
  }
  plan.activeMilestoneId = foundMilestone.id;

  savePlan(planPath, plan);
  console.log(pc.green(`\n✔ Task [${pc.bold(taskId)}] marked as `) + pc.yellow('▶ in_progress') + '\n');
}

export interface TaskCompleteOptions {
  notes?: string;
  skipVerify?: boolean;
  timeout?: number;
}

export async function runTaskComplete(
  taskId: string,
  targetDirArg?: string,
  options: TaskCompleteOptions = {}
) {
  const { targetDir, planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  let foundTask: MasterPlanTask | null = null;
  let foundMilestone: any = null;

  for (const m of plan.milestones) {
    const t = m.tasks.find((task) => task.id === taskId);
    if (t) {
      foundTask = t;
      foundMilestone = m;
      break;
    }
  }

  if (!foundTask) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }

  // ── Verification Gatekeeper ────────────────────────────────────────────────
  if (!options.skipVerify) {
    const vResult = await executeVerification(foundTask.verificationCommand, targetDir, options.timeout);
    if (!vResult.success) {
      console.error(pc.red(`\n✖ Task [${pc.bold(taskId)}] verification FAILED with exit code ${vResult.exitCode}:`));
      console.error(pc.yellow(`  Command: \`${foundTask.verificationCommand}\``));

      if (vResult.stderr && vResult.stderr.trim()) {
        console.error(pc.red('\n--- stderr ---'));
        console.error(pc.red(vResult.stderr.trim()));
      }
      if (vResult.stdout && vResult.stdout.trim() && !vResult.stderr?.trim()) {
        console.error(pc.dim('\n--- stdout ---'));
        console.error(pc.dim(vResult.stdout.trim()));
      }
      if (vResult.error && !vResult.stderr?.includes(vResult.error)) {
        console.error(pc.red(`\nError: ${vResult.error}`));
      }

      console.error(pc.yellow(`\n⚠ Task remains '${foundTask.status}'. Fix the issue and retry:`));
      console.error(pc.white(`  nativ task complete ${taskId}`));
      console.error(pc.dim('  (or pass --no-verify to bypass verification check)\n'));
      process.exitCode = 1;
      return;
    }

    if (vResult.skipped) {
      console.log(pc.dim(`\n○ Verification skipped: no verification command specified for [${taskId}]`));
    } else {
      const elapsed = (vResult.durationMs / 1000).toFixed(2);
      console.log(pc.green(`\n✔ Verification passed (${elapsed}s): `) + pc.yellow(`\`${foundTask.verificationCommand}\``));
    }
  } else {
    console.log(pc.yellow(`\n⚠ Verification skipped via --no-verify for [${taskId}]`));
  }

  foundTask.status = 'completed';
  if (options.notes) {
    foundTask.notes = options.notes;
  }

  // Check if milestone is completed
  const allMilestoneTasksDone = foundMilestone.tasks.every((t: MasterPlanTask) => t.status === 'completed');
  if (allMilestoneTasksDone) {
    foundMilestone.status = 'completed';
    console.log(pc.green(`\n🏁 Milestone [${pc.bold(foundMilestone.id)}] completed!`));

    // Find next milestone
    const nextMilestone = plan.milestones.find((m) => m.status !== 'completed');
    if (nextMilestone) {
      plan.activeMilestoneId = nextMilestone.id;
      console.log(pc.cyan(`▶ Active milestone advanced to: [${nextMilestone.id}] ${nextMilestone.name}`));
    } else {
      plan.overallStatus = 'completed';
      console.log(pc.bold(pc.green('🎉 All project milestones completed!')));
    }
  }

  savePlan(planPath, plan);
  console.log(pc.green(`\n✔ Task [${pc.bold(taskId)}] successfully marked as `) + pc.green('✔ completed') + '\n');
}

export async function runTaskBlock(taskId: string, reason: string, targetDirArg?: string) {
  if (!reason || reason.trim().length === 0) {
    console.error(pc.red('\n✖ A reason must be provided via `--reason <text>` when blocking a task.\n'));
    process.exitCode = 1;
    return;
  }

  const { planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  let foundTask: MasterPlanTask | null = null;

  for (const m of plan.milestones) {
    const t = m.tasks.find((task) => task.id === taskId);
    if (t) {
      foundTask = t;
      break;
    }
  }

  if (!foundTask) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }

  foundTask.status = 'blocked';
  foundTask.notes = reason.trim();

  savePlan(planPath, plan);
  console.log(pc.yellow(`\n⚠ Task [${pc.bold(taskId)}] marked as `) + pc.red('✖ blocked'));
  console.log(pc.dim(`  Reason: ${foundTask.notes}\n`));
}

export async function runTaskEscalate(
  taskId: string,
  targetDirArg?: string,
  options: {
    type?: string;
    details?: string;
    affected?: string;
  } = {}
) {
  const { targetDir, planPath } = getPlanPath(targetDirArg);
  const plan = loadPlan(planPath);
  if (!plan) {
    process.exitCode = 1;
    return;
  }

  let foundTask: MasterPlanTask | null = null;
  for (const m of plan.milestones) {
    const t = m.tasks.find((task) => task.id === taskId);
    if (t) {
      foundTask = t;
      break;
    }
  }

  if (!foundTask) {
    console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
    process.exitCode = 1;
    return;
  }

  const escalationPath = path.join(targetDir, '.ai', 'escalation.json');
  let escalationFile: EscalationFile;

  if (fs.existsSync(escalationPath)) {
    try {
      escalationFile = JSON.parse(fs.readFileSync(escalationPath, 'utf8'));
      if (!Array.isArray(escalationFile.escalations)) {
        escalationFile.escalations = [];
      }
    } catch {
      escalationFile = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        version: '1.0.0',
        projectName: plan.projectName,
        lastUpdated: new Date().toISOString(),
        escalations: [],
      };
    }
  } else {
    escalationFile = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      version: '1.0.0',
      projectName: plan.projectName,
      lastUpdated: new Date().toISOString(),
      escalations: [],
    };
  }

  const count = escalationFile.escalations.length + 1;
  const escId = `esc-${String(count).padStart(2, '0')}`;
  const validTypes: EscalationType[] = [
    'contract_drift',
    'schema_flaw',
    'missing_credential',
    'dependency_conflict',
    'architectural_ambiguity',
  ];
  const escType = (options.type && validTypes.includes(options.type as EscalationType))
    ? (options.type as EscalationType)
    : 'architectural_ambiguity';

  const affectedContracts = options.affected
    ? options.affected.split(',').map((s) => s.trim())
    : ['.ai/db_schema.json', '.ai/api_contracts.json'];

  const summary = options.details || `Task ${taskId} blocked by ${escType}`;

  const newRecord: EscalationRecord = {
    id: escId,
    taskId,
    type: escType,
    reportedBy: foundTask.assignedSubagent,
    timestamp: new Date().toISOString(),
    summary,
    details: options.details || '',
    affectedContracts,
    status: 'pending_review',
  };

  escalationFile.escalations.push(newRecord);
  escalationFile.lastUpdated = new Date().toISOString();

  fs.writeFileSync(escalationPath, JSON.stringify(escalationFile, null, 2) + '\n', 'utf8');

  foundTask.status = 'blocked';
  foundTask.notes = `Escalated [${escId}]: ${summary}`;
  savePlan(planPath, plan);

  console.log(pc.bold(pc.yellow(`\n🚨 Task [${pc.bold(taskId)}] Escalated to Tier 1 (Antigravity)!`)));
  console.log(pc.dim('  Escalation ID:      ') + pc.cyan(escId));
  console.log(pc.dim('  Type:               ') + pc.white(escType));
  console.log(pc.dim('  Reported By:        ') + pc.magenta(`[${foundTask.assignedSubagent}]`));
  console.log(pc.dim('  Affected Contracts: ') + pc.white(affectedContracts.join(', ')));
  console.log(pc.dim('  Details:            ') + pc.yellow(summary));
  console.log(pc.dim('\nNext Step for Macro-Architect:'));
  console.log(pc.white(`  Open Antigravity to review .ai/escalation.json, update the affected contracts, and unblock the task.\n`));
}
