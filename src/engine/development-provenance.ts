// Benchmark engine · recording which Cernum, on which machine, produced a development grade.
//
// THE TEXT BENCHMARK NEVER NEEDED THIS AND THE DEVELOPMENT BENCHMARK DOES. A text case is a frozen
// prompt and a sealed policy: the manifest binds both, so "what was asked and how it was judged" is
// answerable from the evidence alone. A development task is graded by CODE — a predicate language, a
// scoring contract, a fixture repository — and code changes. Two grades of the same answer under two
// commits of this repository are two measurements, and evidence that cannot tell them apart is
// evidence that will eventually be read wrong.
//
// So every development result carries the commit that graded it, the fixture digest it ran against,
// the contract digest that decided it, and the machine that executed it.
//
// BEST EFFORT, AND HONEST ABOUT IT. An installed application has no `.git` directory and no `git`
// on its PATH; a checkout has both. A commit that cannot be read is recorded as the EMPTY STRING and
// `provenanceIsComplete` names it as missing — it is never filled in with a guess, a timestamp, or
// the version number standing in for a commit.

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

import { DevelopmentProvenance } from '../core/development-benchmark';

/**
 * The commit, from a build-time stamp if one was injected, else from git, else empty.
 *
 * `CERNUM_BENCHMARK_COMMIT` is the stamp a packaged build sets. Reading the environment is not a
 * loophole in the isolation rules: this runs in the RUNNER's process, not inside an attempt's
 * scrubbed environment, and it is the only way a build with no repository can know its own identity.
 */
export function readBenchmarkCommit(workingDirectory: string = process.cwd()): string {
  const stamped = process.env.CERNUM_BENCHMARK_COMMIT;
  if (stamped !== undefined && /^[0-9a-f]{7,40}$/i.test(stamped.trim())) return stamped.trim().toLowerCase();
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workingDirectory, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : '';
  } catch {
    // No repository, no git, or a detached environment. Recorded as unknown rather than invented.
    return '';
  }
}

/** True when the working tree has uncommitted changes, so a commit alone would misdescribe the grade. */
export function readWorkingTreeDirty(workingDirectory: string = process.cwd()): boolean | undefined {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: workingDirectory, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return undefined;
  }
}

export interface MachineIdentity {
  machineIdentifier: string;
  platform: string;
}

/**
 * The machine, named the way the rest of this product names it.
 *
 * Sessions and the Home screen already publish `hostname`; a development result publishing something
 * else would be a second, quietly different notion of "which machine" in the same evidence store.
 */
export function readMachineIdentity(): MachineIdentity {
  let hostname = '';
  try {
    hostname = os.hostname();
  } catch {
    hostname = '';
  }
  return {
    machineIdentifier: hostname.length > 0 ? hostname : 'unknown-machine',
    platform: `${process.platform}-${process.arch}`,
  };
}

export interface ProvenanceInputs {
  benchmarkVersion: string;
  suiteID: string;
  suiteVersion: string;
  suiteDigest: string;
  taskID: string;
  taskDigest: string;
  comparabilityKey: string;
  fixtureRepoID: string;
  fixtureRepoVersion: string;
  fixtureRepoDigest: string;
  contractID: string;
  contractVersion: string;
  contractDigest: string;
  executedAt: string;
  /** Supply both to avoid re-shelling out per task; omit to have them read here. */
  benchmarkCommit?: string;
  machine?: MachineIdentity;
}

export function developmentProvenance(inputs: ProvenanceInputs): DevelopmentProvenance {
  const machine = inputs.machine ?? readMachineIdentity();
  return {
    benchmarkVersion: inputs.benchmarkVersion,
    benchmarkCommit: inputs.benchmarkCommit ?? readBenchmarkCommit(),
    machineIdentifier: machine.machineIdentifier,
    platform: machine.platform,
    suiteID: inputs.suiteID,
    suiteVersion: inputs.suiteVersion,
    suiteDigest: inputs.suiteDigest,
    taskID: inputs.taskID,
    taskDigest: inputs.taskDigest,
    comparabilityKey: inputs.comparabilityKey,
    fixtureRepoID: inputs.fixtureRepoID,
    fixtureRepoVersion: inputs.fixtureRepoVersion,
    fixtureRepoDigest: inputs.fixtureRepoDigest,
    contractID: inputs.contractID,
    contractVersion: inputs.contractVersion,
    contractDigest: inputs.contractDigest,
    executedAt: inputs.executedAt,
  };
}
