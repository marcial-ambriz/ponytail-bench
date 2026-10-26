import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = process.env.PW_OUT ?? './results/local';

/** Shared by acceptance/, hazards/ and maintenance/ (each passes its own test dir through PW_TEST_DIR). */
export default defineConfig({
  testDir: process.env.PW_TEST_DIR ?? './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: `${OUT}/artifacts`,
  reporter: [['list'], ['json', { outputFile: `${OUT}/report.json` }]],
  use: {
    baseURL: BASE_URL,
    timezoneId: 'UTC',
    locale: 'en-US',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
