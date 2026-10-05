import pc from 'picocolors';
import readline from 'node:readline';
import type { HumanDecisionCard, TriageEvaluation } from '../../core/tier1-liaison.js';
import type { HumanDecision } from './triage-store.js';

export const MAX_INSTRUCTIONS = 1000;
export const MAX_PROMPT_ATTEMPTS = 3;

export interface LineReader {
  ask(prompt: string): Promise<string | null>;
  close(): void;
}

/** Queues lines so answers typed (or piped) before the prompt appears are not lost. */
export function createLineReader(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineReader {
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
export async function askChoice(reader: LineReader, prompt: string, max: number, print: (line?: string) => void): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const answer = await reader.ask(prompt);
    if (answer === null || !answer.trim()) return null;
    const n = Number(answer.trim());
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
    print(pc.yellow(`  Enter a number from 1 to ${max}, or press Enter to skip.`));
  }
  return null;
}

export function printEvaluation(print: (line?: string) => void, result: TriageEvaluation, taskId: string | null, unblockedTaskId: string | null): void {
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

export async function askDecision(
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
