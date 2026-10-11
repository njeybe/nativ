# taste-skill v2 digest
Condensed from taste-skill v2, github.com/Leonxlnx/taste-skill at commit 717446e, MIT License,
Copyright (c) 2026 Leonxlnx; full text in SKILL.md beside this file.

## Dials
- Baseline VARIANCE 8, MOTION 6, DENSITY 4; infer from the brief via presets (s1.A, s1.B).
- VARIANCE 1-3 symmetric; 4-7 offset; 8-10 asymmetric; 4-10 collapse below 768px (s7).
- MOTION 1-3 hover/active only; 4-7 CSS transform/opacity; 8-10 scroll-driven (s7).
- DENSITY 1-3 py-32+; 4-7 py-16 to py-24; 8-10 1px lines, no cards, font-mono numbers (s7).

## Hard rules
- Italic display words with y g j p q: leading-[1.1] min plus pb-1 (s4.1).
- Max 1 accent, saturation under 80%, locked across the whole page (s4.2).
- One corner-radius system for the page (s4.4).
- CTAs and forms pass WCAG AA; CTA labels one line; one label per intent (s4.5).
- No placeholder-as-label (s4.6).
- Hero fits the viewport: headline max 2 lines, subtext max 20 words, CTA visible (s4.7).
- Hero pt-24 max, 4 text elements max, logo wall below; nav one line, 80px max (s4.7).
- Eyebrows: at most 1 per 3 sections, hero counts (s4.7).
- Each layout family once per page; max 2 image+text zigzags in a row (s4.7).
- Bento: exact cell count, varied rhythm, 2-3 cells with real visuals (s4.7).
- Declare the below-768px fallback in each multi-column component (s4.7).
- Real images: gen tool, then picsum seed, then labeled TODO slots (s4.8).
- Sections: headline 8 words, sub 25 words max; over 5 items needs another UI (s4.9).
- Re-read all visible strings; rewrite broken or AI-cute copy (s4.9).
- Quotes max 3 lines, attribution name + role (s4.10).
- One page theme; sections never invert (s4.11).
- MOTION above 3 honors prefers-reduced-motion; loops collapse to static (s6.B).
- Animate only transform and opacity; design both color modes (s6.A, s6.C).

## Banned patterns
- Defaults: Inter, Fraunces, Instrument_Serif, serif without brand reason (s4.1).
- Mixed-family emphasis in a headline; use italic or bold of the same font (s4.1).
- AI purple glow; beige+brass+espresso for premium consumer unless the brief asks (s4.2).
- Centered hero when VARIANCE is above 4, except manifesto briefs (s4.3).
- Split headers and floating top-right sub-text in section headings (s4.7, s9.F).
- Div-based fake screenshots; text-only heroes; labels under logos (s4.8, s9.E).
- Three equal cards in a row; neon glows; gradient headline text (s9.A, s9.C).
- John Doe, Acme, fake round numbers, filler verbs like Elevate (s9.D, s4.9).
- Hero version labels, section-number eyebrows, 01 / 4 tile pagination (s9.F).
- Scroll cues, decorative status dots, middle-dot chains, locale/weather strips (s9.F).
- Pills on images, photo-credit captions, version footers, stock counters (s9.F).
- Hero-bottom text strips, generic Step 1/2/3 labels, poetic section labels (s9.F).
- Hairlines on every list row; filled-track score bars (s9.F).
- Em dash anywhere; en dash as separator; ranges use a hyphen (s9.G).

## Pre-flight
- [ ] Design read stated and dials reasoned from the brief (s0.B, s1)?
- [ ] Redesign mode detected and audited if relevant (s11)?
- [ ] One accent, one radius system, one theme across the page?
- [ ] Hero fits viewport, pt-24 max, 4 text elements max?
- [ ] Eyebrow count at most ceil(sections / 3)?
- [ ] No duplicate CTA intent, no wrapped CTA?
- [ ] Layout families varied, zigzag cap held, bento cells exact?
- [ ] Real images, no fake screenshots?
- [ ] Copy self-audit done, quotes 3 lines max?
- [ ] Reduced motion handled; MOTION above 4 actually animates?
- [ ] Both color modes tested; no s9.F tells left?

## Read SKILL.md for
- s0 brief inference; s2 and Appendices A-C design system map; s3 stack, icons, deps.
- s5 GSAP skeletons; s8 dark mode; s10 vocabulary; s11 redesign; s13 scope; s14 checks.
