// Runner console drawer and proposal review styles.
export const consoleCss = String.raw`/* Live runner console drawer */
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
.rc-step.is-done { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
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
.rc-fg-ok { color: var(--ok); }
.rc-fg-info { color: var(--accent); }
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
.heal-verdict.pass { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent); }
.heal-verdict.fail { color: color-mix(in srgb, var(--danger) 55%, #fff); background: color-mix(in srgb, var(--danger) 18%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); }
.heal-diag { margin: 0 0 10px; color: var(--term-muted); overflow-wrap: anywhere; }
.heal-diag strong { color: var(--term-text); font-weight: 600; }
.heal-grid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 12px; }
.heal-section h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--term-muted); }
.heal-patch { margin: 0; padding: 8px 10px; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; background: rgb(148 163 184 / 0.08); border: 1px solid var(--term-line); border-radius: var(--r-control); }
.heal-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.heal-checks li { display: flex; gap: 7px; align-items: flex-start; color: var(--term-muted); font-size: 12.5px; }
.heal-checks li b { color: var(--term-text); font-family: var(--mono); font-weight: 500; }
.heal-checks .ok { color: var(--ok); }
.heal-checks .bad { color: color-mix(in srgb, var(--danger) 55%, #fff); }
/* Pinned to the drawer's bottom edge so the decision never needs a scroll. */
.heal-actions { position: sticky; bottom: -14px; display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin: 12px -14px -14px; padding: 10px 14px; background: var(--term-bg); border-top: 1px solid var(--term-line); }
.rc-btn.approve { color: #fff; background: var(--success); border-color: var(--success); }
.rc-btn.approve:hover:not(:disabled) { background: color-mix(in srgb, var(--success) 88%, #000); }
.rc-btn.reject { color: color-mix(in srgb, var(--danger) 55%, #fff); border-color: color-mix(in srgb, var(--danger) 50%, transparent); }
.rc-btn.reject:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 16%, transparent); }
.heal-result { margin: 0 0 10px; padding: 8px 10px; color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent); border-radius: var(--r-control); }
.heal-result.is-error { color: color-mix(in srgb, var(--danger) 55%, #fff); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.heal-skel { height: 12px; margin: 8px 0; border-radius: 4px; background: var(--term-line); animation: blink 1.4s ease-in-out infinite; }
@media (max-width: 768px) { .heal-grid { grid-template-columns: 1fr; } }
`;
