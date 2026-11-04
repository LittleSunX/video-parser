import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:4178',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run build --workspace frontend && node tests/browser/preview.mjs',
    url: 'http://127.0.0.1:4178',
    reuseExistingServer: false,
    env: { VITE_API_BASE_URL: '' },
    timeout: 60_000,
  },
})
