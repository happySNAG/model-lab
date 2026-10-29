# Route-scoped discovery refresh

`cernum discovery-refresh <provider>… --route <routeKey> [--route <routeKey>…] [--json] [--dry-run]` re-observes only
the named routes of the provider they belong to. Engine: `refreshDiscovery({ routeScope })` in
`src/engine/discovery-refresh.ts`; persistence: `discoveryRefreshRecords` in `src/engine/discovery-run.ts`. Test:
`test/engine/discovery-refresh-route.test.ts`.

## Purpose

This is the input for Ordra's RR-7 demonstration. RR-7 needs a real launch whose record shows another qualified
route excluded as `stale` or `unavailable`, and for that one route's observation must be **genuinely older** than
another's. An unscoped `discovery-refresh claudeCLI` observes every Claude route at one instant, so the only
operator control, Ordra's `--availability-max-age`, can only age all routes together. A route-scoped refresh makes
one route's observation genuinely newer than the others, and the others keep their real, older observation.

Running a scoped refresh on the production Cernum root and the demonstration launch are separate approvals. This
change only builds the command.

## What a scope changes, and what it does not

A scope changes **which** routes a refresh re-observes. It never changes what an observation says.

- **The probe is the same probe.** The provider is asked exactly as an unscoped refresh would ask it. Nothing
  writes, copies or synthesises an observation for any route.
- **A scoped route is recorded exactly as an unscoped refresh would record it**, from the provider's answer at
  refresh time. If the provider answered and named it, it is listed with that answer's `observedAt`. If the
  provider answered and did not name it, it is carried forward as `listed: false` and its delta is
  `disappeared`. If the provider did not answer, it is `notRefreshed`.
- **Every other route of that provider is carried forward untouched**: its `listed` flag, its `observedAt` and
  every other field stay as they were. Its delta is `notRefreshed`, and the detail names the route scope. It is
  never `disappeared`, `returned` or `listed: false` because of the scope. This is the same rule as for a provider
  that did not answer: the route was not looked at, so it is never reported as gone.
- **A route the probe named outside the scope that was not already known is not recorded.**
- **Persistence:** the snapshot, the provider's answer and an availability record for each scoped route. No
  availability record is written for a route outside the scope, so its latest availability observation is still
  its earlier one. `cernum candidates` then shows the scoped route's `availability.observedAt` at the refresh time
  and every other route's earlier `observedAt`. No route is marked unavailable, disappeared or unqualified because
  of the scope. Each route still ages by the unchanged availability and freshness windows.
- The snapshot records the scope on the provider's outcome (`providers[].routeScope`). A later diff over stored
  snapshots therefore reads the same `notRefreshed` deltas. Without `--route` the field is absent and every
  snapshot, delta and record is exactly what it was before.

## Refusals (exit 2, nothing probed or persisted)

Each `--route` key must be `<provider>:<modelID>`, and its provider must be named on the command line, as in
`discovery-refresh claudeCLI --route claudeCLI:<modelID>`. The command refuses, before reading the store or
probing anything:

- a key whose provider was not named, including any `--route` when no provider was named;
- a key with no modelID, or with no provider prefix;
- a `--route` given no value.

`refreshDiscovery` makes the same checks (`routeScopeRefusals`) and throws before any probe is called.

A named provider with no `--route` key of its own is refreshed unscoped, as before.

## Unchanged

- **The cycle's daily unscoped refresh is unchanged.** `discovery-run` (the entry the schedule calls) takes no
  `--route`. Plain `discovery-refresh` with no `--route` re-observes every route of every provider it probes,
  exactly as before.
- No probe, provider allowlist, cqp1, crp2, crc2, crr2, qualification threshold, availability window or freshness
  window changes.
