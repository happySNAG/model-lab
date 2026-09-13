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
    include: ['test/unit/**/*.test.ts', 'test/parity/**/*.test.ts', 'test/engine/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    /**
     * The engine's tests are DISK-bound, not CPU-bound, and that is by design.
     *
     * The ledger fsyncs every terminal row before the runner is allowed to move on — that is the
     * durability guarantee the whole campaign rests on — so a campaign test is a few hundred
     * fsyncs. Running one per core turns that into a few thousand concurrent fsyncs against a single
     * volume, which starves the reporter's own IPC and produces an `onTaskUpdate` RPC timeout
     * alongside a fully passing run.
     *
     * Capping the workers is the fix rather than loosening the fsyncs: the fsyncs are the thing
     * being tested. Two keeps the reporter responsive even on the slowest volume this repository is
     * checked out on (an external USB disk), and leaves the suite well inside its time budget.
     */
    maxWorkers: 2,
    minWorkers: 1,
  },
});
