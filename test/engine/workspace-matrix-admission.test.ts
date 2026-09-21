// The matrix-wide identity admission: how an operator authorises identity-unverifiable Codex routes
// across ONE sealed matrix, and every way that authorization must refuse to reach anything else.
//
// NO PROVIDER IS CONTACTED, AND NO MODEL IS INVOKED. Plans are built against a hand-written discovery
// store; the runs use a scripted driver that stands in for `codex exec` and never starts a process;
// the CLI tests put a RECORDING `codex` and `claude` first on PATH and assert that neither was run.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscoveryEvidence, discoveryStorePath } from '../../src/engine/discovery-store';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import {
  RECEIPT_REFUNDS_SIGN, TASK_PRIORITY_PROPAGATE, allWorkspaceCases, foundationFourPack,
} from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack, workspacePackDigest } from '../../src/engine/workspace-pack';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest,
} from '../../src/engine/workspace-agent';
import { WorkspaceAgentUsage } from '../../src/engine/workspace-host';
import {
  WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan, describeWorkspaceMatrixRunResult,
  runWorkspaceMatrix, workspaceMatrixIdentityProvenance,
} from '../../src/engine/workspace-matrix';
import {
  MATRIX_IDENTITY_LIMITATION, WorkspaceMatrixAdmissionError, WorkspaceMatrixIdentityAdmission,
  WorkspaceMatrixRouteFacts, matrixAdmissionFor, matrixAdmissionSealIsIntact, parseWorkspaceMatrixAdmissionFile,
  recordAdmissionFromMatrix, sealWorkspaceMatrixAdmission,
} from '../../src/engine/workspace-matrix-admission';
import {
  IdentityAdmission, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionFor, admissionSealIsIntact,
  authorizeIdentityAdmission,
} from '../../src/engine/identity-admission';
import { WorkspaceRunRow, aggregateWorkspaceRuns, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { WorkspaceCampaign, workspaceRecordPaths } from '../../src/engine/workspace-campaign';
import {
  CODEX_CLI_VERSION_VERIFIED_AGAINST, CODEX_WORKSPACE_DRIVER_ID, codexWorkspaceUsage, eventsFromCodexEvent,
  newCodexStreamState,
} from '../../src/engine/workspace-codex-driver';
import { providerThrottleScopeFor } from '../../src/engine/workspace-throttle';

const repositoryRoot = path.resolve(__dirname, '..', '..');
const FIXTURE_ROOT = path.resolve(repositoryRoot, 'fixtures');
const NODE_DIRECTORY = path.dirname(process.execPath);
const SOL = 'gpt-5.6-sol';
const ASTRA = 'gpt-6-astra';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

/**
 * What an identity smoke on the Codex route leaves in the store — the shape `modelsFromSmokes` writes:
 * `unproven` (never selectable), no verified identity, and the smoked efforts listed.
 */
function acceptedCodexRoute(modelID: string, efforts = ['max', 'medium'], availability: 'unproven' | 'refused' = 'unproven') {
  const at = new Date().toISOString();
  return { ...provenModel('codexCLI', modelID), availability, verifiedModelID: '', discoveredAt: at, desiredEfforts: efforts,
    evidence: `identity smoke test at ${at} (effort max, subscriptionIncluded, identity state `
      + `requestAcceptedIdentityUnverifiable): ${modelID} was accepted and something answered (fixture)` };
}

const DISCOVERY: DiscoveryEvidence = {
  writtenAt: new Date().toISOString(),
  models: [
    acceptedCodexRoute(SOL), acceptedCodexRoute(ASTRA),
    { ...provenModel('claudeCLI', 'claude-haiku-4-5'), discoveredAt: new Date().toISOString() },
  ],
};

/** Two cases, one attempt each, one repeat: a fast matrix. */
const PACK = makeWorkspaceBenchmarkPack({
  id: 'pack.test.matrix-admission',
  version: '1',
  caseIDs: [RECEIPT_REFUNDS_SIGN.id, TASK_PRIORITY_PROPAGATE.id],
  repeatsPerCase: 1,
});
const PACK_DIGEST = workspacePackDigest(PACK, allWorkspaceCases());
const LABEL = 'codex-admission-test';

/** Codex's own usage decomposition, produced by the real mapping, for the scripted runs to report. */
function codexUsage(): WorkspaceAgentUsage {
  const state = newCodexStreamState();
  eventsFromCodexEvent({ type: 'turn.completed', usage: {
    input_tokens: 67791, cached_input_tokens: 56832, cache_write_input_tokens: 0, output_tokens: 1413,
    reasoning_output_tokens: 117,
  } }, state);
  return codexWorkspaceUsage(state, { reportedModelID: '', requestedModelID: SOL })!;
}

const CHANGES_NOTHING: ScriptedAttempt = { steps: [{ do: 'say', text: 'It looks correct to me.' }] };

/**
 * A stand-in for the Codex workspace driver: its id, its CLI version and its provider, and a scripted
 * run in place of `codex exec`. `reroute` makes a named case report `model rerouted: A -> B` exactly as
 * the real driver surfaces one: the served model as the reported id, and the attempt failed.
 */
function codexFactory(options: { reroute?: { modelID: string; caseID: string; served: string }; runs?: string[] } = {}):
  NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  return (binding) => {
    if (binding.provider !== 'codexCLI') return undefined;
    const driver: WorkspaceAgentDriver & { cliVersionVerifiedAgainst: string; commandName: string } = {
      driverID: CODEX_WORKSPACE_DRIVER_ID,
      provider: 'codexCLI',
      commandName: 'codex',
      cliVersionVerifiedAgainst: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      capabilities: new ScriptedWorkspaceAgent([]).capabilities,
      async run(request: WorkspaceAgentRequest) {
        options.runs?.push(`${binding.requestedModelID}|${request.caseID}`);
        const result = await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(request);
        const rerouted = options.reroute !== undefined && options.reroute.modelID === binding.requestedModelID
          && options.reroute.caseID === request.caseID;
        if (rerouted) {
          return {
            ...result, usage: codexUsage(), completed: false, reportedModelID: options.reroute!.served,
            failure: { kind: 'policyNotExpressible', detail: `the tool reported: ${binding.requestedModelID} -> `
              + `${options.reroute!.served} (HighRiskCyberActivity)` },
          };
        }
        return { ...result, usage: codexUsage(), reportedModelID: '' };
      },
    };
    return driver;
  };
}

interface RouteOverrides { [key: string]: unknown }

function admissionText(routes: RouteOverrides[] = [{}], top: Record<string, unknown> = {}): string {
  return JSON.stringify({
    admissionScope: 'workspaceMatrix',
    authorizedBy: 'the repository owner, for this test',
    reason: 'measure Codex subscription routes whose tool names no model',
    intent: 'measurement only; not routing, not promotion',
    pack: { id: PACK.id, version: PACK.version, digest: PACK_DIGEST },
    admitted: routes.map((overrides) => ({
      provider: 'codexCLI', requestedModelID: SOL, requestedEffort: 'medium',
      driverID: CODEX_WORKSPACE_DRIVER_ID, cliVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST,
      executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
      authenticationBasis: 'ChatGPT subscription session (fixture)',
      evidenceDigest: 'sha256:fixture', evidenceCapturedAt: '2026-09-20T18:27:03Z',
      ...overrides,
    })),
    ...top,
  });
}

function sealed(routes: RouteOverrides[] = [{}], top: Record<string, unknown> = {}, label = LABEL): WorkspaceMatrixIdentityAdmission {
  return sealWorkspaceMatrixAdmission(parseWorkspaceMatrixAdmissionFile(admissionText(routes, top)), {
    matrixLabel: label, authorizedAt: '2026-09-21T23:00:00Z',
  });
}

function request(overrides: Partial<WorkspaceMatrixRequest> = {}): WorkspaceMatrixRequest {
  return {
    pack: PACK,
    cases: allWorkspaceCases(),
    provider: 'codexCLI',
    modelIDs: [SOL],
    effort: 'medium',
    discovery: DISCOVERY,
    campaignRoot: temporary('cernum-ma-root-'),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ma-sandbox-'),
    runLabel: LABEL,
    driverFactory: codexFactory(),
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    ...overrides,
  };
}

const RUN_OPTIONS = { hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'cernum test' };

function facts(overrides: Partial<WorkspaceMatrixRouteFacts> = {}): WorkspaceMatrixRouteFacts {
  return {
    matrixLabel: LABEL, provider: 'codexCLI', modelID: SOL, effort: 'medium', candidate: `codexCLI:${SOL}@medium`,
    packID: PACK.id, packVersion: PACK.version, packDigest: PACK_DIGEST, driverID: CODEX_WORKSPACE_DRIVER_ID,
    cliVersion: CODEX_CLI_VERSION_VERIFIED_AGAINST, executionClass: 'subscriptionCLI', billingBasis: 'subscriptionIncluded',
    ...overrides,
  };
}

// MARK: - 1-3 · refusal by default, admission when explicit, and never "verified"

describe('without an explicit matrix admission, an identity-unverifiable Codex route is refused', () => {
  it('refuses every cell, names why, and runs nothing', async () => {
    const runs: string[] = [];
    const plan = buildWorkspaceMatrixPlan(request({ driverFactory: codexFactory({ runs }) }));
    expect(plan.runnableRunCount).toBe(0);
    expect(plan.models[0].admission).toMatchObject({ required: true, present: false, admitted: false });
    expect(plan.models[0].refusals.join(' ')).toContain('identityAdmissionRequired');
    expect(plan.models[0].refusals.join(' ')).toContain('unprovenRoute');
    expect(plan.cells.every((cell) => cell.identityAdmission === undefined)).toBe(true);

    const result = await runWorkspaceMatrix(plan, request(), RUN_OPTIONS);
    expect(result.executedRunCount).toBe(0);
    expect(result.skipped.every((entry) => entry.disposition === 'refusedInPlan')).toBe(true);
    expect(runs).toEqual([]);
  });

  it('is not enabled by anything in the environment', () => {
    const plan = buildWorkspaceMatrixPlan(request({ environmentSource: {
      PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody',
      CERNUM_ADMIT_IDENTITY_UNVERIFIABLE: '1', CERNUM_IDENTITY_ADMISSION: admissionText(),
    } }));
    expect(plan.runnableRunCount).toBe(0);
    expect(plan.identityAdmission).toBeUndefined();
  });
});

describe('an explicit matrix admission makes exactly the intended route runnable', () => {
  it('admits the named route, and its identity is requestAcceptedIdentityUnverifiable — not verified', () => {
    const admission = sealed();
    const plan = buildWorkspaceMatrixPlan(request({ identityAdmission: admission }));
    expect(plan.runnableRunCount).toBe(2);
    expect(plan.admittedUnverifiableRunCount).toBe(2);
    const [model] = plan.models;
    expect(model.admission).toMatchObject({ required: true, present: true, admitted: true });
    expect(model.admission.entry?.entryDigest).toBe(admission.entries[0].entryDigest);
    expect(model.identity.state).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(model.identity.state).not.toBe('verified');
    expect(model.identity.verifiedModelID).toBe('');
    expect(model.identity.resolvedFrom).toBe('identityAdmission');
    expect(model.binding?.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(model.binding?.verifiedModelID).toBe('');
  });

  it('derives one per-record admission per cell, sealed to that record\'s own label and passing the Pass 6 gate', () => {
    const plan = buildWorkspaceMatrixPlan(request({ identityAdmission: sealed() }));
    const seals = new Set<string>();
    for (const cell of plan.cells) {
      const record = cell.identityAdmission!;
      expect(record.campaignLabel).toBe(cell.recordLabel);
      expect(admissionSealIsIntact(record)).toBe(true);
      expect(record.admitted).toHaveLength(1);
      expect(record.admitted[0].returnedModelID).toBe('');
      expect(record.matrixAdmission?.matrixAdmissionDigest).toBe(plan.identityAdmission?.matrixAdmissionDigest);
      expect(admissionFor({ provider: 'codexCLI', modelID: SOL, effort: 'medium', campaignLabel: cell.recordLabel,
        admission: record }).admitted).toBe(true);
      // …and for no other record's label.
      const other = plan.cells.find((entry) => entry.recordLabel !== cell.recordLabel)!;
      expect(admissionFor({ provider: 'codexCLI', modelID: SOL, effort: 'medium', campaignLabel: other.recordLabel,
        admission: record }).admitted).toBe(false);
      seals.add(record.admissionDigest);
    }
    expect(seals.size).toBe(plan.cells.length);
  });

  it('reads the smoke row, which is never selectable, only as accepted-request evidence for the smoked efforts', () => {
    const maxOnly = { writtenAt: new Date().toISOString(), models: [acceptedCodexRoute(SOL, ['max'])] };
    const medium = buildWorkspaceMatrixPlan(request({ identityAdmission: sealed(), discovery: maxOnly }));
    expect(medium.runnableRunCount).toBe(0);
    expect(medium.models[0].admission.acceptedRequestEvidence).toContain('covered effort(s) max, not medium');
    const refusedRow = { writtenAt: new Date().toISOString(), models: [acceptedCodexRoute(SOL, ['max', 'medium'], 'refused')] };
    expect(buildWorkspaceMatrixPlan(request({ identityAdmission: sealed(), discovery: refusedRow })).runnableRunCount).toBe(0);
    // and the row stays unselectable for everything else: without an admission it is still refused as unproven
    const plain = buildWorkspaceMatrixPlan(request());
    expect(plain.models[0].identity.resolvedFrom).toBe('nothing');
    expect(plain.models[0].refusals.join(' ')).toContain('unprovenRoute');
  });

  it('refuses an admitted route this machine has no accepted-request evidence for', () => {
    const plan = buildWorkspaceMatrixPlan(request({
      identityAdmission: sealed(), discovery: { writtenAt: new Date().toISOString(), models: [] },
    }));
    expect(plan.runnableRunCount).toBe(0);
    expect(plan.models[0].admission.admitted).toBe(false);
    expect(plan.models[0].refusals.join(' ')).toContain('no unexpired evidence');
    expect(plan.models[0].refusals.join(' ')).toContain('holds no identity smoke');
  });
});

// MARK: - 4-9 · each bound fact, at the gate

describe('the gate binds every fact the admission names', () => {
  const admission = sealed();
  const refusedFor = (overrides: Partial<WorkspaceMatrixRouteFacts>) => matrixAdmissionFor(admission, facts(overrides));

  it('admits the exact route', () => {
    expect(refusedFor({}).admitted).toBe(true);
  });
  it('binds the provider', () => {
    expect(refusedFor({ provider: 'openaiAPI' }).admitted).toBe(false);
    expect(refusedFor({ provider: 'claudeCLI' }).admitted).toBe(false);
  });
  it('binds the model', () => {
    const decision = refusedFor({ modelID: ASTRA, candidate: `codexCLI:${ASTRA}@medium` });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain('not named');
  });
  it('binds the effort', () => {
    expect(refusedFor({ effort: 'max', candidate: `codexCLI:${SOL}@max` }).admitted).toBe(false);
    expect(refusedFor({ effort: 'high', candidate: `codexCLI:${SOL}@high` }).admitted).toBe(false);
  });
  it('binds the pack id, version and digest', () => {
    expect(refusedFor({ packDigest: 'cwp1:someotherpack' }).mismatches).toEqual(['pack digest']);
    expect(refusedFor({ packID: foundationFourPack.id }).admitted).toBe(false);
    expect(refusedFor({ packVersion: '2' }).admitted).toBe(false);
  });
  it('binds the driver and the CLI version', () => {
    expect(refusedFor({ driverID: 'driver.claude-cli.workspace' }).mismatches).toEqual(['driver']);
    expect(refusedFor({ cliVersion: '0.156.0' }).mismatches).toEqual(['CLI version']);
  });
  it('binds the billing basis and execution class', () => {
    expect(refusedFor({ billingBasis: 'meteredAPI' }).mismatches).toEqual(['billing basis']);
    expect(refusedFor({ executionClass: 'meteredAPI', billingBasis: 'meteredAPI' }).mismatches)
      .toEqual(['execution class', 'billing basis']);
  });
  it('binds the matrix it was sealed to', () => {
    expect(refusedFor({ matrixLabel: 'some-later-matrix' }).admitted).toBe(false);
  });
  it('refuses an edited admission', () => {
    const edited = { ...admission, entries: [{ ...admission.entries[0], requestedEffort: 'max' as const }] };
    expect(matrixAdmissionSealIsIntact(edited)).toBe(false);
    expect(matrixAdmissionFor(edited, facts({ effort: 'max', candidate: `codexCLI:${SOL}@max` })).admitted).toBe(false);
  });
});

// MARK: - 10-13 · no leakage, through the whole planner

describe('an admission for gpt-5.6-sol @ medium authorises nothing else', () => {
  it('does not authorise another model in the same matrix', () => {
    const plan = buildWorkspaceMatrixPlan(request({ modelIDs: [SOL, ASTRA], identityAdmission: sealed() }));
    const [sol, astra] = plan.models;
    expect(sol.runnable).toBe(true);
    expect(astra.runnable).toBe(false);
    expect(astra.admission).toMatchObject({ required: true, present: true, admitted: false });
    expect(astra.refusals.join(' ')).toContain(`codexCLI:${ASTRA}@medium is not named`);
    expect(plan.cells.filter((cell) => cell.modelID === ASTRA).every((cell) => cell.identityAdmission === undefined)).toBe(true);
  });

  it('does not authorise another effort: a medium admission is refused by a max matrix', () => {
    expect(() => buildWorkspaceMatrixPlan(request({ effort: 'max', identityAdmission: sealed() })))
      .toThrow(/matrixAdmissionEntryUnused|does not run/);
    // and an entry for max, in a max matrix, admits max only
    const plan = buildWorkspaceMatrixPlan(request({ effort: 'max', identityAdmission: sealed([{ requestedEffort: 'max' }]) }));
    expect(plan.models[0].candidate).toBe(`codexCLI:${SOL}@max`);
    expect(plan.models[0].admission.admitted).toBe(true);
  });

  it('does not authorise another pack, or the same pack under another digest', () => {
    const f4 = sealed([{}], { pack: { id: foundationFourPack.id, version: foundationFourPack.version,
      digest: workspacePackDigest(foundationFourPack, allWorkspaceCases()) } });
    expect(() => buildWorkspaceMatrixPlan(request({ identityAdmission: f4 }))).toThrow(/matrixAdmissionScopeMismatch|names pack/);
    const stale = sealed([{}], { pack: { id: PACK.id, version: PACK.version, digest: 'cwp1:stale' } });
    expect(() => buildWorkspaceMatrixPlan(request({ identityAdmission: stale }))).toThrow(/authorises no other/);
  });

  it('does not authorise another matrix, even with the same file', () => {
    expect(() => buildWorkspaceMatrixPlan(request({ identityAdmission: sealed([{}], {}, 'an-earlier-matrix') })))
      .toThrow(/never carried forward/);
  });

  it('cannot be written for the metered API route, and a Codex entry billed as metered is refused', () => {
    expect(() => sealed([{ provider: 'openaiAPI', executionClass: 'meteredAPI', billingBasis: 'meteredAPI' }]))
      .toThrow(WorkspaceMatrixAdmissionError);
    expect(() => sealed([{ provider: 'claudeCLI' }])).toThrow(/providerNotAdmissible|cannot be admitted/);
    const metered = buildWorkspaceMatrixPlan(request({ identityAdmission: sealed([{ billingBasis: 'meteredAPI' }]) }));
    expect(metered.runnableRunCount).toBe(0);
    expect(metered.models[0].refusals.join(' ')).toContain('billing basis (admitted meteredAPI, bound subscriptionIncluded)');
    // and an API-provider matrix gets nothing from a Codex admission
    expect(() => buildWorkspaceMatrixPlan(request({ provider: 'openaiAPI', identityAdmission: sealed() })))
      .toThrow(/does not run/);
  });

  it('does not authorise a route through another driver', () => {
    const plan = buildWorkspaceMatrixPlan(request({ identityAdmission: sealed([{ driverID: 'driver.some-other.workspace' }]) }));
    expect(plan.runnableRunCount).toBe(0);
    expect(plan.models[0].refusals.join(' ')).toContain('driver (admitted driver.some-other.workspace');
  });

  it('refuses a single-record admission file as a matrix admission, and the reverse', () => {
    const single = JSON.stringify({ authorizedBy: 'x', admitted: [{ provider: 'codexCLI', requestedModelID: SOL }] });
    expect(() => parseWorkspaceMatrixAdmissionFile(single)).toThrow(/admissionScope/);
    expect(() => parseWorkspaceMatrixAdmissionFile(admissionText([{}], { reason: '' }))).toThrow(/reason/);
    expect(() => parseWorkspaceMatrixAdmissionFile(admissionText([{ returnedModelID: SOL }]))).toThrow(/returned identity/);
    expect(() => sealed([{}, {}])).toThrow(/admitted twice/);
  });

  it('refuses at record creation an admission that does not admit that record', () => {
    const plan = buildWorkspaceMatrixPlan(request({ modelIDs: [SOL], identityAdmission: sealed() }));
    const [first, second] = plan.cells;
    const model = plan.models[0];
    const create = (identityAdmission: IdentityAdmission, pack = { id: plan.packID, version: plan.packVersion, digest: plan.packDigest }) =>
      WorkspaceCampaign.create({
        root: path.join(temporary('cernum-ma-rec-'), 'record'), label: first.recordLabel,
        case: allWorkspaceCases().find((entry) => entry.id === first.caseID)!, binding: model.binding!,
        identity: model.identity, identityAdmission, driver: codexFactory()(model.binding!)!,
        hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'test', fixtureRoot: FIXTURE_ROOT,
        sandboxRoot: temporary('cernum-ma-sb-'), pack,
      });
    // another record's admission
    expect(() => create(second.identityAdmission!)).toThrow(/does not admit this run/);
    // the right record's admission, frozen under another pack
    expect(() => create(first.identityAdmission!, { id: plan.packID, version: plan.packVersion, digest: 'cwp1:other' }))
      .toThrow(/pack digest/);
    // an admission derived for another model, relabelled for this record
    const astra = sealed([{ requestedModelID: ASTRA }]);
    expect(() => create(recordAdmissionFromMatrix(astra, astra.entries[0], first.recordLabel))).toThrow(/does not admit this run/);
  });
});

// MARK: - 14-16 · durable rows, the aggregate, and a reroute

describe('a run under a matrix admission', () => {
  it('seals each record with its own admission, referencing the matrix admission and the right entry', async () => {
    const admission = sealed([{}, { requestedModelID: ASTRA }]);
    const req = request({ modelIDs: [SOL, ASTRA], identityAdmission: admission });
    const plan = buildWorkspaceMatrixPlan(req);
    expect(plan.runnableRunCount).toBe(4);
    const result = await runWorkspaceMatrix(plan, req, RUN_OPTIONS);
    expect(result.executedRunCount).toBe(4);

    const rows = collectWorkspaceRunRows(req.campaignRoot);
    expect(rows).toHaveLength(4);
    for (const { row, recordRoot } of rows) {
      const cell = plan.cells.find((entry) => entry.recordRoot === recordRoot)!;
      const entry = admission.entries.find((candidate) => candidate.requestedModelID === row.requestedModelID)!;
      expect(row.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(row.bindingIdentityResolvedFrom).toBe('identityAdmission');
      expect(row.executionIdentityVerdict).toBe('unverifiable');
      expect(row.reportedModelID).toBe('');
      expect(row.identityAdmissionScope).toBe('workspaceMatrix');
      expect(row.matrixAdmissionDigest).toBe(admission.matrixAdmissionDigest);
      expect(row.matrixAdmissionEntryDigest).toBe(entry.entryDigest);
      expect(row.identityAdmissionDigest).toBe(cell.identityAdmission!.admissionDigest);
      expect(row.identityLimitation).toBe(MATRIX_IDENTITY_LIMITATION);
      expect(String(row.identityAdmissionStamp)).toContain(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      // NOTHING SAYS VERIFIED.
      for (const key of ['bindingIdentityState', 'executionIdentityVerdict']) expect(row[key]).not.toBe('verified');
      expect(JSON.stringify(row)).not.toContain('"verifiedModelID":"gpt');

      const manifest = JSON.parse(fs.readFileSync(workspaceRecordPaths(recordRoot).manifest, 'utf8'));
      expect(manifest.identityAdmissionDigest).toBe(cell.identityAdmission!.admissionDigest);
      expect(manifest.identityAdmission.campaignLabel).toBe(cell.recordLabel);
      expect(manifest.identityAdmission.matrixAdmission.entryDigest).toBe(entry.entryDigest);
      expect(manifest.candidates[0].runtimeDigest).toBe('');
      const record = JSON.parse(fs.readFileSync(workspaceRecordPaths(recordRoot).record, 'utf8'));
      expect(record.matrixAdmissionDigest).toBe(admission.matrixAdmissionDigest);
    }
    const printed = describeWorkspaceMatrixRunResult(result).join('\n');
    expect(printed).toContain('4 executed run(s) ran under the matrix admission');
  });

  it('carries admission provenance into the aggregate, with no quality penalty', async () => {
    const admission = sealed();
    const req = request({ identityAdmission: admission });
    const plan = buildWorkspaceMatrixPlan(req);
    await runWorkspaceMatrix(plan, req, RUN_OPTIONS);
    const rows = collectWorkspaceRunRows(req.campaignRoot);

    const cells = aggregateWorkspaceRuns(rows);
    for (const cell of cells) {
      expect(cell.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(cell.identityProvenance).toMatchObject({
        admittedUnverifiableRunCount: 1, admissionScopes: ['workspaceMatrix'],
        matrixAdmissionDigests: [admission.matrixAdmissionDigest],
        matrixAdmissionEntryDigests: [admission.entries[0].entryDigest],
        executionIdentityVerdicts: { unverifiable: 1 }, substitutedRunCount: 0,
      });
    }
    // THE SAME ROWS WITHOUT ANY ADMISSION FIELD SCORE IDENTICALLY: identity is not quality.
    const stripped: WorkspaceRunRow[] = rows.map(({ recordRoot, row }) => {
      const copy = { ...row };
      for (const key of ['identityAdmissionDigest', 'identityAdmissionStamp', 'identityAdmissionScope',
        'matrixAdmissionDigest', 'matrixAdmissionEntryDigest', 'identityLimitation']) delete copy[key];
      copy.bindingIdentityState = 'verified';
      return { recordRoot, row: copy };
    });
    const plain = aggregateWorkspaceRuns(stripped);
    expect(plain.map((cell) => cell.identityProvenance)).toEqual([undefined, undefined]);
    expect(plain.map((cell) => cell.quality)).toEqual(cells.map((cell) => cell.quality));
    expect(plain.map((cell) => cell.measurementQuality)).toEqual(cells.map((cell) => cell.measurementQuality));

    const provenance = workspaceMatrixIdentityProvenance(plan, rows);
    expect(provenance.matrixAdmission?.matrixAdmissionDigest).toBe(admission.matrixAdmissionDigest);
    expect(provenance.candidates).toEqual([expect.objectContaining({
      candidate: `codexCLI:${SOL}@medium`, identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
      admissionRequired: true, admissionPresent: true, admitted: true, admissionEntryDigest: admission.entries[0].entryDigest,
    })]);
    expect(provenance.admittedUnverifiableRunCount).toBe(2);
    expect(provenance.substitutionFailures).toEqual([]);
    expect(provenance.identityVerificationFailures).toEqual([]);
    expect(provenance.disclosure).toContain('no penalty');
  });

  it('still fails a rerouted run, records the served model, and does not let it change any other run', async () => {
    const runs: string[] = [];
    const admission = sealed();
    const req = request({
      identityAdmission: admission,
      driverFactory: codexFactory({ runs, reroute: { modelID: SOL, caseID: RECEIPT_REFUNDS_SIGN.id, served: 'gpt-5.5' } }),
    });
    const plan = buildWorkspaceMatrixPlan(req);
    const result = await runWorkspaceMatrix(plan, req, RUN_OPTIONS);

    // Both cells ran: a reroute is a failed run, not a throttle, and the matrix carries on.
    expect(runs).toEqual([`${SOL}|${RECEIPT_REFUNDS_SIGN.id}`, `${SOL}|${TASK_PRIORITY_PROPAGATE.id}`]);
    expect(result.identitySubstitutions).toEqual([expect.objectContaining({
      candidate: `codexCLI:${SOL}@medium`, caseID: RECEIPT_REFUNDS_SIGN.id, requestedModelID: SOL, reportedModelID: 'gpt-5.5',
    })]);
    expect(describeWorkspaceMatrixRunResult(result).join('\n')).toContain('requested gpt-5.6-sol, reported gpt-5.5');

    const rows = collectWorkspaceRunRows(req.campaignRoot);
    const rerouted = rows.find(({ row }) => row.caseID === RECEIPT_REFUNDS_SIGN.id)!.row;
    const next = rows.find(({ row }) => row.caseID === TASK_PRIORITY_PROPAGATE.id)!.row;
    expect(rerouted.executionIdentityVerdict).toBe('substituted');
    expect(rerouted.reportedModelID).toBe('gpt-5.5');
    expect(rerouted.status).not.toBe('pass');
    // The admission did not stretch to the served model, and the next run is exactly as unverifiable as before.
    expect(rerouted.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(rerouted.requestedModelID).toBe(SOL);
    expect(next.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(next.executionIdentityVerdict).toBe('unverifiable');
    expect(next.reportedModelID).toBe('');
    expect(matrixAdmissionFor(admission, facts({ modelID: 'gpt-5.5', candidate: 'codexCLI:gpt-5.5@medium' })).admitted).toBe(false);

    const provenance = workspaceMatrixIdentityProvenance(plan, rows);
    expect(provenance.substitutionFailures).toEqual([expect.objectContaining({ reportedModelID: 'gpt-5.5' })]);
    const cell = aggregateWorkspaceRuns(rows).find((entry) => entry.caseID === RECEIPT_REFUNDS_SIGN.id)!;
    expect(cell.identityProvenance).toMatchObject({ substitutedRunCount: 1, reportedSubstitutes: ['gpt-5.5'] });
  });

  it('keeps Codex token accounting: visible = output − reasoning, total = input + output', async () => {
    const req = request({ identityAdmission: sealed() });
    await runWorkspaceMatrix(buildWorkspaceMatrixPlan(req), req, RUN_OPTIONS);
    for (const { row } of collectWorkspaceRunRows(req.campaignRoot)) {
      expect(row.inputTokens).toBe(67791);
      expect(row.visibleOutputTokens).toBe(1413 - 117);
      expect(row.reasoningTokens).toBe(117);
      expect(row.totalTokens).toBe(67791 + 1413);
    }
  });
});

// MARK: - 17-18 · the dry run, and Claude untouched

describe('the dry run states the admission position of every route', () => {
  it('shows ABSENT and the refusal when there is no admission', () => {
    const printed = describeWorkspaceMatrixPlan(buildWorkspaceMatrixPlan(request())).join('\n');
    expect(printed).toContain(`identity adm.   ABSENT — 1 route(s) need one and are REFUSED: codexCLI:${SOL}@medium`);
    expect(printed).toContain('admission     REQUIRED — ABSENT; live execution refused.');
  });

  it('shows the admission, the entry, the route facts and that identity remains unverifiable', () => {
    const admission = sealed();
    const plan = buildWorkspaceMatrixPlan(request({ identityAdmission: admission }));
    const printed = describeWorkspaceMatrixPlan(plan).join('\n');
    expect(printed).toContain(`identity adm.   PRESENT ${admission.matrixAdmissionDigest}`);
    expect(printed).toContain(`REQUIRED — PRESENT, admitted by entry ${admission.entries[0].entryDigest}`);
    expect(printed).toContain(`identity state ${REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE} (NOT verified; returned model: none)`);
    expect(printed).toContain(`requested     ${SOL} · effort medium`);
    expect(printed).toContain('APPLIED effort is NOT MEASURED by this matrix');
    expect(printed).toContain('billing       subscriptionIncluded (subscriptionCLI)');
    expect(printed).toContain(`driver        ${CODEX_WORKSPACE_DRIVER_ID}`);
    expect(printed).toContain(`pack digest     ${PACK_DIGEST}`);
    expect(printed).toContain('attempts 1');
    expect(printed).toContain(`identity limit    ${MATRIX_IDENTITY_LIMITATION}`);
    expect(printed).toContain('still recorded on every admitted run:');
    expect(printed).toContain('throttle scope  provider — UNDECLARED');
    expect(printed).toContain('smoke         identity smoke at');
  });

  it('does not declare a Codex throttle scope it has never observed', () => {
    expect(providerThrottleScopeFor('codexCLI').declared).toBe(false);
    expect(providerThrottleScopeFor('codexCLI').scope).toBe('provider');
    expect(providerThrottleScopeFor('claudeCLI')).toMatchObject({ declared: true, scope: 'subscriptionSession' });
  });
});

describe('a verified Claude route needs no admission and is planned exactly as before', () => {
  const claudeFactory: NonNullable<WorkspaceMatrixRequest['driverFactory']> = () => ({
    driverID: 'driver.scripted', provider: 'claudeCLI', capabilities: new ScriptedWorkspaceAgent([]).capabilities,
    async run(runRequest: WorkspaceAgentRequest) {
      return { ...(await new ScriptedWorkspaceAgent([CHANGES_NOTHING]).run(runRequest)), reportedModelID: 'claude-haiku-4-5' };
    },
  });
  const claude = (overrides: Partial<WorkspaceMatrixRequest> = {}) => request({
    provider: 'claudeCLI', modelIDs: ['claude-haiku-4-5'], effort: 'none', driverFactory: claudeFactory, ...overrides,
  });

  it('marks admission not required, runs, and writes no admission field', async () => {
    const req = claude();
    const plan = buildWorkspaceMatrixPlan(req);
    expect(plan.models[0].admission).toMatchObject({ required: false, admitted: false });
    expect(plan.models[0].identity.state).toBe('verified');
    expect(plan.runnableRunCount).toBe(2);
    expect(plan.admittedUnverifiableRunCount).toBe(0);
    expect(describeWorkspaceMatrixPlan(plan).join('\n')).not.toContain('identity adm.');
    await runWorkspaceMatrix(plan, req, RUN_OPTIONS);
    const rows = collectWorkspaceRunRows(req.campaignRoot);
    for (const { row } of rows) {
      for (const key of ['identityAdmissionDigest', 'identityAdmissionScope', 'matrixAdmissionDigest', 'identityLimitation']) {
        expect(row).not.toHaveProperty(key);
      }
    }
    expect(aggregateWorkspaceRuns(rows).every((cell) => cell.identityProvenance === undefined)).toBe(true);
  });

  it('refuses a Codex admission handed to a Claude matrix rather than ignoring it', () => {
    expect(() => buildWorkspaceMatrixPlan(claude({ identityAdmission: sealed() }))).toThrow(/does not run/);
  });
});

// MARK: - 19-21 · historical identities

describe('historical identities are unchanged', () => {
  it('a single-record admission carries no matrix field and seals exactly as before', () => {
    // The admission frozen into the sealed Codex proof (campaigns-codex-workspace-proof-01), verbatim.
    const proof: IdentityAdmission = {
      admissionFormatVersion: 1,
      campaignLabel: 'ws.broken-sum.mean@3 · codexCLI:gpt-5.6-sol',
      authorizedAt: '2026-09-21T21:46:39Z',
      authorizedBy: 'The repository owner, in the written brief for the Cernum V1 Codex/OpenAI workspace pass (2026-09-21): '
        + '"perform at most ONE minimal live workspace proof after all non-live tests pass ... Choose ONE Codex route whose '
        + 'billing/auth/identity semantics are understood well enough to run safely ... If exact execution model identity '
        + 'remains unverifiable: record that honestly in the live evidence. Do NOT turn \'requested model\' into \'verified '
        + 'model\'." Recorded by the implementing agent on that authority, for exactly one workspace record of ws.broken-sum.mean@3.',
      admitted: [{
        provider: 'codexCLI', requestedModelID: 'gpt-5.6-sol', requestedEffort: 'medium', cliVersion: '0.155.0',
        authenticationBasis: 'ChatGPT subscription session (codex doctor --json: stored auth mode chatgpt, stored ChatGPT '
          + 'tokens true, stored API key false); the driver also sends forced_login_method="chatgpt"',
        evidenceDigest: 'sha256:fa2723c39e19668fa270f3da9ab2fdb110b243adef563c6ed5ecb17032fce6c9 '
          + '(~/cernum-evidence/2026-09-20-codex-identity.json, candidate codexCLI:gpt-5.6-sol:medium, identityState '
          + 'requestAcceptedIdentityUnverifiable)',
        evidenceCapturedAt: '2026-09-20T18:27:03Z', returnedModelID: '', state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
      }],
      admissionDigest: 'eee8a935d9dbe4c67d98891ef4e84115f7958c541f5b0742204535f0aa64c55e',
    };
    expect(admissionSealIsIntact(proof)).toBe(true);
    const { admissionDigest, ...body } = proof;
    const reauthorized = authorizeIdentityAdmission({
      campaignLabel: body.campaignLabel, authorizedAt: body.authorizedAt, authorizedBy: body.authorizedBy, admitted: body.admitted,
    });
    expect(reauthorized.admissionDigest).toBe(admissionDigest);
    expect(reauthorized).not.toHaveProperty('matrixAdmission');
  });

  it('a record admission derived from a matrix admits exactly one route', () => {
    const admission = sealed();
    expect(() => authorizeIdentityAdmission({
      campaignLabel: 'x', authorizedAt: 'y', authorizedBy: 'z',
      admitted: [recordAdmissionFromMatrix(admission, admission.entries[0], 'x').admitted[0],
        { ...recordAdmissionFromMatrix(admission, admission.entries[0], 'x').admitted[0], requestedEffort: 'max' }],
      matrixAdmission: recordAdmissionFromMatrix(admission, admission.entries[0], 'x').matrixAdmission,
    })).toThrow(/exactly one route/);
  });
});

// MARK: - 22 · the real command, with nothing reachable

describe('cernum workspace-benchmark with a Codex route', () => {
  let campaigns: string;
  let fakeBin: string;

  beforeEach(() => {
    campaigns = temporary('cernum-ma-cli-');
    fakeBin = temporary('cernum-ma-bin-');
    for (const name of ['codex', 'claude']) {
      fs.writeFileSync(path.join(fakeBin, name), [
        '#!/bin/sh', `echo "$@" >> ${JSON.stringify(path.join(fakeBin, `${name}.invocations`))}`, 'exit 97', '',
      ].join('\n'), { mode: 0o755 });
    }
    const file = discoveryStorePath(campaigns);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ writtenAt: new Date().toISOString(), models: [acceptedCodexRoute(SOL)] }), 'utf8');
  });

  const cernum = (...args: string[]) => {
    const result = spawnSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaigns], {
      cwd: repositoryRoot, encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${NODE_DIRECTORY}:/usr/bin:/bin` },
    });
    return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  const nothingRan = () => {
    for (const name of ['codex', 'claude']) expect(fs.existsSync(path.join(fakeBin, `${name}.invocations`))).toBe(false);
  };
  const f4Digest = workspacePackDigest(foundationFourPack, allWorkspaceCases());
  const writeAdmission = (text: string): string => {
    const file = path.join(campaigns, 'matrix-admission.json');
    fs.writeFileSync(file, text, 'utf8');
    return file;
  };
  const f4Admission = () => admissionText([{}], {
    pack: { id: foundationFourPack.id, version: foundationFourPack.version, digest: f4Digest },
  });

  it('dry-runs without an admission: states it is required and absent, and a live run refuses', () => {
    const dry = cernum('workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--label', 'f4-codex', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.output).toContain('identity adm.   ABSENT');
    expect(dry.output).toContain('REQUIRED — ABSENT; live execution refused.');
    expect(dry.output).toContain('A route above needs an identity admission');
    const live = cernum('workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--label', 'f4-codex', '--yes');
    expect(live.status).toBe(6);
    expect(live.output).toContain('every cell of this matrix was refused');
    nothingRan();
  });

  it('dry-runs with an admission: runnable, sealed, and still identity-unverifiable', () => {
    const file = writeAdmission(f4Admission());
    const dry = cernum('workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--label', 'f4-codex', '--admit-identity-unverifiable', file, '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.output).toMatch(/identity adm\. {3}PRESENT cma1:[0-9a-f]{64}/);
    expect(dry.output).toContain('runnable      12');
    expect(dry.output).toContain('12 runnable run(s) will be identity-UNVERIFIABLE');
    expect(dry.output).toContain('REQUIRED — PRESENT, admitted by entry cme1:');
    expect(dry.output).toContain('(NOT verified; returned model: none)');
    expect(dry.output).toContain(`--admit-identity-unverifiable ${file}`);
    expect(dry.output).not.toMatch(/identity\s+verified/);
    nothingRan();
  });

  it('refuses a single-record admission file, and refuses a matrix file on the single-record command', () => {
    const single = writeAdmission(JSON.stringify({ authorizedBy: 'x', admitted: [{ provider: 'codexCLI' }] }));
    const matrix = cernum('workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--admit-identity-unverifiable', single, '--dry-run');
    expect(matrix.status).toBe(2);
    expect(matrix.output).toContain('wrongScope');

    const matrixFile = writeAdmission(f4Admission());
    const one = cernum('workspace', 'ws.broken-sum.mean', '--provider', 'codexCLI', '--model', SOL, '--effort', 'medium',
      '--admit-identity-unverifiable', matrixFile, '--dry-run');
    expect(one.status).toBe(2);
    expect(one.output).toContain("declares admissionScope 'workspaceMatrix'");
    nothingRan();
  });

  it('refuses an admission for another pack before planning anything', () => {
    const file = writeAdmission(admissionText());
    const dry = cernum('workspace-benchmark', foundationFourPack.id, '--provider', 'codexCLI', '--models', SOL,
      '--effort', 'medium', '--admit-identity-unverifiable', file, '--dry-run');
    expect(dry.status).toBe(2);
    expect(dry.output).toContain('matrixAdmissionScopeMismatch');
    nothingRan();
  });
});
