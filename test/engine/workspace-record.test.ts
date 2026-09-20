// The durable record one workspace execution leaves behind.
//
// THE QUESTION THIS FILE ASSERTS AN ANSWER TO, in the words the pass was given:
//
//     What exact task, fixture, tool policy, model route and evaluator produced this score?
//
// The first live workspace run could not answer it. It went through `WorkspaceRoutingHost`, which
// authorises, runs, maps usage and scores — and deliberately writes nothing. So the whole proof
// existed as terminal output and a patch on a disk that was then deleted. Nothing below the host
// needed changing to fix that; something above it needed to exist.
//
// NO PROVIDER IS CONTACTED ANYWHERE IN THIS FILE. The driver is `ScriptedWorkspaceAgent`, the
// verification commands are real `node` against the real sealed fixture, and every figure a provider
// would have reported is supplied by the test so the mapping can be asserted rather than hoped for.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BROKEN_SUM_MEAN } from '../../src/engine/workspace-catalog';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver,
} from '../../src/engine/workspace-agent';
import { WorkspaceAgentUsage } from '../../src/engine/workspace-host';
import {
  WorkspaceCampaign, WorkspaceCampaignError, discloseWorkspaceDriver, workspaceCatalogDigest,
  workspaceEvaluatorBindings, workspacePlannableCatalog, workspaceRecordPaths, workspaceRecordRoot,
} from '../../src/engine/workspace-campaign';
import { PreRunIdentity, buildWorkspaceBinding } from '../../src/engine/workspace-binding';
import { workspaceCaseDigest, workspaceComparabilityKey, workspaceInstructionText } from '../../src/engine/workspace-case';
import { Ledger } from '../../src/engine/ledger';
import { FrozenManifest } from '../../src/engine/manifest';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

const CORRECT_STATS = `'use strict';
function sum(values) { let total = 0; for (const value of values) total += value; return total; }
function mean(values) {
  if (values.length === 0) throw new RangeError('empty');
  return sum(values) / values.length;
}
module.exports = { sum, mean };
`;

const FIXING_ATTEMPT: ScriptedAttempt = {
  steps: [
    { do: 'read', path: 'src/stats.js' },
    { do: 'write', path: 'src/stats.js', contents: CORRECT_STATS },
    { do: 'runCommand', executable: 'node', args: ['test/stats.test.js'], exitCode: 0 },
  ],
  finalMessage: 'Fixed the divisor.',
};

const IDLE_ATTEMPT: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'I have fixed it.' }],
  finalMessage: 'All done.',
};

/** A scripted driver that also reports usage and names a model, so every recorded column has a source. */
function reportingDriver(attempts: ScriptedAttempt[], usage: WorkspaceAgentUsage[],
                         reportedModelID = 'claude-haiku-4-5'): WorkspaceAgentDriver {
  const scripted = new ScriptedWorkspaceAgent(attempts);
  let index = 0;
  return {
    driverID: scripted.driverID,
    provider: scripted.provider,
    capabilities: scripted.capabilities,
    async run(request: Parameters<typeof scripted.run>[0]) {
      const result = await scripted.run(request);
      const reported = usage[Math.min(index, usage.length - 1)];
      index += 1;
      return { ...result, usage: reported, reportedModelID };
    },
  };
}

/** A proof resolved from the discovery store, as `resolvePreRunIdentity` would return one. */
const PROVEN: PreRunIdentity = {
  state: 'verified',
  verifiedModelID: 'claude-haiku-4-5',
  evidence: 'a fixture standing in for an identity smoke test; no provider was contacted to produce it',
  resolvedFrom: 'discoveryStore',
  provenAt: '2026-09-20T18:26:35Z',
};

const USAGE: WorkspaceAgentUsage = {
  inputTokens: 6_686, freshInputTokens: 7, cacheCreationInputTokens: 6_551, cacheReadInputTokens: 128,
  visibleOutputTokens: 452, reasoningTokens: 81, subscriptionIncludedUsageMicroUSD: 25_663,
  identityState: 'verified',
};

function campaignFor(options: {
  driver: WorkspaceAgentDriver;
  identity?: PreRunIdentity;
  attemptCeiling?: number;
  root?: string;
}): WorkspaceCampaign {
  const identity = options.identity ?? PROVEN;
  return WorkspaceCampaign.create({
    root: options.root ?? path.join(temporary('cernum-ws-record-'), 'record'),
    label: 'a workspace record',
    case: BROKEN_SUM_MEAN,
    binding: buildWorkspaceBinding({
      candidate: 'claudeCLI:claude-haiku-4-5', provider: 'claudeCLI', modelID: 'claude-haiku-4-5',
      effort: 'none', timeoutMilliseconds: BROKEN_SUM_MEAN.execution.timeoutMilliseconds, identity,
    }),
    identity,
    driver: options.driver,
    hardware: SYNTHETIC_HARDWARE,
    runtimeVersion: 'a test',
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-sandbox-'),
    attemptCeiling: options.attemptCeiling,
  });
}

describe('the manifest seals the task, the fixture, the evaluator and the route', () => {
  it('binds the WorkspaceCase identity into a frozen manifest', async () => {
    const campaign = campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]) });
    const manifest = JSON.parse(fs.readFileSync(campaign.paths.manifest, 'utf8')) as FrozenManifest;

    expect(manifest.scoredCore[0].caseID).toBe(BROKEN_SUM_MEAN.id);
    expect(manifest.scoredCore[0].caseDigest).toBe(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(manifest.scoredCore[0].comparabilityKey).toBe(workspaceComparabilityKey(BROKEN_SUM_MEAN));
    // THE INSTRUCTION AS SENT is what the prompt digest seals — composed by the case, never by a driver.
    expect(manifest.promptDigests[0].caseID).toBe(BROKEN_SUM_MEAN.id);
    // The evaluators are the case's own declared checks, digested as DATA. Change a command and the
    // manifest moves, which is what makes "the same evaluator" a checkable claim.
    expect(manifest.evaluatorDigests.map((entry) => entry.evaluatorID))
      .toEqual(workspaceEvaluatorBindings(BROKEN_SUM_MEAN).map((entry) => entry.evaluatorID).sort());
    // The route, frozen: the workspace contract is in the envelope the manifest digest binds.
    expect(manifest.operationalEnvelope?.bindings[0].executionContract).toBe('workspaceTask');
    expect(manifest.operationalEnvelope?.bindings[0].tokenCeiling).toBe('notExpressibleByContract');
    expect(manifest.manifestFormatVersion).toBe(4);
  });

  it('writes the case verbatim beside its digest, because a digest is not a task description', () => {
    const campaign = campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]) });
    const sealed = JSON.parse(fs.readFileSync(campaign.paths.workspaceCase, 'utf8')) as Record<string, unknown>;
    expect(sealed.caseDigest).toBe(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(sealed.instructionAsSent).toBe(workspaceInstructionText(BROKEN_SUM_MEAN));
    expect((sealed.case as { source: { expectedTreeDigest: string } }).source.expectedTreeDigest)
      .toBe(BROKEN_SUM_MEAN.source.expectedTreeDigest);
  });

  it('refuses to freeze a second manifest over the same evidence', () => {
    const root = path.join(temporary('cernum-ws-record-'), 'record');
    campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]), root });
    expect(() => campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]), root }))
      .toThrow(WorkspaceCampaignError);
  });

  it('plans through the SHARED planner, with its own catalogue digest scheme', () => {
    const catalogue = workspacePlannableCatalog(BROKEN_SUM_MEAN);
    expect(catalogue.catalogDigest).toBe(workspaceCatalogDigest([BROKEN_SUM_MEAN]));
    expect(catalogue.catalogDigest.startsWith('cwx1:')).toBe(true);
    expect(catalogue.suites[0].cases[0].scoringMode).toMatch(/^workspace:/);
    // A workspace case's budgets are zero in the PLAN too, for the same reason they are on the
    // binding: the contract carries no ceiling, and a plan that invented one would describe a limit
    // nobody enforced.
    expect(catalogue.suites[0].cases[0].maxOutputTokens).toBe(0);
  });

  it('keeps the record out of the campaign namespace, so `status` never meets a directory it cannot read', () => {
    expect(workspaceRecordRoot('/campaigns')).toBe(path.join('/campaigns', 'workspace'));
    const paths = workspaceRecordPaths('/campaigns/workspace/one');
    expect(paths.manifest).toBe(path.join('/campaigns/workspace/one', 'manifest.json'));
    expect(fs.existsSync(path.join('/campaigns/workspace/one', 'configuration.json'))).toBe(false);
  });
});

describe('one terminal row carries the whole verdict', () => {
  it('records the scorecard status, the digests, the metrics and the waste', async () => {
    const campaign = campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]) });
    const { outcome, record } = await campaign.run();

    expect(outcome.scorecard.status).toBe('pass');

    const rows = fs.readFileSync(path.join(campaign.paths.ledger, 'results.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // The terminal status, in the SAME vocabulary a prose row uses. `appendResult` refuses any other.
    expect(row.status).toBe('pass');
    expect(row.slotKey).toBe(campaign.slotKey);

    // The task, the fixture and the evaluator.
    expect(row.caseDigest).toBe(workspaceCaseDigest(BROKEN_SUM_MEAN));
    expect(row.comparabilityKey).toBe(workspaceComparabilityKey(BROKEN_SUM_MEAN));
    expect(row.fixtureExpectedTreeDigest).toBe(BROKEN_SUM_MEAN.source.expectedTreeDigest);
    // WHAT WAS ACTUALLY COPIED IN, beside what the case was sealed against. Equal on a sealed case
    // that ran, and the equality is the proof rather than the assumption.
    expect(row.fixtureObservedTreeDigest).toBe(BROKEN_SUM_MEAN.source.expectedTreeDigest);
    expect(row.scoringPolicyID).toBe(BROKEN_SUM_MEAN.scoring.id);
    expect(row.toolPolicy).toEqual(BROKEN_SUM_MEAN.execution.tools);
    expect(row.environmentAllowlist).toEqual(['HOME', 'USER']);
    expect(row.networkPolicy).toBe('providerOnly');

    // What the ENGINE observed.
    expect(typeof row.patchDigest).toBe('string');
    expect((row.patchDigest as string).length).toBeGreaterThan(0);
    expect(row.patchDigest).toBe(outcome.scorecard.patchDigest);
    expect(row.workspaceBaselineTreeDigest).toBe(outcome.run.attempts[0].baselineTreeDigest);
    expect(row.workspaceFinalTreeDigest).toBe(outcome.run.attempts[0].finalTreeDigest);
    expect(row.workspaceBaselineTreeDigest).not.toBe(row.workspaceFinalTreeDigest);
    expect(row.changedPaths).toEqual(['src/stats.js']);
    expect(row.scopeClean).toBe(true);
    expect((row.verificationOutcomes as { commandID: string; passed: boolean }[])[0])
      .toMatchObject({ commandID: 'stats-tests', passed: true });
    expect((row.baselineOutcomes as { commandID: string; passed: boolean }[])[0])
      .toMatchObject({ commandID: 'stats-tests', passed: false });
    expect((row.transitions as { transition: string }[])[0].transition).toBe('fixed');
    expect(row.regressionCount).toBe(0);
    expect((row.invariantOutcomes as { satisfied: boolean }[])[0].satisfied).toBe(true);

    // The driver, its capabilities and the shortfalls it did not have.
    expect(row.driverID).toBe('driver.scripted');
    expect(row.capabilityShortfalls).toEqual([]);
    expect(row.driverCapabilities).toMatchObject({ rootsToDirectory: true });

    // The transcript, sealed and referenced.
    expect(row.transcriptDigest).toBe(outcome.scorecard.transcriptDigest);
    expect(typeof row.transcriptEvidencePath).toBe('string');
    const transcriptFile = path.join(campaign.root, row.transcriptEvidencePath as string);
    expect(fs.existsSync(transcriptFile)).toBe(true);
    const events = fs.readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(events.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(path.dirname(transcriptFile), 'patch.diff'))).toBe(true);

    // Tokens, cost, allowance, timing and waste — ONE record, the same one a prose attempt produces.
    expect(row.inputTokens).toBe(6_686);
    expect(row.freshInputTokens).toBe(7);
    expect(row.visibleOutputTokens).toBe(452);
    expect(row.usageProvenance).toBe('providerReported');
    // A subscription's marginal API charge is a TRUE zero, and the allowance beside it is not.
    expect(row.costMicroUSD).toBe(0);
    expect(row.costProvenance).toBe('measured');
    expect(row.subscriptionIncludedUsageMicroUSD).toBe(25_663);
    expect(row.subscriptionAllowanceState).toBe('reported');
    expect(row.retryCount).toBe(0);
    expect(row.retriesRequired).toBe(0);
    expect(row.wastedTokens).toBe(0);
    expect(row.wastedMilliseconds).toBe(0);
    expect(typeof row.wallClockMilliseconds).toBe('number');
    expect(row.compositeMilli).toBe(outcome.scorecard.compositeMilli.valueMilli);

    // And the derived one-file record agrees with the row it was derived from.
    expect(record.status).toBe(row.status);
    expect(record.patchDigest).toBe(row.patchDigest);
    expect(record.compositeMilli).toBe(row.compositeMilli);
    expect(JSON.parse(fs.readFileSync(campaign.paths.record, 'utf8')).manifestSeal).toBe(record.manifestSeal);
  }, 60_000);

  it('records the retry and waste of a run that needed a second go', async () => {
    const campaign = campaignFor({ driver: reportingDriver([IDLE_ATTEMPT, FIXING_ATTEMPT], [
      { ...USAGE, visibleOutputTokens: 40, reasoningTokens: 10, inputTokens: 100 },
      USAGE,
    ]) });
    const { record } = await campaign.run();
    expect(record.attemptsUsed).toBe(2);
    expect(record.retriesRequired).toBe(1);
    // The waste is the tokens spent on the attempt that did NOT decide the outcome.
    expect(record.wastedTokens).toBe(150);
    expect(record.status).toBe('pass');
  }, 60_000);

  it('records an operator attempt ceiling as the OPERATOR\'s, leaving the case digest where it was', async () => {
    const campaign = campaignFor({
      driver: reportingDriver([IDLE_ATTEMPT, FIXING_ATTEMPT], [USAGE]),
      attemptCeiling: 1,
    });
    const { record } = await campaign.run();
    expect(record.attemptCeilingApplied).toBe(1);
    expect(record.caseMaximumAttempts).toBe(2);
    expect(record.attemptsUsed).toBe(1);
    // The case did not move. A capped run is still comparable with an uncapped one on everything else.
    expect(record.caseDigest).toBe(workspaceCaseDigest(BROKEN_SUM_MEAN));
  }, 60_000);

  it('writes the record before the run, so a failure is recorded rather than lost', async () => {
    const campaign = campaignFor({ driver: reportingDriver([IDLE_ATTEMPT], [USAGE]) });
    expect(fs.existsSync(campaign.paths.manifest)).toBe(true);
    expect(Ledger.exists(campaign.paths.ledger)).toBe(true);
    const { record } = await campaign.run();
    // A model that announced success and changed nothing scores what changing nothing scores.
    expect(record.status).not.toBe('pass');
    expect(record.changedFileCount).toBe(0);
  }, 60_000);
});

describe('identity is two facts, recorded at two moments', () => {
  it('keeps the pre-run state distinct from the post-run verdict', async () => {
    const campaign = campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]) });
    const { record, outcome } = await campaign.run();

    // BEFORE: resolved from the discovery store, with the moment the proof was established.
    expect(record.bindingIdentityState).toBe('verified');
    expect(record.bindingIdentityResolvedFrom).toBe('discoveryStore');
    expect(record.bindingIdentityProvenAt).toBe('2026-09-20T18:26:35Z');
    // AFTER: what THIS request established, from the same ladder the prose path uses.
    expect(record.executionIdentityVerdict).toBe('verified');
    expect(record.reportedModelID).toBe('claude-haiku-4-5');
    expect(outcome.frontier.executionIdentityDetail).toMatch(/claude-haiku-4-5 answered/);
    // Two columns, not one. The pre-run field carries WHERE the proof came from and WHEN it was
    // established; the post-run field carries neither, because it is a statement about this request.
    expect(Object.keys(record)).toEqual(expect.arrayContaining([
      'bindingIdentityState', 'bindingIdentityResolvedFrom', 'bindingIdentityProvenAt',
      'executionIdentityVerdict', 'executionIdentityDetail',
    ]));
    expect(record.bindingIdentityEvidence).toBe(PROVEN.evidence);
    expect(record.executionIdentityDetail).not.toBe(record.bindingIdentityEvidence);
  }, 60_000);

  it('resolves an existing proven route rather than starting from unverifiable', async () => {
    // The pre-run state came from the store and was `verified` BEFORE anything was sent — which is
    // the defect this fixes: the first live run recorded `unverifiable` while a live proof sat on disk.
    const campaign = campaignFor({ driver: reportingDriver([FIXING_ATTEMPT], [USAGE]) });
    const events = campaign.ledger.events();
    const created = events.find((event) => event.kind === 'workspaceRecordCreated');
    expect(created?.bindingIdentityState).toBe('verified');
    expect(created?.bindingIdentityResolvedFrom).toBe('discoveryStore');
    // Written at creation, before the request: the event stream's order is the proof of when.
    expect(events.indexOf(created!)).toBe(0);
  });

  it('does NOT let a post-run answer rewrite the historical pre-run state', async () => {
    // A route nothing proved, admitted here only to drive the mapping: the binding's pre-run state
    // is `unverifiable`, and the tool then names a model. The two must not collapse into one.
    const unproven: PreRunIdentity = {
      state: 'unverifiable', verifiedModelID: '', resolvedFrom: 'nothing',
      evidence: 'nothing on this machine established this route',
    };
    const campaign = WorkspaceCampaign.create({
      root: path.join(temporary('cernum-ws-record-'), 'record'),
      label: 'an unproven route, admitted only to test the mapping',
      case: BROKEN_SUM_MEAN,
      // Built by hand rather than through `buildWorkspaceBinding`, which refuses an unproven route
      // outright. The point under test is the RECORDING, not the refusal — that has its own test.
      binding: {
        ...buildWorkspaceBinding({
          candidate: 'c', provider: 'claudeCLI', modelID: 'claude-haiku-4-5', effort: 'none',
          timeoutMilliseconds: 600_000, identity: PROVEN,
        }),
        identityState: 'unverifiable',
        verifiedModelID: '',
        identityEvidence: unproven.evidence,
      },
      identity: unproven,
      driver: reportingDriver([FIXING_ATTEMPT], [USAGE], 'claude-haiku-4-5'),
      hardware: SYNTHETIC_HARDWARE,
      runtimeVersion: 'a test',
      fixtureRoot: FIXTURE_ROOT,
      sandboxRoot: temporary('cernum-ws-sandbox-'),
    });
    const { record } = await campaign.run();

    // THE PRE-RUN FACT SURVIVES THE ANSWER. Nothing confirmed the route before the request, and the
    // record still says so after one.
    expect(record.bindingIdentityState).toBe('unverifiable');
    expect(record.bindingIdentityResolvedFrom).toBe('nothing');
    // And the post-run verdict is recorded beside it, in full, rather than being suppressed.
    expect(record.executionIdentityVerdict).toBe('verified');
    expect(record.reportedModelID).toBe('claude-haiku-4-5');
  }, 60_000);

  it('records no post-run verdict at all when the tool named nobody, as an absence rather than a finding', async () => {
    const silent = reportingDriver([FIXING_ATTEMPT], [USAGE], '');
    const campaign = campaignFor({ driver: silent });
    const { record } = await campaign.run();
    expect(record.reportedModelID).toBe('');
    expect(record.executionIdentityVerdict).toBe('unverifiable');
    expect(record.executionIdentityDetail).toMatch(/named no model/);
    // The pre-run state is untouched by the silence.
    expect(record.bindingIdentityState).toBe('verified');
  }, 60_000);
});

describe('the driver is disclosed before it runs, and sealed after', () => {
  it('reports a driver that cannot describe its own invocation as having disclosed nothing', () => {
    const disclosure = discloseWorkspaceDriver(new ScriptedWorkspaceAgent([FIXING_ATTEMPT]), BROKEN_SUM_MEAN);
    expect(disclosure.invocationUndisclosed).toBe(true);
    expect(disclosure.invocation).toBeUndefined();
    expect(disclosure.capabilityShortfalls).toEqual([]);
  });

  it('names the capability shortfalls that would refuse the case before anything is spent', () => {
    const blind = new ScriptedWorkspaceAgent([FIXING_ATTEMPT], { capabilities: { rootsToDirectory: false } });
    const disclosure = discloseWorkspaceDriver(blind, BROKEN_SUM_MEAN);
    expect(disclosure.capabilityShortfalls.join(' ')).toMatch(/cannot be told which directory to work in/);
  });
});
