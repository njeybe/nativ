// Shape of one Studio page module; the shell reads these from pages/index.ts.
export interface PageModule {
  id: string;
  group: 'now' | 'project' | 'system';
  label: string;
  /** Inner SVG markup for a 24-unit viewBox (stroke icon). */
  icon: string;
  /** Styles scoped under #panel-<id>. */
  css: string;
  /** Client script; the shell wraps it in its own function scope and passes Studio. */
  script: string;
  /** Static markup placed inside the page panel before the first paint. */
  markup?: string;
}
