import { ICON_PATHS } from './icons.js';

const svg = (name: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

// Document head close, sidebar frame and top bar (needs version and project name).
export function markupHead(version: string, projectName: string, projectHidden: string): string {
  return String.raw`</head>
<body>
<div class="toast-host" id="toasts" role="status" aria-live="polite"></div>

<div class="app">
<aside class="side" aria-label="Studio navigation">
  <div class="brand"><span class="logo">N</span><b>Nativ Studio</b><span class="ver">v${version}</span></div>
  <div id="side-nav"></div>
  <div class="side-foot">
    <span class="foot-project" id="project-name"${projectHidden}>${projectName}</span>
    <div id="side-foot"></div>
  </div>
</aside>

<div class="main">
<header class="top">
  <span class="crumb">Studio / <b id="crumb-view">Home</b></span>
  <div class="top-right">
    <button class="btn" id="btn-find" type="button" aria-keyshortcuts="Control+K Meta+K">${svg('search')}<span>Find task</span><span class="kbd">Ctrl K</span></button>
    <div class="t1" id="t1">
      <button class="t1-chip" id="t1-chip" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="t1-menu" data-state="idle" title="Tier 1 AI Strategist"><svg class="icon t1-spark" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/></svg><span class="t1-chip-label">Tier 1 AI:</span><span class="t1-chip-model" id="t1-chip-model">Gemini 3.8 Flash</span><svg class="icon t1-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg></button>
      <div class="t1-menu" id="t1-menu" role="dialog" aria-label="Tier 1 AI Strategist" tabindex="-1" hidden>
        <div class="t1-row"><span>Active model</span><code id="t1-model">gemini-3.8-flash</code></div>
        <div class="t1-row"><span>Last evaluation</span><b id="t1-latency">No evaluations yet</b></div>
        <div class="t1-row"><span>Gemini API key</span><b id="t1-key">Checking</b></div>
        <div class="t1-row"><span id="t1-auto-label">Autonomous Auto-Triage</span><button class="t1-switch" id="t1-auto" type="button" role="switch" aria-checked="false" aria-labelledby="t1-auto-label" title="When on, fixes Tier 1 proves safe are applied without asking" disabled>OFF</button></div>
        <p class="t1-policy"><svg class="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.6-5.2 6.6-3-1-5.2-3.5-5.2-6.6V3.9z"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3"/></svg>Always halts on destructive database operations &amp; major API contract breaks.</p>
        <dl class="t1-stats"><div><dt>Evaluated</dt><dd id="t1-evaluated">0</dd></div><div><dt>Auto-resolved</dt><dd id="t1-resolved">0</dd></div><div><dt>Human-escalated</dt><dd id="t1-human">0</dd></div></dl>
      </div>
    </div>
    <button class="btn ghost" id="btn-theme" type="button" title="Switch light or dark" aria-label="Switch light or dark">${svg('sun')}</button>
    <span class="live" id="live" data-state="connecting" role="status" aria-live="polite"><i class="live-dot" id="live-dot" aria-hidden="true"></i><span id="live-label">Connecting</span></span>
  </div>
</header>
<p class="banner" id="banner" role="alert" hidden>Studio lost contact with nativ. Retrying. <button class="btn small" id="banner-retry" type="button">Retry</button></p>

<main class="page" id="main" tabindex="-1">
`;
}
