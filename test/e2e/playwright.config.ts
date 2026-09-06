import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
