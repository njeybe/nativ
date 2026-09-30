// App shell: sidebar, top bar, page frame, status helpers, detail panel, palette.
export const shellCss = String.raw`/* Layout */
.app { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); min-height: 100vh; }
.side { border-right: 1px solid var(--line); background: var(--surface); padding: 16px 12px; display: flex; flex-direction: column; gap: 20px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
.logo { width: 26px; height: 26px; border-radius: 7px; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-weight: 700; font-size: 14px; flex: none; }
.brand b { font-weight: 600; white-space: nowrap; }
.brand .ver { margin-left: auto; font: 11px var(--mono); color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav { display: flex; flex-direction: column; gap: 14px; }
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-glabel { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); padding: 0 8px 4px; }
.nav-item { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 7px 8px; border-radius: 7px; border: 0; background: none; text-align: left; color: var(--fg-2); width: 100%; cursor: pointer; transition: background .15s, color .15s; }
.nav-item svg { width: 16px; height: 16px; flex: none; }
.nav-item:hover { background: var(--surface-2); color: var(--fg); }
.nav-item[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
.nav-badge { margin-left: auto; font: 500 11px var(--font); font-variant-numeric: tabular-nums; min-width: 20px; padding: 1px 6px; border-radius: 999px; background: var(--surface-2); color: var(--fg-2); text-align: center; }
.nav-badge.warn { background: var(--warn-soft); color: var(--warn); }
.nav-badge.run { background: var(--run-soft); color: var(--run); }
.side-foot { margin-top: auto; font-size: 12px; color: var(--fg-3); padding: 0 8px; display: flex; flex-direction: column; gap: 4px; }
.side-foot > div { display: flex; flex-direction: column; gap: 4px; }
.side-foot .mono { color: var(--fg-2); font-size: 11px; word-break: break-all; }
.foot-project { color: var(--fg); font-weight: 500; }
.main { min-width: 0; display: flex; flex-direction: column; }
.top { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 20; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 24px; }
.crumb { color: var(--fg-3); font-size: 13px; }
.crumb b { color: var(--fg); font-weight: 500; }
.top-right { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn.ghost { background: none; border-color: transparent; color: var(--fg-2); box-shadow: none; }
.btn.ghost:hover { background: var(--surface-2); }
.btn svg { width: 14px; height: 14px; }
.kbd { font: 11px var(--mono); padding: 0 5px; border: 1px solid var(--line); border-radius: 4px; color: var(--fg-3); }
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--fg-2); }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-3); }
.live[data-state="live"] .live-dot { background: var(--ok); }
.live-dot.flash { animation: live-flash .9s ease-out; }
@keyframes live-flash { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 65%, transparent); } 100% { box-shadow: 0 0 0 9px transparent; } }
@keyframes blink { 50% { opacity: .35; } }
.banner { margin: 0; padding: 8px 24px; background: var(--warn-soft); color: var(--warn); font-size: 13px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.page { padding: 28px 24px 64px; max-width: 1240px; width: 100%; margin: 0 auto; }
.page:focus { outline: none; }
.page-view { min-width: 0; display: flex; flex-direction: column; gap: 22px; }
#panel-worktrees, #panel-benchmarks, #panel-database { display: block; }

/* Shared helpers for pages */
.num { font-variant-numeric: tabular-nums; }
.faint { color: var(--fg-3); }
.st { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; }
.st svg { width: 16px; height: 16px; }
.st.completed { color: var(--ok); } .st.blocked { color: var(--bad); } .st.pending { color: var(--fg-3); } .st.in_progress { color: var(--run); }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--run); box-shadow: 0 0 0 0 color-mix(in srgb, var(--run) 50%, transparent); animation: pulse 1.6s infinite; }
@keyframes pulse { 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.agent { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-2); white-space: nowrap; }
.agent i { width: 7px; height: 7px; border-radius: 2px; background: var(--c, var(--fg-3)); }
.status-pill { font-size: 11.5px; font-weight: 500; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.status-pill.completed { background: var(--ok-soft); color: var(--ok); } .status-pill.in_progress { background: var(--run-soft); color: var(--run); }
.status-pill.blocked { background: var(--bad-soft); color: var(--bad); } .status-pill.pending { background: var(--surface-2); color: var(--fg-2); }
.sel { height: 30px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); padding: 0 28px 0 10px; max-width: 100%; }
.row-btn { display: grid; grid-template-columns: 18px 88px minmax(0, 1fr) auto auto; gap: 12px; align-items: center; min-height: 32px; padding: 9px 16px; border: 0; background: none; text-align: left; border-top: 1px solid var(--line); width: 100%; cursor: pointer; }
.row-btn:hover { background: var(--surface-2); }
.row-btn .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-empty { padding: 36px 16px; text-align: center; color: var(--fg-2); }
.ui-empty b { display: block; color: var(--fg); font-weight: 600; margin-bottom: 4px; }
.skel { height: 14px; border-radius: 6px; margin-bottom: 10px; background: var(--surface-2); }
.skel-head .skel:first-child { height: 22px; }
.skel-block { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }

/* Detail panel */
.scrim { position: fixed; inset: 0; background: rgba(10,10,20,.25); z-index: 40; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100%); background: var(--surface); border-left: 1px solid var(--line); box-shadow: var(--shadow); z-index: 41; display: flex; flex-direction: column; padding-top: env(safe-area-inset-top, 0px); }
.drawer:focus { outline: none; }
.drawer-head { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.drawer-head .close { margin-left: auto; }
.drawer-body { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 18px; padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
.drawer h3 { margin: 0; font-size: 17px; font-weight: 600; text-wrap: balance; }
.drawer .kv { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px 12px; font-size: 13px; margin: 0; }
.drawer .kv dt { color: var(--fg-3); }
.drawer .kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dlabel { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); margin-bottom: 6px; }
.drawer .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.drawer .chip { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 3px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); font-size: 12px; font-family: var(--font); }
.drawer .chip.mono { font-family: var(--mono); }
.drawer button.chip { cursor: pointer; }
.drawer button.chip:hover { border-color: var(--line-2); }
.drawer .code { font: 12px var(--mono); background: var(--surface-2); border-radius: 8px; padding: 10px 12px; overflow-x: auto; white-space: pre; }
.drawer .code.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.drawer .reason { background: var(--bad-soft); color: var(--fg); border-radius: 8px; padding: 10px 12px; font-size: 13px; }

/* Command palette */
.pal-wrap { position: fixed; inset: 0; z-index: 50; display: flex; justify-content: center; align-items: flex-start; padding: 12vh 16px 16px; background: rgba(10,10,20,.3); }
.pal { width: min(620px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }
.pal input { width: 100%; border: 0; border-bottom: 1px solid var(--line); background: none; padding: 14px 16px; font-size: 15px; outline: none; }
.pal ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow: auto; }
.pal li { display: grid; grid-template-columns: 18px 150px minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 32px; padding: 8px 10px; border-radius: 7px; cursor: pointer; }
.pal li[aria-selected="true"] { background: var(--accent-soft); }
.pal li .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pal li.pal-none { display: block; cursor: default; }
.pal-ico svg { width: 16px; height: 16px; display: block; }
.pal .hint { padding: 8px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--fg-3); display: flex; gap: 14px; }
.toast-host { bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }

@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; height: auto; flex-direction: row; align-items: center; padding: 10px 16px; gap: 12px; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .side-foot, .brand .ver, .brand b, .nav-glabel { display: none; }
  .nav { flex-direction: row; gap: 2px; }
  .nav-group { flex-direction: row; }
  .nav-item { width: auto; white-space: nowrap; }
  .top, .page { padding-left: 16px; padding-right: 16px; }
  .banner { padding-inline: 16px; }
  .row-btn { grid-template-columns: 18px minmax(0, 1fr) auto; }
  .hide-sm { display: none; }
  .pal li { grid-template-columns: 18px minmax(0, 1fr); }
  .drawer { width: 100%; }
  #runner-console-drawer { inset: auto 0 0 0; }
}
@media (prefers-reduced-motion: reduce) { .pulse, .live-dot.flash { animation: none; } * { transition: none !important; } }
`;
