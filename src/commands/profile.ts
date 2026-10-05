import path from 'node:path';
import pc from 'picocolors';
import { loadProfile, setProfile, NativProfile, PROFILE_DEFAULTS } from '../core/profiles.js';

export async function runProfileCommand(
  profileArg?: string,
  targetDirArg?: string,
  options: { json?: boolean } = {}
): Promise<void> {
  const root = path.resolve(targetDirArg || process.cwd());

  if (!profileArg) {
    const current = loadProfile(root);
    const details = PROFILE_DEFAULTS[current];
    if (options.json) {
      console.log(JSON.stringify(details, null, 2));
      return;
    }
    console.log(pc.bold(pc.cyan(`\nCurrent nativ Profile: `)) + pc.yellow(current.toUpperCase()));
    console.log(pc.dim(`  ${details.description}\n`));
    console.log(pc.dim('  • Enforcement:      ') + pc.white(details.enforcement));
    console.log(pc.dim('  • Governor:         ') + pc.white(details.governorMode));
    console.log(pc.dim('  • Test Integrity:   ') + pc.white(details.testIntegrity));
    console.log(pc.dim('  • Headless CI/CD:   ') + pc.white(details.allowHeadlessBypass ? 'enabled' : 'restricted'));
    console.log(pc.dim('\nTo switch profile: ') + pc.white('nativ profile [prototype | solo | enterprise]\n'));
    return;
  }

  const p = profileArg.toLowerCase() as NativProfile;
  if (p !== 'prototype' && p !== 'solo' && p !== 'enterprise') {
    console.error(pc.red(`\n✖ Invalid profile "${profileArg}". Choose prototype, solo, or enterprise.\n`));
    process.exitCode = 1;
    return;
  }

  const updated = setProfile(root, p);
  if (options.json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }

  console.log(pc.green(`\n✔ Switched active profile to `) + pc.bold(pc.cyan(p.toUpperCase())));
  console.log(pc.dim(`  ${updated.description}\n`));
  console.log(pc.dim('  • Enforcement:      ') + pc.white(updated.enforcement));
  console.log(pc.dim('  • Governor:         ') + pc.white(updated.governorMode));
  console.log(pc.dim('  • Test Integrity:   ') + pc.white(updated.testIntegrity));
  console.log('');
}
