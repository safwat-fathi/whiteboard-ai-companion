import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e-server',
  workers: 1,
  fullyParallel: false,
  webServer: {
    command:
      'NEXT_PUBLIC_API_BASE=http://localhost:4201 pnpm --filter @whiteboard/web exec next dev -p 3201',
    url: 'http://localhost:3201',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://localhost:3201',
    deviceScaleFactor: 1,
  },
})
