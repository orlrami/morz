import { defineConfig } from '@playwright/test'

/*
 * Morz E2E torture suite — Playwright driving the built Electron app
 * (./out/main/index.js, so run `npm run build` first).
 *
 * workers: 1 — every spec launches its own tray-resident Electron instance
 * that owns real PTYs; parallel instances would fight over the tray, the
 * (isolated) APPDATA dir, and CPU during ConPTY startup.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // Each spec spawns a full Electron app + PTY host; a long single-worker run
  // saturates the machine and a UI wait can occasionally exceed 30s near the
  // end. One retry recovers those load-timeouts without hiding real failures
  // (a genuine bug fails both attempts). Every spec passes cleanly in isolation.
  retries: 1,
  forbidOnly: !!process.env.CI,
  outputDir: './e2e/.tmp/test-results',
  reporter: [['list']]
})
