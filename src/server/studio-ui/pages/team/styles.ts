// Team page styles, all scoped under #panel-team. Ink look: no cards, 1px dividers.
export const teamCss = String.raw`#panel-team .page-head h1 { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -.01em; text-wrap: balance; }
#panel-team .page-head p { margin: 4px 0 0; color: var(--fg-2); }
#panel-team .roster { margin-top: 16px; overflow-x: auto; }
#panel-team table { width: 100%; border-collapse: collapse; }
#panel-team th { text-align: left; font-weight: 500; font-size: 12px; color: var(--fg-3); height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
#panel-team td { height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
#panel-team .r { text-align: right; }
#panel-team .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
#panel-team .who { font-weight: 500; }
#panel-team .run-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--run); margin-right: 8px; }
#panel-team .idle { color: var(--fg-3); }
#panel-team .cur { display: inline-flex; gap: 8px; max-width: 360px; padding: 0; border: 0; background: none; color: var(--fg); font: inherit; cursor: pointer; }
#panel-team .cur:hover .ttl { text-decoration: underline; }
#panel-team .ttl { overflow: hidden; text-overflow: ellipsis; color: var(--fg-2); }
#panel-team .empty { margin: 24px 0; color: var(--fg-3); }
#panel-team .defs { margin-top: 24px; }
#panel-team .defs summary { cursor: pointer; color: var(--fg-2); height: 36px; line-height: 36px; }
#panel-team .defs div { display: flex; gap: 16px; height: 36px; align-items: center; border-bottom: 1px solid var(--line); }
#panel-team .defs b { width: 120px; font-weight: 500; }
#panel-team .defs span { color: var(--fg-2); }
@media (max-width: 1023px) { #panel-team .hide-sm { display: none; } }
`;
