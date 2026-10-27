# Ordra pass classifier — `cpc1`

Ordra plans each pass as a record: a display number, an objective, a scope, the verification commands
and the worker's authority (the `pass_planned` payload). Task taxonomy [`ctt1`](task-taxonomy.md) needs
a task type and a structural tier. This feature reads the record and names both, using fixed,
documented rules. The answer names every rule that fired.

```
cernum classify-pass <file> [--json]
```

The code is `classifyPassRecord` and `classifyPassFile` in `src/engine/pass-classifier.ts`. Tests:
`test/engine/pass-classifier.test.ts`. Fixtures: `fixtures/pass-classifier/` (13 classifiable records
covering gate, verification-only, docs, test-repair, feature, fix, refactor, plan and review passes, and
5 records that must be refused).

**It is not a model and not a selection.** No model reads the record, so the same bytes always give the
same answer. The output is a ctt1 query. It ranks nothing and picks no route. It reads only the file and
writes nothing.

## The record

The file holds one JSON object. That object is the pass record itself, or an Ordra event whose
`payload` is the record. These fields are read:

| Field | Shape | Missing or malformed |
| --- | --- | --- |
| `display_number` | non-empty string, or a number | refused |
| `objective` | non-empty string | refused: the objective is what names the task type |
| `scope` | a list of paths, or an object with `paths`, `in_scope` or `include` (other keys such as `non_goals` are ignored) | refused |
| `verification` | a list of command strings or `{ "command": "…" }` objects; an empty list is allowed | refused when absent: an empty list states "no checks", an absent field states nothing |
| `worker_authority.paths_writable` | a list of paths; an empty list means read-only | refused: whether the worker may write is evidence, never assumed |

Every unreadable field is reported at once.

## Choosing the task type

Each rule that matches adds its weight to one task type. Rules can also **rule out** a type. A type can
be chosen only if the **objective** names it and no rule rules it out. The chosen type is the eligible
type with the highest score.

### Objective rules

Code spans (`` `…` ``), paths (any token containing `/`) and file names (tokens ending in an extension)
are removed from the objective before it is read. So `test/engine/x.test.ts` is not the word "test", and
`docs/…` is not the word "docs". Words are matched whole, with their `-s`, `-es`, `-ed`, `-d` and `-ing`
forms.

| Rule | Weight | Matches |
| --- | --- | --- |
| `objective.phrase.*` | 4 | one of the phrases below, anywhere in the objective |
| `objective.leading-verb` | 3 | the objective's first word, if it is in the word table |
| `objective.keyword` | 1 | any later word in the word table; each distinct word counts once |

Phrases. These are more specific than any single word, so they outweigh a leading verb. "Repair the
failing test" is test repair, not fix.

| Rule | Task type | Phrase |
| --- | --- | --- |
| `objective.phrase.failing-tests` | `test-repair` | "failing test(s)", optionally "failing unit / integration / e2e / end-to-end test" |
| `objective.phrase.tests-failing` | `test-repair` | "test(s) (that) fail / fails / failed / failing / are failing / is failing / went red / broke / are broken / is broken" |
| `objective.phrase.back-to-green` | `test-repair` | "back / return / restore … to green" |
| `objective.phrase.repair-tests` | `test-repair` | "repair (the) (failing / broken / red) test(s)" |
| `objective.phrase.flaky-test` | `test-repair` | "flaky test(s)" |
| `objective.phrase.behaviour-preserved` | `refactor` | "without changing (its / the / any) (observable) behaviour", "behaviour-preserving", "no functional / behavioural change" |
| `objective.phrase.update-docs` | `docs` | "update (the) README / docs / documentation / changelog" |
| `objective.phrase.verification-only` | `verify` | "verification-only" |
| `objective.phrase.review-change` | `review` | "code review", "review (the / this) diff / change / changes / commit / commits / branch / PR" |

The word table:

| Task type | Words |
| --- | --- |
| `implement` | add, implement, build, create, introduce, support, wire, extend, expose, enable, ship |
| `fix` | fix, repair, correct, resolve, patch, debug, bug, defect, regression, crash, broken |
| `test-repair` | flaky |
| `refactor` | refactor, rename, extract, restructure, reorganise, reorganize, consolidate, deduplicate, simplify, split, inline |
| `docs` | document, documentation, readme, changelog, describe, explain |
| `verify` | verify, check, confirm, validate, run, rerun, re-run, gate, smoke, prove |
| `plan` | plan, design, propose, investigate, assess, survey, outline, spike |
| `review` | review, inspect, critique, audit, examine |

### Authority, scope and verification rules

A **docs path** is under `docs/` or `doc/`, is a README or CHANGELOG, or ends in `.md`, `.mdx`, `.rst`,
`.adoc` or `.txt`. A **test path** is under `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`,
`fixture/` or `fixtures/`, or is a `*.test.*` or `*.spec.*` file. Paths are classified by shape only.

| Rule | Source | Effect |
| --- | --- | --- |
| `authority.read-only` | `paths_writable` is empty | rules out `implement`, `fix`, `test-repair`, `refactor` and `docs`: the worker may write nothing |
| `authority.docs-only` | every writable path is a docs path | `docs` +2; rules out `implement`, `fix`, `test-repair` and `refactor` |
| `authority.tests-only` | every writable path is a test path | `test-repair` +2; rules out `implement` and `docs` |
| `scope.docs-only` | every scope path is a docs path | `docs` +1 |
| `scope.tests-only` | every scope path is a test path | `test-repair` +1 |
| `verification.none` | no verification command | rules out `verify`: a verification pass is one that runs checks |
| `verification.checks-only` | commands listed and the worker may write nothing | `verify` +1 |
| `verification.runs-scoped-test` | a command names a test path the scope names | `test-repair` +1 |

The non-objective rules add weight, but they cannot choose a type by themselves. For example, a plan
pass allowed to write only `docs/ordra-lane/block-5-plan.md` scores `docs` +2 from its authority. It is
still classified `plan`, because the objective names `plan` and does not name `docs`.

## Choosing the tier

Each tier rule indicates one tier. The chosen tier is the **highest** tier any rule indicates.
Under-sizing a pass would route it on evidence from easier work.

| Rule | Reads | tier1 | tier2 | tier3 |
| --- | --- | --- | --- | --- |
| `tier.verification-count` | number of verification commands (when at least one) | 1–3 | 4 | 5 or more |
| `tier.scope-count` | number of scope paths (when at least one) | 1–3 | 4–7 | 8 or more |
| `tier.scope-areas` | distinct first path segments in scope (when at least one) | 1–2 | 3–4 | 5 or more |
| `tier.cross-cutting` | the objective says cross-cutting, architecture, architectural, migrate, migration, end-to-end, "across the / all / every", or "every caller / module / command / provider / surface / package" | — | — | always |

The verification-count thresholds are the `verificationCommandCount` minima of the workspace tier bands
in `src/engine/workspace-difficulty.ts`.

## Confidence

- `typeShare` is the chosen type's score divided by the summed scores of every type not ruled out.
- `tierAgreement` is the share of tier rules that indicated the chosen tier.
- `sourcesAgreeing` is how many parts of the record (objective, scope, verification, authority) gave
  evidence for the chosen type.
- `value` is min(`typeShare`, `tierAgreement`), rounded to two places.
- `level` is `high` when `value` ≥ 0.75 and at least 2 sources agree, `medium` when `value` ≥ 0.5, and
  `low` otherwise.

A low confidence is reported, not refused. The caller can see from the evidence why it is low.

## Refusal, never a default

A record no rule classifies is **refused with every reason**, exit 2. It never gets a default type or
tier. A pass mapped to the wrong type would be routed on evidence about different work. The tier is
never defaulted either.

- **No objective rule matched.** The objective names no ctt1 task type, for example "Tidy up the
  ordra-lane folder."
- **Ruled out.** Every type the objective names is ruled out, for example "Implement …" with an empty
  `paths_writable`.
- **A tie.** Two eligible types have the same top score. A tie is never broken by a default order.
- **Nothing measures the size.** There is no scope path, no verification command and no cross-cutting
  objective.
- **Unreadable record.** The file is not JSON, the value is not an object, or a field above is missing
  or malformed.

## The answer

With `--json` the command prints `file` plus:

- `schema` (`cpc1`), `taxonomyVersion` (`ctt1`), `ok`, `displayNumber`, `sourceDigest` (sha256 of the
  file).
- When classified:
  - `taskType` and `tier`.
  - `evidence.taskType`: every rule that supported the type, with `rule`, `source`, `matched`,
    `detail` and `weight`.
  - `evidence.tier`: every tier rule.
  - `evidence.exclusions`: every type ruled out, with its rule and reason.
  - `evidence.scores`: every type's score.
  - `confidence`.
  - `query`.
- When refused: `refusals`, plus `evidence` as far as the rules got (absent when the record could not
  be read).

`query` is the ctt1 query to hand to `recommend`:
`{ taxonomyVersion, taskType, structuralTier, contextTokens: null, contextReason, arguments, command }`.
`command` is, for example, `cernum recommend fix --tier 1 --contract crr2 --json`. The record states no
context requirement, so `contextTokens` is `null` and no `--context` is invented. Add one when it is
known.

Changing a rule, a word or a weight changes how passes are routed, so it needs a new classifier
version. The test pins the weights and checks that every rule and word appears in this document.
