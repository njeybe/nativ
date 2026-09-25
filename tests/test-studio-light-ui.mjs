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
  const decls = rules.flatMap((r) => r.decls.map((d) => ({ ...d, selectors: r.selectors, resolved: norm(resolve(d.value)) })));
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

  // 2. Modern minimalist light theme (ui_specs.md §1)
  {
    assert.doesNotMatch(css, /color-scheme\s*:\s*dark/i, 'light mode must not declare color-scheme: dark');
    assert.doesNotMatch(css, /prefers-color-scheme\s*:\s*dark/i, 'spec defines a light-only palette (no dark-mode override)');
    for (const legacy of ['#0b0f19', '#131b2e', '#1a243c']) {
      assert.ok(!cssNorm.includes(legacy), `legacy dark token ${legacy} must be removed`);
    }

    const bodyDecls = decls.filter((d) => d.selectors.some((s) => s === 'body' || s === 'html'));
    const lastOf = (...props) => bodyDecls.filter((d) => props.includes(d.prop)).at(-1);
    const background = lastOf('background', 'background-color');
    assert.ok(background, 'body/html must declare a background');
    assert.ok(background.resolved.includes('#f8fafc'), `canvas background must resolve to #f8fafc, got "${background.value}"`);
    const color = lastOf('color');
    assert.ok(color?.resolved.includes('#0f172a'), `primary text must resolve to #0f172a, got "${color?.value}"`);

    const palette = {
      'surface border #e2e8f0': '#e2e8f0',
      'text muted #64748b': '#64748b',
      'accent #4f46e5': '#4f46e5',
      'accent hover #4338ca': '#4338ca',
      'success #059669': '#059669',
      'success fill #ecfdf5': '#ecfdf5',
      'active #0284c7': '#0284c7',
      'active fill #f0f9ff': '#f0f9ff',
      'blocked #e11d48': '#e11d48',
      'blocked fill #fff1f2': '#fff1f2',
      'neutral chip #f1f5f9': '#f1f5f9',
      'neutral chip outline #cbd5e1': '#cbd5e1',
    };
    for (const [label, hex] of Object.entries(palette)) {
      assert.ok(cssNorm.includes(hex), `palette token missing: ${label}`);
    }
    assert.match(cssNorm, /#fff(fff)?(?![0-9a-f])/, 'pure white surface (#ffffff) missing');
    console.log('✔ Light palette: #f8fafc canvas, #0f172a text, status/accent/chip tokens, no dark leftovers');
  }

  // 3. Typography, elevation, borders and glass header
  {
    const fonts = decls.filter((d) => d.prop === 'font-family').map((d) => d.resolved.replace(/["']/g, ''));
    const bodyFont = decls.filter((d) => d.prop === 'font-family' && d.selectors.some((s) => s === 'body' || s === 'html')).at(-1);
    assert.ok(bodyFont, 'body/html must declare a font-family');
    for (const family of ['system-ui', '-apple-system', 'segoeui', 'roboto', 'sans-serif']) {
      assert.ok(bodyFont.resolved.replace(/["']/g, '').includes(family), `body font stack missing ${family}`);
    }
    assert.ok(
      fonts.some((f) => ['sfmono-regular', 'consolas', 'monaco', 'monospace'].every((family) => f.includes(family))),
      'monospace stack (SFMono-Regular, Consolas, Monaco, monospace) must be applied somewhere',
    );

    const radii = decls.filter((d) => d.prop === 'border-radius').map((d) => d.resolved);
    assert.ok(radii.some((r) => /(^|[^\d.])6px/.test(r)), 'controls/chips need border-radius: 6px');
    assert.ok(radii.some((r) => /(^|[^\d.])10px/.test(r)), 'cards/dialogs need border-radius: 10px');
    assert.ok(
      decls.some((d) => d.prop.startsWith('border') && d.resolved.includes('1pxsolid#e2e8f0')),
      'strict 1px solid #e2e8f0 borders required',
    );
    const shadow = norm('0 1px 3px 0 rgb(0 0 0 / 0.05), 0 1px 2px -1px rgb(0 0 0 / 0.05)');
    assert.ok(
      decls.some((d) => d.prop === 'box-shadow' && d.resolved.includes(shadow)),
      'soft minimalist elevation box-shadow from ui_specs.md required',
    );

    assert.ok(decls.some((d) => d.prop === 'position' && d.resolved === 'sticky'), 'header bar must be sticky');
    const glass = rules.some((r) => {
      const has = (prop, needle) => r.decls.some((d) => d.prop === prop && norm(resolve(d.value)).includes(needle));
      return (
        (has('backdrop-filter', 'blur(8px)') || has('-webkit-backdrop-filter', 'blur(8px)')) &&
        (has('background', 'rgba(255,255,255,0.85)') || has('background-color', 'rgba(255,255,255,0.85)'))
      );
    });
    assert.ok(glass, 'sticky header needs glass backdrop: backdrop-filter: blur(8px) with rgba(255,255,255,0.85)');
    console.log('✔ System/mono font stacks, 6px/10px radii, 1px #e2e8f0 borders, soft shadow, glass sticky header');
  }

  // 4. Navigation tabs and the primary views (ui_specs.md §2–3)
  {
    const expectText = (group, labels) => {
      for (const label of labels) assert.ok(searchable.includes(label.toLowerCase()), `${group}: "${label}" not rendered`);
    };
    expectText('navigation tab', ['Overview & Status', 'Live Tasks', 'Workflow Canvas', 'Agent Worktrees', 'Agent Cockpits', 'Benchmarks', 'Database']);
    expectText('overview KPI card', ['Active Milestones', 'Task Velocity', 'Financial & Cache Telemetry', 'Specification Contracts']);
    expectText('contract checklist', ['master_plan', 'db_schema', 'api_contracts', 'ui_specs']);
    expectText('kanban', ['Pending', 'In Progress', 'Completed', 'Blocked', 'Attempts']);
    expectText('workflow canvas', ['Workflow Canvas', 'Play Simulation']);
    expectText('worktree table', ['Branch', 'Task ID', 'Commit', 'Merge to Main', 'Delete Workspace']);
    expectText('benchmarks', ['Run Benchmark', 'ops/sec']);
    console.log('✔ Seven navigation tabs with Overview KPIs, Kanban, Workflow Canvas, Worktrees, Agent Cockpits and Benchmarks');
  }

  // 4b. Vertical sidebar architecture (ui_specs.md §2)
  {
    const ruleFor = (selector) => rules.filter((r) => r.selectors.includes(selector));
    const declOf = (selector, prop) => ruleFor(selector).flatMap((r) => r.decls).filter((d) => d.prop === prop).map((d) => norm(resolve(d.value)));

    assert.match(html, /<aside\b[^>]*class=["'][^"']*\bapp-sidebar\b/i, 'sidebar must be an <aside class="app-sidebar"> landmark');
    assert.ok(declOf('.app-sidebar', 'width').includes('240px'), '.app-sidebar must be 240px wide');
    assert.ok(declOf('.app-sidebar', 'position').includes('fixed'), '.app-sidebar must be pinned (position: fixed)');
    assert.ok(declOf('.app-sidebar', 'height').includes('100vh'), '.app-sidebar must span the full viewport height');
    assert.ok(declOf('.app-sidebar', 'border-right').includes('1pxsolid#e2e8f0'), '.app-sidebar needs a 1px solid #e2e8f0 right border');
    assert.ok(declOf('.app-sidebar', 'background').some((v) => v === '#ffffff' || v === '#fff'), 'sidebar surface must be pure white');
    assert.ok(declOf('.app-main', 'margin-left').includes('240px'), '.app-main must offset the 240px sidebar');
    assert.ok(
      declOf('#runner-console-drawer', 'inset').some((v) => v.endsWith('240px')),
      'console drawer must dock beside the sidebar, not underneath it',
    );

    const sidebar = /<aside\b[^>]*app-sidebar[\s\S]*?<\/aside>/i.exec(html)[0];
    assert.match(sidebar, /role=["']tablist["'][^>]*aria-orientation=["']vertical["']/, 'sidebar nav must be a vertical tablist');
    const sidebarText = decodeEntities(sidebar).toLowerCase();
    for (const label of ['pipeline', 'system & data', 'workspace root', 'nativ studio']) {
      assert.ok(sidebarText.includes(label), `sidebar missing "${label}"`);
    }
    const tabs = [...sidebar.matchAll(/<button\b[^>]*class=["']nav-tab["'][\s\S]*?<\/button>/g)].map((m) => m[0]);
    assert.equal(tabs.length, 7, 'sidebar must hold the seven primary views');
    for (const tab of tabs) {
      assert.match(tab, /<svg\b/, 'every sidebar item needs an inline SVG icon');
      assert.match(tab, /class=["']count["']/, 'every sidebar item needs a count badge');
    }
    for (const id of ['sb-root', 'sb-branch', 'sb-live']) assert.match(sidebar, new RegExp(`id=["']${id}["']`), `sidebar footer missing #${id}`);
    assert.match(html, /<header\b[^>]*class=["']topbar["']/, 'main column needs a top app bar');
    assert.match(html, /id=["']crumb-view["']/, 'top bar must show the current view title');
    assert.match(code, /ArrowDown/, 'vertical tablist must support ArrowDown/ArrowUp');
    console.log('✔ 240px fixed sidebar with grouped SVG nav items, workspace footer, top bar and offset drawer');
  }

  // 4c. Intelligent dispatch modal and worktree diff viewer (ui_specs.md §3–4)
  {
    const dialog = /<dialog\b[^>]*id=["']dispatch-dialog["'][\s\S]*?<\/dialog>/i.exec(html);
    assert.ok(dialog, '#dispatch-dialog must be rendered');
    const dlg = decodeEntities(dialog[0]);
    for (const label of ['Isolated Worktree', 'Auto-verify Gatekeeper', 'Auto-merge on Pass', 'Cancel', 'Launch Autonomous Runner', 'Ctrl+Enter']) {
      assert.ok(dlg.includes(label), `dispatch modal missing "${label}"`);
    }
    const checkbox = (id) => new RegExp(`<input[^>]*type=["']checkbox["'][^>]*id=["']${id}["'][^>]*>`).exec(dlg)?.[0] ?? '';
    assert.match(checkbox('dispatch-worktree'), /\bchecked\b/, 'Isolated Worktree defaults on');
    assert.match(checkbox('dispatch-verify-gate'), /\bchecked\b/, 'Auto-verify Gatekeeper defaults on');
    assert.ok(checkbox('dispatch-merge') && !/\bchecked\b/.test(checkbox('dispatch-merge')), 'Auto-merge on Pass defaults off');
    assert.match(code, /--dangerously-skip-permissions/, 'dispatch modal must preview the headless claude command');
    assert.match(code, /ctrlKey/, 'Ctrl+Enter must launch the agent');
    assert.match(code, /['"]\/api\/pipeline\/tasks\/dispatch['"]/, 'dispatch modal must POST /api/pipeline/tasks/dispatch');
    for (const field of ['useWorktree', 'verify', 'autoMerge']) assert.match(code, new RegExp(`\\b${field}\\s*:`), `dispatch payload must send ${field}`);

    const drawer = decodeEntities(/<section\b[^>]*id=["']runner-console-drawer["'][\s\S]*?<\/section>/i.exec(html)[0]);
    assert.ok(drawer.includes('Live Logs') && drawer.includes('Worktree Changes'), 'console drawer needs Live Logs and Worktree Changes tabs');
    assert.match(drawer, /role=["']tablist["']/, 'console drawer tabs must be a tablist');
    assert.match(code, /['"]\/api\/pipeline\/worktrees\/diff\?taskId=['"]/, 'diff viewer must call GET /api/pipeline/worktrees/diff');
    assert.ok(searchable.includes('inspect diff'), 'worktree table needs an "Inspect Diff" action');
    console.log('✔ Dispatch modal (preview, switches, Ctrl+Enter) and Worktree Changes diff tab are wired');
  }

  // 4d. Dual-mode dispatch, grounded spend KPI and self-healing review (ui_specs.md View 1 card 3, View 3, §4 tab 3)
  {
    const dlg = decodeEntities(/<dialog\b[^>]*id=["']dispatch-dialog["'][\s\S]*?<\/dialog>/i.exec(html)[0]);
    const radio = (name, id) => new RegExp(`<input[^>]*type=["']radio["'][^>]*name=["']${name}["'][^>]*id=["']${id}["'][^>]*>`).exec(dlg)?.[0] ?? '';
    assert.ok(dlg.includes('Native Engine') && dlg.includes('Direct API, Prompt Caching & Fast Streaming'), 'engine selector offers the Native Engine');
    assert.ok(dlg.includes('CLI Terminal Pairing'), 'engine selector offers CLI Terminal Pairing');
    assert.match(radio('dispatch-engine', 'dispatch-engine-native'), /\bchecked\b/, 'Native Engine is selected by default');
    assert.doesNotMatch(radio('dispatch-engine', 'dispatch-engine-cli'), /\bchecked\b/, 'CLI pairing is opt-in');
    for (const chip of ['None', 'Fast / Deterministic', 'Standard', '2,048 tokens', 'Deep', '4,096 tokens']) {
      assert.ok(dlg.includes(chip), `thinking budget selector missing "${chip}"`);
    }
    assert.match(radio('dispatch-budget', 'dispatch-budget-none'), /\bchecked\b/, 'the None budget chip is the default');
    assert.match(radio('dispatch-budget', 'dispatch-budget-none'), /value=["']0["']/, 'None sends 0 (least thinking), not "model default"');
    assert.match(radio('dispatch-budget', 'dispatch-budget-standard'), /value=["']2048["']/, 'Standard sends a 2,048-token budget');
    assert.match(radio('dispatch-budget', 'dispatch-budget-deep'), /value=["']4096["']/, 'Deep sends a 4,096-token budget');
    assert.match(dlg, /<fieldset\b[^>]*>\s*<legend>Engine<\/legend>/, 'engine options are a labelled radio group');
    for (const field of ['runnerEngine', 'thinkingBudget']) assert.match(code, new RegExp(`\\b${field}\\b`), `dispatch payload must send ${field}`);
    assert.match(code, /effort/, 'the budget hint explains how budgets map to effort on the native engine');

    for (const label of ['Cached Input', 'Fresh Input', 'Output / Thinking', 'Gatekeeper Pass', 'Cache Hit Rate', 'via Ephemeral Caching', 'actual spend']) {
      assert.ok(code.includes(label), `financial & cache telemetry card missing "${label}"`);
    }
    assert.match(code, /actualSpendUsd/, 'the spend KPI reads actualSpendUsd from /api/pipeline/status');
    assert.match(code, /cacheSavingsUsd/, 'caching savings come from the server audit');
    assert.doesNotMatch(code, /CACHE_RATES|claude-opus-5-5['"]\s*:\s*\[/, 'the client must not keep its own copy of the price table');
    assert.match(code, /['"]\/api\/pipeline\/telemetry\/detailed['"]/, 'client must call GET /api/pipeline/telemetry/detailed');

    const drawer = decodeEntities(/<section\b[^>]*id=["']runner-console-drawer["'][\s\S]*?<\/section>/i.exec(html)[0]);
    assert.ok(drawer.includes('Self-Healing Proposal'), 'console drawer needs the Self-Healing Proposal tab');
    assert.match(drawer, /<button\b[^>]*id=["']rc-tab-heal["'][^>]*role=["']tab["']|<button\b[^>]*role=["']tab["'][^>]*id=["']rc-tab-heal["']/, 'the proposal view is a tab in the drawer tablist');
    assert.match(drawer, /id=["']rc-heal["'][^>]*role=["']tabpanel["']|role=["']tabpanel["'][^>]*id=["']rc-heal["']/, 'the proposal view is a tabpanel');
    for (const label of ['PASSED in sandbox', 'Approve &amp; Apply Patch', 'Reject Proposal', 'Proposal Ready']) {
      assert.ok(code.includes(label), `self-healing review missing "${label}"`);
    }
    assert.match(code, /['"]\/api\/pipeline\/escalations\?status=pending_review['"]/, 'client must list pending escalations');
    assert.match(code, /['"]\/api\/pipeline\/escalations\/resolve['"]/, 'approve/reject must POST /api/pipeline/escalations/resolve');
    assert.match(code, /decision\s*:/, 'resolve payload must carry the decision');
    assert.match(code, /addEventListener\(\s*['"]runner_token_usage['"]/, 'client must stream runner_token_usage SSE events');
    assert.match(html, /id=["']ncount-proposals["']/, 'Live Tasks nav item needs the amber proposal count badge');
    assert.ok(cssNorm.includes('#d97706') && cssNorm.includes('#fef3c7'), 'amber proposal tokens (#d97706 / #fef3c7) from ui_specs.md required');
    console.log('✔ Dual-mode dispatch (engine + budget chips), grounded spend KPI and self-healing proposal tab are wired');
  }

  // 4e. Tier 1 AI Strategist: header chip, 4-part decision card, canvas engine (ui_specs.md §5)
  {
    const ruleFor = (selector) => rules.filter((r) => r.selectors.includes(selector));
    const declOf = (selector, prop) => ruleFor(selector).flatMap((r) => r.decls).filter((d) => d.prop === prop).map((d) => norm(resolve(d.value)));

    const topbar = /<header\b[^>]*class=["']topbar["'][\s\S]*?<\/header>/i.exec(html)[0];
    const chip = /<button\b[^>]*id=["']t1-chip["'][\s\S]*?<\/button>/i.exec(topbar)?.[0];
    assert.ok(chip, 'top bar needs the Tier 1 strategist chip');
    assert.ok(topbar.indexOf('id="t1-chip"') < topbar.indexOf('id="live"'), 'the chip sits beside the live stream indicator');
    assert.match(decodeEntities(chip.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '), /Tier 1 AI: Gemini 3\.8 Flash/);
    assert.match(chip, /<svg\b/, 'chip glyphs are inline SVG, not emoji');
    assert.match(chip, /aria-haspopup=["']dialog["']/);
    assert.match(chip, /aria-expanded=["']false["']/);

    const menu = /<div\b[^>]*id=["']t1-menu["'][\s\S]*?<\/dl>/i.exec(topbar)?.[0];
    assert.ok(menu, 'chip needs its details dropdown');
    assert.match(menu, /\bhidden\b/, 'the dropdown starts closed');
    const menuText = decodeEntities(menu);
    for (const label of ['gemini-3.8-flash', 'Last evaluation', 'Autonomous Auto-Triage', 'Evaluated', 'Auto-resolved', 'Human-escalated',
      'Always halts on destructive database operations & major API contract breaks.']) {
      assert.ok(menuText.includes(label), `Tier 1 dropdown missing "${label}"`);
    }
    assert.match(menu, /<button\b[^>]*id=["']t1-auto["'][^>]*role=["']switch["']|<button\b[^>]*role=["']switch["'][^>]*id=["']t1-auto["']/, 'auto-triage toggle is a switch');

    for (const endpoint of ['/api/pipeline/triage/status', '/api/pipeline/triage/evaluate', '/api/pipeline/triage/config']) {
      assert.match(code, new RegExp(`['"]${endpoint.replace(/\//g, '\\/')}['"]`), `client never calls ${endpoint}`);
    }
    assert.match(code, /autoTriageEnabled\s*:/, 'the toggle posts autoTriageEnabled');
    assert.match(code, /notes\s*=\s*notes|payload\.notes/, 'card decisions travel as resolution notes');

    for (const copy of ['Human Decision Required', 'What is Happening?', 'Why is This Happening?', 'Who &amp; What is Affected?',
      'Actionable Options &amp; Trade-offs', '(Recommended)', 'Custom instructions', 'Auto-Resolved by Tier 1 AI Strategist',
      'Applied contract modification', 'Auto-unblocking', 'Run Tier 1 Triage']) {
      assert.ok(code.includes(copy), `self-healing tab missing "${copy}"`);
    }
    assert.match(code, /role="radiogroup"/, 'decision options form a radio group');
    assert.match(code, /id="t1-custom"/, 'custom instructions need an input field');

    assert.ok(declOf('.t1-card', 'border-left').includes('4pxsolid#d97706'), 'decision card has the amber #d97706 indicator bar');
    assert.ok(declOf('.t1-badge', 'background').includes('#fef3c7'), 'Human Decision Required badge uses #fef3c7');
    assert.ok(declOf('.t1-opt.is-recommended', 'background').includes('#4f46e5'), 'recommended option is the primary indigo button');
    assert.ok(declOf('.t1-banner.is-resolved', 'background').includes('#059669'), 'auto-resolved banner is emerald');
    assert.ok(declOf('.cable.is-t1.is-triage', 'stroke').includes('#0284c7'), 'triage cable pulses sky blue');
    assert.ok(declOf('.cable.is-t1.is-resolved', 'stroke').includes('#059669'), 'resolution cable pulses emerald');
    assert.ok(declOf('.cable.is-t1.is-human', 'stroke').includes('#d97706'), 'human-decision cable is amber');
    assert.ok(declOf('.cnode.is-human .cnode-card', 'border-color').includes('#d97706'), 'nodes awaiting a decision glow amber');
    assert.match(code, /t1-pulse/, 'strategist cables carry traveling pulses');
    assert.match(code, /Tier 1 AI Strategist<\/div>/, 'the canvas shows the strategist engine node');
    console.log('✔ Tier 1 strategist chip + dropdown, 4-part decision card, auto-resolve banner and canvas strategist cables are wired');
  }

  // 4f. Concept A: Agent Cockpit pods primary view (ui_specs.md §5.5)
  {
    const ruleFor = (selector) => rules.filter((r) => r.selectors.includes(selector));
    const declOf = (selector, prop) => ruleFor(selector).flatMap((r) => r.decls).filter((d) => d.prop === prop).map((d) => norm(resolve(d.value)));

    const sidebar = /<aside\b[^>]*app-sidebar[\s\S]*?<\/aside>/i.exec(html)[0];
    const pipelineGroup = sidebar.slice(sidebar.indexOf('>Pipeline<'), sidebar.indexOf('>System &amp; Data<'));
    const tab = /<button\b[^>]*id=["']nav-pods["'][\s\S]*?<\/button>/.exec(pipelineGroup)?.[0];
    assert.ok(tab, 'the Agent Cockpits tab sits in the Pipeline group');
    assert.match(tab, /data-view=["']pods["']/, 'nav-pods switches to the pods view');
    assert.match(tab, /aria-controls=["']panel-pods["']/, 'nav-pods controls #panel-pods');
    assert.match(tab, /<svg\b/, 'nav-pods needs an inline SVG icon');
    assert.match(tab, /id=["']ncount-pods["']/, 'nav-pods needs the active agent count badge');
    assert.match(decodeEntities(tab), />Agent Cockpits</, 'nav-pods is labelled "Agent Cockpits"');
    const panel = /<section\b[^>]*id=["']panel-pods["'][^>]*>/.exec(html)?.[0] ?? '';
    assert.match(panel, /role=["']tabpanel["']/, '#panel-pods must be a tabpanel');
    assert.match(panel, /aria-labelledby=["']nav-pods["']/, '#panel-pods is labelled by its tab');
    assert.match(panel, /\bhidden\b/, '#panel-pods starts hidden (Overview is the default view)');

    const views = [...(/var VIEWS = \[([^\]]*)\]/.exec(code)?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    assert.equal(views.length, 7, 'VIEWS lists the seven primary views');
    const domOrder = [...sidebar.matchAll(/data-view=["']([\w-]+)["']/g)].map((m) => m[1]);
    assert.deepEqual(domOrder, views, 'VIEWS must follow sidebar order so arrow keys move to the adjacent tab');
    assert.match(code, /var RENDERERS = \{(?:\s*\w+: function \(\) \{ return \w+\(\); \},)*\s*pods: function \(\) \{ return renderPods\(\); \}/, 'RENDERERS paints the pods view');
    assert.match(code, /\bpods:\s*\[[^\]]*'runs'[^\]]*\]/, 'the pods view repaints when runner state changes');

    for (const role of ['tier1-strategist', 'backend', 'frontend', 'qa-tester', 'database', 'security-auditor']) {
      assert.match(code, new RegExp(`\\{ role: '${role}'`), `pods grid is missing the ${role} pod`);
    }
    for (const phase of ['IDLE', 'PLANNING', 'EXECUTING', 'TESTING', 'BLOCKED']) {
      assert.match(code, new RegExp(`\\b${phase}: '`), `live phase badge missing ${phase}`);
    }
    for (const copy of ['Thinking budget', 'Auto-resolve rate', 'Inspect Console', 'workspace root', '/.worktrees/', 'No tasks to staff yet']) {
      assert.ok(code.includes(copy), `pod card missing "${copy}"`);
    }
    assert.match(code, /'<article class="card pod-card is-'/, 'pods are cards (white surface, 1px #e2e8f0 border, 10px radius, soft shadow)');
    assert.match(code, /data-action="run-console" data-key="/, 'Inspect Console opens the runner console drawer on the pod task');
    assert.match(code, /openConsole\(key, false, el\.getAttribute\('data-tab'\)/, 'the strategist pod can open the drawer on its Self-Healing tab');
    assert.match(code, /feedPodTail\(entry\)/, 'runner_log output streams into the teleprompters');
    assert.match(code, /\/api\/pipeline\/tasks\/logs\?taskId=/, 'pods opened mid-run backfill their teleprompter from the log tail');

    assert.ok(declOf('.pods-grid', 'display').includes('grid'), '.pods-grid is a CSS grid');
    assert.ok(declOf('.pods-grid', 'grid-template-columns').includes('repeat(3,minmax(0,1fr))'), '.pods-grid lays pods out in 3 columns on wide screens');
    assert.ok(declOf('.pods-grid', 'grid-template-columns').includes('repeat(2,minmax(0,1fr))'), '.pods-grid drops to 2 columns');
    assert.ok(declOf('.pods-grid', 'grid-template-columns').includes('1fr'), '.pods-grid stacks on phones');
    assert.ok(declOf('.pod-teleprompter', 'background').includes('#0f172a'), 'teleprompter is a #0f172a terminal');
    assert.ok(declOf('.pod-teleprompter', 'color').includes('#f8fafc'), 'teleprompter text is #f8fafc');
    assert.ok(declOf('.pod-teleprompter', 'font-size').includes('11.5px'), 'teleprompter font is 11.5px');
    assert.ok(declOf('.pod-teleprompter', 'font-family').some((f) => f.includes('monospace')), 'teleprompter font is monospace');

    // The teleprompter keeps the last 3 lines as a terminal would draw them.
    const fnSource = (name) => {
      const start = code.indexOf(`function ${name}(`);
      assert.ok(start !== -1, `client function ${name} missing`);
      let depth = 0;
      for (let i = code.indexOf('{', start); i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
      }
      throw new Error(`unbalanced function ${name}`);
    };
    const ctx = vm.createContext({});
    vm.runInContext(['var POD_TAIL = 3; var podTail = {};', ...['stripAnsi', 'cleanLine', 'pushTailText', 'tailLines'].map(fnSource)].join('\n'), ctx);
    const tail = (script) => JSON.parse(vm.runInContext(`${script}; JSON.stringify(tailLines('t'))`, ctx));
    let lines = tail(`podTail.t = { lines: [], partial: '' };
      pushTailText(podTail.t, 'one\\ntwo\\n\\x1b[32mthree\\x1b[0m\\r\\nfour', false);
      pushTailText(podTail.t, ' more\\rspin 1\\rspin 2', true)`);
    assert.deepEqual(lines.map((l) => l.text), ['two', 'three', 'spin 2'], 'teleprompter shows the last 3 lines, ANSI-free, with \\r redraws applied');
    assert.equal(lines.at(-1).err, true, 'stderr output stays marked while the line is still streaming');
    lines = tail(`podTail.t = { lines: [], partial: '' };
      pushTailText(podTail.t, 'hello\\r', false);
      pushTailText(podTail.t, '\\nworld\\n', false)`);
    assert.deepEqual(lines.map((l) => l.text), ['hello', 'world'], 'a CRLF split across two log chunks must not drop the line');
    console.log('✔ Agent Cockpits: 7th sidebar view with 6 pods, phase badges, budget meters, streaming teleprompters, branches and Inspect Console');
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

    assert.match(code, /new\s+EventSource\(\s*['"]\/api\/events['"?]/, "client must open new EventSource('/api/events')");
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
      '/api/pipeline/simulation/start',
      '/api/pipeline/simulation/stop',
    ];
    for (const endpoint of pipelineEndpoints) {
      assert.match(code, new RegExp(`['"]${endpoint.replace(/\//g, '\\/')}['"?]`), `client never calls ${endpoint}`);
    }

    // View 5 retains the embedded Database Studio.
    for (const endpoint of ['/api/status', '/api/schema', '/api/diff', '/api/env-info', '/api/data', '/api/connect', '/api/export-contract']) {
      assert.ok(code.includes(endpoint), `Database Studio view lost its ${endpoint} integration`);
    }
    console.log(`✔ ${classic.length} inline script(s) parse; EventSource + plan_change/telemetry_change and all pipeline endpoints wired`);
  }

  // 6. Self-contained (studio CSP is default-src 'self') and no emoji glyphs
  {
    assert.doesNotMatch(html, /<script[^>]+\bsrc\s*=\s*["']?(https?:)?\/\//i, 'external scripts are blocked by the studio CSP');
    assert.doesNotMatch(html, /<link[^>]+\bhref\s*=\s*["']?(https?:)?\/\//i, 'external stylesheets/fonts are blocked by the studio CSP');
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
      JSON.stringify({ version: '1.0.0', projectName: 'ui-fixture', lastUpdated: new Date().toISOString(), overallStatus: 'pending', activeMilestoneId: 'm1', milestones: [] }, null, 2),
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
    assert.ok(served.includes('new EventSource') && served.includes(VERSION), 'GET / must serve the Mission Control dashboard');

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
    console.error(`✖ Process still alive 10s after studio.close() (active resources: ${active.join(', ') || 'timers only'}).`);
    process.exit(1);
  }, 10_000).unref();
}
