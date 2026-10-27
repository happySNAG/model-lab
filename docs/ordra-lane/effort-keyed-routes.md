# Effort-keyed routes — `cek1`

A model at `high` effort and the same model at `max` effort are two experiments. Until this change a
route's qualification record read every run of `provider:model` together, so evidence gathered at two
efforts could be pooled into one verdict. Effort is now a first-class part of a route's identity for
qualification, in an opt-in keyed view beside the pooled one.

The module is `src/engine/effort-keyed-routes.ts`. Tests: `test/engine/effort-keyed-routes.test.ts`.

## The key

| Evidence | Key | Example |
| --- | --- | --- |
| The tool's own telemetry measured the effort it applied | `provider:model@<applied effort>` | `codexCLI:gpt-6-astra@medium` |
| Nothing observed the effort | `provider:model@unobservable:<requested effort>` | `claudeCLI:claude-haiku-4-5@unobservable:high` |
| Nothing observed it and the run recorded no request | `provider:model@unobservable:unrecorded` | |

The effort levels are `EFFORT_LEVELS` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The
notation is the ladder's `provider:model@effort`, as `parseFrontierSpec` names a candidate, except that
`@none` is always written: an observed `none` and an unobservable effort must never print the same way.

## When an effort is observed

`rowEffortKey` decides, from the run row alone:

- **Observed** only when the row carries an applied-effort verdict of `appliedEffortVerified`,
  `appliedEffortMismatch` or `appliedEffortNotRequested` and its `appliedEffort` is a level this engine
  models (`workspace-effort-evidence.ts`; today that is Codex runs with an OTLP collector attached). The
  key is the **applied** effort. An `appliedEffortMismatch` run asked for one effort and ran at another;
  it is evidence at the effort it ran at, and `evidenceEffort.mismatchedRunCount` counts such runs.
- **Unobservable** otherwise. That includes `appliedEffortUnavailable` and `appliedEffortAmbiguous`, a
  measured value the engine does not model, and every run whose driver measures no applied effort (every
  Claude, OpenCode and Ollama run). A requested effort that was sent and accepted is not an observed
  effort: an accepted request is not an honoured one.

Unobservable evidence is keyed by what was **requested**, so `@unobservable:high` and
`@unobservable:max` are two keys, never one. No effort is ever read from a model name, a candidate label
or a default.

## Qualification and history per key

- `deriveRouteQualification({ …, effortKey })` reads only the runs under that key. The record's `effort`
  is the observed level, or `unobservable`, and it carries `evidenceEffort`: the effort route key, the
  state, the observed level, the efforts requested, the run count, the mismatch count, the telemetry
  source or the reason nothing observed it, and `notKeyed` (prose rankings carry no effort, so a keyed
  record leaves them out and says so). A development report measures no applied effort, so it counts only
  toward the unobservable key of the effort it asked for. `effort` and `effortKey` together are refused.
- `deriveQualificationHistory({ …, effortKey })` builds the timeline from that key's runs alone, and the
  history names `effortRouteKey`.
- Every verdict is still decided by the qualification policy given, cqp1 by default, with its 90%
  threshold. Keying changes which runs a verdict reads, never the rule.

## `cernum candidates --by-effort [--json]`

The same query, the same routes, answered once per effort key. For each route available on the machine,
every effort key its sealed runs fall under gets its own record, and each record is put to the crc2 rules
on its own (`effortKeyedRouteCandidates`), so an exclusion and its reasons belong to one key. The answer
is schema **`cek1`**:

- `contract: "crc2"`, the rules each key was answered under;
- `candidates`, each a crc2 candidate plus `effortRouteKey` and `evidenceEffort`;
- `excluded`, each with `effortRouteKey`, `routeKey`, `evidenceEffort` and every reason;
- `unkeyed`, routes the query could see that no sealed run measured at any effort;
- `ordering` (zero marginal cost first, then route key, then effort key: observed levels, then
  unobservable), `disclosure` and `effortDisclosure`.

It is read-only and never a selection. `--by-effort` is refused beside `--fallback` or `--log` (exit 2),
because those answer crc2.

## What does not change

Without an effort key the record and the history are byte-identical to what they were: no
`evidenceEffort`, `effort: "any"`, every run of the route pooled. `cernum candidates` without
`--by-effort`, including `--json`, `--task`, `--fallback` and `--log`, prints crc2 exactly as before.
Ordra reads crc2, and cek1 is a new contract beside it.
