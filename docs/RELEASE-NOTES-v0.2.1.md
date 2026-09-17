# Cernum v0.2.1 — an installed CLI is reported as installed

> ### ⚠️ Corrected by v0.2.2 (2026-09-17)
>
> Two claims below were verified against the code and found wrong. They are left in place because a
> release note is a record of what was said; this banner is what is true.
>
> 1. **"The migration never overwrites and never deletes"** and **"a cross-volume move copies before
>    removing the source"** — the migration **moved**. `fs.renameSync` takes the source away, and the
>    cross-device fallback copied and then removed the original. On a real machine, `evidence/` and
>    `model-lab.log` left the `Model Lab` folder on first launch. Nothing was lost; the old folder was
>    not the intact backup this note describes. **v0.2.2 copies and preserves the source.**
> 2. **OpenCode models described as available/listed** — v0.2.0 and v0.2.1 recorded every model
>    `opencode models` returned as **`proven`**, the state a campaign may select. That listing is read
>    from a locally cached catalogue and proves nothing about an account. **In v0.2.2 every OpenCode
>    model is `unproven` and not selectable.**


**This is a corrective release. It fixes two defects that, together, made v0.2.0 report a provider as
absent on a machine where it was installed, authenticated and working.** There are no new features,
no behaviour changes to campaigns, scoring or evidence, and no change to any stored result.

**If you are running v0.2.0, replace it.** Nothing it recorded is wrong — but what it *told you about
your own machine* could be, and there was no way to tell from the application which one you were
looking at.

---

## What was broken

### 1. Provider discovery searched only `PATH`, so an app launched from Finder found nothing

`findExecutable` read `process.env.PATH` and stopped there. That is correct for a command you type in
a terminal and wrong for every other way Cernum runs.

A macOS application launched from **Finder, the Dock, or `open`** inherits `launchd`'s environment —
on a machine with nothing set, `/usr/bin:/bin:/usr/sbin:/sbin` — and reads **no shell profile**.
Everything a CLI installer appended to your `.zshrc` is invisible to it. So `claude` in
`/usr/local/bin`, `codex` in `~/.local/bin` and `opencode` in `~/.opencode/bin` were all reported
`notInstalled` in the application's own provider view, at the same moment the same CLIs answered
normally in a terminal.

You can still see the old behaviour for yourself against a v0.2.0 bundle:

```
env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /Applications/Cernum.app/Contents/Resources/cernum providers
```

**The fix.** `PATH` is searched **first and still wins**, so a build you deliberately put ahead of
another is still the one that runs. Only when `PATH` has nothing does the search widen, to the
directories CLI installers actually write to:

`~/.opencode/bin` · `~/.local/bin` · `~/.bun/bin` · `~/.npm-global/bin` · `/opt/homebrew/bin` · `/usr/local/bin`

Each is a single stat of a single filename. **Widening where Cernum looks changes nothing about what
Cernum does:** it still drives only a CLI you installed and authenticated yourself, still never
installs one, still never reads its stored session. The absolute path it found is printed on every
status surface, so a match outside `PATH` is always visible as the unusual location it came from.

### 2. `cernum discover opencodeCLI` denied that OpenCode was a provider

The decision about which provider is discovered by which routine was written out **twice** — once in
the terminal command, once in the desktop application — and the two had drifted. The application
routed OpenCode correctly. The terminal had no branch for it, and answered:

```
cernum: 'opencodeCLI' is not a provider. Try claudeCLI, codexCLI, anthropicAPI or openaiAPI.
```

…about a provider the same build supports, two lines below where its own `cernum providers` output
had just listed it. Because `discover` is what *writes down* a proof, **Union Alpha could not be
proven from a terminal at all, and so could not enter a campaign manifest.**

**The fix.** One router in the engine, `discoverProvider`, is now the only place that decision is
made, and both surfaces call it. Adding the missing branch would have fixed the symptom and left the
shape that produced it. The list of discoverable providers is derived from the provider registry
rather than typed, so a provider added later is routed or is caught by a test that walks every
registered id — it cannot become silently unreachable from one surface again.

### Also corrected

- **A sentence that had stopped being true.** Three `notInstalled` messages said the executable *"is
  not on this machine's PATH"*. After fix 1 that understates the search and invites you to fix a
  `PATH` that was never the problem. They now read: *"`opencode` was not found on PATH, nor in the
  directories CLI installers write to."*
- **`cernum providers` and `cernum help`** printed a provider list that omitted `opencodeCLI` — so the
  command nobody could run was also the command nobody was told to run. Both lists are now derived
  from the same registry.
- **`cernum discover` validates every provider name before running anything.** `discover claudeCLI
  opencode` used to discover Claude, then fail, leaving half a run's evidence written.
- The lockfile's own name and version, stale since the rename, now match `package.json`.

---

## What did **not** change

**No campaign, score, ledger, manifest, evidence store or published result is affected by this
release.** The defects were in how Cernum reported what is installed on your machine, not in how it
runs a campaign or what it records. Specifically unchanged: the scoring policy registry and its
digests, every suite identifier, the evidence store manifest format, all provider cost and billing
reporting, and the userData migration v0.2.0 introduced.

**Your Model Lab data is untouched.** `~/Library/Application Support/Model Lab/` and every campaign in
it are left exactly as they are, as they were by v0.2.0.

**OpenCode remains an UNTESTED METERED API.** It is discoverable, and that is all this release
changes about it. No scored Cernum campaign has been run through OpenCode, no OpenCode result is
published anywhere in this repository, and OpenCode's cost is reported as `unavailable` — not zero,
not free, not estimated.

---

## Verification

**1329 unit and parity tests** (up from 1307), **21 E2E**, typecheck clean, both macOS architectures
and the Windows pair built from the same commit.

**22 tests were added, and each one was run against the defective code first.** Eight of them fail on
v0.2.0's `findExecutable`; one fails on v0.2.0's terminal dispatch. The pre-existing OpenCode tests
all passed throughout the outage, because every one of them injected the executable lookup and called
the discovery routine directly — they tested the destination and never the route. The new tests
install a real executable in a real directory, under the `PATH` `launchd` gives an application, and
let discovery find it the way it must find one on a real machine; three of them run
`cernum discover opencodeCLI` as an actual subprocess.

They cover: OpenCode installed and authenticated · Union Alpha present · Union Alpha absent (reported
`refused`, never quietly omitted) · `--version` failure · `models` failure · a version line that is
not a version · spawn failure · a non-default install directory · `PATH` still winning · nothing
installed at all · every registered provider routing from both surfaces.

---

## Checksums

Verify a download before you open it:

```
shasum -a 256 -c Cernum-0.2.1-SHA256SUMS.txt --ignore-missing
```

## Opening an unsigned build

These builds are **not signed with a Developer ID and not notarized**, so macOS will say it cannot
verify the developer. Right-click the app → **Open** → **Open**, or clear the quarantine attribute
yourself:

```
xattr -dr com.apple.quarantine /Applications/Cernum.app
```
