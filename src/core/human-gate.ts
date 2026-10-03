import pc from 'picocolors';

/**
 * nativ · Commands only a person may run. Agents run headless, so a missing terminal stops them even
 * where no permission rule is installed. It is one layer, not a sandbox: the hook and ask rules are others.
 */

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Prints why and sets a failing exit code when there is no terminal. Returns true when refused. */
export function refuseHeadless(command: string): boolean {
  if (isInteractive()) return false;
  console.error(pc.red(`✖ ${command} needs an interactive terminal; agents cannot run it.`));
  process.exitCode = 1;
  return true;
}
