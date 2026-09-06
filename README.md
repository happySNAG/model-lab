<div align="center">

# Model Lab

**A desktop benchmarking environment for comparing AI models on the tasks you actually care about.**

Run the language models on your own computer through repeatable, deterministic evaluations. Compare
quality, speed, reliability and safety behaviour side by side, and pick the right model for each job
with evidence instead of vibes.

[![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#install)
[![Runtime](https://img.shields.io/badge/runtime-Ollama-black.svg)](https://ollama.com)
[![Tests](https://img.shields.io/badge/tests-200%20unit%20%2B%20parity%20%C2%B7%206%20end--to--end-brightgreen.svg)](#tests)
[![Status](https://img.shields.io/badge/status-v0.1.0%20first%20public%20release-blue.svg)](#project-status)

</div>

![The Results screen: two models ranked within one benchmark, with quality, pass/partial/fail counts, reliability, median and p95 latency, tokens per second, and how many hard boundaries each model crossed.](docs/screenshots/model-lab-results.png)

## What it is

Model Lab is a native desktop application. You pick some models, pick what to test, press start, and
watch every answer get judged by fixed rules. What you get back is a ranking *within that one
benchmark* — plus every reason not to over-read it — and a permanent local record of exactly what was
asked, what came back, and why it scored the way it did.

Everything runs on your machine. There is no account, no telemetry, no update check, and the only
network connection Model Lab ever opens is to [Ollama](https://ollama.com) on localhost.

**Quick start:** install [Ollama](https://ollama.com/download) → download Model Lab → open it → press
*New benchmark*. There is a built-in reference model so you can walk the whole workflow before Ollama
is even set up. Full instructions are in [Install](#install).

| Platform | Status |
| --- | --- |
| **macOS 12+** (Apple Silicon and Intel) | Reference platform. Built, packaged and smoke-tested on real hardware. Unsigned — see [Opening an unsigned build](#opening-an-unsigned-build). |
| **Windows 10 / 11** (x64) | Builds from the same source; installer and portable executable are produced and the automated suites pass on Windows in CI. **The packaged application has not yet been launched on physical Windows hardware** — see [Windows verification status](#windows-verification-status). |
| **Linux** | Not packaged. The code is portable and an AppImage target exists in the build config, but it is untested. |

## Why it exists

There are plenty of public leaderboards, and they answer a question most people do not have. A
leaderboard tells you which model is best *on average, on someone else's tasks, on someone else's
hardware*. It cannot tell you whether the 4-billion-parameter model that fits on your laptop is good
enough for the specific thing you want to do, or how fast it will actually be on *your* machine, or
how it behaves when it does not know the answer.

Model Lab answers those questions instead:

- **Is this small local model good enough for my job?** Run it against the same fixed tasks as a
  bigger one and look at the difference.
- **What does it cost me in time?** Median and p95 latency and tokens per second, measured on the
  machine that ran it and recorded alongside that machine's actual specification.
- **Does it stay honest?** A large part of the suite tests what a model does when it has no answer:
  whether it admits a gap, invents a fact, claims to have done something it did not do, or quietly
  goes past a limit it was given.
- **Is it reliable, or just good when it works?** Timeouts and errors count against reliability and
  are never silently averaged away.
- **Did anything change?** Every run is kept forever, so you can compare a model against its own past
  self after an update — and Model Lab tells you plainly when two runs are not like-for-like.

![Comparing two benchmarks: a "Directly comparable" verdict, both runs' machine and date, and quality, median latency and boundaries crossed for each model side by side.](docs/screenshots/model-lab-comparison.png)

## Who it is for

People choosing a local model to build on or work with: developers picking a model for a feature,
people comparing what will actually run on their laptop, anyone who wants a defensible reason for
"we used this one". You do not need a terminal, a Python environment or a source checkout — just the
application and Ollama.

## What Model Lab measures

Each model answers exactly the same fixed prompts, in the same order, with the same settings, on the
same machine. Every attempt is recorded, then judged.

| Measure | What it means |
| --- | --- |
| **Quality** | Passes at full weight, partial credit at half, over the answers a rule could actually judge. Never a guess, never an average over things that were not evaluated. |
| **Pass / partial / fail** | The raw counts behind the quality figure. |
| **Reliability** | How many planned attempts produced an answer at all. Timeouts and transport errors land here — never as a quality score of zero. |
| **Median and p95 latency** | Wall-clock time per answer. p95 is there because the slow tail is what you actually feel. |
| **Tokens per second** | Generation speed, taken from the runtime's own counters. Shown as *n/a* when the runtime does not report them. |
| **Hard boundaries crossed** | Rule violations that are disqualifying regardless of fluency: inventing a personal fact, claiming an action happened, silently changing a configuration, going outside an authorised scope. One crossing sinks a model to the bottom of the ranking. |
| **Capability profile** | The same results broken down across 12 capabilities, so you can see *where* a model is strong rather than just how it ranked overall. |

The twelve capabilities: conversation, memory honesty, context integration, calendar and temporal
reasoning, emotional understanding, privacy and governance, hallucination resistance, tool selection,
planning, long-context retrieval, safety boundaries, and structured-output reliability.

## How the evaluations work

**The suites are fixed, versioned fixtures.** Model Lab ships 14 suites and 44 cases: a short
*Quick check* (11 attempts per model), the *Full lab* (46 attempts per model), or any hand-picked
subset. Every prompt is an invented synthetic fixture — Model Lab reads no files of yours, no
contacts, no calendars, nothing. A validator refuses any prompt that is not marked synthetic.

**Answers are judged by fixed deterministic rules, never by another AI.** Exact and fuzzy matching,
required and prohibited concepts, refusal classification, JSON schema conformance, ordering
constraints, provenance labelling. The same answer always receives the same judgment. Anything a rule
cannot honestly judge — conversational warmth, emotional attunement — is marked *needs human review*
rather than guessed at, and is excluded from the score in both directions.

**Missing evidence is shown as missing.** A value the runtime did not report is *n/a* with the reason,
never a zero and never an estimate. This applies to hardware facts too: if the operating system did
not report your GPU, Model Lab says so instead of inferring one.

**Nothing is overwritten.** The evidence store is append-only. A re-run is a new run, and both are
kept. You can export the whole store as a single JSON bundle with a digest at any time.

### Reading the results

- **Rankings apply within one benchmark only.** Every model in it faced the same prompts on the same
  machine. Model Lab never produces a universal score and never compares against numbers from
  somewhere else.
- **A crossed hard boundary outranks everything.** A fluent model that invents a fact places below a
  clumsy one that admits it does not know.
- **The recommendation is deliberately hard to earn.** It is one of four outcomes — *recommended*,
  *not recommended*, *insufficient evidence*, *disqualified* — under a fixed published policy: at
  least 3 judged answers in each of at least 6 capabilities, every covered capability at 80% or
  better, and no hard boundary crossed. A short benchmark usually yields *insufficient evidence*.
  **That is the honest answer, not a bug.** Run the full lab if you want a verdict.
- **A recommendation changes nothing.** It is evidence for your decision. Model Lab does not
  configure anything, anywhere.

![The Recommendation view: the fixed policy stated in full, then a per-model outcome with every governance failure named — the rule, the case, and what the answer did wrong.](docs/screenshots/model-lab-recommendation.png)

![The Side-by-side view: a capability grid comparing two models across the twelve capabilities, with sample sizes and human-review counts.](docs/screenshots/model-lab-side-by-side.png)

## Supported models and runtimes

| Runtime | Supported | Notes |
| --- | --- | --- |
| **[Ollama](https://ollama.com)**, on this computer | ✅ Yes | Any model you have installed — `llama3.2:3b`, `gemma3:4b`, `qwen3:4b`, and so on. Model Lab detects Ollama, can start it for you, and can ask it to download a model after you confirm by name. |
| **Built-in reference model** | ✅ Yes, always | A deterministic scripted responder built into the application. Same fixed answers every time. It exists so you can try the entire workflow — and check that a change to Model Lab itself did not change any judgment — without installing anything. Its answers are not a real model's. |
| **Remote Ollama on another machine** | ❌ Refused by design | Endpoints that are not `127.0.0.1`, `localhost` or `::1` are rejected. Every result records the hardware that produced it; a remote host would make that record a lie. |
| **Frontier / hosted API models** (Claude, GPT, Gemini, …) | ❌ Not supported | There is no API client, no key handling and no outbound internet path in this application, and adding one is not a small change: prompts would leave your machine, and the per-machine latency and hardware facts that make these results meaningful would no longer mean anything. See [Roadmap](#roadmap). |
| **llama.cpp, LM Studio, vLLM, MLX, …** | ❌ Not yet | The engine has a clean adapter boundary (`src/core/adapter.ts`) and Ollama is one implementation of it, so another local runtime is a tractable contribution. None exists today. |

## Privacy

This is the whole story, and it is short:

- **Nothing leaves your computer.** No telemetry, no crash reporting, no update check, no account, no
  analytics. The only socket Model Lab opens is to Ollama on loopback.
- **No personal data is read.** Every prompt is a fixed synthetic fixture shipped with the
  application. Model Lab does not read your files, messages, contacts or calendar, and has no code
  that could.
- **Your prompts and answers stay local, and stay yours.** The evidence store lives in your user
  application-data folder, in plain JSON you can read. Nothing is uploaded. Uninstalling the
  application does not delete it.
- **Local models are private; that is the point.** Because every model runs through Ollama on your own
  machine, the text of a benchmark never reaches a third party. This is exactly the property that
  would be lost if hosted API models were supported — with a hosted model, every prompt and answer
  goes to that provider under their terms, and Model Lab would rather be clear about that than
  quietly blur the line.
- **Reasoning traces are never stored.** If a model produces internal "thinking", only its length is
  recorded.
- **Downloads are explicit.** Model Lab never installs Ollama and never pulls a model on its own. The
  only download path is the *Add a model* button, after you confirm the name.

## Install

### What you need

| | |
| --- | --- |
| **macOS** | macOS 12 Monterey or later. Apple Silicon (M1 and later) or Intel. |
| **Windows** | Windows 10 or 11, 64-bit. |
| **Ollama** | Free, from [ollama.com/download](https://ollama.com/download). Model Lab detects it, can start it, and guides you if it is missing — but never installs it for you. |
| **A model** | Any model installed in Ollama. The Models screen can ask Ollama to download one after you confirm. |
| **Nothing else** | No terminal, no Node, no Python, no source checkout. The built-in reference model lets you try the whole workflow before Ollama is set up. |

### macOS

1. Download `Model-Lab-<version>-macos-arm64.dmg` (Apple Silicon) or
   `Model-Lab-<version>-macos-x64.dmg` (Intel) from the [releases page][releases]. Not sure which Mac
   you have?  Apple menu → *About This Mac*: "Chip: Apple M…" means arm64.
2. Open the disk image and drag **Model Lab** into **Applications**.
3. Open it from Applications, Launchpad or Spotlight. The first launch needs one extra step — see
   below.
4. To update, replace the app in Applications. Your history and settings are kept; they live in
   Application Support, not in the app.
5. To remove it, drag the app to the Trash. Your evidence folder stays until you delete it yourself.

#### Opening an unsigned build

Release builds are **not signed with an Apple Developer ID and not notarized**. They are ad-hoc signed
so Apple Silicon will run them, but Gatekeeper cannot verify their origin, so a copy downloaded from
the internet is quarantined and the first launch shows *"Model Lab" Not Opened*. This is expected:

- **macOS 15 Sequoia and later:** click *Done*, then open **System Settings ▸ Privacy & Security**,
  scroll to *Security*, and click **Open Anyway**. Confirm once; macOS remembers.
- **macOS 12–14:** right-click (Control-click) **Model Lab** in Applications and choose **Open**, then
  **Open** again.
- Or clear the quarantine flag yourself:
  `xattr -d com.apple.quarantine "/Applications/Model Lab.app"`

A copy you build from source on your own Mac is not quarantined and opens directly. Nothing in the
code needs to change to sign and notarize properly — electron-builder picks up the standard
`CSC_LINK` / `APPLE_ID` environment variables.

### Windows

1. Download `Model-Lab-Setup-<version>-x64.exe` and run it. It installs per user (no administrator
   rights), adds Start Menu and Desktop shortcuts, and starts Model Lab when it finishes. Or download
   `Model-Lab-Portable-<version>-x64.exe` and run it from anywhere with no installation.
2. The build is unsigned, so SmartScreen may show *Windows protected your PC*. Click
   **More info ▸ Run anyway**.
3. Uninstall from *Settings ▸ Apps*. The uninstaller removes the application and **keeps** your
   evidence store.
4. Shortcuts match macOS with Ctrl in place of ⌘ (Ctrl+1…7, Ctrl+N, Ctrl+E). The menu bar is hidden;
   press Alt to show it.

Please read [Windows verification status](#windows-verification-status) before relying on it.

[releases]: https://github.com/happySNAG/model-lab/releases

## Using Model Lab

![The Home screen: this computer's hardware as the operating system reports it, Ollama's status, the models installed, and recent benchmarks.](docs/screenshots/model-lab-home.png)

![The Benchmark screen: three numbered steps — choose models, choose suites, start — with a per-suite breakdown of what will be tested.](docs/screenshots/model-lab-benchmark.png)

| Screen | What it does |
| --- | --- |
| **Home** | This computer (name, system, processor, memory, graphics — only what the operating system actually reports), Ollama status with a *Start Ollama* button or guided install, how many models are installed, recent benchmarks, and the *New benchmark* action. |
| **Models** | Every model Ollama has installed, with size, parameters, quantization, family and how many benchmarks it has been in. *Add a model* asks Ollama to download one after you confirm; downloads are cancellable. |
| **Benchmark** | Three numbered steps: pick models, pick suites (*Quick check*, *Full lab*, or hand-picked — *What exactly is tested?* lists every case, its format, repetitions, time limit and whether it is a hard boundary), then start. A pre-flight dialog states exactly what is about to happen before anything runs. |
| **Live run** | Overall and per-model progress, which model is answering which prompt and for how long, outcomes so far, and the last twelve attempts with their judgments. *Cancel* stops after the prompt in flight; everything already recorded is kept. |
| **Results** | A one-paragraph verdict with every caveat, the ranking table, strengths and weaknesses, a side-by-side capability grid, every case with a drill-down to the exact prompt, answer and judgment, and a recommendation under the fixed policy. |
| **History** | Every benchmark ever run on this computer. Reopen any result; tick two to compare them — Model Lab says plainly when they are not like-for-like. |
| **Settings & diagnostics** | Ollama endpoint (loopback only), model "thinking" mode, evidence folder and export, this computer's facts, version and build, the benchmark catalog digest, and a *Copy diagnostics* button for bug reports. |

### A typical first session

1. Open Model Lab. The Home screen tells you whether Ollama is running and offers to start it.
2. Go to **Models**. If the list is empty, use *Add a model* — `gemma3:270m` and `qwen3:0.6b` are both
   small and quick to try.

![The Models screen: every model Ollama has installed with its size, parameter count, quantization and family, an Add a model field, and the built-in reference model.](docs/screenshots/model-lab-models.png)
3. Go to **Benchmark**. Tick two models, leave *Quick check* selected, press **Start benchmark**, read
   the pre-flight dialog, and confirm.
4. Watch the **Live run**. Every attempt is written to disk as it finishes, so nothing is lost if the
   application closes.

![The Live run screen: overall progress, per-model progress, outcomes so far, and the most recent attempts with their judgments as they land.](docs/screenshots/model-lab-live-run.png)
5. Open **Results**. Start with the verdict paragraph, then the ranking table, then click any case to
   see the exact prompt, the exact answer and exactly why it was judged the way it was.
6. Run it again — or run the *Full lab* — and compare the two in **History**.

![The Every case view: every attempt in the run listed with the model, the case, what it checks, whether an answer arrived, the rule's judgment, latency and speed.](docs/screenshots/model-lab-every-case.png)

Clicking any row opens the attempt in full: the exact prompt that was sent, the exact answer that came
back, every rule that was applied and what each one decided, the timing breakdown, and whether the
runtime's reported model identity matched what was asked for.

## Where your data lives

| | macOS | Windows |
| --- | --- | --- |
| Settings, sessions, log | `~/Library/Application Support/Model Lab/` | `%APPDATA%\Model Lab\` |
| Evidence store (append-only JSON) | `~/Library/Application Support/Model Lab/evidence/` | `%APPDATA%\Model Lab\evidence\` |

Both are shown in *Settings & diagnostics* with *Open* buttons, and you can point the evidence store
somewhere else. History survives updates and reinstalls.

![Settings & diagnostics: the loopback-only Ollama endpoint, model thinking mode, the evidence store's location and record count, this computer's facts, and the build and catalog versions.](docs/screenshots/model-lab-settings.png)

## Troubleshooting

**"Ollama is not installed" but I installed it.** Model Lab looks for the `ollama` executable in the
usual places and checks the endpoint in Settings. Confirm the endpoint is `http://127.0.0.1:11434`,
then use *Ollama ▸ Check Ollama Status* (⌘R / Ctrl+R).

**"Ollama is installed but not running."** Press *Start Ollama* on the Home screen, or start it
yourself with `ollama serve`.

**The endpoint field will not accept my address.** Only `127.0.0.1`, `localhost` and `::1` are
allowed. This is deliberate — see [Supported models and runtimes](#supported-models-and-runtimes).

**A model times out on every case.** Each case has a time limit, sized for small local models. A large
model on modest hardware can exceed it — that is a real finding, and it is recorded against
reliability rather than quality. Try a smaller model, or the *Quick check* first.

**The verdict says "insufficient evidence".** The recommendation policy needs breadth of coverage. Run
the *Full lab*.

**macOS says the app cannot be verified.** See [Opening an unsigned build](#opening-an-unsigned-build).

**Something else.** Open *Settings & diagnostics ▸ Copy diagnostics*, then
[open an issue](https://github.com/happySNAG/model-lab/issues) and paste it in. It contains your
hardware summary, versions, settings and record counts — no prompts, no answers, no personal data.
*Help ▸ Show Log File* has more detail if you need it.

## Known limitations

- **Builds are unsigned.** No Apple Developer ID and no notarization on macOS; unsigned on Windows.
  Expect the Gatekeeper and SmartScreen steps above, and note that you cannot cryptographically verify
  a downloaded artifact's origin. Build from source if that matters to you.
- **Windows has not been exercised on physical Windows hardware.** See below.
- **Local models only.** No hosted API providers. See
  [Supported models and runtimes](#supported-models-and-runtimes).
- **You cannot author your own suites in the application.** The suites are fixed and versioned on
  purpose: an editable suite is not comparable with anything, including its own past self. Adding a
  new versioned suite in source is straightforward; editing an existing one is deliberately not.
- **Some sealed fixtures carry an older project's name.** This engine was first written for a private
  companion application, and the suite titles, system prompts and the reference model's stored name
  were sealed then. Those exact bytes are pinned by the equivalence corpus described in
  [docs/PARITY.md](docs/PARITY.md) and by every result already on disk, so they are not edited; the
  interface presents its own names over them. You will see the original wording if you open the
  attempt drill-down, which shows the prompt verbatim because it is evidence.
- **Judged capabilities reflect that origin too.** The suites lean towards assistant-style behaviour —
  memory honesty, privacy, safety boundaries, emotional attunement. They are not a general
  coding, mathematics or translation benchmark.
- **Two capabilities are partly human-judged.** Conversational warmth and emotional attunement are
  marked *needs human review* rather than auto-scored. The rubrics exist in the engine, but there is
  no screen for recording those judgments yet.
- **Linux is not packaged.**
- **Hardware facts are only as good as the operating system's.** GPU comes from the system report on
  macOS and CIM on Windows; anywhere else it is reported as unavailable rather than guessed. Thermal
  state is never read, so a thermally throttled run looks like a slow run.

## Windows verification status

Being precise about this, because it is the one place where "it should work" and "it was checked" are
different things:

| | |
| --- | --- |
| Source builds on Windows | ✅ Verified in CI (`windows-latest`) |
| Typecheck, 200 unit and parity tests | ✅ Verified in CI on Windows |
| End-to-end Playwright suite against the real Electron application | ✅ Verified in CI on Windows |
| NSIS installer and portable executable are produced | ✅ Verified in CI on Windows |
| Windows-specific code paths (CIM hardware query, `%APPDATA%` locations, Ctrl accelerators, tray/Ollama start) | ⚠️ Reviewed statically and exercised by the automated suites; **not** observed on physical hardware |
| Installing, launching and uninstalling the packaged application on a real Windows PC | ❌ **Not done** |

`scripts/windows-smoke.ps1` performs that last check — silent install, shortcut and registry checks,
launch, evidence-store check, uninstall. It has not been run. If you run it, please
[open an issue](https://github.com/happySNAG/model-lab/issues) with the output, good or bad; that is
the single most useful contribution to this release.

## Build from source

Requirements: **Node 20 or later** and npm. Nothing else. macOS packaging requires macOS; Windows
packaging works from macOS, Linux or Windows.

```bash
git clone https://github.com/happySNAG/model-lab.git
cd model-lab
npm install

npm run dev            # hot-reloading development window
npm test               # 200 unit + parity tests (vitest), ~2 seconds
npm run typecheck      # tsc --noEmit
npm run build          # electron-vite → out/
npm run test:e2e       # Playwright drives the built application end to end
npm run test:all       # typecheck → tests → build → end-to-end

npm run dist:mac       # Model Lab.app + DMG + ZIP, arm64 and x64 → dist/
npm run dist:win       # NSIS installer + portable exe → dist/
npm run smoke:mac      # bundle, Info.plist and signature checks + a Finder-equivalent launch
```

### Architecture

```
src/core/       the portable engine — pure TypeScript, no Electron: digests, suite catalog, planner,
                executor, append-only stores, deterministic evaluators, capability profiles,
                recommendation, history and comparability, the Ollama adapter and its transport
src/main/       Electron main process: window, macOS/Windows menu, environment capture, Ollama
                detection / start / explicit pull, sessions, settings, the lab service, IPC
src/preload/    the narrow typed bridge the renderer may call
src/shared/     ipc.ts — the single contract between main and renderer
src/renderer/   the React interface (Home, Models, Benchmark, Live run, Results, History, Settings)
fixtures/parity/  a frozen equivalence corpus — see docs/PARITY.md
test/           unit, parity and end-to-end suites
```

The renderer has no Node access: `contextIsolation` on, `nodeIntegration` off, a
`default-src 'self'` Content-Security-Policy, and every call crossing one typed preload bridge.

### Tests

| Suite | What it covers |
| --- | --- |
| `test/unit/` (43) | Engine behaviour (fail-closed execution, append-only store, cancellation, idempotent evaluation), the Ollama transport against a scripted loopback server (unavailable, available, no models, enumeration, not found, malformed, timeout, cancellation), and application state (settings persistence and validation, session recovery after an unclean exit, machine-summary honesty, the application menu). |
| `test/parity/` (157) | Byte-for-byte equality with a frozen corpus generated by an independent second implementation of the same engine, written in Swift: digests, catalog, plans, executed bundles, evaluations, profiles, recommendations and a complete on-disk store. See [docs/PARITY.md](docs/PARITY.md). |
| `test/e2e/` (6) | The built application under Playwright: install-to-results with the reference model, relaunch persistence, cancel-and-keep, a two-model benchmark against a scripted Ollama covering HTTP failure, malformed output, timeout and a hard-boundary violation, settings persistence, refusal of non-loopback endpoints, menu navigation, and the packaged `Model Lab.app` launching from its bundle. |

CI runs the typecheck, unit and parity suites on macOS, Windows and Linux, and the end-to-end suite on
macOS and Windows, on every push and pull request.

## Project status

**v0.1.0 — first public release.** The application is complete and used daily on macOS; the version
number reflects how long it has been in front of other people, not how finished it is. Expect the
macOS experience to be solid, Windows to be plausible but unproven on real hardware, and the
interface to change faster than the engine — the engine is pinned by an equivalence corpus and moves
deliberately.

## Roadmap

Only things the existing code actually supports doing next:

- **Signed and notarized releases.** The packaging config already has the hooks; it needs a
  Developer ID and an Azure Trusted Signing (or equivalent) certificate, not a code change.
- **A physical Windows smoke test.** The script is written and waiting.
- **A screen for human-review judgments.** The rubrics, records and store already exist in
  `src/core/human-review.ts`; conversational warmth and emotional attunement are collected and
  excluded from scoring today, with nowhere to record a verdict.
- **A second local runtime behind the existing adapter boundary** — llama.cpp, LM Studio or MLX.
  `src/core/adapter.ts` is the seam and Ollama is one implementation of it.
- **A Linux package.** The AppImage target exists in the build config and is untested.

Explicitly **not** planned: hosted API providers, telemetry of any kind, an LLM-as-judge scorer, and
editable benchmark suites. The reasoning for each is in
[CONTRIBUTING.md](CONTRIBUTING.md#things-that-are-deliberate-not-oversights).

## Contributing and issues

Bug reports and small, well-tested changes are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) — especially *Things that are deliberate, not oversights*, which
saves everyone a round trip.

- **Found a bug?** [Open an issue](https://github.com/happySNAG/model-lab/issues/new/choose). The
  *Copy diagnostics* button gives you almost everything the template asks for.
- **Security or privacy issue?** Please report it privately — see [SECURITY.md](SECURITY.md).
- **Ran it on Windows?** Say so, either way. See
  [Windows verification status](#windows-verification-status).

## Licence

[MIT](LICENSE). Third-party components and the licences of the runtimes and models Model Lab talks to
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
