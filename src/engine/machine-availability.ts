// Benchmark engine · WHICH MACHINE, and what is reachable from it right now.
//
// THE QUESTION ORDRA WILL ASK is "what qualified route can I use ON THIS MACHINE, now?", and it has two
// halves this engine used to answer as one. A hosted route — Claude through a subscription, a model
// through OpenCode — is the same route from any machine signed into the same account: its QUALIFICATION
// is a fact about the provider route, and only its AVAILABILITY varies by machine (is the CLI installed,
// is it signed in). A LOCAL route is different in kind. `gemma3:4b` on one Mac and `gemma3:4b` on
// another may be different weights, served by different runtime versions, on hardware with a fraction of
// the memory — so a local qualification is a statement about ONE machine's weights and runtime and is
// never carried to another. That asymmetry is the whole of this module.
//
// NO MACHINE NAME IS WRITTEN DOWN HERE. A machine is identified by what it REPORTS — hostname, platform,
// CPU, memory — digested into a key. No product or host name of any particular computer appears in this
// file, and a test walks the source to hold it to that.

import * as os from 'node:os';
import { CanonicalValue, digestObject } from './canonical';
import { ProviderID, executionClassOf } from './provider';

/** What a machine reports about itself. Every field is read, none is configured. */
export interface MachineFingerprint {
  /** The OS's name for the machine. A LABEL for people; the key below is what identifies it. */
  hostname: string;
  platform: string;
  architecture: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
}

export function readMachineFingerprint(): MachineFingerprint {
  const cpus = os.cpus();
  let hostname = '';
  try { hostname = os.hostname(); } catch { hostname = ''; }
  return {
    hostname: hostname.length > 0 ? hostname : 'unknown-machine',
    platform: process.platform,
    architecture: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown-cpu',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

/**
 * `cmk1:` — the identity of a machine, from its fingerprint.
 *
 * THE HOSTNAME IS PART OF IT, AND SO IS THE HARDWARE. Two machines renamed to the same hostname stay two
 * keys; one machine whose memory changed becomes a new key, which is the conservative direction — a
 * local result measured on 16 GiB is not assumed to hold on 32 GiB, or the reverse.
 */
export function machineKey(fingerprint: MachineFingerprint): string {
  return 'cmk1:' + digestObject(fingerprint as unknown as CanonicalValue).slice(0, 24);
}

/**
 * How far a qualification reaches.
 *
 *   route    the provider route itself: the same on every machine that can reach it. Hosted models.
 *   machine  one machine's weights on one machine's runtime. Local models. Never transferred.
 */
export type QualificationScope = 'route' | 'machine';

export function qualificationScopeFor(provider: ProviderID): QualificationScope {
  return executionClassOf(provider) === 'localRuntime' ? 'machine' : 'route';
}

export const LOCAL_QUALIFICATION_DOES_NOT_TRANSFER =
  'a local model\'s qualification binds to the machine it was measured on AND the weights digest it ran under. The same '
  + 'tag on another machine may be different weights, a different runtime, or hardware that cannot hold it; a result '
  + 'from one machine is therefore never read as a result on another. Re-qualify on the machine that will run it.';

/** One observation that a route was, or was not, reachable from one machine. */
export interface RouteAvailabilityObservation {
  routeKey: string;
  machineKey: string;
  /** The hostname at observation time. A label; `machineKey` decides. */
  machineLabel: string;
  observedAt: string;
  available: boolean;
  /** Why, in words: "installed and signed in", "runtime did not answer", "not listed by the runtime". */
  reason: string;
  /** For a local route, the weights digest this machine reported. */
  runtimeDigest?: string;
}

export type MachineAvailabilityState = 'available' | 'unavailable' | 'stale' | 'neverObserved';

/** How long an availability observation stays current. Shorter than a proof: installs and sessions move. */
export const AVAILABILITY_OBSERVATION_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;

export interface MachineAvailability {
  state: MachineAvailabilityState;
  reason: string;
  latest?: RouteAvailabilityObservation;
}

/** Is this route reachable from this machine, as of the latest observation made ON it? */
export function availabilityOnMachine(observations: RouteAvailabilityObservation[], routeKey: string, machine: string,
                                      now: Date, maxAge = AVAILABILITY_OBSERVATION_MAX_AGE_MILLISECONDS): MachineAvailability {
  const mine = observations
    .filter((entry) => entry.routeKey === routeKey && entry.machineKey === machine)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const latest = mine[mine.length - 1];
  if (latest === undefined) {
    // AN OBSERVATION FROM ANOTHER MACHINE IS NOT CONSULTED. That the route answered elsewhere says nothing
    // about whether its CLI is installed, signed in, or its weights present, here.
    return { state: 'neverObserved', reason: `${routeKey} has never been observed from this machine (${machine})` };
  }
  const age = now.getTime() - Date.parse(latest.observedAt);
  if (Number.isNaN(age) || age > maxAge) {
    return { state: 'stale', latest, reason: `${routeKey} was last observed from this machine at ${latest.observedAt}, which is `
      + `older than the ${Math.round(maxAge / 3_600_000)} h availability window; re-run discovery here` };
  }
  return latest.available
    ? { state: 'available', latest, reason: `${routeKey} was reachable from this machine at ${latest.observedAt}: ${latest.reason}` }
    : { state: 'unavailable', latest, reason: `${routeKey} was NOT reachable from this machine at ${latest.observedAt}: ${latest.reason}` };
}

/** Every machine a route has been observed on, with its latest state. For a status view. */
export function machinesForRoute(observations: RouteAvailabilityObservation[], routeKey: string, now: Date):
  { machineKey: string; machineLabel: string; availability: MachineAvailability }[] {
  const keys = [...new Set(observations.filter((entry) => entry.routeKey === routeKey).map((entry) => entry.machineKey))].sort();
  return keys.map((key) => {
    const availability = availabilityOnMachine(observations, routeKey, key, now);
    return { machineKey: key, machineLabel: availability.latest?.machineLabel ?? key, availability };
  });
}

/** What a qualification was established UNDER, so its reach can be judged. */
export interface QualificationLocus {
  provider: ProviderID;
  machineKey?: string;
  runtimeDigest?: string;
}

/**
 * Does a qualification established under `locus` apply on `target`?
 *
 * A route-scoped qualification applies wherever the route is available — availability is the separate
 * question above. A machine-scoped one applies ONLY on the same machine with the same weights digest,
 * and anything else is `requalifyOnThisMachine`, never a quiet yes.
 */
export function qualificationAppliesOn(locus: QualificationLocus, target: { machineKey: string; runtimeDigest?: string }):
  { applies: boolean; reason: string } {
  if (qualificationScopeFor(locus.provider) === 'route') {
    return { applies: true, reason: 'a hosted route\'s qualification is a fact about the provider route, not the machine' };
  }
  if (locus.machineKey === undefined || locus.machineKey !== target.machineKey) {
    return { applies: false, reason: `requalifyOnThisMachine: the evidence was measured on ${locus.machineKey ?? 'an unrecorded machine'}, `
      + `not ${target.machineKey}. ${LOCAL_QUALIFICATION_DOES_NOT_TRANSFER}` };
  }
  if (locus.runtimeDigest === undefined || target.runtimeDigest === undefined || locus.runtimeDigest !== target.runtimeDigest) {
    return { applies: false, reason: `requalifyOnThisMachine: the evidence ran under weights ${locus.runtimeDigest ?? '(unrecorded)'} and `
      + `this machine now reports ${target.runtimeDigest ?? '(none)'}. Different weights are a different model.` };
  }
  return { applies: true, reason: 'same machine, same weights digest' };
}
