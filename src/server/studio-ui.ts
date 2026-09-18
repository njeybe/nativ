/**
 * AgentJ DB Studio — self-contained single-page dashboard.
 * Implements .ai/ui_specs.md (dark glassmorphism tokens, dual-pane explorer, drift tracker,
 * migration SQL preview, connection modal). No external assets: served inline by studio-server.
 *
 * The page is a String.raw template so client-side regexes keep their backslashes.
 * Client script must not contain backticks or "${" sequences.
 */

export interface StudioUiOptions {
  version?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function renderStudioHtml(options: StudioUiOptions = {}): string {
  const version = escapeHtml(options.version ?? '1.0.0');
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentJ DB Studio</title>
<style>
:root {
  --bg: #0b0f19;
  --surface: #131b2e;
  --surface-glass: rgba(255, 255, 255, 0.05);
  --surface-hover: #1a243c;
  --border: #1e293b;
  --primary: #6366f1;
  --primary-hover: #4f46e5;
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
  --cyan: #06b6d4;
  --media: #ec4899;
  --text: #f8fafc;
  --muted: #94a3b8;
  --r-control: 8px;
  --r-card: 12px;
  --r-pill: 9999px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Inter", sans-serif;
  --mono: "JetBrains Mono", "Fira Code", monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.5; }
body { min-height: 100vh; background:
  radial-gradient(1200px 600px at 10% -10%, rgba(99, 102, 241, 0.12), transparent 60%),
  radial-gradient(900px 500px at 110% 10%, rgba(6, 182, 212, 0.08), transparent 60%), var(--bg); }
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.container { max-width: 1440px; margin: 0 auto; padding: 24px; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }

.glass { background: linear-gradient(var(--surface-glass), var(--surface-glass)), var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }

/* Top nav */
.topnav { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 14px 18px; position: sticky; top: 12px; z-index: 10; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; white-space: nowrap; }
.pulse { width: 10px; height: 10px; border-radius: 50%; background: var(--primary); box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.6); animation: pulse 2s infinite; }
@keyframes pulse { 70% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); } 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0); } }
.version { font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--muted); border: 1px solid var(--border); border-radius: var(--r-pill); padding: 2px 8px; }
.telemetry { display: flex; flex-wrap: wrap; gap: 8px; flex: 1; min-width: 0; }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: var(--r-pill); border: 1px solid var(--border); background: rgba(255,255,255,0.03); font-size: 12.5px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.pill b { font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
.dot.on { background: var(--success); box-shadow: 0 0 8px var(--success); }
.dot.off { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }

.btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); background: var(--surface); padding: 7px 12px; border-radius: var(--r-control); cursor: pointer; font-size: 13px; transition: background .15s, border-color .15s; white-space: nowrap; }
.btn:hover { background: var(--surface-hover); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { background: var(--primary-hover); }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn:disabled { opacity: .55; cursor: not-allowed; }

/* Tabs */
.tabs { display: flex; gap: 4px; margin: 20px 0 16px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab { background: none; border: none; padding: 10px 14px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; }
.tab:hover { color: var(--text); }
.tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--primary); }
.count { font-size: 11px; padding: 1px 7px; border-radius: var(--r-pill); background: rgba(99,102,241,.18); color: #c7d2fe; }

/* Badges */
.badge { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .03em; padding: 2px 7px; border-radius: var(--r-pill); border: 1px solid currentColor; line-height: 1.4; white-space: nowrap; }
.badge-online, .badge-added { color: var(--success); background: rgba(16,185,129,.12); box-shadow: 0 0 10px rgba(16,185,129,.25); }
.badge-offline, .badge-dropped { color: var(--danger); background: rgba(239,68,68,.12); }
.badge-altered { color: var(--warning); background: rgba(245,158,11,.12); }
.badge-pk { color: #a5b4fc; background: rgba(99,102,241,.15); border-color: var(--primary); }
.badge-fk { color: var(--cyan); background: rgba(6,182,212,.12); }
.badge-subcol { color: var(--cyan); background: rgba(6,182,212,.12); border-style: dashed; }
.badge-collection { color: #c4b5fd; background: rgba(139,92,246,.14); }
.badge-media { color: var(--media); background: rgba(236,72,153,.13); font-family: inherit; cursor: zoom-in; }
button.badge-media:hover { background: rgba(236,72,153,.25); }
button.badge { font: inherit; font-size: 10.5px; font-weight: 700; letter-spacing: .03em; }

/* Media preview */
.thumb-pop { position: fixed; z-index: 60; width: 220px; padding: 8px; border-radius: var(--r-card); border: 1px solid rgba(236,72,153,.45); background: var(--surface); box-shadow: 0 12px 32px rgba(0,0,0,.5); pointer-events: none; }
.thumb-pop[hidden] { display: none; }
.thumb-box { display: grid; place-items: center; min-height: 120px; max-height: 200px; overflow: hidden; border-radius: var(--r-control); background: repeating-conic-gradient(#1a243c 0% 25%, #131b2e 0% 50%) 50% / 16px 16px; }
.thumb-box img { max-width: 100%; max-height: 200px; display: block; }
.thumb-box .ph { color: var(--muted); font-size: 12px; text-align: center; padding: 12px; }
.thumb-meta { margin-top: 6px; font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
.media-modal .thumb-box { min-height: 220px; max-height: 360px; }
.media-modal .thumb-box img { max-height: 360px; }
.media-modal dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 14px 0 0; font-size: 12.5px; }
.media-modal dt { color: var(--muted); }
.media-modal dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.media-note { margin-top: 12px; font-size: 12px; color: var(--muted); }

/* Explorer */
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.input { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-control); padding: 8px 12px; min-width: 0; }
.input:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 3px rgba(99,102,241,.25); }
.search { flex: 1; min-width: 180px; max-width: 420px; }
.segmented { display: none; border: 1px solid var(--border); border-radius: var(--r-control); overflow: hidden; }
.segmented button { border: none; background: transparent; padding: 7px 14px; cursor: pointer; color: var(--muted); }
.segmented button[aria-pressed="true"] { background: var(--primary); color: #fff; }
.panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.pane { padding: 16px; min-width: 0; }
.pane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.pane-head h2 { margin: 0; font-size: 15px; display: flex; align-items: center; gap: 8px; white-space: nowrap; flex: none; }
.pane-head .meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-card { border: 1px solid var(--border); border-radius: var(--r-control); margin-bottom: 8px; background: rgba(11,15,25,.45); }
.table-card > summary { list-style: none; cursor: pointer; padding: 10px 12px; display: flex; align-items: center; gap: 8px; border-radius: var(--r-control); }
.table-card > summary::-webkit-details-marker { display: none; }
.table-card > summary:hover { background: var(--surface-hover); }
.table-card > summary::before { content: "\25B8"; color: var(--muted); transition: transform .15s; }
.table-card[open] > summary::before { transform: rotate(90deg); }
.table-card .tname { font-family: var(--mono); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.table-card .ccount { margin-left: auto; color: var(--muted); font-size: 12px; white-space: nowrap; }
.table-body { padding: 0 12px 12px; overflow-x: auto; }
.desc { color: var(--muted); margin: 0 0 8px; font-size: 12.5px; }
table.cols { width: 100%; border-collapse: collapse; font-size: 12.5px; }
table.cols th { text-align: left; color: var(--muted); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
table.cols td { padding: 6px 8px; border-bottom: 1px solid rgba(30,41,59,.6); vertical-align: top; }
table.cols td.mono { white-space: nowrap; }
.muted { color: var(--muted); }
.subhead { font-size: 12px; color: var(--muted); margin: 12px 0 6px; text-transform: uppercase; letter-spacing: .05em; }
.idx-list { margin: 0; padding-left: 18px; font-size: 12.5px; }

/* Drift */
.summary-banner { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; padding: 16px; margin-bottom: 16px; }
.stat { padding: 4px 8px; }
.stat .n { font-size: 26px; font-weight: 700; line-height: 1.1; }
.stat .l { color: var(--muted); font-size: 12px; }
.risk-HIGH { color: var(--danger); } .risk-MEDIUM { color: var(--warning); } .risk-LOW { color: var(--success); } .risk-NONE { color: var(--muted); }
.section { padding: 16px; margin-bottom: 16px; }
.section h3 { margin: 0 0 12px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
.alert-danger { border: 1px solid rgba(239,68,68,.5); background: rgba(239,68,68,.1); color: #fecaca; border-radius: var(--r-control); padding: 10px 12px; margin-bottom: 12px; }
.alert-danger strong { color: var(--danger); }
.diff-table td.before { color: #fca5a5; } .diff-table td.after { color: #86efac; }
.row-added td { background: rgba(16,185,129,.07); } .row-dropped td { background: rgba(239,68,68,.08); } .row-altered td { background: rgba(245,158,11,.07); }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 12px; padding: 3px 9px; border-radius: var(--r-pill); border: 1px solid var(--border); background: rgba(255,255,255,.03); }

/* SQL */
.sql-wrap { position: relative; padding: 0; overflow: hidden; }
.sql-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
pre.sql { margin: 0; padding: 16px; overflow: auto; max-height: 70vh; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; white-space: pre; }
.sql .k { color: #a5b4fc; font-weight: 600; } .sql .s { color: #86efac; } .sql .c { color: #64748b; font-style: italic; } .sql .d { color: var(--danger); font-weight: 700; }
.sql .p { color: #7dd3fc; } .sql .n { color: #fcd34d; } .sql .o { color: var(--media); }
.lang { font-family: var(--mono); font-size: 11px; padding: 2px 8px; border-radius: var(--r-pill); border: 1px solid var(--border); color: #c7d2fe; margin-right: 6px; }
.copy-wrap { position: relative; display: inline-flex; }
.tooltip { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--success); color: #062016; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px; pointer-events: none; opacity: 0; transition: opacity .15s; white-space: nowrap; }
.tooltip.show { opacity: 1; }

/* States */
.empty { text-align: center; padding: 48px 24px; }
.empty svg { opacity: .8; margin-bottom: 12px; }
.empty h3 { margin: 0 0 6px; font-size: 16px; }
.empty p { color: var(--muted); margin: 0 0 16px; }
.skeleton { height: 42px; border-radius: var(--r-control); margin-bottom: 8px; background: linear-gradient(90deg, #131b2e 0%, #1c2742 50%, #131b2e 100%); background-size: 200% 100%; animation: shimmer 1.3s infinite linear; }
.skeleton.short { width: 60%; }
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.toast-host { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 100; display: flex; flex-direction: column; gap: 8px; width: min(560px, calc(100vw - 32px)); }
.toast { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--r-card); border: 1px solid rgba(239,68,68,.5); background: #2a1216; box-shadow: 0 10px 30px rgba(0,0,0,.4); }
.toast.ok { border-color: rgba(16,185,129,.5); background: #0f2a22; }
.toast .t-body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast .t-hint { color: var(--muted); font-size: 12px; }
.toast button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; }

/* Modal */
dialog { border: none; padding: 0; background: transparent; color: var(--text); width: min(640px, calc(100vw - 32px)); }
dialog::backdrop { background: rgba(3, 6, 14, .7); backdrop-filter: blur(4px); }
.modal { padding: 20px; }
.modal h2 { margin: 0 0 4px; font-size: 17px; }
.modal .lead { color: var(--muted); margin: 0 0 16px; font-size: 12.5px; }
.field { margin-bottom: 16px; }
.field label { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; }
.field-row { display: flex; gap: 8px; }
.field-row .input { flex: 1; font-family: var(--mono); font-size: 12.5px; min-width: 0; }
.field-row + .field-row { margin-top: 8px; }
.field-row select.input { font-family: var(--font); }
.field-row [hidden] { display: none; }
.field .current { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--muted); min-width: 0; }
.field .current code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.result { margin-top: 6px; font-size: 12.5px; }
.result.ok { color: var(--success); } .result.err { color: #fca5a5; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

/* Environment focus & toggles */
.env-toggle-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0 10px; }
.env-segmented { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-pill); background: rgba(19, 27, 46, 0.7); backdrop-filter: blur(8px); padding: 3px; }
.env-seg-btn { border: none; background: transparent; padding: 6px 16px; border-radius: var(--r-pill); cursor: pointer; color: var(--muted); font-size: 12.5px; font-weight: 600; transition: all .15s ease; }
.env-seg-btn:hover { color: var(--text); }
.env-seg-btn[aria-pressed="true"] { background: var(--primary); color: #fff; box-shadow: 0 0 12px rgba(99,102,241,.35); }
.env-seg-btn[data-env-mode="prod"][aria-pressed="true"] { background: #b45309; color: #fff; box-shadow: 0 0 12px rgba(245,158,11,.35); }
.prod-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-radius: var(--r-control); border: 1px solid rgba(245,158,11,.4); background: rgba(245,158,11,.08); color: #fef3c7; font-size: 12.5px; margin-bottom: 14px; }
.prod-banner b { color: #fde68a; font-weight: 600; }
.panes-full { grid-template-columns: 1fr; }

/* Data Grid */
.data-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.data-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.data-grid-wrap { overflow-x: auto; max-width: 100%; border: 1px solid var(--border); border-radius: var(--r-control); background: var(--surface); margin-bottom: 14px; min-height: 240px; }
table.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; text-align: left; }
table.data-table th { background: #1a243c; color: var(--muted); font-weight: 600; padding: 10px 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; white-space: nowrap; user-select: none; }
table.data-table th.sortable { cursor: pointer; }
table.data-table th.sortable:hover { color: var(--text); background: #223050; }
table.data-table td { padding: 8px 12px; border-bottom: 1px solid rgba(30,41,59,.5); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
table.data-table tr:hover td { background: var(--surface-hover); }
.th-sort-icon { font-size: 10px; margin-left: 4px; color: var(--primary); }
.td-actions { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.btn-danger { color: #fca5a5; border-color: rgba(239,68,68,.4); }
.btn-danger:hover { background: rgba(239,68,68,.18); border-color: var(--danger); color: #fff; }
.pagination-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 4px; font-size: 12.5px; color: var(--muted); }
.pagination-ctrls { display: flex; align-items: center; gap: 8px; }
.cell-preview-btn { padding: 2px 6px; font-size: 11px; border-radius: 4px; border: 1px solid var(--media); color: var(--media); background: rgba(236,72,153,.1); cursor: pointer; }
.cell-preview-btn:hover { background: rgba(236,72,153,.2); }

/* Modals */
.modal-prod-guard { border: 1px solid rgba(245,158,11,.6); box-shadow: 0 0 30px rgba(245,158,11,.15); }
.challenge-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--r-pill); font-size: 11px; font-weight: 700; color: #f59e0b; background: rgba(245,158,11,.15); border: 1px solid #f59e0b; margin-bottom: 12px; }
.challenge-box { padding: 14px; border-radius: var(--r-control); border: 1px solid rgba(239,68,68,.4); background: rgba(239,68,68,.07); margin: 12px 0; }
.challenge-box p { margin: 0 0 8px; font-size: 12.5px; }
.challenge-box code { color: #fca5a5; font-weight: 700; font-size: 13px; }
.record-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-height: 60vh; overflow-y: auto; padding-right: 4px; margin-bottom: 16px; }
.record-form-grid .field-full { grid-column: 1 / -1; }
.record-form-grid label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--muted); }
.record-form-grid label b { color: var(--text); font-family: var(--mono); }
.record-form-grid .input { width: 100%; }
.record-form-grid textarea.input { min-height: 64px; resize: vertical; font-family: var(--mono); font-size: 12px; }

@media (max-width: 900px) {
  .container { padding: 16px; }
  .topnav { position: static; }
  .telemetry { flex: 1 1 100%; order: 3; flex-direction: column; align-items: flex-start; }
  .pill { white-space: normal; }
  .panes { grid-template-columns: 1fr; }
  .segmented { display: inline-flex; }
  .pane[data-hidden="true"] { display: none; }
  .summary-banner { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<div class="toast-host" id="toasts" role="status" aria-live="polite"></div>
<div class="container">
  <header class="topnav glass">
    <div class="brand"><span class="pulse" aria-hidden="true"></span>AgentJ DB Studio <span class="version">agentj v${version}</span></div>
    <div class="telemetry" id="telemetry" aria-label="Database telemetry"></div>
    <div class="actions">
      <button class="btn" id="btn-settings" type="button">Connection Settings</button>
      <button class="btn" id="btn-refresh" type="button">Refresh Data</button>
      <button class="btn primary" id="btn-export" type="button">Export Contract</button>
    </div>
  </header>

  <div class="env-toggle-bar">
    <div class="env-segmented" role="group" aria-label="Environment Focus Mode">
      <button type="button" class="env-seg-btn" data-env-mode="dev" aria-pressed="true">Staging / Dev</button>
      <button type="button" class="env-seg-btn" data-env-mode="prod" aria-pressed="false">Production</button>
      <button type="button" class="env-seg-btn" data-env-mode="split" aria-pressed="false">Split Comparison</button>
    </div>
  </div>

  <nav class="tabs" role="tablist" aria-label="Studio views">
    <button class="tab" role="tab" id="tab-explorer" aria-controls="view" data-tab="explorer">Schema &amp; Structure <span class="count" id="count-explorer">0</span></button>
    <button class="tab" role="tab" id="tab-data" aria-controls="view" data-tab="data">Live Data Browser <span class="count" id="count-data">0</span></button>
    <button class="tab" role="tab" id="tab-drift" aria-controls="view" data-tab="drift">Drift &amp; Diff Tracker <span class="count" id="count-drift">0</span></button>
    <button class="tab" role="tab" id="tab-sql" aria-controls="view" data-tab="sql">Migration Script Preview <span class="count" id="count-sql">0</span></button>
  </nav>

  <main id="view" role="tabpanel" tabindex="-1"></main>
</div>

<dialog id="conn-dialog" aria-labelledby="conn-title">
  <form class="modal glass" method="dialog" id="conn-form">
    <h2 id="conn-title">Connection Settings</h2>
    <p class="lead">Connection strings stay in memory inside the local agentj process. They are never written to disk or shown to AI agents; only masked URLs are displayed.</p>
    <div class="field" data-env="dev">
      <label for="engine-dev"><span class="dot" id="mdot-dev"></span> Dev / Staging</label>
      <div class="field-row">
        <select class="input" id="engine-dev" data-engine="dev" aria-label="Dev database type">
          <option value="url">Connection URL (PostgreSQL, MySQL, SQLite, MongoDB)</option>
          <option value="firestore">Firebase Firestore</option>
        </select>
      </div>
      <div class="field-row">
        <input class="input" id="url-dev" type="password" autocomplete="off" spellcheck="false" aria-label="Dev connection string" placeholder="postgres://user:password@localhost:5432/app_dev  or  mongodb://localhost:27017/app">
        <button class="btn small" type="button" data-toggle="dev" aria-controls="url-dev" aria-pressed="false">Show</button>
        <input class="input" id="fsproject-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev Firestore project ID" placeholder="Project ID" hidden>
        <input class="input" id="fsemu-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev Firestore emulator host" placeholder="Emulator host (optional), e.g. localhost:8080" hidden>
        <button class="btn small" type="button" data-ping="dev">Test Ping</button>
      </div>
      <div class="current" id="current-dev"></div>
      <div class="result" id="result-dev" aria-live="polite"></div>
    </div>
    <div class="field" data-env="prod">
      <label for="engine-prod"><span class="dot" id="mdot-prod"></span> Production</label>
      <div class="field-row">
        <select class="input" id="engine-prod" data-engine="prod" aria-label="Production database type">
          <option value="url">Connection URL (PostgreSQL, MySQL, SQLite, MongoDB)</option>
          <option value="firestore">Firebase Firestore</option>
        </select>
      </div>
      <div class="field-row">
        <input class="input" id="url-prod" type="password" autocomplete="off" spellcheck="false" aria-label="Production connection string" placeholder="postgres://user:password@db.example.com:5432/app  or  mongodb+srv://…">
        <button class="btn small" type="button" data-toggle="prod" aria-controls="url-prod" aria-pressed="false">Show</button>
        <input class="input" id="fsproject-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production Firestore project ID" placeholder="Project ID" hidden>
        <input class="input" id="fsemu-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production Firestore emulator host" placeholder="Emulator host (optional)" hidden>
        <button class="btn small" type="button" data-ping="prod">Test Ping</button>
      </div>
      <div class="current" id="current-prod"></div>
      <div class="result" id="result-prod" aria-live="polite"></div>
    </div>
    <p class="lead" style="margin:0 0 8px">Firestore uses your local Application Default Credentials (<code>gcloud auth application-default login</code>) or the emulator; no key file is ever uploaded here.</p>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Close</button>
      <button class="btn primary" type="button" id="btn-save-conn">Save to In-Memory Session</button>
    </div>
  </form>
</dialog>

<dialog id="media-dialog" aria-labelledby="media-title">
  <form class="modal glass media-modal" method="dialog">
    <h2 id="media-title">Image field</h2>
    <p class="lead" id="media-sub"></p>
    <div class="thumb-box" id="media-thumb"></div>
    <dl id="media-details"></dl>
    <p class="media-note">Only metadata from sampled documents is shown. Raw image bytes and full Base64 payloads are never sent to the browser or to AI agents.</p>
    <div class="modal-foot"><button class="btn" value="close" type="submit">Close</button></div>
  </form>
</dialog>

<dialog id="record-dialog" aria-labelledby="record-title">
  <form class="modal glass" method="dialog" id="record-form">
    <h2 id="record-title">Record</h2>
    <p class="lead" id="record-lead">Insert or edit record.</p>
    <div class="record-form-grid" id="record-fields"></div>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn primary" type="button" id="btn-save-record">Save Record</button>
    </div>
  </form>
</dialog>

<dialog id="challenge-dialog" aria-labelledby="challenge-title">
  <form class="modal glass modal-prod-guard" method="dialog" id="challenge-form">
    <span class="challenge-badge">PRODUCTION MUTATION SAFEGUARD</span>
    <h2 id="challenge-title">Confirm Production Mutation</h2>
    <div class="challenge-box">
      <p>Target: <b>PRODUCTION ENVIRONMENT</b></p>
      <p id="challenge-desc">You are about to modify live production data.</p>
      <p>To proceed, type the target name exactly: <code id="challenge-target-name">entity</code></p>
    </div>
    <div class="field">
      <label for="challenge-input">Confirmation phrase</label>
      <input class="input" id="challenge-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type name to confirm">
    </div>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn btn-danger" type="button" id="btn-confirm-challenge" disabled>Execute Production Mutation</button>
    </div>
  </form>
</dialog>

<div class="thumb-pop" id="thumb-pop" role="tooltip" hidden></div>

<script>
(function () {
  'use strict';

  var ENGINE_LABEL = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB', firestore: 'Firebase Firestore' };
  var NOSQL = { mongodb: true, firestore: true };
  var state = {
    tab: 'explorer',
    envMode: 'dev',
    loading: true,
    status: null,
    schema: { devTables: [], prodTables: [] },
    diff: null,
    diffError: null,
    diffTarget: 'prod',
    search: '',
    mobileEnv: 'dev',
    sql: '',
    scriptLang: 'sql',
    dataEnv: 'dev',
    dataEntity: '',
    dataPage: 1,
    dataLimit: 25,
    dataSort: '',
    dataOrder: 'asc',
    dataSearch: '',
    dataLoading: false,
    dataResult: null,
    dataError: null,
    editingPk: null,
    pendingMutation: null
  };
  // Media fields rendered in the current view, referenced by index from IMAGE badges.
  var mediaRegistry = [];

  var $ = function (id) { return document.getElementById(id); };

  function isCollection(t) { return !!t && t.entityType === 'collection'; }
  function entityCount(s) { return s.entityCount != null ? s.entityCount : s.tableCount; }
  function entityNoun(s, plural) {
    var coll = s && (s.entityType === 'collection' || NOSQL[s.engine]);
    return coll ? (plural ? 'Collections' : 'Collection') : (plural ? 'Tables' : 'Table');
  }
  /** Noun for drift views: collections when the compared Dev database is a document store. */
  function driftNoun(plural) {
    var dev = state.status && state.status.dev;
    var word = entityNoun(dev, plural);
    return word.toLowerCase();
  }

  function formatBytes(n) {
    if (n == null) return 'unknown';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function isPreviewableUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body.error && body.error.message) || ('Request failed (' + res.status + ')'));
          err.code = body.error && body.error.code;
          throw err;
        }
        return body;
      });
    });
  }

  function postJson(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  // ─── Toasts ────────────────────────────────────────────────────────────────
  function hintFor(message) {
    var m = String(message || '');
    if (/ECONNREFUSED|ETIMEDOUT|timeout|EHOSTUNREACH/i.test(m)) return 'Check that the database server is running and the host/port are reachable from this machine.';
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'The hostname could not be resolved. Verify the host in your connection string.';
    if (/password|authentication|access denied/i.test(m)) return 'Credentials were rejected. Re-enter the connection string in Connection Settings.';
    if (/unable to open database file/i.test(m)) return 'The SQLite file was not found. Check the path relative to where agentj was started.';
    if (/not configured|NOT_CONNECTED/i.test(m)) return 'Open Connection Settings to connect a database.';
    if (/default credentials|UNAUTHENTICATED|PERMISSION_DENIED/i.test(m)) return 'For Firestore, run "gcloud auth application-default login" or connect to the emulator instead.';
    if (/Server selection timed out|MongoServerSelectionError/i.test(m)) return 'MongoDB did not respond. Check the host, port, and network access list.';
    return '';
  }

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'ok' ? ' ok' : '');
    var hint = kind === 'ok' ? '' : hintFor(message);
    el.innerHTML = '<div class="t-body"><div>' + esc(message) + '</div>' + (hint ? '<div class="t-hint">' + esc(hint) + '</div>' : '') +
      '</div><button type="button" aria-label="Dismiss">×</button>';
    el.querySelector('button').addEventListener('click', function () { el.remove(); });
    $('toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'ok' ? 3500 : 8000);
  }

  function flashCopied(button) {
    var wrap = button.parentElement;
    var tip = wrap && wrap.querySelector('.tooltip');
    if (!tip) return;
    tip.classList.add('show');
    setTimeout(function () { tip.classList.remove('show'); }, 1200);
  }

  function copyText(text, button) {
    var done = function () { flashCopied(button); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ─── Data loading ──────────────────────────────────────────────────────────
  function load(fresh) {
    state.loading = true;
    render();
    var q = fresh ? '?refresh=1' : '';
    var diffPath = '/api/diff?target=' + state.diffTarget + (fresh ? '&refresh=1' : '');
    return Promise.all([
      api('/api/status' + q).catch(function (e) { toast(e.message); return null; }),
      api('/api/schema' + q).catch(function (e) { toast(e.message); return { devTables: [], prodTables: [] }; }),
      api(diffPath).then(function (d) { state.diffError = null; return d; }, function (e) { state.diffError = e.message; return null; })
    ]).then(function (results) {
      state.status = results[0];
      state.schema = results[1];
      state.diff = results[2];
      state.diffTargetUsed = state.diffTarget;
      state.loading = false;
      if (state.status) {
        ['dev', 'prod'].forEach(function (env) {
          var s = state.status[env];
          if (s && !s.connected && s.error && !/No (Dev|Prod) database configured/.test(s.error)) {
            toast((env === 'dev' ? 'Dev' : 'Prod') + ' connection failed: ' + s.error);
          }
        });
      }
      render();
    });
  }

  // ─── Rendering: shell ──────────────────────────────────────────────────────
  function statusPill(env, s) {
    var label = env.toUpperCase();
    if (!s) return '<span class="pill"><span class="dot"></span><b>' + label + ':</b> loading…</span>';
    if (!s.connected) {
      var why = /No (Dev|Prod) database configured/.test(s.error || '') ? 'not configured' : 'offline';
      return '<span class="pill" title="' + esc(s.error || '') + '"><span class="dot off"></span><b>' + label + ':</b> ' + why +
        ' <span class="badge badge-offline">OFFLINE</span></span>';
    }
    return '<span class="pill" title="' + esc(s.maskedUrl) + '"><span class="dot on"></span><b>' + label + ':</b> ' +
      esc(ENGINE_LABEL[s.engine] || s.engine) + (s.database ? ' · ' + esc(s.database) : '') + ' (' + Math.round(s.pingMs) + 'ms) – ' +
      entityCount(s) + ' ' + entityNoun(s, true) + ' <span class="badge badge-online">ONLINE</span></span>';
  }

  function renderShell() {
    var st = state.status || {};
    $('telemetry').innerHTML = statusPill('dev', st.dev) + statusPill('prod', st.prod);
    $('count-explorer').textContent = String((state.schema.devTables || []).length + (state.schema.prodTables || []).length);
    var activeEnv = state.envMode === 'prod' ? 'prod' : 'dev';
    var dataCount = state.dataResult && state.dataResult.totalCount != null
      ? state.dataResult.totalCount
      : ((state.schema[activeEnv + 'Tables'] || []).length);
    $('count-data').textContent = String(dataCount);
    var d = state.diff && state.diff.summary;
    $('count-drift').textContent = d ? String(d.addedTablesCount + d.alteredTablesCount + d.droppedTablesCount) : '–';
    var script = state.diff ? generateScript(state.diff) : { text: '', lang: 'sql', count: 0 };
    state.sql = script.text;
    state.scriptLang = script.lang;
    state.scriptCount = script.count;
    $('count-sql').textContent = String(script.count);
    document.querySelectorAll('.tab').forEach(function (t) {
      var active = t.getAttribute('data-tab') === state.tab;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.setAttribute('tabindex', active ? '0' : '-1');
    });
    document.querySelectorAll('.env-seg-btn').forEach(function (btn) {
      var m = btn.getAttribute('data-env-mode');
      btn.setAttribute('aria-pressed', String(m === state.envMode));
    });
    $('view').setAttribute('aria-labelledby', 'tab-' + state.tab);
    $('btn-refresh').disabled = state.loading;
  }

  function render() {
    renderShell();
    mediaRegistry = [];
    hideThumb();
    var view = $('view');
    if (state.loading) { view.innerHTML = skeleton(); return; }
    if (state.tab === 'explorer') view.innerHTML = renderExplorer();
    else if (state.tab === 'data') view.innerHTML = renderData();
    else if (state.tab === 'drift') view.innerHTML = renderDrift();
    else view.innerHTML = renderSql();
  }

  function skeleton() {
    var col = '<div class="pane glass">' + '<div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    return '<div class="sr-only">Loading database schema…</div><div class="panes" aria-busy="true">' + col + col + '</div>';
  }

  var DB_ICON = '<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="1.4" aria-hidden="true">' +
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>';

  function emptyState(title, text) {
    return '<div class="empty glass">' + DB_ICON + '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      '<button class="btn primary" type="button" data-action="open-settings">Connection Settings</button></div>';
  }

  // ─── Explorer ──────────────────────────────────────────────────────────────
  function diffBadges() {
    var map = { dev: {}, prod: {} };
    var d = state.diff;
    if (!d) return map;
    var lower = function (n) { return String(n).toLowerCase(); };
    d.addedTables.forEach(function (t) { map.dev[lower(t.name)] = 'added'; });
    d.alteredTables.forEach(function (t) { map.dev[lower(t.name)] = 'altered'; if (state.diffTargetUsed === 'prod') map.prod[lower(t.name)] = 'altered'; });
    if (state.diffTargetUsed === 'prod') d.droppedTables.forEach(function (t) { map.prod[lower(t.name)] = 'dropped'; });
    return map;
  }

  var BADGE_TEXT = { added: 'NEW TABLE', altered: 'ALTERED', dropped: 'DROPPED' };

  /** IMAGE badge: hover shows a thumbnail tooltip, click opens the media modal. */
  function mediaBadge(t, c) {
    if (!c.isMedia) return '';
    var i = mediaRegistry.push({ table: t.name, field: c.name, type: c.type, media: c.media || null }) - 1;
    return '<button type="button" class="badge badge-media" data-media="' + i + '" aria-label="Preview image field ' + esc(c.name) + '">IMAGE</button>';
  }

  function tableCard(t, badge) {
    var coll = isCollection(t);
    var fkCols = {};
    (t.foreignKeys || []).forEach(function (fk) { fkCols[String(fk.column).toLowerCase()] = fk; });
    var rows = t.columns.map(function (c) {
      var fk = fkCols[String(c.name).toLowerCase()];
      var tags = (c.primaryKey ? '<span class="badge badge-pk">PK</span> ' : '') +
        (fk ? '<span class="badge badge-fk" title="→ ' + esc(fk.referencedTable + '.' + fk.referencedColumn) + '">FK</span> ' : '') +
        (c.isSubcollection ? '<span class="badge badge-subcol">SUBCOLLECTION</span> ' : '') +
        mediaBadge(t, c);
      var typeCell = esc(c.type) + (c.observedTypes ? ' <span class="muted">(' + esc(c.observedTypes.join(' | ')) + ')</span>' : '');
      var lastCell = coll
        ? (c.presence != null ? Math.round(c.presence * 100) + '%' : '<span class="muted">–</span>')
        : (c.default == null ? '<span class="muted">NULL</span>' : esc(c.default));
      return '<tr><td>' + (tags || '<span class="muted">–</span>') + '</td><td class="mono">' + esc(c.name) +
        (fk ? ' <span class="muted">→ ' + esc(fk.referencedTable + '.' + fk.referencedColumn) + '</span>' : '') + '</td><td class="mono">' + typeCell +
        '</td><td>' + (c.nullable ? 'YES' : '<b>NO</b>') + '</td><td class="mono">' + lastCell + '</td></tr>';
    }).join('');
    var idx = (t.indexes || []).length
      ? '<div class="subhead">Indexes</div><ul class="idx-list">' + t.indexes.map(function (i) {
          return '<li><code>' + esc(i.name) + '</code> (' + esc(i.columns.join(', ')) + ')' + (i.unique ? ' <span class="muted">unique</span>' : '') + '</li>';
        }).join('') + '</ul>'
      : '';
    var docMeta = coll && (t.documentCount != null || t.sampledDocuments != null)
      ? '<p class="desc">' + (t.documentCount != null ? '~' + t.documentCount + ' documents' : 'Document count unavailable') +
        (t.sampledDocuments != null ? ' · fields inferred from ' + t.sampledDocuments + ' sampled' : '') + '</p>'
      : '';
    return '<details class="table-card"><summary><span class="tname">' + esc(t.name) + '</span>' +
      (coll ? '<span class="badge badge-collection">COLLECTION</span>' : '') +
      (badge ? '<span class="badge badge-' + badge + '">' + BADGE_TEXT[badge] + '</span>' : '') +
      '<span class="ccount">' + t.columns.length + (coll ? ' fields' : ' cols') + '</span></summary><div class="table-body">' +
      (t.description ? '<p class="desc">' + esc(t.description) + '</p>' : '') + docMeta +
      '<table class="cols"><thead><tr><th scope="col">Key</th><th scope="col">' + (coll ? 'Field' : 'Name') + '</th><th scope="col">Type</th><th scope="col">Nullable</th><th scope="col">' +
      (coll ? 'Presence' : 'Default') + '</th></tr></thead><tbody>' +
      rows + '</tbody></table>' + idx + '</div></details>';
  }

  // ─── Media preview ─────────────────────────────────────────────────────────
  var SOURCE_LABEL = { url: 'Image URL', gcs: 'Cloud Storage URI', base64: 'Base64 string', bytes: 'Binary (Bytes)' };

  function thumbHtml(m) {
    if (m && isPreviewableUrl(m.sampleUrl)) {
      return '<img src="' + esc(m.sampleUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb>';
    }
    var why = !m ? 'No sample available'
      : m.source === 'gcs' ? 'gs:// URIs need a signed URL to preview'
      : (m.source === 'bytes' || m.source === 'base64') ? 'Binary preview withheld (metadata only)'
      : 'No preview available';
    return '<div class="ph">' + esc(why) + '</div>';
  }

  // Swap broken thumbnails (auth-protected URLs or blocked by the page's content policy) for a note.
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-thumb')) {
      var ph = document.createElement('div');
      ph.className = 'ph';
      ph.textContent = 'Preview unavailable (URL needs auth, was redacted, or is blocked by the studio content policy)';
      img.replaceWith(ph);
    }
  }, true);

  function mediaSummary(m) {
    if (!m) return '';
    var parts = [m.mimeType || 'unknown type'];
    if (m.width && m.height) parts.push(m.width + '×' + m.height);
    if (m.sizeBytes != null) parts.push(formatBytes(m.sizeBytes));
    return parts.join(' · ');
  }

  function showThumb(el) {
    var entry = mediaRegistry[Number(el.getAttribute('data-media'))];
    if (!entry) return;
    var pop = $('thumb-pop');
    pop.innerHTML = '<div class="thumb-box">' + thumbHtml(entry.media) + '</div><div class="thumb-meta"><b>' + esc(entry.table + '.' + entry.field) +
      '</b><br>' + esc(mediaSummary(entry.media)) + '</div>';
    pop.hidden = false;
    // Place beside the badge so the field names in the row stay readable; flip left near the edge.
    var r = el.getBoundingClientRect();
    var w = pop.offsetWidth, h = pop.offsetHeight;
    var left = r.right + 12 + w > window.innerWidth ? r.left - w - 12 : r.right + 12;
    var top = Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }

  function hideThumb() {
    var pop = $('thumb-pop');
    if (pop) { pop.hidden = true; pop.innerHTML = ''; }
  }

  function openMedia(index) {
    var entry = mediaRegistry[index];
    if (!entry) return;
    hideThumb();
    var m = entry.media;
    $('media-title').textContent = entry.table + '.' + entry.field;
    $('media-sub').textContent = (m ? SOURCE_LABEL[m.source] || m.source : 'Image field') + ' · ' + entry.type;
    $('media-thumb').innerHTML = thumbHtml(m);
    var rows = [];
    if (m) {
      if (m.sampleUrl) rows.push(['Sample ' + (m.source === 'gcs' ? 'URI' : 'URL'), '<code>' + esc(m.sampleUrl) + '</code>']);
      rows.push(['MIME type', esc(m.mimeType || 'unknown')]);
      rows.push(['Size', esc(m.sizeBytes != null ? formatBytes(m.sizeBytes) : 'unknown')]);
      rows.push(['Dimensions', esc(m.width && m.height ? m.width + ' × ' + m.height + ' px' : 'unknown')]);
      // Base64 is truncated to a short prefix server-side; render it as plain text only.
      if (m.base64Head) rows.push(['Base64 (truncated)', '<code>' + esc(m.base64Head) + '</code>']);
    }
    $('media-details').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>'; }).join('');
    var dlg = $('media-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function paneHtml(env, tables, badges) {
    var s = state.status && state.status[env];
    var title = env === 'dev' ? 'Dev / Staging' : 'Production';
    var q = state.search.trim().toLowerCase();
    var filtered = tables.filter(function (t) {
      if (!q) return true;
      if (t.name.toLowerCase().indexOf(q) !== -1) return true;
      return t.columns.some(function (c) { return c.name.toLowerCase().indexOf(q) !== -1; });
    });
    var body;
    if (!s || !s.connected) {
      body = '<div class="empty" style="padding:28px 12px"><p>' + esc(s && s.error ? s.error : 'No database connected.') + '</p>' +
        '<button class="btn small" type="button" data-action="open-settings">Connect</button></div>';
    } else if (!tables.length) {
      body = '<p class="muted">Connected, but this database has no ' + entityNoun(s, true).toLowerCase() + ' yet.</p>';
    } else if (!filtered.length) {
      body = '<p class="muted">No ' + entityNoun(s, true).toLowerCase() + ' or fields match “' + esc(state.search) + '”.</p>';
    } else {
      body = filtered.map(function (t) { return tableCard(t, badges[t.name.toLowerCase()]); }).join('');
    }
    return '<section class="pane glass" aria-labelledby="pane-' + env + '" data-hidden="' + (state.mobileEnv !== env) + '">' +
      '<div class="pane-head"><h2 id="pane-' + env + '"><span class="dot ' + (s && s.connected ? 'on' : 'off') + '"></span>' + title + '</h2>' +
      '<span class="meta">' + (s && s.connected ? esc(s.maskedUrl) : '') + '</span></div>' + body + '</section>';
  }

  function renderExplorer() {
    var st = state.status || {};
    if (!(st.dev && st.dev.connected) && !(st.prod && st.prod.connected)) {
      return emptyState('No database connected', 'No database connected. Click Connection Settings to connect a local or remote database.');
    }
    var badges = diffBadges();
    var panesHtml = '';
    if (state.envMode === 'dev') {
      panesHtml = '<div class="panes panes-full">' + paneHtml('dev', state.schema.devTables || [], badges.dev) + '</div>';
    } else if (state.envMode === 'prod') {
      panesHtml = '<div class="prod-banner"><span><b>Production Focus Active:</b> Browsing production schema and collections. Any data modifications require challenge phrase confirmation.</span>' +
        '<span class="badge badge-prod">PROD</span></div>' +
        '<div class="panes panes-full">' + paneHtml('prod', state.schema.prodTables || [], badges.prod) + '</div>';
    } else {
      panesHtml = '<div class="panes">' + paneHtml('dev', state.schema.devTables || [], badges.dev) + paneHtml('prod', state.schema.prodTables || [], badges.prod) + '</div>';
    }

    return '<div class="toolbar">' +
      '<label class="sr-only" for="search">Search tables, collections and fields</label>' +
      '<input class="input search" id="search" type="search" placeholder="Search tables, collections or fields…" value="' + esc(state.search) + '">' +
      '</div>' + panesHtml;
  }

  // ─── Live Data Studio ───────────────────────────────────────────────────────
  function renderDataCell(val, colName) {
    if (val === null || val === undefined) return '<td class="mono muted">NULL</td>';
    if (typeof val === 'boolean') return '<td class="mono"><b>' + (val ? 'TRUE' : 'FALSE') + '</b></td>';
    if (typeof val === 'string') {
      var isImgUrl = /^https?:\/\//i.test(val) && /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)/i.test(val);
      var isDataImg = /^data:image\//i.test(val);
      if (isImgUrl || isDataImg) {
        return '<td><button type="button" class="cell-preview-btn" data-action="preview-url" data-url="' + esc(val) + '">Preview Image</button> <span class="mono muted" style="font-size:11px">' + esc(val.length > 28 ? val.slice(0, 28) + '…' : val) + '</span></td>';
      }
      var displayStr = val.length > 50 ? val.slice(0, 50) + '…' : val;
      return '<td class="mono" title="' + esc(val) + '">' + esc(displayStr) + '</td>';
    }
    if (typeof val === 'object') {
      var json = JSON.stringify(val);
      var display = json.length > 40 ? json.slice(0, 40) + '…' : json;
      return '<td class="mono cell-expandable" title="Click to expand JSON" data-action="view-json" data-raw="' + esc(json) + '">' + esc(display) + '</td>';
    }
    return '<td class="mono">' + esc(String(val)) + '</td>';
  }

  function renderData() {
    var activeEnv = state.envMode === 'prod' ? 'prod' : 'dev';
    state.dataEnv = activeEnv;
    var s = state.status && state.status[activeEnv];
    if (!s || !s.connected) {
      return emptyState((activeEnv === 'dev' ? 'Dev / Staging' : 'Production') + ' database not connected',
        'Please connect the ' + (activeEnv === 'dev' ? 'Dev' : 'Prod') + ' database in Connection Settings to browse and edit live data.');
    }

    var tables = state.schema[activeEnv + 'Tables'] || [];
    if (!tables.length) {
      return '<div class="empty glass"><p>No ' + entityNoun(s, true).toLowerCase() + ' found in this database.</p></div>';
    }

    if (!state.dataEntity || !tables.some(function (t) { return t.name === state.dataEntity; })) {
      state.dataEntity = tables[0].name;
    }

    var currentTable = tables.find(function (t) { return t.name === state.dataEntity; }) || tables[0];
    var isColl = isCollection(currentTable);

    var entityOptions = tables.map(function (t) {
      var sel = t.name === state.dataEntity ? ' selected' : '';
      return '<option value="' + esc(t.name) + '"' + sel + '>' + esc(t.name) + (isCollection(t) ? ' (collection)' : '') + '</option>';
    }).join('');

    var limitOptions = [25, 50, 100].map(function (n) {
      var sel = state.dataLimit === n ? ' selected' : '';
      return '<option value="' + n + '"' + sel + '>' + n + ' / page</option>';
    }).join('');

    var prodBannerHtml = activeEnv === 'prod'
      ? '<div class="prod-banner"><span><b>Production Safeguard Active:</b> Operating on live production data. All mutations require strict challenge phrase confirmation and are recorded to .agentj/prod_audit.log.</span><span class="badge badge-prod">PROD</span></div>'
      : '';

    var toolbar = '<div class="data-toolbar">' +
      '<div class="data-controls">' +
        '<select class="input" id="data-entity-select" style="min-width:180px;font-weight:600">' + entityOptions + '</select>' +
        '<input class="input" id="data-search" type="search" placeholder="Search records in ' + esc(state.dataEntity) + '…" value="' + esc(state.dataSearch) + '" style="min-width:200px">' +
        '<select class="input" id="data-limit-select">' + limitOptions + '</select>' +
        '<button class="btn" type="button" id="btn-data-refresh">Refresh</button>' +
      '</div>' +
      '<button class="btn primary" type="button" id="btn-insert-record">+ Insert ' + (isColl ? 'Document' : 'Record') + '</button>' +
    '</div>';

    if (state.dataLoading) {
      return prodBannerHtml + toolbar + '<div class="glass" style="padding:48px 24px;text-align:center"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    }

    if (state.dataError) {
      return prodBannerHtml + toolbar + '<div class="alert-danger" style="margin-top:12px"><strong>Query error:</strong> ' + esc(state.dataError) + '</div>';
    }

    var res = state.dataResult;
    if (!res || !res.rows || res.entity !== state.dataEntity) {
      setTimeout(function () { fetchDataRecords(); }, 10);
      return prodBannerHtml + toolbar + '<div class="glass" style="padding:48px 24px;text-align:center"><p class="muted">Loading records for ' + esc(state.dataEntity) + '…</p></div>';
    }

    var pk = res.primaryKey || 'id';
    var schemaCols = currentTable.columns.map(function (c) { return c.name; });
    var allKeys = new Set(schemaCols);
    res.rows.forEach(function (r) { Object.keys(r).forEach(function (k) { allKeys.add(k); }); });
    var displayCols = [pk];
    allKeys.forEach(function (k) { if (k !== pk) displayCols.push(k); });

    var thead = '<tr><th class="th-actions" style="width:115px">Actions</th>' + displayCols.map(function (col) {
      var isSorted = state.dataSort === col;
      var sortIcon = isSorted ? (state.dataOrder === 'desc' ? ' ▼' : ' ▲') : '';
      return '<th class="sortable" data-sort-col="' + esc(col) + '">' + esc(col) +
        (col === pk ? ' <span class="badge badge-pk">PK</span>' : '') +
        '<span class="th-sort-icon">' + sortIcon + '</span></th>';
    }).join('') + '</tr>';

    var tbody = '';
    if (res.rows.length === 0) {
      tbody = '<tr><td colspan="' + (displayCols.length + 1) + '" style="text-align:center;padding:32px;color:var(--muted)">No records found' +
        (state.dataSearch ? ' matching "' + esc(state.dataSearch) + '"' : '') + '.</td></tr>';
    } else {
      tbody = res.rows.map(function (row, rowIdx) {
        var actions = '<td class="td-actions">' +
          '<button class="btn small" type="button" data-action="edit-record" data-row="' + rowIdx + '">Edit</button>' +
          '<button class="btn small btn-danger" type="button" data-action="delete-record" data-row="' + rowIdx + '">Delete</button>' +
        '</td>';

        var cells = displayCols.map(function (c) {
          return renderDataCell(row[c], c);
        }).join('');

        return '<tr>' + actions + cells + '</tr>';
      }).join('');
    }

    var start = res.totalCount === 0 ? 0 : (res.page - 1) * res.limit + 1;
    var end = Math.min(res.page * res.limit, res.totalCount);
    var pagination = '<div class="pagination-bar">' +
      '<div>Showing ' + start + '–' + end + ' of ' + res.totalCount + ' ' + (isColl ? 'documents' : 'records') + '</div>' +
      '<div class="pagination-ctrls">' +
        '<button class="btn small" type="button" id="btn-page-prev"' + (res.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
        '<span>Page ' + res.page + ' of ' + Math.max(1, res.totalPages) + '</span>' +
        '<button class="btn small" type="button" id="btn-page-next"' + (res.page >= res.totalPages ? ' disabled' : '') + '>Next</button>' +
      '</div>' +
    '</div>';

    return prodBannerHtml + toolbar + '<div class="data-grid-wrap"><table class="data-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' + pagination;
  }

  function fetchDataRecords() {
    if (!state.dataEntity) return;
    state.dataLoading = true;
    state.dataError = null;
    render();

    var params = [
      'env=' + encodeURIComponent(state.dataEnv),
      'entity=' + encodeURIComponent(state.dataEntity),
      'page=' + state.dataPage,
      'limit=' + state.dataLimit
    ];
    if (state.dataSort) params.push('sort=' + encodeURIComponent(state.dataSort));
    if (state.dataOrder) params.push('order=' + encodeURIComponent(state.dataOrder));
    if (state.dataSearch) params.push('search=' + encodeURIComponent(state.dataSearch));

    api('/api/data?' + params.join('&')).then(function (res) {
      state.dataResult = res;
      state.dataLoading = false;
      render();
    }, function (err) {
      state.dataError = err.message;
      state.dataLoading = false;
      render();
    });
  }

  function openInsertRecordModal() {
    var tables = state.schema[state.dataEnv + 'Tables'] || [];
    var table = tables.find(function (t) { return t.name === state.dataEntity; }) || { columns: [] };
    var isColl = isCollection(table);

    $('record-title').textContent = 'Insert ' + (isColl ? 'Document' : 'Record') + ' into ' + state.dataEntity;
    $('record-lead').textContent = 'Target Environment: ' + state.dataEnv.toUpperCase() + '. Specify column values below:';
    $('btn-save-record').textContent = 'Insert ' + (isColl ? 'Document' : 'Record');
    state.editingPk = null;

    var html = '';
    table.columns.forEach(function (col) {
      var isPk = col.primaryKey;
      var fieldLabel = esc(col.name) + (isPk ? ' (Primary Key - Optional/Auto)' : '');
      var placeholder = col.type + (col.default ? ' · default: ' + col.default : '');
      var isLong = /json|map|array|text/i.test(col.type);
      if (isLong) {
        html += '<div class="field field-full"><label><b>' + fieldLabel + '</b></label><textarea class="input" name="' + esc(col.name) + '" placeholder="' + esc(placeholder) + '"></textarea></div>';
      } else {
        html += '<div class="field"><label><b>' + fieldLabel + '</b></label><input class="input" type="text" name="' + esc(col.name) + '" placeholder="' + esc(placeholder) + '"></div>';
      }
    });
    $('record-fields').innerHTML = html || '<p class="muted">No schema columns defined.</p>';

    var dlg = $('record-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function openEditRecordModal(rowIndex) {
    if (!state.dataResult || !state.dataResult.rows[rowIndex]) return;
    var row = state.dataResult.rows[rowIndex];
    var pkCol = state.dataResult.primaryKey || 'id';
    var pkVal = row[pkCol];
    state.editingPk = pkVal;

    var tables = state.schema[state.dataEnv + 'Tables'] || [];
    var table = tables.find(function (t) { return t.name === state.dataEntity; }) || { columns: [] };
    var isColl = isCollection(table);

    $('record-title').textContent = 'Edit ' + (isColl ? 'Document' : 'Record') + ' (' + pkCol + ' = ' + pkVal + ')';
    $('record-lead').textContent = 'Target Environment: ' + state.dataEnv.toUpperCase() + '. Primary key is locked for single-record isolation:';
    $('btn-save-record').textContent = 'Save Changes';

    var html = '';
    html += '<div class="field field-full"><label><b>' + esc(pkCol) + ' (Primary Key - Locked)</b></label><input class="input" type="text" name="' + esc(pkCol) + '" value="' + esc(pkVal) + '" disabled style="opacity:.65"></div>';

    var displayedCols = new Set([pkCol]);
    table.columns.forEach(function (col) {
      if (col.name === pkCol) return;
      displayedCols.add(col.name);
      var val = row[col.name];
      var valStr = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
      var isLong = /json|map|array|text/i.test(col.type) || valStr.length > 50;
      if (isLong) {
        html += '<div class="field field-full"><label><b>' + esc(col.name) + ' (' + esc(col.type) + ')</b></label><textarea class="input" name="' + esc(col.name) + '">' + esc(valStr) + '</textarea></div>';
      } else {
        html += '<div class="field"><label><b>' + esc(col.name) + ' (' + esc(col.type) + ')</b></label><input class="input" type="text" name="' + esc(col.name) + '" value="' + esc(valStr) + '"></div>';
      }
    });

    Object.keys(row).forEach(function (k) {
      if (displayedCols.has(k)) return;
      var val = row[k];
      var valStr = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
      html += '<div class="field"><label><b>' + esc(k) + '</b></label><input class="input" type="text" name="' + esc(k) + '" value="' + esc(valStr) + '"></div>';
    });

    $('record-fields').innerHTML = html;
    var dlg = $('record-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function parseInputValue(raw) {
    if (raw === '') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
    if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
  }

  function handleSaveRecordSubmit() {
    var form = $('record-form');
    var inputs = form.querySelectorAll('input, textarea');
    var data = {};
    inputs.forEach(function (inp) {
      if (inp.name && !inp.disabled) {
        var v = inp.value.trim();
        if (v !== '') data[inp.name] = parseInputValue(v);
      }
    });

    if (state.editingPk !== null) {
      dispatchMutation('UPDATE', state.dataEntity, state.editingPk, { updates: data });
    } else {
      dispatchMutation('INSERT', state.dataEntity, null, { record: data });
    }
  }

  function handleDeleteRecord(rowIndex) {
    if (!state.dataResult || !state.dataResult.rows[rowIndex]) return;
    var row = state.dataResult.rows[rowIndex];
    var pkCol = state.dataResult.primaryKey || 'id';
    var pkVal = row[pkCol];
    if (pkVal === undefined || pkVal === null) return;

    if (state.dataEnv === 'prod') {
      dispatchMutation('DELETE', state.dataEntity, pkVal, {});
    } else {
      if (window.confirm('Delete record ' + pkVal + ' from ' + state.dataEntity + '?')) {
        api('/api/data', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: state.dataEnv, entity: state.dataEntity, primaryKey: pkVal })
        }).then(function () {
          toast('Record deleted successfully', 'ok');
          fetchDataRecords();
        }, function (err) {
          toast('Delete failed: ' + err.message);
        });
      }
    }
  }

  function dispatchMutation(action, entity, pk, payload) {
    if (state.dataEnv === 'prod') {
      state.pendingMutation = { action: action, entity: entity, pk: pk, payload: payload };
      $('challenge-desc').textContent = 'Action: ' + action + ' on entity "' + entity + '"' + (pk != null ? ' (PK: ' + pk + ')' : '') + '.';
      $('challenge-target-name').textContent = entity;
      var input = $('challenge-input');
      input.value = '';
      $('btn-confirm-challenge').disabled = true;

      var dlg = $('challenge-dialog');
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
      input.focus();
    } else {
      executeMutationDirect(action, entity, pk, payload, false, '');
    }
  }

  function executeMutationDirect(action, entity, pk, payload, confirmProd, challengePhrase) {
    var method = action === 'INSERT' ? 'POST' : action === 'UPDATE' ? 'PUT' : 'DELETE';
    var body = Object.assign({
      env: state.dataEnv,
      entity: entity
    }, payload);
    if (pk != null) body.primaryKey = pk;
    if (confirmProd) {
      body.confirmProd = true;
      body.challengePhrase = challengePhrase;
    }

    api('/api/data', {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () {
      if (confirmProd) {
        toast('Production ' + action.toLowerCase() + ' executed. Logged to .agentj/prod_audit.log', 'ok');
        $('challenge-dialog').close();
      } else {
        toast(action + ' executed successfully', 'ok');
      }
      $('record-dialog').close();
      fetchDataRecords();
    }, function (err) {
      toast(action + ' failed: ' + err.message);
    });
  }

  // ─── Drift ─────────────────────────────────────────────────────────────────
  function riskLevel(d) {
    var s = d.summary;
    if (s.hasDestructiveChanges || s.droppedTablesCount > 0) return 'HIGH';
    if (s.alteredTablesCount > 0) return 'MEDIUM';
    if (s.addedTablesCount > 0) return 'LOW';
    return 'NONE';
  }

  function targetSelect() {
    return '<div class="toolbar"><label for="diff-target" class="muted">Compare Dev against</label>' +
      '<select class="input" id="diff-target"><option value="prod"' + (state.diffTarget === 'prod' ? ' selected' : '') + '>Production database</option>' +
      '<option value="contract"' + (state.diffTarget === 'contract' ? ' selected' : '') + '>.ai/db_schema.json contract</option></select></div>';
  }

  function colCell(c) {
    if (!c) return '<span class="muted">—</span>';
    return esc(c.type) + (c.nullable ? '' : ' NOT NULL') + (c.default != null ? ' <span class="muted">DEFAULT</span> ' + esc(c.default) : '') +
      (c.primaryKey ? ' <span class="badge badge-pk">PK</span>' : '') + (c.isMedia ? ' <span class="badge badge-media">IMAGE</span>' : '') +
      (c.isSubcollection ? ' <span class="badge badge-subcol">SUBCOLLECTION</span>' : '');
  }

  function alteredTableHtml(t) {
    var targetLabel = state.diffTargetUsed === 'contract' ? 'Contract' : 'Prod';
    var rows = [];
    t.addedColumns.forEach(function (c) { rows.push('<tr class="row-added"><td class="mono">' + esc(c.name) + '</td><td><span class="badge badge-added">ADDED</span></td><td class="before mono">' + colCell(null) + '</td><td class="after mono">' + colCell(c) + '</td></tr>'); });
    t.alteredColumns.forEach(function (ch) { rows.push('<tr class="row-altered"><td class="mono">' + esc(ch.name) + '</td><td><span class="badge badge-altered">' + esc(ch.changedFields.join(', ').toUpperCase()) + '</span></td><td class="before mono">' + colCell(ch.before) + '</td><td class="after mono">' + colCell(ch.after) + '</td></tr>'); });
    t.droppedColumns.forEach(function (c) { rows.push('<tr class="row-dropped"><td class="mono">' + esc(c.name) + '</td><td><span class="badge badge-dropped">DROPPED</span></td><td class="before mono">' + colCell(c) + '</td><td class="after mono">' + colCell(null) + '</td></tr>'); });
    var extras = [];
    t.addedIndexes.forEach(function (i) { extras.push('<span class="chip" style="border-color:var(--success)">+ index ' + esc(i.name) + '</span>'); });
    t.droppedIndexes.forEach(function (i) { extras.push('<span class="chip" style="border-color:var(--danger)">− index ' + esc(i.name) + '</span>'); });
    t.addedForeignKeys.forEach(function (f) { extras.push('<span class="chip" style="border-color:var(--success)">+ FK ' + esc(f.column + ' → ' + f.referencedTable + '.' + f.referencedColumn) + '</span>'); });
    t.droppedForeignKeys.forEach(function (f) { extras.push('<span class="chip" style="border-color:var(--danger)">− FK ' + esc(f.column + ' → ' + f.referencedTable + '.' + f.referencedColumn) + '</span>'); });
    return '<details class="table-card" open><summary><span class="tname">' + esc(t.name) + '</span><span class="badge badge-altered">ALTERED</span>' +
      (t.isDestructive ? '<span class="badge badge-dropped">DESTRUCTIVE</span>' : '') + '</summary><div class="table-body">' +
      (rows.length ? '<table class="cols diff-table"><thead><tr><th scope="col">Column</th><th scope="col">Change</th><th scope="col">' + targetLabel + ' (before)</th><th scope="col">Dev (after)</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>' : '') +
      (extras.length ? '<div class="subhead">Indexes &amp; constraints</div><div class="chip-list">' + extras.join('') + '</div>' : '') + '</div></details>';
  }

  function renderDrift() {
    if (!state.diff) {
      return targetSelect() + emptyState('Drift unavailable', state.diffError || 'Connect both databases to compute schema drift.');
    }
    var d = state.diff, s = d.summary, risk = riskLevel(d);
    var targetLabel = state.diffTargetUsed === 'contract' ? 'the contract' : 'Prod';
    var noun = driftNoun(true);
    var html = targetSelect() + '<div class="summary-banner glass" role="region" aria-label="Drift summary">' +
      '<div class="stat"><div class="n" style="color:var(--success)">' + s.addedTablesCount + '</div><div class="l">Added ' + noun + '</div></div>' +
      '<div class="stat"><div class="n" style="color:var(--warning)">' + s.alteredTablesCount + '</div><div class="l">Altered ' + noun + '</div></div>' +
      '<div class="stat"><div class="n" style="color:var(--danger)">' + s.droppedTablesCount + '</div><div class="l">Dropped ' + noun + '</div></div>' +
      '<div class="stat"><div class="n muted">' + s.unchangedTablesCount + '</div><div class="l">Unchanged</div></div>' +
      '<div class="stat"><div class="n risk-' + risk + '">' + risk + '</div><div class="l">Risk level</div></div></div>';

    if (!s.addedTablesCount && !s.alteredTablesCount && !s.droppedTablesCount) {
      return html + '<div class="empty glass"><h3>In sync</h3><p>Dev matches ' + esc(targetLabel) + '. No drift detected.</p></div>';
    }

    if (d.addedTables.length) {
      html += '<section class="section glass"><h3><span class="badge badge-added">NEW TABLE</span> Added in Dev (' + d.addedTables.length + ')</h3>' +
        d.addedTables.map(function (t) { return tableCard(t, 'added'); }).join('') + '</section>';
    }
    if (d.alteredTables.length) {
      html += '<section class="section glass"><h3><span class="badge badge-altered">ALTERED</span> Altered ' + noun + ' (' + d.alteredTables.length + ')</h3>' +
        d.alteredTables.map(alteredTableHtml).join('') + '</section>';
    }
    if (d.droppedTables.length) {
      html += '<section class="section glass"><h3><span class="badge badge-dropped">DROPPED</span> Dropped in Dev (' + d.droppedTables.length + ')</h3>' +
        '<div class="alert-danger" role="alert"><strong>High severity:</strong> these ' + noun + ' exist in ' + esc(targetLabel) +
        ' but not in Dev. Applying this migration would permanently delete them and all their data.</div>' +
        d.droppedTables.map(function (t) { return tableCard(t, 'dropped'); }).join('') + '</section>';
    }
    return html;
  }

  // ─── Migration script (SQL DDL / MongoDB shell / Firestore index JSON) ─────
  function sqlDialect() {
    var st = state.status || {};
    if (state.diffTargetUsed === 'prod' && st.prod && st.prod.connected) return st.prod.engine;
    return (st.dev && st.dev.engine) || 'postgresql';
  }

  function generateScript(d) {
    var dialect = sqlDialect();
    if (dialect === 'mongodb') { var js = generateMongo(d); return { text: js, lang: 'js', count: countStatements(js, 'js') }; }
    if (dialect === 'firestore') return generateFirestore(d);
    var sql = generateSql(d);
    return { text: sql, lang: 'sql', count: countStatements(sql, 'sql') };
  }

  function generateMongo(d) {
    var target = state.diffTargetUsed === 'contract' ? '.ai/db_schema.json' : 'Prod';
    var coll = function (name) { return 'db.getCollection(' + JSON.stringify(name) + ')'; };
    var keySpec = function (i) {
      return '{ ' + i.columns.map(function (c) { return JSON.stringify(c) + ': 1'; }).join(', ') + ' }';
    };
    var createIdx = function (t, i) {
      return coll(t) + '.createIndex(' + keySpec(i) + ', { name: ' + JSON.stringify(i.name) + (i.unique ? ', unique: true' : '') + ' });';
    };
    var out = [
      '// AgentJ migration preview: Dev → ' + target + ' (MongoDB shell)',
      '// Generated from structural metadata only. Review carefully; nothing is executed automatically.',
      ''
    ];

    d.addedTables.forEach(function (t) {
      out.push('// [NEW COLLECTION] ' + t.name);
      out.push('db.createCollection(' + JSON.stringify(t.name) + ');');
      (t.indexes || []).forEach(function (i) { out.push(createIdx(t.name, i)); });
      out.push('');
    });

    d.alteredTables.forEach(function (t) {
      out.push('// [ALTERED] ' + t.name + (t.isDestructive ? '  [DESTRUCTIVE]' : ''));
      t.droppedIndexes.forEach(function (i) { out.push(coll(t.name) + '.dropIndex(' + JSON.stringify(i.name) + ');'); });
      t.addedColumns.forEach(function (c) {
        if (c.isSubcollection) { out.push('// + subcollection ' + JSON.stringify(c.name) + ' (Firestore-only concept; model as a separate collection or embedded array in MongoDB)'); return; }
        out.push('// + field ' + JSON.stringify(c.name) + ' (' + c.type + '): schemaless, no DDL needed. Optional backfill:');
        out.push('// ' + coll(t.name) + '.updateMany({ ' + JSON.stringify(c.name) + ': { $exists: false } }, { $set: { ' + JSON.stringify(c.name) + ': null } });');
      });
      t.alteredColumns.forEach(function (ch) {
        out.push('// ~ field ' + JSON.stringify(ch.name) + ': ' + ch.before.type + ' → ' + ch.after.type + ' (' + ch.changedFields.join(', ') + '); convert existing values with a data migration.');
      });
      t.droppedColumns.forEach(function (c) {
        out.push('// [DESTRUCTIVE] removes field data from every document');
        out.push(coll(t.name) + '.updateMany({}, { $unset: { ' + JSON.stringify(c.name) + ': "" } });');
      });
      t.addedIndexes.forEach(function (i) { out.push(createIdx(t.name, i)); });
      out.push('');
    });

    d.droppedTables.forEach(function (t) {
      out.push('// [DESTRUCTIVE: DROPPED] ' + t.name + ': permanently deletes the collection and all documents');
      out.push(coll(t.name) + '.drop();');
      out.push('');
    });

    if (!d.addedTables.length && !d.alteredTables.length && !d.droppedTables.length) out.push('// No schema drift. Nothing to migrate.');
    return out.join('\n').replace(/\n+$/, '\n');
  }

  /** Firestore: deployable index definitions (firestore.indexes.json shape) plus a list of data-migration steps. */
  function generateFirestore(d) {
    var target = state.diffTargetUsed === 'contract' ? '.ai/db_schema.json' : 'Prod';
    var indexes = [], fieldOverrides = [], steps = [], warnings = [];
    var addIndex = function (collection, i) {
      if (i.unique) warnings.push('Firestore has no unique indexes: enforce uniqueness of ' + collection + '.' + i.columns.join('+') + ' (' + i.name + ') in application code or security rules.');
      if (i.columns.length > 1) {
        indexes.push({ collectionGroup: collection, queryScope: 'COLLECTION', fields: i.columns.map(function (f) { return { fieldPath: f, order: 'ASCENDING' }; }) });
      } else if (i.columns.length === 1) {
        fieldOverrides.push({ collectionGroup: collection, fieldPath: i.columns[0], indexes: [{ order: 'ASCENDING', queryScope: 'COLLECTION' }] });
      }
    };

    d.addedTables.forEach(function (t) {
      steps.push({ op: 'createCollection', collection: t.name, note: 'Collections are created implicitly by the first document write.' });
      (t.indexes || []).forEach(function (i) { addIndex(t.name, i); });
    });
    d.alteredTables.forEach(function (t) {
      t.addedColumns.forEach(function (c) {
        steps.push(c.isSubcollection
          ? { op: 'addSubcollection', collection: t.name, subcollection: c.name }
          : { op: 'addField', collection: t.name, field: c.name, type: c.type });
      });
      t.alteredColumns.forEach(function (ch) { steps.push({ op: 'changeField', collection: t.name, field: ch.name, from: ch.before.type, to: ch.after.type, changed: ch.changedFields }); });
      t.droppedColumns.forEach(function (c) { steps.push({ op: 'deleteField', collection: t.name, field: c.name, destructive: true }); });
      t.addedIndexes.forEach(function (i) { addIndex(t.name, i); });
      t.droppedIndexes.forEach(function (i) { steps.push({ op: 'removeIndex', collection: t.name, index: i.name, fields: i.columns }); });
    });
    d.droppedTables.forEach(function (t) {
      steps.push({ op: 'deleteCollection', collection: t.name, destructive: true, note: 'Permanently deletes every document (e.g. firebase firestore:delete --recursive).' });
    });

    var doc = {
      _agentj: 'Preview Dev → ' + target + ' (Firestore). Nothing runs automatically.',
      _deploy: 'indexes + fieldOverrides: firebase deploy --only firestore:indexes; dataMigrations: apply with a script',
      indexes: indexes,
      fieldOverrides: fieldOverrides,
      dataMigrations: steps
    };
    if (warnings.length) doc.warnings = warnings;
    return { text: JSON.stringify(doc, null, 2) + '\n', lang: 'json', count: indexes.length + fieldOverrides.length + steps.length };
  }

  function generateSql(d) {
    var dialect = sqlDialect();
    var BT = String.fromCharCode(96);
    var q = function (name) {
      return dialect === 'mysql' ? BT + String(name).split(BT).join(BT + BT) + BT : '"' + String(name).split('"').join('""') + '"';
    };
    var colDef = function (c) { return q(c.name) + ' ' + c.type + (c.nullable ? '' : ' NOT NULL') + (c.default != null ? ' DEFAULT ' + c.default : ''); };
    var fkDef = function (f) { return 'CONSTRAINT ' + q(f.name) + ' FOREIGN KEY (' + q(f.column) + ') REFERENCES ' + q(f.referencedTable) + ' (' + q(f.referencedColumn) + ')' + (f.onDelete ? ' ON DELETE ' + f.onDelete : ''); };
    var idxDef = function (t, i) { return 'CREATE ' + (i.unique ? 'UNIQUE ' : '') + 'INDEX ' + q(i.name) + ' ON ' + q(t) + ' (' + i.columns.map(q).join(', ') + ');'; };
    var dropIdx = function (t, i) { return dialect === 'mysql' ? 'DROP INDEX ' + q(i.name) + ' ON ' + q(t) + ';' : 'DROP INDEX ' + q(i.name) + ';'; };
    var target = state.diffTargetUsed === 'contract' ? '.ai/db_schema.json' : 'Prod';
    var out = [
      '-- AgentJ migration preview: Dev → ' + target + ' (' + (ENGINE_LABEL[dialect] || dialect) + ' dialect)',
      '-- Generated from structural metadata only. Review carefully; nothing is executed automatically.',
      ''
    ];

    d.addedTables.forEach(function (t) {
      var lines = t.columns.map(function (c) { return '  ' + colDef(c); });
      var pks = t.columns.filter(function (c) { return c.primaryKey; }).map(function (c) { return q(c.name); });
      if (pks.length) lines.push('  PRIMARY KEY (' + pks.join(', ') + ')');
      (t.foreignKeys || []).forEach(function (f) { lines.push('  ' + fkDef(f)); });
      out.push('-- [NEW TABLE] ' + t.name);
      out.push('CREATE TABLE ' + q(t.name) + ' (\n' + lines.join(',\n') + '\n);');
      (t.indexes || []).forEach(function (i) { out.push(idxDef(t.name, i)); });
      out.push('');
    });

    d.alteredTables.forEach(function (t) {
      var T = 'ALTER TABLE ' + q(t.name) + ' ';
      out.push('-- [ALTERED] ' + t.name + (t.isDestructive ? '  [DESTRUCTIVE]' : ''));
      t.droppedForeignKeys.forEach(function (f) {
        if (dialect === 'sqlite') out.push('-- SQLite cannot drop constraints in place; rebuild ' + t.name + ' to remove FK ' + f.name);
        else out.push(T + (dialect === 'mysql' ? 'DROP FOREIGN KEY ' : 'DROP CONSTRAINT ') + q(f.name) + ';');
      });
      t.droppedIndexes.forEach(function (i) { out.push(dropIdx(t.name, i)); });
      t.addedColumns.forEach(function (c) { out.push(T + 'ADD COLUMN ' + colDef(c) + ';'); });
      t.alteredColumns.forEach(function (ch) {
        var c = ch.after, f = ch.changedFields;
        if (dialect === 'mysql') { out.push(T + 'MODIFY COLUMN ' + colDef(c) + ';'); return; }
        if (dialect === 'sqlite') { out.push('-- SQLite cannot ALTER COLUMN ' + t.name + '.' + c.name + ' (' + f.join(', ') + '); a table rebuild is required.'); return; }
        if (f.indexOf('type') !== -1) out.push(T + 'ALTER COLUMN ' + q(c.name) + ' TYPE ' + c.type + ' USING ' + q(c.name) + '::' + c.type + ';');
        if (f.indexOf('nullable') !== -1) out.push(T + 'ALTER COLUMN ' + q(c.name) + (c.nullable ? ' DROP NOT NULL;' : ' SET NOT NULL;'));
        if (f.indexOf('default') !== -1) out.push(T + 'ALTER COLUMN ' + q(c.name) + (c.default == null ? ' DROP DEFAULT;' : ' SET DEFAULT ' + c.default + ';'));
        if (f.indexOf('primaryKey') !== -1) out.push('-- Primary key membership changed for ' + t.name + '.' + c.name + '; recreate the PRIMARY KEY constraint manually.');
      });
      t.droppedColumns.forEach(function (c) { out.push('-- [DESTRUCTIVE] drops column data'); out.push(T + 'DROP COLUMN ' + q(c.name) + ';'); });
      t.addedIndexes.forEach(function (i) { out.push(idxDef(t.name, i)); });
      t.addedForeignKeys.forEach(function (f) {
        if (dialect === 'sqlite') out.push('-- SQLite cannot add constraints in place; rebuild ' + t.name + ' to add FK ' + f.column + ' → ' + f.referencedTable);
        else out.push(T + 'ADD ' + fkDef(f) + ';');
      });
      out.push('');
    });

    d.droppedTables.forEach(function (t) {
      out.push('-- [DESTRUCTIVE: DROPPED] ' + t.name + ': permanently deletes the table and all rows');
      out.push('DROP TABLE ' + q(t.name) + ';');
      out.push('');
    });

    if (!d.addedTables.length && !d.alteredTables.length && !d.droppedTables.length) out.push('-- No schema drift. Nothing to migrate.');
    return out.join('\n').replace(/\n+$/, '\n');
  }

  function countStatements(text, lang) {
    if (!text) return 0;
    var comment = lang === 'js' ? /^\s*\/\// : /^\s*--/;
    return text.split('\n').filter(function (l) { return /;\s*$/.test(l) && !comment.test(l); }).length;
  }

  var JS_TOKEN = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")|\b(db|getCollection|createCollection|createIndex|dropIndex|updateMany|drop|true|false|null)\b|(\$[A-Za-z]+)/g;
  var JSON_TOKEN = /("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;

  function highlightScript(text, lang) {
    if (lang === 'sql') return highlightSql(text);
    var html = esc(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (lang === 'js') {
      return html.replace(JS_TOKEN, function (m, comment, str, kw, op) {
        if (comment) return '<span class="' + (/DESTRUCTIVE/.test(comment) ? 'd' : 'c') + '">' + comment + '</span>';
        if (str) return '<span class="s">' + str + '</span>';
        if (kw) return '<span class="k">' + kw + '</span>';
        return '<span class="o">' + op + '</span>';
      });
    }
    return html.replace(JSON_TOKEN, function (m, str, colon, lit, num) {
      if (str) return colon ? '<span class="p">' + str + '</span>' + colon : '<span class="' + (/deleteField|deleteCollection/.test(str) ? 'd' : 's') + '">' + str + '</span>';
      if (lit) return '<span class="' + (lit === 'true' ? 'n' : 'k') + '">' + lit + '</span>';
      return '<span class="n">' + num + '</span>';
    });
  }

  var LANG_LABEL = { sql: 'SQL DDL', js: 'MongoDB Shell', json: 'Firestore Index JSON' };

  var SQL_TOKEN = /(--[^\n]*)|('(?:[^']|'')*')|\b(CREATE|TABLE|ALTER|ADD|DROP|COLUMN|CONSTRAINT|PRIMARY|FOREIGN|KEY|REFERENCES|ON|DELETE|INDEX|UNIQUE|NOT|NULL|DEFAULT|SET|TYPE|USING|MODIFY|CASCADE|RESTRICT|NO|ACTION)\b/g;

  function highlightSql(sql) {
    return esc(sql).replace(/&#39;/g, "'").replace(SQL_TOKEN, function (m, comment, str, kw) {
      if (comment) return '<span class="' + (/DESTRUCTIVE/.test(comment) ? 'd' : 'c') + '">' + comment + '</span>';
      if (str) return '<span class="s">' + str + '</span>';
      return '<span class="k">' + kw + '</span>';
    });
  }

  function renderSql() {
    if (!state.diff) return emptyState('No migration to preview', state.diffError || 'Connect Dev and Prod to generate a migration script.');
    var destructive = state.diff.summary.hasDestructiveChanges;
    var lang = state.scriptLang;
    var unit = lang === 'json' ? ' change(s)' : ' statement(s)';
    return '<div class="sql-wrap glass"><div class="sql-head"><span class="muted"><span class="lang">' + LANG_LABEL[lang] + '</span>' +
      (destructive ? '<span class="badge badge-dropped">DESTRUCTIVE</span> ' : '') + state.scriptCount + unit + ' · read-only preview</span>' +
      '<span class="copy-wrap"><span class="tooltip">Copied!</span><button class="btn small" type="button" data-action="copy-sql">Copy ' +
      (lang === 'sql' ? 'SQL' : lang === 'js' ? 'Script' : 'JSON') + '</button></span></div>' +
      '<pre class="sql" tabindex="0" aria-label="Migration script (' + LANG_LABEL[lang] + ')"><code>' + highlightScript(state.sql, lang) + '</code></pre></div>';
  }

  // ─── Connection modal ──────────────────────────────────────────────────────
  function renderModalStatus() {
    ['dev', 'prod'].forEach(function (env) {
      var s = state.status && state.status[env];
      $('mdot-' + env).className = 'dot ' + (s && s.connected ? 'on' : 'off');
      $('current-' + env).innerHTML = s && s.maskedUrl
        ? 'Current: <code>' + esc(s.maskedUrl) + '</code><span class="copy-wrap"><span class="tooltip">Copied!</span><button class="btn small" type="button" data-copy-masked="' + env + '">Copy</button></span>'
        : 'Current: <span class="muted">not configured</span>';
    });
  }

  function openSettings() {
    renderModalStatus();
    ['dev', 'prod'].forEach(function (env) { $('result-' + env).textContent = ''; $('result-' + env).className = 'result'; });
    var dlg = $('conn-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function isFirestoreMode(env) { return $('engine-' + env).value === 'firestore'; }

  function setEngineMode(env) {
    var fs = isFirestoreMode(env);
    $('url-' + env).hidden = fs;
    document.querySelector('[data-toggle="' + env + '"]').hidden = fs;
    $('fsproject-' + env).hidden = !fs;
    $('fsemu-' + env).hidden = !fs;
    $('result-' + env).textContent = '';
  }

  function hasInput(env) {
    return isFirestoreMode(env) ? !!$('fsproject-' + env).value.trim() : !!$('url-' + env).value.trim();
  }

  /** Builds the /api/connect body. Firestore is sent as a firestore:// URL plus the contract's firestoreConfig. */
  function connectBody(env) {
    if (!isFirestoreMode(env)) {
      var url = $('url-' + env).value.trim();
      return url ? { body: { env: env, connectionUrl: url } } : { error: 'Enter a connection string first.' };
    }
    var projectId = $('fsproject-' + env).value.trim();
    var emulatorHost = $('fsemu-' + env).value.trim();
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(projectId)) return { error: 'Enter a valid Firestore project ID (lowercase letters, digits, hyphens).' };
    if (emulatorHost && !/^[A-Za-z0-9.\-\[\]:]+:\d{2,5}$/.test(emulatorHost)) return { error: 'Emulator host must look like localhost:8080.' };
    var firestoreUrl = 'firestore://' + encodeURIComponent(projectId) + (emulatorHost ? '?emulator=' + emulatorHost : '');
    var config = { projectId: projectId };
    if (emulatorHost) config.emulatorHost = emulatorHost;
    return { body: { env: env, engine: 'firestore', connectionUrl: firestoreUrl, firestoreConfig: config } };
  }

  function ping(env) {
    var out = $('result-' + env);
    var req = connectBody(env);
    if (req.error) { out.className = 'result err'; out.textContent = req.error; return Promise.resolve(false); }
    out.className = 'result'; out.textContent = 'Testing connection…';
    return postJson('/api/connect', req.body).then(function (r) {
      if (r.success) {
        var count = r.entityCount != null ? r.entityCount : r.tableCount;
        out.className = 'result ok';
        out.textContent = 'Connected to ' + (ENGINE_LABEL[r.engine] || r.engine) + ' in ' + Math.round(r.pingMs) + 'ms · ' + count + ' ' +
          entityNoun({ engine: r.engine }, true).toLowerCase() + ' · saved to session as ' + r.maskedUrl;
        $('url-' + env).value = '';
        return true;
      }
      out.className = 'result err';
      out.textContent = 'Error: ' + (r.error || 'Connection failed');
      var hint = hintFor(r.error);
      if (hint) out.textContent += ' — ' + hint;
      return false;
    }, function (e) {
      out.className = 'result err'; out.textContent = 'Error: ' + e.message; return false;
    });
  }

  // ─── Events ────────────────────────────────────────────────────────────────
  function setTab(tab, focus) {
    state.tab = tab;
    render();
    if (focus) $('tab-' + tab).focus();
    if (tab === 'data' && (!state.dataResult || state.dataResult.entity !== state.dataEntity)) {
      fetchDataRecords();
    }
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { setTab(t.getAttribute('data-tab')); });
    t.addEventListener('keydown', function (e) {
      var order = ['explorer', 'data', 'drift', 'sql'];
      var i = order.indexOf(state.tab);
      if (e.key === 'ArrowRight') { e.preventDefault(); setTab(order[(i + 1) % 4], true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(order[(i + 3) % 4], true); }
      else if (e.key === 'Home') { e.preventDefault(); setTab('explorer', true); }
      else if (e.key === 'End') { e.preventDefault(); setTab('sql', true); }
    });
  });

  document.querySelectorAll('.env-seg-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-env-mode');
      if (mode) {
        state.envMode = mode;
        if (mode === 'prod') state.dataEnv = 'prod';
        else if (mode === 'dev') state.dataEnv = 'dev';
        state.dataResult = null;
        render();
        if (state.tab === 'data') fetchDataRecords();
      }
    });
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-refresh').addEventListener('click', function () { load(true); });
  $('btn-export').addEventListener('click', function () {
    var btn = $('btn-export');
    var st = state.status || {};
    var sourceEnv = st.dev && st.dev.connected ? 'dev' : (st.prod && st.prod.connected ? 'prod' : 'dev');
    if (!window.confirm('Export the ' + sourceEnv.toUpperCase() + ' schema (structure only, no credentials or data) to .ai/db_schema.json?\nThis overwrites the tables in the current contract.')) return;
    btn.disabled = true;
    postJson('/api/export-contract', { sourceEnv: sourceEnv }).then(function (r) {
      var n = r.exportedEntitiesCount != null ? r.exportedEntitiesCount : r.exportedTablesCount;
      toast('Exported ' + n + ' ' + entityNoun(st[sourceEnv], true).toLowerCase() + ' to ' + r.filePath, 'ok');
      if (state.diffTarget === 'contract') load(true);
    }, function (e) { toast('Export failed: ' + e.message); }).then(function () { btn.disabled = false; });
  });

  $('view').addEventListener('input', function (e) {
    if (e.target && e.target.id === 'search') {
      state.search = e.target.value;
      var pos = e.target.selectionStart;
      render();
      var s = $('search');
      if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
    if (e.target && e.target.id === 'data-search') {
      state.dataSearch = e.target.value;
      clearTimeout(state._dataSearchTimeout);
      state._dataSearchTimeout = setTimeout(function () {
        state.dataPage = 1;
        fetchDataRecords();
      }, 350);
    }
  });

  $('view').addEventListener('change', function (e) {
    if (e.target && e.target.id === 'diff-target') { state.diffTarget = e.target.value; load(false); }
    if (e.target && e.target.id === 'data-entity-select') {
      state.dataEntity = e.target.value;
      state.dataPage = 1;
      state.dataSort = '';
      state.dataSearch = '';
      state.dataResult = null;
      fetchDataRecords();
    }
    if (e.target && e.target.id === 'data-limit-select') {
      state.dataLimit = Number(e.target.value);
      state.dataPage = 1;
      fetchDataRecords();
    }
  });

  $('view').addEventListener('mouseover', function (e) {
    var el = e.target.closest && e.target.closest('[data-media]');
    if (el) showThumb(el);
  });
  $('view').addEventListener('mouseout', function (e) {
    var el = e.target.closest && e.target.closest('[data-media]');
    if (el && !el.contains(e.relatedTarget)) hideThumb();
  });
  $('view').addEventListener('focusin', function (e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-media')) showThumb(e.target);
  });
  $('view').addEventListener('focusout', hideThumb);
  window.addEventListener('scroll', hideThumb, { passive: true });

  $('view').addEventListener('click', function (e) {
    var sortTh = e.target.closest('th.sortable');
    if (sortTh) {
      var col = sortTh.getAttribute('data-sort-col');
      if (col) {
        if (state.dataSort === col) {
          state.dataOrder = state.dataOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.dataSort = col;
          state.dataOrder = 'asc';
        }
        fetchDataRecords();
        return;
      }
    }

    var el = e.target.closest('button');
    if (!el) return;
    if (el.hasAttribute('data-media')) {
      // Keep the <details> card from toggling when the badge sits in a summary row.
      e.preventDefault();
      openMedia(Number(el.getAttribute('data-media')));
      return;
    }
    var action = el.getAttribute('data-action');
    if (action === 'open-settings') openSettings();
    else if (action === 'copy-sql') copyText(state.sql, el);
    else if (action === 'edit-record') openEditRecordModal(Number(el.getAttribute('data-row')));
    else if (action === 'delete-record') handleDeleteRecord(Number(el.getAttribute('data-row')));
    else if (action === 'preview-url') {
      var url = el.getAttribute('data-url');
      $('media-title').textContent = 'Image Preview';
      $('media-sub').textContent = url;
      $('media-thumb').innerHTML = '<img src="' + esc(url) + '" style="max-width:100%;max-height:300px">';
      $('media-details').innerHTML = '<dt>Source URL</dt><dd><code>' + esc(url) + '</code></dd>';
      var dlg = $('media-dialog');
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    }
    else if (action === 'view-json') {
      var raw = el.getAttribute('data-raw');
      toast(raw);
    }

    if (el.id === 'btn-insert-record') openInsertRecordModal();
    else if (el.id === 'btn-data-refresh') fetchDataRecords();
    else if (el.id === 'btn-page-prev') {
      state.dataPage = Math.max(1, state.dataPage - 1);
      fetchDataRecords();
    }
    else if (el.id === 'btn-page-next') {
      state.dataPage++;
      fetchDataRecords();
    }

    var envToggle = el.getAttribute('data-env-toggle');
    if (envToggle) { state.mobileEnv = envToggle; render(); }
  });

  $('record-form').addEventListener('submit', function (e) {
    if (e.submitter && e.submitter.value === 'save') {
      e.preventDefault();
      handleSaveRecordSubmit();
    }
  });

  $('challenge-input').addEventListener('input', function (e) {
    var val = e.target.value.trim();
    var entity = state.pendingMutation ? state.pendingMutation.entity : '';
    $('btn-confirm-challenge').disabled = (val !== entity);
  });

  $('btn-confirm-challenge').addEventListener('click', function () {
    if (!state.pendingMutation) return;
    var m = state.pendingMutation;
    var inputVal = $('challenge-input').value.trim();
    if (inputVal !== m.entity) return;
    executeMutationDirect(m.action, m.entity, m.pk, m.payload, true, inputVal);
  });

  $('conn-form').addEventListener('click', function (e) {
    var el = e.target.closest('button');
    if (!el) return;
    var toggle = el.getAttribute('data-toggle');
    if (toggle) {
      var input = $('url-' + toggle);
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.textContent = show ? 'Hide' : 'Show';
      el.setAttribute('aria-pressed', String(show));
    }
    var pingEnv = el.getAttribute('data-ping');
    if (pingEnv) {
      el.disabled = true;
      ping(pingEnv).then(function (ok) { el.disabled = false; if (ok) load(false).then(renderModalStatus); });
    }
    var copyEnv = el.getAttribute('data-copy-masked');
    if (copyEnv && state.status && state.status[copyEnv]) copyText(state.status[copyEnv].maskedUrl, el);
  });

  ['dev', 'prod'].forEach(function (env) {
    $('engine-' + env).addEventListener('change', function () { setEngineMode(env); });
  });

  $('btn-save-conn').addEventListener('click', function () {
    var envs = ['dev', 'prod'].filter(hasInput);
    if (!envs.length) { $('conn-dialog').close(); return; }
    var btn = $('btn-save-conn');
    btn.disabled = true;
    Promise.all(envs.map(ping)).then(function (results) {
      btn.disabled = false;
      load(false).then(renderModalStatus);
      if (results.every(Boolean)) { $('conn-dialog').close(); toast('Connections saved to in-memory session', 'ok'); }
    });
  });

  // Clear any typed secrets whenever the modal closes.
  $('conn-dialog').addEventListener('close', function () {
    ['dev', 'prod'].forEach(function (env) {
      var input = $('url-' + env);
      input.value = ''; input.type = 'password';
      $('fsproject-' + env).value = '';
      $('fsemu-' + env).value = '';
      var t = document.querySelector('[data-toggle="' + env + '"]');
      if (t) { t.textContent = 'Show'; t.setAttribute('aria-pressed', 'false'); }
    });
  });

  load(false);
})();
</script>
</body>
</html>`;
}
