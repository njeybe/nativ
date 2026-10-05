import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { loadEscalationFile } from '../governor/store.js';
import {
  Tier1Liaison,
  type RiskThreshold,
  type Tier1LiaisonOptions,
  type TriageEvaluation,
  type TriageFailure,
} from '../core/tier1-liaison.js';
import {
  ESCALATION_ID,
  finalizeTriage,
  recordHumanDecision,
  triageBlocker,
  type HumanDecision,
  type TriagedEscalationRecord,
} from './triage/triage-store.js';
import {
  askChoice,
  askDecision,
  createLineReader,
  printEvaluation,
} from './triage/triage-ui.js';

export * from './triage/triage-store.js';

export interface RunTriageOptions {
  all?: boolean;
  apply?: boolean;
  threshold?: string;
  json?: boolean;
  /** Streams, prompt mode and the provider transport are injectable for tests. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  interactive?: boolean;
  liaison?: Tier1LiaisonOptions;
}

export interface TriageRunResult {
  escalationId: string;
  evaluation: TriageEvaluation | TriageFailure;
  unblockedTaskId: string | null;
  decision?: HumanDecision;
}

function pendingEscalations(root: string): TriagedEscalationRecord[] {
  return loadEscalationFile(root, path.basename(root))
    .escalations.filter((e) => e && typeof e.id === 'string' && e.status === 'pending_review') as TriagedEscalationRecord[];
}

export async function runTriage(
  escalationIdArg?: string,
  targetDirArg?: string,
  options: RunTriageOptions = {},
): Promise<TriageRunResult[]> {
  const output = options.output ?? process.stdout;
  const print = (line = '') => {
    output.write(`${line}\n`);
  };
  const fail = (message: string): TriageRunResult[] => {
    if (options.json) print(JSON.stringify({ ok: false, error: message }, null, 2));
    else print(pc.red(`\nTriage failed: ${message}\n`));
    process.exitCode = 1;
    return [];
  };

  // `nativ triage <dir>` reads naturally, so a lone directory argument is the target, not an id.
  let escalationId = escalationIdArg;
  let targetDir = targetDirArg;
  if (escalationId && !targetDir && !ESCALATION_ID.test(escalationId) && fs.existsSync(escalationId)) {
    targetDir = escalationId;
    escalationId = undefined;
  }
  const root = resolveProjectRoot(targetDir);

  const threshold = options.threshold;
  if (threshold !== undefined && threshold !== 'safe_contracts_only' && threshold !== 'all_non_destructive') {
    return fail("--threshold must be 'safe_contracts_only' or 'all_non_destructive'");
  }
  if (escalationId !== undefined && !ESCALATION_ID.test(escalationId)) {
    return fail(`"${escalationId}" is not an escalation id such as esc-01`);
  }

  const liaison = new Tier1Liaison(root, {
    ...options.liaison,
    config: {
      ...(options.apply !== undefined ? { autoTriageEnabled: Boolean(options.apply) } : {}),
      ...(threshold ? { riskThreshold: threshold as RiskThreshold } : {}),
    },
  });
  const interactive = !options.json && (options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const reader = interactive ? createLineReader(options.input ?? process.stdin, output) : null;

  try {
    const pending = pendingEscalations(root);
    let targets: string[];
    if (escalationId) {
      targets = [escalationId];
    } else if (options.all) {
      targets = pending.map((e) => e.id);
    } else if (!pending.length) {
      targets = [];
    } else if (reader) {
      print(pc.bold('\nPending escalations'));
      pending.forEach((e, i) => print(`  [${i + 1}] ${pc.cyan(e.id)}  ${pc.dim(e.type)}  ${e.taskId}  ${e.summary}`));
      const choice = await askChoice(reader, `\nChoose an escalation [1-${pending.length}] (Enter to cancel): `, pending.length, print);
      targets = choice === null ? [] : [pending[choice - 1].id];
      if (choice === null) print(pc.dim('No escalation selected.'));
    } else {
      return fail(`${pending.length} pending escalation(s): pass an escalation id or --all (${pending.map((e) => e.id).join(', ')})`);
    }

    if (!options.json && !liaison.hasApiKey()) {
      print(pc.dim('No AI provider is available (sign in to Claude Code, or set ANTHROPIC_API_KEY or GEMINI_API_KEY): using the offline rules engine.'));
    }
    if (!targets.length) {
      if (options.json) print(JSON.stringify({ ok: true, evaluations: [] }, null, 2));
      else if (!pending.length) print(pc.green('\nNo pending escalations. Nothing to triage.\n'));
      return [];
    }

    const results: TriageRunResult[] = [];
    for (const id of targets) {
      const blocker = triageBlocker(root, id);
      const evaluation: TriageEvaluation | TriageFailure = blocker ? { ok: false, escalationId: id, error: blocker } : await liaison.evaluate(id);
      if (!evaluation.ok) {
        results.push({ escalationId: id, evaluation, unblockedTaskId: null });
        process.exitCode = 1;
        if (!options.json) print(pc.red(`\n${id}: ${evaluation.error}`));
        continue;
      }
      const { taskId, unblockedTaskId } = await finalizeTriage(root, evaluation);
      const result: TriageRunResult = { escalationId: id, evaluation, unblockedTaskId };
      results.push(result);
      if (options.json) continue;

      printEvaluation(print, evaluation, taskId, unblockedTaskId);
      // Choices are only asked for one escalation at a time; --all is a report.
      if (reader && evaluation.humanCard && targets.length === 1) {
        const picked = await askDecision(reader, evaluation.humanCard, print);
        if (!picked) {
          print(pc.dim(`Decision deferred. ${id} stays pending.`));
        } else {
          const decision: HumanDecision = { ...picked, decidedAt: new Date().toISOString(), decidedVia: 'cli' };
          if (recordHumanDecision(root, id, decision)) {
            result.decision = decision;
            print(pc.green(`\nRecorded your choice on ${id}: ${decision.label}.`));
            print(pc.white(`Approve or reject it in Studio (Self-Healing tab) or with the architect agent to unblock ${taskId ?? 'the task'}.`));
          } else {
            print(pc.red(`\nCould not record the decision: ${id} is no longer in .ai/escalation.json.`));
            process.exitCode = 1;
          }
        }
      }
    }

    if (options.json) {
      print(JSON.stringify({ ok: results.every((r) => r.evaluation.ok), evaluations: results }, null, 2));
    } else {
      const evaluated = results.filter((r) => r.evaluation.ok).map((r) => r.evaluation as TriageEvaluation);
      const safe = evaluated.filter((e) => e.classification === 'AUTO_RESOLVE').length;
      const applied = evaluated.filter((e) => e.autoPatchApplied).length;
      print(pc.dim(`\nEvaluated ${evaluated.length}: ${safe} safe (${applied} patched), ${evaluated.length - safe} need a human.\n`));
    }
    return results;
  } finally {
    reader?.close();
  }
}
