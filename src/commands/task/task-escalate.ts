import path from 'node:path';
import pc from 'picocolors';
import {
  EscalationRecord,
  EscalationType,
  MasterPlanTask,
} from '../../scanner/types.js';
import {
  ContractGovernor,
  ContractPatch,
  appendEscalation,
} from '../../governor/index.js';
import { withPlanLock } from '../../core/lock-manager.js';
import { getPlanPath, ProposePatchOptions } from './task-common.js';

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
  return withPlanLock(planPath, (plan, ctx) => {
    let foundTask: MasterPlanTask | null = null;
    for (const m of plan.milestones) {
      const t = m.tasks.find((task) => task.id === taskId);
      if (t) {
        foundTask = t;
        break;
      }
    }

    if (!foundTask) {
      ctx.abort();
      console.error(pc.red(`\n✖ Task [${taskId}] not found in .ai/master_plan.json\n`));
      process.exitCode = 1;
      return;
    }

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

    const reportedBy = foundTask.assignedSubagent;
    // Locked append: the id is numbered under the escalation file lock, so concurrent
    // escalations (and circuit-breaker trips) never collide or overwrite each other.
    const escId = appendEscalation(
      targetDir,
      (id): EscalationRecord => ({
        id,
        taskId,
        type: escType,
        reportedBy,
        timestamp: new Date().toISOString(),
        summary,
        details: options.details || '',
        affectedContracts,
        status: 'pending_review',
      }),
      { style: 'sequential', position: 'last', projectName: plan.projectName },
    );

    foundTask.status = 'blocked';
    foundTask.notes = `Escalated [${escId}]: ${summary}`;

    console.log(pc.bold(pc.yellow(`\n🚨 Task [${pc.bold(taskId)}] Escalated to the Architect!`)));
    console.log(pc.dim('  Escalation ID:      ') + pc.cyan(escId));
    console.log(pc.dim('  Type:               ') + pc.white(escType));
    console.log(pc.dim('  Reported By:        ') + pc.magenta(`[${foundTask.assignedSubagent}]`));
    console.log(pc.dim('  Affected Contracts: ') + pc.white(affectedContracts.join(', ')));
    console.log(pc.dim('  Details:            ') + pc.yellow(summary));
    console.log(pc.dim('\nNext Step for the Architect:'));
    console.log(pc.white(`  Ask the architect agent (Claude Code, or Antigravity if that is your host) to review .ai/escalation.json, update the affected contracts, and unblock the task. \`nativ triage\` can assess it first.\n`));
  });
}

export async function runTaskProposePatch(targetDirArg: string | undefined, options: ProposePatchOptions) {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  let parsedValue = options.value;
  if (typeof options.value === 'string') {
    try {
      parsedValue = JSON.parse(options.value);
    } catch {
      parsedValue = options.value;
    }
  }

  const patch: ContractPatch = {
    taskId: options.taskId,
    target: options.target,
    operation: options.operation,
    path: options.path,
    value: parsedValue,
    reason: options.reason || 'No reason provided',
    baseHash: options.baseHash,
  };

  const verdict = ContractGovernor.evaluate(targetDir, patch);

  if (options.json) {
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.approved) {
      process.exitCode = 1;
    }
    return verdict;
  }

  if (verdict.approved) {
    console.log(pc.green(`\n✔ [GOVERNOR APPROVED] Blast Radius: `) + pc.cyan(verdict.blastRadius));
    console.log(pc.dim('  Rule:    ') + pc.yellow(verdict.ruleId));
    console.log(pc.dim('  Message: ') + verdict.message);
    if (verdict.patchApplied) {
      console.log(pc.green(`  Patch automatically merged into .ai/${options.target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json'}`));
      console.log(pc.dim(`  Audit log updated at .ai/audit_log.jsonl\n`));
    }
  } else {
    console.error(pc.red(`\n✖ [GOVERNOR REJECTED] Blast Radius: `) + pc.red(verdict.blastRadius));
    console.error(pc.yellow(`  Rule:    ${verdict.ruleId}`));
    console.error(pc.red(`  Message: ${verdict.message}`));
    if (verdict.violations.length > 0) {
      console.error(pc.dim('  Violations:'));
      verdict.violations.forEach((v) => console.error(pc.red(`    • ${v}`)));
    }
    console.error(pc.yellow(`  Circuit Breaker: ${verdict.circuitBreaker.consecutiveFailures}/${verdict.circuitBreaker.maxThreshold} failures`));
    if (verdict.circuitBreaker.tripped) {
      console.error(pc.bold(pc.red(`  🛑 CIRCUIT BREAKER TRIPPED: Task locked to blocked.`)));
      console.error(pc.magenta(`  Escalation record written to .ai/escalation.json (${verdict.diagnosticBundle?.escalationId})\n`));
    } else {
      console.error(pc.dim('  Fix the issue or formulate a backward-compatible proposal.\n'));
    }
    process.exitCode = 1;
  }
  return verdict;
}
