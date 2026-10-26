import { defineConfig, devices } from '@playwright/test';

// Which suite to run: acceptance | hazards | maintenance (set by support/run-suite.sh).
const SUITE = process.env.SUITE ?? 'acceptance';
const RUN_ID = process.env.RUN_ID ?? 'local';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = process.env.PW_OUT ?? `./results/${RUN_ID}/${SUITE}`;

export default defineConfig({
  testDir: `./${SUITE}/tests`,
  testMatch: /\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: `${OUT}/artifacts`,
  reporter: [['list'], ['json', { outputFile: `${OUT}/report.json` }]],
  use: {
    baseURL: BASE_URL,
    // The app and the browser both run in UTC so "today" in the UI equals the UTC date the tests compute.
    timezoneId: 'UTC',
    locale: 'en-US',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
