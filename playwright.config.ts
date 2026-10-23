import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

export default defineConfig({
  testDir: './tests',

  // Sign-in round-trips the employee's tenant and role set before the landing
  // page renders, and the commodity dashboard aggregates warehouse data server
  // side. Both are slow enough that the default 30s is not workable.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30 * 1000 },

  // No retries and no parallelism, on purpose. This suite submits real stock
  // records to Bauchi production - a retry would re-submit the shipment and
  // create duplicates, and parallel workers would race the same campaign.
  retries: 0,
  workers: 1,
  fullyParallel: false,

  // Refuse to run if someone leaves a .only in a spec.
  forbidOnly: true,

  outputDir: 'artifacts/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'artifacts/report', open: 'never' }],
  ],

  use: {
    baseURL: process.env.HCM_WEB_URL,
    headless: process.env.HEADED !== '1',

    // Everything needed to work out what happened, without re-running a flow
    // that writes to production.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    actionTimeout: 30 * 1000,
    navigationTimeout: 120 * 1000,

    viewport: { width: 1600, height: 1000 },

    // The workbench-ui is served over https with a normal certificate; this is
    // only here so a proxied or UAT host with a self-signed cert does not need
    // a config change.
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
