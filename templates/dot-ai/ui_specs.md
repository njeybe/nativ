# UI/UX Specifications

Plain language, concise. The Architect fills this in; workers follow it. Tasks point at a component with a specRef such as `ui_specs.md#appointment-list`.

---

## Planning Level
Pick one and write it here: **Level: Quick | Standard | Full**

- **Quick:** small fix, fast-path task, no design phase.
- **Standard:** new screen in an existing design. Flow + wireframe + component map. Reuse existing tokens.
- **Full:** new app, new platform or redesign. Discovery questions, brief, flows, two directions with style tiles, wireframes, component map.

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
ASCII box-drawing, max 80 columns. Label each region `<ComponentName>`. One desktop wireframe per key screen, plus mobile for the primary screen. Use real content. No HTML mockups.

```
+--------------------------------------------------+
| <AppHeader>  Clinic Dela Cruz          [Sign out] |
+----------+---------------------------------------+
| <SideNav>| <AppointmentList>                      |
| Today    | 09:00  Maria Concepcion-Villanueva     |
| Patients | 09:30  (no name given)                 |
+----------+---------------------------------------+
```

---

## Component Map

| Region | Component | File path | States | Section |
| :--- | :--- | :--- | :--- | :--- |
| | | | | [appointment-list](#appointment-list) |

### appointment-list
Example component section. One per component: purpose, data, states, behavior. Keep the heading anchor stable.

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
- [ ] No default Inter or system-only type without a reason.
- [ ] No default indigo/purple accent.
- [ ] No rows of identical cards with pastel icon boxes.
- [ ] No gradient-text hero.
- [ ] No decorative blobs.
- [ ] No greeting banners.
- [ ] No emojis. Icons are vector SVG.

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
| **Mobile only** | Offline, slow connection, permission denied. |

---

## Accessibility
- **Transitions:** `transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);`
- **Active state:** `transform: scale(0.98)`.
- **Focus rings:** `:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }`
- **Dialogs and drawers:** close with `Escape` and backdrop click; lock background scroll.
- **Labels:** `aria-label` on every icon-only button.
