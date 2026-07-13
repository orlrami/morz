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
  retries: 0,
  forbidOnly: !!process.env.CI,
  outputDir: './e2e/.tmp/test-results',
  reporter: [['list']]
})
