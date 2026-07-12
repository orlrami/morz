# Morz — Design Direction (spec)

*Approved 2026-07-10. Feeds the build plan (`MORZ-Build-Plan.md`) and the implementation plan.*

---

## 1. Product feel

**Cozy dark command center.** Discord's comfortable, all-day dark shell + mission-control density where the fleet lives. A tool a developer lives in for hours and still enjoys.

**Rounded, soft shell; crisp, dense data.** Panels, cards, sidebar, buttons are rounded and warm. Data-heavy areas — terminal, dependency DAG, diffs, tables, agent pills — stay tighter and crisper for precision.

---

## 2. Visual language (locked — user approved)

**Palette**
- **Base:** warm **graphite** — medium-dark, "graphite gray, clearer but not super dark" (not near-black). `#26241E` page · `#2E2B24` panel · `#37332B` raised/card.
- **Neutral/light:** **quartz** (warm pale cream) — primary text, active surfaces, highlights, and the general roundness/softness. `#EEE6D9`.
- **Brand + interactive:** **bronze/gold** — buttons, links, focus, the orchestrator. Soft glow on primary. `#CBA25A → #E4BC77`.

**Core rule:** *neutrals carry structure; color carries meaning.* Chroma appears only where it means something.

**Status color language** (on pills/rings, context-separated from bronze):
`working = blue` · `blocked/needs-you = amber` · `done = green` · `error = red` · `warning = orange`.

**Per-agent identity tint** (subtle): Claude = orange · Codex = teal-green · agy/Gemini = blue · OpenCode = violet. Shows on pane border, sidebar dot, DAG node so you recognize each CLI at a glance.

**Type:** warm humanist UI face (TBD — currently system default; pick a distinctive non-Inter/Roboto face), monospace for all terminal/code. Quartz is the text color.

**Deliverable:** Claude Design board (project `713058c0-a6ec-4147-9002-b92c59420c4e`) — palette, UI elements, desktop shell, phone mission-control.

**Still needs work (user-flagged):** the mobile/iPhone app UI and the overall UI need real refinement passes; pick the UI font. User will supply reference images of in-app screens before we build.

---

## 3. Control philosophy (locked — the product's soul)

**"Assist, don't take over."** Morz is easy to use *and* gives developers deep control. Explicitly **not** BridgeMind's everything-auto-magic that runs your whole space. The orchestrator is a **dial you reach for**, never an autopilot that grabs your workflow.

**Graduated autonomy — three modes, always available, chosen per task:**

| Mode | You do | Morz does |
|------|--------|-----------|
| **Manual** | Launch/run CLIs yourself, one by one | Nothing unasked — a great terminal. Full control. |
| **Assisted** | Drive; launch your own agents | Routes, auto-hands-off between the CLIs *you* launched, suggests. Does **not** spawn on its own. |
| **Orchestrated** | Delegate a goal ("run an 8-agent team") | Proposes a plan → **you approve** → spawns, **scoped to what you pointed it at**. |

**Non-negotiable rules (apply to every automation feature):**
- **Opt-in, not default-on** — nothing auto-spawns or auto-takes-over; orchestration is invoked, not ambient.
- **Scoped, not global** — acts only on the space/task you aim it at, never your whole environment.
- **Reversible + visible** — see, stop, override anything.
- **Low-magic** — controls are exposed and configurable. Easy surface, deep controls.

**Consequence for the build:** Manual mode is a first-class path, not an afterthought. The orchestrator, routing, auto-handoff, watchdog, scheduled agents, and remote steering all default **off/opt-in**, scoped, and reversible. This reshapes Phase 2 — orchestration is a capability you switch on, not the app's baseline.

---

## 4. Next steps

1. Confirm the control philosophy framing (§3).
2. Generate the implementation plan (design-first: Phase 0 = visual/UI, then build), honoring the control dial.
3. User supplies reference images of in-app screens → refine the UI/mobile designs → begin building.
