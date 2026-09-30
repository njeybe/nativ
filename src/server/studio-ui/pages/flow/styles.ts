// Flow page styles, all scoped under #panel-flow.
export const flowCss = String.raw`#panel-flow .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--surface); }
#panel-flow .seg button { border: 0; background: none; padding: 0 12px; height: 30px; font-size: 13px; color: var(--fg-2); cursor: pointer; }
#panel-flow .seg button + button { border-left: 1px solid var(--line); }
#panel-flow .seg button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 500; }
#panel-flow .fl-panel { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; min-width: 0; overflow: hidden; }
#panel-flow .fl-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; padding: 12px 16px; }
#panel-flow .fl-bar .right { margin-left: auto; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--fg-3); }
#panel-flow .flow-wrap { overflow: auto; max-height: 72vh; position: relative; border-top: 1px solid var(--line); }
#panel-flow .canvas { position: relative; }
#panel-flow .canvas svg.wires { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
#panel-flow .wire { fill: none; stroke: var(--line-2); stroke-width: 1.5; transition: opacity .15s, stroke .15s; }
#panel-flow .wire.implied { stroke-dasharray: 4 4; }
#panel-flow .wire.hot { stroke: var(--accent); stroke-width: 2; }
#panel-flow .canvas.focus .wire:not(.hot) { opacity: .15; }
#panel-flow .lane-band { position: absolute; left: 0; right: 0; border-top: 1px solid var(--line); }
#panel-flow .lane-band:nth-child(even) { background: color-mix(in srgb, var(--surface-2) 45%, transparent); }
#panel-flow .lane-label { position: sticky; left: 0; width: 128px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; background: var(--surface); border-right: 1px solid var(--line); height: 100%; z-index: 2; }
#panel-flow .lane-label .faint { font-size: 11.5px; }
#panel-flow .round-head { position: absolute; top: 0; height: 30px; display: flex; align-items: center; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-3); }
#panel-flow .node { position: absolute; display: flex; flex-direction: column; justify-content: center; gap: 3px; padding: 7px 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; text-align: left; cursor: pointer; transition: opacity .15s, border-color .15s, box-shadow .15s; z-index: 1; }
#panel-flow .node:hover { border-color: var(--line-2); box-shadow: var(--shadow); }
#panel-flow .node.in_progress { border-color: color-mix(in srgb, var(--run) 50%, var(--line)); background: color-mix(in srgb, var(--run-soft) 55%, var(--surface)); }
#panel-flow .node.blocked { border-color: color-mix(in srgb, var(--bad) 50%, var(--line)); background: color-mix(in srgb, var(--bad-soft) 55%, var(--surface)); }
#panel-flow .node .l1 { display: flex; align-items: center; gap: 6px; }
#panel-flow .node .l1 .d { margin-left: auto; font: 11px var(--mono); color: var(--fg-3); }
#panel-flow .node .l1 .mono { font-size: 11px; }
#panel-flow .node .title { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#panel-flow .canvas.focus .node:not(.hot) { opacity: .3; }
#panel-flow .node.sel { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
#panel-flow .legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--fg-2); align-items: center; }
#panel-flow .legend span { display: inline-flex; align-items: center; gap: 6px; }
#panel-flow .check { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--fg-2); }
#panel-flow .stats { display: flex; flex-wrap: wrap; }
#panel-flow .stats > div { padding: 12px 16px; display: flex; flex-direction: column; gap: 1px; min-width: 140px; }
#panel-flow .stats > div + div { border-left: 1px solid var(--line); }
#panel-flow .stats .k { font-size: 12px; color: var(--fg-3); }
#panel-flow .stats .v { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
#panel-flow .stats .s { font-size: 12px; color: var(--fg-2); }
#panel-flow svg.tl { display: block; }
#panel-flow svg.tl text { font-family: var(--font); font-size: 11px; fill: var(--fg-3); }
#panel-flow svg.tl .lane-t { fill: var(--fg); font-weight: 500; font-size: 12px; }
#panel-flow svg.tl .grid { stroke: var(--line); stroke-width: 1; }
#panel-flow svg.tl .band { fill: var(--surface-2); opacity: .5; }
#panel-flow svg.tl .gap { fill: var(--surface-2); }
#panel-flow svg.tl .gap-line { stroke: var(--line-2); stroke-dasharray: 3 3; }
#panel-flow svg.tl .bar-w { fill: color-mix(in srgb, var(--ok) 30%, var(--surface)); stroke: var(--ok); stroke-width: 1; cursor: pointer; }
#panel-flow svg.tl .bar-c { fill: var(--ok); pointer-events: none; }
#panel-flow svg.tl .bar-w.in_progress { fill: url(#fl-stripes); stroke: var(--run); }
#panel-flow svg.tl .bar-w.blocked { fill: color-mix(in srgb, var(--bad) 22%, var(--surface)); stroke: var(--bad); }
#panel-flow svg.tl .bar-w:hover { stroke-width: 2; }
#panel-flow svg.tl .bar-l { fill: var(--fg); font-size: 11px; pointer-events: none; font-family: var(--mono); }
#panel-flow svg.tl .now-line { stroke: var(--run); stroke-width: 1.5; }
#panel-flow svg.tl .stripe-a { fill: var(--run-soft); }
#panel-flow svg.tl .stripe-b { fill: color-mix(in srgb, var(--run) 30%, var(--surface)); }
#panel-flow .fl-untimed { padding: 12px 16px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--fg-3); }
#panel-flow .fl-untimed button { border: 0; background: none; padding: 0; color: var(--fg-2); cursor: pointer; }
#panel-flow .fl-untimed button:hover { text-decoration: underline; }
`;
