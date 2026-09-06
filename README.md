# Model Lab

**A desktop laboratory for benchmarking the language models on your own computer.**
macOS (Apple Silicon and Intel) and Windows (x64). Everything runs locally through
[Ollama](https://ollama.com); nothing leaves the machine.

Model Lab sends fixed, synthetic prompts to the models you choose, judges every answer with fixed
deterministic rules (never another AI), and keeps every attempt as permanent local evidence. It tells
you which model did best *within one benchmark*, per capability, with latency and reliability, and it
says plainly when the evidence is too thin to conclude anything.

![Benchmark screen](docs/screenshots/benchmark.png)
![Live run](docs/screenshots/live-run.png)

*More screenshots (Results, History, Models) will be added once captured on a clean machine; the two
above are real captures of the built application.*

## Contents

- [What you need](#what-you-need)
- [macOS: install and run](#macos-install-and-run)
- [Windows: install and run](#windows-install-and-run)
- [Using Model Lab](#using-model-lab)
- [Where your data lives](#where-your-data-lives)
- [Privacy and local processing](#privacy-and-local-processing)
- [Build from source](#build-from-source)
- [Release artifacts](#release-artifacts)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Architecture](#architecture)

## What you need

| | |
| --- | --- |
| **macOS** | macOS 12 Monterey or later. Apple Silicon (M1 and later) or Intel. |
| **Windows** | Windows 10 or 11, 64-bit. |
| **Ollama** | Free, from [ollama.com/download](https://ollama.com/download). Model Lab detects it, can start it, and guides you if it is missing. Model Lab never installs Ollama or downloads a model on its own. |
| **A model** | Any model installed in Ollama (for example `llama3.2:3b`, `gemma3:4b`, `qwen3:4b`). The Models screen can ask Ollama to download one, only after you confirm. |
| **Nothing else** | No terminal, no Node, no Python, no source checkout. A built-in *reference model* lets you try the whole workflow before Ollama is set up. |

## macOS: install and run

1. Download `Model-Lab-<version>-macos-arm64.dmg` (Apple Silicon) or `Model-Lab-<version>-macos-x64.dmg`
   (Intel). Not sure which Mac you have? Apple menu → *About This Mac*: "Chip: Apple M…" means arm64.
2. Open the DMG and drag **Model Lab** into **Applications**.
3. Open **Model Lab** from Applications, Launchpad, or Spotlight. See *Opening an unsigned build* below
   the first time.
4. Model Lab behaves like any Mac app: a menu bar (Model Lab ▸ About, Settings… ⌘,, Quit ⌘Q; File ▸
   New Benchmark ⌘N, Export Evidence ⌘E; View ▸ ⌘1–⌘7 switch screens), Dock icon, standard window
   controls, light and dark appearance following the system.
5. To update, replace the app in Applications with the new version. Your history and settings are kept
   (they live in Application Support, not in the app).
6. To remove, drag the app to the Trash. Your evidence folder stays until you delete it yourself
   (see [Where your data lives](#where-your-data-lives)).

### Opening an unsigned build

Release builds of Model Lab are **not signed with an Apple Developer ID and not notarized**. They are
ad-hoc signed so that Apple Silicon can run them, but macOS Gatekeeper cannot verify their origin, so a
copy downloaded from the internet is quarantined and the first launch shows *"Model Lab" Not Opened —
Apple could not verify "Model Lab" is free of malware*. This is expected. To open it anyway:

- **macOS 15 Sequoia and later:** click *Done*, then open **System Settings ▸ Privacy & Security**,
  scroll to *Security*, and click **Open Anyway** next to the Model Lab message. Confirm once. macOS
  remembers the choice.
- **macOS 12–14:** right-click (Control-click) **Model Lab** in Applications and choose **Open**, then
  **Open** again in the dialog.
- Alternatively, clear the quarantine flag in Terminal:
  `xattr -d com.apple.quarantine "/Applications/Model Lab.app"`

A copy built on your own Mac from source is not quarantined and opens directly. Anyone distributing
Model Lab more widely should sign and notarize it (electron-builder supports both through the standard
`CSC_LINK` / `APPLE_ID` environment variables); nothing in the code needs to change.

## Windows: install and run

1. Download `Model-Lab-Setup-<version>-x64.exe` and run it. It installs per user (no administrator
   rights), adds Start Menu and Desktop shortcuts, and starts Model Lab when finished. Or download
   `Model-Lab-Portable-<version>-x64.exe` and run it from anywhere with no installation.
2. The build is unsigned, so Windows SmartScreen may show *Windows protected your PC*. Click **More
   info ▸ Run anyway**.
3. Uninstall from *Settings ▸ Apps*. The uninstaller removes the application and **keeps** your
   evidence store.
4. Keyboard shortcuts match macOS with Ctrl in place of ⌘ (Ctrl+1…7, Ctrl+N, Ctrl+E). The menu bar is
   hidden; press Alt to show it.

## Using Model Lab

| Screen | What it does |
| --- | --- |
| **Home** | This computer (name, system, processor, memory, graphics — only what the OS reports; never estimated), Ollama status with a **Start Ollama** button or guided install, installed-model count, recent benchmarks, and the *New benchmark* action. |
| **Models** | Every model Ollama has installed with size, parameters, quantization, family, and how many benchmarks it has been in. *Add a model* asks Ollama to download one after you confirm; downloads are cancellable. The built-in reference model is always listed. Clear empty states when Ollama is missing, not running, or has no models. |
| **Benchmark** | Three numbered steps: pick models, pick suites (*Quick check*, *Full lab*, or hand-picked; *What exactly is tested?* lists every case, its format, repetitions, time limit, and whether it is a hard boundary), then start. The pre-flight dialog states exactly what will happen before anything runs. |
| **Live run** | Overall and per-model progress, the suite in progress, which model is answering which prompt and for how long, outcomes so far, and the last twelve attempts with their judgments. **Cancel** stops after the prompt in flight; everything recorded stays. |
| **Results** | A one-paragraph verdict (who ranked first, by how much, and every reason not to over-read it), the ranking table (quality, pass/partial/fail, reliability, median and p95 latency, tokens per second, boundaries crossed), strengths and weaknesses, a side-by-side capability grid, every case with a drill-down to the exact prompt, answer, and judgment, and a recommendation under a fixed policy that can be recorded into the evidence. |
| **History** | Every benchmark ever run on this computer with its machine, models, suites, and state. Reopen any result; tick two benchmarks to compare them — Model Lab says plainly when they are not like-for-like. |
| **Settings & diagnostics** | Ollama endpoint (loopback only), model "thinking" mode, evidence folder (with an optional custom location), export of the whole evidence bundle, this computer's facts, version/build/runtime, benchmark catalog digest, log file, and a *Copy diagnostics* button. |

### How to read the results

- **Rankings apply within one benchmark only**, where every model faced the same prompts on the same
  machine. Model Lab never produces one universal score.
- **Quality** counts passes at full weight and partials at half, over the answers a rule could judge.
  Timeouts and errors count against **reliability**, never as zero quality; missing evidence is shown as
  *n/a*, not 0.
- A **hard boundary** (inventing a personal fact, claiming an action happened, changing a configuration
  silently, …) sinks a model to the bottom regardless of fluency.
- The **recommendation** is one of four outcomes — recommended, not recommended, insufficient evidence,
  disqualified — under a fixed policy. A short benchmark usually yields *insufficient evidence*; that is
  the honest answer, not a bug. A recommendation changes nothing anywhere.

## Where your data lives

| | macOS | Windows |
| --- | --- | --- |
| Settings, sessions, log | `~/Library/Application Support/Model Lab/` | `%APPDATA%\Model Lab\` |
| Evidence store (append-only JSON) | `~/Library/Application Support/Model Lab/evidence/` | `%APPDATA%\Model Lab\evidence\` |

Both are shown in *Settings & diagnostics* with *Open* buttons. History survives updates and reinstalls.
Nothing is ever overwritten or deleted by Model Lab; a re-run is a new run.

## Privacy and local processing

- Every prompt is an invented fixture with a `synthetic:` origin; the validator refuses anything else.
  No personal data is read, sent, or stored.
- The only network Model Lab uses is the loopback connection to Ollama on the same computer; endpoints
  that are not `127.0.0.1`, `localhost`, or `::1` are refused.
- The only download path is the explicit, confirmed *Add a model* action; benchmark execution can only
  read, describe, and generate.
- There is no telemetry, no update check, no account.
- Model thinking/reasoning traces, when a model produces them, are never stored — only their length.

## Build from source

Requirements: Node 20 or later and npm. macOS packaging requires macOS; Windows packaging works from
macOS, Linux, or Windows.

```
cd model-lab
npm install
npm test               # 200 unit + parity tests (vitest)
npm run build          # electron-vite → out/
npm run test:e2e       # Playwright drives the built application end to end
npm run dist:mac       # Model Lab.app + DMG + ZIP for arm64 and x64 → dist/
npm run dist:win       # NSIS installer + portable exe → dist/
npm run smoke:mac      # bundle/Info.plist/signature checks + Finder-equivalent launch of dist/mac-arm64/Model Lab.app
npm run dev            # hot-reloading development window
```

## Release artifacts

| File | Platform | What it is |
| --- | --- | --- |
| `Model-Lab-<v>-macos-arm64.dmg` / `.zip` | macOS, Apple Silicon | Drag-to-Applications disk image / plain zip of `Model Lab.app` |
| `Model-Lab-<v>-macos-x64.dmg` / `.zip` | macOS, Intel | Same, Intel build |
| `Model-Lab-Setup-<v>-x64.exe` | Windows x64 | Per-user NSIS installer |
| `Model-Lab-Portable-<v>-x64.exe` | Windows x64 | Single executable, no install |

All artifacts are unsigned unless a certificate is configured at build time (see comments in
`electron-builder.yml`). `.blockmap` files are electron-builder by-products and can be ignored.

## Tests

- `test/unit/` — engine behaviour (fail-closed execution, append-only store, cancellation, idempotent
  evaluation), the Ollama transport against a scripted loopback server (unavailable, available, no
  models, enumeration, not found, malformed, timeout, cancellation), and application state (settings
  persistence and validation, session recovery after an unclean exit, machine-summary honesty, the
  application menu).
- `test/parity/` — 157 assertions that this engine produces byte-identical digests, plans, evidence,
  evaluations, profiles, recommendations, and on-disk stores to the canonical Swift implementation the
  fixtures were generated from (see [Architecture](#architecture)).
- `test/e2e/` — the built application under Playwright: install-to-results with the reference model,
  relaunch persistence, cancel-and-keep, a two-model benchmark against a scripted Ollama covering
  HTTP failure, malformed output, timeout, and a hard-boundary violation, settings persistence and
  refusal of non-loopback endpoints, menu navigation, and (on macOS, when built) the packaged
  `Model Lab.app` launching from its bundle with data in Application Support.
- `scripts/windows-smoke.ps1` — silent install, launch, evidence check, uninstall on a real Windows PC.

## Known limitations

- **Unsigned, not notarized** (macOS) and **unsigned** (Windows): expect the Gatekeeper / SmartScreen
  steps above until a signing identity is configured.
- **Windows has not yet been exercised on a Windows machine** in this release cycle. The Windows
  artifacts are built from the same source and runtime as the macOS build and pass the automated
  application tests on macOS; the installer, CIM hardware detection, and Ollama tray start are verified
  by `scripts/windows-smoke.ps1` on real hardware, which has not run yet.
- Linux is not packaged (the code is portable; an AppImage target exists in the config but is untested).
- Model Lab reads the GPU on macOS from the system report and on Windows from CIM; on other systems it
  is reported as not available rather than guessed. Thermal state is never read.
- Ollama must be reachable on loopback. Remote Ollama hosts are deliberately refused so the hardware
  facts recorded with every result describe the machine that actually ran the model.
- The benchmark suites are fixed and versioned; you cannot author new suites in the app. Suite titles
  and system prompts are part of the sealed fixtures, so a few carry the name of the project the engine
  was first built for.

## Architecture

- `src/core/` — the portable engine (TypeScript, no Electron dependency): digests, suite catalog,
  planner, executor, append-only stores, deterministic evaluators, capability profiles,
  recommendation, history and comparability, the Ollama adapter and loopback HTTP transport.
- `src/main/` — Electron main process: window and macOS/Windows menu, environment capture, Ollama
  detection / start / explicit pull, sessions, settings, the lab service, IPC.
- `src/preload/` — the narrow typed bridge the renderer may call. `src/shared/ipc.ts` is the contract.
- `src/renderer/` — the React UI (Home, Models, Benchmark, Live run, Results, History, Settings).
- `fixtures/parity/` — generated by the canonical Swift implementation of the same engine
  (`Sources/SkippyModelLabParityFixtures` in the parent repository, `swift run SkippyModelLabParityFixtures <dir>`).
  `scripts/regenerate-parity-fixtures.sh` regenerates them; `scripts/verify-store-with-swift.sh`
  checks the reverse direction (a store written here, validated by the Swift CLI).

Model Lab is the standalone form of an engine that also lives, in Swift, inside a larger private
project. The Swift implementation remains canonical; this port is proven equivalent by the parity
fixtures rather than by inspection, and its evidence store is byte-compatible.
