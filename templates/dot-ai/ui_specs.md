# UI/UX Specifications

Plain language, concise. The Architect fills this in; workers follow it. Tasks point at a component with a specRef such as `ui_specs.md#appointment-list`.

---

## Planning Level
Pick one level and design track and write them here:
- **Level:** Quick | Standard | Full
- **Track:** Experience-First (Outside-In) | Data-First (Inside-Out)

- **Quick:** small fix, fast-path task, no design phase.
- **Standard:** new screen in an existing design. Flow + wireframe or component tree + component map. Reuse existing tokens.
- **Full:** new app, new platform or redesign. Discovery questions, brief, flows, two directions with style tiles, wireframes or component trees, component map.

- **Experience-First (Outside-In):** UI flows and screen data needs drive API contracts and DB schema.
- **Data-First (Inside-Out):** Core database schema or pipeline models drive API contracts and UI views.

---

## Design Brief
- **Who uses it:**
- **The job they are doing:**
- **Tone (three words):**
- **Things to avoid:**

---

## Users & Top Tasks
Top 3-5 user tasks and how often each happens.

| Task | Frequency |
| :--- | :--- |
| | |

---

## Real Content Samples
Real sample data per screen, drawn from `db_schema.json` and `api_contracts.json`. Include extremes: long names, empty values, big numbers. Never "Item 1" or lorem ipsum.

---

## User Flows
Each key journey step by step, with tap/click counts.

1. Journey name (N taps)
   1. Step
   2. Step

---

## Design Directions
Exactly two directions.

- **Direction A:**
- **Direction B:**
- **Chosen and why:**
- **Full level only:** style tile at `.ai/design/style-tile.html`

---

## Design Tokens
Placeholders the Architect fills, each with a one-line rationale. Do not copy a default palette.

```css
:root {
  /* Surface & canvas */
  --bg-canvas: <value>;        /* why */
  --surface: <value>;          /* why */
  --surface-hover: <value>;    /* why */
  --border-subtle: <value>;    /* why */
  --border-hover: <value>;     /* why */

  /* Typography & contrast */
  --text-primary: <value>;     /* why */
  --text-secondary: <value>;   /* why */
  --text-muted: <value>;       /* why */

  /* Brand & accents */
  --brand: <value>;            /* why */
  --brand-hover: <value>;      /* why */
  --brand-surface: <value>;    /* why */

  /* Status */
  --status-success: <value>;     --status-success-bg: <value>;
  --status-warning: <value>;     --status-warning-bg: <value>;
  --status-danger: <value>;      --status-danger-bg: <value>;
  --status-info: <value>;        --status-info-bg: <value>;

  /* Geometry & elevation */
  --radius-sm: <value>;  --radius-md: <value>;  --radius-lg: <value>;
  --shadow-sm: <value>;  --shadow-md: <value>;
}
```

**Flutter mapping:** each token maps to a `ThemeData` field (`colorScheme`, `textTheme`) or a `ThemeExtension` (status colors, radii, shadows). List the mapping here.

| Token | Flutter target |
| :--- | :--- |
| `--brand` | `colorScheme.primary` |
| `--status-*` | `ThemeExtension` |

---

## Platform Rules
- **Primary platform (designed first):**
- **Web:** sidebar or top bar, density, keyboard support, hover states, targets at least 32px, behavior on wide screens.
- **Mobile:** bottom nav and sheets, back gesture, one main action per screen, thumb reach, targets at least 48dp, offline / slow / permission-denied states, safe areas and keyboard.
- **Mobile design language (choose explicitly):** Material 3 | Cupertino | custom.

---

## Wireframes
Choose the format that best communicates the layout:
1. **ASCII Box Art:** Max 80 columns. Best for mobile screens, simple CRUD lists, and master-detail views.
2. **Semantic Component Tree:** Indented hierarchy with layout annotations (e.g. grid, split-view, v-stack, h-stack). Best for dense dashboards, data tables, and responsive multi-column web views.

Label each region `<ComponentName>`. One desktop wireframe per key screen, plus mobile for the primary screen. Use real content. No HTML mockups.

```
+--------------------------------------------------+
| <AppHeader>  Clinic Dela Cruz          [Sign out] |
+----------+---------------------------------------+
| <SideNav>| <AppointmentList>                      |
| Today    | 09:00  Maria Concepcion-Villanueva     |
| Patients | 09:30  (no name given)                 |
+----------+---------------------------------------+
```

Or Semantic Component Tree:
```yaml
Screen: AppointmentDashboard (Desktop 1280px+)
Layout: SplitView (sidebar: 240px, content: 1fr)
Tree:
- <AppSidebar (sticky, h-full)>:
    - <ClinicBrandHeader title="Clinic Dela Cruz">
    - <NavMenu active="today" items=["Today", "Patients"]>
- <MainContainer (v-stack, gap-6, p-6)>:
    - <AppointmentFilterBar (h-stack, justify-between)>
    - <AppointmentList (v-stack, gap-3)>:
        - Columns: [Time, PatientName, StatusBadge, ActionButtons]
```

---

## Component Map

| Region | Component | File path | States | Section |
| :--- | :--- | :--- | :--- | :--- |
| | | | | [appointment-list](#appointment-list) |

### appointment-list
Example component section. One per component: purpose, data, states, mutations, behavior. Keep the heading anchor stable.
- **Purpose:** Display upcoming patient appointments with instant check-in.
- **Data:** `Appointment[]` from `api_contracts.json#GET /appointments`.
- **States:** Loading skeleton (3 rows), Empty (prompt to book), Error (inline retry).
- **Mutations:**
  - *Check in:* Inline button spinner -> optimistic status badge change to Checked In.
  - *Cancel:* Confirm dialog -> optimistic remove. On error: rollback item with error toast.

---

## Copy & Wording
- **UI language(s):** e.g. English / Filipino
- **Key labels:**
- **Button verbs (domain words):**
- **Empty-state text:**
- **Error messages (plain language):**

---

## Signature Moments
One or two. Everything else stays restrained.

---

## Anti-Generic Checklist
**Web**
- [ ] No unconsidered font defaults. Consumer/brand: distinct curated typeface (e.g. Outfit, Plus Jakarta Sans, DM Sans). Data-dense B2B SaaS/utility: Inter, Roboto, or native system type permitted for density and zero-FOIT. No unstyled browser defaults without a reason.
- [ ] No default indigo/purple accent.
- [ ] No rows of identical cards with pastel icon boxes.
- [ ] No gradient-text hero.
- [ ] No decorative blobs.
- [ ] No greeting banners.
- [ ] No emojis. Icons are vector SVG.
- [ ] No serif by default. A serif needs a stated reason (editorial, heritage) in the brief.
- [ ] One font family, unless the tokens define a heading and body pairing.
- [ ] No purple or blue glow gradients and no neon mesh backgrounds unless the brief asks.
- [ ] No warm beige with brass accents as the automatic "premium" look. Pick it only on purpose.
- [ ] One accent color and one palette temperature (warm or cool grays, not both).
- [ ] One corner-radius scale for every surface.

**Marketing pages** (landing, product and pricing pages)
- [ ] The hero fits the first screen: headline of at most 2 lines, subtext of about 20 words, the main button visible without scrolling.
- [ ] The hero holds at most 4 things: an optional small label, headline, subtext, buttons (one primary, at most one secondary). Logo walls go in their own section below.
- [ ] No more than 2 image-and-text split sections in a row.
- [ ] Small uppercase labels above headings: at most one for every 3 sections.
- [ ] Each section layout (3-column cards, split, bento) appears once per page.
- [ ] Real images and real vector logos. No mock screenshots built from boxes, no text-only page.
- [ ] Sections stay short: a headline of about 8 words, about 25 words of text, one visual or one button. More than 5 items need a grid, tabs or a carousel.
- [ ] Every figure comes from real data or is marked as a sample.
- [ ] One label per action across the page ("Contact us" everywhere, not three variants).

**Mobile**
- [ ] No default Material seed blue.
- [ ] No unthemed default widgets without a reason.
- [ ] No emojis.

---

## States
Every component and view covers these.

| State | Requirement |
| :--- | :--- |
| **Loading** | Skeleton matching loaded dimensions. |
| **Empty** | Short explanation and a primary action. |
| **Error** | Plain diagnosis with a Retry action. |
| **Success** | Clear confirmation. |
| **Disabled** | Visibly inactive, with a reason where useful. |
| **Mutation / Action** | Behavior during Create/Update/Delete (optimistic vs inline spinner, disabled submit, rollback on failure). |
| **Mobile only** | Offline, slow connection, permission denied. |

---

## Accessibility
- **Transitions:** `transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);`
- **Active state:** `transform: scale(0.98)`.
- **Focus rings:** `:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }`
- **Dialogs and drawers:** close with `Escape` and backdrop click; lock background scroll.
- **Labels:** `aria-label` on every icon-only button.
