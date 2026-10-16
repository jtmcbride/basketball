import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.BASKETBALL_ORIGIN ?? 'http://127.0.0.1:5177' },
  webServer: process.env.BASKETBALL_ORIGIN ? undefined : {
    command: 'npm run dev', url: 'http://127.0.0.1:5177', reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1100 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
});
