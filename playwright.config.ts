import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: 'npm run start:mock',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      PORT: '3100',
      PAIRING_CODE: 'current-e2e-only',
      SONOS_DATA_DIR: '/tmp/current-e2e-data',
      SOUNDCLOUD_CLIENT_ID: '',
      SOUNDCLOUD_CLIENT_SECRET: '',
      SOUNDCLOUD_REDIRECT_URI: '',
    },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
