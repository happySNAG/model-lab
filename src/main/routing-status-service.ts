// Cernum · the read-only routing status behind the Qualification and Routing screens.
//
// WHAT IT DOES. Reads the cse1 status-export document for one campaign root, the same root the
// Campaigns screen uses, exactly as `cernum status-export --expiry-warnings` assembles it: the
// observation store (`readObservationStore`), the sealed workspace runs under the root
// (`collectWorkspaceRunRows`, each run counted once), the runtime leases (`leasedEndpoints`), and
// `deriveStatusExport` with `expiryWarnings: true`. Every verdict, chain and finding is the engine's own.
//
// WHAT IT DOES NOT DO, AND EACH IS A RULE. It writes nothing, contacts no model, provider or network
// service, starts no process and changes no route. It has no Electron dependency, so it can be tested
// in a plain node process against a temporary root.

import { createHash } from 'node:crypto';
import {
  allWorkspaceCases, collectWorkspaceRunRows, deriveStatusExport, leasedEndpoints, machineKey, readMachineFingerprint,
  readObservationStore, registeredWorkspaceDifficultyProfiles, routeSpendPosture,
} from '../engine/index';
import type { WorkspaceRunRow } from '../engine/workspace-aggregate';
import type { RoutingStatusResult } from '../shared/ipc';

export interface RoutingStatusOptions {
  /** The campaign root, as `CampaignService.root()` returns it. */
  root: string;
  /** The `cmk1:` machine key answered for. Absent: this machine, from what the OS reports. */
  machineKey?: string;
  /** The instant answered for. Absent: now. */
  now?: Date;
}

/**
 * A sealed run's identity, from its row's own content, so a run is never counted twice. The same rule
 * `cernum status-export` applies when it gathers runs; restated here because the CLI keeps it private.
 */
function runIdentity(run: WorkspaceRunRow): string {
  const row = run.row;
  const stable = Object.keys(row).sort().map((key) => `${key}=${JSON.stringify(row[key])}`).join('\u0000');
  return createHash('sha256').update(stable).digest('hex');
}

function workspaceRowsUnder(root: string): WorkspaceRunRow[] {
  const seen = new Set<string>();
  return collectWorkspaceRunRows(root).filter((run) => {
    const id = runIdentity(run);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * The cse1 document (schemaVersion 2, with expiryWarnings) for `root`, or the reason it could not be read.
 * READ-ONLY: never throws for what it finds on disk; a failure is returned, in words.
 */
export function readRoutingStatus(options: RoutingStatusOptions): RoutingStatusResult {
  const { root } = options;
  try {
    const machine = options.machineKey ?? machineKey(readMachineFingerprint());
    const contents = readObservationStore(root);
    const workspaceRows = workspaceRowsUnder(root);
    const document = deriveStatusExport({
      machineKey: machine, contents, workspaceRows, now: options.now ?? new Date(),
      workspaceCases: allWorkspaceCases(), difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
      leases: leasedEndpoints(root),
      spendFor: ({ provider, modelID }, at) => routeSpendPosture({ provider, modelID, now: at }),
      expiryWarnings: true,
    });
    return { ok: true, root, document };
  } catch (error) {
    return { ok: false, root, reason: error instanceof Error ? error.message : String(error) };
  }
}
