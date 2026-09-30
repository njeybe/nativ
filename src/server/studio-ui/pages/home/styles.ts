// Home page styles, all scoped under #panel-home.
export const homeCss = String.raw`#panel-home .page-head { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
#panel-home .page-head h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -.01em; text-wrap: balance; }
#panel-home .page-head p { margin: 4px 0 0; color: var(--fg-2); }
#panel-home .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; min-width: 0; }
#panel-home .panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
#panel-home .panel-head h2 { font-size: 14px; font-weight: 600; margin: 0; }
#panel-home .panel-head .right { margin-left: auto; font-size: 12.5px; color: var(--fg-3); }
#panel-home .panel-body { padding: 14px 16px; }
#panel-home .home-top { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; }
#panel-home .need { display: flex; gap: 12px; padding: 12px; border-radius: 10px; background: var(--bad-soft); }
#panel-home .need + .need { margin-top: 8px; }
#panel-home .need .body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
#panel-home .need .why { font-size: 13px; color: var(--fg-2); overflow-wrap: anywhere; }
#panel-home .need .row { display: flex; gap: 8px; flex-wrap: wrap; }
#panel-home .calm { display: flex; align-items: center; gap: 10px; color: var(--fg-2); padding: 6px 0; }
#panel-home .calm .st { color: var(--ok); }
#panel-home .now { display: flex; flex-direction: column; gap: 6px; width: 100%; text-align: left; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); cursor: pointer; }
#panel-home .now:hover { background: var(--surface-2); }
#panel-home .now + .now { margin-top: 8px; }
#panel-home .now .l1 { display: flex; align-items: center; gap: 8px; }
#panel-home .now .timer { margin-left: auto; font: 12px var(--mono); color: var(--run); }
#panel-home .now .log { font: 11.5px var(--mono); color: var(--fg-2); background: var(--surface-2); padding: 6px 8px; border-radius: 6px; overflow-wrap: anywhere; }
#panel-home .strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
#panel-home .strip > div { padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
#panel-home .strip > div + div { border-left: 1px solid var(--line); }
#panel-home .strip .k { font-size: 12px; color: var(--fg-3); }
#panel-home .strip .v { font-size: 22px; font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
#panel-home .strip .v small { font-size: 13px; font-weight: 400; color: var(--fg-3); }
#panel-home .strip .s { font-size: 12px; color: var(--fg-2); }
#panel-home .list .row-btn:first-child, #panel-home .list .ms-row:first-child { border-top: 0; }
#panel-home .ms-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) 120px 64px; gap: 12px; align-items: center; padding: 9px 16px; border: 0; border-top: 1px solid var(--line); background: none; text-align: left; width: 100%; cursor: pointer; }
#panel-home .ms-row:hover { background: var(--surface-2); }
#panel-home .ms-row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-home .bar { height: 5px; border-radius: 3px; background: var(--surface-2); overflow: hidden; }
#panel-home .bar i { display: block; height: 100%; background: var(--ok); border-radius: 3px; }
#panel-home .row-right { text-align: right; font-size: 12px; }
#panel-home .skel-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 900px) {
  #panel-home .home-top { grid-template-columns: minmax(0, 1fr); }
  #panel-home .strip, #panel-home .skel-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  #panel-home .strip > div:nth-child(3) { border-left: 0; }
}
@media (max-width: 760px) {
  #panel-home .ms-row { grid-template-columns: 34px minmax(0, 1fr) 64px; }
  #panel-home .ms-row .bar { display: none; }
}
`;
