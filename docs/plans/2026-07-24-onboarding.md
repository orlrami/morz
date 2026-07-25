# First-Run Onboarding Implementation Plan

**Goal:** Build the Wave 15 onboarding configure screen with detection, persistence, live preview, minimal skip, and Settings re-entry.

**Architecture:** A shared typed contract feeds a validated SQLite service and sandboxed preload bridge. A Zustand renderer store hydrates `App`, drives the configure screen, and exposes the saved module map to the current shell until the Wave 15 module store is integrated.

**Tech Stack:** Electron 32, React 18, TypeScript, Zustand, better-sqlite3, Tailwind 4, Playwright Electron E2E.

**Estimated Tasks:** 4

---

### Task 1: First-run behavior contract

**Files:**
- Create: `e2e/first-run.spec.ts`
- Create: `src/shared/modules.ts`
- Create: `src/shared/onboarding.ts`

**Step 1: Write the failing E2E cases**

Add tests that launch fresh isolated app data and assert:

```typescript
await expect(page.getByRole('heading', { name: 'Make Morz yours' })).toBeVisible()
await page.getByRole('button', { name: /Skip/ }).click()
await expect(page.getByRole('tab', { name: 'Terminals' })).toBeVisible()
```

Add separate cases for reactive preview, saved module visibility after relaunch, and Settings re-entry.

**Step 2: Verify failure**

Run:

```powershell
npx.cmd playwright test e2e/first-run.spec.ts
```

Expected: FAIL because the configure screen does not exist.

**Step 3: Define exact shared contracts**

Create the Agent 1-compatible `ModuleId`, `ModuleDef`, and `MODULES` exports. Define `OnboardingSnapshot`, target/model/slot constants, safe defaults, IPC channels, and `MorzOnboardingApi`.

**Step 4: Verify types**

Run:

```powershell
npm.cmd run typecheck
```

Expected: PASS because the new contracts are not wired yet.

### Task 2: Validated persistence and CLI detection

**Files:**
- Create: `src/main/services/onboarding.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Add the SQLite service**

Create a single-row `onboarding_settings` table in `%APPDATA%\Morz\morz.db`, plus:

```typescript
export function registerOnboardingIpc(): void
```

Handle `onboarding:get`, `onboarding:detect`, and `onboarding:save`.

**Step 2: Add safe PATH probes**

Resolve all nine executables without a shell, run `--version` with a five-second timeout and bounded output, and sanitize the first non-empty line.

**Step 3: Validate saves**

Rebuild the snapshot from allowlisted module IDs, slot providers, modes, and string limits. Persist in a transaction and return the normalized snapshot.

**Step 4: Expose the preload bridge**

Expose only:

```typescript
window.morzOnboarding.get()
window.morzOnboarding.detect()
window.morzOnboarding.save(snapshot)
```

**Step 5: Verify types**

Run `npm.cmd run typecheck`.

Expected: PASS.

### Task 3: Configure screen and shell integration

**Files:**
- Create: `src/renderer/src/store/onboardingStore.ts`
- Create: `src/renderer/src/components/OnboardingScreen.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/components/Shell.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`

**Step 1: Hydrate before shell mount**

`App` shows a token-based loading surface, then mounts `OnboardingScreen` when `completed === false`.

**Step 2: Implement the controlled form**

Render all detection rows, module toggles, slots, autonomy cards, and footer actions using only `tokens.ts` colors and existing font variables.

**Step 3: Implement the live preview**

Derive rail/tabs and launch lines directly from form state. Toggling orchestration must add a `Waves` preview tab synchronously.

**Step 4: Persist Open and Skip**

Open saves current state and updates `modeStore`. Skip saves `MINIMAL_ONBOARDING`.

**Step 5: Wire Settings re-entry**

Add `Run setup again` under Settings → Connections. It dispatches the store re-entry action without clearing persisted completion.

**Step 6: Gate current Shell surfaces**

Filter optional tabs and panel mounts by the saved module map; hide and unmount the Orchestrator affordance when orchestration is disabled.

**Step 7: Verify targeted E2E**

Build, then run:

```powershell
npx.cmd playwright test e2e/first-run.spec.ts
```

Expected: all onboarding cases pass.

### Task 4: Final verification

**Files:**
- Review all changed files.

**Step 1: Run typecheck**

Run `npm.cmd run typecheck`.

Expected: exit 0.

**Step 2: Run production build**

Run `npm.cmd run build`.

Expected: exit 0.

**Step 3: Run the required spec**

Run `npx.cmd playwright test e2e/first-run.spec.ts`.

Expected: all tests pass.

**Step 4: Inspect the final diff**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Expected: only onboarding slice files, no whitespace errors, no secrets or generated build output.

