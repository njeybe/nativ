import path from 'node:path';
import pc from 'picocolors';
import { verifyBatch, BatchVerificationResult } from '../core/verifier.js';

export interface VerifyOptions {
  all?: boolean;
  milestone?: string;
  json?: boolean;
  timeout?: number;
}

export async function runVerify(
  taskId?: string,
  targetDirArg?: string,
  options: VerifyOptions = {}
): Promise<BatchVerificationResult> {
  const targetDir = path.resolve(targetDirArg || process.cwd());
  const batch = await verifyBatch(targetDir, {
    taskId,
    milestoneId: options.milestone,
    all: options.all,
    timeout: options.timeout,
  });

  if (options.json) {
    console.log(JSON.stringify(batch, null, 2));
    if (batch.failed > 0) {
      process.exitCode = 1;
    }
    return batch;
  }

  console.log(pc.bold(pc.cyan(`\nVerification Gatekeeper: ${batch.projectName}`)));
  console.log(pc.dim(`Workspace: ${targetDir}\n`));

  if (batch.total === 0) {
    console.log(pc.yellow('No candidate tasks found to verify. Specify a taskId, --milestone, or --all.\n'));
    return batch;
  }

  for (const t of batch.tasks) {
    const elapsed = (t.result.durationMs / 1000).toFixed(2);

    if (t.result.skipped) {
      console.log(pc.dim(`  ○ [${t.taskId}] ${t.title} — no verification command (skipped)`));
      continue;
    }

    if (t.result.success) {
      console.log(
        pc.green(`  ✔ [${pc.bold(t.taskId)}] ${t.title}`) +
          pc.dim(` (${elapsed}s)`) +
          pc.yellow(` \`${t.result.command}\``)
      );
      if (t.result.phases?.length) {
        console.log(pc.dim(`    Phases passed: ${t.result.phases.map((p) => p.name).join(', ')}`));
      }
    } else {
      console.log(
        pc.red(`  ✖ [${pc.bold(t.taskId)}] ${t.title}`) +
          pc.dim(` (${elapsed}s, exit code: ${t.result.exitCode})`) +
          pc.yellow(` \`${t.result.command}\``)
      );
      const failedPhase = t.result.phases?.find((p) => !p.success);
      if (failedPhase) console.log(pc.red(`    Failed in phase "${failedPhase.name}"`));

      if (t.result.stderr && t.result.stderr.trim()) {
        console.log(pc.red(`\n--- [${t.taskId}] stderr ---`));
        console.log(pc.red(t.result.stderr.trim()));
      }
      if (t.result.stdout && t.result.stdout.trim() && !t.result.stderr?.trim()) {
        console.log(pc.dim(`\n--- [${t.taskId}] stdout ---`));
        console.log(pc.dim(t.result.stdout.trim()));
      }
      if (t.result.error && !t.result.stderr?.includes(t.result.error)) {
        console.log(pc.red(`\nError: ${t.result.error}`));
      }
      console.log('');
    }
  }

  const totalTime = (batch.durationMs / 1000).toFixed(2);
  console.log(pc.dim('\n────────────────────────────────────────────────────────────────'));

  const summary = `Tasks: ${batch.total} | Passed: ${batch.passed} | Failed: ${batch.failed} | Skipped: ${batch.skipped} (${totalTime}s)`;

  if (batch.failed > 0) {
    console.log(pc.bold(pc.red(`✖ Verification FAILED: ${summary}\n`)));
    process.exitCode = 1;
  } else {
    console.log(pc.bold(pc.green(`✔ Verification PASSED: ${summary}\n`)));
  }

  return batch;
}
