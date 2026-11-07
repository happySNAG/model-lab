# Status export — `cse1`

Ordra Office needs one place to read what Cernum knows. Without this feature it would have to run nine
commands and stitch their answers together. `cernum status-export --json` prints **one document** that
gathers them. The document is versioned: schema id **`cse1`**, **version 1**. The JSON schema it
validates against is [`status-export.schema.json`](status-export.schema.json), beside this page.

The function is `deriveStatusExport` in `src/engine/status-export.ts`. It takes the observation store's
contents, the sealed workspace run rows and the runtime-lease inspections as values, and returns a value.
Tests: `test/engine/status-export.test.ts`. They validate the document against the schema, both from the
engine and from the command in a subprocess.

Office itself is out of scope. This page describes the interface it will read.

## What it is not

- **Not a writer and not a client.** The command reads the observation store, the sealed runs under
  `--root` and `--evidence-roots`, and the lease files under `--root`. It writes nothing. It sends no
  request to any model, provider or network service. The command test runs it with the network tripwire
  preloaded and checks that the campaign root's bytes are unchanged.
- **Not a second rule.** Every verdict, candidate set, chain, figure and finding is the output of the
  module that owns it, called with the inputs its own command would give it. The export only gathers.
  The tests compare the metrics rollup, the regression report and the history entries with those modules'
  own output.
- **Not a selection.** A candidate set is not a choice, and a fallback chain is advisory. Each says so in
  its disclosure, and `fallbackChains.isSelection` is always `false`. Nothing is combined into a score or
  ranked. The export adds no recommend ranking (crr1, gated on D-C6) and does not change qualification
  policy cqp1.

## Usage

```
cernum status-export --json [--root <dir>] [--machine <cmk1:key>] [--policy crp1|crp2]
                            [--evidence-roots <dir,dir>] [--context <tokens>] [--expiry-warnings]
```

Without `--json` it prints a short summary and points at the full document. `--context` gives every
task's fallback query a context requirement; see below. A store file that does not verify is listed in
`corrupt`. With `--json` the document is still printed whole and the command exits 2. Without `--json` the
files are named and the command exits 2. An unreadable `--context` or a positional argument is refused
with exit 2 before anything is read.

## The document

Every top-level field below is required, and no other field is allowed except `expiryWarnings`, which
only version 2 carries (see [Expiry warnings](#expiry-warnings--version-2-opt-in)).

| Field | What it holds |
|---|---|
| `schema`, `schemaVersion`, `jsonSchema` | `cse1`, `1`, and the schema's path in this repository. |
| `generatedAt`, `machineKey`, `effort` | The instant and the machine everything is answered for. |
| `readOnly` | Always `true`. |
| `versions` | The version of every rule and schema carried: `cos1`, `cds1`, `cqp1`, `crp1`/`crp2`, `crc2`, `cmr1`, `crg1`, `crt1`, `cqh1`, `ctt1`, `cfc1`. |
| `discoveredModels` | The latest discovery snapshot (`cds1`) on the machine, as it was recorded: each provider's answer and each model with its metadata (listed, availability, published price fingerprint, published-free, context window, runtime digest and version, when seen). With no snapshot the list is empty and `reason` says so. |
| `qualifiedRoutes` | Every route the machine observed, the snapshot listed or a sealed run measured. Each comes with its qualification record (cqp1) summarised: safe to route, routable capabilities, capability verdicts, blockers, availability, identity, staleness, last passing run. `safeToRouteKeys` lists the routes that are safe. |
| `capabilityCandidates` | For every capability any route has evidence for, the crc2 candidate set under the V1 default, zero marginal cost only. Each candidate is summarised. Each exclusion keeps every reason. |
| `metricsRollup` | `deriveMetricsRollup` (`cmr1`), unchanged. |
| `regressions` | `detectRegressions` (`crg1` under thresholds `crt1`), unchanged, with the stale-qualification findings. |
| `recentQualificationResults` | The newest 5 entries of each route's qualification history (`cqh1`), oldest first, and the total entry count. |
| `costs` | Per route: the spend posture (cost eligibility, zero marginal cost, whether spending needs authorization); the published price the snapshot recorded; and what the sealed runs recorded spending (`cmr1` cost). `state` is `known`, `partlyKnown` or `unknown`. `reason` names each part that is missing. A cost not recorded is never estimated. |
| `fallbackChains` | `deriveFallbackChain` (`cfc1`) for every task type of task taxonomy `ctt1`, at each of the three structural tiers: 8 × 3 chains. Each tier gives its crc2 query, the `chain`, every qualified entry with its standing and ordering evidence, and every exclusion with its reasons. |
| `activeLeases` | The runtime-endpoint leases under `--root`, each with endpoint, campaign, owner process, heartbeat and state (`live`, `selfHeld`, `stale`, `unresponsive`, `foreignHost`). `active` means held and not reclaimable. A crashed owner's lease is listed, but is not active. `read` is false when no leases were read. |
| `corrupt` | Observation files that did not verify and were not read. |
| `disclosure` | The read-only statement. |

### The context requirement of the task queries

Task taxonomy `ctt1` refuses to default a pass's context requirement. The export has no pass, so it
invents none. Without `--context`, each task query carries no `minimumContextTokens`, and
`fallbackChains.contextRequirement.applied` is `false` with the reason. A pass that needs a context
requirement asks `cernum candidates --task <type> --tier <n> --context <tokens> --fallback`. With
`--context <tokens>`, every task query carries it. As in `candidates`, a route whose context window is
unknown cannot satisfy it and is excluded with that reason.

## Expiry warnings — version 2, opt-in

`cernum status-export --expiry-warnings --json` prints the same document as **version 2**: `schemaVersion`
is `2` and one field is added, last, **`expiryWarnings`**. Without `--expiry-warnings` the document is
version 1, with exactly the fields and order above; nothing else changes either way.

`expiryWarnings` has one entry per route whose latest qualification history (`cqh1`) verdict is
`safeToRoute` and whose qualification expires within the qualification planner's renewal window
(`RENEWAL_WINDOW_MILLISECONDS`, 7 days, in `src/engine/qualification-planner.ts`) or has already expired.
Each entry has:

| Field | What it holds |
|---|---|
| `routeKey` | The route. |
| `expiresAt` | The instant the qualification stops being current. |
| `state` | `expiring` when it is within the window and not yet past; `expired` when `expiresAt` is at or before the export's instant. |
| `reason` | The policy, the end of the evidence the qualification rests on, and the expiry. |

Entries are sorted by `expiresAt`, then `routeKey`. A route outside the window, one whose latest verdict is
not safe, and one with no dated evidence get no entry; an empty list means nothing is due.

The expiry instant is the planner's own: `latestQualificationEvidence` (the newest entry's
`evidenceWindow.to` plus the policy's `maximumAgeMilliseconds`) and `qualificationExpiryState` are exported
from the planner and called here, not copied. So a route warned `expiring` or `expired` is exactly a route
`plan-qualification` would plan a renewal for at the same instant, with the same `qualificationExpiresAt`.
The warnings are information only: nothing is planned, written or sent. The function is
`deriveExpiryWarnings` in `src/engine/status-export.ts`; tests: `test/engine/status-export-expiry.test.ts`.

The JSON schema admits both versions: `schemaVersion` is `1` or `2`, and `expiryWarnings` is optional,
with no other field allowed on its entries. The schema's `$id` is unchanged.

## Versioning

- **Adding** a field is a new `schemaVersion` under the same `schema` id.
- **Removing** a field, or changing what one means, is a new `schema` id.

The sections that carry another versioned document pin that document's id: `metricsRollup.schema` is
`cmr1`, `regressions.schema` is `crg1`. They also pin its required fields, and they admit the fields that
document adds. A change to those documents is versioned where they are defined.
