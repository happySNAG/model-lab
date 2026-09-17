# Cernum v0.2.2 — a listing is not a proof, and a migration is not a move

**A corrective release.** Two claims Cernum made about itself were wrong, and both were the kind that
only matters later: one would have let a scored campaign spend money on a model nothing had ever
called, and the other described an untouched backup folder that the code had already emptied.

No campaign, score, ledger, manifest or published result is changed by this release. What changes is
what Cernum *asserts*.

---

## 1. OpenCode models were marked `proven` on the strength of a catalogue

**What v0.2.1 did.** Every model `opencode models` returned was recorded as **`proven`** — the one
availability state a campaign builder will select. So this chain ran to completion:

> OpenCode is installed → a credential is configured → a listing names 70 models → all 70 are
> selectable for a scored, billed campaign.

Not one link in that chain is a model having answered anything.

**Where the listing actually comes from**, checked on the machine rather than assumed:
`~/.cache/opencode/models.json`, a cached catalogue holding **7,850 models across 221 providers** — a
description of the world, not of your account. `opencode models opencode` narrows it to one provider
and printed 70 of the 103 entries the catalogue carries there. Some filtering happens; none of it is
a per-model entitlement check, and none of it is a reply from a model. Holding a credential does not
close the gap either: a configured key says a service was signed into, never that a particular model
will answer.

Cernum already refuses exactly this inference for Codex — `codex debug models` renders a catalogue of
what the client knows about, the service refuses models that appear in it, so the listing proves
nothing about the account. **OpenCode was given the opposite treatment by accident.**

**What v0.2.2 does.**

| | v0.2.1 | v0.2.2 |
| --- | --- | --- |
| `opencode/union-alpha` after discovery | `proven` | **`unproven`** |
| `verifiedModelID` | `opencode/union-alpha` | **empty** — nothing returned an identifier |
| Selectable for a campaign | yes | **no** |
| An identifier OpenCode does not name | `refused` | `refused`, and the evidence now adds that being named would not have proven it either |

`proven` now means what it says: **a request that was authorized, was sent, came back, and was
written down.** The type itself is documented that way, and the distinction it draws is between an
*account-scoped* listing — a metered API's `/v1/models`, answered with your own key — and a
*client-side catalogue*, which never reaches `proven`.

**There is no OpenCode proof path today, and Cernum says so.** `adaptersFor` binds `claudeCLI`,
`codexCLI`, `anthropicAPI` and `openaiAPI` and nothing else, so Cernum has no OpenCode execution
adapter and no request it could make. A bare `unproven` would read like a chore with a command that
fixes it; the status text states plainly that there is none, and `cernum smoke opencodeCLI` refuses
by name rather than implying otherwise.

**If you ran discovery under v0.2.1, your stored evidence says `proven`.** Re-run
`cernum discover opencodeCLI` under v0.2.2 and those records are rewritten.

---

## 2. The rename migration MOVED your data while saying it never deletes

**What v0.2.0 and v0.2.1 did.** The first launch after the rename carried `campaigns/`, `evidence/`,
`settings.json` and `model-lab.log` from `Model Lab` into `Cernum` using `fs.renameSync`, with a
copy-then-`fs.rmSync` fallback across devices. Both take the source away.

The code's own header said *"It NEVER deletes"*, and the v0.2.0 release notes said *"The migration
never overwrites and never deletes"* immediately above a sentence describing a move that *"copies
before removing the source"*. The two halves contradicted each other, and the reassuring half was the
one people read.

**This happened.** On a MacBook Pro on 2026-09-17, `evidence/` and `model-lab.log` left the
`Model Lab` folder on first launch. Nothing was lost — both were intact under `Cernum` — but the old
folder was not the untouched backup the notes promised.

**Why the tests did not catch it.** Every migration test asserted the destination was populated. Not
one asserted the *source* still existed, so "carried across" and "taken away" were indistinguishable
to the suite.

**What v0.2.2 does.**

- **Copies. Never moves.** There is no code path in the migration that renames, unlinks or removes
  anything inside the legacy directory. The one `rm` in the file removes a **partial destination**
  the migration itself just created and could not finish.
- **Idempotent, decided by content.** A second launch compares both sides by relative path, then
  size, then SHA-256. Identical means *already carried across* — reported, and not a conflict, so the
  normal state of every migrated machine stops reading as a problem.
- **Conflict-safe.** Present on both sides with different contents means **both are left alone** and
  a person decides. Work done in Cernum after the migration is never copied over.
- **Failure costs nothing.** A copy that fails leaves the original untouched and removes its own
  half-written destination, so a later launch does not mistake a partial copy for a conflict.
- **Says so.** The result carries `sourcePreserved`, the log states the old directory was left
  intact, and `migrated-from.json` records `copied` rather than `moved`.

After migrating, **your data exists in both places.** That is deliberate: a move makes the old
directory an unreliable witness, and duplication buys a second opinion for the price of disk. Delete
the old folder yourself once you are satisfied.

### Recovering a machine that already ran v0.2.0 or v0.2.1

If `evidence/` or `model-lab.log` left your `Model Lab` folder, they are under `Cernum`. Copy them
back — verifying first, and without touching Cernum's copies:

```bash
SUPPORT="$HOME/Library/Application Support"
# Confirm what is missing on the old side and present on the new.
for item in evidence model-lab.log; do
  printf '%-16s legacy:%s  cernum:%s\n' "$item" \
    "$([ -e "$SUPPORT/Model Lab/$item" ] && echo yes || echo MISSING)" \
    "$([ -e "$SUPPORT/Cernum/$item" ] && echo yes || echo missing)"
done
# Copy back only what is missing. -n never overwrites; the Cernum copy is the source and is unchanged.
cp -Rn "$SUPPORT/Cernum/evidence"       "$SUPPORT/Model Lab/evidence"
cp -n  "$SUPPORT/Cernum/model-lab.log"  "$SUPPORT/Model Lab/model-lab.log"
# Prove the restore by hash, not by eye.
diff -r "$SUPPORT/Cernum/evidence" "$SUPPORT/Model Lab/evidence" && echo "evidence/ matches"
shasum -a 256 "$SUPPORT/Cernum/model-lab.log" "$SUPPORT/Model Lab/model-lab.log"
```

Once both sides match, v0.2.2's migration will report them as *already carried across* on every
future launch and will not touch either copy again.

---

## What did **not** change

The scoring policy registry and its digests, every suite identifier, the evidence store manifest
format, all provider cost and billing reporting, campaign execution, and the v0.2.1 executable-lookup
and discovery-routing fixes. **Every historical campaign and every frozen evidence manifest is
untouched.**

Windows remains on v0.2.0 (issue #1) and is unaffected by either defect fixed here in its published
build — it carries the v0.2.1 routing gap instead.

---

## Verification

Both defects were reproduced against the defective code before being fixed, and every new test was
run against it: **6 of the OpenCode proof tests fail** on v0.2.1's `proven`, and **6 of the migration
tests fail** on v0.2.1's move. 33 tests added across the two areas, covering `evidence/`,
`model-lab.log`, existing destinations, same-size-different-content conflicts, repeat launches, work
done after migrating, and a copy that fails mid-way.

## Checksums

```
shasum -a 256 -c Cernum-0.2.2-SHA256SUMS.txt --ignore-missing
```

## Opening an unsigned build

Not signed with a Developer ID and not notarized. Right-click the app → **Open** → **Open**, or:

```
xattr -dr com.apple.quarantine /Applications/Cernum.app
```
