# Morz — Phase 0 Design Brief

> **Role:** You are the Phase 0 lead designer for **Morz** — a Windows-first desktop command center for teams of AI coding CLIs. Your output is a high-fidelity coded prototype (Electron + React shell) that locks the visual language before any real code is written. This brief is complete; do not ask for clarification. Execute it.

---

## Skills to invoke (in order, before anything else)

1. `/ui-ux-pro-max` — style selection, palette reasoning, typography, spacing, motion
2. `/frontend-design` — Anthropic aesthetic direction, distinctive design choices
3. `/huashu-design` — HTML prototype structure, animation staging, interaction patterns

---

## Product feel

**Cozy dark command center.** Discord's comfortable all-day dark shell + mission-control density where the fleet lives. A tool a developer lives in for hours and still enjoys.

**Rounded, soft shell; crisp, dense data.** Panels, cards, sidebar, buttons: rounded and warm. Terminal, DAG, diffs, tables, agent pills: tight and crisp for precision.

**Control philosophy:** "Assist, don't take over." Morz is a dial you reach for, never an autopilot. Three modes always available: Manual / Assisted / Orchestrated. Nothing auto-spawns. Everything is opt-in, scoped, reversible, visible.

---

## Tech stack (confirmed)

| Layer | Choice |
|-------|--------|
| Shell | Electron (Main + dedicated PTY-host) |
| UI framework | React + TypeScript |
| Terminal | xterm.js + WebGL addon |
| Editor | CodeMirror 6 |
| Layout/splits | dockview (splits, tabs, popout windows) |
| Styling | Tailwind CSS v4 + shadcn/ui **(Luma style)** |
| Icons | **Tabler Icons** |
| Motion | **Framer Motion** (Emil Kowalski / motion-primitives patterns) |

---

## shadcn/ui setup — preset `b3Z4dPIdAO`

```bash
pnpm dlx shadcn@latest init --preset b3Z4dPIdAO
```

**What the preset gives you:**
- Style: **Luma** (modern, clean shadcn variant)
- Heading font: **Geist**
- Body font: **Noto Sans**
- Icon library: **Tabler Icons**
- Border radius: **Medium**
- Chart color: **Amber**

The preset's `:root` defaults are light/neutral. Override the `.dark` block entirely with Morz tokens (see §Color palette below).

### shadcn CSS var override — `src/styles/shadcn-theme.css`

```css
/* Morz dark theme — maps warm graphite palette to shadcn CSS vars */
/* Override the preset's .dark block entirely */
.dark {
  --background:         oklch(0.17 0.012 70);   /* #26241E graphite page */
  --foreground:         oklch(0.93 0.015 80);   /* #EEE6D9 quartz text */

  --card:               oklch(0.20 0.012 70);   /* #2E2B24 panel */
  --card-foreground:    oklch(0.93 0.015 80);

  --popover:            oklch(0.25 0.013 70);   /* #37332B raised */
  --popover-foreground: oklch(0.93 0.015 80);

  --primary:            oklch(0.73 0.11 75);    /* #CBA25A bronze */
  --primary-foreground: oklch(0.17 0.012 70);

  --secondary:          oklch(0.25 0.013 70);   /* #37332B card */
  --secondary-foreground: oklch(0.93 0.015 80);

  --muted:              oklch(0.20 0.012 70);
  --muted-foreground:   oklch(0.60 0.010 75);   /* dimmed quartz */

  --accent:             oklch(0.25 0.013 70);
  --accent-foreground:  oklch(0.93 0.015 80);

  --destructive:        oklch(0.577 0.245 27);  /* #EF4444 error red */

  --border:             oklch(1 0 0 / 8%);
  --input:              oklch(1 0 0 / 12%);
  --ring:               oklch(0.73 0.11 75);    /* bronze focus ring */

  /* Amber chart scale (matches preset chart color = Amber) */
  --chart-1:            oklch(0.879 0.169 91);  /* yellow-amber */
  --chart-2:            oklch(0.769 0.188 70);
  --chart-3:            oklch(0.666 0.179 58);
  --chart-4:            oklch(0.555 0.163 49);
  --chart-5:            oklch(0.440 0.137 46);  /* deep amber */

  --sidebar:            oklch(0.17 0.012 70);
  --sidebar-foreground: oklch(0.93 0.015 80);
  --sidebar-primary:    oklch(0.73 0.11 75);    /* bronze */
  --sidebar-primary-foreground: oklch(0.17 0.012 70);
  --sidebar-accent:     oklch(0.25 0.013 70);
  --sidebar-accent-foreground: oklch(0.93 0.015 80);
  --sidebar-border:     oklch(1 0 0 / 8%);
}
```

> Design tip: `oklch(0.17 0.012 70)` = warm graphite dark; the chroma (0.012) is low but present — gives the "not-cold-dark" feel. Quartz at `oklch(0.93 0.015 80)` has warm undertone. Bronze at `oklch(0.73 0.11 75)` is the sole high-chroma color.

---

## Color palette (locked — user approved)

### Design tokens

```ts
export const colors = {
  // Surfaces
  page:      '#26241E',   // graphite base — page background
  panel:     '#2E2B24',   // panel, card, sidebar
  card:      '#37332B',   // raised card, hover bg, active surface

  // Neutrals
  quartz:    '#EEE6D9',   // primary text, labels, active surfaces
  quartzDim: 'rgba(238,230,217,0.45)',  // secondary text, placeholders

  // Brand + interactive
  bronze:    '#CBA25A',   // buttons, links, focus, brand
  bronzeHot: '#E4BC77',   // hover, active bronze

  // Status semantic (pills, rings — context-separated from bronze)
  working:   '#3B82F6',   // blue — in progress
  blocked:   '#F59E0B',   // amber — needs you
  done:      '#22C55E',   // green — complete
  error:     '#EF4444',   // red — failed
  warning:   '#F97316',   // orange — caution

  // Per-agent identity tints (pane border, sidebar dot, DAG node)
  agentClaude:   '#FB923C',   // orange
  agentCodex:    '#2DD4BF',   // teal-green
  agentGemini:   '#60A5FA',   // blue
  agentOpenCode: '#A78BFA',   // violet
} as const
```

### Core rule

Neutrals carry structure. Color carries meaning. Chroma appears only where it means something. The only high-chroma default element is bronze. Status colors appear on pills and rings, never as large fills. Agent tints are borders/dots/small indicators — not backgrounds.

---

## Typography

Fonts are confirmed by preset `b3Z4dPIdAO`. No substitution.

| Role | Font | Weight | Size range |
|------|------|--------|------------|
| Display / App title | **Geist** | 700 | 32–48px |
| Section heading | **Geist** | 600 | 18–24px |
| UI label / button | **Geist** | 500 | 12–14px |
| Body / paragraph | **Noto Sans** | 400 | 14–15px |
| Muted / metadata | **Noto Sans** | 400 | 11–12px |
| Terminal / code | **JetBrains Mono** or **Geist Mono** | 400 | 13–14px |

Base text color: `#EEE6D9` (quartz). Scale: quartz full → `quartzDim` (45% alpha) → `oklch(1 0 0 / 25%)` for ghost labels.

---

## Iconography

**Tabler Icons** (from preset). Stroke-based, 24×24 baseline, stroke-width 1.5.

- Navigation + sidebar: 20px
- Action buttons: 16px
- Agent pills / status dots: 14px
- Terminal toolbar: 16px

Import pattern:
```tsx
import { IconTerminal2, IconBolt, IconGitBranch } from '@tabler/icons-react'
```

Do not mix Lucide or Heroicons. Tabler only.

---

## Motion system — Emil Kowalski / motion-primitives

All interactive elements use **Framer Motion** with spring physics. Reference: [motion-primitives.com](https://motion-primitives.com), Emil Kowalski's animation principles.

### Spring presets

```ts
export const springs = {
  // Micro-interactions: badge count, dot pulse, status ring
  snappy: { type: 'spring', stiffness: 400, damping: 30 },

  // Panel open/close, sidebar expand, drawer
  panel:  { type: 'spring', stiffness: 260, damping: 24 },

  // Layout morphing, tab indicator, active pill slide
  layout: { type: 'spring', stiffness: 200, damping: 22 },

  // Floating elements, command palette
  float:  { type: 'spring', stiffness: 300, damping: 28 },
} as const
```

### Animation patterns (required)

| Element | Pattern |
|---------|---------|
| Agent pill entering fleet | `AnimatePresence` + `layoutId` slide-in from right, stagger 50ms per pill |
| Status ring on blocked agent | Pulse: `scale 1 → 1.25 → 1`, amber ring, repeat |
| Command palette (cmd-K) | Backdrop blur fade + panel spring-down from top |
| Pane split/close | `layout` spring on sibling panels redistributing width |
| Sidebar expand/collapse | `layout` spring on content area, icon stays anchored |
| Notification toast | Slide in from bottom-right, spring-in, auto-dismiss with shrink |
| Tab indicator | `layoutId="tab-indicator"` sliding underline/pill |
| Hover on bronze button | `whileHover={{ scale: 1.02 }}` snappy spring + bronze glow |
| File explorer pop-in | AnimatePresence opacity + x-translate, panel spring |
| DAG node appear | Stagger 30ms per node, fade + scale from 0.9 |

### Stagger pattern

```tsx
const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } }
}
const item = {
  hidden: { opacity: 0, y: 8 },
  show:   { opacity: 1, y: 0, transition: springs.panel }
}
```

---

## Surfaces to design (Phase 0 scope)

Design all of these as coded React components in the prototype:

### Priority 1 — minimum exit criteria for Phase 0

1. **Shell layout** — full window frame, menu bar, drag region
2. **Spaces sidebar** — project, agent list with status pills, model badge, CLI badge, branch, state
3. **Agent pill-bar + lanes** — horizontal strip of active agents, color-coded per identity tint, status ring
4. **Terminal pane with command blocks** — xterm.js area, per-command block (cmd / output / exit / cwd / time)
5. **Orchestrator side panel** — live blackboard, NL input, spawn plan preview

### Priority 2 — before Phase 1 coding starts

6. **Pop-in/out file explorer** — dockview popout style
7. **LazyGit-style commit UX** — unstaged/staged split, stage hunks, commit message
8. **Reviewer panel** — inline gutter comments + findings list
9. **cmd-K command palette** — fuzzy search, typed filters (`agent:` `skill:` `spawn:`)
10. **Dependency DAG view** — wave execution graph, nodes color by agent tint

### Priority 3 — reference screens (can be static)

11. **Remote mobile mission-control** — portrait phone view, fleet status, approve/deny
12. **Notifications** — blocked/done/error toasts, push ring on sidebar dot
13. **Settings / theme importer** — base16 / VS Code / Ghostty theme import

---

## Design constraints

- **Always dark.** No light mode. The `.dark` class is permanent.
- **Windows-first.** Title bar is custom (draggable Electron), not native. Scrollbars use Tailwind scrollbar plugin styling.
- **Density balance.** Sidebar and header are generous (comfortable). Terminal and DAG are dense. Never collapse them into one feel.
- **Bronze is the only CTA color.** Status colors only on status. Agent tints only on identity indicators. Never use them as general UI accent.
- **Framer Motion, not CSS transitions.** All interactive motion uses spring presets above.
- **No placeholder UI.** Every component must use the locked tokens. No gray-600 or generic Tailwind defaults.
- **Tabler Icons only.** No Lucide, Heroicons, or others.

---

## Reference design board

Claude Design project: `713058c0-a6ec-4147-9002-b92c59420c4e`
File: `Morz Design Board.dc.html`

The board contains the locked palette, UI element samples, desktop shell mockup, and phone mission-control concept. Use it as the visual north star for all component decisions.

---

## Definition of done (Phase 0 exit)

- [ ] All Priority 1 surfaces coded in React with real tokens
- [ ] shadcn preset installed: `pnpm dlx shadcn@latest init --preset b3Z4dPIdAO`
- [ ] `shadcn-theme.css` override applied — warm graphite palette active
- [ ] Geist + Noto Sans loaded and applied per role table
- [ ] All Framer Motion spring presets implemented
- [ ] All Tabler Icons replacing any placeholders
- [ ] Agent tints visible on pill-bar and sidebar dots
- [ ] Status semantic colors visible on pills/rings
- [ ] Command palette (cmd-K) animated and functional
- [ ] User approves the prototype → Phase 1 coding begins
