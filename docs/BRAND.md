# Morz — Brand & Design System v1.0

Canonical domain: **morz.dev** · Social: **@morzdev**

> A signal moves through the system, but the developer decides where it goes.

## What's here

The interactive brand guide is the master reference:
`Morz Brand and Design System.dc.html` (project root) — logo system, color, type,
iconography, product design system + a hi-fi workspace screen, motion, web/social,
the full copy library, and the decision log.

## Package structure

```
Morz-Brand/
├── 00-Brand-Guide/            → see root .dc.html (interactive)
├── 01-Logo/
│   ├── SVG/                   primary lockups + signal glyph variants
│   └── Monochrome/            one-color black / white / graphite / quartz
├── 02-App-Icons/              dark · light · gold (512, rounded)
├── 03-Favicons/               color + monochrome browser icon
├── 04-Color/                  morz-tokens.css (CSS variables)
├── 05-Typography/  06-Iconography/  07-Motion/  08-Social/
├── 09-Web/  10-Product-Design-System/  11-Presentations/  12-Press-Kit/
├── 13-Templates/  14-Copy-and-Messaging/  15-Source-Files/
```

## The Morz Signal — geometry

Single stroke, viewBox `0 0 104 76`:
`M15 37 C31 37 30 57 47 57 C64 57 66 33 90 30` · stroke-width 13 · round caps.
Point: `cx 52 cy 13 r 7.5`. The mark works fully in one color — gold is optional.

## Export instructions

- **PNG / WebP** — render each SVG at 16·20·24·32·48·64·128·256·512·1024·2048 px with
  transparent padding. Verify the gold point survives at 16px.
- **.ico** — pack 16/24/32/48/256 from `03-Favicons/morz-favicon.svg`.
- **.icns / PWA maskable** — from `02-App-Icons`, keep the glyph inside the 80% safe area.
- **PDF / EPS vector** — export the SVGs directly from any vector editor.
- **Wordmark** — set in Quicksand 600; **convert to outlines** before distributing lockups
  so the file renders without the font installed.
- **Motion** — Lottie / MP4 / WebM from the three-beat sting (flow → arrive → resolve),
  ~1.4s, with a reduced-motion cross-fade fallback.

## Fonts (open-source, SIL OFL — do not redistribute binaries)
UI/brand **Hanken Grotesk** · code/terminal **JetBrains Mono** · wordmark **Quicksand**.

## Naming
`morz-<asset>-<variant>.<ext>` — e.g. `morz-logo-primary-dark.svg`,
`morz-signal-accent.svg`, `morz-app-icon-1024.png`. No `final-final-2`.
