# Ordra task taxonomy — `ctt1`

Ordra knows what a pass is for: implement, fix, review. It also knows how large the pass is and how
much context it needs. It does not know which capability names that work. This feature is that
translation. It uses one documented, versioned table, **`ctt1`**, and one pure function.

The function is `routeQueryForTask` in `src/engine/task-taxonomy.ts`. It takes a machine key, a task
type, a structural tier and a context requirement in tokens. It returns a crc2 `RouteCandidateQuery`
with `capability`, `structuralTier`, `minimumContextTokens`, `costPolicy`, `localOnly` and
`preferSubscriptionOrFree` set. It reads nothing and writes nothing. Tests:
`test/engine/task-taxonomy.test.ts`.

**It adds no measurement, no policy and no ranking.** The query it returns is answered by
`qualifiedRouteCandidates` exactly as a hand-written query would be. It picks no route.

## The table, `ctt1`

| Task type | Capability | Cost policy | Local only | Prefer subscription or free | Why |
| --- | --- | --- | --- | --- | --- |
| `implement` | `workspace:multiFileEditing` | `zeroMarginalCostOnly` | no | yes | New behaviour lands across the files it touches. |
| `fix` | `workspace:failureInterpretation` | `zeroMarginalCostOnly` | no | yes | A fix starts from what a failing check says and finds the cause from it. |
| `test-repair` | `workspace:testExecution` | `zeroMarginalCostOnly` | no | yes | The work is running the suite and bringing a failing test back to green. |
| `refactor` | `workspace:preservationUnderTransformation` | `zeroMarginalCostOnly` | no | yes | Structure changes; behaviour stays exactly as it was. |
| `docs` | `workspace:scopeDiscipline` | `zeroMarginalCostOnly` | no | yes | A documentation pass must not touch what it was not asked to change. |
| `verify` | `workspace:contractOverVisibleTests` | `zeroMarginalCostOnly` | no | yes | Verification checks the stated contract, not only the visible checks. |
| `plan` | `workspace:repositoryComprehension` | `zeroMarginalCostOnly` | no | yes | A plan needs the repository understood well enough to say what to change and where. |
| `review` | `workspace:regressionAvoidance` | `zeroMarginalCostOnly` | no | yes | A review looks for what a change would break. |

Every row asks for zero marginal cost only. That is the V1 default. Admitting metered routes is a
spending decision the owner makes; it is not a property of a task type. No row is local only, because
locality is a property of the machine and the evidence, not of the work.

The tier and the context requirement pass through unchanged:

- The tier is `1`, `2` or `3` (the name `tier1`, `tier2` or `tier3` is also accepted). It becomes
  `structuralTier`, so the route must also be qualified at `workspace-tier:<tier>`.
- The context requirement is a positive whole number of tokens. It becomes `minimumContextTokens`.

The table is pinned to `ctt1` by the test. Changing a row changes which evidence a pass is routed on,
so any change needs a new taxonomy version.

## The table, `ctt2`

`ctt2` stands beside `ctt1` and changes nothing in it. It is `ctt1`'s eight rows, unchanged, plus one:

| Task type | Capability | Cost policy | Local only | Prefer subscription or free | Why |
| --- | --- | --- | --- | --- | --- |
| `preservation-critical` | `workspace:forwardCompatibilityReasoning` | `zeroMarginalCostOnly` | no | yes | The work must keep what exists working as the code moves forward: the capability the forward-compatibility pack `pack.cernum.workspace.forward-compat-one@1` measures. |

The function is `routeQueryForTaskCtt2` (and `routeQueryForTaskUnder` by version name). It reads the tier,
the context and the machine key exactly as `ctt1` does and refuses in the same words, naming `ctt2` and its
nine types. `ctt2` is chosen **only** by an explicit `--taxonomy ctt2` on `cernum candidates --task` or on
`cernum recommend … --contract crr2`. Without `--taxonomy` every answer is `ctt1`, exactly as before; an
unknown `--taxonomy` value is refused with the reason and exit 2. The status export, the pass classifier
(cpc1) and outcome ingest stay on `ctt1`.

No route holds `workspace:forwardCompatibilityReasoning` evidence until the forward-compatibility pack has
been run, so today `preservation-critical` correctly ranks nothing. Tests:
`test/engine/task-taxonomy-ctt2.test.ts`.

## Refusal, never a default

An input the table cannot read is **refused with the reason**. Nothing is guessed. A pass mapped to the
wrong capability would be routed on evidence about different work, and a candidate set for the wrong
question looks exactly like one for the right question.

- An unknown task type is refused. It is never mapped to a default capability.
- A tier other than 1, 2 or 3 is refused, and so is a missing tier.
- A context requirement that is not a positive whole number of tokens is refused.
- Every refusal is reported at once, so one answer names everything that is wrong.

## The command

```
cernum candidates --task <type> --tier <n> --context <tokens> [--taxonomy ctt1|ctt2] [--machine <cmk1:…>] [--json] [--log]
```

The query comes from the table, not from the flags. A capability, `--min-context`, `--cost-policy` or
`--local-only` beside `--task` is refused rather than mixed in. `--context` without `--task` is refused.
A refusal exits 2 and reads nothing. `--require-verified-identity`, `--policy`, `--evidence-roots` and
`--log` work as they do for a capability query. With `--json` the answer carries a `task` field naming
the taxonomy version, the task type and the row that was applied.
