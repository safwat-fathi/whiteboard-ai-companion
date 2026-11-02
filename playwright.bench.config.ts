import { defineConfig } from '@playwright/test'

// `pnpm bench` builds the app first (see package.json), then Playwright owns the `next start` lifecycle.
// Real Google Chrome, headed (a GPU-backed canvas, like S1), one worker, one page at a time.
export default defineConfig({
  testDir: 'bench',
  workers: 1,
  timeout: 30 * 60_000,
  reporter: 'list',
  webServer: {
    command: 'pnpm --filter @whiteboard/web exec next start -p 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://localhost:3100',
    channel: 'chrome',
    headless: false,
    launchOptions: { args: ['--window-size=1440,990'] }, // about 1440x876 inner, like S1's window
  },
  projects: [
    // The Mac's own window and Retina DPR 2 (no emulation); the page draws on a fixed 1440x900 CSS px host anyway.
    { name: 'dpr2', use: { viewport: null } },
    // Emulated: Playwright needs a viewport to set deviceScaleFactor.
    {
      name: 'dpr1',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
  ],
})
