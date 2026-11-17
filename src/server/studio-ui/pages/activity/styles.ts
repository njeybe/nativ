// Activity page styles, all scoped under #panel-activity. Ink look: row groups, 1px dividers.
export const activityCss = String.raw`#panel-activity .act-head {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
#panel-activity .act-head h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
#panel-activity .act-count { color: var(--fg-3); }
#panel-activity .chips { margin-left: auto; display: flex; gap: 4px; }
#panel-activity .chip {
  height: 28px; padding: 0 12px; border: 1px solid var(--line); border-radius: 14px;
  background: none; color: var(--fg-2); font: inherit; cursor: pointer; }
#panel-activity .chip.on { color: var(--fg); border-color: var(--fg-3); }
#panel-activity .lanes { margin-top: 16px; border-top: 1px solid var(--line); }
#panel-activity .lane {
  display: flex; gap: 16px; align-items: flex-start; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid var(--line); }
#panel-activity .lane-main { flex: 1; min-width: 0; display: grid; gap: 4px; }
#panel-activity .lane-l1, #panel-activity .lane-l2, #panel-activity .lane-l3 {
  display: flex; gap: 12px; align-items: baseline; min-width: 0; }
#panel-activity .lane-l2 { color: var(--fg-2); }
#panel-activity .lane-l3 { color: var(--fg-3); font-size: 12px; flex-wrap: wrap; }
#panel-activity .lbl { font-weight: 500; }
#panel-activity .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
#panel-activity .model { color: var(--fg-3); }
#panel-activity .ttl, #panel-activity .txt {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
#panel-activity .ttl { color: var(--fg-2); }
#panel-activity .none, #panel-activity .ago, #panel-activity .hint { color: var(--fg-3); }
#panel-activity .ago { margin-left: auto; white-space: nowrap; }
#panel-activity .st { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; white-space: nowrap; }
#panel-activity .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-3); }
#panel-activity .st-active .dot { background: var(--run); }
#panel-activity .st-stopped .dot { background: var(--ok); }
#panel-activity .st-failed .dot { background: var(--bad); }
#panel-activity .st-paused .dot { background: var(--warn); }
#panel-activity .tok { margin-left: auto; }
#panel-activity .lane-actions {
  display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
#panel-activity .act-btn {
  height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 6px;
  background: none; color: var(--fg); font: inherit; cursor: pointer; }
#panel-activity .tip-wrap { position: relative; }
#panel-activity .act-empty { padding: 24px 0; }
#panel-activity .act-empty p { margin: 0 0 4px; }
#panel-activity .skel { height: 12px; margin: 8px 0; border-radius: 4px; background: var(--line); }
#panel-activity .feed { list-style: none; margin: 24px 0 0; padding: 0; }
#panel-activity .feed li { display: flex; gap: 12px; height: 28px; align-items: center; color: var(--fg-2); }
#panel-activity .feed .who { width: 110px; color: var(--fg); }
#panel-activity .feed .tid { width: 80px; color: var(--fg-3); }
@media (max-width: 1023px) {
  #panel-activity .lane { flex-direction: column; gap: 8px; }
  #panel-activity .lane-main, #panel-activity .lane-actions { width: 100%; }
  #panel-activity .lane-l1, #panel-activity .lane-l3 { flex-wrap: wrap; }
  #panel-activity .lane-actions { justify-content: flex-start; }
}
`;
