// Team page styles, all scoped under #panel-team.
export const teamCss = String.raw`#panel-team .page-head { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
#panel-team .page-head h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -.01em; text-wrap: balance; }
#panel-team .page-head p { margin: 4px 0 0; color: var(--fg-2); }
#panel-team .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; min-width: 0; margin-top: 16px; }
#panel-team .panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
#panel-team .panel-head h2 { font-size: 14px; font-weight: 600; margin: 0; }
#panel-team .panel-body { padding: 14px 16px; }
#panel-team .table-wrap { overflow-x: auto; }
#panel-team table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
#panel-team th { text-align: left; font-weight: 500; font-size: 12px; color: var(--fg-3); padding: 10px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
#panel-team td { padding: 11px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
#panel-team tr:last-child td { border-bottom: 0; }
#panel-team td.r, #panel-team th.r { text-align: right; }
#panel-team .share { width: 110px; }
#panel-team .bar { height: 6px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
#panel-team .bar i { display: block; height: 100%; border-radius: 3px; }
#panel-team .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px 2px 6px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); font: 12px var(--mono); cursor: pointer; }
#panel-team .chip:hover { background: var(--surface-2); }
#panel-team .defs { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; font-size: 13px; color: var(--fg-2); }
#panel-team .defs b { color: var(--fg); font-weight: 500; }
`;
