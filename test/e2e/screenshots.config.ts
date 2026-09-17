// A config of its own, so the capture never runs as part of the gate.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /screenshots\.capture\.ts$/,
  timeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
});
