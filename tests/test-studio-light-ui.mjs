import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Run with `npx tsx tests/test-studio-light-ui.mjs`: the dashboard renderer and server are imported
// from TypeScript source so the light-mode UI is verified without a build step.
import { renderStudioHtml } from '../src/server/studio-ui.ts';
import { startStudioServer } from '../src/server/studio-server.ts';

console.log('--- Starting Studio Mission Control Light Mode UI Verification ---');

setTimeout(() => {
  console.error('\n✖ Studio light UI suite exceeded 60s.');
  process.exit(1);
}, 60_000).unref();

const VERSION = '9.8.7-ui-test';
const tempDirs = [];
let studio = null;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Lowercase, whitespace-free, leading-zero decimals: `rgba(255, 255, 255, .85)` → `rgba(255,255,255,0.85)`. */
const norm = (value) =>
  value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(^|[^\d])\.(\d)/g, (_, before, digit) => `${before}0.${digit}`);

function extractBlocks(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => ({
    attrs: m[1],
    body: m[2],
  }));
}

/** Flat rule list; innermost blocks only, so rules nested in @media are still visible. */
function parseCss(css) {
  const rules = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = [];
    for (const part of m[2].split(';')) {
      const idx = part.indexOf(':');
      if (idx === -1) continue;
      decls.push({ prop: part.slice(0, idx).trim().toLowerCase(), value: part.slice(idx + 1).trim() });
    }
    rules.push({ selectors: m[1].split(',').map((s) => s.trim()), decls });
  }
  return rules;
}

function createResolver(rules) {
  const vars = new Map();
  for (const rule of rules) for (const d of rule.decls) if (d.prop.startsWith('--')) vars.set(d.prop, d.value);
  const resolve = (value, depth = 0) =>
    depth > 10
      ? value
      : value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g, (_, name, fallback) =>
          resolve(vars.get(name) ?? fallback ?? '', depth + 1),
        );
  return resolve;
}

// ─── Render ────────────────────────────────────────────────────────────────────

try {
  const html = renderStudioHtml({ version: VERSION });
  assert.equal(typeof html, 'string');
  const searchable = decodeEntities(html).toLowerCase();
  const css = extractBlocks(html, 'style').map((b) => b.body).join('\n');
  const rules = parseCss(css);
  const resolve = createResolver(rules);
  const decls = rules.flatMap((r) => r.decls.map((d) => ({
    ...d,
    selectors: r.selectors,
    resolved: norm(resolve(d.value)),
  })));
  const cssNorm = norm(css);
  const scripts = extractBlocks(html, 'script').filter((b) => !/\bsrc\s*=/i.test(b.attrs));
  const classic = scripts.filter((b) => !/type\s*=\s*["']?module/i.test(b.attrs));
  const code = scripts.map((b) => b.body).join('\n');

  // 1. Document shell & header
  {
    assert.match(html, /^\s*<!doctype html>/i, 'page must start with <!doctype html>');
    assert.match(html, /<meta[^>]+name=["']viewport["']/i, 'viewport meta tag required');
    assert.ok(searchable.includes('nativ studio'), 'header brand "Nativ Studio" must be rendered');
    assert.ok(html.includes(VERSION), 'version badge must render the provided version');

    const hostile = renderStudioHtml({ version: '<img src=x onerror=alert(1)>' });
    assert.ok(!hostile.includes('<img src=x'), 'version must be HTML-escaped (no markup injection)');
    assert.ok(hostile.includes('&lt;img src=x'), 'escaped version must still be displayed');
    console.log('✔ Document shell, "Nativ Studio" header and escaped version badge render');
  }

  // 4c. Intelligent dispatch modal and worktree diff viewer (ui_specs.md §3–4)
  {
    const dialog = /<dialog\b[^>]*id=["']dispatch-dialog["'][\s\S]*?<\/dialog>/i.exec(html);
    assert.ok(dialog, '#dispatch-dialog must be rendered');
    const dlg = decodeEntities(dialog[0]);
    for (const label of [
      'Isolated Worktree', 'Auto-verify Gatekeeper', 'Auto-merge on Pass', 'Cancel',
      'Launch Autonomous Runner', 'Ctrl+Enter',
    ]) {
      assert.ok(dlg.includes(label), `dispatch modal missing "${label}"`);
    }
    const checkbox = (id) => new RegExp(
      `<input[^>]*type=["']checkbox["'][^>]*id=["']${id}["'][^>]*>`,
    ).exec(dlg)?.[0] ?? '';
    assert.match(checkbox('dispatch-worktree'), /\bchecked\b/, 'Isolated Worktree defaults on');
    assert.match(checkbox('dispatch-verify-gate'), /\bchecked\b/, 'Auto-verify Gatekeeper defaults on');
    assert.ok(
      checkbox('dispatch-merge') && !/\bchecked\b/.test(checkbox('dispatch-merge')),
      'Auto-merge on Pass defaults off',
    );
    assert.match(
      code,
      /--permission-mode acceptEdits --settings "\.nativ\/runs\/permissions\//,
      'dispatch modal must preview the headless claude command with its allowlist file',
    );
    assert.doesNotMatch(code, /dangerously-skip-permissions/, 'the preview must not offer a permission bypass');
    assert.match(code, /ctrlKey/, 'Ctrl+Enter must launch the agent');
    assert.match(
      code,
      /['"]\/api\/pipeline\/tasks\/dispatch['"]/,
      'dispatch modal must POST /api/pipeline/tasks/dispatch',
    );
    for (const field of ['useWorktree', 'verify', 'autoMerge']) {
      assert.match(code, new RegExp(`\\b${field}\\s*:`), `dispatch payload must send ${field}`);
    }

    const drawer = decodeEntities(/<section\b[^>]*id=["']runner-console-drawer["'][\s\S]*?<\/section>/i.exec(html)[0]);
    assert.ok(
      drawer.includes('Live Logs') && drawer.includes('Worktree Changes'),
      'console drawer needs Live Logs and Worktree Changes tabs',
    );
    assert.match(drawer, /role=["']tablist["']/, 'console drawer tabs must be a tablist');
    assert.match(
      code,
      /['"]\/api\/pipeline\/worktrees\/diff\?taskId=['"]/,
      'diff viewer must call GET /api/pipeline/worktrees/diff',
    );
    assert.ok(searchable.includes('inspect diff'), 'worktree table needs an "Inspect Diff" action');
    console.log('✔ Dispatch modal (preview, switches, Ctrl+Enter) and Worktree Changes diff tab are wired');
  }

  // 4d. Dual-mode dispatch, self-healing review (ui_specs.md View 1 card 3, View 3, §4 tab 3)
  {
    const dlg = decodeEntities(/<dialog\b[^>]*id=["']dispatch-dialog["'][\s\S]*?<\/dialog>/i.exec(html)[0]);
    const radio = (name, id) => new RegExp(
      `<input[^>]*type=["']radio["'][^>]*name=["']${name}["'][^>]*id=["']${id}["'][^>]*>`,
    ).exec(dlg)?.[0] ?? '';
    assert.ok(
      dlg.includes('Native Engine') && dlg.includes('Direct API, Prompt Caching & Fast Streaming'),
      'engine selector offers the Native Engine',
    );
    assert.ok(dlg.includes('CLI Terminal Pairing'), 'engine selector offers CLI Terminal Pairing');
    assert.match(
      radio('dispatch-engine', 'dispatch-engine-native'),
      /\bchecked\b/,
      'Native Engine is selected by default',
    );
    assert.doesNotMatch(
      radio('dispatch-engine', 'dispatch-engine-cli'),
      /\bchecked\b/,
      'CLI pairing is opt-in',
    );
    for (const chip of ['None', 'Fast / Deterministic', 'Standard', '2,048 tokens', 'Deep', '4,096 tokens']) {
      assert.ok(dlg.includes(chip), `thinking budget selector missing "${chip}"`);
    }
    assert.match(
      radio('dispatch-budget', 'dispatch-budget-none'),
      /\bchecked\b/,
      'the None budget chip is the default',
    );
    assert.match(
      radio('dispatch-budget', 'dispatch-budget-none'),
      /value=["']0["']/,
      'None sends 0 (least thinking), not "model default"',
    );
    assert.match(
      radio('dispatch-budget', 'dispatch-budget-standard'),
      /value=["']2048["']/,
      'Standard sends a 2,048-token budget',
    );
    assert.match(
      radio('dispatch-budget', 'dispatch-budget-deep'),
      /value=["']4096["']/,
      'Deep sends a 4,096-token budget',
    );
    assert.match(dlg, /<fieldset\b[^>]*>\s*<legend>Engine<\/legend>/, 'engine options are a labelled radio group');
    for (const field of ['runnerEngine', 'thinkingBudget']) {
      assert.match(code, new RegExp(`\\b${field}\\b`), `dispatch payload must send ${field}`);
    }
    assert.match(code, /effort/, 'the budget hint explains how budgets map to effort on the native engine');

    assert.match(
      code,
      /['"]\/api\/pipeline\/telemetry\/detailed['"]/,
      'client must call GET /api/pipeline/telemetry/detailed',
    );

    const drawer = decodeEntities(/<section\b[^>]*id=["']runner-console-drawer["'][\s\S]*?<\/section>/i.exec(html)[0]);
    assert.ok(drawer.includes('Self-Healing Proposal'), 'console drawer needs the Self-Healing Proposal tab');
    assert.match(
      drawer,
      new RegExp(
        '<button\\b[^>]*id=["\']rc-tab-heal["\'][^>]*role=["\']tab["\']'
        + '|<button\\b[^>]*role=["\']tab["\'][^>]*id=["\']rc-tab-heal["\']',
      ),
      'the proposal view is a tab in the drawer tablist',
    );
    assert.match(
      drawer,
      /id=["']rc-heal["'][^>]*role=["']tabpanel["']|role=["']tabpanel["'][^>]*id=["']rc-heal["']/,
      'the proposal view is a tabpanel',
    );
    for (const label of ['PASSED in sandbox', 'Approve &amp; Apply Patch', 'Reject Proposal']) {
      assert.ok(code.includes(label), `self-healing review missing "${label}"`);
    }
    assert.match(
      code,
      /['"]\/api\/pipeline\/escalations\?status=pending_review['"]/,
      'client must list pending escalations',
    );
    assert.match(
      code,
      /['"]\/api\/pipeline\/escalations\/resolve['"]/,
      'approve/reject must POST /api/pipeline/escalations/resolve',
    );
    assert.match(code, /decision\s*:/, 'resolve payload must carry the decision');
    assert.match(
      code,
      /addEventListener\(\s*['"]runner_token_usage['"]/,
      'client must stream runner_token_usage SSE events',
    );
    console.log('✔ Dual-mode dispatch (engine + budget chips), self-healing proposal tab are wired');
  }

  // 4e. Tier 1 AI Strategist: header chip, 4-part decision card, canvas engine (ui_specs.md §5)
  {

    const topbar = /<header\b[^>]*class=["']top["'][\s\S]*?<\/header>/i.exec(html)[0];
    const chip = /<button\b[^>]*id=["']t1-chip["'][\s\S]*?<\/button>/i.exec(topbar)?.[0];
    assert.ok(chip, 'top bar needs the Tier 1 strategist chip');
    assert.ok(
      topbar.indexOf('id="t1-chip"') < topbar.indexOf('id="live"'),
      'the chip sits beside the live stream indicator',
    );
    assert.match(
      decodeEntities(chip.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '),
      /Tier 1 AI: Gemini 3\.8 Flash/,
    );
    assert.match(chip, /<svg\b/, 'chip glyphs are inline SVG, not emoji');
    assert.match(chip, /aria-haspopup=["']dialog["']/);
    assert.match(chip, /aria-expanded=["']false["']/);

    const menu = /<div\b[^>]*id=["']t1-menu["'][\s\S]*?<\/dl>/i.exec(topbar)?.[0];
    assert.ok(menu, 'chip needs its details dropdown');
    assert.match(menu, /\bhidden\b/, 'the dropdown starts closed');
    const menuText = decodeEntities(menu);
    for (const label of [
      'gemini-3.8-flash', 'Last evaluation', 'Autonomous Auto-Triage', 'Evaluated',
      'Auto-resolved', 'Human-escalated',
      'Always halts on destructive database operations & major API contract breaks.',
    ]) {
      assert.ok(menuText.includes(label), `Tier 1 dropdown missing "${label}"`);
    }
    assert.match(
      menu,
      new RegExp(
        '<button\\b[^>]*id=["\']t1-auto["\'][^>]*role=["\']switch["\']'
        + '|<button\\b[^>]*role=["\']switch["\'][^>]*id=["\']t1-auto["\']',
      ),
      'auto-triage toggle is a switch',
    );

    for (const endpoint of [
      '/api/pipeline/triage/status', '/api/pipeline/triage/evaluate', '/api/pipeline/triage/config',
    ]) {
      assert.match(code, new RegExp(`['"]${endpoint.replace(/\//g, '\\/')}['"]`), `client never calls ${endpoint}`);
    }
    assert.match(code, /autoTriageEnabled\s*:/, 'the toggle posts autoTriageEnabled');
    assert.match(code, /notes\s*=\s*notes|payload\.notes/, 'card decisions travel as resolution notes');

    for (const copy of [
      'Human Decision Required', 'What is Happening?', 'Why is This Happening?',
      'Who &amp; What is Affected?', 'Actionable Options &amp; Trade-offs', '(Recommended)',
      'Custom instructions', 'Auto-Resolved by Tier 1 AI Strategist',
      'Applied contract modification', 'Auto-unblocking', 'Run Tier 1 Triage',
    ]) {
      assert.ok(code.includes(copy), `self-healing tab missing "${copy}"`);
    }
    assert.match(code, /role="radiogroup"/, 'decision options form a radio group');
    assert.match(code, /id="t1-custom"/, 'custom instructions need an input field');

    console.log('✔ Tier 1 strategist chip + dropdown, 4-part decision card and auto-resolve strings are wired');
  }

  // 5. Client script: valid JS, SSE listener and pipeline endpoint wiring
  {
    assert.ok(classic.length > 0, 'dashboard must ship an inline client script');
    classic.forEach((block, i) => {
      try {
        new vm.Script(block.body, { filename: `studio-inline-script-${i}.js` });
      } catch (err) {
        assert.fail(`inline <script> #${i} is not valid JavaScript: ${err.message}`);
      }
    });

    assert.match(
      code,
      /new\s+EventSource\(\s*['"]\/api\/events['"]?\)/,
      "client must open new EventSource('/api/events')",
    );
    assert.match(code, /addEventListener\(/, 'named SSE events need addEventListener (onmessage only sees "message")');
    assert.match(code, /['"]plan_change['"]/, 'client must handle plan_change events');
    assert.match(code, /['"]telemetry_change['"]/, 'client must handle telemetry_change events');

    const pipelineEndpoints = [
      '/api/pipeline/status',
      '/api/pipeline/tasks',
      '/api/pipeline/tasks/action',
      '/api/pipeline/worktrees',
      '/api/pipeline/worktrees/action',
      '/api/pipeline/benchmarks',
      '/api/pipeline/benchmarks/run',
    ];
    for (const endpoint of pipelineEndpoints) {
      assert.match(code, new RegExp(`['"]${endpoint.replace(/\//g, '\\/')}['"?]`), `client never calls ${endpoint}`);
    }

    assert.ok(!code.includes('/api/pipeline/simulation'), 'the UI must not call the simulation endpoints');
    assert.ok(!html.includes('/api/pipeline/simulation'), 'no simulation endpoint anywhere in the page');
    assert.ok(!code.includes('CACHE_RATES'), 'the client must not keep its own price table');
    // View 5 retains the embedded Database Studio.
    for (const endpoint of [
      '/api/status', '/api/schema', '/api/diff', '/api/env-info',
      '/api/data', '/api/connect', '/api/export-contract',
    ]) {
      assert.ok(code.includes(endpoint), `Database Studio view lost its ${endpoint} integration`);
    }
    console.log(
      `✔ ${classic.length} inline script(s) parse; EventSource + plan_change/telemetry_change `
      + 'and all pipeline endpoints wired',
    );
  }

  // 6. Self-contained (studio CSP is default-src 'self') and no emoji glyphs
  {
    assert.doesNotMatch(
      html,
      /<script[^>]+\bsrc\s*=\s*["']?(https?:)?\/\//i,
      'external scripts are blocked by the studio CSP',
    );
    assert.doesNotMatch(
      html,
      /<link[^>]+\bhref\s*=\s*["']?(https?:)?\/\//i,
      'external stylesheets/fonts are blocked by the studio CSP',
    );
    assert.doesNotMatch(css, /@import/i, 'CSS @import is not allowed (self-contained page)');

    const glyphs = decodeEntities(html)
      .replace(/\\u\{([0-9a-f]+)\}/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const emoji = [...new Set(glyphs.match(/\p{Emoji_Presentation}|️/gu) ?? [])];
    assert.deepEqual(emoji, [], `ui_specs.md forbids emojis; found: ${emoji.join(' ')}`);
    console.log('✔ Page is self-contained (CSP-safe) and emoji-free');
  }

  // 7. Served end-to-end by the studio server under its CSP
  {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nativ-studio-ui-')));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.ai'));
    fs.writeFileSync(path.join(dir, '.ai', 'context.md'), '# Context\n', 'utf8');
    fs.writeFileSync(
      path.join(dir, '.ai', 'master_plan.json'),
      JSON.stringify({
        version: '1.0.0',
        projectName: 'ui-fixture',
        lastUpdated: new Date().toISOString(),
        overallStatus: 'pending',
        activeMilestoneId: 'm1',
        milestones: [],
      }, null, 2),
      'utf8',
    );

    studio = await startStudioServer({
      port: 0,
      cwd: dir,
      connections: { dev: null, prod: null },
      html: () => renderStudioHtml({ version: VERSION }),
    });
    const res = await fetch(`${studio.url}/`);
    const served = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.ok(served.includes('new EventSource') && served.includes(VERSION), 'GET / must serve the Studio dashboard');

    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /connect-src[^;]*'self'/, "CSP must allow same-origin fetch/EventSource (connect-src 'self')");
    assert.match(csp, /script-src[^;]*('unsafe-inline'|'nonce-|'sha256-)/, 'CSP must permit the inline client script');
    console.log('✔ GET / serves the light dashboard with a CSP that permits its inline script and /api/events');
  }

  console.log('\n🎉 ALL STUDIO LIGHT MODE UI TESTS PASSED!');
} finally {
  if (studio) await studio.close();
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    const active = process.getActiveResourcesInfo().filter((r) => !['Timeout', 'PipeWrap', 'TTYWrap'].includes(r));
    console.error(
      `✖ Process still alive 10s after studio.close() (active resources: ${active.join(', ') || 'timers only'}).`,
    );
    process.exit(1);
  }, 10_000).unref();
}
