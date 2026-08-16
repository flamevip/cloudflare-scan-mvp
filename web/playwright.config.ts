import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// This Windows workspace stores downloaded executables with filesystem compression that
// Chrome cannot read reliably; local runs use the installed Chrome channel. CI uses the
// Playwright-managed Chromium installed by the workflow.
const localBrowser = process.platform === 'win32' && !process.env.CI ? { channel: 'chrome' as const } : {};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: process.env.CI ? 4 : 2,
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js build --config web/vite.config.ts && node node_modules/vite/bin/vite.js preview --config web/vite.config.ts --host 127.0.0.1',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...localBrowser } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...localBrowser } },
  ],
});
