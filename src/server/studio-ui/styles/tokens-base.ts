// Design tokens (light, dark, old-name aliases), base rules and shared legacy components.
const DARK = `--bg: #0e0e13; --surface: #16161d; --surface-2: #1d1d26; --line: #2a2a36; --line-2: #383847;
  --fg: #ececf2; --fg-2: #a4a4b7; --fg-3: #6e6e82;
  --accent: #8e8aff; --accent-soft: #23224a; --accent-fg: #0e0e13;
  --ok: #4ade80; --ok-soft: #13281b; --run: #60a5fa; --run-soft: #142238;
  --bad: #f87171; --bad-soft: #341617; --warn: #fbbf24; --warn-soft: #2f2410;
  --ag-backend: #38bdf8; --ag-frontend: #a78bfa; --ag-qa: #fbbf24; --ag-flutter: #2dd4bf;
  --ag-architect: #8e8aff; --ag-devops: #94a3b8; --ag-database: #34d399; --ag-security: #f87171;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 6px 20px rgba(0,0,0,.35); color-scheme: dark;`;

export const tokensBaseCss = String.raw`:root {
  --bg: #f6f6f9;
  --surface: #ffffff;
  --surface-2: #f0f0f5;
  --line: #e3e3ea; --line-2: #d2d2dc;
  --fg: #16161f; --fg-2: #54546a; --fg-3: #8b8b9e;
  --accent: #4f46e5; --accent-soft: #eeeefe; --accent-fg: #ffffff;
  --ok: #15803d; --ok-soft: #e7f5ec;
  --run: #2563eb; --run-soft: #e7eefd;
  --bad: #dc2626; --bad-soft: #fdecec;
  --warn: #b45309; --warn-soft: #fcf2e1;
  --ag-backend: #0284c7; --ag-frontend: #7c3aed; --ag-qa: #d97706; --ag-flutter: #0d9488;
  --ag-architect: #4f46e5; --ag-devops: #64748b; --ag-database: #059669; --ag-security: #dc2626;
  --shadow: 0 1px 2px rgba(22,22,40,.05), 0 4px 16px rgba(22,22,40,.06);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "SFMono-Regular", Consolas, Menlo, monospace;
  color-scheme: light;
  /* Old names used by Worktrees, Benchmarks, Database and the kept tools follow the new tokens. */
  --border: var(--line); --text: var(--fg); --muted: var(--fg-2);
  --primary: var(--accent); --primary-hover: color-mix(in srgb, var(--accent) 86%, var(--fg));
  --primary-active: color-mix(in srgb, var(--accent) 72%, var(--fg));
  --primary-tint: var(--accent-soft); --primary-line: color-mix(in srgb, var(--accent) 35%, var(--surface));
  --success: var(--ok); --success-bg: var(--ok-soft); --success-line: color-mix(in srgb, var(--ok) 35%, var(--surface));
  --active: var(--run); --active-bg: var(--run-soft); --active-line: color-mix(in srgb, var(--run) 35%, var(--surface));
  --danger: var(--bad); --danger-bg: var(--bad-soft); --danger-line: color-mix(in srgb, var(--bad) 35%, var(--surface));
  --warn-bg: var(--warn-soft);
  --proposal: var(--warn); --proposal-bg: var(--warn-soft); --proposal-line: color-mix(in srgb, var(--warn) 40%, var(--surface));
  --chip: var(--surface-2); --chip-border: var(--line-2);
  --term-bg: #0f172a; --term-text: #f8fafc; --term-muted: #94a3b8; --term-line: rgb(148 163 184 / 0.28);
  --r-control: 7px; --r-card: 12px;
  --shadow-float: 0 12px 32px -8px rgb(15 23 42 / 0.25), 0 2px 6px -2px rgb(15 23 42 / 0.1);
  --sidebar-w: 224px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  ${DARK}
} }
:root[data-theme="dark"] {
  ${DARK}
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 14px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
body { min-height: 100vh; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
code, .mono { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--fg-2); }
.text-danger { color: var(--bad); }
.icon { flex: none; display: block; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); }
.count { display: inline-block; min-width: 20px; padding: 0 6px; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; color: var(--text); background: var(--chip); border: 1px solid var(--border); border-radius: var(--r-control); font-variant-numeric: tabular-nums; }


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
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--accent-fg); }
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

`;
