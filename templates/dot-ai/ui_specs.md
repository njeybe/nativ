# UI/UX Specifications & Layout Design

## 1. System Identity & Visual Design Style
- **System Domain Archetype:** Developer Mission Control / Analytical Workbench / Workflow Pipeline / Creative Canvas
- **Design Style Archetype:** Modern Minimalist / Neo-Brutalism / Glassmorphism / Bento Grid / Neumorphism / Claymorphism / Skeuomorphism / Spatial UI
- **Zero-Emoji Mandate:** Strictly enforced. All visual iconography must be precision vector SVGs aligned to the stroke and geometry of the chosen style. Never use Unicode emojis.

---

## 2. Design Tokens & CSS Variables
Define explicit CSS variables for the chosen style to avoid ad-hoc hardcoded values:

```css
:root {
  /* Surface & Canvas */
  --bg-canvas: #f8fafc;
  --surface: #ffffff;
  --surface-hover: #f1f5f9;
  --border-subtle: #e2e8f0;
  --border-hover: #cbd5e1;

  /* Typography & Contrast */
  --text-primary: #0f172a;
  --text-secondary: #64748b;
  --text-muted: #94a3b8;

  /* Brand & Accents */
  --brand: #4f46e5;
  --brand-hover: #4338ca;
  --brand-surface: #eef2ff;

  /* Status Colors */
  --status-success: #059669;
  --status-success-bg: #ecfdf5;
  --status-warning: #d97706;
  --status-warning-bg: #fffbeb;
  --status-danger: #e11d48;
  --status-danger-bg: #fff1f2;
  --status-info: #0284c7;
  --status-info-bg: #f0f9ff;

  /* Elevation & Geometry (Adjust by Design Style) */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.08);
}
```

---

## 3. Layout Structure & Navigation Hierarchy
- **Navigation Modality:** Vertical Pinned Sidebar (240px) or Top App Bar depending on application density.
- **Content Area:** Fluid layout, max-width bounded, responsive grid/flex partitions.
- **Docked Telemetry Drawer:** Collapsible bottom drawer for live logs, streaming output, or contextual diff inspections.

---

## 4. The 5 UI States Matrix
Every component and view must implement all five states:

| State | Visual & Interactive Requirement |
| :--- | :--- |
| **Default / Populated** | Crisp typography, tabular alignment for metrics, subtle hover feedback. |
| **Empty State** | Meaningful vector SVG illustration, clear explanatory text, primary CTA button. |
| **Loading / Skeleton** | Shimmer pulse cards matching the exact dimensions of loaded content (zero CLS). |
| **Error / Degraded** | Actionable error alert card with an inline "Retry" action and non-cryptic diagnosis. |
| **Overflow / Truncated** | Ellipsis truncation with full-value tooltips; pagination or virtual scrolling for >20 items. |

---

## 5. Interaction Ergonomics & Accessibility
- **Micro-Transitions:** `transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);`.
- **Active Click State:** `transform: scale(0.98)` (or brutalist `translate(2px, 2px)`).
- **Focus Rings:** `:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }`.
- **Dialogs & Drawers:** Dismissible via `Escape` key and backdrop click; background scroll locking.
- **Accessible Labels:** `aria-label` required on all icon-only buttons.
