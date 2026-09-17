# Incident — `cernum smoke --help` sent six live requests

**Date:** 2026-09-17 · **Machine:** MacBook Pro (Apple Silicon) · **Build:** Cernum v0.2.2
**Status:** closed by v0.2.3 · **Classification: ACCIDENTAL REQUESTS. NOT BENCHMARK EVIDENCE.**

---

## What happened

A person typed `cernum smoke --help` to find out what the command did.

It did not print help. It began **six Claude CLI identity smoke requests** against the whole Claude
ladder. **At least four completed**, consuming approximately **$0.127 of subscription allowance at
list value**.

**No smoke evidence file was written and no proof state was recorded**, so the four completed
requests established nothing and left nothing behind. The Codex and Union Alpha proof round the
person had actually intended never began.

## Why it happened

Three ordinary decisions in one argument parser. Any one alone would have been harmless.

1. **`--help` was honoured only in the command position.** `cernum --help` worked; `cernum smoke
   --help` parsed `help` as an ordinary option and handed it to a command that never looked for it.
2. **`smoke` defaulted to a live provider.** `positional.length > 0 ? positional : ['claudeCLI']`.
   `--help` produces no positionals, so asking for help selected the default — and with no candidate
   scope either, the default scope was the entire six-configuration Claude ladder.
3. **Unknown options were accepted silently.** Nothing in the program could refuse an argument it did
   not understand, so an unrecognised flag became a no-op rather than a stop.

`-h` was not even recognised as an option: it did not start with `--`, so it was pushed into the
positional list and read as a provider name.

## Disposition of the four completed requests

**These are not benchmark evidence and must never be read as any.** They were not planned, not
scoped, not authorized, and not recorded. They carried the standard nine-word identity prompt, so
they measured nothing about capability even in principle. No ledger, manifest, ranking or report in
this repository includes them, and none may be amended to.

The allowance they consumed is real and is not recoverable. It is recorded here because a cost that
bought nothing is worth remembering accurately.

## What v0.2.3 changed

- **Help is answered before dispatch, for every command**, from a central table — `--help` and `-h`,
  in any position. A command cannot be added without one.
- **`smoke` has no default provider and no default candidate scope.** Both must be named. Naming a
  provider is not consent to its whole ladder.
- **Unknown options refuse with exit code 2** and list what was accepted. Nothing runs.
- **`--dry-run`** on every command that spends, printing exactly which requests would be sent.
- **A pre-flight disclosure** — provider, candidates, request count, authorization class — precedes
  every live execution.
- **Every effectful command was audited** for the same hazard and given a declared option list.

## What would have prevented it

A test that ran `cernum smoke --help` as a subprocess with a recording fake on PATH and asserted the
fake was never invoked. `test/engine/cli-argument-safety.test.ts` is now exactly that, and it fails
against v0.2.2.
