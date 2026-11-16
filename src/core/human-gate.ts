import readline from 'node:readline/promises';
import pc from 'picocolors';

/**
 * nativ · Commands only a person may run. Agents run headless, so a missing terminal stops them even
 * where no permission rule is installed. It is one layer, not a sandbox: the hook and ask rules are others.
 */

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Only the explicit override opens the gate; ambient CI variables do not. */
export function hasHeadlessOverride(): boolean {
  return isOn(process.env.NATIV_HEADLESS_OVERRIDE) || isOn(process.env.NATIV_CI_OVERRIDE);
}

/** Prints why and sets a failing exit code when there is no terminal, unless overridden. */
export function refuseHeadless(command: string): boolean {
  if (isInteractive() || hasHeadlessOverride()) return false;
  console.error(pc.red(`✖ ${command} needs an interactive terminal; agents cannot run it.`));
  process.exitCode = 1;
  return true;
}

/** Asks a yes/no question in the terminal; only "y" or "yes" counts as yes. */
export async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}
