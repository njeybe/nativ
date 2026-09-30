// Database Studio view styles.
export const databaseCss = String.raw`/* Database Studio */
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

`;
