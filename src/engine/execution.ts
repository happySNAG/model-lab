// Benchmark engine · what kind of run this is, and what authority it carries.
//
// TWO KINDS OF RUN, AND THEY ARE NOT COMPARABLE.
//
// A **canonical** campaign is an ACTIVE measurement. Cernum manages model residency on the one
// benchmark endpoint it was pointed at: it asks the runtime to release a candidate's weights before
// the next candidate loads, and it PROVES the release happened before continuing. That is what makes
// the second candidate's latency a measurement of the model rather than a measurement of the disk.
// A campaign that cannot prove the release aborts. It never downgrades to a warning, because a
// warning on a number nobody can distinguish from a good one is worse than no number.
//
// An **observe-only** campaign is for someone who does not want a benchmark tool touching what is
// loaded on their machine. That is a legitimate thing to want, and it is offered by name. What it
// cannot be is quietly mixed in with canonical results: every candidate after the first may have
// measured a warm or a cold machine depending on what else was running, and nothing in the evidence
// can tell a later reader which. So an observe-only run is labelled noncanonical and noncomparable
// in the manifest, in every ledger row, in the rankings, in the reports and in both interfaces —
// and, because the mode is bound into the manifest digest, it is not even the same manifest as its
// canonical twin. Joining the two is not something a reader has to remember not to do.
//
// THE AUTHORITY IS BOUNDED. Residency management applies to the ONE endpoint the campaign froze and
// to nothing else. There is no discovery of other runtimes, no iteration over ports, and no
// process-level action: the only thing Cernum does is send that endpoint a request carrying
// `keep_alive: 0` for a model it is itself benchmarking. It is disclosed before the run starts, once
// — not per attempt, because an authority you must re-grant between attempts is one nobody reads by
// the third time.

import type { ThinkingMode } from '../core/ollama';

export type { ThinkingMode };

/** Whether Cernum manages what is loaded on the benchmark endpoint. */
export type ResidencyMode =
  /** Cernum unloads a candidate's weights between candidates and proves it. Canonical. */
  | 'managed'
  /** Cernum touches nothing. Noncanonical and noncomparable with managed runs. */
  | 'observeOnly';

/** The execution choices frozen into the manifest. Neither may change after the freeze. */
export interface ExecutionPolicy {
  residency: ResidencyMode;
  thinkingMode: ThinkingMode;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = { residency: 'managed', thinkingMode: 'disabled' };

/** Canonical means one thing only: residency was managed and proved. */
export function isCanonical(policy: ExecutionPolicy): boolean {
  return policy.residency === 'managed';
}

export const NONCANONICAL_LABEL = 'OBSERVE-ONLY — noncanonical, not comparable with managed-residency results';

/**
 * Why an observe-only result cannot be compared with a canonical one. Written once, quoted
 * everywhere, so the terminal, the interface and the report cannot drift into softer wordings.
 */
export const NONCANONICAL_REASONS = [
  'residency was not managed: Cernum did not unload a candidate\'s weights before the next candidate loaded, and did not prove the runtime had released them',
  'every candidate after the first may therefore have been measured against a machine already holding another model\'s weights, and nothing in this evidence records which',
  'latency, throughput and time-to-first-token from this run are not comparable with a canonical run, and are not comparable between candidates within it',
  'quality outcomes (pass, fail, requiresHumanReview) are unaffected: what the model answered is what it answered',
];

/** The disclosure a person sees before a canonical run starts. One place, both interfaces. */
export function residencyDisclosure(endpoint: string, candidates: string[]): string[] {
  return [
    `Cernum will load and unload models on ${endpoint} while this campaign runs.`,
    `Before each candidate after the first, it asks that endpoint to release the previous candidate's weights (${candidates.join(', ')}) and verifies the release before continuing.`,
    'That is what makes the candidates comparable: without it, the second model\'s latency measures the disk rather than the model.',
    `This applies to ${endpoint} only. No other runtime, port or process on this machine is touched, and no model is pulled, created or deleted.`,
    'You are asked once. It is not asked again between attempts.',
  ];
}

/** The one-line summary shown beside a campaign wherever there is room for one line. */
export function describeExecutionPolicy(policy: ExecutionPolicy): string {
  const residency = policy.residency === 'managed'
    ? 'canonical · residency managed on the benchmark endpoint'
    : 'observe-only · noncanonical, residency untouched';
  const thinking = policy.thinkingMode === 'enabled' ? 'thinking on'
    : policy.thinkingMode === 'disabled' ? 'thinking off'
      : 'thinking left to the runtime';
  return `${residency} · ${thinking}`;
}

/**
 * The normalized identity of one benchmark endpoint.
 *
 * `localhost`, `127.0.0.1` and `::1` are the same server, and a trailing slash is not a different
 * one. Normalizing before taking a lease is what stops two campaigns from each believing they own
 * the runtime because they spelled its address differently.
 */
export function normalizeEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // An unparseable endpoint is left to the transport to refuse. For leasing purposes the raw
    // string is its own identity: two callers who typed the same broken address still contend.
    return endpoint.trim().replace(/\/+$/, '').toLowerCase();
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' ? '127.0.0.1' : host;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${loopback}:${port}`;
}

/**
 * How a live host must be configured to honour one frozen policy.
 *
 * Both surfaces call this rather than each deciding for themselves. The desktop service deciding
 * separately from the terminal is exactly how the release-blocking defect happened: the terminal
 * passed `enableResidency` and the service did not, so the same campaign ran two different ways
 * depending on which button started it, and one of those ways threw instead of finishing.
 */
export function hostOptionsFor(policy: ExecutionPolicy): { enableResidency: boolean; thinkingMode: ThinkingMode } {
  return { enableResidency: policy.residency === 'managed', thinkingMode: policy.thinkingMode };
}
