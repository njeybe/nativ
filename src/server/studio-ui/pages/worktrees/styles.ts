// Worktrees view styles.
export const worktreesCss = String.raw`/* Worktrees table */
table.grid { width: 100%; border-collapse: collapse; font-size: 13px; }
table.grid th { height: 32px; padding: 0 12px; text-align: left; font-size: 12px; font-weight: 500; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
table.grid th:last-child { text-align: right; }
table.grid td { height: 36px; padding: 0 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.grid code { font-family: var(--mono); font-size: 12px; }
.wt-task { display: flex; align-items: center; gap: 8px; height: 36px; max-width: 320px; }
.wt-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.wt-num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.wt-dot { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--muted); }
.wt-dot[data-tone="ok"] { background: var(--ok); }
.wt-dot[data-tone="err"] { background: var(--danger); }
.wt-dot[data-tone="run"] { background: var(--warn); }
.row-actions { display: flex; justify-content: flex-end; gap: 6px; }

`;
