// Home page styles, all scoped under #panel-home. Ink: flat sections, one raised decision surface.
export const homeCss = String.raw`#panel-home .home { display: flex; flex-direction: column; }
#panel-home .page-head h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px; letter-spacing: -.01em; }
#panel-home .home-sec { border-top: 1px solid var(--line); padding: 12px 0; min-width: 0; }
#panel-home .sec-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
#panel-home .sec-head h2 { font-size: 13px; font-weight: 600; margin: 0; color: var(--fg-2); }
#panel-home .sec-head .right { margin-left: auto; font-size: 12px; color: var(--fg-3); }
#panel-home .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
#panel-home .row { display: flex; align-items: center; gap: 12px; min-height: 36px; }
#panel-home .row .id { width: 72px; flex: none; color: var(--fg-2); font-size: 12px; }
#panel-home .row .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-home .link { background: none; border: 0; padding: 0; text-align: left; color: var(--fg); cursor: pointer; font: inherit; }
#panel-home .agent { width: 96px; flex: none; color: var(--fg-2); font-size: 12.5px; }
#panel-home .state { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; }
#panel-home .timer { width: 64px; text-align: right; font-size: 12px; }
#panel-home .sub-row .log { flex: 1; min-width: 0; font-size: 12px; color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-home .wait { color: var(--fg-3); font-size: 12.5px; }
#panel-home .calm { color: var(--fg-2); justify-content: space-between; }
#panel-home .decisions { background: var(--surface); border: 0; border-left: 3px solid var(--warn); border-radius: 6px; box-shadow: var(--shadow); padding: 8px 16px; margin-bottom: 12px; }
#panel-home .need { display: flex; align-items: center; gap: 12px; min-height: 36px; padding: 8px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
#panel-home .need .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
#panel-home .need .l1 { display: flex; gap: 8px; align-items: baseline; }
#panel-home .need .why { font-size: 13px; color: var(--fg-2); overflow-wrap: anywhere; }
#panel-home .need .acts { display: flex; gap: 8px; flex-wrap: wrap; }
#panel-home .progress { height: 4px; border-bottom: 1px solid var(--line); }
#panel-home .progress i { display: block; height: 4px; background: var(--fg); border-radius: 2px; }
#panel-home .act-row .when { width: 72px; flex: none; font-size: 12px; color: var(--fg-3); }
#panel-home .skel-row .skel { height: 12px; width: 100%; border-radius: 6px; background: var(--surface-2); }
@media (max-width: 1024px) {
  #panel-home .agent { display: none; }
}
`;
