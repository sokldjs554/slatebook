import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3100);

/**
 * e2e: 실제 브라우저로 실제 서버(가짜 PG)와 실제 PostgreSQL 을 사용한다.
 *   E2E_DATABASE_URL  테스트가 비우고 다시 채우는 전용 DB (이름에 e2e 가 들어 있어야 한다 — 안전장치)
 * 서버는 이미 떠 있으면 재사용하고, 없으면 `next start` 로 띄운다 (먼저 `npm run build`).
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {} } },
  ],
  webServer: {
    command: `npx next start -p ${port}`,
    url: `http://127.0.0.1:${port}/api/demo/users`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
