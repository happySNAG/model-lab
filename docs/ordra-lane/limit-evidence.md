# Limit evidence — `cle1`

Two parts of Cernum already see a usage limit or a rate limit. The session preflight
(`provider-session-status.ts`) can report a `SessionThrottleState`. The matrix circuit breaker
(`workspace-throttle.ts`) builds a `ProviderThrottleSignal` when a provider declines. Before this feature
both were forgotten when the command exited. So `availability` and `candidates` kept answering
"available" for a route whose provider had just said it would serve nothing until a stated time.

This feature writes each such event into the existing append-only observation store as availability
evidence. `availability` and `candidates` read it back. A limited route shows as **unavailable until its
evidence expires**. After that the ordinary availability observations decide again.

Code: `src/engine/limit-evidence.ts` (writing), `availabilityLimitsFrom` in
`src/engine/observation-store.ts` and `applyAvailabilityLimits` in `src/engine/machine-availability.ts`
(reading). Tests: `test/engine/limit-evidence.test.ts`. Fixture:
`fixtures/limit-evidence/usage-limit-2026-09-21.json`.

## What is written

Every record is a normal sealed `cos1` observation. It is content-addressed, so recording the same
event twice writes one file. Each record carries:

- **source**: `provenance` on the record names the command (`workspace-benchmark circuit breaker` or
  `session preflight`). `body.limit.source` names the run that saw the decline (candidate, case, repeat
  and sealed record root) or the probe command.
- **time**: `observedAt`, the moment the decline was seen.
- **expected return, where known**: the record's `expiresAt`. `body.limit.expiresBy` says where it came from:
  - `expectedReturn`: the provider's own return time, placed in time (also in `body.limit.expectedReturn`);
  - `availabilityWindow`: the provider named nothing that could be placed, so the limit lasts the
    ordinary 24 h availability window from `observedAt`. Anything the provider did say is kept verbatim
    in `body.limit.reported`, and `body.limit.expectedReturnBasis` says why it could not be placed.

| Event | Records written |
|---|---|
| Breaker signal, `rateLimited`, scope `provider` or `subscriptionSession` | one `providerAvailability` (`answered: true`, `limit`) and one `routeAvailability` (`available: false`, `limit`) for the route it was seen on |
| Breaker signal, `rateLimited`, scope `route` | one `routeAvailability` for that route |
| Breaker signal, `notAuthenticated` | nothing. It is a login problem, not a limit, and has no return time. `notWritten` says so |
| Session status `throttled` | one `providerAvailability` with `limit.kind: throttleReported`, scoped by `providerThrottleScopeFor` |
| Session status `notThrottled` | one `providerAvailability` with `limitLifted` (a lift; see below) |
| Session status `notReported` or deferred | nothing. A tool that reports no throttle state gives no evidence either way |

`body.limit.kind` is `usageLimit` when the message says the allowance is spent. That uses the engine's
`isPlanExhausted` markers plus a Claude "session limit". Any other limit is `rateLimit`.

### Placing the provider's return time

Only what the provider said is read. Nothing is invented.

- A delay (`retry after 120 seconds`) is the observation time plus the delay.
- A clock time with a printed zone (`resets 8:10pm (America/Chicago)`) is the next such time after the
  observation, in that zone.
- A full date (`try again at Sep 21st, 2026 1:55 AM`) is read in the zone the provider printed. If it
  printed none, it is read in the zone of the machine whose CLI printed it, but only when the caller
  names that zone (`reportedTimeZone`). `workspace-benchmark` names its own machine's zone, because the
  CLI it ran formats times in that zone.
- A time that is not after the observation cannot bound it. It is reported but not used.

## How it is read back

`availabilityObservationsFrom` now skips limit records, so an expired limit does not stay "the latest
observation" for a day. `availabilityLimitsFrom` reads the limits and lifts.
`availabilityLimitInEffect` decides which limit, if any, holds a route on a machine at `now`:

- it reaches only the machine that observed it, never another;
- a `route` limit reaches only its route. A `provider` or `subscriptionSession` limit reaches every route
  of that provider;
- it holds from `observedAt` until, but not including, `expiresAt`;
- a later `notThrottled` from the provider's own session probe lifts provider-wide limits observed before
  it. It does not lift route-scoped ones, because the session probe says nothing about those;
- an ordinary availability observation does **not** lift a limit. A probe that found the CLI installed
  and signed in did not ask whether the allowance came back;
- if several limits reach a route, the one that holds longest is reported.

`fleetAvailability` (`cernum availability`) and `availabilityFromStore` (`cernum candidates`) apply this
on top of the ordinary answer. A limited route is `unavailable`, and `availability.limit` carries the
limit. The reason names the limit's kind, reach, source, time and expiry, then the ordinary reason.
`candidates` therefore excludes the route under `availability:` with that reason, and `--fallback` lets it
fall through. `cernum availability` also lists every limit still in force on the machine asked about,
including a provider-wide limit that no listed route shows.

## Where it is recorded live

`cernum workspace-benchmark` records limit evidence into the campaign root's observation store in two places:

1. the session preflight, on a live run only (a dry run returns before this point);
2. the circuit breaker, when it trips.

Each prints what it recorded, or why it recorded nothing. Nothing new is sent to any provider. The
inputs are the status and the signal those parts already produced.

## The fixture

`usage-limit-2026-09-21.json` is modelled on the 2026-09-21 usage-limit incident. In that incident the
Codex service answered sixty-nine `gpt-6-astra@max` attempts with "You've hit your usage limit … try
again at Sep 21st, 2026 1:55 AM". The fixture also includes the Claude session limit ("resets 8:10pm
(America/Chicago)") that the first sealed Claude matrix recorded, an OpenCode 429 with a retry delay, a
`notAuthenticated` decline, and the honest Claude preflight (`notReported`). The provider messages are
verbatim. The machine, the record roots and the instants are placed by the fixture; they were not
recovered from the incident's records.

## Bounds

This is availability evidence, nothing more. It changes no qualification policy (cqp1) and adds no
ranking. It never turns a plan name into an allowance. It never carries a limit from one machine to
another.
