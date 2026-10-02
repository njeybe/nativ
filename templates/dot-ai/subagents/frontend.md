# Frontend Sub-agent Guide

## 1. Your job
Build web interfaces, components and client-side state exactly as the design says. You build
from the design, you do not redesign it. You do not make generic AI-looking pages.

## 2. What to read
- The task from `nativ task next`: its `specSlices` and `acceptanceCriteria`.
- The design tokens in `.ai/ui_specs.md`.
- `.ai/design/style-tile.html`, when it exists. Match its fonts, colors, corners and spacing.
- Read a whole contract file only when a slice is missing. Do not load everything up front.

## 2.5 Design read (before coding)
Before writing any code, state in one line what you are building:
"Reading this as: [page kind] for [audience], in the [chosen direction] style."
Take it from the design brief, the chosen direction and the style tile. If they do not
settle it, escalate with `architectural_ambiguity`. Do not guess a direction.

## 3. Build from the design
`.ai/ui_specs.md` is the source of truth. Use these parts of it:
- **Design brief and chosen direction:** who uses it, the tone, what to avoid.
- **Wireframes:** the layout of each screen. Every labeled region is a component.
  It may be ASCII box art or a Semantic Component Tree. Build from either.
- **Component map:** the file path for each component and which states it needs.
- **Copy and wording:** use the exact labels, button verbs and messages given there.
- **Real content samples:** test with long names, empty values and big numbers.

- **Semantic Component Trees:** when a screen uses one, build the same nesting and layout
  notes (grid, split-view, stacks). Each node is a component.
- **Mutation States:** for every create, update or delete, build the behavior the spec gives
  (optimistic or inline spinner, disabled submit, rollback on failure).
- **Contextual Typography:** use the type role the spec names for each place, not one size.

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

### 7.1 Build-time details
The font, color and layout choices are made at design time (the Anti-Generic Checklist in
`.ai/ui_specs.md`). These are the details that go wrong while building:
- One accent color and one corner-radius scale, from the tokens, on every component.
  A button or link that needs a different color is a spec gap: escalate it.
- Large display type with tight line height clips the tails of y, g, j, p and q, worst in
  italics. Keep display line height at 1.1 or more.
- Images come from the spec. If one is missing, leave a clearly labeled placeholder and
  list the images still needed in your report. Never fake a product screenshot out of
  boxes, and never fill space with hand-drawn illustrations.
- Logos are real vector files, never a company name typed out as text.
- Numbers shown in the UI come from the spec's content samples or real data. Do not
  invent precise-looking figures such as "92%" or "4.1x".
- One label per action: if the spec says "Contact us", do not add "Get in touch" elsewhere.
- Marketing or landing page: also follow the Marketing pages part of the checklist.

## 8. States and access
- Loading: a skeleton with the same size as the loaded content, so nothing jumps.
- Empty: a short explanation and a primary action.
- Error: a plain-language cause and a Retry button, never a raw error dump.
- Long text is cut with the full value available on hover. Long lists are paged.
- Every icon-only button has an `aria-label`. Text contrast is at least 4.5:1.
- Use semantic tags: `header`, `nav`, `main`, `aside`, `section`.

- Mutations: disable the submit while it runs and show progress next to it.
  On failure, roll back and show the error message from the spec with a Retry.

## 9. Before you finish
1. Run the task's `verificationCommand` (or `nativ verify <taskId>`).
2. Check the source for emojis. There must be none.
3. Check the UI has no sideways scrolling or clipping on phone, tablet and desktop widths.
4. Check every item in the task's `acceptanceCriteria`.
5. Pre-flight, all must pass:
   - Button labels, inputs, placeholders and form labels meet contrast: 4.5:1 for body
     text, 3:1 for large text.
   - Button labels fit on one line at desktop width.
   - The accent color and corner radius are the same everywhere.
   - Re-read every string you wrote that the spec did not give. Rewrite anything vague,
     broken or invented.
   - Marketing or landing page: run the Marketing pages checks in the checklist.
