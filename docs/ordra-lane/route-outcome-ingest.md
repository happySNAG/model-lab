# Outcome feedback (cro1)

`cernum ingest-outcomes <file> [--machine <cmk1:…>] [--json]` reads an exported Ordra route-telemetry file and
appends each record to the observation store as a sealed observation. What a route actually did on real Ordra
passes then reaches the metrics rollup. Rule version: `cro1`. Engine: `src/engine/route-outcome-ingest.ts`.

It reads one local file and contacts nothing: no model, provider or network.

## The file

One JSON object per line (JSONL). Lines holding only whitespace are skipped and counted.

| field | type | meaning |
| --- | --- | --- |
| `pass` | non-empty string | the Ordra pass, e.g. `P-7097` |
| `attempt` | whole number ≥ 1 | the attempt within the pass |
| `provider` | a Cernum provider id | `claudeCLI`, `codexCLI`, `ollama`, `opencodeCLI`, `anthropicAPI`, `openaiAPI`. Required, because a provider is never inferred from a model name |
| `requestedModel` | non-empty string | the model Ordra asked for |
| `actualModel` | string or `null` | the model the session's own reported model usage names; `null` when it named none. The key must be present |
| `verification` | `passed`, `failed` or `notRun` | Ordra's verification result for the attempt |
| `tokens` | whole number ≥ 0, `null` or absent | total tokens the session reported; never estimated |
| `durationMilliseconds` | whole number ≥ 0, `null` or absent | wall clock of the attempt |
| `recordedAt` | ISO-8601 instant | when the attempt was recorded; becomes the observation's `observedAt` |

Fields not listed are not read. Example: `fixtures/route-outcomes/ordra-route-telemetry.jsonl`.

## What is written

- **`routeOutcome`**, one per accepted line: the fields above plus the route key (`provider:requestedModel`),
  the identity (`matched`, `substituted` or `unreported`) and `findings`. The record is content-addressed under
  the store's own rule, and its provenance names no file, so the same outcome in two exports is one record.
  It carries no record-level `routeKey`, so the availability views and the qualification timeline never select it.
- **`routeOutcomeQuarantine`**, one per line that could not be ingested: the reason code (`malformed` or
  `duplicate`), the reason, the line number, the file's sha256 and the line's text exactly as it arrived.

## Substitution

A requested model that differs from the reported one is recorded on the outcome as a finding
`{ kind: 'substitution', requestedModel, actualModel }` and listed in the command's `substitutions`. The
comparison is by exact string: a dated alias the provider reports differently is a finding until something
proves it is the same model. A session that reported no model usage is `unreported`, not a substitution.

## Idempotence, duplicates and quarantine

An outcome is identified by its pass and attempt.

- A line the store already holds exactly writes nothing and is listed under `alreadyPresent`.
- A line repeating an earlier line's pass and attempt in the same file, exactly or not, is quarantined
  naming that line. Neither copy is chosen over the other.
- A line whose pass and attempt the store already holds with different content is quarantined naming the
  stored record, which is never replaced.
- A malformed line is quarantined with every reason it fails.

The file is checked before the store, so a line is quarantined for the same reason every time. A quarantine
already in the store is not written again (`written: false`). Ingesting the same file twice writes nothing the
second time. Nothing is dropped: every non-blank line is an outcome or a quarantine.

A file that cannot be read is refused whole with exit 2, and nothing is written.

## Feeding the rollup, never a verdict

`routeOutcomeRunRows` hands outcomes to `deriveMetricsRollup` as run rows. Only outcomes whose identity is
`matched` and whose verification is `passed` or `failed` are handed over. A substituted outcome measured another
model, an unreported one measured a model nobody named, and a `notRun` one has no result; each stays in the store
and none is credited to the requested route. Ingested rows carry no case, so they count toward the route's own
rollup entry and toward no capability. Tokens are taken as provider-reported, and cost is unknown.

`cernum recommend`, `cernum candidates --fallback` and `cernum history <route> --metrics` add these rows to the
rollup they read. No qualification verdict reads them: `deriveRouteQualification`, the qualification timeline and
the routing contract are derived from the sealed benchmark runs alone, under cqp1 by default, and the test
`test/engine/route-outcome-ingest.test.ts` holds a verdict and a timeline unchanged across an ingest.
