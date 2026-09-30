// Tier 1 strategist chip, verdicts and decision card styles.
export const strategistCss = String.raw`/* Tier 1 AI Strategist (ui_specs.md §5): header chip, triage verdicts, decision card. */
.t1 { position: relative; }
.t1-chip { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 10px; font: 500 12.5px/1 var(--font); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-control); cursor: pointer; white-space: nowrap; transition: background .15s, border-color .15s; }
.t1-chip:hover { background: var(--bg); border-color: var(--chip-border); }
.t1-chip:focus-visible, .t1-switch:focus-visible, .t1-opt:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.t1-chip .t1-spark { color: var(--primary); }
.t1-chip[data-state="triaging"] { border-color: var(--active-line); }
.t1-chip[data-state="triaging"] .t1-spark { color: var(--active); animation: blink 1s ease-in-out infinite; }
.t1-chip[data-state="attention"] { border-color: var(--proposal-line); }
.t1-chip[data-state="attention"] .t1-spark { color: var(--proposal); }
.t1-chip-label { color: var(--muted); }
.t1-caret { color: var(--muted); transition: transform .15s; }
.t1-chip[aria-expanded="true"] .t1-caret { transform: rotate(180deg); }
.t1-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 300px; padding: 12px; font-size: 12.5px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card); box-shadow: var(--shadow-float); }
.t1-menu:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.t1-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; color: var(--muted); }
.t1-row b, .t1-row code { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
.t1-row code { font-family: var(--mono); font-size: 12px; }
.t1-switch { position: relative; width: 54px; height: 24px; padding: 0 8px; font: 600 10.5px/22px var(--mono); color: var(--muted); text-align: right; background: var(--chip); border: 1px solid var(--chip-border); border-radius: 12px; cursor: pointer; transition: background .15s, border-color .15s; }
.t1-switch::before { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow); transition: transform .15s; }
.t1-switch[aria-checked="true"] { color: #fff; text-align: left; background: var(--success); border-color: var(--success); }
.t1-switch[aria-checked="true"]::before { transform: translateX(30px); }
.t1-switch:disabled { opacity: .5; cursor: not-allowed; }
.t1-policy { display: flex; gap: 6px; margin: 8px 0; padding: 8px; line-height: 1.45; color: var(--muted); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-control); }
.t1-policy .icon { flex: none; margin-top: 1px; color: var(--success); }
.t1-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 0; }
.t1-stats div { min-width: 0; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-control); }
.t1-stats dt { font-size: 11px; color: var(--muted); }
.t1-stats dd { margin: 2px 0 0; font: 600 15px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--text); }
.t1-strip { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 0 0 10px; padding: 8px 10px; color: var(--term-muted); border: 1px solid var(--term-line); border-radius: var(--r-control); }
.t1-strip > span { display: inline-flex; align-items: center; gap: 6px; }
.t1-strip strong { color: var(--term-text); font-weight: 600; }
.t1-strip.is-triaging { border-color: color-mix(in srgb, var(--active) 60%, transparent); background: color-mix(in srgb, var(--active) 14%, transparent); }
.rc-btn.t1-run { color: #fff; background: var(--active); border-color: var(--active); }
.rc-btn.t1-run:hover:not(:disabled) { background: color-mix(in srgb, var(--active) 88%, #000); }
.t1-banner { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; padding: 8px 10px; font-weight: 600; border-radius: var(--r-control); }
.t1-banner.is-resolved { color: #fff; background: var(--success); }
.t1-banner.is-safe { color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent); }
.t1-card { margin: 0 0 12px; padding: 12px 12px 12px 16px; border: 1px solid var(--term-line); border-left: 4px solid var(--proposal); border-radius: var(--r-card); }
.t1-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.t1-badge { font: 600 11.5px/20px var(--font); padding: 0 8px; color: var(--proposal); background: var(--proposal-bg); border-radius: var(--r-control); }
.t1-meta { margin-left: auto; font: 500 11px/18px var(--mono); color: var(--term-muted); }
.t1-parts { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; counter-reset: t1; }
.t1-parts > li { counter-increment: t1; }
.t1-parts h4 { margin: 0 0 3px; font-size: 12.5px; font-weight: 600; color: var(--term-text); }
.t1-parts h4::before { content: counter(t1) ". "; color: var(--proposal); }
.t1-parts p { margin: 0; color: var(--term-muted); overflow-wrap: anywhere; }
.t1-options { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.t1-opt { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; flex: 1 1 200px; min-width: 0; padding: 8px 10px; font: inherit; text-align: left; color: var(--term-text); background: transparent; border: 1px solid var(--muted); border-radius: var(--r-control); cursor: pointer; transition: background .15s, border-color .15s, box-shadow .15s; }
.t1-opt b { font-weight: 600; }
.t1-opt span { font-size: 12px; color: var(--term-muted); }
.t1-opt:hover { border-color: var(--term-text); }
.t1-opt.is-recommended { background: var(--primary); border-color: var(--primary); }
.t1-opt.is-recommended:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
.t1-opt.is-recommended span { color: color-mix(in srgb, #fff 82%, var(--primary)); }
.t1-opt[aria-checked="true"] { box-shadow: 0 0 0 2px var(--term-bg), 0 0 0 4px var(--proposal); }
.t1-custom { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; font-size: 12px; color: var(--term-muted); }
.t1-custom textarea { width: 100%; box-sizing: border-box; min-height: 52px; padding: 6px 8px; font: 12.5px/1.45 var(--font); color: var(--term-text); background: rgb(148 163 184 / 0.08); border: 1px solid var(--term-line); border-radius: var(--r-control); resize: vertical; }
.t1-custom textarea:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.t1-decided { margin: 8px 0 0; font-size: 12px; color: var(--term-muted); }
@media (prefers-reduced-motion: reduce) { .t1-chip[data-state="triaging"] .t1-spark { animation: none; } }
@media (max-width: 760px) {
  .t1-chip-label, .t1-chip-model { display: none; }
  .t1-menu { position: fixed; top: 56px; left: 16px; right: 16px; width: auto; }
}
.df-add { display: block; color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.df-del { display: block; color: color-mix(in srgb, var(--danger) 55%, #fff); background: color-mix(in srgb, var(--danger) 14%, transparent); }
.df-hunk { display: block; color: var(--accent); }
.df-file { display: block; margin-top: 8px; font-weight: 700; color: var(--term-text); }
.df-meta { display: block; color: var(--term-muted); }
@media (max-width: 760px) {
  .rc-steps { order: 3; margin-left: 0; width: 100%; }
  .rc-title { max-width: 100%; }
}

`;
