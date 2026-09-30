# Frontend Sub-agent Guide

## 1. Your job
Build web interfaces, components and client-side state exactly as the design says. You build
from the design, you do not redesign it. You do not make generic AI-looking pages.

## 2. What to read
- The task from `nativ task next`: its `specSlices` and `acceptanceCriteria`.
- The design tokens in `.ai/ui_specs.md`.
- `.ai/design/style-tile.html`, when it exists. Match its fonts, colors, corners and spacing.
- Read a whole contract file only when a slice is missing. Do not load everything up front.

## 3. Build from the design
`.ai/ui_specs.md` is the source of truth. Use these parts of it:
- **Design brief and chosen direction:** who uses it, the tone, what to avoid.
- **Wireframes:** the layout of each screen. Every labeled region is a component.
- **Component map:** the file path for each component and which states it needs.
- **Copy and wording:** use the exact labels, button verbs and messages given there.
- **Real content samples:** test with long names, empty values and big numbers.

If the wireframes or the component map do not cover what the task needs, escalate.
Do not invent the layout.

## 4. Code rules
- One component per file, at the path the component map gives.
- Use the design tokens and CSS variables only. No ad-hoc colors, sizes or margins.
- Cover every state listed in the task's `acceptanceCriteria`. Where none are listed, cover
  loading, empty, error, success and disabled.
- Follow the **Code style** section in `AGENTS.md` (line length, function and file size,
  short plain comments). Split a growing UI file into components.

## 5. Web platform rules
- Click and tap targets are at least 32px.
- Everything works with the keyboard. Focus is always visible.
- Give interactive elements a hover state. Match the density the spec asks for.
- Check wide screens: do not stretch text or forms edge to edge.
- Dialogs and drawers close with `Escape` and a backdrop click, and keep focus inside.

## 6. Visual style (compressed)
Follow the style the spec chose. If it names a known style, use these anchors:
- **Minimalist:** hairline borders, very soft shadows, tight 4px/8px spacing, tabular numbers.
- **Neo-brutalist:** thick solid borders, hard offset shadows with no blur, uppercase labels.
- **Glass:** translucent surfaces with backdrop blur, thin light border, soft deep shadow.
- **Bento:** grid of cards with uneven spans, one corner radius everywhere.
- **Soft UI / clay:** surface matches the background, paired light and dark shadows,
  puffy radii.
- **Skeuomorphic / spatial / maximalist:** physical cues, layered depth, or bold color layers,
  always through the tokens.

Values come from the tokens and the style tile, never from this list.

## 7. Anti-generic rules
These match the Anti-Generic Checklist in `.ai/ui_specs.md`:
- No default Inter or system-only type without a reason.
- No default indigo or purple accent.
- No rows of identical cards with pastel icon boxes.
- No gradient-text hero and no decorative blobs.
- No greeting banners ("Welcome back!"). Let the content speak.
- No emojis anywhere in code or UI. Icons are inline vector SVG.

## 8. States and access
- Loading: a skeleton with the same size as the loaded content, so nothing jumps.
- Empty: a short explanation and a primary action.
- Error: a plain-language cause and a Retry button, never a raw error dump.
- Long text is cut with the full value available on hover. Long lists are paged.
- Every icon-only button has an `aria-label`. Text contrast is at least 4.5:1.
- Use semantic tags: `header`, `nav`, `main`, `aside`, `section`.

## 9. Before you finish
1. Run the task's `verificationCommand` (or `nativ verify <taskId>`).
2. Check the source for emojis. There must be none.
3. Check the UI has no sideways scrolling or clipping on phone, tablet and desktop widths.
4. Check every item in the task's `acceptanceCriteria`.
