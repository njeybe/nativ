// Toasts, dialogs, dispatch modal and small shared widgets.
export const dialogsCss = String.raw`/* Toasts */
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
dialog::backdrop { background: rgb(10 10 20 / 0.4); backdrop-filter: blur(2px); }
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

/* Task chips used by the dispatch dialog */
.tcard-id { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.file { max-width: 100%; padding: 1px 7px; font-family: var(--mono); font-size: 11.5px; background: var(--chip); border: 1px solid var(--chip-border); border-radius: var(--r-control); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmd { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmd-label { color: var(--text); font-weight: 600; font-size: 12px; }

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
.btn.primary kbd { color: var(--accent-fg); background: transparent; border-color: color-mix(in srgb, var(--accent-fg) 45%, transparent); }

`;
