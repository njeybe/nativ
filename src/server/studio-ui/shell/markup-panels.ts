import type { PageModule } from '../pages/types.js';
import { escapeHtml } from '../document.js';

// One hidden section per registered page; the shell fills them on first paint.
export function markupPanels(pages: PageModule[]): string {
  return pages
    .map(
      (p) =>
        `  <section class="page-view" id="panel-${p.id}" aria-label="${escapeHtml(p.label)}" hidden>\n${p.markup ?? ''}  </section>\n`,
    )
    .join('');
}
