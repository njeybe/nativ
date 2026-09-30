// Inline SVG icon paths and status marks shared by the shell and every page.
export const ICON_PATHS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tasks: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  flow: '<rect x="2" y="4" width="6" height="5" rx="1.5"/><rect x="16" y="4" width="6" height="5" rx="1.5"/><rect x="9" y="15" width="6" height="5" rx="1.5"/><path d="M8 6.5h8M5 9v3.5a2.5 2.5 0 0 0 2.5 2.5H9m10-6v3.5a2.5 2.5 0 0 1-2.5 2.5H15"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.5"/><path d="M16 14.2A5 5 0 0 1 22 19"/>',
  worktrees: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 4-6 3-10.5 7.5"/>',
  benchmarks: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-5"/>',
  database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
};

// Done check, up-next dashed ring and stuck alert; running is a pulsing dot.
export const ST_SVG: Record<string, string> = {
  completed:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".15"/><path d="m5 8.2 2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pending:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.5 2"/></svg>',
  blocked:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".15"/><path d="M8 4.5v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.3" r="1" fill="currentColor"/></svg>',
};
