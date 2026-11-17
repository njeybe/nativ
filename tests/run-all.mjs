// Runs every suite even after one fails, then reports all failures.
// `node tests/run-all.mjs studio` runs the matching suites.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NODE_SUITES = [
  'profiles', 'task-router', 'task-fields', 'design-templates', 'spec-slices', 'learnings', 'contract-generator',
  'verify-gatekeeper', 'mcp-server', 'data-studio', 'fragmented-env', 'env-example-detection', 'contract-governor',
  'worktree-lifecycle', 'agent-supervisor', 'runner-enforcement-hook', 'native-tools', 'concurrency-locks',
  'task-claims',
  'telemetry-engine', 'read-output-size', 'benchmark-suite', 'identity', 'activity-spawn-event',
  'event-log', 'activity-normalize', 'hook-event', 'activity-hooks-setup', 'activity-gate-events',
  'activity-bridge', 'activity-lanes', 'activity-git-changes', 'watch-render', 'activity-feed',
  'providers', 'tier1-liaison', 'enforcement', 'setup-doctor', 'update', 'validate', 'plugin-manifest', 'code-shape',
  'model-routing', 'notify', 'token-budget', 'transcript', 'v2-e2e',
  'taste-bundle', 'taste-digest', 'init-design', 'design-check',
  'gitignore-block', 'env-reads', 'verify-env', 'clean-tree', 'check-docs', 'portability-lint', 'm16-templates',
  'm16-e2e', 'single-startup-context', 'milestone-archive', 'archive-integration',
  'style-store', 'style-sources', 'style-measure-js', 'style-measure-python', 'style-formatters', 'style-aggregate',
  'style-scan', 'style-health', 'init-style', 'style-conflicts', 'style-status',
  'style-decide', 'style-delivery', 'style-prompt', 'style-templates', 'style-drift',
  'plan-status', 'plan-changes', 'plan-command', 'dropped-lifecycle', 'dropped-readers', 'mcp-plan-propose',
  'plan-change-gate', 'studio-session', 'studio-plan-changes-api', 'studio-plan-changes-ui', 'studio-dropped-ui',
  'studio-launch',
];
const TSX_SUITES = [
  'studio-pipeline-api', 'studio-light-ui', 'studio-shell', 'studio-home', 'studio-tasks-view', 'studio-flow',
  'studio-team', 'studio-redesign-e2e',
  'studio-brand', 'studio-topbar', 'studio-pulse', 'studio-inspector', 'studio-worktrees',
  'studio-activity-api', 'studio-activity-shell', 'studio-activity', 'studio-activity-inspector',
];

const filter = process.argv[2];
const suites = [
  ...NODE_SUITES.map((name) => ({ name, cmd: process.execPath, args: [`tests/test-${name}.mjs`] })),
  ...TSX_SUITES.map((name) => ({ name, cmd: 'npx', args: ['tsx', `tests/test-${name}.mjs`] })),
].filter((s) => !filter || s.name.includes(filter));

// Strip the override, CI and host session variables so each suite sees a plain headless agent and no host project.
// Suites that test the override or a project directory set those variables themselves.
const env = { ...process.env };
const HOST_KEYS = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'NATIV_CI_OVERRIDE', 'NATIV_HEADLESS_OVERRIDE'];
for (const key of [...HOST_KEYS, 'CLAUDE_PROJECT_DIR']) {
  delete env[key];
}

const failed = [];
for (const s of suites) {
  const shell = process.platform === 'win32' && s.cmd === 'npx';
  const r = spawnSync(s.cmd, s.args, { cwd: root, env, stdio: 'inherit', shell });
  if (r.status !== 0) failed.push(s.name);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
