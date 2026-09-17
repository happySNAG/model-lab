# Release install scripts

One script per published release and architecture, pinned to that release's artifact checksum.

These exist so a second machine can be brought onto a verified build **without trusting the machine
that built it**: the script names the artifact, pins its SHA-256, downloads only from the public
GitHub release, and refuses to install anything that does not match.

---

## `install-cernum-v0.2.2-macos-arm64.sh`

Upgrades an **Apple Silicon** Mac to **Cernum v0.2.2** (commit `ef1c6b9`), and repairs the data that
the v0.2.0/v0.2.1 migration moved out of the `Model Lab` folder.

### Use it

Download it, check it against the SHA-256 published with it, **read it**, then run it:

```bash
cd ~/Downloads
curl -fLO <raw URL pinned to a commit>
shasum -a 256 install-cernum-v0.2.2-macos-arm64.sh   # compare against the published digest
less install-cernum-v0.2.2-macos-arm64.sh            # read it before running it
bash install-cernum-v0.2.2-macos-arm64.sh
```

Run it as yourself. It does not need `sudo`, and it will refuse to run with `sudo` doing anything
useful — everything it writes is in your own home directory or `/Applications`.

### What it does

1. **Refuses any machine that is not `arm64`**, before downloading a byte. For an Intel Mac use
   `Cernum-0.2.2-macos-x64.dmg` from the same release.
2. Records what the old migration moved, reading `migrated-from.json`, before changing anything.
3. Downloads the DMG and `SHA256SUMS.txt` from the public `happySNAG/model-lab` v0.2.2 release.
4. **Verifies the DMG three ways before mounting it** — a checksum pinned in the script, the checksum
   in the release's own sums file, and the bytes actually downloaded. All three must agree. A
   substituted sums file therefore cannot approve a substituted artifact.
5. Installs to `/Applications/Cernum.app`. **An existing Cernum.app is moved to
   `~/Downloads/Cernum.app.backup-<timestamp>`, never deleted**, so rolling back is one `mv`.
6. Repairs the `cernum` terminal shim so it points into the newly installed bundle.
7. Verifies GUI version, CLI version, bundle architecture, shim target and the build commit stamped
   inside `app.asar`, and stops if any of them disagree.
8. **Restores what the old migration moved** — `evidence/` and `model-lab.log` on the machines this
   was written for, plus `campaigns/` and `settings.json` if they are missing too. Cernum's copies
   are the *source* and are never written to; `cp -n` means anything already on the Model Lab side is
   left exactly as it is.
9. Proves the restore by `diff -r` and SHA-256 rather than by eye.
10. Opens Cernum once and reads its log, to confirm v0.2.2's migration now reports
    *"already been carried across and still match"* instead of moving anything.
11-14. Runs **read-only** provider discovery and records whether `opencode/union-alpha` is present.
    It must come back **`unproven`**. The script **fails deliberately if any OpenCode model is marked
    `proven`**, because that is the v0.2.1 defect and means the build or the stored evidence is stale.
15. Writes a machine-specific manifest to `~/Library/Application Support/Cernum/manifests/`.

### What it will not do

- **No smoke test, no model inference, no campaign.** The only `cernum` verbs it issues are `where`,
  `providers`, `discover`, `models` and `install-command`. Discovery runs a CLI's own version,
  credential and model-listing subcommands; none of them reaches a model or spends allowance.
- **No API keys.** It never reads, sets or transmits `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or any
  other credential.
- **No deletions of your data.** Both `Model Lab` and `Cernum` keep everything they had. After it
  runs, your data exists in *both* places on purpose — delete the old folder yourself once you are
  satisfied, knowing what you are deleting.
- **No network destination other than the pinned GitHub release.**

### A note on the manifest

The manifest it writes describes **one machine at one moment**. It is not interchangeable with the
Mac mini's `PRIOR-LIVE-CAMPAIGNS-BASELINE.sha256`: campaign checksums there are rooted at that
machine's own campaign directory and will not verify on a different machine unless those exact
campaigns exist on it. Each machine keeps its own.

### Gatekeeper

The release is **not signed with a Developer ID and not notarized**, so macOS will say it cannot
verify the developer. The script clears the quarantine attribute on the copy it installs. To do it
by hand: `xattr -dr com.apple.quarantine /Applications/Cernum.app`.
