// Board and history styles, scoped under the Tasks panel.
export const tasksCss = String.raw`#panel-tasks .board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
#panel-tasks .col { background: var(--surface-2); border-radius: 12px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
#panel-tasks .col-head { display: flex; align-items: center; gap: 8px; padding: 4px 6px 2px; font-weight: 500; font-size: 13px; }
#panel-tasks .col-head .count { margin-left: auto; background: var(--surface); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--fg-2); }
#panel-tasks .col-empty { font-size: 12.5px; color: var(--fg-3); padding: 14px 8px; text-align: center; border: 1px dashed var(--line-2); border-radius: 8px; }
#panel-tasks .tcard { display: flex; flex-direction: column; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 10px; text-align: left; width: 100%; cursor: pointer; }
#panel-tasks .tcard:hover { border-color: var(--line-2); box-shadow: var(--shadow); }
#panel-tasks .tcard.in_progress { border-color: color-mix(in srgb, var(--run) 45%, var(--line)); }
#panel-tasks .tcard.blocked { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
#panel-tasks .tcard .l1 { display: flex; align-items: center; gap: 6px; }
#panel-tasks .tcard .l1 .agent { margin-left: auto; }
#panel-tasks .tcard .title { font-size: 13px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#panel-tasks .tcard .meta { font-size: 12px; color: var(--fg-3); display: flex; gap: 8px; flex-wrap: wrap; }
#panel-tasks .tcard .meta .run { color: var(--run); }
#panel-tasks .tcard .meta .bad { color: var(--bad); }
#panel-tasks .more { border: 0; background: none; color: var(--accent); font-size: 12.5px; padding: 6px; cursor: pointer; text-align: center; }
#panel-tasks .more:hover { text-decoration: underline; }
#panel-tasks .section-title { margin: 22px 0 8px; font-size: 15px; font-weight: 600; }
#panel-tasks .hist { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
#panel-tasks .hist-row { display: grid; grid-template-columns: 16px 34px minmax(0, 1fr) auto 70px 90px 60px; gap: 12px; align-items: center; padding: 9px 16px; border: 0; border-top: 1px solid var(--line); background: none; text-align: left; width: 100%; cursor: pointer; }
#panel-tasks .hist > div:first-child .hist-row { border-top: 0; }
#panel-tasks .hist-row:hover { background: var(--surface-2); }
#panel-tasks .hist-row .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-tasks .hist-row .chev { display: inline-grid; transition: transform .15s; }
#panel-tasks .hist-row .chev svg { width: 14px; height: 14px; }
#panel-tasks .hist-row[aria-expanded="true"] .chev { transform: rotate(90deg); }
#panel-tasks .hist-row .small { font-size: 12px; }
#panel-tasks .hist-tasks { background: var(--surface-2); }
#panel-tasks .hist-tasks .row-btn { padding-left: 46px; }
@media (max-width: 1100px) { #panel-tasks .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  #panel-tasks .board { grid-template-columns: minmax(0, 1fr); }
  #panel-tasks .hist-row { grid-template-columns: 16px 34px minmax(0, 1fr) auto; }
  #panel-tasks .hist-row .small { display: none; }
}
`;
