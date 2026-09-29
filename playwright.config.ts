import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: [
    'browser.spec.mjs',
    'node-tests.browser.mjs',
    'upstream.browser.mjs',
    'miaospeed.browser.mjs',
    'lan-http.browser.mjs',
  ],
  outputDir: '.cache/browser-results',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3210',
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'narrow', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'node tests/browser-server.mjs',
    url: 'http://127.0.0.1:3210/healthz',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
