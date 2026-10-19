// List, Board and history styles, scoped under the Tasks panel (Ink: 6px radius, 1px dividers).
export const tasksCss = String.raw`#panel-tasks .board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
#panel-tasks .col { background: var(--surface-2); border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
#panel-tasks .col-head { display: flex; align-items: center; gap: 8px; padding: 4px 6px 2px; font-weight: 500; font-size: 13px; }
#panel-tasks .col-head .count { margin-left: auto; background: var(--surface); border-radius: 999px; padding: 0 8px; font-size: 12px; color: var(--fg-2); }
#panel-tasks .col-empty { font-size: 12.5px; color: var(--fg-3); padding: 14px 8px; text-align: center; border: 1px dashed var(--line-2); border-radius: 6px; }
#panel-tasks .tcard { display: flex; flex-direction: column; gap: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px; text-align: left; width: 100%; cursor: pointer; }
#panel-tasks .tcard:hover { border-color: var(--line-2); }
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
#panel-tasks .hist { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
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
#panel-tasks .tbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
#panel-tasks .tfilters, #panel-tasks .tseg { display: flex; gap: 4px; }
#panel-tasks .tseg { margin-left: auto; border: 1px solid var(--line); border-radius: 6px; padding: 2px; }
#panel-tasks .tf, #panel-tasks .seg {
  border: 1px solid transparent; background: none; color: var(--fg-2); border-radius: 6px;
  padding: 4px 10px; font-size: 12.5px; cursor: pointer;
}
#panel-tasks .tf { border-color: var(--line); }
#panel-tasks .tf .num { font-variant-numeric: tabular-nums; color: var(--fg-3); }
#panel-tasks .tf.on, #panel-tasks .seg.on { background: var(--surface-2); color: var(--fg); border-color: var(--line-2); }
#panel-tasks .tlist { border-top: 1px solid var(--line); }
#panel-tasks .tg-head {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 8px; border: 0;
  border-bottom: 1px solid var(--line); background: none; color: var(--fg); text-align: left;
  cursor: pointer; font-weight: 600;
}
#panel-tasks .tg-head .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-tasks .tg-head .num { font-variant-numeric: tabular-nums; font-weight: 400; font-size: 12px; }
#panel-tasks .tg-head .chev { display: inline-grid; transition: transform .15s; }
#panel-tasks .tg-head .chev svg { width: 14px; height: 14px; }
#panel-tasks .tg-head[aria-expanded="true"] .chev { transform: rotate(90deg); }
#panel-tasks .trow {
  display: grid; grid-template-columns: 76px minmax(0, 1fr) 110px 150px 72px; gap: 12px;
  align-items: center; height: 36px; padding: 0 8px;
  font-size: 13px; cursor: pointer;
}
#panel-tasks .trow:hover, #panel-tasks .trow:focus-visible { background: var(--surface-2); }
#panel-tasks .trow:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
#panel-tasks .trow.thead { border-bottom: 1px solid var(--line); cursor: default; color: var(--fg-3); font-size: 12px; background: none; }
#panel-tasks .trow .mono { font-variant-numeric: tabular-nums; font-size: 12px; }
#panel-tasks .c-id { color: var(--fg-3); }
#panel-tasks .c-title, #panel-tasks .c-agent { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#panel-tasks .c-agent { color: var(--fg-2); }
#panel-tasks .c-time { text-align: right; color: var(--fg-2); }
#panel-tasks .c-status { display: flex; align-items: center; gap: 6px; }
#panel-tasks .c-status { white-space: nowrap; overflow: hidden; }
#panel-tasks .st-done { color: var(--ok); }
#panel-tasks .st-running { color: var(--run); }
#panel-tasks .st-stuck { color: var(--bad); }
#panel-tasks .st-next { color: var(--fg); }
#panel-tasks .board-empty { margin: 10px 0 0; font-size: 12.5px; }
#panel-tasks .panel-title .lead { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
#panel-tasks .tdispatch {
  display: none; margin-left: auto; border: 1px solid var(--line-2); background: var(--surface);
  color: var(--fg); border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer;
}
#panel-tasks .trow:hover .tdispatch, #panel-tasks .trow:focus-within .tdispatch { display: inline-block; }
#panel-tasks .tskel span { height: 10px; border-radius: 6px; background: var(--surface-2); }
#panel-tasks .tempty { padding: 36px 16px; text-align: center; color: var(--fg-2); }
#panel-tasks .tempty .btn { margin-top: 8px; }
@media (max-width: 1024px) {
  #panel-tasks .trow { grid-template-columns: 76px minmax(0, 1fr) 150px 72px; }
  #panel-tasks .c-agent { display: none; }
}
@media (max-width: 768px) {
  #panel-tasks .trow { grid-template-columns: 76px minmax(0, 1fr) 120px; }
  #panel-tasks .c-time { display: none; }
}
@media (max-width: 1100px) { #panel-tasks .board { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  #panel-tasks .board { grid-template-columns: minmax(0, 1fr); }
  #panel-tasks .hist-row { grid-template-columns: 16px 34px minmax(0, 1fr) auto; }
  #panel-tasks .hist-row .small { display: none; }
}
`;
