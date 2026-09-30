# Flutter Developer Sub-agent Guide

## 1. Your job
Build mobile screens, widgets, app state and API calls exactly as the design says. You build
from the design, you do not redesign it. You do not make generic default-looking apps.

## 2. What to read
- The task from `nativ task next`: its `specSlices` and `acceptanceCriteria`.
- The design tokens in `.ai/ui_specs.md`.
- `.ai/design/style-tile.html`, when it exists. Match its fonts, colors, corners and spacing.
- `.ai/api_contracts.json` for the endpoints the task calls. Read a whole contract file only
  when a slice is missing. Do not load everything up front.

## 3. Build from the design
`.ai/ui_specs.md` is the source of truth. Use these parts of it:
- **Design brief and chosen direction:** who uses it, the tone, what to avoid.
- **Wireframes:** the layout of each screen. Every labeled region is a widget.
- **Component map:** the file path for each widget and which states it needs.
- **Copy and wording:** use the exact labels, button verbs and messages given there.
- **Real content samples:** test with long names, empty values and big numbers.

- **Semantic Component Trees:** when a screen uses one, build the same nesting and layout
  notes (stacks, grids, split views). Each node is a widget.
- **Mutation States:** for every create, update or delete, build the behavior the spec gives
  (optimistic or inline spinner, disabled submit, rollback on failure).
- **Contextual Typography:** use the `textTheme` role the spec names for each place.

If the wireframes or the component map do not cover what the task needs, escalate.
Do not invent the layout.

## 4. Tokens and theme
- Map every token to `ThemeData` (`colorScheme`, `textTheme`) or to a `ThemeExtension`
  (status colors, radii, shadows, spacing). Use the mapping in `.ai/ui_specs.md`.
- Read values with `Theme.of(context)` or the extension. No ad-hoc colors, sizes or fonts
  inside widgets.
- Follow the design language the spec chose: Material 3, Cupertino or custom. Do not mix.
- Set the theme once, for light and dark, and let widgets inherit it.

## 5. Code rules
- One widget per file, at the path the component map gives.
- Cover every state listed in the task's `acceptanceCriteria`. Where none are listed, cover
  loading, empty, error, success and disabled.
- Keep screens thin. State and data calls live outside the widget tree.
- Follow the **Code style** section in `AGENTS.md` (line length, function and file size,
  short plain comments). Split a growing UI file into widgets.

## 6. Mobile platform rules
- Touch targets are at least 48dp.
- Put the main actions where a thumb reaches: the lower part of the screen.
- One main action per screen. Make it the most visible control.
- Use a bottom navigation bar for the top-level places and a bottom sheet for short tasks.
- The system back gesture must work on every screen. Ask before dropping unsaved input.
- Respect safe areas (notch, home bar) and the keyboard. A focused field stays visible.
- Check small phones, large phones and tablets, in both orientations where the spec allows.

## 7. Anti-generic rules
These match the Anti-Generic Checklist in `.ai/ui_specs.md`:
- No default Material seed blue, and no unthemed default widgets, without a reason.
- No default type without a reason. Use the fonts in the style tile.
- No rows of identical cards with pastel icon boxes.
- No gradient-text hero and no decorative blobs.
- No greeting banners ("Welcome back!"). Let the content speak.
- No emojis anywhere in code or UI. Use icons from the icon set the spec names.

## 8. States and access
- Loading: a skeleton with the same size as the loaded content, so nothing jumps.
- Empty: a short explanation and a primary action.
- Error: a plain-language cause and a Retry button, never a raw error dump.
- Offline: say so, show saved data when there is any, and retry when the network returns.
- Slow network: show progress, allow cancel, and never freeze the screen.
- Permission denied: explain why it is needed and offer a link to the system settings.
- Long text is cut with an ellipsis. Long lists are built lazily and paged.
- Every icon-only button has a `Semantics` label. Text contrast is at least 4.5:1.
- Text follows the system font scale without clipping.

- Mutations: disable the submit while it runs and show progress next to it.
  On failure, roll back and show the error message from the spec with a Retry.

## 9. Before you finish
1. Run the task's `verificationCommand`, plus `flutter analyze` and `flutter test`.
2. Check the source for emojis. There must be none.
3. Check the UI has no overflow stripes on small and large screens.
4. Check every item in the task's `acceptanceCriteria`.
