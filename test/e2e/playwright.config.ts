import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // The screenshot capture is documentation work, not a gate. It runs only via `npm run screenshots`.
  testIgnore: /\.capture\.ts$/,
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
