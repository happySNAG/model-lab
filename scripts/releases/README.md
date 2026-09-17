# Release install scripts

One script per published release and architecture, pinned to that release's artifact checksum.

These exist so a second machine can be brought onto a verified build **without trusting the machine
that built it**: the script names the artifact, pins its SHA-256, downloads only from the public
GitHub release, and refuses to install anything that does not match.

---

## `install-cernum-v0.2.4-macos-arm64.sh`

**The current one.** Upgrades an **Apple Silicon** Mac to **Cernum v0.2.4** (build commit
`6315cb1`), verifies the v0.2.4 corrections without sending a single provider request, and still
carries the v0.2.1 migration repair because it is idempotent and this machine may never have run it.

### Use it

```bash
cd ~/Downloads
curl -fLO https://raw.githubusercontent.com/happySNAG/model-lab/49ca9478b4eacb61347cf99ae08a09e5d7bfc683/scripts/releases/install-cernum-v0.2.4-macos-arm64.sh
shasum -a 256 install-cernum-v0.2.4-macos-arm64.sh   # compare against the digest in the release notes
less install-cernum-v0.2.4-macos-arm64.sh            # read it before running it
bash install-cernum-v0.2.4-macos-arm64.sh
```

Run it as yourself. It needs no `sudo`; everything it writes is in your own home directory or
`/Applications`.

### What it does, beyond what v0.2.3's did

Steps 1–15 are the v0.2.3 script's, with the version, commit and checksum repinned: arch check,
three-way checksum verification before mounting, install with the old app **moved aside rather than
deleted**, shim repair, version/architecture/commit assertions, the migration repair proved by
`diff -r` and SHA-256, read-only discovery, and a machine manifest.

Step 14 additionally **fails if discovery still carries the superseded v0.2.2 sentence** ("no
OpenCode execution adapter"), which v0.2.3 wrote into `discovered.json` on a build that had one.

**Step 16 is new, and every check in it is free**:

- `cernum help smoke`, `cernum smoke --help` and `cernum smoke -h` must be **the same page**, and it
  must document `--models`, `--all-ladder`, `--dry-run`, `--pricing`, `--authorize-metered`,
  `--authorize-unpriced-metered` and `--otlp-observer`.
- `--max-attempts banana` must **refuse**, rather than silently dropping the cap.
- A Claude dry-run must preview as `subscriptionIncluded` and confirm it sent nothing.
- An OpenCode dry-run must preview as `meteredAPI`, warn that a live run of that scope would be
  **REFUSED**, and report its cost as **UNAVAILABLE**.

Any of those failing stops the script with "this is not a v0.2.4 build".

### What it will not do

Everything the v0.2.3 list below says, and one thing more: **it cannot accidentally spend.** The only
`cernum` verbs it issues are `where`, `providers`, `discover`, `models`, `install-command`, `help` and
`smoke --dry-run`. Even if `smoke` were reached without `--dry-run`, a metered provider would refuse
without an explicit spending authorization the script never supplies.

---

## `install-cernum-v0.2.3-macos-arm64.sh`

**Superseded by the v0.2.4 script above.** Kept because it is what was published, and a record of
what was published is not improved by deleting it.

## `install-cernum-v0.2.3-macos-arm64.sh`

Upgrades an **Apple Silicon** Mac to **Cernum v0.2.3** (commit `4604af3`), and repairs the data that
the v0.2.0/v0.2.1 migration moved out of the `Model Lab` folder.

### Use it

Download it, check it against the SHA-256 published with it, **read it**, then run it:

```bash
cd ~/Downloads
curl -fLO <raw URL pinned to a commit>
shasum -a 256 install-cernum-v0.2.3-macos-arm64.sh   # compare against the published digest
less install-cernum-v0.2.3-macos-arm64.sh            # read it before running it
bash install-cernum-v0.2.3-macos-arm64.sh
```

Run it as yourself. It does not need `sudo`, and it will refuse to run with `sudo` doing anything
useful — everything it writes is in your own home directory or `/Applications`.

### What it does

1. **Refuses any machine that is not `arm64`**, before downloading a byte. For an Intel Mac use
   `Cernum-0.2.3-macos-x64.dmg` from the same release.
2. Records what the old migration moved, reading `migrated-from.json`, before changing anything.
3. Downloads the DMG and `SHA256SUMS.txt` from the public `happySNAG/model-lab` v0.2.3 release.
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
10. Opens Cernum once and reads its log, to confirm the copy-only migration now reports
    *"already been carried across and still match"* instead of moving anything.
11-14. Runs **read-only** provider discovery and records whether `opencode/union-alpha` is present.
    Discovery must prove **nothing**: the script fails deliberately if a *listing* reports any
    OpenCode model as `proven`, because a catalogue cannot prove a model and a build that says
    otherwise predates v0.2.2. From v0.2.3 OpenCode **can** be proven — by a smoke test you run
    yourself, deliberately, which spends per token. The script never runs one.
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
