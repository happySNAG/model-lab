# `cernum history <route>` — one route's qualification verdicts over time

`history` prints the timeline of one route's qualification verdicts, oldest first. For each verdict it
gives the qualification policy id, the routing policy version, the verdict, every blocker, the evidence
window behind it, and the time it is derived at.

**It is read-only.** The observation store and the sealed workspace runs are read where they are. No
verdict is stored, and the command creates no file, not even in an empty root.

## Usage

```
cernum history <route> [--root <dir>] [--machine <cmk1:key>] [--policy crp1|crp2]
                       [--evidence-roots <dir>[,<dir>…]] [--json]
```

| Option | Default | Meaning |
| --- | --- | --- |
| `<route>` | required | `provider:model`, for example `claudeCLI:claude-haiku-4-5`. Split at the first colon, so `ollama:gemma3:4b` is provider `ollama`, model `gemma3:4b`. |
| `--root <dir>` | the default campaign root | Where the observation store (`<root>/.observations`) and the sealed workspace runs are read from. |
| `--machine <key>` | this machine | The `cmk1:` key that availability and discovery are answered for. |
| `--policy` | `crp2` | The routing policy each verdict is decided under, as with `candidates`. |
| `--evidence-roots` | none | More campaign roots to read sealed runs from. A run reached through two roots counts once. A root that does not exist is refused. |
| `--json` | | Print the whole history (schema `cqh1`) as JSON. |

Exit codes: 0 when the history is printed. 2 when no route is named, the argument is not
`provider:model`, `--policy` is not `crp1` or `crp2`, an evidence root is missing, or **the route is
unknown**, meaning no observation in the store names it and no sealed run measured it. A refusal
prints the reason and derives nothing. In text mode the command also exits 2 when a store file did not
verify, after it prints the history and lists that file.

## How each verdict is derived

The engine is in `src/engine/qualification-history.ts` (`deriveQualificationHistory`). It is pure: it
takes the store contents and the run rows as values.

1. **The instants.** One instant for each time the route's evidence moved:
   - each sealed workspace run of the route, at its `recordedAt`, whichever machine ran it, and
   - each observation about the route made **on the machine asked about**, at its `observedAt`. An
     observation is about the route when its `routeKey` matches, or when it is a `discoverySnapshot`
     that lists the route.

   An observation made on another machine is not an instant, because it cannot move a verdict on this
   machine.
2. **The evidence as it stood.** At each instant the store is cut to the observations made by then,
   and the runs to those recorded by then. Then `deriveRouteQualification` is called with `now` set to
   that instant. It gets the latest discovery snapshot on the machine (`latestDiscoverySnapshot`), the
   availability observations (`observationsForRouting`), the workspace cases and difficulty profiles,
   and the spend posture at that instant. These are the same readers `candidates` uses.
3. **The entry.** The record is reduced to:
   - `recordedAt`, `policyID` (`cqp1` unless a caller passes another), and `routingPolicyVersion`
   - `verdict` (`safeToRoute` or `notRoutable`), `routableCapabilities`, and each capability's verdict
   - `blockers`, each with its kind and reason
   - `evidenceWindow`: the earliest and latest evidence instant, with counts of runs and observations
   - `triggeredBy`: the runs or observation records that made this an instant
   - `stalenessRecorded`: any `qualificationStaleness` observations recorded at that instant, as stored
   - `changed`: false when the verdict, the capability verdicts and the blocker kinds all match the
     previous entry

A run whose `recordedAt` cannot be read as a time is listed under `undatedWorkspaceRuns` and is not
placed on the timeline.

## What it is not

- **Not a record of what an earlier build said.** It is what this build's read model says about the
  evidence as it stood at each instant. The policy ids on every entry say which rules produced it.
- **Not a new qualification rule.** Every verdict is a `deriveRouteQualification` record under `cqp1`.
  This command does not change, add or rank policies.
- **Not a writer.** The tests hold it to this: the campaign root's bytes are identical before and after
  the command, and an empty root stays empty.

## Tests

`test/engine/qualification-history.test.ts` uses fixtures only. A scripted matrix seals three real runs
against the repository's fixtures, with no provider involved. Observations are sealed by the store's own
constructors into temporary roots, and the command is spawned with `--machine`, so it never reads this
Mac's identity.
