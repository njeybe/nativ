import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { resolveProjectRoot } from '../core/root-resolver.js';
import { withFileLockSync, withPlanLock, writeJsonAtomicSync } from '../core/lock-manager.js';
import { escalationPath, loadEscalationFile } from '../governor/store.js';
import type { CandidatePatch, SelfHealingEscalationRecord } from '../governor/circuit-breaker.js';
import {
  Tier1Liaison,
  type HumanDecisionCard,
  type RiskThreshold,
  type Tier1LiaisonOptions,
  type TriageClassification,
  type TriageEvaluation,
  type TriageFailure,
  type TriageSource,
} from '../core/tier1-liaison.js';

/**
 * `nativ triage`: runs the Tier 1 AI Strategist on pending escalations from the terminal and
 * presents human decision cards with numbered choices. Also home of the helpers that persist a
 * verdict onto its escalation record, shared with the Studio triage endpoints.
 */

const ESCALATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_INSTRUCTIONS = 1000;
const MAX_PROMPT_ATTEMPTS = 3;

/** Latest Tier 1 verdict, stored on the escalation so Studio and the architect can show it after a reload. */
export interface TriageSnapshot {
  evaluatedAt: string;
  provider: string;
  model: string;
  source: TriageSource;
  latencyMs: number;
  classification: TriageClassification;
  reasoning: string;
  autoPatchApplied: boolean;
  unblockedTaskId: string | null;
  guardrails: string[];
  resolution?: { summary: string; patch: CandidatePatch; proofPassed: boolean; proposalId?: string };
  humanCard?: HumanDecisionCard;
}

/** The product owner's pick from a decision card. Acting on it stays with the approve/reject gate. */
export interface HumanDecision {
  optionId: string;
  label: string;
  outcome?: string;
  instructions?: string;
  decidedAt: string;
  decidedVia: 'cli';
}

export type TriagedEscalationRecord = SelfHealingEscalationRecord & {
  triage?: TriageSnapshot;
  humanDecision?: HumanDecision;
};

export interface TriageFinalization {
  taskId: string | null;
  unblockedTaskId: string | null;
  persisted: boolean;
}

function mutateEscalation(root: string, escalationId: string, mutate: (record: TriagedEscalationRecord) => void): boolean {
  const file = escalationPath(root);
  return withFileLockSync(file, () => {
    const data = loadEscalationFile(root, path.basename(root));
    const record = data.escalations.find((e) => e?.id === escalationId) as TriagedEscalationRecord | undefined;
    if (!record) return false;
    mutate(record);
    data.lastUpdated = new Date().toISOString();
    writeJsonAtomicSync(file, data);
    return true;
  });
}

/** Moves a blocked task back to pending so it can be dispatched again. False when it was not blocked. */
async function unblockTask(root: string, taskId: string, note: string): Promise<boolean> {
  const planPath = path.join(root, '.ai', 'master_plan.json');
  if (!fs.existsSync(planPath)) return false;
  const result = await withPlanLock(planPath, (plan, ctx) => {
    const task = plan.milestones.flatMap((m) => m.tasks ?? []).find((t) => t.id === taskId);
    if (!task || task.status !== 'blocked') {
      ctx.abort();
      return false;
    }
    task.status = 'pending';
    task.notes = note;
    return true;
  });
  return result === true;
}

/**
 * Only pending escalations may be triaged: re-running a resolved one could re-apply its proposal.
 * Returns an error message, or null when the escalation can be evaluated.
 */
export function triageBlocker(root: string, escalationId: string): string | null {
  const record = loadEscalationFile(root, path.basename(root)).escalations.find((e) => e?.id === escalationId);
  if (!record) return `Escalation "${escalationId}" not found in .ai/escalation.json`;
  if (record.status !== 'pending_review') return `Escalation "${escalationId}" is already ${record.status}`;
  return null;
}

/**
 * After an evaluation: unblocks the task and closes the escalation when a patch was auto-applied,
 * then stores the verdict on the escalation. Never throws; a bookkeeping failure must not hide an
 * applied patch.
 */
export async function finalizeTriage(root: string, evaluation: TriageEvaluation): Promise<TriageFinalization> {
  let taskId: string | null = null;
  let unblockedTaskId: string | null = null;
  let persisted = false;
  try {
    taskId = loadEscalationFile(root, path.basename(root)).escalations.find((e) => e?.id === evaluation.escalationId)?.taskId ?? null;
    if (evaluation.autoPatchApplied && taskId) {
      const reason = evaluation.resolution?.summary ?? 'contract patch applied';
      if (await unblockTask(root, taskId, `Unblocked by Tier 1 auto-resolution of ${evaluation.escalationId}: ${reason}`)) {
        unblockedTaskId = taskId;
      }
    }
    const snapshot: TriageSnapshot = {
      evaluatedAt: new Date().toISOString(),
      provider: evaluation.provider,
      model: evaluation.model,
      source: evaluation.source,
      latencyMs: evaluation.latencyMs,
      classification: evaluation.classification,
      reasoning: evaluation.reasoning,
      autoPatchApplied: evaluation.autoPatchApplied,
      unblockedTaskId,
      guardrails: evaluation.guardrails,
      ...(evaluation.resolution
        ? {
            resolution: {
              summary: evaluation.resolution.summary,
              patch: evaluation.resolution.patch,
              proofPassed: evaluation.resolution.proof.passed,
              ...(evaluation.resolution.proposalId ? { proposalId: evaluation.resolution.proposalId } : {}),
            },
          }
        : {}),
      ...(evaluation.humanCard ? { humanCard: evaluation.humanCard } : {}),
    };
    persisted = mutateEscalation(root, evaluation.escalationId, (record) => {
      record.triage = snapshot;
      if (evaluation.autoPatchApplied && record.status === 'pending_review') {
        // Same closing fields the Studio approve/reject endpoint writes.
        const closed = record as TriagedEscalationRecord & { resolvedAt?: string; resolution?: unknown };
        closed.status = 'resolved';
        closed.resolutionNotes = `Auto-resolved by Tier 1 (${evaluation.model}): ${evaluation.resolution?.summary ?? 'contract patch applied'}`;
        closed.resolvedAt = snapshot.evaluatedAt;
        closed.resolution = { decision: 'approve', proposalApplied: true, ruleId: 'TIER1_AUTO_RESOLVED', unblockedTaskId };
      }
    });
  } catch {
    // Reported through `persisted: false`.
  }
  return { taskId, unblockedTaskId, persisted };
}

export function recordHumanDecision(root: string, escalationId: string, decision: HumanDecision): boolean {
  return mutateEscalation(root, escalationId, (record) => {
    record.humanDecision = decision;
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

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

interface LineReader {
  ask(prompt: string): Promise<string | null>;
  close(): void;
}

/** Queues lines so answers typed (or piped) before the prompt appears are not lost. */
function createLineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineReader {
  const rl = readline.createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  return {
    ask(prompt) {
      output.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

/** Asks for a number in 1..max; null on Enter, end of input, or repeated invalid answers. */
async function askChoice(reader: LineReader, prompt: string, max: number, print: (line?: string) => void): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = await reader.ask(prompt);
    if (answer === null || !answer.trim()) return null;
    const n = Number(answer.trim());
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
    print(pc.yellow(`  Enter a number from 1 to ${max}, or press Enter to skip.`));
  }
  return null;
}

function pendingEscalations(root: string): TriagedEscalationRecord[] {
  return loadEscalationFile(root, path.basename(root))
    .escalations.filter((e) => e && typeof e.id === 'string' && e.status === 'pending_review') as TriagedEscalationRecord[];
}

function printEvaluation(print: (line?: string) => void, result: TriageEvaluation, taskId: string | null, unblockedTaskId: string | null): void {
  print('');
  print(pc.bold(`Tier 1 AI Strategist`) + pc.dim(`  ${result.escalationId}${taskId ? ` / ${taskId}` : ''}  (${result.provider === 'deterministic' ? 'offline rules' : `${result.provider}: ${result.model}`}, ${result.latencyMs}ms)`));

  if (result.classification === 'AUTO_RESOLVE' && !result.resolution) {
    print(pc.green(pc.bold('Safe to proceed')) + pc.green('  No contract change is needed and nothing was written.'));
  } else if (result.classification === 'AUTO_RESOLVE' && result.resolution) {
    const { patch, summary } = result.resolution;
    print(pc.green(pc.bold(result.autoPatchApplied ? 'Auto-resolved' : 'Safe fix found')) + pc.green(`  ${summary}`));
    print(pc.dim(`  ${patch.operation} ${patch.target} ${patch.path}`));
    if (result.autoPatchApplied) {
      print(pc.green(`  Patch written to .ai/${patch.target === 'db_schema' ? 'db_schema.json' : 'api_contracts.json'}.`));
      if (unblockedTaskId) print(pc.green(`  Task ${unblockedTaskId} is unblocked and pending.`));
    } else {
      print(pc.white('  Proven in a sandbox copy of the contract. Re-run with --apply to write it.'));
    }
  } else if (result.humanCard) {
    const card = result.humanCard;
    print(pc.yellow(pc.bold('Human Decision Required')));
    print('');
    print(pc.bold('1. What is happening?'));
    print(`   ${card.symptom}`);
    print(pc.bold('2. Why is this happening?'));
    print(`   ${card.rootCause}`);
    print(pc.bold('3. Who and what is affected?'));
    print(`   ${card.blastRadius}`);
    print(pc.bold('4. Your options'));
    card.options.forEach((option, i) => {
      const tag = option.recommended && !/recommended/i.test(option.label) ? pc.cyan(' (Recommended)') : '';
      print(`   [${i + 1}] ${option.label}${tag}`);
      print(pc.dim(`       ${option.outcome}`));
    });
    print(`   [${card.options.length + 1}] Give custom instructions`);
  }

  if (result.reasoning) print(pc.dim(`\n  Reasoning: ${result.reasoning}`));
  for (const note of result.guardrails) print(pc.dim(`  Guardrail: ${note}`));
}

async function askDecision(
  reader: LineReader,
  card: HumanDecisionCard,
  print: (line?: string) => void,
): Promise<Omit<HumanDecision, 'decidedAt' | 'decidedVia'> | null> {
  const count = card.options.length + 1;
  const keys = Array.from({ length: count }, (_, i) => i + 1).join('/');
  const choice = await askChoice(reader, `\nChoose [${keys}] (Enter to decide later): `, count, print);
  if (choice === null) return null;
  if (choice <= card.options.length) {
    const option = card.options[choice - 1];
    return { optionId: option.id, label: option.label, outcome: option.outcome };
  }
  const text = (await reader.ask('Instructions for the team: '))?.trim() ?? '';
  if (!text) return null;
  return { optionId: 'custom', label: 'Custom instructions', instructions: text.slice(0, MAX_INSTRUCTIONS) };
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
    config: { autoTriageEnabled: Boolean(options.apply), riskThreshold: (threshold as RiskThreshold | undefined) ?? 'safe_contracts_only' },
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
