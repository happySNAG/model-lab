import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts', 'test/parity/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
