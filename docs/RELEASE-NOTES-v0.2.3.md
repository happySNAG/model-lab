# Cernum v0.2.3 — asking a question must not cost money

**A corrective release, and the first one that makes OpenCode a provider Cernum can actually run.**

Two things happened on a MacBook Pro. A person asked a command what it did and was charged for the
question. And when they went to prove the model they actually wanted, they found Cernum could
discover it but had never been able to send it a single request.

---

## 1. `cernum smoke --help` sent six live requests

**It did not print help.** It began six Claude CLI smoke requests against the whole Claude ladder.
At least four completed, consuming roughly **$0.127 of subscription allowance at list value**. No
evidence file was written and no proof state was recorded, so **the spend bought nothing.**

Three ordinary decisions in one argument parser, none dangerous alone:

| | |
| --- | --- |
| `--help` was honoured **only in the command position** | `cernum --help` worked; `cernum smoke --help` did not |
| `smoke` **defaulted to a live provider** | no positional argument meant `claudeCLI` — and `--help` produces no positionals |
| unknown options were **accepted and ignored** | nothing could refuse an argument it did not understand |

`-h` was not recognised as an option at all: it does not start with `--`, so it was read as a
provider name.

The four completed requests are recorded as an **accidental-request incident and explicitly not as
benchmark evidence** — see [`docs/incidents/2026-09-17-accidental-smoke-requests.md`](incidents/2026-09-17-accidental-smoke-requests.md).
No ledger, manifest, ranking or report includes them, and none will be amended to.

### What changed

- **Help is answered before dispatch, for every command.** `--help` and `-h`, in any position, from a
  central command table. A command cannot be added without one, and cannot spend on its way to
  printing one.
- **`smoke` requires an explicit provider AND an explicit candidate scope.** There is no default
  provider and no default candidate set. Naming `claudeCLI` is not consent to its six-request ladder:
  `--models <id,…>` names them, or `--all-ladder` asks for the whole thing deliberately.
- **Unknown options refuse with exit code 2**, list what was accepted, and run nothing.
- **`--dry-run`** on every command that spends, printing exactly which requests would be sent.
- **A pre-flight disclosure** precedes every live execution: provider, candidates, request count and
  authorization class — and `subscriptionIncluded` is spelled out as *"consumes a finite plan
  allowance you already pay for. Not free."*
- **Every effectful command was audited.** All 25 now declare their effect class and their options.
  The audit found options read inside helpers (`--pricing`, `--thinking`, `--observe-only`,
  `--admit-identity-unverifiable` on `create`) that a glance at the function bodies would have missed.

`--root` and `--endpoint` are accepted everywhere, because they say *where things are* rather than
what to do and wrappers reasonably append them to every call. Everything else is declared by the
command that reads it, so `--modles` is still refused.

---

## 2. OpenCode can now be executed, not just discovered

v0.2.2 correctly stopped calling a catalogue listing a proof — and left OpenCode with **no way to
ever be proven**, because Cernum had no OpenCode execution adapter. `opencode/union-alpha` could be
named in a plan and never run.

### How the adapter was built, which matters more than usual

This engine has written a CLI adapter from assumption exactly once, and its tests used the same
assumption, so a wholly broken adapter passed for weeks.

- **The invocation** was read from `opencode run --help`, which sends nothing:
  `-m/--model provider/model`, `--format json`, `--dir`, `--variant`, `--pure`.
- **The response envelope** was read from the **generated types that ship with the tool** —
  `@opencode-ai/sdk/dist/gen/types.gen.d.ts`, where `AssistantMessage`, `TextPart`, `RetryPart` and
  the five error variants are declared by OpenCode itself.
- **No request was sent to any model** while writing or testing this, and none is sent by the tests.
  Every fixture is shaped from those declarations and replayed by a fake executable.

### What it does

- Invokes OpenCode **non-interactively**, with the model named explicitly in OpenCode's own
  `provider/model` addressing, `--format json`, `--pure`, and **an empty working directory created
  and removed around each request** — OpenCode is a coding agent, and a request run in a real
  directory can read what is in it.
- Captures **exit status, answer text, latency, retries, token telemetry (input, output, reasoning,
  cache read/write), cost and finish reason** where OpenCode reports them.
- **Marks what it does not have.** No `tokens` block means `usageProvenance: 'unavailable'`, never a
  zero. OpenCode's cost is **never** filed as subscription allowance — it is metered, and saying
  otherwise would report a per-token bill as plan usage.
- **Reads identity from the reply and never from the request.** `providerID`/`modelID` rejoined as
  OpenCode addresses them. No identity in the reply means `reportedModelID` stays empty; a different
  model answering is a **mismatch**, not a result.
- Classifies failures from the envelope before the exit code, so a `ProviderAuthError` is
  `notAuthenticated` and is never retried three times over.

### Execution proof and identity are still two different things

A successful authorized request proves **execution**. What it proves about **identity** is decided
separately, by what the reply said: `proven` when OpenCode names the model asked for, `unverifiable`
when it answers and names nobody, `substituted` when it names another. A request succeeding is never
allowed to imply who answered it.

### Integrated, not bolted on

Smoke, campaign manifests, ledgers, guards, checkpoint/resume and reports all reach OpenCode through
the **same adapter factory** a campaign uses — `smoke` used to construct a subscription adapter
unconditionally, which is why engine support would not have reached it. A new authorization mode,
**`toolManagedCredential`**, records what is actually true of OpenCode: metered, and holding its own
credential. Neither existing mode was honest — `apiKeyEnvironment` claims Cernum knows where a key
lives, and `subscriptionCLISession` would assert a subscription for something billed per token.

A metered OpenCode campaign still **refuses to freeze without a pricing snapshot**. Cernum will not
estimate from prices it invented.

---

## Tests

**1397 unit and parity tests** (up from 1354), **22 E2E passing** (up from 15), typecheck clean, both
macOS architectures built.

43 tests added. The CLI safety tests spawn the real command as a subprocess with a **recording fake
on PATH** and assert the fake was never invoked — a test that accidentally sent a request would be
the failure it is looking for. They fail against v0.2.2.

**Six E2E remain blocked, and not by this release.** Every campaign-execution test aborts at
`disk.freeSpace: free 13.9 GiB, floor 15.00 GiB`. That is the machine, not the code: reproduced by
hand outside Playwright and identical on earlier commits. The same guard means **no scored campaign
can run on that machine until ~1 GiB is freed.**

## Checksums

```
shasum -a 256 -c Cernum-0.2.3-SHA256SUMS.txt --ignore-missing
```

## Opening an unsigned build

Not signed with a Developer ID and not notarized:

```
xattr -dr com.apple.quarantine /Applications/Cernum.app
```
