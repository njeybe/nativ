// Responsive rules for the kept pages and dialogs.
export const responsiveCss = String.raw`/* Responsive */
@media (max-width: 900px) {
  #runner-console-drawer { inset: auto 0 0 0; }
  .panes { grid-template-columns: 1fr; }
  .summary-banner { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .hero { grid-template-columns: 1fr; }
  .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 820px) {
  table.grid thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  table.grid, table.grid tbody, table.grid tr, table.grid td { display: block; }
  table.grid tr { padding: 10px 16px; border-bottom: 1px solid var(--border); }
  table.grid tbody tr:last-child { border-bottom: none; }
  table.grid td { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; border: none; text-align: right; min-width: 0; }
  table.grid td::before { content: attr(data-label); flex: none; font-size: 12px; color: var(--muted); text-align: left; }
  table.grid tbody tr:hover td { background: none; }
  .path, .cell-sub { max-width: 58vw; }
}
@media (max-width: 640px) {
  .panel-actions, .panel-actions input.input, .panel-actions select.input { width: 100%; max-width: none; }
  .param-grid { grid-template-columns: 1fr; }
  .param-grid .span-2 { grid-column: auto; }
  .record-form-grid { grid-template-columns: 1fr; }
  .diagnostic-banner { flex-direction: column; align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
