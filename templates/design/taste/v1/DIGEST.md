# taste-skill v1 digest
Condensed from taste-skill v1, github.com/Leonxlnx/taste-skill at commit 717446e, MIT License,
Copyright (c) 2026 Leonxlnx; full text in SKILL.md beside this file.

## Dials
- Baseline VARIANCE 8, MOTION 6, DENSITY 4; the user's explicit request overrides (s1).
- VARIANCE 1-3 symmetric grids; 4-7 offset overlaps, mixed ratios; 8-10 masonry, fr grids (s6).
- VARIANCE 4-10: collapse to single column (w-full px-4 py-8) below 768px (s6).
- MOTION 1-3 hover/active only; 4-7 CSS transitions on transform/opacity; 8-10 Motion hooks (s6).
- DENSITY 1-3 airy; 4-7 normal app spacing; 8-10 1px lines, no cards, font-mono numbers (s6).

## Hard rules
- Check package.json before importing any library; print the install command if missing (s2).
- React/Next RSC default; motion lives in isolated 'use client' leaf components (s2).
- Tailwind for styling; match the installed version; v4 uses @tailwindcss/postcss (s2).
- Contain layouts with max-w-[1400px] mx-auto or max-w-7xl; CSS Grid, never flex calc math (s2).
- Icons from @phosphor-icons/react or @radix-ui/react-icons, one strokeWidth globally (s2).
- Headlines text-4xl md:text-6xl tracking-tighter leading-none; body max-w-[65ch] (s3).
- No serif on dashboards or software UI; use Geist + Geist Mono or Satoshi + JetBrains Mono (s3).
- Max 1 accent, saturation under 80%, neutral Zinc/Slate base, one gray family (s3).
- VARIANCE above 4: no centered hero; split screen or asymmetric layout (s3).
- Cards only when elevation shows hierarchy; tint shadows to the background (s3).
- Build loading skeletons, empty states, inline errors, :active push feedback (s3).
- Forms: label above input, helper text in markup, error below, gap-2 (s3).
- Never useState for magnetic or continuous motion; use useMotionValue/useTransform (s4).
- Spring physics (stiffness 100, damping 20) on interactive elements; no linear easing (s4).
- Stagger list reveals; parent and children in the same client tree (s4).
- Animate only transform and opacity; grain only on fixed pointer-events-none layers (s5).
- z-index only for systemic layers (nav, modal, overlay) (s5).
- Never mix GSAP/Three.js with Framer Motion in one tree; clean up useEffect (s8).
- SaaS dashboards and feature sections use the Bento 2.0 motion-engine paradigm: perpetual,
  memoized, isolated micro-animations and labels below cards (s9).

## Banned patterns
- Visual: neon/outer glows, oversaturated accents, gradient text on big headers (s7).
- AI purple/blue glow aesthetic and neon gradients (s3).
- Type: Inter, screaming oversized H1s, serif outside creative/editorial work (s7).
- Layout: three equal cards in a row; awkward gaps or floating elements (s7).
- Content: John Doe names, egg avatars, fake round numbers, Acme/Nexus names (s7).
- Copy: filler verbs like Elevate, Seamless, Unleash, Next-Gen (s7).
- Assets: Unsplash links (use picsum.photos/seed), default-state shadcn/ui (s7).

## Pre-flight
- [ ] Global state only to avoid deep prop drilling?
- [ ] Mobile collapse guaranteed for high-variance layouts?
- [ ] useEffect animations have strict cleanup?
- [ ] Empty, loading and error states provided?
- [ ] Cards omitted in favor of spacing where possible?
- [ ] CPU-heavy perpetual animations isolated in their own client components?
- [ ] One accent, one gray family, no AI purple?
- [ ] No centered hero when VARIANCE is above 4?

## Read SKILL.md for
- s4: Liquid Glass refraction, magnetic buttons, layout transitions.
- s8: creative arsenal vocabulary (hero, nav, grids, cards, scroll, media, text).
- s9: Bento 2.0 palette, surfaces, animation engine and the 5 card archetypes.
- s10: the full original pre-flight list.
