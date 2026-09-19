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

  // 4. Navigation tabs and the five views (ui_specs.md §2–3)
  {
    const expectText = (group, labels) => {
      for (const label of labels) assert.ok(searchable.includes(label.toLowerCase()), `${group}: "${label}" not rendered`);
    };
    expectText('navigation tab', ['Overview & Status', 'Live Tasks', 'Agent Worktrees', 'Benchmarks', 'Database']);
    expectText('overview KPI card', ['Active Milestones', 'Task Velocity', 'Telemetry & Costs', 'Specification Contracts']);
    expectText('contract checklist', ['master_plan', 'db_schema', 'api_contracts', 'ui_specs']);
    expectText('kanban', ['Pending', 'In Progress', 'Completed', 'Blocked', 'Attempts']);
    expectText('worktree table', ['Branch', 'Task ID', 'Commit', 'Merge Worktree', 'Discard']);
    expectText('benchmarks', ['Run Benchmark', 'ops/sec']);
    console.log('✔ Five navigation tabs with Overview KPIs, Kanban columns, Worktree table and Benchmark views');
  }

  // 5. Client script: valid JS, SSE listener and pipeline endpoint wiring
  const scripts = extractBlocks(html, 'script').filter((b) => !/\bsrc\s*=/i.test(b.attrs));
  const classic = scripts.filter((b) => !/type\s*=\s*["']?module/i.test(b.attrs));
  const code = scripts.map((b) => b.body).join('\n');
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
