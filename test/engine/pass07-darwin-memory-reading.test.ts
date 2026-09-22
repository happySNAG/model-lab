// Pass 7 · the memory guard measures memory that is ACTUALLY AVAILABLE, not Mach's free list.
//
// THE INCIDENT. A 616-attempt campaign aborted at `memory.free: free memory 2.8%, floor 5.0%` on a
// Mac mini with 32 GiB, roughly 15 GiB of it immediately reclaimable, and no memory pressure at all
// — `memory_pressure` reported the system 89% free in the same second. `os.freemem()` returns Mach's
// "pages free" and nothing else, and on Darwin that list is kept near empty BY DESIGN, because the
// kernel parks reusable pages on the inactive list instead of returning them to it.
//
// The floor was never the problem and is not what changed. These tests hold the correction to its
// claim: the reading is fixed, the floor is untouched, and no other platform moved.

import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import { availableMemoryBytes } from '../../src/engine/machine';
import { DEFAULT_GUARD_POLICY, evaluateGuards, guardPolicyForEndpoint } from '../../src/engine/guards';

describe('Pass 7 · available memory on Darwin', () => {
  it('reports at least what os.freemem() reports, and never less', async () => {
    // The correction may only ever ADD reclaimable pages to the figure. A reading that came back
    // smaller than the free list would mean the parse had gone wrong in the one direction a floor
    // cannot tolerate.
    expect(await availableMemoryBytes()).toBeGreaterThanOrEqual(os.freemem());
  });

  it('never claims more memory than the machine has', async () => {
    // The guard rail on the other side. Double-counting purgeable pages — which are already carried
    // within the active and inactive lists — is the obvious way to overstate this, and overstating
    // available memory is how a floor stops protecting anything.
    expect(await availableMemoryBytes()).toBeLessThanOrEqual(os.totalmem());
  });

  it('leaves every other platform on os.freemem()', async () => {
    if (process.platform === 'darwin') return;
    expect(await availableMemoryBytes()).toBe(os.freemem());
  });

  it('did NOT lower the floor it was blamed for tripping', () => {
    // Stated as a test because it is the whole ethical content of the change: the campaign was
    // failing a 5% floor, and the fix must not be "make the floor 2%".
    expect(DEFAULT_GUARD_POLICY.minimumFreeMemoryMilli).toBe(50);
    expect(guardPolicyForEndpoint('http://127.0.0.1:11434').minimumFreeMemoryMilli).toBe(50);
  });

  it('still BREACHES when memory really is short', () => {
    // The correction must not have turned the guard off. A machine genuinely down to 2% available
    // has to abort exactly as before — the reading changed, not the judgement.
    const verdict = evaluateGuards(
      guardPolicyForEndpoint('http://127.0.0.1:11434'),
      {
        freeDiskBytes: 500 * 1024 ** 3,
        swapUsedBytes: 0,
        freeMemoryBytes: Math.floor(0.02 * 32 * 1024 ** 3),
        totalMemoryBytes: 32 * 1024 ** 3,
        listeners: { '11434': 1 },
        modelStoreListingDigest: 'd',
        modelStoreCount: 1,
      },
      { listingDigest: 'd', count: 1 },
      '2026-09-20T00:00:00Z',
    );
    expect(verdict.breaches.some((breach) => breach.guardID === 'memory.free')).toBe(true);
  });
});
