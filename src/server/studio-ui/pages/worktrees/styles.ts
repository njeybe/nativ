// Worktrees view styles.
export const worktreesCss = String.raw`/* Agent worktrees */
.wt-card { overflow: hidden; }
table.grid { width: 100%; border-collapse: collapse; font-size: 13.5px; }
table.grid th { padding: 10px 16px; text-align: left; font-size: 12.5px; font-weight: 600; color: var(--muted); background: var(--bg); border-bottom: 1px solid var(--border); white-space: nowrap; }
table.grid th:last-child { text-align: right; }
table.grid td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.grid tbody tr:last-child td { border-bottom: none; }
table.grid tbody tr:hover td { background: var(--bg); }
table.grid code { font-size: 12.5px; }
.cell-sub { max-width: 280px; margin-top: 2px; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.path { display: inline-block; max-width: 260px; vertical-align: bottom; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-actions { display: flex; justify-content: flex-end; gap: 6px; }

`;
