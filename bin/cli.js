#!/usr/bin/env node

// Claude Code runs `nativ hook check` before every file write, so those two commands skip loading the whole CLI
// (every command and database driver, roughly half a second) and import only what they need. Everything else
// goes through the full program exactly as before.
const [, , group, subcommand, ...rest] = process.argv;

if (group === 'hook' && (subcommand === 'check' || subcommand === 'context')) {
  // The optional targetDir is the first argument that is not a flag.
  const targetDir = rest.find((arg) => !arg.startsWith('-'));
  try {
    if (subcommand === 'check') {
      const { runHookCheck } = await import('../dist/commands/hook.js');
      await runHookCheck(targetDir);
    } else {
      const { runSessionContext } = await import('../dist/core/setup-assets.js');
      runSessionContext(targetDir);
    }
  } catch (err) {
    // A hook must never fail the tool call it guards.
    process.stderr.write(`nativ hook ${subcommand}: ${err instanceof Error ? err.message : String(err)}; allowing.\n`);
  }
  // No process.exit(): on Windows a pipe write is asynchronous and exiting here could cut the decision short.
  process.exitCode = 0;
} else {
  const { run } = await import('../dist/index.js');
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
