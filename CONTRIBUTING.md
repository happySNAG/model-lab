# Contributing to Model Lab

Thanks for taking a look. Model Lab is a small, deliberately conservative codebase: it records
evidence that people use to make decisions, so correctness and honesty matter more here than
features. Bug reports and small, well-tested changes are very welcome.

## Getting set up

You need **Node 20 or later** and npm. Nothing else is required to build, run or test — Ollama is
only needed if you want to benchmark real models rather than the built-in reference model.

```bash
git clone https://github.com/happySNAG/model-lab.git
cd model-lab
npm install
npm run dev          # hot-reloading development window
```

Useful commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Development window with hot reload |
| `npm test` | Unit + parity suites (vitest) — fast, no Electron |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm run build` | Production bundles into `out/` |
| `npm run test:e2e` | Playwright drives the built application end to end (run `npm run build` first) |
| `npm run test:all` | typecheck → unit/parity → build → end-to-end |
| `npm run dist:mac` / `dist:win` | Packaged installers into `dist/` |

Please run `npm run test:all` before opening a pull request.

## How the code is arranged

```
src/core/       the portable engine — no Electron, no I/O beyond the store; pure and testable
src/main/       Electron main process: window, menu, settings, Ollama detection, IPC handlers
src/preload/    the narrow typed bridge; src/shared/ipc.ts is the contract
src/renderer/   the React interface (Home, Models, Benchmark, Live run, Results, History, Settings)
fixtures/parity/  a frozen reference corpus — see docs/PARITY.md
test/           unit, parity and end-to-end suites
```

The renderer never touches Node APIs; everything crosses `src/shared/ipc.ts` as plain JSON. If you
find yourself wanting to widen that bridge, that is usually a sign the work belongs in `src/main/`.

## Things that are deliberate, not oversights

Please read these before proposing a change that touches them — each one is load-bearing.

- **`fixtures/parity/` is sealed.** It is never regenerated and never hand-edited. If a change moves
  any of those bytes, it changes the engine's observable behaviour; say so explicitly in the pull
  request. See [docs/PARITY.md](docs/PARITY.md).
- **Benchmark suites are versioned and immutable.** Editing a prompt, a budget or a rule silently
  invalidates every result already recorded on every user's disk. New behaviour goes in a new suite
  version, never in an edit to an existing one.
- **Answers are judged by fixed deterministic rules, never by another model.** Anything a rule cannot
  judge is marked for human review rather than guessed. Please do not propose an LLM judge.
- **The evidence store is append-only.** Nothing is overwritten or deleted; a re-run is a new run.
- **Only loopback network access.** Endpoints that are not `127.0.0.1`, `localhost` or `::1` are
  refused, so the hardware facts recorded with a result always describe the machine that ran it.
  There is no telemetry, no update check and no account, and there should never be one.
- **Missing data is shown as missing.** A value the system did not report is `n/a` with a reason, not
  a zero and never an estimate.

## Pull requests

- Keep changes focused; one concern per pull request.
- Add or update tests. Engine changes belong in `test/unit/`; interface changes in `test/e2e/`.
- Match the surrounding style. There is no linter to argue with — the code is plain TypeScript with
  `strict` on, and comments explain *why*, not *what*.
- User-facing copy is part of the product. Prefer plain language over jargon, say what will happen
  before it happens, and never overstate what the evidence supports.
- Describe how you tested it, including which platform you tested on.

## Platform notes

macOS is the reference platform and is the one regularly exercised. Windows builds from the same
source and passes the automated suites in CI, but the packaged Windows application has not yet been
smoke-tested on real Windows hardware — if you run `scripts/windows-smoke.ps1` on a Windows PC, a
report of what happened is genuinely valuable. Linux is not packaged; the code is portable but
untested there.

## Reporting bugs and asking questions

Open an issue. There are templates for bug reports and feature requests. For anything with a security
or privacy dimension, please read [SECURITY.md](SECURITY.md) first.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

By contributing you agree that your contributions are licensed under the MIT License, the same terms
that cover the rest of the project.
