# Naming policy

**The product is Cernum.** It was called *Model Lab* until v0.2.0. The full inventory behind this
policy is in [NAMING-AUDIT-2026-09-24.md](NAMING-AUDIT-2026-09-24.md).

## Rules

1. **Every current surface says Cernum.** That covers window and menu titles, the About box, the CLI
   banner, help and errors, installers, artifact filenames, shortcuts, log and export filenames,
   README and current docs, package metadata, and test descriptions that are not bound to evidence.
2. **Read the name; don't type it.** `package.json` (`productName`, `name`) and `electron-builder.yml`
   decide it. Source reads it through `src/shared/product.ts` (`PRODUCT.name`, `PRODUCT.slug`).
3. **"Model Lab" may remain only for one of these reasons,** and the reason must be evident from the
   code or a comment next to it:
   - **Sealed evidence.** The suite, policy, candidate, budget and provenance IDs (`suite.model-lab.*`,
     `policy.model-lab.*`, `model-lab-fake`, and so on), the sealed suite titles and system prompt, the
     store-manifest description, `fixtures/parity/**` and `docs/campaigns/**`. These are digested, and
     changing a byte orphans results already on disk. On screen, `displaySuiteTitle` removes the
     title prefix.
   - **Migration.** `LEGACY_PRODUCT_NAME` and `model-lab.log` in `src/main/user-data-migration.ts`
     find and copy an old install's data.
   - **Compatibility aliases.** The `MODEL_LAB_*` environment variables (read after `CERNUM_*`, in
     `environmentOverride`), `MODEL_LAB_APP` for the packaged-app spec, and `MODEL_LAB_HARNESS` for
     the ledger-vector regenerator.
   - **History.** Release notes, published install scripts, and text that describes the old name *as*
     the old name, such as "Upgrading from Model Lab?".
   - **External names this repository does not control.** The GitHub repository slug
     `happySNAG/model-lab`, which GitHub redirects if the repository is ever renamed. Also the
     `SkippyModelLab*` Swift targets, the Swift `ModelLab*` type names cited in port comments, the
     `model-lab-v2` reference harness, and the `model-lab-results` evidence directory.
4. **New code, tests and docs must not introduce Model Lab branding** without one of those reasons. A
   new compatibility reason means a new, narrow allowlist entry, with that reason written beside it.

## The guard

`test/engine/naming-guard.test.ts` scans every tracked and untracked-but-not-ignored file. It removes
the sealed identifier patterns, then counts the lines per file that still mention the old name in any
spelling. Each file that is allowed to mention it has an **exact** count and a reason. The test fails
in three cases:

- a file outside the allowlist mentions the old name;
- an allowlisted file gains an occurrence;
- an allowlisted file loses one. Update the count and keep the list honest.

The same test also checks that the packaging metadata still produces Cernum-named artifacts.

Other historical names are out of scope. **Skippy** is the downstream application the evaluation
suites were first written for, not a former name of Cernum. It survives in sealed suite titles, which
`displaySuiteTitle` removes on screen.
