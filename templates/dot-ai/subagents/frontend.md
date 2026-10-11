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
For Standard or Full work that renders a page or screen, state in one line what you build:
"Reading this as: [page kind] for [audience], in the [chosen direction] style."
Take it from the design brief, the chosen direction and the style tile. If they do not
settle it, escalate with `architectural_ambiguity`. Do not guess a direction.
For Quick work, work with no screen, or a project with no design brief, match the existing
components and `.ai/codebase_map.md` instead.

## 2.6 Design profiles
Read `## Design Profile` in `.ai/ui_specs.md` first.
If the Profile is missing or still the placeholder, stop and escalate with
`architectural_ambiguity` before writing UI code.

Profiles are `taste-v1` or `taste-v2`. Read the digest at
`.ai/design/taste/<v1|v2>/DIGEST.md`. Open `SKILL.md` beside it only for a
section the digest points to.

Order of authority, highest first:
1. The task's `acceptanceCriteria`.
2. `.ai/ui_specs.md` (tokens, wireframes, copy).
3. The digest.
4. `SKILL.md`.

The settled conflicts below override the digest and `SKILL.md`. The digest is a faithful copy
of upstream, so it may say things nativ overrides, such as "generate images first".
1. Questions: never ask the user. Escalate with `architectural_ambiguity`.
2. The design read and dials are set in the Design Profile. Do not change them. If values
   are missing, that is a spec gap: escalate.
3. Dependencies: a library the profile needs that is not in `package.json` is installed only
   when `package.json` is in your targetFiles. Otherwise escalate with `dependency_conflict`.
   Never import a package that is not installed.
4. Icons: use the icon library named in Stack notes. Do not hand-draw SVG icons.
5. Images: the spec decides imagery. Never call image generation yourself. Leave a labeled
   placeholder and list the missing images in your report.
6. Colors and fonts come from the Design Tokens. A token that breaks a profile rule is a
   spec gap: escalate, do not fix it in code.
7. Emojis are banned under every profile. Only the spec can allow them.
8. Under `taste-v2`, no em dash or en dash as a separator in any text users see. Use a
   hyphen or rewrite the sentence.
9. Run Lighthouse and Core Web Vitals only when the task's `verificationCommand` does.

Stack notes:
- React 18: `motion` (from `motion/react`) and `framer-motion` share one API and work on
  React 18 and 19. Keep the one installed. Do not migrate packages in a feature task.
- Server Component rules apply only when Stack notes say Next.js App Router. In a
  client-only React app skip them, but keep motion in small memoized leaf components.
- Tailwind: follow the installed major version. Never mix v3 and v4 syntax.
- `next/font` is for Next.js only. Elsewhere self-host fonts with `@font-face` and
  `font-display: swap`.

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

## 6. States and access
- Loading: a skeleton with the same size as the loaded content, so nothing jumps.
- Empty: a short explanation and a primary action.
- Error: a plain-language cause and a Retry button, never a raw error dump.
- Long text is cut with the full value available on hover. Long lists are paged.
- Every icon-only button has an `aria-label`. Text contrast is at least 4.5:1.
- Use semantic tags: `header`, `nav`, `main`, `aside`, `section`.

- Mutations: disable the submit while it runs and show progress next to it.
  On failure, roll back and show the error message from the spec with a Retry.

## 7. Before you finish
1. Run the task's `verificationCommand` (or `nativ verify <taskId>`).
2. Check the source for emojis. There must be none.
3. Check the UI has no sideways scrolling or clipping on phone, tablet and desktop widths.
4. Check every item in the task's `acceptanceCriteria`.
5. Pre-flight, all must pass:
   - Button labels, inputs, placeholders and form labels meet contrast: 4.5:1 for body
     text, 3:1 for large text.
   - Re-read every string you wrote that the spec did not give. Rewrite anything vague,
     broken or invented.
6. Run the Pre-flight in the profile's DIGEST.md.
7. Run `nativ design check <your UI files or folders>`. Fix every error. Fix each warning, or
   explain it in your report. It reads the Design Profile in `.ai/ui_specs.md`.
