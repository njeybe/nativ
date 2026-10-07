// Runs every suite even after one fails, then reports all failures. `node tests/run-all.mjs studio` runs the matching suites.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NODE_SUITES = [
  'profiles', 'task-router', 'task-fields', 'design-templates', 'spec-slices', 'learnings', 'contract-generator',
  'verify-gatekeeper', 'mcp-server', 'data-studio', 'fragmented-env', 'env-example-detection', 'contract-governor',
  'worktree-lifecycle', 'agent-supervisor', 'native-tools', 'concurrency-locks', 'task-claims', 'telemetry-engine', 'benchmark-suite',
  'providers', 'tier1-liaison', 'enforcement', 'setup-doctor', 'update', 'validate', 'plugin-manifest', 'code-shape',
  'model-routing', 'notify', 'token-budget', 'v2-e2e',
];
const TSX_SUITES = [
  'studio-pipeline-api', 'studio-light-ui', 'studio-shell', 'studio-home', 'studio-tasks-view', 'studio-flow',
  'studio-team', 'studio-redesign-e2e',
];

const filter = process.argv[2];
const suites = [
  ...NODE_SUITES.map((name) => ({ name, cmd: process.execPath, args: [`tests/test-${name}.mjs`] })),
  ...TSX_SUITES.map((name) => ({ name, cmd: 'npx', args: ['tsx', `tests/test-${name}.mjs`] })),
].filter((s) => !filter || s.name.includes(filter));

// CI runners set CI=true, which nativ reads as permission for human-only overrides. Suites that test that set it
// themselves; every other suite must see the plain headless agent it expects, on a laptop or in CI alike.
const env = { ...process.env };
for (const key of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'NATIV_CI_OVERRIDE', 'NATIV_HEADLESS_OVERRIDE']) delete env[key];

const failed = [];
for (const s of suites) {
  const r = spawnSync(s.cmd, s.args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' && s.cmd === 'npx' });
  if (r.status !== 0) failed.push(s.name);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
