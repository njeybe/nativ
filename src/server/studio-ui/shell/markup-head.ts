import { ICON_PATHS } from './icons.js';
import { wordmark } from './brand.js';

const svg = (name: string): string =>
  `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

// Document head close, sidebar frame and top bar (needs version and project name).
export function markupHead(version: string, projectName: string, projectHidden: string): string {
  return String.raw`</head>
<body>
<div class="toast-host" id="toasts" role="status" aria-live="polite"></div>

<div class="app">
<aside class="side" aria-label="Studio navigation">
  <div class="brand">${wordmark()}${wordmark({ rail: true })}<b>Studio</b></div>
  <div id="side-nav"></div>
  <div class="side-foot">
    <span class="foot-project" id="project-name"${projectHidden}>${projectName}</span>
    <div id="side-foot"></div>
    <span class="ver">v${version}</span>
  </div>
</aside>

<div class="main">
<header class="top">
  <span class="crumb">Studio / <b id="crumb-view">Home</b></span>
  <span class="spacer" aria-hidden="true"></span>
  <div class="top-right">
    <button class="btn" id="btn-find" type="button" aria-keyshortcuts="Control+K Meta+K">${svg('search')}<span>Find task</span><span class="kbd">Ctrl+K</span></button>
    <button class="btn ghost" id="btn-theme" type="button" title="Switch light or dark" aria-label="Switch light or dark"><span class="ic-sun">${svg('sun')}</span><span class="ic-moon">${svg('moon')}</span></button>
    <button class="btn primary" id="btn-dispatch-next" type="button" disabled title="Loading tasks">${svg('play')}<span id="dispatch-next-label">Nothing ready</span></button>
    <div class="t1" id="t1">
      <button class="t1-chip" id="t1-chip" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="t1-menu" data-state="idle" title="Tier 1 AI Strategist"><svg class="icon t1-spark" width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M197.58,129.06,146,110l-19-51.62a15.92,15.92,0,0,0-29.88,0L78,110l-51.62,19a15.92,15.92,0,0,0,0,29.88L78,178l19,51.62a15.92,15.92,0,0,0,29.88,0L146,178l51.62-19a15.92,15.92,0,0,0,0-29.88ZM137,164.22a8,8,0,0,0-4.74,4.74L112,223.85,91.78,169A8,8,0,0,0,87,164.22L32.15,144,87,123.78A8,8,0,0,0,91.78,119L112,64.15,132.22,119a8,8,0,0,0,4.74,4.74L191.85,144ZM144,40a8,8,0,0,1,8-8h16V16a8,8,0,0,1,16,0V32h16a8,8,0,0,1,0,16H184V64a8,8,0,0,1-16,0V48H152A8,8,0,0,1,144,40ZM248,88a8,8,0,0,1-8,8h-8v8a8,8,0,0,1-16,0V96h-8a8,8,0,0,1,0-16h8V72a8,8,0,0,1,16,0v8h8A8,8,0,0,1,248,88Z"/></svg><span class="t1-chip-label">Tier 1 AI:</span><span class="t1-chip-model" id="t1-chip-model">Gemini 3.8 Flash</span><svg class="icon t1-caret" width="12" height="12" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg></button>
      <div class="t1-menu" id="t1-menu" role="dialog" aria-label="Tier 1 AI Strategist" tabindex="-1" hidden>
        <div class="t1-row"><span>Active model</span><code id="t1-model">gemini-3.8-flash</code></div>
        <div class="t1-row"><span>Last evaluation</span><b id="t1-latency">No evaluations yet</b></div>
        <div class="t1-row"><span>Gemini API key</span><b id="t1-key">Checking</b></div>
        <div class="t1-row"><span id="t1-auto-label">Autonomous Auto-Triage</span><button class="t1-switch" id="t1-auto" type="button" role="switch" aria-checked="false" aria-labelledby="t1-auto-label" title="When on, fixes Tier 1 proves safe are applied without asking" disabled>OFF</button></div>
        <p class="t1-policy"><svg class="icon" width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.26,47,25.53a8,8,0,0,0,4.2,0c1-.27,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0ZM82.34,141.66a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35a8,8,0,0,1,11.32,11.32l-56,56a8,8,0,0,1-11.32,0Z"/></svg>Always halts on destructive database operations &amp; major API contract breaks.</p>
        <dl class="t1-stats"><div><dt>Evaluated</dt><dd id="t1-evaluated">0</dd></div><div><dt>Auto-resolved</dt><dd id="t1-resolved">0</dd></div><div><dt>Human-escalated</dt><dd id="t1-human">0</dd></div></dl>
      </div>
    </div>
    <span class="live" id="live" data-state="connecting" role="status" aria-live="polite"><i class="live-dot" id="live-dot" aria-hidden="true"></i><span id="live-label">Connecting</span></span>
  </div>
</header>
<div id="pulse" class="pulse-strip" aria-live="polite"></div>
<p class="banner" id="banner" role="alert" hidden>Studio lost contact with nativ. Retrying. <button class="btn small" id="banner-retry" type="button">Retry</button></p>

<main class="page" id="main" tabindex="-1">
`;
}
