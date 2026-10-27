import pc from 'picocolors';

/**
 * nativ · Commands only a person may run. Agents run headless, so a missing terminal stops them even
 * where no permission rule is installed. It is one layer, not a sandbox: the hook and ask rules are others.
 */

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function isCiEnvironment(): boolean {
  // Inside a verification sandbox, CI vars are set by nativ and must not open gates
  const sandbox = process.env.NATIV_VERIFY_SANDBOX === '1';
  return Boolean(
    (!sandbox &&
      (process.env.CI === 'true' ||
        process.env.GITHUB_ACTIONS === 'true' ||
        process.env.GITLAB_CI === 'true')) ||
    process.env.NATIV_CI_OVERRIDE ||
    process.env.NATIV_HEADLESS_OVERRIDE === '1'
  );
}

/** Prints why and sets a failing exit code when there is no terminal, unless in CI or overridden. */
export function refuseHeadless(command: string): boolean {
  if (isInteractive() || isCiEnvironment()) return false;
  console.error(pc.red(`✖ ${command} needs an interactive terminal; agents cannot run it.`));
  process.exitCode = 1;
  return true;
}
