import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 240000,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true, // Subagent style running
    video: 'on',
  },
  // Fail the build on CI if you accidentally left test.only in the source code.
  forbidOnly: !!process.env.CI,
});
