# Naming audit · 2026-09-24 ("Cernum is Cernum")

The product has been Cernum since v0.2.0. This audit went through every remaining reference to its old
name, **Model Lab**, in whatever spelling (`Model Lab`, `Model-Lab`, `model-lab`, `MODEL_LAB`,
`ModelLab`, `modelLab`, `modellab`). Each one was classified before anything was edited. The policy
that came out of it is in [NAMING.md](NAMING.md), and `test/engine/naming-guard.test.ts` enforces it.

Starting point: `main` at `640c2d2`. Search: `git grep -i -E 'model[ _-]?lab|modellab'`. It matched
**5,114 lines** in 150+ tracked files.

Classes:

- **A** Must rename: user-facing or current product identity.
- **B** Must preserve: sealed, hashed, provenance-sensitive or historical. Changing it would invalidate
  evidence or rewrite history.
- **C** Compatibility alias: a legacy value that must still be accepted, while new output uses Cernum.
- **D** Historical explanation: the text describes the old name *as* the old name, and it is still accurate.

## Summary by location

| Location | Lines | Class | Why |
| --- | ---: | --- | --- |
| `fixtures/parity/**` | 4,109 | B | Sealed parity corpus (see `docs/PARITY.md`). Every byte is digested; suite, policy, candidate and budget IDs such as `suite.model-lab.*` sit inside content-addressed records. |
| `docs/campaigns/**` | 510 | B | Sealed campaign evidence (Pass 11 ledger, manifest, blinded review packet). Hash-chained. |
| `docs/RELEASE-NOTES-v*.md` | 27 | B / D | Historical release records. The v0.1.0 notes were written when the product *was* Model Lab. The v0.2.x notes describe the rename and the migration defect. |
| `scripts/releases/install-cernum-v*.sh` | 53 | B / C | Published installer scripts, pinned by commit SHA in the release notes. They name the legacy `~/Library/Application Support/Model Lab` folder they recover data from, and download from the real GitHub repository slug. |
| `scripts/releases/README.md` | 7 | D / C | Describes what those scripts do to the legacy folder, plus the pinned download URLs. |
| `src/**` | 214 | mixed | See below. |
| `test/**` | 138 | mixed | See below. |
| `scripts/**` (other) | 39 | mixed | See below. |
| Root docs, `package.json`, `.gitignore`, `.github/**` | 17 | mixed | See below. |

## Sealed identifiers (class B), wherever they appear

These strings are part of the evaluation contract. They appear in `src/core/catalog.ts`,
`src/core/foundation.ts`, `src/core/candidate.ts`, `src/engine/catalogue.ts`, `src/main/lab-service.ts`,
`src/renderer/views/Benchmark.tsx`, `src/renderer/views/Results.tsx`, tests and fixtures. Renaming any of
them would orphan every recorded result on every user's disk and break the parity digests.

- Suite IDs: `suite.model-lab.<name>` (14 suites, plus `-v2`)
- Policy IDs: `policy.model-lab.<dimension>.<rule>` and `policy.scoring.model-lab-foundation[.*]`
- Reference candidate: provider `model-lab-fake`, ID `candidate:model-lab-fake:deterministic-reference:1:none`
- Fixture provenance: `synthetic:model-lab-c1-*`, `synthetic:model-lab-c2-*`, `model-lab-campaign-1`,
  `model-lab-campaign-2 (…)`, `model-lab-foundation-v2`
- Resource budgets: `budget.resource.model-lab-c1-unmetered`, `budget.resource.model-lab-c2-unmetered`
- Sealed suite titles: `Model Lab Foundation Suite`, `Model Lab Foundation Suite v2 (…)`. They are
  displayed through `displaySuiteTitle`, which removes the prefix.
- Benchmark system prompt: `…evaluated inside the Skippy Model Lab on synthetic fixtures.` This is part of
  every prompt digest (`src/core/catalog.ts`, `src/core/foundation.ts`).
- Store manifest description: `Skippy Model Lab permanent evaluation history…` (`src/core/file-store.ts`).
  It is written into `store-manifest.json` and compared byte for byte by the parity suite.
- Canonical vector input `gemma3:4b|model-lab-foundation|1|…` (`scripts/regenerate-canonical-vectors.py`,
  `fixtures/parity/engine/*`).
- Captured model output quoting the prompt (`test/engine/fixtures/pass06-captured.ts`).
- Recorded evidence paths `model-lab-results/…` (`src/engine/reconciliation.ts`). These are provenance
  citations into an external evidence tree.

## `src/**` (214 lines), non-sealed

| Occurrence | Class | Action |
| --- | --- | --- |
| 59 file-header comments `// Model Lab core · …` / `// Model Lab · …` / `/* Model Lab · … */` (src/core, src/main, src/preload, src/shared/ipc.ts, src/renderer/styles.css) | A | Rename to `Cernum core ·` / `Cernum ·`. |
| `(port of \`ModelLabX\`)` in those headers, and `ModelLabDigest`, `ModelLabOllama*` and similar in comments | D | Keep. These are the real type names in the canonical Swift implementation the engine was ported from, and they are accurate as cited. |
| `src/main/settings.ts:2` "Windows: %APPDATA%\Model Lab" | A | Wrong today. Change to `%APPDATA%\Cernum`. |
| `src/core/candidate.ts:150` "Model Lab never lists or runs it" | A | Change to Cernum. |
| `src/shared/ipc.ts` `ModelLabAPI`, `src/preload/index.ts` `window.modelLab`, `src/renderer/api.ts` | A | An internal bridge name, never persisted. The preload and the renderer are built together. Rename to `CernumAPI` / `window.cernum`. |
| `src/shared/ipc.ts:793` "reads as Model Lab's own" | A | Change to "Cernum's own". |
| `src/shared/ipc.ts:796` regex `^(Skippy\|Model Lab) ` in `displaySuiteTitle` | C | Keep. This is what stops a sealed title from reaching the screen. Add a comment. |
| `src/main/lab-service.ts` `adapterID: 'adapter:model-lab:composite'` | A | Not persisted or read anywhere (only `fake`/`ollama` adapter IDs reach records). Rename to `adapter:cernum:composite`. |
| `src/main/lab-service.ts:568` `.replace('suite.model-lab.', '')` | B | Operates on the sealed suite ID. Keep. |
| `src/main/index.ts:118` default export filename `model-lab-evidence-<stamp>.json` | A | User-facing. Derive from `PRODUCT.slug` (`cernum-evidence-…`). |
| `src/main/user-data-migration.ts` `LEGACY_PRODUCT_NAME = 'Model Lab'`, `'model-lab.log'` in `MIGRATED_ENTRIES`, header history | C / D | Keep. This is how old installs are found and carried across. Add a comment on the log entry. |
| `src/shared/product.ts` `MODEL_LAB_${suffix}` fallback and its comments | C / D | Keep. Documented env-var alias. |
| `src/cli/cernum.ts` `suites` command prints the raw `suite.title` | A (leak) | Sealed titles `Model Lab Foundation Suite…` reach the terminal. Route through `displaySuiteTitle`. |
| `src/renderer/views/Campaigns.tsx:822` prints raw `suite.title` | A (leak) | Same leak on the Campaigns screen. Route through `displaySuiteTitle`. |
| `src/renderer/views/{Benchmark,Home,OllamaStatusCard}.tsx` "try the lab" | A | Old product-as-"the lab" copy. Change to "try Cernum". |

## `test/**` (138 lines), non-sealed

| Occurrence | Class | Action |
| --- | --- | --- |
| e2e `MODEL_LAB_USER_DATA` / `MODEL_LAB_CAMPAIGN_ROOT` launch env (6 specs) | A | Use the canonical `CERNUM_*` names. The legacy alias stays covered in `product-identity.test.ts`. |
| e2e / unit / parity temp-dir prefixes `model-lab-*` | A | Rename to `cernum-*`. |
| `test/unit/app-state.test.ts` menu tests with `productName: 'Model Lab'` | A | Use `Cernum`. |
| `test/engine/lock.test.ts`, `endpoint-lease.test.ts` `'Model Lab · Campaigns screen'` | A | The real owner string is `${PRODUCT.name} … · Campaigns screen`. Use `Cernum`. |
| `test/engine/installed-command.test.ts` launcher paths `Model Lab.app` / `Model Lab.exe` | A | Use `Cernum`. |
| `test/engine/installed-command.test.ts` `MODEL_LAB_CAMPAIGN_ROOT` override test | A + C | Test `CERNUM_CAMPAIGN_ROOT` as canonical, and keep one assertion that the legacy name still works. |
| `test/engine/user-data-migration.test.ts` | C | The migration tests exist to exercise the legacy name. Keep. |
| `test/engine/product-identity.test.ts` `MODEL_LAB_*` | C | Tests of the alias. Keep. |
| `test/e2e/packaged-mac.spec.ts` `MODEL_LAB_APP` | C | Documented alias for the packaged-app path. Keep. |
| `test/e2e/settings-and-menu.spec.ts:46` comment on `model-lab.log` | D | Accurate. Keep. |
| `/Volumes/LaCie/…/model-lab-results` default evidence roots (7 tests) | B | An external directory that exists on disk under that name, and `CERNUM_EVIDENCE_ROOT` overrides it. Keep. |
| `SkippyModelLabParityFixtures` in parity test comment | B | The real name of an external Swift target. Keep. |
| Sealed IDs (suite/policy/candidate) in engine tests | B | Keep. |

## `scripts/**` (other than releases, 39 lines)

| Occurrence | Class | Action |
| --- | --- | --- |
| `scripts/windows-smoke.ps1` looks for `Programs\Model Lab\Model Lab.exe`, `Model Lab.lnk`, `%APPDATA%\Model Lab\model-lab.log` | A (broken) | This smoke test cannot pass against a current installer. Point it at `Cernum`. |
| `scripts/regenerate-ledger-plan-vectors.py` `MODEL_LAB_HARNESS` | C | Make `CERNUM_HARNESS` canonical and keep `MODEL_LAB_HARNESS` as a fallback. |
| `scripts/req0*-*.ts` default `…/model-lab-results` | B | External evidence directory, as above. |
| `scripts/maintainer/*.sh`, `scripts/req03-phase6-rebaseline-parity.ts` `SkippyModelLab*` | B | External Swift target names. |
| `scripts/macos-smoke.sh:5` comment about the old assertion | D | Accurate history. Keep. |
| `scripts/regenerate-canonical-vectors.py` `model-lab-foundation` | B | Sealed vector input. |

## Root documents and metadata (17 lines)

| Occurrence | Class | Action |
| --- | --- | --- |
| `package.json` `homepage` / `repository` / `bugs` → `github.com/happySNAG/model-lab` | B (external) | The GitHub repository is still named `model-lab`. Changing these URLs would break them. Renaming the repository is an outward-facing action outside this campaign. GitHub redirects after a rename, so these can follow later. |
| `.github/ISSUE_TEMPLATE/*.yml` repo URLs | B (external) | Same. |
| `README.md` / `CONTRIBUTING.md` issue and release links | B (external) | Same. |
| `README.md` / `CONTRIBUTING.md` `git clone …model-lab.git` then `cd model-lab` | A (partly) | Keep the URL, but clone into a `cernum` directory so the working copy carries the product's name. |
| `README.md:288-297` "Upgrading from Model Lab?" | D | Accurate migration guidance. Keep. |
| `.gitignore` `model-lab.log` | — | Redundant with the `*.log` line above it. Remove. |

## Other historical names found

- **Skippy** is the downstream application the evaluation suites were first written for. It is *not* a
  former name of this product. It appears in sealed suite titles (`Skippy Conversation Quality` and
  others, removed on display by `displaySuiteTitle`), in the sealed system prompt and store description,
  in the recommendation disclaimer, and in the identity-admission note. Out of scope, and kept.
- **`org.modellab.desktop`** is the old bundle ID. It appears only in the `macos-smoke.sh` history comment
  (class D). `electron-builder.yml` already uses `org.cernum.desktop`.
- **"Full lab"** is the name of the "every suite" preset (Benchmark screen, History, README, stored
  session labels). It is a generic word rather than the product name, and existing sessions on disk
  already carry it as their label. Kept as a mode name, and recorded here as a judgement call.

## Result

What was done, and what the re-run search found afterwards:

- **Renamed (A):** about 126 occurrences. That is 59 file headers, the IPC bridge
  (`ModelLabAPI`/`window.modelLab` → `CernumAPI`/`window.cernum`), the settings path comment, the
  composite adapter ID, the evidence-export filename, the Windows smoke script (12 lines), the e2e launch
  environments and temp-directory prefixes, the unit and engine test fixtures, the harness env var, and
  the clone directory. One redundant `.gitignore` line was removed.
- **Leaks fixed with no legacy string in the source:** `cernum suites` and the Campaigns screen
  printed sealed suite titles raw, so `Model Lab Foundation Suite` reached the terminal and the UI.
  Both now go through `displaySuiteTitle`. The copy "try the lab" became "try Cernum" in three places.
- **Compatibility aliases retained (C):** `MODEL_LAB_USER_DATA`, `MODEL_LAB_CAMPAIGN_ROOT`,
  `MODEL_LAB_OLLAMA_ENDPOINT`, `MODEL_LAB_APP`, `MODEL_LAB_HARNESS` (new `CERNUM_HARNESS` is canonical),
  the `Model Lab` legacy data directory, `model-lab.log`, and the `Model Lab ` title prefix accepted by
  `displaySuiteTitle`.
- **Tests added:** `test/engine/naming-guard.test.ts` (6 tests). A migration test proving that a
  pre-rename install's settings and sealed evidence store still *load* after the rename. An
  installed-command test showing the legacy `MODEL_LAB_CAMPAIGN_ROOT` still works beside the canonical
  `CERNUM_CAMPAIGN_ROOT`.
- **After:** 5,020 tracked lines still match. After the sealed identifiers are removed, the remainder is
  63 lines in 19 files. Every one of them is listed, with its reason, in the guard's allowlist.
