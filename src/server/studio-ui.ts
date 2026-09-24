/**
 * Nativ Mission Control Studio — self-contained single-page dashboard.
 * Implements .ai/ui_specs.md: modern minimalist light tokens, five primary views (Overview & Status,
 * Live Tasks kanban, Agent Worktrees, Benchmarks, embedded Database Studio) and a real-time
 * EventSource client on /api/events. No external assets: served inline by studio-server.
 *
 * The page is a String.raw template so client-side regexes keep their backslashes.
 * Client script must not contain backticks or "${" sequences.
 */

export interface StudioUiOptions {
  version?: string;
  /** Project name shown in the header; filled from the pipeline API when omitted. */
  projectName?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

export function renderStudioHtml(options: StudioUiOptions = {}): string {
  const version = escapeHtml(options.version ?? '1.0.0');
  const projectName = escapeHtml(options.projectName ?? '');
  const projectHidden = projectName ? '' : ' hidden';
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nativ Studio</title>
<style>
:root {
  --bg: #f8fafc;
  --surface: #ffffff;
  --border: #e2e8f0;
  --text: #0f172a;
  --muted: #64748b;
  --primary: #4f46e5;
  --primary-hover: #4338ca;
  --success: #059669;
  --success-bg: #ecfdf5;
  --active: #0284c7;
  --active-bg: #f0f9ff;
  --danger: #e11d48;
  --danger-bg: #fff1f2;
  --chip: #f1f5f9;
  --chip-border: #cbd5e1;
  /* Tints derived from the spec tokens (never new hues). */
  --primary-tint: color-mix(in srgb, var(--primary) 7%, #fff);
  --primary-line: color-mix(in srgb, var(--primary) 30%, #fff);
  --success-line: color-mix(in srgb, var(--success) 30%, #fff);
  --active-line: color-mix(in srgb, var(--active) 30%, #fff);
  --danger-line: color-mix(in srgb, var(--danger) 30%, #fff);
  /* Autonomous runner + console drawer tokens (ui_specs.md §1). */
  --run: #10b981;
  --run-line: #6366f1;
  --warn: #f59e0b;
  --warn-bg: #fffbeb;
  /* Self-healing proposals (ui_specs.md §1: Status Proposal / Amber). */
  --proposal: #d97706;
  --proposal-bg: #fef3c7;
  --proposal-line: color-mix(in srgb, var(--proposal) 35%, #fff);
  --primary-active: #3730a3;
  --term-bg: #0f172a;
  --term-text: #f8fafc;
  --term-muted: #94a3b8;
  --term-line: rgb(148 163 184 / 0.28);
  --r-control: 6px;
  --r-card: 10px;
  --shadow: 0 1px 3px 0 rgb(0 0 0 / 0.05), 0 1px 2px -1px rgb(0 0 0 / 0.05);
  --shadow-float: 0 12px 32px -8px rgb(15 23 42 / 0.14), 0 2px 6px -2px rgb(15 23 42 / 0.06);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: SFMono-Regular, Consolas, Monaco, monospace;
  color-scheme: light;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14.5px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
body { min-height: 100vh; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.container { max-width: 1440px; margin: 0 auto; padding: 24px 32px; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.text-danger { color: var(--danger); }
.icon { flex: none; display: block; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); box-shadow: var(--shadow); }

/* App shell: fixed 240px vertical sidebar + fluid main column (ui_specs.md §2) */
:root { --sidebar-w: 240px; }
.app-sidebar { position: fixed; top: 0; left: 0; bottom: 0; z-index: 30; width: var(--sidebar-w); height: 100vh; display: flex; flex-direction: column; background: var(--surface); border-right: 1px solid var(--border); }
.app-main { margin-left: var(--sidebar-w); min-width: 0; min-height: 100vh; }
.brand { display: flex; flex-direction: column; gap: 8px; padding: 18px 16px 14px; border-bottom: 1px solid var(--border); }
.brand-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-name { font-weight: 650; font-size: 15px; letter-spacing: -0.01em; white-space: nowrap; }
.version { font-family: var(--mono); font-size: 11px; color: var(--muted); background: var(--chip); border: 1px solid var(--border); border-radius: var(--r-control); padding: 0 6px; white-space: nowrap; }
.brand-project { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 8px; font-size: 12.5px; color: var(--muted); background: var(--chip); border: 1px solid var(--border); border-radius: var(--r-control); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-self: flex-start; }
.sidebar-nav { flex: 1 1 auto; overflow-y: auto; padding: 8px 10px; }
.nav-group { margin: 12px 0 4px; padding: 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.sidebar-foot { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
.sidebar-foot .foot-label { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.sidebar-foot .foot-root { font-family: var(--mono); font-size: 11.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.sidebar-foot .foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.branch-badge { display: inline-flex; align-items: center; gap: 5px; max-width: 150px; padding: 0 7px; font-family: var(--mono); font-size: 11px; color: var(--text); background: var(--chip); border: 1px solid var(--chip-border); border-radius: var(--r-control); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-live { display: inline-flex; align-items: center; gap: 6px; }
.sb-live .live-dot { width: 7px; height: 7px; }
.sb-live[data-state="live"] .live-dot { background: var(--success); animation: sb-pulse 2s ease-in-out infinite; }
.sb-live[data-state="connecting"] .live-dot { background: var(--active); animation: blink 1.2s ease-in-out infinite; }
.sb-live[data-state="offline"] .live-dot { background: var(--danger); }
@keyframes sb-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 45%, transparent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--success) 0%, transparent); } }

/* Top app bar (glass, sticky) */
.topbar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; padding: 10px 32px; background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
.crumb { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; }
.crumb-root { color: var(--muted); white-space: nowrap; }
.crumb-sep { color: var(--chip-border); }
.crumb-view { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appbar-actions { display: flex; align-items: center; gap: 8px; }
.live { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 10px; font-size: 12.5px; font-weight: 500; color: var(--muted); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-control); white-space: nowrap; }
.live[data-state="live"] { color: var(--text); }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chip-border); flex: none; }
.live[data-state="live"] .live-dot { background: var(--success); }
.live[data-state="connecting"] .live-dot { background: var(--active); animation: blink 1.2s ease-in-out infinite; }
.live[data-state="offline"] .live-dot { background: var(--danger); }
.live-dot.flash { animation: live-flash .9s ease-out; }
@keyframes live-flash { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 65%, transparent); } 100% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--success) 0%, transparent); } }
@keyframes blink { 50% { opacity: .35; } }
.live-tag { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }

/* Primary navigation: vertical sidebar items with live counters */
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-tab { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 0 10px; border: 1px solid transparent; border-radius: var(--r-control); background: none; color: var(--muted); font-size: 13.5px; font-weight: 500; text-align: left; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s, border-color .15s; }
.nav-tab .nav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.nav-tab:hover { color: var(--text); background: var(--chip); }
.nav-tab[aria-selected="true"] { color: var(--primary); background: var(--primary-tint); border-color: var(--primary-line); }
.count { display: inline-block; min-width: 20px; padding: 0 6px; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; color: var(--text); background: var(--chip); border: 1px solid var(--border); border-radius: var(--r-control); font-variant-numeric: tabular-nums; }
.nav-tab[aria-selected="true"] .count { color: var(--primary); background: var(--surface); border-color: var(--primary-line); }

/* Panels */
.panel { min-width: 0; }
.panel:focus-visible { outline-offset: 6px; border-radius: var(--r-card); }
.panel-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; margin: 4px 0 20px; }
.panel-title { min-width: 0; }
.panel-head h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.015em; }
.panel-head .lead { margin: 4px 0 0; color: var(--muted); font-size: 15.5px; line-height: 1.6; max-width: 860px; }
.panel-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.panel-actions select.input { max-width: 260px; }
.panel-actions input.input { width: 240px; max-width: 100%; }

/* Buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 12px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--r-control); box-shadow: var(--shadow); cursor: pointer; font-size: 13.5px; font-weight: 500; white-space: nowrap; transition: background .15s, border-color .15s, color .15s; }
.btn:hover { background: var(--bg); border-color: var(--chip-border); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
.btn.danger, .btn-danger { color: var(--danger); border-color: var(--danger-line); }
.btn.danger:hover, .btn-danger:hover { background: var(--danger-bg); border-color: var(--danger); }
.btn.danger-solid { background: var(--danger); border-color: var(--danger); color: #fff; }
.btn.danger-solid:hover { background: color-mix(in srgb, var(--danger) 88%, #000); }
.btn.small { min-height: 28px; padding: 0 10px; font-size: 12.5px; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.is-busy .icon { animation: spin .9s linear infinite; }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Badges */
.badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; line-height: 1.5; padding: 0 7px; border-radius: var(--r-control); border: 1px solid transparent; white-space: nowrap; }
button.badge { font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.badge-success, .badge-online, .badge-added { color: var(--success); background: var(--success-bg); border-color: var(--success-line); }
.badge-active, .badge-altered, .badge-fk { color: var(--active); background: var(--active-bg); border-color: var(--active-line); }
.badge-danger, .badge-offline, .badge-dropped, .badge-prod { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.badge-neutral, .badge-agent { color: var(--text); background: var(--chip); border-color: var(--chip-border); }
.badge-agent { font-family: var(--mono); font-weight: 500; font-size: 11.5px; }
.badge-accent, .badge-pk, .badge-collection { color: var(--primary); background: var(--primary-tint); border-color: var(--primary-line); }
.badge-subcol { color: var(--active); background: var(--active-bg); border: 1px dashed var(--active); }
.badge-media { color: var(--primary); background: var(--surface); border-color: var(--primary-line); cursor: zoom-in; }
button.badge-media:hover { background: var(--primary-tint); }
.badge-source { font-family: var(--mono); font-weight: 500; color: var(--active); background: var(--active-bg); border-color: var(--active-line); }
.badge-synth { font-family: var(--mono); font-weight: 500; color: var(--primary); background: var(--primary-tint); border-color: var(--primary-line); }

/* Shared states */
.skeleton { height: 42px; border-radius: var(--r-control); margin-bottom: 8px; background: linear-gradient(90deg, var(--chip) 0%, var(--border) 50%, var(--chip) 100%); background-size: 200% 100%; animation: shimmer 1.3s infinite linear; }
.skeleton.short { width: 60%; }
.skeleton.tall { height: 150px; margin: 0; }
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.state { padding: 40px 24px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.state h2 { margin: 6px 0 0; font-size: 17px; font-weight: 600; }
.state p { margin: 0; color: var(--muted); max-width: 620px; font-size: 15px; line-height: 1.55; }
.state .btn { margin-top: 10px; }
.state-icon { color: var(--primary); }
.state-error .state-icon { color: var(--danger); }
.notice { margin: 0 0 14px; padding: 10px 14px; font-size: 13.5px; background: var(--danger-bg); border: 1px solid var(--danger-line); border-radius: var(--r-control); }
.section { padding: 20px; margin-bottom: 16px; }
.section > h3 { margin: 0 0 12px; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.section-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.progress { height: 6px; border-radius: var(--r-control); background: var(--chip); overflow: hidden; }
.progress > span { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width .5s cubic-bezier(.2, .8, .2, 1); }
.progress.success > span { background: var(--success); }
.progress.danger > span { background: var(--danger); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--chip-border); }
.dot.on, .dot-completed { background: var(--success); }
.dot.off, .dot-blocked { background: var(--danger); }
.dot-in_progress { background: var(--active); }
.dot-pending { background: var(--chip-border); }

/* Overview */
.kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.kpi { padding: 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.kpi-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 20px; }
.kpi-head h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--muted); }
.kpi-value { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kpi-of { margin-left: 6px; font-size: 13.5px; font-weight: 500; letter-spacing: 0; color: var(--muted); }
.kpi-sub, .kpi-foot { margin: 0; font-size: 14px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stack { display: flex; gap: 2px; height: 8px; border-radius: var(--r-control); overflow: hidden; background: var(--chip); }
.seg { display: block; height: 100%; }
.seg-completed { background: var(--success); }
.seg-in_progress { background: var(--active); }
.seg-pending { background: var(--chip-border); }
.seg-blocked { background: var(--danger); }
.legend { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; font-size: 13.5px; }
.legend li { display: flex; align-items: center; gap: 6px; color: var(--muted); min-width: 0; }
.legend b { margin-left: auto; color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.kv { margin: 0; display: flex; flex-direction: column; gap: 7px; font-size: 14px; }
.kv > div { display: flex; justify-content: space-between; gap: 12px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.checklist li { display: flex; align-items: center; gap: 8px; font-size: 14px; min-width: 0; }
.check { width: 18px; height: 18px; border-radius: var(--r-control); display: grid; place-items: center; flex: none; }
.checklist .ok .check { color: var(--success); background: var(--success-bg); }
.checklist .missing .check { color: var(--danger); background: var(--danger-bg); }
.checklist .missing code { color: var(--danger); }
.steps { list-style: none; margin: 0; padding: 0; }
.step { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 14px; padding: 12px 0; }
.step:not(:last-child)::after { content: ""; position: absolute; left: 13.5px; top: 44px; bottom: -8px; width: 1px; background: var(--border); }
.step-marker { position: relative; z-index: 1; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: 12.5px; font-weight: 600; color: var(--muted); background: var(--surface); border: 1px solid var(--chip-border); }
.step.is-completed .step-marker { color: var(--success); background: var(--success-bg); border-color: var(--success-line); }
.step.is-active .step-marker { color: var(--active); background: var(--active-bg); border-color: var(--active); box-shadow: 0 0 0 3px color-mix(in srgb, var(--active) 12%, transparent); }
.step-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.step-title h3 { margin: 0; font-size: 15.5px; font-weight: 600; }
.step-desc { margin: 3px 0 8px; color: var(--muted); font-size: 14.5px; line-height: 1.55; }
.step-pct { min-width: 40px; padding-top: 4px; text-align: right; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* Live Tasks kanban */
.kanban { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; align-items: start; }
.kcol { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-card); padding: 12px; min-width: 0; box-shadow: inset 0 2px 0 var(--chip-border); }
.kcol-in_progress { box-shadow: inset 0 2px 0 var(--active); }
.kcol-completed { box-shadow: inset 0 2px 0 var(--success); }
.kcol-blocked { box-shadow: inset 0 2px 0 var(--danger); }
.kcol-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 2px 10px; }
.kcol-head h2 { margin: 0; font-size: 14.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.kcol-body { display: flex; flex-direction: column; gap: 10px; }
.kcol-empty { margin: 0; padding: 18px 8px; text-align: center; font-size: 14px; color: var(--muted); border: 1px dashed var(--chip-border); border-radius: var(--r-control); }
.tcard { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); box-shadow: var(--shadow); transition: border-color .2s, box-shadow .2s; }
.tcard.is-in_progress { border-color: var(--active-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--active) 12%, transparent), 0 0 18px -4px color-mix(in srgb, var(--active) 35%, transparent); }
.tcard.is-blocked { border-color: var(--danger); }
.tcard.is-updated { animation: card-updated 1.6s ease-out; }
@keyframes card-updated { 0%, 30% { background: var(--active-bg); } 100% { background: var(--surface); } }
.tcard-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; flex-wrap: wrap; }
.tcard-id { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tcard-check { display: inline-flex; color: var(--success); }
.tcard-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.file-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.file { max-width: 100%; padding: 1px 7px; font-family: var(--mono); font-size: 11.5px; background: var(--chip); border: 1px solid var(--chip-border); border-radius: var(--r-control); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tcard-note { margin: 0; font-size: 14px; color: var(--muted); line-height: 1.5; }
.tcard-note code { font-size: 13px; color: var(--text); }
.tcard-blocked { padding: 9px 12px; font-size: 13.5px; line-height: 1.5; background: var(--danger-bg); border: 1px solid var(--danger-line); border-radius: var(--r-control); }
.tcard-blocked p { margin: 0; overflow-wrap: anywhere; }
.tcard-blocked .attempts + p { margin-top: 4px; }
.attempts { display: block; font-family: var(--mono); font-size: 12.5px; font-weight: 600; color: var(--danger); }
.tcard-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--border); }
.cmd { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmd-label { color: var(--text); font-weight: 600; font-size: 12px; }
.tcard-actions { display: flex; gap: 6px; flex: none; }
.done-label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 600; color: var(--success); }

/* Autonomous runner: status pills and the live card treatment */
.tcard.is-running { border-color: var(--run-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--run-line) 12%, transparent), 0 0 18px -4px color-mix(in srgb, var(--run-line) 40%, transparent); animation: run-border 2.6s ease-in-out infinite; }
@keyframes run-border { 0%, 100% { border-color: var(--run-line); } 50% { border-color: color-mix(in srgb, var(--run-line) 45%, #fff); } }
.run-pill { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 2px 7px; font-family: var(--mono); font-size: 11px; font-weight: 600; color: var(--success); background: var(--success-bg); border: 1px solid var(--success-line); border-radius: var(--r-control); white-space: nowrap; }
.run-pill .run-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--run); animation: run-pulse 1.4s ease-in-out infinite; }
.run-pill.is-warn { color: #b45309; background: var(--warn-bg); border-color: var(--warn); }
.run-pill.is-warn .run-dot { background: var(--warn); animation: none; }
.run-pill.is-danger { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.run-pill.is-danger .run-dot { background: var(--danger); animation: none; }
.run-pill.is-done { color: var(--muted); background: var(--chip); border-color: var(--chip-border); }
.run-pill.is-done .run-dot { background: var(--chip-border); animation: none; }
@keyframes run-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }

/* Live runner console drawer */
body.has-console { padding-bottom: min(58vh, 520px); }
body.has-console-min { padding-bottom: 56px; }
#runner-console-drawer { position: fixed; inset: auto 0 0 var(--sidebar-w); z-index: 60; display: flex; flex-direction: column; max-height: min(58vh, 520px); background: var(--term-bg); color: var(--term-text); border-top: 1px solid var(--chip-border); box-shadow: var(--shadow-float); animation: rc-slide-up .28s cubic-bezier(.2, .8, .2, 1); }
#runner-console-drawer[hidden] { display: none; }
#runner-console-drawer.is-min .rc-body, #runner-console-drawer.is-min .rc-foot { display: none; }
@keyframes rc-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
.rc-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px solid var(--term-line); }
.rc-task { font-family: var(--mono); font-size: 12.5px; font-weight: 600; }
.rc-title { font-size: 12.5px; color: var(--term-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch; }
.rc-steps { display: flex; align-items: center; gap: 6px; margin: 0 0 0 auto; padding: 0; list-style: none; }
.rc-step { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; font-size: 11px; color: var(--term-muted); border: 1px solid var(--term-line); border-radius: var(--r-control); }
.rc-step.is-done { color: var(--run); border-color: color-mix(in srgb, var(--run) 55%, transparent); }
.rc-step.is-active { color: var(--term-text); background: color-mix(in srgb, var(--primary) 32%, transparent); border-color: var(--primary); }
.rc-step.is-failed { color: var(--term-text); background: color-mix(in srgb, var(--danger) 32%, transparent); border-color: var(--danger); }
.rc-controls { display: flex; gap: 6px; flex: none; }
.rc-btn { padding: 5px 9px; font: 500 11px/1 var(--font); color: var(--term-text); background: transparent; border: 1px solid var(--term-line); border-radius: var(--r-control); cursor: pointer; }
.rc-btn:hover { background: color-mix(in srgb, var(--term-muted) 22%, transparent); }
.rc-btn:disabled { opacity: .45; cursor: not-allowed; }
.rc-btn[aria-pressed="true"] { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 34%, transparent); }
.rc-btn.danger { color: var(--term-text); border-color: var(--danger); }
.rc-btn.danger:hover { background: color-mix(in srgb, var(--danger) 30%, transparent); }
.rc-btn:focus-visible { outline: 2px solid var(--term-text); outline-offset: 2px; }
.rc-body { flex: 1 1 auto; min-height: 120px; margin: 0; padding: 10px 14px; overflow: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.rc-body:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.rc-empty { color: var(--term-muted); }
.rc-fg-muted { color: var(--term-muted); }
.rc-fg-warn { color: var(--warn); }
.rc-fg-ok { color: var(--run); }
.rc-fg-info { color: var(--run-line); }
.rc-fg-danger { color: color-mix(in srgb, var(--danger) 55%, #fff); }
.rc-bold { font-weight: 700; }
.rc-foot { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 7px 14px; font-size: 11.5px; color: var(--term-muted); border-top: 1px solid var(--term-line); }
.rc-foot strong { font-family: var(--mono); font-weight: 600; color: var(--term-text); }
#runner-console-drawer.is-min .rc-tabs { display: none; }
.rc-tabs { display: flex; gap: 2px; padding: 0 14px; border-bottom: 1px solid var(--term-line); }
.rc-tab { display: inline-flex; align-items: center; gap: 6px; padding: 8px 10px; font: 500 12px/1 var(--font); color: var(--term-muted); background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -1px; cursor: pointer; }
.rc-tab:hover { color: var(--term-text); }
.rc-tab[aria-selected="true"] { color: var(--term-text); border-bottom-color: var(--primary); }
.rc-tab:focus-visible { outline: 2px solid var(--term-text); outline-offset: -2px; }
.rc-tab .rc-count { min-width: 18px; padding: 0 5px; font-family: var(--mono); font-size: 10.5px; line-height: 16px; text-align: center; color: var(--term-text); background: color-mix(in srgb, var(--term-muted) 22%, transparent); border-radius: var(--r-control); }
.rc-diff { flex: 1 1 auto; min-height: 120px; display: flex; flex-direction: column; overflow: hidden; }
#runner-console-drawer.is-min .rc-diff { display: none; }
.rc-diff-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 14px; font-size: 11.5px; color: var(--term-muted); border-bottom: 1px solid var(--term-line); }
.rc-diff-bar code { color: var(--term-text); font-family: var(--mono); }
.rc-diff-bar .rc-btn { margin-left: auto; }
.rc-files { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 8px 14px 0; list-style: none; }
.rc-files li { padding: 1px 7px; font-family: var(--mono); font-size: 11px; color: var(--term-text); border: 1px solid var(--term-line); border-radius: var(--r-control); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-diff-body { flex: 1 1 auto; margin: 0; padding: 10px 14px; overflow: auto; font-family: var(--mono); font-size: 12px; line-height: 1.5; white-space: pre; }
.rc-diff-body:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
/* Console tab 3: self-healing proposal review (dark drawer surface). */
.rc-tab .rc-count.is-proposal { color: #fff; background: var(--proposal); }
.rc-heal { flex: 1 1 auto; min-height: 120px; overflow: auto; padding: 12px 14px 14px; font-size: 13px; line-height: 1.5; }
#runner-console-drawer.is-min .rc-heal { display: none; }
.rc-heal:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.heal-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.heal-head h3 { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--term-text); }
.heal-tag { font: 500 11px/18px var(--mono); padding: 0 7px; color: var(--term-text); border: 1px solid var(--term-line); border-radius: var(--r-control); }
.heal-verdict { display: inline-flex; align-items: center; gap: 5px; font: 600 11.5px/20px var(--font); padding: 0 8px; border-radius: var(--r-control); }
.heal-verdict.pass { color: var(--run); background: color-mix(in srgb, var(--run) 16%, transparent); border: 1px solid color-mix(in srgb, var(--run) 45%, transparent); }
.heal-verdict.fail { color: color-mix(in srgb, var(--danger) 55%, #fff); background: color-mix(in srgb, var(--danger) 18%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); }
.heal-diag { margin: 0 0 10px; color: var(--term-muted); overflow-wrap: anywhere; }
.heal-diag strong { color: var(--term-text); font-weight: 600; }
.heal-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 12px; }
.heal-section h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--term-muted); }
.heal-patch { margin: 0; padding: 8px 10px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; background: rgb(148 163 184 / 0.08); border: 1px solid var(--term-line); border-radius: var(--r-control); }
.heal-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.heal-checks li { display: flex; gap: 7px; align-items: flex-start; color: var(--term-muted); font-size: 12.5px; }
.heal-checks li b { color: var(--term-text); font-family: var(--mono); font-weight: 500; }
.heal-checks .ok { color: var(--run); }
.heal-checks .bad { color: color-mix(in srgb, var(--danger) 55%, #fff); }
/* Pinned to the drawer's bottom edge so the decision never needs a scroll. */
.heal-actions { position: sticky; bottom: -14px; display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin: 12px -14px -14px; padding: 10px 14px; background: var(--term-bg); border-top: 1px solid var(--term-line); }
.rc-btn.approve { color: #fff; background: var(--success); border-color: var(--success); }
.rc-btn.approve:hover:not(:disabled) { background: color-mix(in srgb, var(--success) 88%, #000); }
.rc-btn.reject { color: color-mix(in srgb, var(--danger) 55%, #fff); border-color: color-mix(in srgb, var(--danger) 50%, transparent); }
.rc-btn.reject:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 16%, transparent); }
.heal-result { margin: 0 0 10px; padding: 8px 10px; color: var(--run); border: 1px solid color-mix(in srgb, var(--run) 45%, transparent); border-radius: var(--r-control); }
.heal-result.is-error { color: color-mix(in srgb, var(--danger) 55%, #fff); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.heal-skel { height: 12px; margin: 8px 0; border-radius: 4px; background: var(--term-line); animation: blink 1.4s ease-in-out infinite; }
@media (max-width: 768px) { .heal-grid { grid-template-columns: 1fr; } }
.df-add { display: block; color: var(--run); background: color-mix(in srgb, var(--run) 12%, transparent); }
.df-del { display: block; color: color-mix(in srgb, var(--danger) 55%, #fff); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.df-hunk { display: block; color: var(--run-line); }
.df-file { display: block; margin-top: 8px; font-weight: 700; color: var(--term-text); }
.df-meta { display: block; color: var(--term-muted); }
@media (max-width: 760px) {
  .rc-steps { order: 3; margin-left: 0; width: 100%; }
  .rc-title { max-width: 100%; }
}

/* Agent worktrees */
.wt-card { overflow: hidden; }
table.grid { width: 100%; border-collapse: collapse; font-size: 13.5px; }
table.grid th { padding: 10px 16px; text-align: left; font-size: 12.5px; font-weight: 600; color: var(--muted); background: var(--bg); border-bottom: 1px solid var(--border); white-space: nowrap; }
table.grid th:last-child { text-align: right; }
table.grid td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.grid tbody tr:last-child td { border-bottom: none; }
table.grid tbody tr:hover td { background: var(--bg); }
table.grid code { font-size: 12.5px; }
.cell-sub { max-width: 280px; margin-top: 2px; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path { display: inline-block; max-width: 260px; vertical-align: bottom; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-actions { display: flex; justify-content: flex-end; gap: 6px; }

/* Benchmarks */
.hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px 32px; padding: 22px; margin-bottom: 16px; transition: opacity .2s; }
.hero.is-running { opacity: .6; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.hero-value { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 40px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hero-value .badge { font-size: 12px; letter-spacing: 0; }
.hero-meta { margin: 0; font-size: 13.5px; color: var(--muted); }
.hero-stats { display: grid; grid-template-columns: repeat(4, minmax(96px, auto)); gap: 4px 28px; margin: 0; }
.hero-stats dt { font-size: 12.5px; color: var(--muted); }
.hero-stats dd { margin: 0; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.scenario-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.scenario { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px; }
.scenario.is-idle { box-shadow: none; border-style: dashed; }
.scenario-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.scenario-head h3 { margin: 0; font-size: 14.5px; font-weight: 600; }
.scenario-sub { margin: -6px 0 0; font-size: 13px; color: var(--muted); }
.scenario p { margin: 0; font-size: 13.5px; line-height: 1.5; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.metric-v { display: block; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.metric-l { display: block; font-size: 12px; color: var(--muted); }
.details { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; padding-top: 10px; font-size: 12.5px; border-top: 1px solid var(--border); }
.details dt { color: var(--muted); }
.details dd { margin: 0; text-align: right; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.details .wide { grid-column: 1 / -1; }
.details dd.wide { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; text-align: left; }
.details dd.wide .chip { font-size: 11px; }
.scenario-errors { margin: 0; padding: 8px 10px 8px 26px; font-size: 12.5px; color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger-line); border-radius: var(--r-control); }

/* Database Studio */
.telemetry { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.pill { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 4px 10px; font-size: 13px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-control); box-shadow: var(--shadow); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pill b { font-weight: 600; }
.diagnostic-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; margin: 12px 0 16px; background: var(--danger-bg); border: 1px solid var(--danger-line); border-radius: var(--r-control); }
.diagnostic-content { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.diagnostic-tag { font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--danger); background: var(--surface); border: 1px solid var(--danger-line); padding: 0 7px; border-radius: var(--r-control); }
.diagnostic-msg code { background: var(--surface); padding: 1px 6px; border-radius: 4px; font-family: var(--mono); }
.diagnostic-actions { display: flex; gap: 8px; }
.template-helper-box { background: var(--active-bg); border: 1px solid var(--active-line); border-radius: var(--r-control); padding: 12px 14px; margin-bottom: 16px; }
.template-helper-label { font-size: 12.5px; color: var(--muted); margin-bottom: 8px; }
.template-helper-label code { color: var(--active); font-weight: 600; }
.template-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.template-chip { font-family: var(--mono); font-size: 12.5px; }
.template-chip:hover { border-color: var(--active); }
.chip-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.chip-dot.on { background: var(--success); }
.chip-dot.off { background: var(--danger); }

.thumb-pop { position: fixed; z-index: 60; width: 220px; padding: 8px; border-radius: var(--r-card); border: 1px solid var(--border); background: var(--surface); box-shadow: var(--shadow-float); pointer-events: none; }
.thumb-box { display: grid; place-items: center; min-height: 120px; max-height: 200px; overflow: hidden; border-radius: var(--r-control); background: repeating-conic-gradient(var(--chip) 0% 25%, var(--surface) 0% 50%) 50% / 16px 16px; }
.thumb-box img { max-width: 100%; max-height: 200px; display: block; }
.thumb-box .ph { color: var(--muted); font-size: 12px; text-align: center; padding: 12px; }
.thumb-meta { margin-top: 6px; font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
.media-modal .thumb-box { min-height: 220px; max-height: 360px; }
.media-modal .thumb-box img { max-height: 360px; }
.media-modal dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 14px 0 0; font-size: 13px; }
.media-modal dt { color: var(--muted); }
.media-modal dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.media-note { margin-top: 12px; font-size: 13px; line-height: 1.5; color: var(--muted); }

.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 14px; }
.input { min-height: 32px; padding: 6px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-control); min-width: 0; }
.input:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 15%, transparent); }
textarea.input { width: 100%; resize: vertical; line-height: 1.5; }
.search { flex: 1; min-width: 180px; max-width: 420px; }
.panes { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.panes-full { grid-template-columns: 1fr; }
.pane { padding: 16px; min-width: 0; }
.pane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.pane-head h2 { margin: 0; font-size: 15.5px; display: flex; align-items: center; gap: 8px; white-space: nowrap; flex: none; }
.pane-head .meta { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-card { border: 1px solid var(--border); border-radius: var(--r-control); margin-bottom: 8px; background: var(--surface); }
.table-card > summary { list-style: none; cursor: pointer; padding: 10px 12px; display: flex; align-items: center; gap: 8px; border-radius: var(--r-control); }
.table-card > summary::-webkit-details-marker { display: none; }
.table-card > summary:hover { background: var(--bg); }
.table-card > summary::before { content: "\25B8"; color: var(--muted); transition: transform .15s; }
.table-card[open] > summary::before { transform: rotate(90deg); }
.table-card .tname { font-family: var(--mono); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.table-card .ccount { margin-left: auto; color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.table-body { padding: 0 12px 12px; overflow-x: auto; }
.desc { color: var(--muted); margin: 0 0 8px; font-size: 13.5px; line-height: 1.5; }
table.cols { width: 100%; border-collapse: collapse; font-size: 13px; }
table.cols th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12.5px; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
table.cols td { padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.cols td.mono { white-space: nowrap; }
.subhead { font-size: 12.5px; color: var(--muted); margin: 12px 0 6px; text-transform: uppercase; letter-spacing: .05em; }
.idx-list { margin: 0; padding-left: 18px; font-size: 13px; }

.summary-banner { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; padding: 16px; margin-bottom: 16px; }
.stat { padding: 4px 8px; }
.stat .n { font-size: 26px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat .l { color: var(--muted); font-size: 12.5px; }
.risk-HIGH { color: var(--danger); } .risk-MEDIUM { color: var(--active); } .risk-LOW { color: var(--success); } .risk-NONE { color: var(--muted); }
.alert-danger { border: 1px solid var(--danger-line); background: var(--danger-bg); border-radius: var(--r-control); padding: 10px 12px; margin-bottom: 12px; }
.alert-danger strong { color: var(--danger); }
.diff-table td.before { color: var(--danger); } .diff-table td.after { color: var(--success); }
.row-added td { background: var(--success-bg); } .row-dropped td { background: var(--danger-bg); } .row-altered td { background: var(--active-bg); }
.chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 12px; padding: 1px 8px; border-radius: var(--r-control); border: 1px solid var(--chip-border); background: var(--chip); }

.sql-wrap { position: relative; padding: 0; overflow: hidden; }
.sql-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
pre.sql { margin: 0; padding: 16px; overflow: auto; max-height: 70vh; background: var(--bg); font-family: var(--mono); font-size: 12.5px; line-height: 1.6; white-space: pre; }
.sql .k { color: var(--primary); font-weight: 600; } .sql .s { color: var(--success); } .sql .c { color: var(--muted); font-style: italic; } .sql .d { color: var(--danger); font-weight: 700; }
.sql .p { color: var(--active); } .sql .n { color: var(--active); font-weight: 600; } .sql .o { color: var(--primary); }
.lang { font-family: var(--mono); font-size: 11px; padding: 0 7px; border-radius: var(--r-control); border: 1px solid var(--primary-line); background: var(--primary-tint); color: var(--primary); margin-right: 6px; }
.copy-wrap { position: relative; display: inline-flex; }
.tooltip { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--success); color: #fff; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: var(--r-control); pointer-events: none; opacity: 0; transition: opacity .15s; white-space: nowrap; }
.tooltip.show { opacity: 1; }

.empty { text-align: center; padding: 48px 24px; }
.empty .empty-icon { color: var(--primary); margin: 0 auto 12px; }
.empty h3 { margin: 0 0 6px; font-size: 16px; }
.empty p { color: var(--muted); margin: 0 0 16px; font-size: 15px; line-height: 1.55; }

.env-toggle-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 14px 0 6px; }
.env-segmented { display: inline-flex; gap: 2px; padding: 3px; background: var(--chip); border: 1px solid var(--border); border-radius: var(--r-control); }
.env-seg-btn { border: 1px solid transparent; background: transparent; padding: 4px 14px; border-radius: 5px; cursor: pointer; color: var(--muted); font-size: 13px; font-weight: 600; transition: all .15s ease; }
.env-seg-btn:hover { color: var(--text); }
.env-seg-btn[aria-pressed="true"] { background: var(--surface); color: var(--primary); border-color: var(--border); box-shadow: var(--shadow); }
.env-seg-btn[data-env-mode="prod"][aria-pressed="true"] { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.prod-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-radius: var(--r-control); border: 1px solid var(--danger-line); background: var(--danger-bg); font-size: 13px; margin-bottom: 14px; }
.prod-banner b { color: var(--danger); font-weight: 600; }

.tabs { display: flex; gap: 4px; margin: 16px 0; border-bottom: 1px solid var(--border); overflow-x: auto; overflow-y: hidden; }
.subtab { background: none; border: none; padding: 10px 12px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 500; }
.subtab:hover { color: var(--text); }
.subtab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--primary); }

.data-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.data-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; flex: 1; min-width: 0; }
.data-grid-wrap { overflow-x: auto; max-width: 100%; border: 1px solid var(--border); border-radius: var(--r-card); background: var(--surface); box-shadow: var(--shadow); margin-bottom: 14px; min-height: 240px; }
table.data-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
table.data-table th { background: var(--bg); color: var(--muted); font-weight: 600; font-size: 12.5px; padding: 10px 12px; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; white-space: nowrap; user-select: none; }
table.data-table th.sortable { cursor: pointer; }
table.data-table th.sortable:hover { color: var(--text); background: var(--chip); }
table.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
table.data-table tr:hover td { background: var(--bg); }
.th-sort-icon { font-size: 10px; margin-left: 4px; color: var(--primary); }
.td-actions { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.pagination-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 4px; font-size: 13px; color: var(--muted); }
.pagination-ctrls { display: flex; align-items: center; gap: 8px; }
.cell-preview-btn { padding: 1px 6px; font-size: 11px; border-radius: 4px; border: 1px solid var(--primary-line); color: var(--primary); background: var(--primary-tint); cursor: pointer; }
.cell-preview-btn:hover { background: var(--surface); }

/* Toasts */
/* Bottom-right so notifications never cover the sticky header and navigation. */
.toast-host { position: fixed; right: 16px; bottom: 16px; z-index: 100; display: flex; flex-direction: column; gap: 8px; width: min(440px, calc(100vw - 32px)); pointer-events: none; }
.toast { pointer-events: auto; display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; font-size: 13.5px; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--danger); border-radius: var(--r-card); box-shadow: var(--shadow-float); animation: toast-in .18s ease-out; }
.toast.ok { border-left-color: var(--success); }
.toast .t-body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast .t-hint { color: var(--muted); font-size: 12.5px; }
.toast button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; }
@keyframes toast-in { from { opacity: 0; transform: translateY(6px); } }

/* Dialogs */
dialog { border: none; padding: 0; background: transparent; color: var(--text); width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 32px); }
dialog.narrow { width: min(460px, calc(100vw - 32px)); }
dialog::backdrop { background: rgb(15 23 42 / 0.32); backdrop-filter: blur(2px); }
.modal { padding: 22px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); box-shadow: var(--shadow-float); }
.modal h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.modal .lead { color: var(--muted); margin: 0 0 16px; font-size: 14px; line-height: 1.55; }
.field { margin-bottom: 16px; }
.field label { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; margin-bottom: 6px; }
.field-row { display: flex; gap: 8px; }
.field-row .input { flex: 1; font-family: var(--mono); font-size: 12.5px; min-width: 0; }
.field-row + .field-row { margin-top: 8px; }
.field-row select.input { font-family: var(--font); }
.param-grid { display: grid; grid-template-columns: 140px 1fr 96px; gap: 8px; margin-top: 8px; }
.param-grid .input { font-family: var(--mono); font-size: 12.5px; min-width: 0; }
.param-grid select.input { font-family: var(--font); }
.param-grid .span-2 { grid-column: span 2; }
.field .current { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12.5px; color: var(--muted); min-width: 0; }
.field .current code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.field-error { margin: 6px 0 0; font-size: 13px; color: var(--danger); }
.result { margin-top: 6px; font-size: 13px; }
.result.ok { color: var(--success); } .result.err { color: var(--danger); }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.modal-prod-guard { border-color: var(--danger-line); }
.challenge-badge { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; border-radius: var(--r-control); font-size: 11px; font-weight: 700; color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger-line); margin-bottom: 12px; }
.challenge-box { padding: 14px; border-radius: var(--r-control); border: 1px solid var(--danger-line); background: var(--danger-bg); margin: 12px 0; }
.challenge-box p { margin: 0 0 8px; font-size: 13.5px; line-height: 1.5; }
.challenge-box code { color: var(--danger); font-weight: 700; font-size: 13px; }
.record-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; max-height: 60vh; overflow-y: auto; padding-right: 4px; margin-bottom: 16px; }
.record-form-grid .field-full { grid-column: 1 / -1; }
.record-form-grid label { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 4px; color: var(--muted); }
.record-form-grid label b { color: var(--text); font-family: var(--mono); }
.record-form-grid .input { width: 100%; }
.record-form-grid textarea.input { min-height: 64px; font-family: var(--mono); font-size: 12px; }

/* Intelligent dispatch modal */
.dispatch-task { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; margin-bottom: 16px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-control); }
.dispatch-task-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dispatch-task h3 { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.45; }
.dispatch-task .cmd { flex: none; white-space: normal; overflow-wrap: anywhere; }
textarea.cmd-preview { min-height: 92px; font-family: var(--mono); font-size: 12px; background: var(--bg); }
.field-hint { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); }
.switches { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.switch { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.switch-track { position: relative; flex: none; width: 32px; height: 18px; margin-top: 1px; background: var(--chip-border); border-radius: 999px; transition: background .15s; }
.switch-track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: var(--surface); border-radius: 50%; box-shadow: var(--shadow); transition: transform .15s; }
.switch input:checked + .switch-track { background: var(--primary); }
.switch input:checked + .switch-track::after { transform: translateX(14px); }
.switch input:focus-visible + .switch-track { outline: 2px solid var(--primary); outline-offset: 2px; }
.switch input:disabled + .switch-track { opacity: .45; }
/* Dual-mode dispatch: engine cards + thinking budget chips (radio groups, keyboard-native). */
.choice-group { margin: 0 0 16px; padding: 0; border: none; min-width: 0; }
.choice-group > legend { padding: 0; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.engine-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.engine-option { position: relative; display: flex; gap: 10px; align-items: flex-start; padding: 11px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-control); cursor: pointer; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.engine-option:hover { border-color: var(--chip-border); }
.engine-option input, .budget-chip input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.engine-option .icon { flex: none; margin-top: 2px; color: var(--muted); }
.engine-option b { display: block; font-size: 13.5px; font-weight: 600; }
.engine-option span span { display: block; font-size: 12.5px; color: var(--muted); line-height: 1.45; }
.engine-option:has(input:checked) { border-color: var(--primary); background: var(--primary-tint); box-shadow: inset 0 0 0 1px var(--primary); }
.engine-option:has(input:checked) .icon { color: var(--primary); }
.engine-option:has(input:focus-visible), .budget-chip:has(input:focus-visible) { outline: 2px solid var(--primary); outline-offset: 2px; }
.budget-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.budget-chip { position: relative; display: inline-flex; align-items: center; min-height: 32px; padding: 0 11px; font-size: 13px; background: var(--chip); border: 1px solid var(--chip-border); border-radius: var(--r-control); cursor: pointer; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.budget-chip small { margin-left: 5px; font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.budget-chip:has(input:checked) { color: var(--primary); background: var(--primary-tint); border-color: var(--primary); }
.budget-chip:has(input:checked) small { color: var(--primary); }
@media (max-width: 768px) { .engine-options { grid-template-columns: 1fr; } }
/* Grounded spend KPI (ui_specs.md View 1, card 3). */
.cache-pill { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 6px; row-gap: 1px; padding: 5px 9px; font-size: 12.5px; line-height: 1.4; color: var(--success); background: var(--success-bg); border: 1px solid var(--success-line); border-radius: var(--r-control); font-variant-numeric: tabular-nums; }
.cache-pill .label { white-space: nowrap; }
.cache-pill b { font-weight: 650; }
/* The savings line wraps under the rate instead of being clipped in a narrow card. */
.cache-pill .save { flex-basis: 100%; color: var(--muted); }
.tel-chips { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.tel-chips li { display: flex; flex-direction: column; gap: 1px; min-width: 0; padding: 5px 8px; background: var(--chip); border: 1px solid var(--chip-border); border-radius: var(--r-control); }
.tel-chips span { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tel-chips b { font-family: var(--mono); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi-note { margin: 0; font-size: 13px; color: var(--muted); }
.kpi-note .btn { margin-left: 6px; }
.dot-proposal { background: var(--proposal); }
/* Self-healing proposals on the kanban and in the sidebar. */
.badge-proposal { color: var(--proposal); background: var(--proposal-bg); border-color: var(--proposal-line); }
.nav-tab .count.count-proposal { color: var(--proposal); background: var(--proposal-bg); border-color: var(--proposal-line); }
.tcard.has-proposal { border-color: var(--proposal-line); box-shadow: inset 3px 0 0 var(--proposal), var(--shadow); }
.proposal-banner { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 11px; font: 600 13px/1.4 var(--font); text-align: left; color: var(--proposal); background: var(--proposal-bg); border: 1px solid var(--proposal-line); border-radius: var(--r-control); cursor: pointer; transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1); }
.proposal-banner:hover { border-color: var(--proposal); }
.proposal-banner:active { transform: scale(0.98); }
.proposal-banner:focus-visible { outline: 2px solid var(--proposal); outline-offset: 2px; }
.proposal-banner .icon { flex: none; }
.switch input:disabled ~ .switch-text { opacity: .55; }
.switch-text { display: flex; flex-direction: column; font-size: 13.5px; }
.switch-text b { font-weight: 600; }
.switch-text span { font-size: 12.5px; color: var(--muted); }
kbd { padding: 0 5px; font-family: var(--mono); font-size: 11px; color: var(--muted); background: var(--chip); border: 1px solid var(--chip-border); border-radius: 4px; }
.btn.primary kbd { color: #fff; background: transparent; border-color: color-mix(in srgb, #fff 45%, transparent); }

/* Responsive */
@media (max-width: 1180px) {
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  #runner-console-drawer { inset: auto 0 0 0; }
  .app-sidebar { position: static; width: auto; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  .brand { flex-direction: row; align-items: center; flex-wrap: wrap; padding: 12px 16px; border-bottom: none; }
  .sidebar-nav { padding: 0 12px 10px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; }
  .sidebar-nav::-webkit-scrollbar { display: none; }
  .sidebar-nav .nav-group, .sidebar-foot { display: none; }
  .sidebar-nav, .nav { display: flex; flex-direction: row; gap: 4px; }
  .nav-tab { width: auto; }
  .app-main { margin-left: 0; }
  .topbar { padding: 10px 16px; }
  .container { padding: 16px; }
  .panes { grid-template-columns: 1fr; }
  .summary-banner { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hero { grid-template-columns: 1fr; }
  .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pill { white-space: normal; }
}
@media (max-width: 820px) {
  table.grid thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  table.grid, table.grid tbody, table.grid tr, table.grid td { display: block; }
  table.grid tr { padding: 10px 16px; border-bottom: 1px solid var(--border); }
  table.grid tbody tr:last-child { border-bottom: none; }
  table.grid td { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; border: none; text-align: right; min-width: 0; }
  table.grid td::before { content: attr(data-label); flex: none; font-size: 12px; color: var(--muted); text-align: left; }
  table.grid tbody tr:hover td { background: none; }
  .path, .cell-sub { max-width: 58vw; }
}
@media (max-width: 640px) {
  .kpi-grid, .kanban { grid-template-columns: 1fr; }
  .brand-project, .live-tag, .crumb-root, .crumb-sep { display: none; }
  .panel-actions, .panel-actions input.input, .panel-actions select.input { width: 100%; max-width: none; }
  .param-grid { grid-template-columns: 1fr; }
  .param-grid .span-2 { grid-column: auto; }
  .record-form-grid { grid-template-columns: 1fr; }
  .diagnostic-banner { flex-direction: column; align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<div class="toast-host" id="toasts" role="status" aria-live="polite"></div>

<aside class="app-sidebar" aria-label="Studio navigation">
  <div class="brand">
    <div class="brand-row">
      <svg class="icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#4f46e5"/><path d="M8 16.5v-9l8 9v-9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="brand-name">Nativ Studio</span>
      <span class="version">v${version}</span>
    </div>
    <span class="brand-project" id="project-name" title="Repository"${projectHidden}>${projectName}</span>
  </div>
  <div class="sidebar-nav" role="tablist" aria-orientation="vertical" aria-label="Studio views">
    <div class="nav-group" aria-hidden="true">Pipeline</div>
    <div class="nav" role="none">
      <button class="nav-tab" role="tab" id="nav-overview" data-view="overview" aria-controls="panel-overview" aria-selected="true"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg><span class="nav-label">Overview &amp; Status</span><span class="count" id="ncount-overview">&#8211;</span></button>
      <button class="nav-tab" role="tab" id="nav-tasks" data-view="tasks" aria-controls="panel-tasks" aria-selected="false" tabindex="-1"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/></svg><span class="nav-label">Live Tasks</span><span class="count count-proposal" id="ncount-proposals" hidden>0</span><span class="count" id="ncount-tasks">&#8211;</span></button>
      <button class="nav-tab" role="tab" id="nav-worktrees" data-view="worktrees" aria-controls="panel-worktrees" aria-selected="false" tabindex="-1"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-4 2.5-6.2 4.6"/></svg><span class="nav-label">Agent Worktrees</span><span class="count" id="ncount-worktrees">&#8211;</span></button>
    </div>
    <div class="nav-group" aria-hidden="true">System &amp; Data</div>
    <div class="nav" role="none">
      <button class="nav-tab" role="tab" id="nav-benchmarks" data-view="benchmarks" aria-controls="panel-benchmarks" aria-selected="false" tabindex="-1"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11l2.8-3.3"/></svg><span class="nav-label">Benchmarks</span><span class="count" id="ncount-benchmarks">&#8211;</span></button>
      <button class="nav-tab" role="tab" id="nav-database" data-view="database" aria-controls="panel-database" aria-selected="false" tabindex="-1"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><ellipse cx="8" cy="3.5" rx="5" ry="1.8"/><path d="M3 3.5v9c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-9M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8"/></svg><span class="nav-label">Database</span><span class="count" id="ncount-database">&#8211;</span></button>
    </div>
  </div>
  <div class="sidebar-foot">
    <span class="foot-label">Workspace Root</span>
    <span class="foot-root" id="sb-root" title="">&#8211;</span>
    <div class="foot-row">
      <span class="branch-badge" id="sb-branch" title="Active git branch"><svg class="icon" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-4 2.5-6.2 4.6"/></svg><span id="sb-branch-name">&#8211;</span></span>
      <span class="sb-live" id="sb-live" data-state="connecting"><span class="live-dot" aria-hidden="true"></span><span id="sb-live-label">Connecting</span></span>
    </div>
  </div>
</aside>

<div class="app-main">
<header class="topbar">
  <div class="crumb"><span class="crumb-root">Mission Control</span><span class="crumb-sep" aria-hidden="true">/</span><span class="crumb-view" id="crumb-view">Overview &amp; Status</span></div>
  <div class="appbar-actions">
    <span class="live" id="live" data-state="connecting" role="status" aria-live="polite"><span class="live-dot" id="live-dot" aria-hidden="true"></span><span id="live-label">Connecting</span><span class="live-tag">SSE</span></span>
    <button class="btn" id="btn-refresh-all" type="button"><svg class="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"/><path d="M13.5 2.5v3h-3"/></svg>Refresh</button>
  </div>
</header>

<main class="container" id="main">
  <section class="panel" id="panel-overview" role="tabpanel" aria-labelledby="nav-overview" tabindex="0"></section>
  <section class="panel" id="panel-tasks" role="tabpanel" aria-labelledby="nav-tasks" tabindex="0" hidden></section>
  <section class="panel" id="panel-worktrees" role="tabpanel" aria-labelledby="nav-worktrees" tabindex="0" hidden></section>
  <section class="panel" id="panel-benchmarks" role="tabpanel" aria-labelledby="nav-benchmarks" tabindex="0" hidden></section>
  <section class="panel" id="panel-database" role="tabpanel" aria-labelledby="nav-database" tabindex="0" hidden>
    <div class="panel-head">
      <div class="panel-title">
        <h1>Database Studio</h1>
        <p class="lead">Schema inspector, live data browser, drift tracker and migration preview. Connection strings stay inside this local process.</p>
      </div>
      <div class="panel-actions">
        <button class="btn" id="btn-settings" type="button">Connection Settings</button>
        <button class="btn primary" id="btn-export" type="button">Export Contract</button>
      </div>
    </div>
    <div class="telemetry" id="telemetry" aria-label="Database telemetry"></div>

    <div class="env-toggle-bar">
      <div class="env-segmented" role="group" aria-label="Environment Focus Mode">
        <button type="button" class="env-seg-btn" data-env-mode="dev" aria-pressed="true">Staging / Dev</button>
        <button type="button" class="env-seg-btn" data-env-mode="prod" aria-pressed="false">Production</button>
        <button type="button" class="env-seg-btn" data-env-mode="split" aria-pressed="false">Split Comparison</button>
      </div>
    </div>

    <div id="diagnostic-banner" aria-live="polite" hidden></div>

    <nav class="tabs" role="tablist" aria-label="Database views">
      <button class="subtab" role="tab" id="tab-explorer" aria-controls="view" data-tab="explorer">Schema &amp; Structure <span class="count" id="count-explorer">0</span></button>
      <button class="subtab" role="tab" id="tab-data" aria-controls="view" data-tab="data">Live Data Browser <span class="count" id="count-data">0</span></button>
      <button class="subtab" role="tab" id="tab-drift" aria-controls="view" data-tab="drift">Schema Changes (Live vs Blueprint) <span class="count" id="count-drift">0</span></button>
      <button class="subtab" role="tab" id="tab-sql" aria-controls="view" data-tab="sql">Migration Script Preview <span class="count" id="count-sql">0</span></button>
    </nav>

    <div id="view" role="tabpanel" tabindex="-1"></div>
  </section>
</main>
</div>

<section id="runner-console-drawer" aria-labelledby="rc-task" hidden>
  <header class="rc-head">
    <code class="rc-task" id="rc-task">&#8211;</code>
    <span class="rc-title" id="rc-title"></span>
    <ol class="rc-steps" id="rc-steps" aria-label="Runner lifecycle"></ol>
    <div class="rc-controls">
      <button class="rc-btn" type="button" id="rc-autoscroll" aria-pressed="true" aria-label="Toggle console auto-scroll">Auto-scroll</button>
      <button class="rc-btn" type="button" id="rc-clear" aria-label="Clear the console buffer">Clear</button>
      <button class="rc-btn danger" type="button" id="rc-abort" aria-label="Abort the running agent">Abort</button>
      <button class="rc-btn" type="button" id="rc-minimize" aria-expanded="true" aria-controls="rc-body">Minimize</button>
      <button class="rc-btn" type="button" id="rc-close" aria-label="Close the runner console">Close</button>
    </div>
  </header>
  <div class="rc-tabs" role="tablist" aria-label="Console views">
    <button class="rc-tab" type="button" role="tab" id="rc-tab-logs" data-rc-tab="logs" aria-controls="rc-body" aria-selected="true"><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3.5 3.5L3 11.5M8.5 12h4.5"/></svg>Live Logs</button>
    <button class="rc-tab" type="button" role="tab" id="rc-tab-diff" data-rc-tab="diff" aria-controls="rc-diff" aria-selected="false" tabindex="-1"><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 2.5v6M2 5.5h6M8.5 12.5h5.5"/></svg>Worktree Changes <span class="rc-count" id="rc-diff-count">&#8211;</span></button>
    <button class="rc-tab" type="button" role="tab" id="rc-tab-heal" data-rc-tab="heal" aria-controls="rc-heal" aria-selected="false" tabindex="-1" hidden><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.6-5.2 6.6-3-1-5.2-3.5-5.2-6.6V3.9z"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3"/></svg>Self-Healing Proposal <span class="rc-count is-proposal" id="rc-heal-count">1</span></button>
  </div>
  <pre class="rc-body" id="rc-body" role="log" aria-live="polite" aria-label="Runner output" tabindex="0"></pre>
  <div class="rc-diff" id="rc-diff" role="tabpanel" aria-labelledby="rc-tab-diff" hidden>
    <div class="rc-diff-bar">
      <span id="rc-diff-summary">Uncommitted changes in the task worktree</span>
      <button class="rc-btn" type="button" id="rc-diff-refresh" aria-label="Reload the worktree diff">Reload Diff</button>
    </div>
    <ul class="rc-files" id="rc-diff-files" aria-label="Changed files"></ul>
    <pre class="rc-diff-body" id="rc-diff-body" aria-label="Unified diff" tabindex="0"></pre>
  </div>
  <div class="rc-heal" id="rc-heal" role="tabpanel" aria-labelledby="rc-tab-heal" tabindex="0" hidden></div>
  <footer class="rc-foot">
    <span>Elapsed <strong id="rc-elapsed">00:00</strong></span>
    <span>Output <strong id="rc-bytes">0 B</strong></span>
    <span id="rc-spend-wrap" hidden>Spend <strong id="rc-spend">$0.0000</strong></span>
    <span id="rc-cache-wrap" hidden>Cache hit <strong id="rc-cache">0%</strong></span>
    <span>Gatekeeper <strong id="rc-gate">Idle</strong></span>
    <span id="rc-exit"></span>
  </footer>
</section>

<dialog id="block-dialog" class="narrow" aria-labelledby="block-title">
  <form class="modal" method="dialog">
    <h2 id="block-title">Block <code id="block-task-id">task</code></h2>
    <p class="lead">The reason is saved to the task notes in .ai/master_plan.json so the next agent knows why work stopped.</p>
    <div class="field">
      <label for="block-reason">Reason</label>
      <textarea class="input" id="block-reason" rows="3" placeholder="Verification failed after 3 attempts: ..."></textarea>
      <p class="field-error" id="block-error" aria-live="polite"></p>
    </div>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn danger-solid" type="button" id="btn-confirm-block">Block Task</button>
    </div>
  </form>
</dialog>

<dialog id="dispatch-dialog" aria-labelledby="dispatch-title" aria-describedby="dispatch-lead">
  <form class="modal" method="dialog" id="dispatch-form">
    <h2 id="dispatch-title">Dispatch Task</h2>
    <p class="lead" id="dispatch-lead">Hands the task to an autonomous Claude runner. Output, token spend and gatekeeper results stream into the console drawer.</p>
    <div class="dispatch-task">
      <div class="dispatch-task-head"><code class="tcard-id" id="dispatch-task-id">task</code><span class="badge badge-agent" id="dispatch-agent">agent</span></div>
      <h3 id="dispatch-task-title"></h3>
      <ul class="file-list" id="dispatch-files" aria-label="Target files"></ul>
      <code class="cmd" id="dispatch-verify"></code>
    </div>
    <fieldset class="choice-group">
      <legend>Engine</legend>
      <div class="engine-options">
        <label class="engine-option"><input type="radio" name="dispatch-engine" id="dispatch-engine-native" value="native" checked><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/></svg><span><b>Native Engine</b><span>Direct API, Prompt Caching &amp; Fast Streaming. Token spend is reported live.</span></span></label>
        <label class="engine-option"><input type="radio" name="dispatch-engine" id="dispatch-engine-cli" value="cli"><svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6.5L6.5 8l-2 1.5M8.5 10h3"/></svg><span><b>CLI Terminal Pairing</b><span>Interactive Claude Code in a terminal shell, driven by the command below.</span></span></label>
      </div>
    </fieldset>
    <fieldset class="choice-group">
      <legend>Thinking Budget</legend>
      <div class="budget-chips">
        <label class="budget-chip"><input type="radio" name="dispatch-budget" id="dispatch-budget-none" value="" checked>None<small>Fast / Deterministic</small></label>
        <label class="budget-chip"><input type="radio" name="dispatch-budget" id="dispatch-budget-standard" value="2048">Standard<small>2,048 tokens</small></label>
        <label class="budget-chip"><input type="radio" name="dispatch-budget" id="dispatch-budget-deep" value="4096">Deep<small>4,096 tokens</small></label>
      </div>
      <p class="field-hint" id="dispatch-budget-hint" aria-live="polite"></p>
    </fieldset>
    <div class="field" id="dispatch-command-field" hidden>
      <label for="dispatch-command">Autonomous command</label>
      <textarea class="input cmd-preview" id="dispatch-command" rows="4" spellcheck="false"></textarea>
      <p class="field-hint" id="dispatch-command-hint">Leave unchanged to use the server's default runner (Claude Code unless <code>NATIV_RUNNER_COMMAND</code> is set). In a custom command, <code>{taskId}</code>, <code>{taskTitle}</code> and <code>{worktreeDir}</code> are filled in on launch.</p>
    </div>
    <div class="switches" role="group" aria-label="Run options">
      <label class="switch"><input type="checkbox" id="dispatch-worktree" checked><span class="switch-track" aria-hidden="true"></span><span class="switch-text"><b>Isolated Worktree</b><span>Run on branch agent/task-&lt;id&gt; in .worktrees/, away from your working copy.</span></span></label>
      <label class="switch"><input type="checkbox" id="dispatch-verify-gate" checked><span class="switch-track" aria-hidden="true"></span><span class="switch-text"><b>Auto-verify Gatekeeper</b><span>Run the test command when the agent exits.</span></span></label>
      <label class="switch"><input type="checkbox" id="dispatch-merge"><span class="switch-track" aria-hidden="true"></span><span class="switch-text"><b>Auto-merge on Pass</b><span>Merge the worktree branch into main once verification passes.</span></span></label>
    </div>
    <p class="field-error" id="dispatch-error" aria-live="polite"></p>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn primary" type="button" id="btn-launch-agent" aria-keyshortcuts="Control+Enter"><svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>Launch Autonomous Runner <kbd>Ctrl+Enter</kbd></button>
    </div>
  </form>
</dialog>

<dialog id="confirm-dialog" class="narrow" aria-labelledby="confirm-title" aria-describedby="confirm-body">
  <form class="modal" method="dialog">
    <h2 id="confirm-title">Confirm</h2>
    <p class="lead" id="confirm-body"></p>
    <div class="modal-foot">
      <button class="btn" value="cancel" type="submit">Cancel</button>
      <button class="btn primary" type="button" id="btn-confirm-ok">Confirm</button>
    </div>
  </form>
</dialog>

<dialog id="conn-dialog" aria-labelledby="conn-title">
  <form class="modal" method="dialog" id="conn-form">
    <h2 id="conn-title">Connection Settings</h2>
    <p class="lead">Connection strings stay in memory inside the local nativ process. They are never written to disk or shown to AI agents; only masked URLs are displayed.</p>
    <div id="conn-template-chips" hidden></div>
    <div class="field" data-env="dev">
      <label for="engine-dev"><span class="dot" id="mdot-dev"></span> Dev / Staging</label>
      <div class="field-row">
        <select class="input" id="engine-dev" data-engine="dev" aria-label="Dev database type">
          <option value="url">Connection URL (PostgreSQL, MySQL, SQLite, MongoDB)</option>
          <option value="form">Connection Form (XAMPP / Parameters)</option>
          <option value="firestore">Firebase Firestore</option>
        </select>
      </div>
      <div class="param-grid" id="params-dev" hidden>
        <select class="input" id="pengine-dev" aria-label="Dev database engine">
          <option value="mysql">MySQL</option>
          <option value="postgresql">PostgreSQL</option>
        </select>
        <input class="input" id="phost-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev host" placeholder="Host, e.g. 127.0.0.1">
        <input class="input" id="pport-dev" type="text" inputmode="numeric" autocomplete="off" aria-label="Dev port" placeholder="Port">
        <input class="input" id="puser-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev user" placeholder="User">
        <input class="input span-2" id="ppass-dev" type="password" autocomplete="new-password" aria-label="Dev password" placeholder="Password (empty for XAMPP root)">
        <input class="input span-2" id="pdb-dev" type="text" autocomplete="off" spellcheck="false" aria-label="Dev database name" placeholder="Database name">
        <button class="btn small" type="button" data-xampp="dev">Use XAMPP Defaults</button>
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
          <option value="form">Connection Form (XAMPP / Parameters)</option>
          <option value="firestore">Firebase Firestore</option>
        </select>
      </div>
      <div class="param-grid" id="params-prod" hidden>
        <select class="input" id="pengine-prod" aria-label="Production database engine">
          <option value="mysql">MySQL</option>
          <option value="postgresql">PostgreSQL</option>
        </select>
        <input class="input" id="phost-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production host" placeholder="Host">
        <input class="input" id="pport-prod" type="text" inputmode="numeric" autocomplete="off" aria-label="Production port" placeholder="Port">
        <input class="input" id="puser-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production user" placeholder="User">
        <input class="input span-2" id="ppass-prod" type="password" autocomplete="new-password" aria-label="Production password" placeholder="Password">
        <input class="input span-2" id="pdb-prod" type="text" autocomplete="off" spellcheck="false" aria-label="Production database name" placeholder="Database name">
        <button class="btn small" type="button" data-xampp="prod">Use XAMPP Defaults</button>
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
  <form class="modal media-modal" method="dialog">
    <h2 id="media-title">Image field</h2>
    <p class="lead" id="media-sub"></p>
    <div class="thumb-box" id="media-thumb"></div>
    <dl id="media-details"></dl>
    <p class="media-note">Only metadata from sampled documents is shown. Raw image bytes and full Base64 payloads are never sent to the browser or to AI agents.</p>
    <div class="modal-foot"><button class="btn" value="close" type="submit">Close</button></div>
  </form>
</dialog>

<dialog id="record-dialog" aria-labelledby="record-title">
  <form class="modal" method="dialog" id="record-form">
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
  <form class="modal modal-prod-guard" method="dialog" id="challenge-form">
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
  // Database Studio state (View 5).
  var state = {
    tab: 'explorer',
    envMode: 'dev',
    dbStarted: false,
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
    pendingMutation: null,
    envInfo: null
  };
  // Media fields rendered in the current view, referenced by index from IMAGE badges.
  var mediaRegistry = [];

  var $ = function (id) { return document.getElementById(id); };

  var ICON = {
    check: '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
    x: '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    shield: '<svg class="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8l5.2 2.1v3.7c0 3.1-2.2 5.6-5.2 6.6-3-1-5.2-3.5-5.2-6.6V3.9z"/><path d="M5.6 8.1l1.7 1.7 3.2-3.3"/></svg>',
    play: '<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
    alert: '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
    branch: '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11.2 7.4"/></svg>',
    gauge: '<svg class="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/></svg>'
  };

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
        // DB routes answer { error: { code, message } }; pipeline routes answer { ok: false, error: "..." }.
        if (!res.ok || body.ok === false) {
          var message = typeof body.error === 'string' ? body.error : (body.error && body.error.message) || body.message;
          var err = new Error(message || ('Request failed (' + res.status + ')'));
          err.code = (body.error && body.error.code) || body.code;
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function postJson(path, body) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  function openDialog(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  // ─── Toasts ────────────────────────────────────────────────────────────────
  function hintFor(message) {
    var m = String(message || '');
    if (/ECONNREFUSED|ETIMEDOUT|timeout|EHOSTUNREACH/i.test(m)) return 'Check that the database server is running and the host/port are reachable from this machine.';
    if (/ENOTFOUND|getaddrinfo/i.test(m)) return 'The hostname could not be resolved. Verify the host in your connection string.';
    if (/password|authentication|access denied/i.test(m)) return 'Credentials were rejected. Re-enter the connection string in Connection Settings.';
    if (/unable to open database file/i.test(m)) return 'The SQLite file was not found. Check the path relative to where nativ was started.';
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

  // ─── Formatting ────────────────────────────────────────────────────────────
  function num(n) {
    if (n == null || n === '' || isNaN(n)) return '–';
    return Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  }
  function usd(n) {
    if (n == null || isNaN(n)) return '–';
    n = Number(n);
    return '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
  }
  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '–';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(2) + ' s';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }
  function clampPct(v) { return Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
  /** Telemetry stores the gatekeeper pass rate as a 0..1 ratio; tolerate a 0..100 percentage too. */
  function passRatePct(v) {
    if (v == null || isNaN(v)) return null;
    return clampPct(v <= 1 ? v * 100 : v);
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try { return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return d.toLocaleString(); }
  }
  function humanize(key) {
    var words = String(key).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    words = words.replace(/ ms$/, ' (ms)').replace(/ usd$/, ' (USD)');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  function detailValue(v) {
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) return v.map(String).join(', ');
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v == null ? '–' : v);
  }

  // ─── Mission Control: pipeline state ───────────────────────────────────────
  var VIEWS = ['overview', 'tasks', 'worktrees', 'benchmarks', 'database'];
  var VIEW_DEPS = {
    overview: ['status', 'tasks', 'telemetry', 'escalations'],
    tasks: ['tasks', 'runs', 'escalations'],
    worktrees: ['worktrees', 'tasks'],
    benchmarks: ['benchmarks']
  };
  var PIPE_PATHS = {
    status: '/api/pipeline/status',
    tasks: '/api/pipeline/tasks',
    worktrees: '/api/pipeline/worktrees',
    benchmarks: '/api/pipeline/benchmarks',
    runs: '/api/pipeline/tasks/runs',
    telemetry: '/api/pipeline/telemetry/detailed',
    escalations: '/api/pipeline/escalations?status=pending_review'
  };
  var ALL_PARTS = ['status', 'tasks', 'worktrees', 'benchmarks', 'runs', 'telemetry', 'escalations'];
  /** Circuit-breaker budget from the task execution loop. */
  var MAX_ATTEMPTS = 3;
  var REDUCED_MOTION = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  var ui = { view: 'overview' };
  var pipe = {
    status: null,
    milestones: [],
    worktrees: [],
    runs: [],
    report: null,
    /** GET /api/pipeline/telemetry/detailed: { summary, taskBreakdowns }. */
    telemetry: null,
    /** Pending escalations, newest first; each may carry a self-healing proposedPatch. */
    escalations: [],
    loaded: {},
    errors: {},
    busy: {},
    changedAt: {},
    syncedAt: null,
    filterMilestone: 'all',
    filterText: ''
  };

  var STATUS_META = {
    pending: { label: 'Pending', tone: 'neutral' },
    in_progress: { label: 'In Progress', tone: 'active' },
    completed: { label: 'Completed', tone: 'success' },
    blocked: { label: 'Blocked', tone: 'danger' }
  };
  function statusBadge(s) {
    var m = STATUS_META[s] || { label: s || 'Unknown', tone: 'neutral' };
    return '<span class="badge badge-' + m.tone + '">' + esc(m.label) + '</span>';
  }

  function allTasks() {
    var out = [];
    (pipe.milestones || []).forEach(function (m) { (m.tasks || []).forEach(function (t) { out.push(t); }); });
    return out;
  }
  function taskById(id) {
    var found = null;
    allTasks().some(function (t) { if (t.id === id) { found = t; return true; } return false; });
    return found;
  }
  function activeMilestone() {
    var ms = pipe.milestones || [];
    for (var i = 0; i < ms.length; i++) if (ms[i].status === 'in_progress') return ms[i];
    for (var j = 0; j < ms.length; j++) if (ms[j].status !== 'completed') return ms[j];
    return null;
  }

  function setProjectName(name) {
    if (!name) return;
    var el = $('project-name');
    el.textContent = name;
    el.hidden = false;
    document.title = 'Nativ Studio · ' + name;
  }

  function fetchPipeline(parts) {
    return Promise.all(parts.map(function (part) {
      return api(PIPE_PATHS[part]).then(function (body) {
        applyPipeline(part, body);
        pipe.errors[part] = null;
      }, function (e) {
        pipe.errors[part] = e.message;
      }).then(function () { pipe.loaded[part] = true; });
    })).then(function () {
      pipe.syncedAt = new Date();
      updateNavCounts();
      repaintFor(parts);
    });
  }

  function applyPipeline(part, body) {
    if (part === 'status') {
      pipe.status = body.pipeline || null;
      if (pipe.status) setProjectName(pipe.status.projectName);
    } else if (part === 'tasks') {
      var before = {};
      allTasks().forEach(function (t) { before[t.id] = t.status; });
      var hadTasks = !!pipe.loaded.tasks;
      pipe.milestones = Array.isArray(body.milestones) ? body.milestones : [];
      setProjectName(body.projectName);
      // Remember which cards changed column so they can flash once after the live update.
      if (hadTasks) {
        var now = Date.now();
        allTasks().forEach(function (t) { if (before[t.id] !== t.status) pipe.changedAt[t.id] = now; });
      }
    } else if (part === 'worktrees') {
      pipe.worktrees = Array.isArray(body.worktrees) ? body.worktrees : [];
      setWorkspaceFooter();
    } else if (part === 'runs') {
      pipe.runs = Array.isArray(body.runs) ? body.runs : [];
    } else if (part === 'benchmarks') {
      pipe.report = body.report || null;
    } else if (part === 'telemetry') {
      pipe.telemetry = { summary: body.summary || {}, taskBreakdowns: Array.isArray(body.taskBreakdowns) ? body.taskBreakdowns : [] };
    } else if (part === 'escalations') {
      pipe.escalations = Array.isArray(body.escalations) ? body.escalations : [];
      syncHealTab();
    }
  }

  /** Newest pending escalation for a task (the list arrives newest first). */
  function escalationFor(taskId) {
    var found = null;
    (pipe.escalations || []).some(function (e) { if (e.taskId === taskId && e.status === 'pending_review') { found = e; return true; } return false; });
    return found;
  }
  function proposalCount() {
    return (pipe.escalations || []).filter(function (e) { return e.status === 'pending_review' && e.proposedPatch; }).length;
  }

  /** Sidebar footer: the main (non-agent) worktree is the workspace root and carries the active branch. */
  function setWorkspaceFooter() {
    var main = null;
    pipe.worktrees.some(function (w) { if (!w.isAgentWorktree) { main = w; return true; } return false; });
    var root = main ? String(main.path || '') : '';
    $('sb-root').textContent = root || '–';
    $('sb-root').title = root;
    $('sb-branch-name').textContent = main ? (main.branch || 'detached') : '–';
  }

  /** 1234 → "1.2k": keeps the sidebar throughput indicator inside its badge. */
  function compactNum(n) {
    if (!isFinite(n)) return '–';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  function setCount(view, text, title) {
    var el = $('ncount-' + view);
    el.textContent = text;
    if (title) el.title = title; else el.removeAttribute('title');
  }

  function updateNavCounts() {
    var st = pipe.status;
    setCount('overview', st && st.tasks ? clampPct(st.tasks.progressPercentage) + '%' : '–', 'Tasks complete');
    var tasksOk = pipe.loaded.tasks && !(pipe.errors.tasks && !pipe.milestones.length);
    var active = allTasks().filter(function (t) { return t.status === 'in_progress'; }).length;
    setCount('tasks', tasksOk ? String(active) : '–', 'Tasks in progress');
    var proposals = proposalCount();
    var pBadge = $('ncount-proposals');
    pBadge.hidden = !proposals;
    pBadge.textContent = String(proposals);
    pBadge.title = proposals + ' self-healing proposal' + (proposals === 1 ? '' : 's') + ' awaiting review';
    var agents = pipe.worktrees.filter(function (w) { return w.isAgentWorktree; }).length;
    setCount('worktrees', pipe.loaded.worktrees && !pipe.errors.worktrees ? String(agents) : '–', 'Agent worktrees');
    var s = pipe.report && pipe.report.summary;
    setCount('benchmarks', s ? compactNum(Number(s.averageThroughputOpsPerSec) || 0) : '–', s ? 'Average throughput (ops/sec) · score ' + clampPct(s.score) + '%' : 'Benchmark throughput');
    var dbReady = state.dbStarted && !state.loading;
    setCount('database', dbReady ? String((state.schema.devTables || []).length + (state.schema.prodTables || []).length) : '–', 'Tables and collections');
  }

  // ─── Mission Control: painting with smooth live transitions ────────────────
  var RENDERERS = {
    overview: function () { return renderOverview(); },
    tasks: function () { return renderTasks(); },
    worktrees: function () { return renderWorktrees(); },
    benchmarks: function () { return renderBenchmarks(); }
  };

  function isViewLoading(view) {
    return (VIEW_DEPS[view] || []).some(function (p) { return !pipe.loaded[p]; });
  }

  function repaintFor(parts) {
    var deps = VIEW_DEPS[ui.view];
    if (deps && deps.some(function (d) { return parts.indexOf(d) !== -1; })) paint(ui.view);
  }

  function repaint(view) { if (ui.view === view) paint(view); }

  /** Re-renders a view in place: keeps focus and caret, slides moved cards, and eases progress bars. */
  function paint(view) {
    var panel = $('panel-' + view);
    var render = RENDERERS[view];
    if (!panel || !render) return;
    var focus = focusMemo(panel);
    var rects = snapshot(panel, 'data-flip', function (el) { return el.getBoundingClientRect(); });
    var bars = snapshot(panel, 'data-bar', function (el) { return el.style.width; });
    panel.innerHTML = render();
    panel.setAttribute('aria-busy', String(isViewLoading(view)));
    animateMoves(panel, rects);
    animateBars(panel, bars);
    restoreFocus(panel, focus);
  }

  function snapshot(root, attr, read) {
    var map = {};
    root.querySelectorAll('[' + attr + ']').forEach(function (el) { map[el.getAttribute(attr)] = read(el); });
    return map;
  }

  function animateMoves(root, before) {
    if (REDUCED_MOTION.matches) return;
    root.querySelectorAll('[data-flip]').forEach(function (el) {
      var prev = before[el.getAttribute('data-flip')];
      if (!prev || typeof el.animate !== 'function') return;
      var now = el.getBoundingClientRect();
      var dx = prev.left - now.left, dy = prev.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 360, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    });
  }

  function animateBars(root, before) {
    root.querySelectorAll('[data-bar]').forEach(function (el) {
      var prev = before[el.getAttribute('data-bar')];
      var next = el.style.width;
      if (prev == null || prev === next) return;
      el.style.width = prev;
      void el.offsetWidth;
      el.style.width = next;
    });
  }

  function cssEsc(v) { return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'); }

  function focusMemo(root) {
    var el = document.activeElement;
    if (!el || el === document.body || el === root || !root.contains(el)) return null;
    var sel = null;
    if (el.id) sel = '#' + cssEsc(el.id);
    else if (el.getAttribute('data-action')) {
      sel = '[data-action="' + cssEsc(el.getAttribute('data-action')) + '"]';
      if (el.getAttribute('data-key')) sel += '[data-key="' + cssEsc(el.getAttribute('data-key')) + '"]';
    }
    return sel ? { sel: sel, start: el.selectionStart, end: el.selectionEnd } : null;
  }

  function restoreFocus(root, memo) {
    if (!memo) return;
    var el = root.querySelector(memo.sel);
    if (!el || el.disabled) return;
    el.focus({ preventScroll: true });
    if (memo.start != null && typeof el.setSelectionRange === 'function') {
      try { el.setSelectionRange(memo.start, memo.end); } catch (e) { /* ignore */ }
    }
  }

  // ─── Mission Control: shared fragments ─────────────────────────────────────
  function panelHead(title, lead, actions) {
    return '<div class="panel-head"><div class="panel-title"><h1>' + title + '</h1>' + (lead ? '<p class="lead">' + lead + '</p>' : '') + '</div>' +
      (actions ? '<div class="panel-actions">' + actions + '</div>' : '') + '</div>';
  }

  function progressBar(pct, key, label, tone) {
    return '<div class="progress' + (tone ? ' ' + tone : '') + '" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
      '<span data-bar="' + esc(key) + '" style="width:' + pct + '%"></span></div>';
  }

  function errorCard(what, message, part) {
    var missing = /No route for|NOT_FOUND|\(404\)/.test(message || '');
    return '<div class="card state state-error" role="alert"><div class="state-icon">' + ICON.alert + '</div>' +
      '<h2>Could not load ' + esc(what) + '</h2><p>' + esc(message) + '</p>' +
      (missing ? '<p>This studio server does not expose the pipeline API yet. Restart it with a nativ build that includes the Mission Control endpoints.</p>' : '') +
      '<button class="btn" type="button" data-action="retry" data-key="' + part + '">Retry</button></div>';
  }

  /** Data is still shown after a failed live refresh; say so instead of silently going stale. */
  function staleNote(part) {
    return pipe.errors[part] ? '<p class="notice" role="status">Showing the last synced data. Refresh failed: ' + esc(pipe.errors[part]) + '</p>' : '';
  }

  function skeletonCards(n, cls) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="card ' + (cls || 'kpi') + '"><div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    return out;
  }

  // ─── View 1: Overview & Status ─────────────────────────────────────────────
  var CONTRACTS = [
    ['masterPlanExists', 'master_plan.json'],
    ['contextExists', 'context.md'],
    ['dbSchemaExists', 'db_schema.json'],
    ['apiContractsExists', 'api_contracts.json'],
    ['uiSpecsExists', 'ui_specs.md']
  ];

  function renderOverview() {
    var synced = pipe.syncedAt ? ' · synced ' + esc(pipe.syncedAt.toLocaleTimeString()) : '';
    var head = panelHead('Overview &amp; Status', 'Project progress, task breakdown, AI costs, and contract health' + synced + '.');
    if (!pipe.loaded.status) return head + '<div class="kpi-grid" aria-hidden="true">' + skeletonCards(4) + '</div>';
    if (pipe.errors.status && !pipe.status) return head + errorCard('pipeline status', pipe.errors.status, 'status') + burndown();
    var st = pipe.status || {};
    return head + staleNote('status') + '<div class="kpi-grid">' + kpiMilestones(st) + kpiVelocity(st) + kpiTelemetry(st) + kpiContracts(st) + '</div>' + burndown();
  }

  function kpiCard(title, badge, body) {
    return '<article class="card kpi"><header class="kpi-head"><h2>' + title + '</h2>' + (badge || '') + '</header>' + body + '</article>';
  }

  function kpiMilestones(st) {
    var m = st.milestones || {}, t = st.tasks || {};
    var pct = clampPct(t.progressPercentage);
    var active = activeMilestone();
    return kpiCard('Active Milestones', active ? '<span class="badge badge-active" title="Active milestone">' + esc(active.id) + '</span>' : '',
      '<div class="kpi-value">' + num(m.completed) + '<span class="kpi-of">/ ' + num(m.total) + '</span></div>' +
      '<p class="kpi-sub">milestones completed' + (m.inProgress ? ' · ' + num(m.inProgress) + ' in progress' : '') + '</p>' +
      progressBar(pct, 'overall', 'Overall task progress') +
      '<p class="kpi-foot" title="' + esc(active ? active.name : '') + '">' + pct + '% of tasks complete' + (active ? ' · ' + esc(active.name) : '') + '</p>');
  }

  function kpiVelocity(st) {
    var t = st.tasks || {};
    var total = Number(t.total) || 0;
    var rows = [['completed', 'Completed', t.completed], ['in_progress', 'In Progress', t.inProgress], ['pending', 'Pending', t.pending], ['blocked', 'Blocked', t.blocked]];
    var segs = rows.map(function (r) {
      var w = total ? (Number(r[2]) || 0) / total * 100 : 0;
      return w ? '<span class="seg seg-' + r[0] + '" style="width:' + w.toFixed(2) + '%"></span>' : '';
    }).join('');
    var summary = rows.map(function (r) { return r[1] + ' ' + (Number(r[2]) || 0); }).join(', ');
    return kpiCard('Task Velocity', '',
      '<div class="kpi-value">' + num(total) + '<span class="kpi-of">tasks</span></div>' +
      '<div class="stack" role="img" aria-label="' + esc(summary) + '">' + segs + '</div>' +
      '<ul class="legend">' + rows.map(function (r) {
        return '<li><span class="dot dot-' + r[0] + '" aria-hidden="true"></span>' + r[1] + '<b>' + num(r[2] || 0) + '</b></li>';
      }).join('') +
      '<li title="Self-healing proposals awaiting review"><span class="dot dot-proposal" aria-hidden="true"></span>Proposals<b>' +
        (pipe.loaded.escalations ? num(proposalCount()) : '–') + '</b></li>' +
      '</ul>');
  }

  /**
   * Input and cache-read list prices (USD per 1M tokens) used only to estimate what prompt caching
   * saved. Mirrors MODEL_PRICING in core/telemetry.ts; unknown models fall back to Opus 5 rates.
   */
  var CACHE_RATES = {
    'claude-fable-5-1': [10, 0.25], 'claude-fable-5': [10, 1], 'claude-opus-5-5': [4, 0.2], 'claude-opus-5': [5, 0.5],
    'claude-opus-4-8': [5, 0.5], 'claude-opus-4-7': [5, 0.5], 'claude-opus-4-6': [5, 0.5], 'claude-sonnet-5': [2, 0.2],
    'claude-sonnet-4-6': [3, 0.3], 'claude-haiku-4-5': [1, 0.1]
  };
  function cacheRates(model) {
    var best = null;
    Object.keys(CACHE_RATES).forEach(function (id) {
      if (String(model || '').indexOf(id) === 0 && (!best || id.length > best.length)) best = id;
    });
    return CACHE_RATES[best || 'claude-opus-5'];
  }
  /** Cache reads billed at the read rate instead of the full input rate, summed per model. */
  function cacheSavingsUsd(summary) {
    return ((summary && summary.byModel) || []).reduce(function (sum, m) {
      var r = cacheRates(m.model);
      return sum + (Number(m.cacheReadTokens) || 0) * (r[0] - r[1]) / 1e6;
    }, 0);
  }
  /** Grounded spend is small per task: show four decimals below a dollar (ui_specs.md: $0.3184). */
  function usdSpend(n) {
    if (n == null || isNaN(n)) return '–';
    n = Number(n);
    return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
  }

  function telChip(label, value, title) {
    return '<li title="' + esc(title) + '"><span>' + label + '</span><b>' + value + '</b></li>';
  }

  function kpiTelemetry(st) {
    var tel = st.telemetry || {};
    var rate = passRatePct(tel.passRate);
    var summary = pipe.telemetry && pipe.telemetry.summary;
    var actual = (summary && summary.actual) || null;
    var spend = Number(tel.actualSpendUsd) || 0;
    var hasUsage = spend > 0 || !!(actual && actual.turns);
    var hitPct = Math.round((Number(tel.cacheHitRate) || 0) * 1000) / 10;
    var badge = hasUsage ? '<span class="badge badge-success" title="Spend reported by the Claude API">Grounded</span>' : '<span class="badge badge-neutral">Estimate</span>';

    var pill;
    if (!hasUsage) {
      pill = '<p class="kpi-note">No native runs yet. Estimated cost so far: ' + usd(tel.estimatedCostUsd) + '. Dispatch with the Native Engine to report exact spend.</p>';
    } else {
      var saved = summary ? cacheSavingsUsd(summary) : null;
      pill = '<span class="cache-pill" title="Share of prompt tokens served from the prompt cache"><span class="label">Cache Hit Rate</span><b>' + hitPct + '%</b>' +
        (saved ? '<span class="save">Saved ~' + usdSpend(saved) + ' via Ephemeral Caching</span>' : '') + '</span>';
    }

    // Token breakdown comes from the detailed audit; the status call alone carries only cache counters.
    var chips;
    if (pipe.errors.telemetry && !summary) {
      chips = '<p class="kpi-note">Token breakdown unavailable. <button class="btn small" type="button" data-action="retry" data-key="telemetry">Retry</button></p>';
    } else {
      var loading = !pipe.loaded.telemetry;
      var fresh = actual ? (Number(actual.inputTokens) || 0) + (Number(actual.cacheCreationTokens) || 0) : null;
      var out = actual ? compactNum(Number(actual.outputTokens) || 0) + ' / ' + compactNum(Number(actual.thinkingTokens) || 0) : null;
      chips = '<ul class="tel-chips">' +
        telChip('Cached Input', compactNum(Number(tel.cacheReadTokens) || 0), 'Prompt tokens read from the cache') +
        telChip('Fresh Input', loading || fresh == null ? '–' : compactNum(fresh), 'Uncached prompt tokens plus cache writes') +
        telChip('Output / Thinking', loading || out == null ? '–' : out, 'Output tokens, of which spent on reasoning') +
        telChip('Gatekeeper Pass', rate == null ? '–' : rate + '%', 'Verification pass rate across completed tasks') +
        '</ul>';
    }

    return kpiCard('Financial &amp; Cache Telemetry', badge,
      '<div class="kpi-value">' + usdSpend(spend) + '<span class="kpi-of">actual spend</span></div>' + pill + chips);
  }

  function kpiContracts(st) {
    var c = st.contracts || {};
    var present = CONTRACTS.filter(function (x) { return !!c[x[0]]; }).length;
    var intact = present === CONTRACTS.length;
    return kpiCard('Specification Contracts',
      '<span class="badge badge-' + (intact ? 'success' : 'danger') + '">' + (intact ? 'Intact' : (CONTRACTS.length - present) + ' missing') + '</span>',
      '<div class="kpi-value">' + present + '<span class="kpi-of">/ ' + CONTRACTS.length + ' present</span></div>' +
      '<ul class="checklist">' + CONTRACTS.map(function (x) {
        var ok = !!c[x[0]];
        return '<li class="' + (ok ? 'ok' : 'missing') + '"><span class="check">' + (ok ? ICON.check : ICON.x) + '</span><code>.ai/' + x[1] + '</code>' +
          '<span class="sr-only">' + (ok ? 'present' : 'missing') + '</span></li>';
      }).join('') + '</ul>');
  }

  function burndown() {
    var ms = pipe.milestones || [];
    var body;
    if (!pipe.loaded.tasks) body = '<div class="skeleton"></div><div class="skeleton"></div>';
    else if (pipe.errors.tasks && !ms.length) body = errorCard('milestones', pipe.errors.tasks, 'tasks');
    else if (!ms.length) body = '<p class="muted">No milestones in .ai/master_plan.json yet.</p>';
    else body = '<ol class="steps">' + ms.map(stepHtml).join('') + '</ol>';
    var done = ms.filter(function (m) { return m.status === 'completed'; }).length;
    return '<section class="card section" aria-labelledby="burndown-h"><header class="section-head"><h2 id="burndown-h">Milestone Progress</h2>' +
      (ms.length ? '<span class="muted">' + done + ' of ' + ms.length + ' completed</span>' : '') + '</header>' + body + '</section>';
  }

  function stepHtml(m, i) {
    var tasks = m.tasks || [];
    var done = tasks.filter(function (t) { return t.status === 'completed'; }).length;
    var blocked = tasks.filter(function (t) { return t.status === 'blocked'; }).length;
    var pct = tasks.length ? Math.round(done / tasks.length * 100) : (m.status === 'completed' ? 100 : 0);
    var cls = m.status === 'completed' ? 'is-completed' : m.status === 'in_progress' ? 'is-active' : 'is-pending';
    var desc = m.description ? esc(m.description) : done + ' of ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ' completed';
    return '<li class="step ' + cls + '"><span class="step-marker" aria-hidden="true">' + (m.status === 'completed' ? ICON.check : String(i + 1)) + '</span>' +
      '<div class="step-body"><div class="step-title"><h3>' + esc(m.name) + '</h3><code class="muted">' + esc(m.id) + '</code>' + statusBadge(m.status) +
      (m.fastPath ? '<span class="badge badge-neutral">fast path</span>' : '') +
      (blocked ? '<span class="badge badge-danger">' + blocked + ' blocked</span>' : '') + '</div>' +
      '<p class="step-desc">' + desc + '</p>' + progressBar(pct, 'ms-' + m.id, m.name + ' progress', m.status === 'completed' ? 'success' : '') + '</div>' +
      '<span class="step-pct">' + pct + '%</span></li>';
  }

  // ─── View 2: Live Tasks kanban ─────────────────────────────────────────────
  var COLUMNS = [
    { status: 'pending', label: 'Pending', empty: 'Nothing queued.' },
    { status: 'in_progress', label: 'In Progress', empty: 'No task is running.' },
    { status: 'completed', label: 'Completed', empty: 'No completed tasks yet.' },
    { status: 'blocked', label: 'Blocked', empty: 'No blocked tasks.' }
  ];
  var BUSY_LABEL = { start: 'Starting…', complete: 'Verifying…', block: 'Blocking…', dispatch: 'Dispatching…', abort: 'Aborting…' };

  // ─── Autonomous runner state (/api/pipeline/tasks/runs + runner_* SSE) ─────
  var RUN_ACTIVE = { spawning_worktree: 1, running: 1, verifying: 1, merging: 1 };
  var RUN_LABEL = {
    spawning_worktree: 'Worktree',
    running: 'Claude Running',
    verifying: 'Verifying',
    merging: 'Merging',
    completed: 'Run completed',
    failed: 'Run failed',
    aborted: 'Run aborted'
  };
  var RUN_TONE = { completed: 'is-done', failed: 'is-danger', aborted: 'is-warn' };

  function runFor(taskId) {
    var found = null;
    (pipe.runs || []).some(function (r) { if (r.taskId === taskId) { found = r; return true; } return false; });
    return found;
  }
  function isRunActive(run) { return !!run && !!RUN_ACTIVE[run.status]; }
  function upsertRun(run) {
    if (!run || !run.taskId) return;
    pipe.runs = [run].concat((pipe.runs || []).filter(function (r) { return r.taskId !== run.taskId; }));
  }
  function unmetDeps(t) {
    return (t.dependencies || []).filter(function (d) { var dep = taskById(d); return !dep || dep.status !== 'completed'; });
  }
  function elapsedOf(run) {
    if (!run || !run.startedAt) return null;
    var ms = isRunActive(run) ? Date.now() - Date.parse(run.startedAt) : run.durationMs;
    return typeof ms === 'number' && isFinite(ms) && ms >= 0 ? ms : null;
  }
  /** mm:ss, the elapsed format ui_specs.md asks for on running cards and in the drawer. */
  function clock(ms) {
    var total = Math.floor((ms || 0) / 1000);
    var mm = Math.floor(total / 60), ss = total % 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function runPill(run) {
    if (!run) return '';
    var label = RUN_LABEL[run.status] || run.status;
    var ms = elapsedOf(run);
    var text = label + (isRunActive(run) && ms != null ? ' (' + clock(ms) + ')' : '');
    return '<span class="run-pill ' + (RUN_TONE[run.status] || '') + '" title="' + esc(label + ' · run ' + (run.runId || '')) + '">' +
      '<span class="run-dot" aria-hidden="true"></span>' + esc(text) + '</span>';
  }

  function taskFilters() {
    var opts = '<option value="all">All milestones</option>' + (pipe.milestones || []).map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (pipe.filterMilestone === m.id ? ' selected' : '') + '>' + esc(m.id + ' · ' + m.name) + '</option>';
    }).join('');
    return '<label class="sr-only" for="task-milestone">Milestone</label><select class="input" id="task-milestone">' + opts + '</select>' +
      '<label class="sr-only" for="task-search">Filter tasks</label><input class="input" id="task-search" type="search" placeholder="Filter by ID, title, agent or file" value="' + esc(pipe.filterText) + '">';
  }

  function visibleTasks() {
    var q = pipe.filterText.trim().toLowerCase();
    var out = [];
    (pipe.milestones || []).forEach(function (m) {
      if (pipe.filterMilestone !== 'all' && m.id !== pipe.filterMilestone) return;
      (m.tasks || []).forEach(function (t) {
        if (q) {
          var hay = [t.id, t.title, t.assignedSubagent].concat(t.targetFiles || []).join(' ').toLowerCase();
          if (hay.indexOf(q) === -1) return;
        }
        out.push(t);
      });
    });
    return out;
  }

  function renderTasks() {
    var head = panelHead('Live Tasks', 'Real-time kanban of <code>.ai/master_plan.json</code>. Cards move as agents start, verify and block work.', taskFilters());
    if (!pipe.loaded.tasks) return head + '<div class="kanban" aria-hidden="true">' + skeletonCards(4, 'kcol') + '</div>';
    if (pipe.errors.tasks && !pipe.milestones.length) return head + errorCard('tasks', pipe.errors.tasks, 'tasks');
    var tasks = visibleTasks();
    var filtered = pipe.filterMilestone !== 'all' || !!pipe.filterText.trim();
    var cols = COLUMNS.map(function (c) {
      var items = tasks.filter(function (t) { return t.status === c.status; });
      return '<section class="kcol kcol-' + c.status + '" aria-labelledby="kcol-' + c.status + '">' +
        '<header class="kcol-head"><h2 id="kcol-' + c.status + '"><span class="dot dot-' + c.status + '" aria-hidden="true"></span>' + c.label + '</h2><span class="count">' + items.length + '</span></header>' +
        '<div class="kcol-body" role="list">' + (items.length ? items.map(taskCard).join('') : '<p class="kcol-empty">' + (filtered ? 'No matching tasks.' : c.empty) + '</p>') + '</div></section>';
    }).join('');
    return head + staleNote('tasks') + '<div class="kanban">' + cols + '</div>';
  }

  /** Prefers the server's circuit-breaker state; falls back to the "failed after N attempts" block reason. */
  function attemptCount(t) {
    if (typeof t.attempts === 'number') return t.attempts;
    var cb = t.circuitBreaker;
    if (cb && cb.consecutiveFailures > 0) return cb.consecutiveFailures;
    var m = /(\d+)\s+(?:fix\s+)?attempts?/i.exec(t.notes || '');
    return m ? Number(m[1]) : null;
  }
  function attemptLimit(t) {
    return t.maxAttempts || (t.circuitBreaker && t.circuitBreaker.maxThreshold) || MAX_ATTEMPTS;
  }

  function actionBtn(action, key, label, tone) {
    return '<button class="btn small' + (tone ? ' ' + tone : '') + '" type="button" data-action="' + action + '" data-key="' + esc(key) + '" aria-label="' + esc(label + ' ' + key) + '">' + label + '</button>';
  }

  /** Primary dispatch affordance; disabled (with the blocking dependency named) until the task is ready. */
  function dispatchBtn(t) {
    var unmet = unmetDeps(t);
    if (!unmet.length) return actionBtn('task-dispatch', t.id, 'Dispatch', 'primary');
    var why = 'Waiting on ' + unmet.join(', ');
    return '<button class="btn small primary" type="button" disabled title="' + esc(why) + '" aria-label="' + esc('Dispatch for ' + t.id + ' is unavailable: ' + why) + '">Dispatch</button>';
  }

  function taskActions(t) {
    var busy = pipe.busy['task:' + t.id];
    if (busy) return '<button class="btn small" type="button" disabled><span class="spinner" aria-hidden="true"></span>' + BUSY_LABEL[busy] + '</button>';
    var run = runFor(t.id);
    if (isRunActive(run)) return actionBtn('run-console', t.id, 'Live Logs', '') + actionBtn('run-abort', t.id, 'Abort', 'danger');
    var console_ = run ? actionBtn('run-console', t.id, 'Live Logs', '') : '';
    if (t.status === 'pending') return console_ + actionBtn('task-start', t.id, 'Start', '') + dispatchBtn(t);
    if (t.status === 'in_progress') return console_ + actionBtn('task-block', t.id, 'Block', 'danger') + actionBtn('task-complete', t.id, 'Complete', 'primary') + dispatchBtn(t);
    if (t.status === 'blocked') return console_ + actionBtn('task-start', t.id, 'Retry', '') + dispatchBtn(t);
    return console_ + '<span class="done-label">' + ICON.check + 'Done</span>';
  }

  function taskCard(t) {
    var files = t.targetFiles || [];
    var unmet = unmetDeps(t);
    var run = runFor(t.id);
    var updated = pipe.changedAt[t.id] && Date.now() - pipe.changedAt[t.id] < 1500;
    var blocked = '';
    if (t.status === 'blocked') {
      var attempts = attemptCount(t);
      blocked = '<div class="tcard-blocked">' + (attempts != null ? '<span class="attempts">Attempts: ' + attempts + '/' + attemptLimit(t) + '</span>' : '') +
        (t.notes ? '<p>' + esc(t.notes) + '</p>' : '') + '</div>';
    }
    var escalation = escalationFor(t.id);
    var banner = '';
    if (escalation) {
      banner = '<button class="proposal-banner" type="button" data-action="heal-review" data-key="' + esc(t.id) + '">' + ICON.shield +
        (escalation.proposedPatch ? 'Proposal Ready &#8212; Click to Review &amp; Apply' : 'Escalated &#8212; Review &amp; Decide') + '</button>';
    }
    return '<article class="tcard is-' + esc(t.status) + (isRunActive(run) ? ' is-running' : '') + (updated ? ' is-updated' : '') +
      (escalation && escalation.proposedPatch ? ' has-proposal' : '') + '" role="listitem" data-flip="' + esc(t.id) + '">' +
      '<header class="tcard-head"><code class="tcard-id">' + (t.status === 'completed' ? '<span class="tcard-check">' + ICON.check + '</span>' : '') + esc(t.id) + '</code>' +
      (run ? runPill(run) : '') +
      '<span class="badge badge-agent">' + esc(t.assignedSubagent || 'unassigned') + '</span></header>' +
      '<h3 class="tcard-title">' + esc(t.title) + '</h3>' +
      (files.length ? '<ul class="file-list" aria-label="Target files">' + files.map(function (f) { return '<li class="file" title="' + esc(f) + '">' + esc(f) + '</li>'; }).join('') + '</ul>' : '') +
      (t.status === 'pending' && unmet.length ? '<p class="tcard-note">Waiting on ' + unmet.map(function (d) { return '<code>' + esc(d) + '</code>'; }).join(', ') + '</p>' : '') +
      blocked + banner +
      '<footer class="tcard-foot"><code class="cmd" title="' + esc(t.verificationCommand || '') + '">' +
      (t.verificationCommand ? '<span class="cmd-label">Test command: </span>' + esc(t.verificationCommand) : 'no test command') + '</code>' +
      '<div class="tcard-actions">' + taskActions(t) + '</div></footer></article>';
  }

  var ACTION_DONE = { start: 'Started', complete: 'Completed (gatekeeper passed)', block: 'Blocked' };
  var ACTION_FAIL = { start: 'Could not start', complete: 'Gatekeeper rejected completion of', block: 'Could not block' };

  function runTaskAction(action, taskId, reason) {
    var key = 'task:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = action;
    repaint('tasks');
    var body = { action: action, taskId: taskId };
    if (reason) body.reason = reason;
    postJson('/api/pipeline/tasks/action', body).then(function () {
      toast(ACTION_DONE[action] + ': ' + taskId, 'ok');
    }, function (e) {
      toast(ACTION_FAIL[action] + ' ' + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['status', 'tasks', 'worktrees']);
    });
  }

  // ─── Autonomous dispatch: POST /tasks/dispatch and /tasks/abort ────────────
  function runDispatch(taskId, customOptions) {
    var key = 'task:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = 'dispatch';
    repaint('tasks');
    var payload = Object.assign({ taskId: taskId }, customOptions || {});
    postJson('/api/pipeline/tasks/dispatch', payload).then(function (body) {
      upsertRun(body && body.run);
      var engine = body && body.run && body.run.engine === 'native' ? 'native engine' : 'CLI runner';
      toast('Dispatched ' + taskId + ' to the ' + engine, 'ok');
      openConsole(taskId, true);
    }, function (e) {
      toast('Could not dispatch ' + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['status', 'tasks', 'runs', 'worktrees']);
    });
  }

  function runAbort(taskId) {
    var key = 'task:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = 'abort';
    repaint('tasks');
    postJson('/api/pipeline/tasks/abort', { taskId: taskId, reason: 'Aborted from Nativ Studio' }).then(function () {
      toast('Abort signal sent to ' + taskId, 'ok');
    }, function (e) {
      toast('Could not abort ' + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['status', 'tasks', 'runs']);
    });
  }

  function confirmAbort(taskId) {
    confirmDialog({
      title: 'Abort agent run',
      body: 'Terminate the Claude process tree for ' + taskId + '? The isolated worktree and its branch are left in place so the partial work can be inspected.',
      confirmLabel: 'Abort Run',
      danger: true
    }, function () { runAbort(taskId); });
  }

  // ─── Intelligent dispatch modal (#dispatch-dialog) ─────────────────────────
  var pendingDispatch = null;

  /** Mirrors buildDefaultClaudeCommand() in agent-supervisor.ts so the preview matches what the server runs. */
  function defaultClaudeCommand(t) {
    var prompt = [
      'Execute task ' + t.id + ' (' + t.title + ').',
      t.description ? 'Description: ' + t.description + '.' : '',
      t.verificationCommand ? 'Verify your work using: ' + t.verificationCommand + '.' : '',
      'Start by running: nativ task start ' + t.id + '. When finished and verified, run: nativ task complete ' + t.id + '.',
      'If blocked, follow the Human-Centric Communication Protocol in CLAUDE.md: explain the user experience symptom, root cause in plain English, and clear options without technical jargon.'
    ].filter(Boolean).join(' ');
    return 'claude -p "' + prompt.replace(/"/g, '\\"') + '" --output-format stream-json --verbose --dangerously-skip-permissions';
  }

  function syncDispatchSwitches() {
    var isolated = $('dispatch-worktree').checked;
    var merge = $('dispatch-merge');
    merge.disabled = !isolated || !$('dispatch-verify-gate').checked;
    if (merge.disabled) merge.checked = false;
  }

  function checkedValue(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  /**
   * Current Claude models reject a fixed thinking budget, so the native engine maps it onto an
   * effort level (same buckets as thinkingBudgetToEffort in agent-supervisor.ts). Say so here
   * rather than implying an exact token cap.
   */
  function budgetHint(engine, budget) {
    if (engine === 'cli') {
      return budget ? 'Passed to Claude Code as MAX_THINKING_TOKENS=' + budget + '.' : 'Claude Code chooses its own thinking budget.';
    }
    if (!budget) return 'Uses the model default effort (medium on Claude Opus 5.5, whose thinking cannot be switched off).';
    var effort = budget <= 2048 ? 'low' : budget <= 8192 ? 'medium' : budget <= 24576 ? 'high' : budget <= 49152 ? 'xhigh' : 'max';
    return 'Runs at ' + effort + ' effort: the native engine maps token budgets onto effort levels.';
  }

  function syncDispatchEngine() {
    var engine = checkedValue('dispatch-engine') || 'native';
    $('dispatch-command-field').hidden = engine !== 'cli';
    $('dispatch-budget-hint').textContent = budgetHint(engine, Number(checkedValue('dispatch-budget')) || 0);
  }

  function openDispatchDialog(taskId) {
    var t = taskById(taskId);
    if (!t) { runDispatch(taskId); return; }
    var files = t.targetFiles || [];
    pendingDispatch = { taskId: t.id, preview: defaultClaudeCommand(t) };
    $('dispatch-task-id').textContent = t.id;
    $('dispatch-agent').textContent = t.assignedSubagent || 'unassigned';
    $('dispatch-task-title').textContent = t.title || '';
    $('dispatch-files').innerHTML = files.map(function (f) { return '<li class="file" title="' + esc(f) + '">' + esc(f) + '</li>'; }).join('');
    $('dispatch-files').hidden = !files.length;
    $('dispatch-verify').innerHTML = t.verificationCommand ? '<span class="cmd-label">Test command: </span>' + esc(t.verificationCommand) : 'no test command';
    $('dispatch-command').value = pendingDispatch.preview;
    $('dispatch-engine-native').checked = true;
    $('dispatch-budget-none').checked = true;
    syncDispatchEngine();
    $('dispatch-worktree').checked = true;
    $('dispatch-verify-gate').checked = !!t.verificationCommand;
    $('dispatch-verify-gate').disabled = !t.verificationCommand;
    $('dispatch-merge').checked = false;
    $('dispatch-error').textContent = '';
    syncDispatchSwitches();
    openDialog($('dispatch-dialog'));
    $('btn-launch-agent').focus();
  }

  function launchDispatch() {
    if (!pendingDispatch) return;
    var engine = checkedValue('dispatch-engine') || 'native';
    var budget = Number(checkedValue('dispatch-budget')) || 0;
    var command = $('dispatch-command').value.trim();
    if (engine === 'cli' && !command) {
      $('dispatch-error').textContent = 'Enter a runner command, or reopen the dialog to restore the generated one.';
      $('dispatch-command').focus();
      return;
    }
    var opts = {
      runnerEngine: engine,
      useWorktree: $('dispatch-worktree').checked,
      verify: $('dispatch-verify-gate').checked,
      autoMerge: $('dispatch-merge').checked
    };
    if (budget) opts.thinkingBudget = budget;
    // An untouched preview is the server's own default, which may be overridden by NATIV_RUNNER_COMMAND.
    if (engine === 'cli' && command !== pendingDispatch.preview) opts.runnerCommand = command;
    var id = pendingDispatch.taskId;
    pendingDispatch = null;
    $('dispatch-dialog').close();
    runDispatch(id, opts);
  }

  // ─── Live runner console drawer ────────────────────────────────────────────
  var RC_STEPS = ['Worktree', 'Claude', 'Verify', 'Merge'];
  var RC_STAGE = { spawning_worktree: 0, running: 1, verifying: 2, merging: 3 };
  var RC_MAX_NODES = 3000;
  var rc = { taskId: null, autoscroll: true, minimized: false, stage: 0, ticker: null, backfilled: false, tab: 'logs', diffSeq: 0, diffTimer: null, heal: null };

  /** Minimal SGR parser: escapes the chunk, then maps the colors agents actually emit. */
  var ANSI_CLASS = {
    '0': null, '39': null, '1': 'rc-bold', '2': 'rc-fg-muted', '90': 'rc-fg-muted',
    '31': 'rc-fg-danger', '91': 'rc-fg-danger', '32': 'rc-fg-ok', '92': 'rc-fg-ok',
    '33': 'rc-fg-warn', '93': 'rc-fg-warn', '34': 'rc-fg-info', '94': 'rc-fg-info',
    '36': 'rc-fg-info', '96': 'rc-fg-info'
  };
  function ansiToHtml(text, fallbackClass) {
    var out = '', open = 0, cls = fallbackClass || '';
    var parts = String(text == null ? '' : text).split(/\x1b\[([0-9;]*)m/);
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var codes = parts[i].split(';');
        for (var c = 0; c < codes.length; c++) {
          var code = codes[c] || '0';
          if (!Object.prototype.hasOwnProperty.call(ANSI_CLASS, code)) continue;
          while (open > 0) { out += '</span>'; open--; }
          cls = ANSI_CLASS[code] ? ANSI_CLASS[code] : (fallbackClass || '');
        }
        continue;
      }
      // Other CSI sequences (cursor moves, clears) carry no meaning in a log pane.
      var chunk = parts[i].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
      if (!chunk) continue;
      if (cls) { out += '<span class="' + cls + '">' + esc(chunk) + '</span>'; }
      else out += esc(chunk);
    }
    while (open > 0) { out += '</span>'; open--; }
    return out;
  }

  function rcStepper(run) {
    var status = run ? run.status : null;
    var stage = RC_STAGE[status] != null ? RC_STAGE[status] : rc.stage;
    var settled = !!status && !RUN_ACTIVE[status];
    var failed = status === 'failed' || status === 'aborted';
    if (RC_STAGE[status] != null) rc.stage = stage;
    return RC_STEPS.map(function (label, i) {
      var cls = 'rc-step';
      // Never dispatched (e.g. opened from a proposal banner): no phase is active.
      if (!status) return '<li class="' + cls + '">' + esc(label) + '</li>';
      if (status === 'completed') cls += ' is-done';
      else if (settled && failed) cls += i < stage ? ' is-done' : (i === stage ? ' is-failed' : '');
      else if (i < stage) cls += ' is-done';
      else if (i === stage) cls += ' is-active';
      return '<li class="' + cls + '">' + esc(label) + '</li>';
    }).join('<li class="rc-sep" aria-hidden="true">&#8250;</li>');
  }

  function syncConsole() {
    var run = rc.taskId ? runFor(rc.taskId) : null;
    var task = rc.taskId ? taskById(rc.taskId) : null;
    $('rc-task').textContent = rc.taskId || '–';
    $('rc-title').textContent = task ? task.title : '';
    $('rc-steps').innerHTML = rcStepper(run);
    $('rc-abort').disabled = !isRunActive(run);
    $('rc-elapsed').textContent = clock(elapsedOf(run) || 0);
    $('rc-bytes').textContent = formatBytes((run && run.logBytes) || 0);
    var gate = 'Idle';
    if (run && run.verification) gate = run.verification.success ? 'Passed' : 'Failed';
    else if (run && run.status === 'verifying') gate = 'Running';
    $('rc-gate').textContent = gate;
    // Native runs report grounded usage; cli runs have none to show.
    var usage = run && run.usage;
    $('rc-spend-wrap').hidden = !usage;
    $('rc-cache-wrap').hidden = !usage;
    if (usage) {
      $('rc-spend').textContent = usdSpend(usage.costUsd);
      $('rc-cache').textContent = Math.round((Number(usage.cacheHitRate) || 0) * 100) + '%';
    }
    var exit = '';
    if (run && !isRunActive(run)) {
      exit = RUN_LABEL[run.status] || run.status;
      if (typeof run.exitCode === 'number') exit += ' (exit ' + run.exitCode + ')';
      if (run.error) exit += ' · ' + run.error;
    }
    $('rc-exit').textContent = exit;
  }

  function rcTick() {
    clearInterval(rc.ticker);
    rc.ticker = setInterval(function () {
      var run = rc.taskId ? runFor(rc.taskId) : null;
      if (!rc.taskId || !isRunActive(run)) { clearInterval(rc.ticker); rc.ticker = null; return; }
      $('rc-elapsed').textContent = clock(elapsedOf(run) || 0);
      repaint('tasks');
    }, 1000);
  }

  function appendConsole(html) {
    var body = $('rc-body');
    var stick = rc.autoscroll || body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    var frag = document.createElement('span');
    frag.innerHTML = html;
    body.appendChild(frag);
    while (body.childElementCount > RC_MAX_NODES) body.removeChild(body.firstChild);
    if (stick) body.scrollTop = body.scrollHeight;
  }

  function loadConsoleLogs(taskId) {
    return api('/api/pipeline/tasks/logs?taskId=' + encodeURIComponent(taskId) + '&tailLines=500').then(function (body) {
      if (rc.taskId !== taskId) return;
      $('rc-body').innerHTML = body.log ? ansiToHtml(body.log) : '<span class="rc-empty">No output captured yet.</span>';
      $('rc-body').scrollTop = $('rc-body').scrollHeight;
      rc.backfilled = true;
      syncConsole();
    }, function () {
      if (rc.taskId !== taskId) return;
      $('rc-body').innerHTML = '<span class="rc-empty">Waiting for the runner to emit output…</span>';
      rc.backfilled = true;
    });
  }

  // ─── Console tab 2: worktree git diff (GET /api/pipeline/worktrees/diff) ───
  function diffToHtml(diff) {
    return String(diff).split('\n').map(function (line) {
      var cls = '';
      if (/^(diff --git|\+\+\+ |--- )/.test(line)) cls = /^diff --git/.test(line) ? 'df-file' : 'df-meta';
      else if (/^@@/.test(line)) cls = 'df-hunk';
      else if (/^\+/.test(line)) cls = 'df-add';
      else if (/^-/.test(line)) cls = 'df-del';
      else if (/^(index |new file mode|deleted file mode|similarity |rename |Binary files)/.test(line)) cls = 'df-meta';
      return cls ? '<span class="' + cls + '">' + esc(line) + '</span>' : esc(line) + '\n';
    }).join('');
  }

  function setDiffState(summary, files, bodyHtml, count) {
    $('rc-diff-summary').innerHTML = summary;
    $('rc-diff-files').innerHTML = (files || []).map(function (f) { return '<li title="' + esc(f) + '">' + esc(f) + '</li>'; }).join('');
    $('rc-diff-files').hidden = !(files && files.length);
    $('rc-diff-body').innerHTML = bodyHtml;
    $('rc-diff-count').textContent = count == null ? '–' : String(count);
  }

  function loadConsoleDiff(taskId) {
    var seq = ++rc.diffSeq;
    $('rc-diff-refresh').disabled = true;
    if (!$('rc-diff-body').textContent) setDiffState('Loading worktree changes…', [], '<span class="rc-empty">Reading git status…</span>', null);
    return api('/api/pipeline/worktrees/diff?taskId=' + encodeURIComponent(taskId)).then(function (body) {
      if (seq !== rc.diffSeq || rc.taskId !== taskId) return;
      var files = Array.isArray(body.filesChanged) ? body.filesChanged : [];
      var summary = '<code>' + esc(body.branch || '') + '</code> · ' + (body.hasChanges ? files.length + ' uncommitted file' + (files.length === 1 ? '' : 's') : 'working tree clean');
      setDiffState(summary, files, body.diff ? diffToHtml(body.diff) : '<span class="rc-empty">No uncommitted changes in this worktree yet.</span>', files.length);
    }, function (e) {
      if (seq !== rc.diffSeq || rc.taskId !== taskId) return;
      var missing = e.code === 'WORKTREE_NOT_FOUND';
      setDiffState(missing ? 'No isolated worktree' : 'Could not load the diff',
        [], '<span class="rc-empty">' + esc(missing ? 'This task has no agent worktree. Dispatch it with Isolated Worktree on, or run nativ worktree create ' + taskId + '.' : e.message) + '</span>', null);
    }).then(function () {
      if (seq === rc.diffSeq) $('rc-diff-refresh').disabled = false;
    });
  }

  /** Throttled refresh (at most every 2s) while an agent streams output or git state changes. */
  function queueConsoleDiff() {
    if (!rc.taskId || rc.tab !== 'diff' || rc.minimized || rc.diffTimer) return;
    var id = rc.taskId;
    rc.diffTimer = setTimeout(function () {
      rc.diffTimer = null;
      if (rc.taskId === id && rc.tab === 'diff') loadConsoleDiff(id);
    }, 2000);
  }

  function setConsoleTab(tab, focus) {
    if (tab === 'heal' && $('rc-tab-heal').hidden) tab = 'logs';
    rc.tab = tab;
    ['logs', 'diff', 'heal'].forEach(function (name) {
      var btn = $('rc-tab-' + name);
      var on = name === tab;
      btn.setAttribute('aria-selected', String(on));
      btn.setAttribute('tabindex', on ? '0' : '-1');
    });
    $('rc-body').hidden = tab !== 'logs';
    $('rc-diff').hidden = tab !== 'diff';
    $('rc-heal').hidden = tab !== 'heal';
    $('rc-autoscroll').hidden = tab !== 'logs';
    $('rc-clear').hidden = tab !== 'logs';
    if (tab === 'diff' && rc.taskId) loadConsoleDiff(rc.taskId);
    if (tab === 'heal') renderHeal();
    if (focus) $('rc-tab-' + tab).focus();
  }

  /** Console tabs in DOM order, skipping the proposal tab while it is hidden. */
  function visibleConsoleTabs() {
    return ['logs', 'diff', 'heal'].filter(function (name) { return !$('rc-tab-' + name).hidden; });
  }

  // ─── Console tab 3: self-healing proposal review (/api/pipeline/escalations) ─
  /** Shows the tab only while the console's task has a pending escalation; keeps the panel in sync. */
  function syncHealTab() {
    var escalation = rc.taskId ? escalationFor(rc.taskId) : null;
    // Keep the tab while a just-finished resolution is still on screen.
    var show = !!escalation || !!(rc.heal && rc.heal.result && rc.heal.taskId === rc.taskId);
    $('rc-tab-heal').hidden = !show;
    $('rc-heal-count').hidden = !(escalation && escalation.proposedPatch);
    if (!show && rc.tab === 'heal') setConsoleTab('logs');
    else if (rc.tab === 'heal') renderHeal();
  }

  function patchLine(sign, p) {
    if (!p) return '';
    var value = p.value === undefined ? '' : ' ' + JSON.stringify(p.value);
    return '<span class="' + (sign === '-' ? 'df-del' : 'df-add') + '">' + sign + ' ' + esc(p.operation + ' ' + p.path + value) + '</span>';
  }

  function healBody(escalation) {
    var p = escalation.proposedPatch;
    var diag = '<p class="heal-diag"><strong>' + esc(escalation.summary || 'Escalated') + '</strong>' +
      (escalation.details ? '<br>' + esc(escalation.details) : '') + '</p>';
    if (!p) {
      return '<div class="heal-head"><h3>No automatic fix could be proven</h3><span class="heal-tag">' + esc(escalation.id) + '</span></div>' + diag +
        '<p class="heal-diag">' + esc(escalation.recommendedAction || 'Review the affected contracts, then unblock the task or dismiss the escalation.') + '</p>' +
        '<div class="heal-actions"><button class="rc-btn reject" type="button" data-heal="reject">Dismiss</button>' +
        '<button class="rc-btn approve" type="button" data-heal="approve">Approve &amp; Unblock Task</button></div>';
    }
    var proof = p.verificationProof || {};
    var verdict = proof.passed
      ? '<span class="heal-verdict pass">' + ICON.check + 'PASSED in sandbox</span>'
      : '<span class="heal-verdict fail">' + ICON.x + 'NOT VERIFIED</span>';
    var patch = p.kind === 'restore_tests'
      ? (p.files || []).map(function (f) { return '<span class="df-add">+ restore ' + esc(f) + '</span>'; }).join('') +
        (p.commands || []).map(function (c) { return '<span class="df-meta">$ ' + esc(c) + '</span>'; }).join('')
      : patchLine('-', p.original) + patchLine('+', p.candidate);
    var checks = (proof.checks || []).map(function (c) {
      return '<li><span class="' + (c.passed ? 'ok' : 'bad') + '">' + (c.passed ? ICON.check : ICON.x) + '</span><span><b>' + esc(c.name) + '</b> ' + esc(c.detail) + '</span></li>';
    }).join('');
    return '<div class="heal-head"><h3>' + esc(humanize(p.strategy || 'proposal')) + '</h3><span class="heal-tag">' + esc(p.proposalId || escalation.id) + '</span>' + verdict + '</div>' +
      diag + '<p class="heal-diag">' + esc(p.rationale || '') + '</p>' +
      '<div class="heal-grid">' +
        '<section class="heal-section"><h4>' + (p.kind === 'restore_tests' ? 'Restoration plan' : 'Rejected change &#8594; proposed change') + '</h4><pre class="heal-patch">' + patch + '</pre></section>' +
        '<section class="heal-section"><h4>Isolated verification</h4><ul class="heal-checks">' + (checks || '<li>No checks recorded.</li>') + '</ul></section>' +
      '</div>' +
      '<div class="heal-actions"><button class="rc-btn reject" type="button" data-heal="reject">Reject Proposal</button>' +
      '<button class="rc-btn approve" type="button" data-heal="approve"' + (proof.passed ? '' : ' disabled title="Only sandbox-verified proposals can be applied"') + '>Approve &amp; Apply Patch</button></div>';
  }

  function renderHeal() {
    var panel = $('rc-heal');
    var heal = rc.heal && rc.heal.taskId === rc.taskId ? rc.heal : null;
    var result = heal && heal.result ? '<p class="heal-result' + (heal.result.ok ? '' : ' is-error') + '" role="status">' + esc(heal.result.message) + '</p>' : '';
    if (!pipe.loaded.escalations) { panel.innerHTML = '<div class="heal-skel"></div><div class="heal-skel"></div><div class="heal-skel" style="width:60%"></div>'; return; }
    if (pipe.errors.escalations && !pipe.escalations.length) {
      panel.innerHTML = '<p class="heal-result is-error">Could not load escalations: ' + esc(pipe.errors.escalations) + '</p>' +
        '<div class="heal-actions"><button class="rc-btn" type="button" data-heal="retry">Retry</button></div>';
      return;
    }
    var escalation = escalationFor(rc.taskId);
    if (!escalation) {
      panel.innerHTML = result || '<p class="heal-diag">No pending proposal for this task. When the circuit breaker trips on a third failed attempt, a sandbox-verified fix appears here for review.</p>';
      return;
    }
    panel.innerHTML = result + healBody(escalation);
    if (heal && heal.busy) panel.querySelectorAll('[data-heal]').forEach(function (b) { b.disabled = true; });
  }

  /** One click resolves: approve applies the proposal and unblocks the task, reject dismisses it. */
  function resolveEscalation(decision) {
    var escalation = rc.taskId ? escalationFor(rc.taskId) : null;
    if (!escalation || (rc.heal && rc.heal.busy)) return;
    var taskId = rc.taskId;
    rc.heal = { taskId: taskId, busy: true, result: null };
    renderHeal();
    var btn = $('rc-heal').querySelector('[data-heal="' + decision + '"]');
    if (btn) btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + (decision === 'approve' ? 'Applying…' : 'Rejecting…');
    postJson('/api/pipeline/escalations/resolve', { escalationId: escalation.id, decision: decision }).then(function (body) {
      rc.heal = { taskId: taskId, busy: false, result: { ok: true, message: body.message || 'Escalation resolved.' } };
      toast(body.message || 'Escalation resolved', 'ok');
    }, function (e) {
      rc.heal = { taskId: taskId, busy: false, result: { ok: false, message: e.message } };
      toast('Could not ' + decision + ' ' + escalation.id + ': ' + e.message);
    }).then(function () {
      renderHeal();
      return fetchPipeline(['escalations', 'status', 'tasks', 'telemetry']);
    });
  }

  /** Per-turn usage from the native engine: fold the running total into the run record. */
  function onRunnerUsage(event) {
    if (!event || !event.taskId || !event.total) return;
    var run = runFor(event.taskId);
    if (run && (!event.runId || run.runId === event.runId)) run.usage = event.total;
    if (rc.taskId === event.taskId) syncConsole();
  }

  function openConsole(taskId, quiet, tab) {
    var drawer = $('runner-console-drawer');
    if (rc.taskId !== taskId) {
      rc.taskId = taskId;
      rc.backfilled = false;
      rc.stage = 0;
      rc.diffSeq++;
      rc.heal = null;
      setDiffState('Uncommitted changes in the task worktree', [], '', null);
      // The run list includes restored history, so no run means no log to fetch (the server would 400).
      if (runFor(taskId)) {
        $('rc-body').innerHTML = '<span class="rc-empty">Loading runner output…</span>';
        loadConsoleLogs(taskId);
      } else {
        $('rc-body').innerHTML = '<span class="rc-empty">No runner has been dispatched for this task yet.</span>';
        rc.backfilled = true;
      }
    }
    rc.minimized = false;
    drawer.hidden = false;
    drawer.classList.remove('is-min');
    $('rc-minimize').textContent = 'Minimize';
    $('rc-minimize').setAttribute('aria-expanded', 'true');
    document.body.classList.add('has-console');
    document.body.classList.remove('has-console-min');
    syncConsole();
    syncHealTab();
    rcTick();
    setConsoleTab(tab || rc.tab);
    if (!quiet) (rc.tab === 'diff' ? $('rc-diff-body') : rc.tab === 'heal' ? $('rc-heal') : $('rc-body')).focus();
  }

  function closeConsole() {
    rc.taskId = null;
    clearInterval(rc.ticker);
    rc.ticker = null;
    clearTimeout(rc.diffTimer);
    rc.diffTimer = null;
    $('runner-console-drawer').hidden = true;
    document.body.classList.remove('has-console', 'has-console-min');
  }

  function toggleConsoleMinimized() {
    rc.minimized = !rc.minimized;
    var drawer = $('runner-console-drawer');
    drawer.classList.toggle('is-min', rc.minimized);
    document.body.classList.toggle('has-console', !rc.minimized);
    document.body.classList.toggle('has-console-min', rc.minimized);
    var btn = $('rc-minimize');
    btn.textContent = rc.minimized ? 'Expand' : 'Minimize';
    btn.setAttribute('aria-expanded', String(!rc.minimized));
    if (!rc.minimized && rc.tab === 'diff' && rc.taskId) loadConsoleDiff(rc.taskId);
  }

  function onRunnerStatus(run) {
    if (!run || !run.taskId) return;
    upsertRun(run);
    if (rc.taskId === run.taskId) {
      syncConsole();
      if (isRunActive(run)) rcTick();
      queueConsoleDiff();
    }
    repaint('tasks');
    if (!RUN_ACTIVE[run.status]) {
      var statusMsg = (RUN_LABEL[run.status] || run.status) + ': ' + run.taskId;
      if (run.error && run.status !== 'completed') {
        statusMsg += ' (' + run.error + ')';
      }
      toast(statusMsg, run.status === 'completed' ? 'ok' : 'err');
      // The agent may have moved the task through "nativ task complete" while it ran.
      queueRefresh(['status', 'tasks', 'worktrees', 'runs']);
    }
  }

  function onRunnerLog(entry) {
    if (!entry || !entry.taskId) return;
    var run = runFor(entry.taskId);
    if (run) run.logBytes = (run.logBytes || 0) + (entry.chunk ? entry.chunk.length : 0);
    if (rc.taskId !== entry.taskId || !rc.backfilled) return;
    var empty = $('rc-body').querySelector('.rc-empty');
    if (empty) $('rc-body').innerHTML = '';
    appendConsole(ansiToHtml(entry.chunk, entry.stream === 'stderr' ? 'rc-fg-warn' : ''));
    $('rc-bytes').textContent = formatBytes((run && run.logBytes) || 0);
    queueConsoleDiff();
  }

  var pendingBlock = null;
  function openBlockDialog(taskId) {
    pendingBlock = taskId;
    $('block-task-id').textContent = taskId;
    $('block-reason').value = '';
    $('block-error').textContent = '';
    openDialog($('block-dialog'));
    $('block-reason').focus();
  }

  // ─── View 3: Agent worktrees ───────────────────────────────────────────────
  function shortPath(p) {
    var parts = String(p || '').split(/[\\/]+/).filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : String(p || '');
  }

  function worktreeTaskStatus(w) {
    if (w.taskStatus) return w.taskStatus;
    var task = w.taskId ? taskById(w.taskId) : null;
    return task ? task.status : null;
  }

  function worktreeBadge(w, status) {
    if (!w.isAgentWorktree) return '<span class="badge badge-neutral">Main workspace</span>';
    if (status === 'completed') return '<span class="badge badge-success">Tests Passed (Ready to merge)</span>';
    if (status === 'in_progress') return '<span class="badge badge-active">Agent working</span>';
    if (status === 'blocked') return '<span class="badge badge-danger">Blocked</span>';
    if (status === 'pending') return '<span class="badge badge-neutral">Pending</span>';
    return '<span class="badge badge-neutral" title="No matching task in the master plan">Untracked</span>';
  }

  function worktreeRow(w) {
    var status = worktreeTaskStatus(w);
    var task = w.taskId ? taskById(w.taskId) : null;
    // The server decides merge eligibility (and why not); fall back to the task status from the plan.
    var canMerge = w.mergeEligible != null ? !!w.mergeEligible : status === 'completed';
    var blockedWhy = w.mergeBlockedReason || 'Available once the task is completed';
    var busy = w.taskId && pipe.busy['wt:' + w.taskId];
    var actions = '<span class="muted">–</span>';
    if (w.isAgentWorktree && w.taskId) {
      actions = busy
        ? '<button class="btn small" type="button" disabled><span class="spinner" aria-hidden="true"></span>' + (busy === 'merge' ? 'Merging…' : 'Deleting…') + '</button>'
        : '<button class="btn small" type="button" data-action="wt-diff" data-key="' + esc(w.taskId) + '" aria-label="' + esc('Inspect diff for ' + w.taskId) + '">Inspect Diff</button>' +
          '<button class="btn small primary" type="button" data-action="wt-merge" data-key="' + esc(w.taskId) + '"' + (canMerge ? '' : ' disabled title="' + esc(blockedWhy) + '"') + '>Merge to Main</button>' +
          '<button class="btn small danger" type="button" data-action="wt-remove" data-key="' + esc(w.taskId) + '">Delete Workspace</button>';
    }
    return '<tr><td data-label="Branch"><code>' + esc(w.branch) + '</code></td>' +
      '<td data-label="Task ID">' + (w.taskId ? '<div><code>' + esc(w.taskId) + '</code>' + (task ? '<div class="cell-sub" title="' + esc(task.title) + '">' + esc(task.title) + '</div>' : '') + '</div>' : '<span class="muted">–</span>') + '</td>' +
      '<td data-label="Workspace Folder"><code class="path" title="' + esc(w.path) + '">' + esc(shortPath(w.path)) + '</code></td>' +
      '<td data-label="Latest Commit"><code>' + esc(String(w.head || '').slice(0, 7) || '–') + '</code></td>' +
      '<td data-label="Status">' + worktreeBadge(w, status) + '</td>' +
      '<td data-label="Actions"><div class="row-actions">' + actions + '</div></td></tr>';
  }

  function renderWorktrees() {
    var head = panelHead('Agent Worktrees', 'Isolated git workspaces for tasks. Changes are tested automatically before merging into your main branch.');
    if (!pipe.loaded.worktrees) return head + '<div class="card section" aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div></div>';
    if (pipe.errors.worktrees && !pipe.worktrees.length) return head + errorCard('worktrees', pipe.errors.worktrees, 'worktrees');
    var rows = pipe.worktrees.slice().sort(function (a, b) { return (a.isAgentWorktree ? 1 : 0) - (b.isAgentWorktree ? 1 : 0); });
    if (!rows.some(function (w) { return w.isAgentWorktree; })) {
      return head + staleNote('worktrees') + '<div class="card state"><div class="state-icon">' + ICON.branch + '</div><h2>No agent worktrees</h2>' +
        '<p>Run <code>nativ worktree create &lt;taskId&gt;</code> to give an agent its own isolated workspace folder for an independent task.</p></div>';
    }
    return head + staleNote('worktrees') + '<div class="card wt-card"><table class="grid"><thead><tr>' +
      '<th scope="col">Branch Name</th><th scope="col">Task ID</th><th scope="col">Workspace Folder</th><th scope="col">Latest Commit</th><th scope="col">Status</th><th scope="col">Actions</th>' +
      '</tr></thead><tbody>' + rows.map(worktreeRow).join('') + '</tbody></table></div>';
  }

  var pendingConfirm = null;
  function confirmDialog(opts, onConfirm) {
    $('confirm-title').textContent = opts.title;
    $('confirm-body').textContent = opts.body;
    var ok = $('btn-confirm-ok');
    ok.textContent = opts.confirmLabel;
    ok.className = 'btn ' + (opts.danger ? 'danger-solid' : 'primary');
    pendingConfirm = onConfirm;
    openDialog($('confirm-dialog'));
  }

  function confirmWorktree(action, taskId) {
    var w = null;
    pipe.worktrees.some(function (x) { if (x.taskId === taskId) { w = x; return true; } return false; });
    var branch = w ? w.branch : 'agent/task-' + taskId;
    if (action === 'merge') {
      confirmDialog({
        title: 'Merge to Main',
        body: 'Merge ' + branch + ' into the main workspace? Automated tests will run first and reject the merge if tests fail.',
        confirmLabel: 'Merge to Main'
      }, function () { runWorktreeAction('merge', taskId); });
    } else {
      confirmDialog({
        title: 'Delete workspace',
        body: 'Remove the workspace folder for ' + taskId + ' and delete branch ' + branch + '? Uncommitted work will be removed.',
        confirmLabel: 'Delete Workspace',
        danger: true
      }, function () { runWorktreeAction('remove', taskId); });
    }
  }

  function runWorktreeAction(action, taskId) {
    var key = 'wt:' + taskId;
    if (pipe.busy[key]) return;
    pipe.busy[key] = action;
    repaint('worktrees');
    postJson('/api/pipeline/worktrees/action', { action: action, taskId: taskId }).then(function (r) {
      toast(r.message || (action === 'merge' ? 'Merged workspace for ' : 'Deleted workspace for ') + taskId, 'ok');
    }, function (e) {
      toast((action === 'merge' ? 'Merge rejected for ' : 'Could not delete workspace for ') + taskId + ': ' + e.message);
    }).then(function () {
      delete pipe.busy[key];
      return fetchPipeline(['worktrees', 'tasks', 'status']);
    });
  }

  // ─── View 4: Synthetic benchmarks ──────────────────────────────────────────
  var SCENARIOS = [
    { id: 'concurrency', label: 'Multi-Agent Concurrency' },
    { id: 'telemetry', label: 'Telemetry Engine' },
    { id: 'governor', label: 'Governor Invariants' },
    { id: 'verification', label: 'Gatekeeper' },
    { id: 'e2e_pipeline', label: 'E2E Lifecycle' }
  ];

  function renderBenchmarks() {
    var running = !!pipe.busy.bench;
    var runBtn = '<button class="btn primary" type="button" data-action="bench-run"' + (running ? ' disabled' : '') + '>' +
      (running ? '<span class="spinner" aria-hidden="true"></span>Running…' : ICON.play + 'Run Benchmark') + '</button>';
    var head = panelHead('Synthetic Benchmarks', 'Sandboxed stress runs of plan locking, telemetry, the contract governor, the verification gatekeeper and the full agent lifecycle.', runBtn);
    if (!pipe.loaded.benchmarks) return head + '<div class="card section" aria-hidden="true"><div class="skeleton tall"></div></div><div class="scenario-grid" aria-hidden="true">' + skeletonCards(5, 'scenario') + '</div>';
    if (pipe.errors.benchmarks && !pipe.report) return head + errorCard('benchmark report', pipe.errors.benchmarks, 'benchmarks');
    var r = pipe.report;
    if (!r) {
      return head + '<div class="card state" aria-busy="' + running + '"><div class="state-icon">' + (running ? '<span class="spinner" aria-hidden="true"></span>' : ICON.gauge) + '</div>' +
        '<h2>' + (running ? 'Running benchmark matrix…' : 'No benchmark report yet') + '</h2>' +
        '<p>' + (running ? 'Scenarios run in throwaway sandboxes; this usually takes a few seconds.' : 'Run the synthetic matrix to measure throughput and score all five pipeline scenarios. Results are cached in .ai/benchmark_report.json.') + '</p></div>';
    }
    return head + staleNote('benchmarks') + benchHero(r, running) + '<div class="scenario-grid">' + scenarioCards(r) + '</div>';
  }

  function benchHero(r, running) {
    var s = r.summary || {};
    var env = r.environment || {};
    var meta = [];
    if (r.timestamp) meta.push('Ran ' + esc(fmtDate(r.timestamp)));
    if (env.platform) meta.push(esc(env.platform + (env.arch ? ' ' + env.arch : '')));
    if (env.nodeVersion) meta.push('Node ' + esc(env.nodeVersion));
    if (env.cpuCount) meta.push(env.cpuCount + ' CPUs');
    var score = clampPct(s.score);
    return '<section class="card hero' + (running ? ' is-running' : '') + '" aria-labelledby="hero-h" aria-busy="' + running + '">' +
      '<div><h2 class="eyebrow" id="hero-h">Average throughput</h2>' +
      '<div class="hero-value">' + num(Math.round(s.averageThroughputOpsPerSec || 0)) + '<span class="badge badge-accent">ops/sec</span></div>' +
      '<p class="hero-meta">' + meta.join(' · ') + '</p></div>' +
      '<dl class="hero-stats">' +
        '<div><dt>Score</dt><dd class="' + (score < 100 ? 'text-danger' : '') + '">' + score + '%</dd></div>' +
        '<div><dt>Scenarios passed</dt><dd>' + num(s.passedScenarios) + '/' + num(s.totalScenarios) + '</dd></div>' +
        '<div><dt>Total duration</dt><dd>' + fmtMs(s.totalDurationMs) + '</dd></div>' +
        '<div><dt>Operations</dt><dd>' + num(s.totalOperations) + '</dd></div>' +
      '</dl></section>';
  }

  function scenarioCards(r) {
    var byId = {}, known = {};
    (r.scenarios || []).forEach(function (s) { byId[s.id] = s; });
    var cards = SCENARIOS.map(function (meta) { known[meta.id] = true; return scenarioCard(meta.label, byId[meta.id]); });
    (r.scenarios || []).forEach(function (s) { if (!known[s.id]) cards.push(scenarioCard(s.name || s.id, s)); });
    return cards.join('');
  }

  function scenarioCard(label, s) {
    if (!s) {
      return '<article class="card scenario is-idle"><header class="scenario-head"><h3>' + esc(label) + '</h3><span class="badge badge-neutral">Not run</span></header>' +
        '<p class="muted">Not part of the last run. Run the full matrix to score it.</p></article>';
    }
    var total = (s.assertionsPassed || 0) + (s.assertionsFailed || 0);
    var passed = s.status === 'passed';
    var score = total ? Math.round((s.assertionsPassed || 0) / total * 100) : (passed ? 100 : 0);
    var details = Object.keys(s.details || {}).slice(0, 4).map(function (k) {
      var v = s.details[k];
      // Lists (e.g. invariant names) get a full-width row of chips instead of a cramped value column.
      if (Array.isArray(v)) {
        return '<dt class="wide">' + esc(humanize(k)) + '</dt><dd class="wide">' + v.map(function (item) { return '<span class="chip">' + esc(detailValue(item)) + '</span>'; }).join('') + '</dd>';
      }
      return '<dt>' + esc(humanize(k)) + '</dt><dd>' + esc(detailValue(v)) + '</dd>';
    }).join('');
    var errors = (s.errors || []).length ? '<ul class="scenario-errors">' + s.errors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '';
    return '<article class="card scenario"><header class="scenario-head"><h3>' + esc(label) + '</h3>' +
      '<span class="badge badge-' + (passed ? 'success' : 'danger') + '">' + (passed ? 'Passed' : 'Failed') + '</span></header>' +
      (s.name && s.name !== label ? '<p class="scenario-sub">' + esc(s.name) + '</p>' : '') +
      '<div class="metrics"><div><span class="metric-v">' + score + '%</span><span class="metric-l">Score</span></div>' +
      '<div><span class="metric-v">' + fmtMs(s.durationMs) + '</span><span class="metric-l">Latency</span></div>' +
      '<div><span class="metric-v">' + num(Math.round(s.throughputOpsPerSec || 0)) + '</span><span class="metric-l">ops/sec</span></div></div>' +
      progressBar(score, 'sc-' + s.id, label + ' score', passed ? 'success' : 'danger') +
      (details ? '<dl class="details">' + details + '</dl>' : '') + errors + '</article>';
  }

  function runBenchmark() {
    if (pipe.busy.bench) return;
    pipe.busy.bench = true;
    repaint('benchmarks');
    postJson('/api/pipeline/benchmarks/run', {}).then(function (r) {
      if (r.report) { pipe.report = r.report; pipe.errors.benchmarks = null; pipe.loaded.benchmarks = true; }
      var s = r.report && r.report.summary;
      toast('Benchmark finished' + (s ? ': score ' + clampPct(s.score) + '%, ' + s.passedScenarios + '/' + s.totalScenarios + ' scenarios passed' : ''), 'ok');
    }, function (e) {
      toast('Benchmark run failed: ' + e.message);
    }).then(function () {
      pipe.busy.bench = false;
      updateNavCounts();
      repaint('benchmarks');
    });
  }

  // ─── Real-time sync: EventSource on /api/events ────────────────────────────
  var live = { es: null, retry: 0, timer: null, lastBeat: 0, sawBeat: false, opened: false };
  var LIVE_TEXT = { connecting: 'Connecting', live: 'Live', offline: 'Offline' };
  // Keys are SSE event names on the wire; values are the pipeline slices each one invalidates.
  var EVENT_PARTS = {
    // .ai/escalation.json writes (circuit-breaker trips, resolutions) arrive as plan changes.
    'plan_change': ['status', 'tasks', 'worktrees', 'escalations'],
    // The server also reports .ai/benchmark_report.json writes (e.g. a CLI "nativ bench") as telemetry changes.
    'telemetry_change': ['status', 'benchmarks', 'telemetry'],
    'benchmark_change': ['benchmarks'],
    'worktree_change': ['worktrees']
  };

  function setLive(mode, detail) {
    var el = $('live');
    el.setAttribute('data-state', mode);
    $('live-label').textContent = LIVE_TEXT[mode];
    el.title = detail || (mode === 'live' ? 'Receiving real-time updates from /api/events' : '');
    var sb = $('sb-live');
    sb.setAttribute('data-state', mode);
    sb.title = el.title;
    $('sb-live-label').textContent = mode === 'live' ? 'Live Stream' : LIVE_TEXT[mode];
  }

  function flashLive() {
    var dot = $('live-dot');
    dot.classList.remove('flash');
    void dot.offsetWidth;
    dot.classList.add('flash');
  }

  // fs.watch fires several events per write; batch them into one refetch.
  var queuedParts = {}, queueTimer = null;
  function queueRefresh(parts) {
    parts.forEach(function (p) { queuedParts[p] = true; });
    clearTimeout(queueTimer);
    queueTimer = setTimeout(function () {
      var list = Object.keys(queuedParts);
      queuedParts = {};
      fetchPipeline(list);
    }, 150);
  }

  function onStreamEvent(type) {
    live.lastBeat = Date.now();
    if (type === 'heartbeat' || type === 'ping') { live.sawBeat = true; return; }
    var parts = EVENT_PARTS[type];
    if (!parts) return;
    flashLive();
    queueRefresh(parts);
    if (parts.indexOf('worktrees') !== -1) queueConsoleDiff();
  }

  function connectEvents() {
    clearTimeout(live.timer);
    if (typeof window.EventSource !== 'function') {
      setLive('offline', 'This browser has no EventSource support; refreshing every 15 seconds instead.');
      setInterval(function () { fetchPipeline(ALL_PARTS); }, 15000);
      return;
    }
    if (live.es) live.es.close();
    setLive('connecting');
    var es = new EventSource('/api/events');
    live.es = es;
    es.onopen = function () {
      live.retry = 0;
      live.lastBeat = Date.now();
      setLive('live');
      // Catch up on anything written while the stream was down.
      if (live.opened) queueRefresh(ALL_PARTS);
      live.opened = true;
    };
    es.onerror = function () {
      if (es.readyState === EventSource.CLOSED) scheduleReconnect();
      else setLive('connecting', 'Reconnecting to /api/events');
    };
    // Unnamed events may carry the type in a JSON payload: { "type": "plan_change" }.
    es.onmessage = function (e) {
      var type = 'message';
      try { type = JSON.parse(e.data).type || type; } catch (err) { /* plain-text payload */ }
      onStreamEvent(type);
    };
    Object.keys(EVENT_PARTS).concat(['heartbeat', 'ping']).forEach(function (name) {
      es.addEventListener(name, function () { onStreamEvent(name); });
    });
    // Runner events carry a payload, so they bypass the slice-invalidation table.
    es.addEventListener('runner_status', function (e) {
      live.lastBeat = Date.now();
      flashLive();
      onRunnerStatus(parseEventData(e));
    });
    es.addEventListener('runner_log', function (e) {
      live.lastBeat = Date.now();
      onRunnerLog(parseEventData(e));
    });
    // Native engine: one event per API turn with the delta and the run's running total.
    es.addEventListener('runner_token_usage', function (e) {
      live.lastBeat = Date.now();
      flashLive();
      onRunnerUsage(parseEventData(e));
    });
  }

  function parseEventData(e) {
    try { return JSON.parse(e.data); } catch (err) { return null; }
  }

  function scheduleReconnect() {
    if (live.es) { live.es.close(); live.es = null; }
    var delay = Math.min(30000, 1000 * Math.pow(2, live.retry++));
    setLive('offline', 'Live stream unavailable; retrying in ' + Math.round(delay / 1000) + 's');
    clearTimeout(live.timer);
    live.timer = setTimeout(connectEvents, delay);
  }

  // Heartbeat watchdog: armed only once the server has shown it sends heartbeats.
  setInterval(function () {
    if (live.es && live.sawBeat && Date.now() - live.lastBeat > 45000) scheduleReconnect();
  }, 15000);

  // ─── View 5: Database Studio — data loading ────────────────────────────────
  function load(fresh) {
    state.loading = true;
    renderDb();
    var q = fresh ? '?refresh=1' : '';
    var diffPath = '/api/diff?target=' + state.diffTarget + (fresh ? '&refresh=1' : '');
    return Promise.all([
      api('/api/status' + q).catch(function (e) { toast(e.message); return null; }),
      api('/api/schema' + q).catch(function (e) { toast(e.message); return { devTables: [], prodTables: [] }; }),
      api(diffPath).then(function (d) { state.diffError = null; return d; }, function (e) { state.diffError = e.message; return null; }),
      api('/api/env-info').catch(function () { return null; })
    ]).then(function (results) {
      state.status = results[0];
      state.schema = results[1];
      state.diff = results[2];
      state.envInfo = results[3];
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
      renderDb();
    });
  }

  // ─── Database Studio: shell ────────────────────────────────────────────────
  /** DB_HOST -> DB_*, PROD_DB_HOST -> PROD_DB_*, PGHOST -> PG*. */
  function keyFamily(key) {
    var m = /^(.*_)[^_]*$/.exec(key);
    return m ? m[1] + '*' : key.slice(0, 2) + '*';
  }

  /** Local-stack hint when fragmented DB_* keys resolve to a server that refuses connections. */
  function fragmentedDiagnostic(s) {
    var cfg = state.envInfo && state.envInfo.fragmentedConfig;
    if (!s || s.connected || !s.synthesized || !cfg) return '';
    if (!/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(s.error || '')) return '';
    var keys = cfg.sourceKeys.filter(function (k) { return /HOST|DATABASE|_DB$|DB_NAME$/.test(k); });
    var label = ENGINE_LABEL[cfg.engine] || cfg.engine;
    var action = cfg.engine === 'mysql'
      ? 'Ensure MySQL is started in XAMPP Control Panel.'
      : 'Ensure the PostgreSQL service is running on ' + cfg.host + ':' + cfg.port + '.';
    return 'Detected fragmented ' + label + ' config (' + (keys.length ? keys : cfg.sourceKeys).join(', ') + '). ' + action;
  }

  function statusPill(env, s) {
    var label = env.toUpperCase();
    if (!s) return '<span class="pill"><span class="dot"></span><b>' + label + ':</b> loading…</span>';
    if (!s.connected) {
      var why = /No (Dev|Prod) database configured/.test(s.error || '') ? 'not configured' : 'offline';
      return '<span class="pill" title="' + esc(s.error || '') + '"><span class="dot off"></span><b>' + label + ':</b> ' + why +
        ' <span class="badge badge-offline">OFFLINE</span></span>';
    }
    var sourceBadge = s.synthesized && s.sourceKey
      ? ' <span class="badge badge-synth" title="Assembled in memory from fragmented .env keys">synthesized from ' + esc(keyFamily(s.sourceKey)) + '</span>'
      : s.detectedFromExample && s.sourceKey
        ? ' <span class="badge badge-source" title="Detected in ' + esc(s.exampleFile || '.env.example') + '">via ' + esc(s.sourceKey) + '</span>'
        : (s.sourceKey ? ' <span class="badge badge-source">via ' + esc(s.sourceKey) + '</span>' : '');
    return '<span class="pill" title="' + esc(s.maskedUrl) + '"><span class="dot on"></span><b>' + label + ':</b> ' +
      esc(ENGINE_LABEL[s.engine] || s.engine) + (s.database ? ' · ' + esc(s.database) : '') + ' (' + Math.round(s.pingMs) + 'ms) – ' +
      entityCount(s) + ' ' + entityNoun(s, true) + sourceBadge + ' <span class="badge badge-online">ONLINE</span></span>';
  }

  function renderDbShell() {
    var st = state.status || {};
    $('telemetry').innerHTML = statusPill('dev', st.dev) + statusPill('prod', st.prod);

    var bannerEl = $('diagnostic-banner');
    if (bannerEl) {
      var devS = st.dev;
      var prodS = st.prod;
      var activeS = state.envMode === 'prod' ? prodS : devS;
      var suggestion = fragmentedDiagnostic(activeS) || fragmentedDiagnostic(devS) ||
        (activeS && !activeS.connected && activeS.suggestion) ||
        (devS && !devS.connected && devS.suggestion) ||
        (prodS && !prodS.connected && prodS.suggestion);

      if (!suggestion && state.envInfo && state.envInfo.missingKeys && state.envInfo.missingKeys.length > 0) {
        var missingForActive = state.envInfo.missingKeys.find(function (k) {
          return k.targetEnv === (state.envMode === 'prod' ? 'prod' : 'dev');
        }) || state.envInfo.missingKeys[0];
        if (missingForActive && ((missingForActive.targetEnv === 'dev' && (!devS || !devS.connected)) || (missingForActive.targetEnv === 'prod' && (!prodS || !prodS.connected)))) {
          var engLabel = missingForActive.engine ? ' (' + (ENGINE_LABEL[missingForActive.engine] || missingForActive.engine) + ')' : '';
          suggestion = 'Detected "' + missingForActive.key + '"' + engLabel + ' in ' + (state.envInfo.templateFile || '.env.example') + ', but it is not set in your .env file.';
        }
      }

      if (suggestion && ((!devS || !devS.connected) || (!prodS || !prodS.connected))) {
        bannerEl.innerHTML = '<div class="diagnostic-banner">' +
          '<div class="diagnostic-content">' +
            '<span class="diagnostic-tag">[DIAGNOSTIC]</span> ' +
            '<span class="diagnostic-msg">' + esc(suggestion) + '</span>' +
          '</div>' +
          '<div class="diagnostic-actions">' +
            '<button class="btn small" type="button" id="btn-diag-settings">Open Connection Settings</button>' +
          '</div>' +
        '</div>';
        bannerEl.hidden = false;
        var btnDiag = $('btn-diag-settings');
        if (btnDiag) {
          btnDiag.onclick = function () { openSettings(); };
        }
      } else {
        bannerEl.innerHTML = '';
        bannerEl.hidden = true;
      }
    }

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
    document.querySelectorAll('.subtab').forEach(function (t) {
      var active = t.getAttribute('data-tab') === state.tab;
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.setAttribute('tabindex', active ? '0' : '-1');
    });
    document.querySelectorAll('.env-seg-btn').forEach(function (btn) {
      var m = btn.getAttribute('data-env-mode');
      btn.setAttribute('aria-pressed', String(m === state.envMode));
    });
    $('view').setAttribute('aria-labelledby', 'tab-' + state.tab);
    updateNavCounts();
  }

  function renderDb() {
    renderDbShell();
    mediaRegistry = [];
    hideThumb();
    var view = $('view');
    if (state.loading) { view.innerHTML = dbSkeleton(); return; }
    if (state.tab === 'explorer') view.innerHTML = renderExplorer();
    else if (state.tab === 'data') view.innerHTML = renderData();
    else if (state.tab === 'drift') view.innerHTML = renderDrift();
    else view.innerHTML = renderSql();
  }

  function dbSkeleton() {
    var col = '<div class="pane card">' + '<div class="skeleton short"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    return '<div class="sr-only">Loading database schema…</div><div class="panes" aria-busy="true">' + col + col + '</div>';
  }

  var DB_ICON = '<svg class="icon empty-icon" width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>';

  function emptyState(title, text) {
    return '<div class="empty card">' + DB_ICON + '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      '<button class="btn primary" type="button" data-action="open-settings">Connection Settings</button></div>';
  }

  // ─── Database Studio: explorer ─────────────────────────────────────────────
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

  // ─── Database Studio: media preview ────────────────────────────────────────
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
    openDialog($('media-dialog'));
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
    return '<section class="pane card" aria-labelledby="pane-' + env + '">' +
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

  // ─── Database Studio: live data browser ────────────────────────────────────
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
      return '<div class="empty card"><p>No ' + entityNoun(s, true).toLowerCase() + ' found in this database.</p></div>';
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
      ? '<div class="prod-banner"><span><b>Production Safeguard Active:</b> Operating on live production data. All mutations require strict challenge phrase confirmation and are recorded to .nativ/prod_audit.log.</span><span class="badge badge-prod">PROD</span></div>'
      : '';

    var toolbar = '<div class="data-toolbar">' +
      '<div class="data-controls">' +
        '<select class="input" id="data-entity-select" aria-label="Table or collection" style="min-width:180px;font-weight:600">' + entityOptions + '</select>' +
        '<input class="input" id="data-search" type="search" aria-label="Search records" placeholder="Search records in ' + esc(state.dataEntity) + '…" value="' + esc(state.dataSearch) + '" style="min-width:200px">' +
        '<select class="input" id="data-limit-select" aria-label="Rows per page">' + limitOptions + '</select>' +
        '<button class="btn" type="button" id="btn-data-refresh">Refresh</button>' +
      '</div>' +
      '<button class="btn primary" type="button" id="btn-insert-record">+ Insert ' + (isColl ? 'Document' : 'Record') + '</button>' +
    '</div>';

    if (state.dataLoading) {
      return prodBannerHtml + toolbar + '<div class="card" style="padding:48px 24px;text-align:center"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    }

    if (state.dataError) {
      return prodBannerHtml + toolbar + '<div class="alert-danger" style="margin-top:12px"><strong>Query error:</strong> ' + esc(state.dataError) + '</div>';
    }

    var res = state.dataResult;
    if (!res || !res.rows || res.entity !== state.dataEntity) {
      setTimeout(function () { fetchDataRecords(); }, 10);
      return prodBannerHtml + toolbar + '<div class="card" style="padding:48px 24px;text-align:center"><p class="muted">Loading records for ' + esc(state.dataEntity) + '…</p></div>';
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
    renderDb();

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
      renderDb();
    }, function (err) {
      state.dataError = err.message;
      state.dataLoading = false;
      renderDb();
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
    openDialog($('record-dialog'));
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
    openDialog($('record-dialog'));
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
      openDialog($('challenge-dialog'));
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
        toast('Production ' + action.toLowerCase() + ' executed. Logged to .nativ/prod_audit.log', 'ok');
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

  // ─── Database Studio: drift ────────────────────────────────────────────────
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
    var html = targetSelect() + '<div class="summary-banner card" role="region" aria-label="Drift summary">' +
      '<div class="stat"><div class="n" style="color:var(--success)">' + s.addedTablesCount + '</div><div class="l">Added ' + noun + '</div></div>' +
      '<div class="stat"><div class="n" style="color:var(--active)">' + s.alteredTablesCount + '</div><div class="l">Altered ' + noun + '</div></div>' +
      '<div class="stat"><div class="n" style="color:var(--danger)">' + s.droppedTablesCount + '</div><div class="l">Dropped ' + noun + '</div></div>' +
      '<div class="stat"><div class="n muted">' + s.unchangedTablesCount + '</div><div class="l">Unchanged</div></div>' +
      '<div class="stat"><div class="n risk-' + risk + '">' + risk + '</div><div class="l">Risk level</div></div></div>';

    if (!s.addedTablesCount && !s.alteredTablesCount && !s.droppedTablesCount) {
      return html + '<div class="empty card"><h3>In sync</h3><p>Dev matches ' + esc(targetLabel) + '. No drift detected.</p></div>';
    }

    if (d.addedTables.length) {
      html += '<section class="section card"><h3><span class="badge badge-added">NEW TABLE</span> Added in Dev (' + d.addedTables.length + ')</h3>' +
        d.addedTables.map(function (t) { return tableCard(t, 'added'); }).join('') + '</section>';
    }
    if (d.alteredTables.length) {
      html += '<section class="section card"><h3><span class="badge badge-altered">ALTERED</span> Altered ' + noun + ' (' + d.alteredTables.length + ')</h3>' +
        d.alteredTables.map(alteredTableHtml).join('') + '</section>';
    }
    if (d.droppedTables.length) {
      html += '<section class="section card"><h3><span class="badge badge-dropped">DROPPED</span> Dropped in Dev (' + d.droppedTables.length + ')</h3>' +
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
      '// Nativ migration preview: Dev → ' + target + ' (MongoDB shell)',
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
      _nativ: 'Preview Dev → ' + target + ' (Firestore). Nothing runs automatically.',
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
      '-- Nativ migration preview: Dev → ' + target + ' (' + (ENGINE_LABEL[dialect] || dialect) + ' dialect)',
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
    return '<div class="sql-wrap card"><div class="sql-head"><span class="muted"><span class="lang">' + LANG_LABEL[lang] + '</span>' +
      (destructive ? '<span class="badge badge-dropped">DESTRUCTIVE</span> ' : '') + state.scriptCount + unit + ' · read-only preview</span>' +
      '<span class="copy-wrap"><span class="tooltip">Copied!</span><button class="btn small" type="button" data-action="copy-sql">Copy ' +
      (lang === 'sql' ? 'SQL' : lang === 'js' ? 'Script' : 'JSON') + '</button></span></div>' +
      '<pre class="sql" tabindex="0" aria-label="Migration script (' + LANG_LABEL[lang] + ')"><code>' + highlightScript(state.sql, lang) + '</code></pre></div>';
  }

  // ─── Database Studio: connection modal ─────────────────────────────────────
  function renderModalStatus() {
    ['dev', 'prod'].forEach(function (env) {
      var s = state.status && state.status[env];
      $('mdot-' + env).className = 'dot ' + (s && s.connected ? 'on' : 'off');
      $('current-' + env).innerHTML = s && s.maskedUrl
        ? 'Current: <code>' + esc(s.maskedUrl) + '</code><span class="copy-wrap"><span class="tooltip">Copied!</span><button class="btn small" type="button" data-copy-masked="' + env + '">Copy</button></span>'
        : 'Current: <span class="muted">not configured</span>';
    });
  }

  function renderTemplateChips() {
    var host = $('conn-template-chips');
    if (!host) return;
    if (!state.envInfo || !state.envInfo.templateFound || !state.envInfo.detectedKeys || state.envInfo.detectedKeys.length === 0) {
      host.innerHTML = '';
      host.hidden = true;
      return;
    }
    var html = '<div class="template-helper-box">' +
      '<div class="template-helper-label">Discovered in <code>' + esc(state.envInfo.templateFile || '.env.example') + '</code>:</div>' +
      '<div class="template-chips">';
    state.envInfo.detectedKeys.forEach(function (dk) {
      var eng = dk.engine ? ' (' + (ENGINE_LABEL[dk.engine] || dk.engine) + ')' : '';
      var statusDot = dk.isConfiguredInEnv ? '<span class="chip-dot on"></span>' : '<span class="chip-dot off"></span>';
      var title = dk.isConfiguredInEnv ? 'Configured in .env' : 'Missing in .env';
      html += '<button type="button" class="btn small template-chip" data-template-key="' + esc(dk.key) + '" data-template-engine="' + esc(dk.engine || '') + '" data-template-env="' + esc(dk.targetEnv) + '" title="' + title + '">' +
        statusDot + esc(dk.key) + eng +
      '</button>';
    });
    html += '</div></div>';
    host.innerHTML = html;
    host.hidden = false;

    host.querySelectorAll('.template-chip').forEach(function (btn) {
      btn.onclick = function () {
        var key = btn.getAttribute('data-template-key');
        var eng = btn.getAttribute('data-template-engine');
        var targetEnv = btn.getAttribute('data-template-env') || 'dev';
        // Fragmented component keys (DB_HOST, DB_PORT, ...) map to the parameter form, not a URL.
        var isComponent = /(^|_)(HOST|HOSTNAME|SERVER|PORT|USER|USERNAME|PASS|PASSWORD|DATABASE|NAME|CONNECTION|DRIVER)$/i.test(key) && eng !== 'mongodb' && eng !== 'firestore' && eng !== 'sqlite';
        $('engine-' + targetEnv).value = eng === 'firestore' ? 'firestore' : isComponent ? 'form' : 'url';
        setEngineMode(targetEnv);
        if (isComponent) {
          if (eng === 'mysql' || eng === 'postgresql') $('pengine-' + targetEnv).value = eng;
          $('phost-' + targetEnv).focus();
        } else {
          $((eng === 'firestore' ? 'fsproject-' : 'url-') + targetEnv).focus();
        }
        toast('Selected ' + key + ' for ' + targetEnv.toUpperCase());
      };
    });
  }

  function openSettings() {
    renderModalStatus();
    renderTemplateChips();
    ['dev', 'prod'].forEach(function (env) { $('result-' + env).textContent = ''; $('result-' + env).className = 'result'; });
    openDialog($('conn-dialog'));
  }

  function isFirestoreMode(env) { return $('engine-' + env).value === 'firestore'; }
  function isFormMode(env) { return $('engine-' + env).value === 'form'; }

  var PARAM_FIELDS = ['phost', 'pport', 'puser', 'ppass', 'pdb'];
  var DEFAULT_PORT = { mysql: '3306', postgresql: '5432' };

  function setEngineMode(env) {
    var fs = isFirestoreMode(env);
    var form = isFormMode(env);
    $('url-' + env).hidden = fs || form;
    document.querySelector('[data-toggle="' + env + '"]').hidden = fs || form;
    $('fsproject-' + env).hidden = !fs;
    $('fsemu-' + env).hidden = !fs;
    $('params-' + env).hidden = !form;
    $('result-' + env).textContent = '';
  }

  /** Quick-fill for a stock XAMPP install: MySQL on 127.0.0.1:3306 as root with an empty password. */
  function applyXamppDefaults(env) {
    $('engine-' + env).value = 'form';
    setEngineMode(env);
    $('pengine-' + env).value = 'mysql';
    $('phost-' + env).value = '127.0.0.1';
    $('pport-' + env).value = '3306';
    $('puser-' + env).value = 'root';
    $('ppass-' + env).value = '';
    $('pdb-' + env).focus();
  }

  function hasInput(env) {
    if (isFirestoreMode(env)) return !!$('fsproject-' + env).value.trim();
    if (isFormMode(env)) return !!$('phost-' + env).value.trim();
    return !!$('url-' + env).value.trim();
  }

  /** Parameter form: sent as the contract's components payload; the server assembles the URL in memory. */
  function componentsBody(env) {
    var engine = $('pengine-' + env).value;
    var host = $('phost-' + env).value.trim();
    var port = $('pport-' + env).value.trim() || DEFAULT_PORT[engine];
    if (!host) return { error: 'Enter a host, e.g. 127.0.0.1.' };
    if (!/^[A-Za-z0-9._:\[\]-]{1,253}$/.test(host)) return { error: 'Host must be a hostname or IP address.' };
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) return { error: 'Port must be a number between 1 and 65535.' };
    var components = { engine: engine, host: host, port: +port };
    var user = $('puser-' + env).value.trim();
    var password = $('ppass-' + env).value;
    var database = $('pdb-' + env).value.trim();
    if (user) components.user = user;
    if (password) components.password = password;
    if (database) components.database = database;
    return { body: { env: env, engine: engine, components: components } };
  }

  /** Builds the /api/connect body. Firestore is sent as a firestore:// URL plus the contract's firestoreConfig. */
  function connectBody(env) {
    if (isFormMode(env)) return componentsBody(env);
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
        $('ppass-' + env).value = '';
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

  // ─── Events: primary navigation ────────────────────────────────────────────
  function viewFromHash() {
    var h = String(location.hash || '').replace(/^#/, '');
    return VIEWS.indexOf(h) !== -1 ? h : 'overview';
  }

  function setView(view, focus) {
    ui.view = view;
    VIEWS.forEach(function (v) {
      var active = v === view;
      var tab = $('nav-' + v);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
      $('panel-' + v).hidden = !active;
      if (active) $('crumb-view').textContent = tab.querySelector('.nav-label').textContent;
    });
    if (location.hash !== '#' + view && window.history && history.replaceState) history.replaceState(null, '', '#' + view);
    if (view === 'database') {
      // The Database Studio connects to live databases, so it only loads once it is opened.
      if (!state.dbStarted) { state.dbStarted = true; load(false); } else renderDb();
    } else {
      paint(view);
    }
    if (focus) {
      var tab = $('nav-' + view);
      tab.focus();
      if (tab.scrollIntoView) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  document.querySelectorAll('.nav-tab').forEach(function (t) {
    t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
    t.addEventListener('keydown', function (e) {
      var i = VIEWS.indexOf(ui.view), n = VIEWS.length, next = null;
      // Vertical sidebar: Up/Down; Left/Right still work when the narrow layout lays the tabs out in a row.
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = VIEWS[(i + 1) % n];
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = VIEWS[(i + n - 1) % n];
      else if (e.key === 'Home') next = VIEWS[0];
      else if (e.key === 'End') next = VIEWS[n - 1];
      if (next) { e.preventDefault(); setView(next, true); }
    });
  });

  window.addEventListener('hashchange', function () {
    var v = viewFromHash();
    if (v !== ui.view) setView(v);
  });

  $('btn-refresh-all').addEventListener('click', function () {
    var btn = $('btn-refresh-all');
    btn.disabled = true;
    btn.classList.add('is-busy');
    var jobs = [fetchPipeline(ALL_PARTS)];
    if (state.dbStarted) jobs.push(load(true));
    var done = function () { btn.disabled = false; btn.classList.remove('is-busy'); };
    Promise.all(jobs).then(done, done);
  });

  // ─── Events: Mission Control views ─────────────────────────────────────────
  $('main').addEventListener('click', function (e) {
    if (e.target.closest('#view')) return; // Database Studio handles its own clicks.
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    var action = el.getAttribute('data-action');
    var key = el.getAttribute('data-key');
    if (action === 'task-start') runTaskAction('start', key);
    else if (action === 'task-complete') runTaskAction('complete', key);
    else if (action === 'task-block') openBlockDialog(key);
    else if (action === 'task-dispatch') openDispatchDialog(key);
    else if (action === 'run-console') openConsole(key);
    else if (action === 'run-abort') confirmAbort(key);
    else if (action === 'wt-diff') openConsole(key, false, 'diff');
    else if (action === 'heal-review') openConsole(key, false, 'heal');
    else if (action === 'wt-merge') confirmWorktree('merge', key);
    else if (action === 'wt-remove') confirmWorktree('remove', key);
    else if (action === 'bench-run') runBenchmark();
    else if (action === 'retry' && PIPE_PATHS[key]) fetchPipeline([key]);
  });

  $('panel-tasks').addEventListener('input', function (e) {
    if (e.target.id === 'task-search') { pipe.filterText = e.target.value; paint('tasks'); }
  });
  $('panel-tasks').addEventListener('change', function (e) {
    if (e.target.id === 'task-milestone') { pipe.filterMilestone = e.target.value; paint('tasks'); }
  });

  $('btn-confirm-block').addEventListener('click', function () {
    var reason = $('block-reason').value.trim();
    if (!reason) {
      $('block-error').textContent = 'Enter a reason so the next agent knows why this task stopped.';
      $('block-reason').focus();
      return;
    }
    var id = pendingBlock;
    pendingBlock = null;
    $('block-dialog').close();
    if (id) runTaskAction('block', id, reason);
  });

  // ─── Events: live runner console drawer ────────────────────────────────────
  $('rc-autoscroll').addEventListener('click', function () {
    rc.autoscroll = !rc.autoscroll;
    this.setAttribute('aria-pressed', String(rc.autoscroll));
    if (rc.autoscroll) $('rc-body').scrollTop = $('rc-body').scrollHeight;
  });
  $('rc-clear').addEventListener('click', function () {
    $('rc-body').innerHTML = '<span class="rc-empty">Console cleared. New output will stream in here.</span>';
  });
  $('rc-abort').addEventListener('click', function () { if (rc.taskId) confirmAbort(rc.taskId); });
  document.querySelectorAll('.rc-tab').forEach(function (btn) {
    btn.addEventListener('click', function () { setConsoleTab(btn.getAttribute('data-rc-tab')); });
    btn.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var tabs = visibleConsoleTabs();
      var i = tabs.indexOf(rc.tab);
      setConsoleTab(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true);
    });
  });
  $('rc-diff-refresh').addEventListener('click', function () { if (rc.taskId) loadConsoleDiff(rc.taskId); });
  $('rc-heal').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-heal]');
    if (!btn || btn.disabled) return;
    var what = btn.getAttribute('data-heal');
    if (what === 'retry') { pipe.loaded.escalations = false; renderHeal(); fetchPipeline(['escalations']); }
    else resolveEscalation(what);
  });

  // ─── Events: dispatch modal ────────────────────────────────────────────────
  document.querySelectorAll('input[name="dispatch-engine"], input[name="dispatch-budget"]').forEach(function (input) {
    input.addEventListener('change', syncDispatchEngine);
  });
  $('dispatch-worktree').addEventListener('change', syncDispatchSwitches);
  $('dispatch-verify-gate').addEventListener('change', syncDispatchSwitches);
  $('btn-launch-agent').addEventListener('click', launchDispatch);
  $('dispatch-dialog').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); launchDispatch(); }
  });
  $('dispatch-dialog').addEventListener('close', function () { pendingDispatch = null; });
  $('rc-minimize').addEventListener('click', toggleConsoleMinimized);
  $('rc-close').addEventListener('click', closeConsole);
  $('runner-console-drawer').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeConsole(); $('main').focus(); }
  });

  $('btn-confirm-ok').addEventListener('click', function () {
    var fn = pendingConfirm;
    pendingConfirm = null;
    $('confirm-dialog').close();
    if (fn) fn();
  });

  // ─── Events: Database Studio ───────────────────────────────────────────────
  function setDbTab(tab, focus) {
    state.tab = tab;
    renderDb();
    if (focus) $('tab-' + tab).focus();
    if (tab === 'data' && (!state.dataResult || state.dataResult.entity !== state.dataEntity)) {
      fetchDataRecords();
    }
  }

  document.querySelectorAll('.subtab').forEach(function (t) {
    t.addEventListener('click', function () { setDbTab(t.getAttribute('data-tab')); });
    t.addEventListener('keydown', function (e) {
      var order = ['explorer', 'data', 'drift', 'sql'];
      var i = order.indexOf(state.tab);
      if (e.key === 'ArrowRight') { e.preventDefault(); setDbTab(order[(i + 1) % 4], true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setDbTab(order[(i + 3) % 4], true); }
      else if (e.key === 'Home') { e.preventDefault(); setDbTab('explorer', true); }
      else if (e.key === 'End') { e.preventDefault(); setDbTab('sql', true); }
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
        renderDb();
        if (state.tab === 'data') fetchDataRecords();
      }
    });
  });

  $('btn-settings').addEventListener('click', openSettings);
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
      renderDb();
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
      openDialog($('media-dialog'));
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
    if (envToggle) { state.mobileEnv = envToggle; renderDb(); }
  });

  $('btn-save-record').addEventListener('click', handleSaveRecordSubmit);

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
    $('pengine-' + env).addEventListener('change', function () {
      var port = $('pport-' + env);
      // Swap the port only when it still holds the other engine's default.
      if (!port.value.trim() || port.value.trim() === DEFAULT_PORT.mysql || port.value.trim() === DEFAULT_PORT.postgresql) {
        port.value = DEFAULT_PORT[$('pengine-' + env).value];
      }
    });
    document.querySelector('[data-xampp="' + env + '"]').addEventListener('click', function () { applyXamppDefaults(env); });
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
      PARAM_FIELDS.forEach(function (f) { $(f + '-' + env).value = ''; });
      var t = document.querySelector('[data-toggle="' + env + '"]');
      if (t) { t.textContent = 'Show'; t.setAttribute('aria-pressed', 'false'); }
    });
  });

  // ─── Boot ──────────────────────────────────────────────────────────────────
  setView(viewFromHash());
  fetchPipeline(ALL_PARTS);
  connectEvents();
})();
</script>
</body>
</html>`;
}
