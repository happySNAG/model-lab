// Benchmark engine · the safety guards, enforced independently of the thing they are guarding.
// A port of the proven `safety_monitor_v2.py`, with the same posture: measure, then judge.
//
// WHY THIS IS SEPARATE FROM THE RUNNER. A guard that lives inside the loop it protects can be
// skipped by the same bug that breaks the loop. Every probe here is a pure function of an injected
// reading, so the guards can be tested exhaustively without a single request reaching any server,
// and the runner cannot quietly opt out of one.
//
// EVERY GUARD RETURNS A MEASUREMENT ALONGSIDE ITS VERDICT — so an abort report can say
// "free 12.41 GiB, floor 15.00 GiB" rather than "disk guard failed".

import { CanonicalValue } from './canonical';

export const GIB = 1024 ** 3;

/** The floors in force. These are bound into the frozen manifest, so loosening one is visible. */
export interface GuardPolicy {
  minimumFreeDiskBytes: number;
  maximumSwapUsedBytes: number;
  /** Free memory as a fraction of total, in thousandths — integer-scaled so it can be canonically encoded. */
  minimumFreeMemoryMilli: number;
  /** The port the benchmark is permitted to talk to. Work anywhere else is a breach. */
  benchmarkPort: number;
  /** Ports that must have no listener while the benchmark runs. */
  portsThatMustBeQuiet: number[];
  /** The production listener that must still be held by the same process it was at freeze time. */
  productionListener?: { port: number; pid: number };
}

/**
 * The reference policy. `benchmarkPort` is the isolated lane a dedicated benchmark host serves on,
 * and `portsThatMustBeQuiet` is empty here because which other lanes must be silent is a property of
 * the machine, not of the product — a caller that has one says so explicitly.
 */
export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  minimumFreeDiskBytes: 15 * GIB,
  maximumSwapUsedBytes: 8 * GIB,
  minimumFreeMemoryMilli: 50,
  benchmarkPort: 11436,
  portsThatMustBeQuiet: [11435],
};

/** What the machine actually reports. Injected, never read inside a verdict function. */
export interface SystemReading {
  freeDiskBytes: number;
  swapUsedBytes: number;
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** port -> pid of whatever holds it; absent means nothing is listening. */
  listeners: Record<string, number>;
  /** The model store as the runtime lists it, for the drift check. */
  modelStoreListingDigest: string;
  modelStoreCount: number;
}

export interface GuardMeasurement {
  guardID: string;
  /** Plain language, for the abort report and the terminal. */
  statement: string;
  passed: boolean;
  observed: CanonicalValue;
  floor: CanonicalValue;
}

export interface GuardVerdict {
  allPassed: boolean;
  breaches: GuardMeasurement[];
  measurements: GuardMeasurement[];
  checkedAt: string;
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(2)} GiB`;
}

export interface StoreBaseline { listingDigest: string; count: number }

/**
 * Run every guard against one reading. Pure: the same reading always produces the same verdict,
 * which is what makes the abort reproducible from the recorded measurements alone.
 */
export function evaluateGuards(policy: GuardPolicy, reading: SystemReading, baseline: StoreBaseline | undefined, checkedAt: string): GuardVerdict {
  const measurements: GuardMeasurement[] = [];

  measurements.push({
    guardID: 'disk.freeSpace',
    statement: `free ${gib(reading.freeDiskBytes)}, floor ${gib(policy.minimumFreeDiskBytes)}`,
    passed: reading.freeDiskBytes >= policy.minimumFreeDiskBytes,
    observed: reading.freeDiskBytes,
    floor: policy.minimumFreeDiskBytes,
  });

  measurements.push({
    guardID: 'memory.swapUsed',
    statement: `swap ${gib(reading.swapUsedBytes)}, ceiling ${gib(policy.maximumSwapUsedBytes)}`,
    passed: reading.swapUsedBytes <= policy.maximumSwapUsedBytes,
    observed: reading.swapUsedBytes,
    floor: policy.maximumSwapUsedBytes,
  });

  const freeMemoryMilli = reading.totalMemoryBytes > 0
    ? Math.floor((reading.freeMemoryBytes * 1000) / reading.totalMemoryBytes)
    : 0;
  measurements.push({
    guardID: 'memory.free',
    statement: `free memory ${(freeMemoryMilli / 10).toFixed(1)}%, floor ${(policy.minimumFreeMemoryMilli / 10).toFixed(1)}%`,
    passed: reading.totalMemoryBytes > 0 && freeMemoryMilli >= policy.minimumFreeMemoryMilli,
    observed: freeMemoryMilli,
    floor: policy.minimumFreeMemoryMilli,
  });

  for (const port of policy.portsThatMustBeQuiet) {
    const holder = reading.listeners[String(port)];
    measurements.push({
      guardID: `port.quiet.${port}`,
      statement: holder === undefined ? `port ${port} has no listener` : `port ${port} is held by pid ${holder}, which must be quiet during a benchmark`,
      passed: holder === undefined,
      observed: holder === undefined ? null : holder,
      floor: 'no listener',
    });
  }

  const benchHolder = reading.listeners[String(policy.benchmarkPort)];
  measurements.push({
    guardID: 'port.benchmarkLane',
    statement: benchHolder === undefined
      ? `nothing is listening on the benchmark lane (port ${policy.benchmarkPort}); there is nothing to benchmark against`
      : `the benchmark lane on port ${policy.benchmarkPort} is held by pid ${benchHolder}`,
    passed: benchHolder !== undefined,
    observed: benchHolder === undefined ? null : benchHolder,
    floor: `a listener on ${policy.benchmarkPort}`,
  });

  // The strictest guard: production must still be held by the SAME process it was at freeze time.
  // A different pid on that port means production restarted under the benchmark, and the benchmark
  // may have been talking to it.
  if (policy.productionListener) {
    const { port, pid } = policy.productionListener;
    const holder = reading.listeners[String(port)];
    measurements.push({
      guardID: 'port.productionListener',
      statement: holder === pid
        ? `production on port ${port} is still held by pid ${pid}`
        : holder === undefined
          ? `production on port ${port} has no listener; the process recorded at freeze time (pid ${pid}) is gone`
          : `production on port ${port} is held by pid ${holder}, not the pid ${pid} recorded at freeze time`,
      passed: holder === pid,
      observed: holder === undefined ? null : holder,
      floor: pid,
    });
  }

  if (baseline) {
    const same = reading.modelStoreListingDigest === baseline.listingDigest && reading.modelStoreCount === baseline.count;
    measurements.push({
      guardID: 'modelStore.unchanged',
      statement: same
        ? `the model store still holds ${baseline.count} models with the listing recorded at freeze time`
        : `the model store now holds ${reading.modelStoreCount} models (${reading.modelStoreListingDigest.slice(0, 12)}), not the ${baseline.count} recorded at freeze time (${baseline.listingDigest.slice(0, 12)})`,
      passed: same,
      observed: { count: reading.modelStoreCount, listingDigest: reading.modelStoreListingDigest },
      floor: { count: baseline.count, listingDigest: baseline.listingDigest },
    });
  }

  const breaches = measurements.filter((m) => !m.passed);
  return { allPassed: breaches.length === 0, breaches, measurements, checkedAt };
}

/**
 * The policy for a campaign that talks to a specific endpoint.
 *
 * The benchmark-lane guard exists to catch work going somewhere other than the lane the campaign was
 * authorised against, so the port it watches has to be the one actually in use. Hard-coding a lane
 * number would either fail every ordinary single-Ollama machine or, worse, pass while the campaign
 * talked to a different server than the guard was watching.
 */
export function guardPolicyForEndpoint(endpoint: string, overrides: Partial<GuardPolicy> = {}): GuardPolicy {
  let port = DEFAULT_GUARD_POLICY.benchmarkPort;
  try {
    const parsed = new URL(endpoint);
    if (parsed.port) port = Number(parsed.port);
    else port = parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    // An unparseable endpoint is left to the transport to refuse; the guard keeps its default rather
    // than inventing a port that nothing is listening on.
  }
  return { ...DEFAULT_GUARD_POLICY, benchmarkPort: port, portsThatMustBeQuiet: [], ...overrides };
}

/** A guard breach is an abort, never a warning. This is the reason line the ledger records. */
export function describeBreach(verdict: GuardVerdict): string {
  return verdict.breaches.map((breach) => `${breach.guardID}: ${breach.statement}`).join('; ');
}
