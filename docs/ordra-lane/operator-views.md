# Operator views: Qualification and Routing

Two read-only screens in the desktop app, reached from the sidebar. Both show the cse1 status export
(`docs/ordra-lane/status-export.md`, schema `docs/ordra-lane/status-export.schema.json`) for the app's
campaign root, the same root the Campaigns screen uses. **They write nothing, contact nothing and change
no route. Neither screen has an action button.**

## Where the data comes from

- `src/main/routing-status-service.ts`: `readRoutingStatus({ root })` assembles the document the way
  `cernum status-export --expiry-warnings` does: `readObservationStore(root)`, the sealed workspace runs
  under the root (`collectWorkspaceRunRows`, each run counted once by its row's own content),
  `leasedEndpoints(root)`, and `deriveStatusExport` with `expiryWarnings: true`, so the document is
  schemaVersion 2. The machine is this machine (`machineKey(readMachineFingerprint())`). It returns
  `{ ok: true, root, document }`, or `{ ok: false, root, reason }` when the evidence could not be read; it
  never throws for what it finds on disk. Only the default root is read; `--evidence-roots` has no
  counterpart here.
- IPC: `getRoutingStatus()` on the bridge (`src/shared/ipc.ts`, channel `lab:routing:status`,
  `src/main/index.ts`, `src/preload/index.ts`).
- The view-model is `src/renderer/routing-status-view.ts`. It is pure (no React, no bridge):
  `qualificationView(document)` and `routingView(document)`, and `qualificationViewOf(result)` and
  `routingViewOf(result)` for the bridge's answer. It re-decides nothing; every verdict, expiry, chain and
  finding is the engine's, unchanged.

## The screens

- **Qualification** (`src/renderer/views/Qualification.tsx`): one row per `qualifiedRoutes.routes` entry,
  in the document's order: safe to route or not, the newest `recentQualificationResults` verdict and when,
  the last successful qualification, the `expiryWarnings` entry on that route (expiring or expired, with
  `expiresAt` and the reason), availability and blockers.
- **Routing** (`src/renderer/views/Routing.tsx`): every `fallbackChains.tasks` task type with its tiers
  in order, each tier's entries by position (in chain or falls through, with the reasons), and a list of
  every route the regression report marks regressed (any finding other than `staleQualification`) or stale
  (a `staleQualification` finding). The marks appear on the chain entries too. A fallback chain is advisory,
  not a selection.

## States, in words

- No routes: Qualification says no route is known and nothing is safe to route; Routing says no route is in
  any fallback chain, and each empty tier says so. Neither shows a blank table.
- Corrupt observation files: both screens say how many did not verify and were not read, and list them by
  path. The rest of the document is still shown.
- Unreadable root, or a document that is not cse1: the screen says why and shows nothing from it.

## Not in the application menu

The screens are in `ScreenID` and `SCREEN_ORDER` and in the sidebar, but not in the application menu's
`SCREENS` (`src/main/menu.ts`), whose Cmd/Ctrl+1..8 shortcuts `test/unit/app-state.test.ts` pins. Their
sidebar tooltip names no shortcut.

## Tests

`test/unit/routing-status-view.test.ts` covers the service on an empty temporary root and on one holding a
corrupt observation (no file or mtime changes, no fetch, socket connect or child process), the views on a
hand-written schemaVersion 2 document that validates against the schema, and the screen ids and the
unchanged menu.
