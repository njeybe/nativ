import path from 'node:path';
import pc from 'picocolors';
import { resolveMainRoot } from '../core/root-resolver.js';
import { confirm, refuseHeadless } from '../core/human-gate.js';
import { assertFollowChoice, decideStyleRule, loadCodeStyle } from '../core/style/style-store.js';
import { STYLE_RULES } from '../core/style/style-types.js';
import { resolvePerson } from '../core/identity.js';

function fail(message: string): void {
  console.error(pc.red(`✖ ${message}`));
  process.exitCode = 1;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function printEvidence(rule: string, title: string, status: string, count: number, files: string[]): void {
  console.log(`\n  ${pc.bold(rule)} ${pc.dim(`[${status}]`)} ${title}`);
  const places = count === 1 ? 'place' : 'places';
  console.log(`    ${count} ${places} found`);
  for (const f of files) console.log(pc.dim(`    ${f}`));
}

export async function runStyleDecide(
  rule: string,
  follow: string,
  targetDirArg?: string,
  options: { yes?: boolean } = {},
) {
  if (refuseHeadless('nativ style decide')) return;
  const meta = STYLE_RULES.find((r) => r.id === rule);
  if (!meta) {
    fail(`Unknown rule "${rule}". Valid rules: ${STYLE_RULES.map((r) => r.id).join(', ')}.`);
    return;
  }
  try {
    assertFollowChoice(follow);
  } catch (err: unknown) {
    fail(errorText(err));
    return;
  }
  const root = resolveMainRoot(path.resolve(targetDirArg || process.cwd()));
  const current = loadCodeStyle(root).file?.decisions.find((d) => d.rule === rule);
  if (!current) {
    fail(`No decision recorded for rule "${rule}"; run nativ style scan.`);
    return;
  }
  printEvidence(rule, meta.title, current.status, current.evidence.count, current.evidence.files);
  if (current.decidedAt) {
    const who = current.decidedBy ? `, ${current.decidedBy}` : '';
    console.log(pc.dim(`    previous choice: ${current.status} (${current.decidedAt}${who})`));
  }
  if (!options.yes && !(await confirm(`\n  Follow ${follow} for ${rule}? [y/N] `))) {
    console.log(pc.dim('  Nothing changed.\n'));
    return;
  }
  try {
    decideStyleRule(root, rule, follow, resolvePerson(root));
  } catch (err: unknown) {
    fail(errorText(err));
    return;
  }
  console.log(pc.green(`\n✔ ${rule}: following ${follow}`));
  if (rule === 'config-fallback' && follow === 'codebase') {
    console.log(pc.dim('  Set codeStyle.configFallback to "off" in .nativ/config.json to stop flagging it.'));
  }
  console.log('');
}
