# Routing decision log — `cernum candidates --log` and `cernum decision-log`

The routing decision log is an append-only record of what `candidates` answered. Each logged answer is
one sealed, digested record. It holds the query, the answer, the routing contract, routing policy and
qualification policy versions, the time the answer was given, and what changed since the previous
logged answer to the same query: every route added, removed or reordered, each with its cause, and
every policy version that moved.

**Logging is off by default.** Without `--log`, `candidates` writes nothing, as before. Because it can
now write, `candidates` is declared `writesLocal` in the command table. `decision-log` is read-only.

Module: `src/engine/routing-decision-log.ts` (schema `crd1`). Tests: `test/engine/routing-decision-log.test.ts`.

## Usage

```
cernum candidates <capability> [the usual query options] --log [--json]
cernum decision-log [--root <dir>] [--capability <capability>] [--query <digest prefix>] [--json]
```

| Option | Meaning |
| --- | --- |
| `candidates … --log` | Append this answer to `<root>/.routing-decisions` before printing it. Text output ends with `Logged as <recordID>` and the change lines. With `--json`, the candidate set gains a `loggedDecision` object (`recordID`, `written`, `filePath`, `change`). |
| `decision-log --capability` | Show only answers to queries about this capability. |
| `decision-log --query` | Show only answers to the query with this digest. A prefix is enough. |
| `decision-log --json` | Print the whole log: `decisions`, `corrupt` and `logDigest`. |

Exit codes. `candidates --log` exits 4 and appends nothing when any record in the log fails to verify,
or when the answer is dated before the previous answer to the same query. `decision-log` exits 4 when
any record fails to verify. In text mode it lists each failed record by path, with its reason. With
`--json` it prints the failed records in `corrupt`.

## The record

| Field | Content |
| --- | --- |
| `recordID` | The digest of every other field under the canonical encoding. This is also the file name, `<recordID>.json`. |
| `decidedAt` | When the answer was given. The caller supplies it; the engine reads no clock. |
| `machineKey` | The machine the query asked about. |
| `query` | The `RouteCandidateQuery` exactly as asked (crc2). |
| `queryDigest` | The digest of the query **without** `routingPolicyVersion`. "The same query" is matched on this value. |
| `answer` | The contract, the routing policy version and the ordering rule. Each candidate with its position, group, locality, identity confidence and admission, availability state, capability verdict and reason, and qualification policy id. Every excluded route with every reason. |
| `policies` | `routingContract` (crc2), `routingPolicy` (crp1 or crp2), and `qualificationPolicies` (cqp1). |
| `previousDecisionID` | The previous logged answer to the same query. It is absent only on the first answer. |
| `change` | Compared with the previous answer: `basis` (`firstAnswer`, `unchanged` or `changed`), `added`, `removed`, `reordered`, `policyChanges` and `exclusionsChanged`. |
| `provenance` | What produced the answer. |

The routing policy version is left out of the query key on purpose. Asking the same question under
crp1 and then under crp2 is one question decided under two rules. The log reports this as a
`policyChanges` entry on the later answer.

### Causes

- **Added**: the route was either previously excluded, with the exclusion reasons it had then, or
  not considered at all (it had no availability observation on the machine). The route's current
  qualification reason follows, then any policy change.
- **Removed**: the route is either now excluded, with each current reason, or no longer considered.
  Any policy change follows.
- **Reordered** compares relative order, not index. A route that slides one place because another
  route was added ahead of it is not reordered; the change is recorded as the addition. A route is
  reordered only when its order relative to the other surviving candidates moved. Its cause is one of
  three: its own group changed, it moved relative to routes whose group changed, or the ordering rule
  itself changed.
- **Exclusion reasons that moved** without moving a candidate are counted in `exclusionsChanged`. On
  their own they do not make the answer `changed`.

## Tampering

Records are checked when the log is read, by `readRoutingDecisionLog`. A record that fails a check is
reported in `corrupt` with its path and reason, and is never returned as a decision.

1. **Shape and schema.** A file that is unreadable, is not a JSON object, or does not carry schema
   `crd1` and its required fields fails.
2. **Digest.** The content must digest to `recordID`, and the query must digest to `queryDigest`.
3. **Name.** The file must be named `<recordID>.json`.
4. **Chain.** The previous answer the record names must be present and intact, must answer the same
   query, and must not be dated after the record. A record that claims to be the first answer must
   have no earlier answer to its query. The record's stated `change` must equal the change recomputed
   from its own answer and the previous one. So a record edited and then re-sealed under a new name is
   still refused. When a record is edited or removed, the record after it is refused too.

`appendRoutingDecision` refuses to write while any record fails verification. A change reason
computed against a predecessor nobody can trust would be a confident falsehood.

The chain cannot detect one case: the newest record removed whole. `logDigest`, the digest of every
verified `recordID`, is the value a consumer such as Ordra keeps outside the log to detect that case.

## What it does not do

- It does not rank, choose or recommend. It records the candidate set that `qualifiedRouteCandidates`
  already produced. The set stays unordered within a group.
- It does not change crc2, crp1 or crp2, or qualification policy cqp1. It adds no record kind to the
  observation store.
- It never rewrites or deletes a record. Each file is written once, through a temporary file, fsync
  and rename (`atomicWriteJSON`).
- It contacts nothing. The answer is derived from evidence already on disk, the same way as without
  `--log`.
