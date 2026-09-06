# Model Lab v0.1.0

The first public release.

Model Lab is a desktop benchmarking environment for comparing the language models that run on your
own computer. You pick some models, pick what to test, and every answer is judged by fixed
deterministic rules — never by another AI. What you get back is a ranking *within that one benchmark*
with every caveat stated, and a permanent local record of exactly what was asked, what came back, and
why it scored the way it did.

Nothing leaves your machine. No account, no telemetry, no update check.

## What it does

- **Benchmarks local models through [Ollama](https://ollama.com)**, plus a built-in deterministic
  reference model so you can walk the entire workflow before Ollama is even installed.
- **14 versioned suites, 44 cases, 12 capabilities.** A *Quick check* is 11 attempts per model; the
  *Full lab* is 46. You can also hand-pick suites.
- **Measures quality, reliability, median and p95 latency, tokens per second, and hard-boundary
  violations**, and breaks all of it down per capability.
- **Judges deterministically**: matching, required and prohibited concepts, refusal classification,
  JSON conformance, ordering, provenance labelling. Anything a rule cannot honestly judge is marked
  *needs human review* rather than guessed at, and is excluded from the score in both directions.
- **Records a hard boundary as disqualifying.** Inventing a personal fact, claiming an action
  happened, silently changing a configuration or exceeding an authorised scope sinks a model to the
  bottom of the ranking regardless of how fluent it was.
- **Issues a recommendation under a fixed, published policy** — recommended, not recommended,
  insufficient evidence, or disqualified — that is deliberately hard to earn, and that changes
  nothing anywhere by itself.
- **Keeps an append-only local evidence store.** Nothing is ever overwritten; a re-run is a new run.
  Export the whole store as one JSON bundle with a digest at any time.
- **Compares any two past benchmarks**, and says plainly when they are not like-for-like.
- **Shows missing data as missing.** A value the runtime or the operating system did not report is
  *n/a* with the reason — never a zero, never an estimate.

## Supported platforms

| Platform | Status |
| --- | --- |
| macOS 12+, Apple Silicon (arm64) | Reference platform. DMG and ZIP. |
| macOS 12+, Intel (x64) | DMG and ZIP, built from the same source. |
| Windows 10 / 11 x64 | NSIS per-user installer and a portable executable. See *Windows verification status* below. |
| Linux | Not packaged. |

## Supported model runtimes

- **Ollama on this computer** — any model you have installed. Model Lab detects it, can start it, and
  can ask it to download a model after you confirm by name.
- **Built-in deterministic reference model** — always available, no runtime required.

Not supported in this release: hosted API models (Claude, GPT, Gemini and similar), remote Ollama
hosts, and other local runtimes such as llama.cpp, LM Studio or MLX. Non-loopback endpoints are
refused by design, so that the hardware facts recorded with every result describe the machine that
actually ran the model.

## Privacy

- The only network connection is to Ollama on loopback. There is no telemetry, no crash reporting, no
  update check and no account.
- Every benchmark prompt is a fixed synthetic fixture. Model Lab reads no files, messages, contacts
  or calendars, and contains no code that could.
- Prompts, answers and results stay in your user application-data folder as plain JSON, and survive
  uninstalling the application.
- If a model produces internal "thinking", only its length is recorded, never its content.

## Known limitations

- **Builds are unsigned.** macOS builds are ad-hoc signed but carry no Apple Developer ID and are not
  notarized; Windows builds are unsigned. Expect Gatekeeper and SmartScreen warnings — the README
  walks through both — and note that you cannot cryptographically verify a downloaded artifact.
- **You cannot author benchmark suites in the application.** The suites are fixed and versioned so
  that results stay comparable, including with their own past selves.
- **Some sealed fixtures carry an older project's name.** The engine was first written for a private
  application; its suite titles, system prompts and the reference model's stored name were sealed
  then and are pinned by the equivalence corpus and by every result already on disk, so they are not
  edited. The interface presents its own names over them, but the attempt drill-down shows the prompt
  verbatim, because that is evidence.
- **Two capabilities are partly human-judged.** Conversational warmth and emotional attunement are
  marked *needs human review*; there is no screen for recording those judgments yet.
- **The suites reflect that origin.** They lean towards assistant behaviour — memory honesty,
  privacy, safety boundaries — and are not a general coding, mathematics or translation benchmark.
- **Thermal state is never read**, so a thermally throttled run looks simply like a slow run.

## Windows verification status

Being precise, because "should work" and "was checked" are different claims:

- ✅ Builds from source on Windows, in CI.
- ✅ Typecheck and all 200 unit and parity tests pass on Windows, in CI.
- ✅ The end-to-end Playwright suite drives the real Electron application on Windows, in CI.
- ✅ The NSIS installer and portable executable are produced on Windows, in CI.
- ⚠️ Windows-specific code paths (CIM hardware query, `%APPDATA%` locations, Ctrl accelerators,
  starting Ollama) are reviewed and exercised by those automated suites, but have not been observed
  on physical hardware.
- ❌ **Installing, launching and uninstalling the packaged application on a real Windows PC has not
  been done.** `scripts/windows-smoke.ps1` performs exactly that check and is waiting for someone to
  run it. Reports either way are the most useful contribution to this release.

## Verification for this release

- 200 unit and parity tests, and 6 end-to-end tests against the built application, all passing on
  macOS.
- 157 of those parity assertions check byte-for-byte equality with a frozen reference corpus produced
  by an independent second implementation of the same engine. See `docs/PARITY.md`.
- macOS arm64 and x64 packaged, with the bundle smoke test passing: structure, `Info.plist`,
  architecture, ad-hoc signature, and a Finder-equivalent launch storing data in Application Support.
- Windows installer and portable executable built successfully.
- The full user journey exercised against real Ollama models: install-to-results, live progress,
  cancellation, results, drill-down, recommendation, history and comparison.

## Licence

MIT. Third-party components are listed in `THIRD-PARTY-NOTICES.md`.
