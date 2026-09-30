// Benchmarks view styles.
export const benchmarksCss = String.raw`/* Benchmarks */
.hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px 32px; padding: 22px; margin-bottom: 16px; transition: opacity .2s; }
.hero.is-running { opacity: .6; }
.eyebrow { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.hero-value { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 40px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hero-value .badge { font-size: 12px; letter-spacing: 0; }
.hero-meta { margin: 0; font-size: 13.5px; color: var(--muted); }
.hero-stats { display: grid; grid-template-columns: repeat(4, minmax(96px, auto)); gap: 4px 28px; margin: 0; }
.hero-stats dt { font-size: 12.5px; color: var(--muted); }
.hero-stats dd { margin: 0; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.scenario-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.scenario { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 16px; }
.scenario.is-idle { box-shadow: none; border-style: dashed; }
.scenario-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.scenario-head h3 { margin: 0; font-size: 14.5px; font-weight: 600; }
.scenario-sub { margin: -6px 0 0; font-size: 13px; color: var(--muted); }
.scenario p { margin: 0; font-size: 13.5px; line-height: 1.5; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.metric-v { display: block; font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.metric-l { display: block; font-size: 12px; color: var(--muted); }
.details { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; padding-top: 10px; font-size: 12.5px; border-top: 1px solid var(--border); }
.details dt { color: var(--muted); }
.details dd { margin: 0; text-align: right; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.details .wide { grid-column: 1 / -1; }
.details dd.wide { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; text-align: left; }
.details dd.wide .chip { font-size: 11px; }
.scenario-errors { margin: 0; padding: 8px 10px 8px 26px; font-size: 12.5px; color: var(--danger); background: var(--danger-bg); border: 1px solid var(--danger-line); border-radius: var(--r-control); }

`;
