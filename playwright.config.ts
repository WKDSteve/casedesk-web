import { defineConfig } from '@playwright/test';

// The pages, opened from disk (file://). No server: `pnpm build` makes the files first. The system's Chrome is used
// (`channel`), the browser the pages are made for; no Playwright browser has to be installed.
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chrome', use: { channel: 'chrome' } }],
});
