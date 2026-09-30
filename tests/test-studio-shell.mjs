import assert from 'node:assert/strict';
import { renderStudioHtml } from '../src/server/studio-ui.ts';
import { createStudio, loadModel, run, NOW } from './helpers/studio-harness.mjs';

// Run with `npx tsx tests/test-studio-shell.mjs`.
console.log('--- Studio shell: model, sidebar, palette, detail panel, theme, routing ---');

const plain = (v) => JSON.parse(JSON.stringify(v));
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const LONG = 'UI/UX Design Enhancements: Dual-Track Intake, Semantic Component Trees, Stack-Aware Style Tiles';

const task = (id, over = {}) => ({
  id, title: `Title of ${id}`, status: 'pending', assignedSubagent: 'backend', dependencies: [],
  targetFiles: [`src/${id}.ts`], verificationCommand: `npx test ${id}`, notes: '', isAvailable: true,
  circuitBreaker: { consecutiveFailures: 0, maxThreshold: 3 }, ...over,
});

const api = {
  milestones: [
    { id: 'm1', name: 'Initial Setup & Contract Verification', status: 'completed', tasks: [
      task('task-01', { status: 'completed', assignedSubagent: 'qa-tester', targetFiles: ['package.json'] }),
    ] },
    { id: 'm2', name: LONG, status: 'in_progress', tasks: [
      task('task-studio-sse', { status: 'completed', assignedSubagent: 'frontend', title: 'Build the flow view' }),
      task('task-run', { status: 'in_progress', assignedSubagent: 'frontend', dependencies: ['task-studio-sse'] }),
      task('task-stuck', { status: 'blocked', assignedSubagent: 'database', dependencies: ['task-studio-sse'],
        notes: 'Verification failed after 3 attempts: heading not found.', circuitBreaker: { consecutiveFailures: 3, maxThreshold: 3 } }),
      task('task-wait', { dependencies: ['task-run', 'task-stuck'], isAvailable: false }),
      task('task-ready', { dependencies: ['task-studio-sse'] }),
    ] },
  ],
  status: { contracts: { a: true, b: true, c: true, d: false, e: true }, telemetry: { actualSpendUsd: 1.5, cacheHitRate: 0.5 } },
  telemetry: {
    summary: { actual: { spendUsd: 6.18, cacheHitRate: 0.976, cacheSavingsUsd: 39.73 } },
    taskBreakdowns: [
      { taskId: 'task-studio-sse', startedAt: iso(-3_600_000), completedAt: iso(-3_300_000), durationMs: 300_000,
        verification: { durationMs: 38_000 }, actual: { costUsd: 0.42 }, estimated: { costUsd: 0.1 } },
      { taskId: 'task-run', startedAt: iso(-72_000), completedAt: null, durationMs: 0, actual: { costUsd: 0 }, estimated: { costUsd: 0.25 } },
      { taskId: 'task-01', startedAt: null, completedAt: null, durationMs: 0, actual: null, estimated: null },
    ],
  },
  runs: [{ taskId: 'task-run', runId: 'r1', status: 'running', startedAt: iso(-60_000) }],
  escalations: [{ id: 'esc-1', taskId: 'task-stuck', status: 'pending_review', proposedPatch: { kind: 'x' } }],
  logTail: { 'task-run': '\u001b[32mEditing files\u001b[0m\nrunning tests now\n\n' },
};

// 1. buildModel joins
{
  const ctx = createStudio();
  const m = plain(loadModel(ctx, api));
  assert.equal(m.tasks.length, 6);
  assert.equal(m.activeMilestoneId, 'm2', 'first milestone with an unfinished task');
  assert.equal(m.milestones[1].short, 'UI/UX Design Enhancements');
  assert.ok(m.milestones[1].short.length <= 46);
  const done = m.byId['task-studio-sse'];
  assert.equal(done.durationMs, 300_000);
  assert.equal(done.checkMs, 38_000);
  assert.equal(done.costUsd, 0.42);
  assert.equal(done.endT, NOW - 3_300_000);
  assert.deepEqual(done.children.sort(), ['task-ready', 'task-run', 'task-stuck']);
  const running = m.byId['task-run'];
  assert.equal(running.startT, NOW - 72_000, 'startT from telemetry');
  assert.equal(running.durationMs, null, 'zero duration is null');
  assert.equal(running.costUsd, 0.25, 'zero actual cost falls back to the estimate');
  assert.equal(running.attempt, 1, 'a running task is on attempt 1');
  assert.equal(running.latestLog, 'running tests now', 'last non-empty line, no colour codes');
  assert.ok(running.run && running.run.runId === 'r1');
  assert.deepEqual(plain(running.waitingOn), []);
  const stuck = m.byId['task-stuck'];
  assert.match(stuck.reason, /failed after 3 attempts/);
  assert.equal(stuck.attempt, 3);
  assert.equal(stuck.maxAttempts, 3);
  assert.equal(stuck.hasProposal, true);
  assert.equal(stuck.escalation.id, 'esc-1');
  assert.deepEqual(m.byId['task-wait'].waitingOn.sort(), ['task-run', 'task-stuck']);
  assert.equal(m.byId['task-01'].startT, null, 'no timing recorded');
  assert.equal(m.byId['task-01'].costUsd, null);
  assert.deepEqual(m.needsYou.map((n) => [n.taskId, n.hasProposal]), [['task-stuck', true]]);
  assert.equal(m.milestones[1].done, 1);
  assert.equal(m.milestones[1].workMs, 300_000);
  assert.equal(m.milestones[1].lastEndT, NOW - 3_300_000);
  assert.equal(m.summary.spendUsd, 6.18);
  assert.equal(m.summary.cacheSavingsUsd, 39.73);
  assert.equal(m.summary.contractsPresent, 4);
  const fallback = plain(loadModel(createStudio(), { ...api, telemetry: null }));
  assert.equal(fallback.summary.spendUsd, 1.5, 'falls back to the status telemetry');
  assert.equal(plain(loadModel(createStudio(), { milestones: [] })).activeMilestoneId, null);
  console.log('✔ buildModel joins timing, cost, attempts, reason, children, active milestone and needs-you');
}

// 2. sidebar
{
  const ctx = createStudio();
  loadModel(ctx, api);
  const html = run(ctx, 'Studio.sidebarHtml({ model: Studio.model, view: "tasks", worktreeCount: 2, benchmarkText: "364" })');
  const labels = [...html.matchAll(/nav-glabel">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Now', 'Project', 'System']);
  const items = [...html.matchAll(/data-go="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(items, ['home', 'tasks', 'flow', 'team', 'worktrees', 'benchmarks', 'database']);
  assert.match(html, /data-go="tasks" aria-current="page"/);
  assert.match(html, /nav-badge warn">1</, 'needs-you badge on Home');
  assert.match(html, /nav-badge run">1</, 'running badge on Tasks');
  assert.doesNotMatch(html, /Cockpit|Canvas/);
  console.log('✔ Sidebar groups Now, Project, System in order, with badges and no removed entries');
}

// 3. palette
{
  const ctx = createStudio();
  loadModel(ctx, api);
  const find = (q) => plain(run(ctx, `Studio.paletteItems(${JSON.stringify(q)})`)).map((i) => (i.page ? `page:${i.page.id}` : i.task.id));
  assert.deepEqual(find('').slice(0, 3), ['task-run', 'task-stuck', 'task-studio-sse'].slice(0, 3), 'running, stuck, then finished');
  assert.ok(find('task-wait').includes('task-wait'), 'by id');
  assert.deepEqual(find('flow view'), ['task-studio-sse'], 'by title');
  assert.ok(find('database').includes('task-stuck'), 'by agent id');
  assert.ok(find('qa tester').includes('task-01'), 'by agent label');
  assert.deepEqual(find('package.json'), ['task-01'], 'by file');
  assert.equal(find('flow')[0], 'page:flow', 'page names match');
  assert.deepEqual(find('zzzz'), []);
  assert.match(run(ctx, 'Studio.paletteListHtml([], 0)'), /No task matches\. Try an id like task-31 or a file name\./);
  assert.ok(find('task').length <= 9, 'capped at nine');
  const list = run(ctx, 'Studio.paletteListHtml(Studio.paletteItems("task-run"), 0)');
  assert.match(list, /role="option"[^>]*aria-selected="true"/);
  console.log('✔ Palette finds by id, title, agent, file and page, shows the empty state, caps at nine');
}

// 4. detail panel sections per status
{
  const ctx = createStudio();
  loadModel(ctx, api);
  const html = (id, env = {}) => run(ctx, `Studio.detailHtml(${JSON.stringify(id)}, ${JSON.stringify(env)})`);
  const stuck = html('task-stuck');
  assert.match(stuck, /class="reason"/);
  for (const label of ['Show check output', 'Try again', 'Review proposal', 'Show in Flow', 'Needs first', 'Unblocks', 'Files it may change', 'How it is checked']) {
    assert.ok(stuck.includes(label), `stuck panel missing ${label}`);
  }
  assert.doesNotMatch(stuck, /Ask the architect/, 'proposal wins over ask');
  const noProposal = plain(api);
  noProposal.escalations = [{ id: 'esc-2', taskId: 'task-stuck', status: 'pending_review' }];
  loadModel(ctx, noProposal);
  assert.match(html('task-stuck'), /Ask the architect/);
  loadModel(ctx, api);
  const running = html('task-run');
  assert.match(running, /Latest step/);
  assert.match(running, /running tests now/);
  assert.match(running, /Open live logs/);
  assert.match(running, /data-act="task-abort"/);
  assert.match(running, /data-since="\d+"/);
  assert.match(running, /so far/);
  const ready = html('task-ready');
  assert.match(ready, /data-act="task-start"/);
  assert.match(ready, /data-act="task-dispatch"/);
  const waiting = html('task-wait');
  assert.doesNotMatch(waiting, /data-act="task-start"/, 'waiting tasks cannot start');
  const done = html('task-studio-sse');
  assert.match(done, /\(check 38s\)/);
  assert.match(done, /\$0\.42/);
  assert.doesNotMatch(done, /data-act="task-start"|Latest step/);
  assert.match(html('task-01'), /Nothing\. It can start right away\./);
  assert.match(html('task-wait'), /task-run/);
  assert.match(html('task-studio-sse'), /task-run/, 'unblocks list');
  assert.match(html('task-wait'), /No later task depends on this\./);
  const busy = html('task-ready', { busy: 'start' });
  assert.match(busy, /spinner/);
  assert.match(busy, /data-act="task-dispatch" disabled/);
  assert.match(html('task-run'), /data-act="close-detail"/);
  console.log('✔ Detail panel shows the right sections and actions per status, and a spinner while busy');
}

// 5. theme tokens and shell markup
{
  const html = renderStudioHtml({ version: '1.2.3' });
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const light = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const lightTokens = {
    '--bg': '#f6f6f9', '--surface': '#ffffff', '--surface-2': '#f0f0f5', '--line': '#e3e3ea', '--line-2': '#d2d2dc',
    '--fg': '#16161f', '--fg-2': '#54546a', '--fg-3': '#8b8b9e', '--accent': '#4f46e5', '--accent-soft': '#eeeefe',
    '--ok': '#15803d', '--run': '#2563eb', '--bad': '#dc2626', '--warn': '#b45309', '--ag-frontend': '#7c3aed',
  };
  for (const [k, v] of Object.entries(lightTokens)) assert.match(light, new RegExp(`${k}:\\s*${v}`), `light ${k}`);
  const darkBlock = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)[1];
  const darkTokens = {
    '--bg': '#0e0e13', '--surface': '#16161d', '--line': '#2a2a36', '--fg': '#ececf2', '--accent': '#8e8aff',
    '--accent-fg': '#0e0e13', '--ok': '#4ade80', '--run': '#60a5fa', '--bad': '#f87171', '--warn': '#fbbf24',
  };
  for (const [k, v] of Object.entries(darkTokens)) assert.match(darkBlock, new RegExp(`${k}:\\s*${v}`), `dark ${k}`);
  assert.match(css, /prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/, 'system dark applies when nothing is saved');
  for (const alias of ['--border: var(--line)', '--text: var(--fg)', '--muted: var(--fg-2)', '--primary: var(--accent)',
    '--success: var(--ok)', '--active: var(--run)', '--danger: var(--bad)', '--chip: var(--surface-2)', '--danger-bg: var(--bad-soft)']) {
    assert.ok(css.includes(alias), `old token alias ${alias}`);
  }
  const head = html.slice(0, html.indexOf('<style>'));
  assert.match(head, /localStorage\.getItem\('nativ-studio:theme'\)/, 'pre-paint script reads the saved theme');
  assert.match(html, /nativ-studio:theme/);
  assert.match(html, /title="Switch light or dark"/);
  const fontOf = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(light)[1];
  assert.match(fontOf('--font'), /^system-ui, -apple-system, "Segoe UI", Roboto/, 'UI font is the system stack');
  assert.match(fontOf('--mono'), /^ui-monospace, "Cascadia Mono"[^;]*monospace$/, 'mono font is a system stack');
  assert.doesNotMatch(css, /@font-face|@import/, 'no web font loading');
  const webFonts = /Geist|\bInter\b|fonts\.googleapis|fonts\.gstatic|<link[^>]+stylesheet/;
  assert.doesNotMatch(html, webFonts, 'no named web fonts or external stylesheets');
  const families = [...css.matchAll(/font-family:\s*([^;}]+)/g)].map((m) => m[1]);
  assert.ok(families.length > 0, 'font-family declarations exist');
  for (const f of families) {
    assert.match(f, /var\(--(font|mono)\)|inherit/, `font-family must use the system tokens: ${f}`);
  }
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  assert.ok(!html.includes('/api/pipeline/simulation'), 'the UI never calls the simulation endpoints');
  assert.ok(!script.includes('simulation'), 'no simulation code in the client script');
  assert.ok(!script.includes('CACHE_RATES'), 'the client keeps no copy of the price table');
  assert.match(html, /prefers-reduced-motion: reduce/);
  console.log('✔ Light and dark tokens, old-name aliases, pre-paint theme script and toggle');
}

// 6. routing
{
  const ctx = createStudio();
  const ids = ['home', 'tasks', 'flow', 'team', 'worktrees', 'benchmarks', 'database'];
  const hash = (h) => run(ctx, `Studio.resolveHash(${JSON.stringify(h)}, ${JSON.stringify(ids)})`);
  assert.equal(hash('#overview'), 'home');
  assert.equal(hash('#canvas'), 'flow');
  assert.equal(hash('#pods'), 'team');
  assert.equal(hash('#tasks'), 'tasks');
  assert.equal(hash(''), 'home');
  assert.equal(hash('#nonsense'), 'home');
  console.log('✔ Old hashes redirect (overview, canvas, pods) and unknown hashes land on Home');
}

// 7. formatting helpers
{
  const ctx = createStudio();
  const f = (code) => run(ctx, code);
  assert.equal(f('Studio.fmt.dur(45000)'), '45s');
  assert.equal(f('Studio.fmt.dur(252000)'), '4m 12s');
  assert.equal(f('Studio.fmt.dur(3900000)'), '1h 05m');
  assert.equal(f('Studio.fmt.dur(null)'), '–');
  assert.equal(f(`Studio.fmt.ago(${NOW - 10_000})`), 'just now');
  assert.equal(f(`Studio.fmt.ago(${NOW - 12 * 60_000})`), '12m ago');
  assert.equal(f(`Studio.fmt.ago(${NOW - 3 * 3_600_000})`), '3h ago');
  assert.equal(f(`Studio.fmt.ago(${NOW - 2 * 86_400_000})`), '2d ago');
  assert.equal(f('Studio.fmt.ago(null)'), 'time not recorded');
  assert.equal(f('Studio.fmt.money(0.42)'), '$0.42');
  assert.equal(f('Studio.fmt.money(null)'), '–');
  assert.match(f('Studio.ui.agentChip("mystery-agent")'), /mystery-agent/);
  assert.match(f('Studio.ui.agentChip("db-migration")'), /--ag-database/);
  console.log('✔ fmt and ui helpers');
}

console.log('\nALL STUDIO SHELL TESTS PASSED');
