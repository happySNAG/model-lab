# Fallback chain — `cfc1`

`cernum candidates` answers which routes the evidence qualifies for a query. It answers with a SET and
says it is not a choice. Ordra also needs to know what to try next when the route it tried cannot take
the work. This feature puts the same set in an **advisory fallback order**. It uses one documented,
versioned rule, **`cfc1`**, and one pure function.

The function is `deriveFallbackChain` in `src/engine/fallback-chain.ts`. It takes a crc2
`RouteCandidateSet`, the instant to answer for, an optional metrics rollup (`cmr1`) and the recorded
throttles. It returns a value. It reads nothing and writes nothing. Tests:
`test/engine/fallback-chain.test.ts`.

**It is never a selection.** Every answer carries `isSelection: false` and the disclosure
`FALLBACK_CHAIN_IS_NOT_A_SELECTION`, beside the candidate set's own `ROUTE_CANDIDATES_ARE_NOT_A_CHOICE`.
Cernum picks no route, and nothing says the first route should be used. Whether and when to try each
route is Ordra's scheduling decision. It is not a recommend ranking (crr1, gated on D-C6) and it changes
no qualification policy: no figure is combined with another into a score.

## The ordering rule, `cfc1`

Only routes in `candidates` are ordered. Each step only breaks the ties the step before it left.

1. **Zero marginal cost before metered.** These are the candidate set's own groups, `zeroMarginalCost`
   and `meteredRequiresAuthorization`, unchanged. No later step can move a route across them.
2. **Qualification freshness.** The newest passing run (`lastSuccessfulQualificationAt` on the route's
   qualification record) comes first. A route that recorded none comes after every route that did.
3. **The metrics rollup**, for the queried capability (`cmr1`, from `history --metrics`):
   1. the lower failure rate first;
   2. then the lower nearest-rank p90 wall clock.

   An unknown figure sorts after every known one. Without a rollup this step orders nothing, and each
   entry says so.
4. **Route key**, so the order is total and the same evidence always gives the same chain.

Every entry carries `orderedBy`, the evidence each step compared, so a reader can check the order.

## Fall-through

A qualified route keeps its position and is marked `fallsThrough`, with every reason, when either is
true at the instant answered for:

- **Availability.** Its availability on the queried machine is not `available`.
- **Throttle.** A recorded throttle still reaches it. A throttle is a rate-limit or usage-limit decline
  that a sealed run recorded (`lastThrottle` on a route's qualification record).

The fallback list itself is `chain`: the route keys whose standing is `inChain`, in order. `entries`
lists every qualified route, including those that fall through.

How far a throttle reaches is decided by `providerThrottleScopeFor`, the same rule the workspace
breaker uses. `claudeCLI` declares one subscription session, so a decline on one Claude route reaches
every Claude route. A provider that has declared nothing is treated as `provider`-scoped, and the reason
says the scope is undeclared. A throttle never reaches another provider. The command reads throttles
from every derived record, **including excluded routes**, because a session limit seen on an excluded
sibling still applies to a candidate.

A throttle stops speaking to now when any of these is true:

- the reached route recorded a passing run after it;
- the provider named a retry-after delay and that delay has passed;
- it is older than 24 hours (`FALLBACK_THROTTLE_MAX_AGE_MILLISECONDS`, the availability window).

A reset clock time the provider named, such as `resets 8:10pm (America/Chicago)`, is kept verbatim in
the reason and is never parsed. A throttle with no readable date cannot be placed in time, so it does
not make a route fall through.

## Exclusions

`excluded` is exactly the candidate set's `excluded`, with every reason. No excluded route can enter the
chain. That holds for a free route that is not qualified, for a metered route under a zero-cost query,
and for a route the store says is unavailable here.

## The command

```
cernum candidates <capability> --fallback [--json] [--machine <cmk1:…>] [--evidence-roots …]
cernum candidates --task <type> --tier <n> --context <tokens> --fallback --json
```

It answers the same query `candidates` answers, from the same observation store and sealed runs. It
then orders that set by `cfc1`. The metrics rollup comes from the same rows. Without `--log` it writes
nothing. With `--log` the candidate set is logged as before, and the chain is not stored. With `--json`
the chain is printed; with `--task`, a `task` field is added, as for the candidate set.

Changing any step, its order, the throttle window or what counts as fall-through changes which route
Ordra tries next. Any such change needs a new rule version.
