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
  /** Present when a usage-limit or rate-limit observation still in force decided this state. */
  limit?: AvailabilityLimit;
}

/**
 * How far a recorded limit reaches: one route, or every route of one provider on the machine that
 * observed it. Same three words as `workspace-throttle.ts`'s `ThrottleScope`, repeated rather than
 * imported so that this pure module depends on nothing that knows about runs.
 */
export type AvailabilityLimitScope = 'route' | 'provider' | 'subscriptionSession';

/**
 * A usage-limit or rate-limit event, as availability evidence (limit evidence cle1, see `limit-evidence.ts`).
 *
 * IT EXPIRES. `expiresAt` is the provider's own expected return when one could be placed in time, and
 * otherwise the end of the availability window from `observedAt`; `expiresBy` says which. Until then
 * the route it reaches reads as unavailable on the machine that observed it, whatever an ordinary
 * availability observation says — a probe that found the CLI installed and signed in did not ask whether
 * the allowance came back. After it, the limit says nothing and the ordinary observations decide again.
 */
export interface AvailabilityLimit {
  kind: 'usageLimit' | 'rateLimit' | 'throttleReported';
  provider: string;
  machineKey: string;
  machineLabel: string;
  scope: AvailabilityLimitScope;
  /** The route the limit was observed on. For a `route` scope, the only route it reaches. */
  routeKey?: string;
  observedAt: string;
  expiresAt: string;
  expiresBy: 'expectedReturn' | 'availabilityWindow';
  /** The provider's expected return as an instant, when it named one that could be placed in time. */
  expectedReturn?: string;
  /** The provider's own words about when it returns, verbatim, when it said anything. */
  reported?: string;
  /** What established the limit, in words a person can check. */
  source: string;
  detail: string;
  /** The observation record that carries it, when it came from a store. */
  recordID?: string;
}

/** A later statement, by the provider's own session probe, that it is NOT throttled. */
export interface AvailabilityLimitLift {
  provider: string;
  machineKey: string;
  observedAt: string;
  source: string;
}

const providerOfRoute = (routeKey: string): string => routeKey.split(':')[0] ?? '';

/**
 * The limit that still holds this route unavailable on this machine at `now`, if any.
 *
 * A limit reaches only the machine that observed it, never another. A `route` limit reaches its own
 * route; a `provider` or `subscriptionSession` limit reaches every route of its provider. A lift — the
 * provider's own probe saying it is not throttled — clears the provider-wide limits observed before
 * it and never a route-scoped one, which the session probe says nothing about. When several reach, the
 * one that holds longest is reported, because that is the one the route is waiting on.
 */
export function availabilityLimitInEffect(limits: AvailabilityLimit[], lifts: AvailabilityLimitLift[], routeKey: string,
                                          machine: string, now: Date): AvailabilityLimit | undefined {
  const at = now.getTime();
  const reaching = limits.filter((limit) => {
    if (limit.machineKey !== machine) return false;
    const observed = Date.parse(limit.observedAt);
    const expires = Date.parse(limit.expiresAt);
    // AN UNDATED OR NOT-YET-OBSERVED LIMIT CANNOT SPEAK TO `now`, and an expired one has stopped speaking.
    if (Number.isNaN(observed) || Number.isNaN(expires) || observed > at || expires <= at) return false;
    if (limit.scope === 'route') return limit.routeKey === routeKey;
    if (limit.provider !== providerOfRoute(routeKey)) return false;
    return !lifts.some((lift) => lift.machineKey === machine && lift.provider === limit.provider
      && Date.parse(lift.observedAt) > observed && Date.parse(lift.observedAt) <= at);
  });
  return reaching.sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt)
    || (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))[0];
}

/** The sentence a limit puts in an availability answer: its source, its time, and when it lifts. */
export function describeAvailabilityLimit(limit: AvailabilityLimit): string {
  const kind = limit.kind === 'usageLimit' ? 'a usage limit' : limit.kind === 'rateLimit' ? 'a rate limit' : 'a throttle';
  const reach = limit.scope === 'route' ? `on ${limit.routeKey ?? 'this route'}`
    : `across every ${limit.provider} route (${limit.scope}-scoped${limit.routeKey === undefined ? '' : `, observed on ${limit.routeKey}`})`;
  const until = limit.expiresBy === 'expectedReturn'
    ? `until ${limit.expiresAt}, the provider's expected return${limit.reported === undefined ? '' : ` ("${limit.reported}")`}`
    : `until ${limit.expiresAt}, the end of the availability window — the provider named `
      + `${limit.reported === undefined ? 'no return time' : `"${limit.reported}", which could not be placed in time`}`;
  return `limit: ${kind} was recorded ${reach} at ${limit.observedAt} by ${limit.source}; unavailable ${until}`;
}

/**
 * An ordinary availability answer, with the recorded limits applied on top.
 *
 * A limit in force makes the route `unavailable` whatever the ordinary state was, and carries itself on
 * the answer. Without one the ordinary answer is returned unchanged, so a store with no limit evidence
 * answers exactly as it always did.
 */
export function applyAvailabilityLimits(base: MachineAvailability, limits: AvailabilityLimit[], lifts: AvailabilityLimitLift[],
                                        routeKey: string, machine: string, now: Date): MachineAvailability {
  const limit = availabilityLimitInEffect(limits, lifts, routeKey, machine, now);
  if (limit === undefined) return base;
  return {
    state: 'unavailable',
    ...(base.latest === undefined ? {} : { latest: base.latest }),
    limit,
    reason: `${routeKey} is NOT available from this machine: ${describeAvailabilityLimit(limit)}. `
      + `Without the limit: ${base.reason}`,
  };
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
