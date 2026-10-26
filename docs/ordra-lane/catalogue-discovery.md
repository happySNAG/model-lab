# Catalogue discovery for Claude and Codex (ccd1)

Block 3, B3-2. `src/engine/catalogue-discovery.ts` records what the Codex CLI and the Anthropic API
list as models, and records that the Claude CLI cannot list any. It gives the release watcher (cmd2,
cdd1 and crl1, see [model-lifecycle.md](model-lifecycle.md)) a source of Claude and Codex identifiers.
Local Ollama discovery is separate and unchanged.

**Discovered is not reachable, and reachable is not qualified.** Every row carries all three states as
separate fields, and no field is derived from another. Nothing is read from a model's name: not
availability, not capability, not price.

## One outcome per provider

| Provider | What is asked | Outcome | Rows |
|---|---|---|---|
| `codexCLI` | `codex debug models`, read with the existing `parseCodexCatalogue` (`codex-cli.ts`) | `listed`, source `catalogue` | One per entry with `visibility: list`. A `hide` entry is put in `omitted` with its reason. |
| `claudeCLI` | Nothing. `claude` documents no model-listing command. | `cannotList`, `probe: offline`, with the reason `CLAUDE_CLI_CANNOT_LIST_MODELS` | None. This means "the tool cannot tell you". It does not mean "the account has no models". |
| `anthropicAPI` | `/v1/models` through `discoverMeteredProvider`, **only when `credentialStatus` already reports a configured credential** | `listed`, source `accountListing`, with `credentialSource` (`environment` or `keychain`) | One per listed identifier. |

Other outcomes:

- `notConsulted` (`probe: offline`): `anthropicAPI` with no configured credential, or any provider the
  provider allowlist (cpa1 unless overridden) leaves out (then `refusedByAllowlist` names the list's
  version). The reader is not called.
- `notAnswered` (`probe: invoked`): the reader failed or threw, the output did not parse, or the listing
  came back non-OK. This is recorded, never thrown, and gives no rows.

### Credentials

This module never adds, stores, prints or changes a credential. It asks `credentialStatus` whether one
is present and records only where it was found. A missing credential is `notConsulted`: nothing is sent,
and the remedy text names the variable and the Keychain service without a value. The value is used
only inside `discoverMeteredProvider`, the same reader `cernum discover` already uses.

## A row

| Field | Meaning |
|---|---|
| `routeKey`, `provider`, `modelID` | `provider:modelID`, the key discovery and qualification use. |
| `source` | `catalogue` (a client-side catalogue: what the tool knows about) or `accountListing` (what the provider advertises to this credential). |
| `discovered` | Always `{ state: 'listed', source, observedAt, detail }`. A listing named this route. |
| `reachable` | `unproven` with a reason, unless the caller supplies a recorded smoke result for this exact route key (`proven` or `refused`, with its source). A listing never sets it. |
| `qualified` | `notEvaluated` with a reason, unless the caller supplies a recorded qualification verdict for this exact route key (`qualified`, `notQualified`, `insufficientEvidence` or `notExercised`, with its source). Discovery never qualifies. |
| `displayName` | `Known<string>`: the name the listing published, or `unknown`. A slug, a ladder name or an id is never put in its place. |
| `declaredEfforts` | `Known<string[]>`: the effort levels the Codex catalogue declares, as the catalogue's claim, or `unknown`. |

A supplied smoke result moves only `reachable`, and a supplied verdict moves only `qualified`.
cqp1 and its 90% threshold are not read or changed here.

## Feeding discovery refresh

`catalogueDiscoveryProbe(report, provider)` turns one provider's outcome into a `DiscoveryProbe` for
`refreshDiscovery`. Only a `listed` outcome refreshes, and its routes arrive with `listed: true` and
`availability: 'unproven'`. For `cannotList`, `notConsulted` and `notAnswered`, nothing was re-observed.
The provider's earlier routes are carried forward and their delta is `notRefreshed`, never
`disappeared`.

## Offline core, real readers kept apart

`discoverCatalogues({ now, readers, credentials?, allowlist?, providers?, reachability?, qualification? })`
takes its two readers as arguments and runs nothing itself. `defaultCatalogueReaders()` builds the real
ones: `codexCatalogueReader()` runs `codex debug models` through `runCLI`, and the Anthropic reader
calls `discoverMeteredProvider`. Building them sends nothing. No command calls them yet, and they are
for an authorised caller only.

## Tests

`test/engine/catalogue-discovery.test.ts` uses only the recorded outputs in
`fixtures/catalogue-discovery/` (`codex-debug-models.json`, `anthropic-v1-models.json`) and injected
fakes: a fake `run` and `findExecutable` for Codex, and a fake `fetch`, environment and Keychain reader
for the Anthropic API. The global `fetch` is replaced by a tripwire that fails any test that reaches it.

```
npm test -- test/engine/catalogue-discovery.test.ts
```
