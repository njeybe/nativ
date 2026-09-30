import type { PageModule } from '../pages/types.js';

// Startup: pages register, the first view opens, data loads and the live stream connects.
export function bootScript(pages: PageModule[]): string {
  const order = JSON.stringify(pages.map((p) => ({ id: p.id, group: p.group, label: p.label, icon: p.icon })));
  return String.raw`  // ─── Boot ──────────────────────────────────────────────────────────────────
  Studio.order = ${order};
  setView(Studio.resolveHash(location.hash, pageIds()));
  fetchPipeline(ALL_PARTS);
  connectEvents();
})();
</script>
</body>
</html>`;
}
