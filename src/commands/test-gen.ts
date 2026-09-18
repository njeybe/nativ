import path from 'node:path';
import pc from 'picocolors';
import { generateContractTests, TestGenError } from '../core/test-generator.js';
import { TEST_FRAMEWORKS, type TestGenResult, type TestFramework } from '../core/test-generator-types.js';

/**
 * `nativ test gen`: synthesizes contract and database integrity tests from .ai/ contracts.
 * Generated suites read live structure through `nativ db inspect --json`, never credentials.
 */

export interface TestGenCommandOptions {
  output?: string;
  framework?: string;
  baseUrl?: string;
  dryRun?: boolean;
  json?: boolean;
}

const SUITE_LABEL: Record<string, string> = {
  'api-contract': 'API contract',
  'db-integrity': 'DB integrity',
  support: 'support',
};

export async function runTestGen(targetDirArg?: string, options: TestGenCommandOptions = {}): Promise<TestGenResult | null> {
  const targetDir = path.resolve(targetDirArg || process.cwd());

  let result: TestGenResult;
  try {
    result = generateContractTests({
      targetDir,
      outputDir: options.output,
      framework: options.framework as TestFramework | undefined,
      baseUrl: options.baseUrl,
      dryRun: options.dryRun,
    });
  } catch (err) {
    const code = err instanceof TestGenError ? err.code : 'TEST_GEN_FAILED';
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) console.log(JSON.stringify({ error: { code, message } }, null, 2));
    else console.error(pc.red(`\n✖ ${message}\n`));
    process.exitCode = 1;
    return null;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const mode = options.dryRun ? pc.yellow(' (dry run, nothing written)') : '';
  console.log(pc.bold(pc.cyan(`\nContract Test Generator: ${result.projectName}`)) + mode);
  console.log(pc.dim(`Framework: ${result.framework} · Output: ${result.outputDir}\n`));

  if (!result.files.length) {
    console.log(pc.yellow('No endpoints or tables in .ai/ contracts produced tests.\n'));
    return result;
  }

  for (const file of result.files) {
    const label = SUITE_LABEL[file.suiteType] ?? file.suiteType;
    console.log(`  ${options.dryRun ? pc.dim('○') : pc.green('✔')} ${file.relativePath} ${pc.dim(`[${label}]`)}`);
  }

  console.log(
    `\n${pc.bold(String(result.endpointsCovered))} endpoints and ${pc.bold(String(result.tablesCovered))} tables covered` +
      pc.dim(` in ${result.durationMs}ms`),
  );
  console.log(pc.dim('Set NATIV_TEST_BASE_URL to point the API suites at another server; DB suites skip when the database is unreachable.\n'));
  return result;
}

export const TEST_GEN_FRAMEWORK_HELP = `Test framework (${TEST_FRAMEWORKS.join(', ')})`;
