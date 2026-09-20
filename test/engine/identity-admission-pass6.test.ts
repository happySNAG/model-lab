// Pass 6 — the identity exception, switched on, and every place it is not allowed to reach.
//
// WHAT THIS FILE IS FOR. Pass 5C tested the admission RECORD: that it seals itself, that it refuses
// claudeCLI, that it will not carry a returned identifier. Those tests still pass unchanged and are
// still in `frontier-candidate-reconciliation.test.ts`. This file tests what activating it did — the
// part that could not be tested while the thing was inert:
//
//   · a named Codex candidate is actually admitted, by the real builder, and comes out carrying the
//     state rather than being refused;
//   · a campaign without a record still refuses, on every provider, exactly as before;
//   · the state reaches the manifest, the ledger, the metrics, the ranking, the retention report,
//     the campaign status and the final report — every surface, one by one, by name;
//   · the returned-model field is empty at every one of those points;
//   · and the candidate earns no role and no recommendation, because a measurement of something
//     nobody can name is a measurement and not advice.
//
// NOTHING HERE CONTACTS ANY PROVIDER. The adapters are scripted, exactly as in the rest of the
// frontier suite, and the one thing being measured is what the engine does with what it is told.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign } from '../../src/engine/campaign';
import { buildCampaignPlan } from '../../src/engine/campaign-builder';
import { freezeManifest, verifyManifest } from '../../src/engine/manifest';
import {
  ADMISSION_APPROVAL, ADMISSIBLE_PROVIDERS, ADMISSION_PROVIDER_APPROVALS, IDENTITY_UNNAMEABLE_BECAUSE,
  ACTIVATION_SATISFIED_BY, AdmittedCandidateEvidence,
  IdentityAdmission, NEVER_AFFECTS, NOT_PROMOTABLE_BECAUSE, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  assertSurfaceCanStamp, authorizeIdentityAdmission, isPromotable, isRoutable,
} from '../../src/engine/identity-admission';
import {
  IDENTITY_ADMISSIBLE_PROVIDERS, ProviderBindingError, describeBinding, validateBinding,
} from '../../src/engine/provider';
import {
  IDENTITY_UNVERIFIABLE_CAVEAT, aggregateFromRows, attemptMetricsFromRow, describeCandidateMetrics,
} from '../../src/engine/frontier-metrics';
import { outcomesFromLedger, rankCandidates } from '../../src/engine/ranking';
import { recommendRetention } from '../../src/engine/retention';
import {
  configurationFor, envelopeOf, provenModel, routingHost, scriptedAdapter, subscriptionBinding,
  temporaryRoot,
} from './frontier-harness';

const LABEL = 'pass-6-frontier-pilot';

function evidence(over: Partial<AdmittedCandidateEvidence> = {}): AdmittedCandidateEvidence {
  return {
    provider: 'codexCLI',
    requestedModelID: 'gpt-6-astra',
    requestedEffort: 'max',
    cliVersion: 'codex-cli 0.154.0',
    authenticationBasis: 'ChatGPT subscription session',
    evidenceDigest: 'mlo1:abcdef0123456789',
    evidenceCapturedAt: '2026-09-13T20:22:00Z',
    returnedModelID: '',
    state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    ...over,
  };
}

function admissionFor(campaignLabel = LABEL, ...admitted: AdmittedCandidateEvidence[]): IdentityAdmission {
  return authorizeIdentityAdmission({
    campaignLabel,
    authorizedAt: '2026-09-13T21:00:00Z',
    authorizedBy: 'the repository owner, in the Pass 6 approval prompt',
    admitted: admitted.length > 0 ? admitted : [evidence()],
  });
}

function planRequest(over: Record<string, unknown> = {}) {
  return {
    label: LABEL,
    suiteIDs: ['suite.model-lab.foundation'],
    repeatsPerCase: 1,
    local: [],
    endpoint: 'http://127.0.0.1:11434',
    hardware: { platform: 'darwin', architecture: 'arm64', model: 't', cpuCoreCount: 1, physicalMemoryBytes: 1, osVersion: 't' },
    runtimeVersion: 'test',
    frontier: [{
      name: 'codexCLI:gpt-6-astra@max', provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max',
      thinkingMode: 'runtimeDefault',
    }],
    provenModels: [],
    ...over,
  } as never;
}

describe('the approval itself is recorded, not merely acted on', () => {
  it('names the pass and the decision it was approved under', () => {
    expect(ADMISSION_APPROVAL.pass).toBe('Cernum Pass 6');
    expect(ADMISSION_APPROVAL.decision).toMatch(/1\(b\)/);
  });

  it('lists where each activation requirement is now enforced, one per requirement', () => {
    expect(ACTIVATION_SATISFIED_BY.length).toBeGreaterThanOrEqual(5);
    const all = ACTIVATION_SATISFIED_BY.join(' ');
    for (const pattern of [/manifest/i, /routing/i, /promotion/i, /surface/i, /default/i]) {
      expect(all).toMatch(pattern);
    }
  });

  // The four things the approval prompt said this must never touch, kept as a list rather than as a
  // sentence in a report nobody re-reads.
  it('names what it must never affect, production routing and the two applications included', () => {
    const all = NEVER_AFFECTS.join(' ');
    expect(all).toMatch(/routing/i);
    expect(all).toMatch(/promotion/i);
    expect(all).toMatch(/Skippy/);
    expect(all).toMatch(/Ordra/);
  });

  it('keeps the provider restriction in the two places that enforce it, agreeing', () => {
    // Pass 7 made this a two-provider list. The invariant under test was never "exactly one provider"
    // — it is that the authority a PERSON reads (`ADMISSIBLE_PROVIDERS`) and the authority the BINDING
    // VALIDATOR applies (`IDENTITY_ADMISSIBLE_PROVIDERS`) are the same list and cannot drift.
    expect(ADMISSIBLE_PROVIDERS).toEqual(IDENTITY_ADMISSIBLE_PROVIDERS);
    expect(IDENTITY_ADMISSIBLE_PROVIDERS).toEqual(['codexCLI', 'opencodeCLI']);
  });

  it('admits ONLY providers that structurally cannot name the model, and says why for each', () => {
    // The bar for membership, asserted rather than described: every admissible provider carries its
    // own reason, and no provider that DOES name its model is on the list.
    for (const provider of IDENTITY_ADMISSIBLE_PROVIDERS) {
      expect(IDENTITY_UNNAMEABLE_BECAUSE[provider]).toBeTruthy();
    }
    for (const naming of ['claudeCLI', 'anthropicAPI', 'openaiAPI', 'ollama'] as const) {
      expect(IDENTITY_ADMISSIBLE_PROVIDERS).not.toContain(naming);
      expect(IDENTITY_UNNAMEABLE_BECAUSE[naming]).toBeUndefined();
    }
  });

  it('records WHO approved each admissible provider, and on what evidence', () => {
    // "The exception is approved" and "this provider is inside it" are different claims. Each provider
    // on the list has to carry the second, or it got there without anybody deciding.
    for (const provider of IDENTITY_ADMISSIBLE_PROVIDERS) {
      const approval = ADMISSION_PROVIDER_APPROVALS[provider];
      expect(approval).toBeDefined();
      expect(approval!.approvedBy.length).toBeGreaterThan(0);
      expect(approval!.evidence.length).toBeGreaterThan(0);
      expect(approval!.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // And the Pass 6 origin of the exception is not overwritten by the Pass 7 extension.
    expect(ADMISSION_APPROVAL.pass).toBe('Cernum Pass 6');
    expect(ADMISSION_PROVIDER_APPROVALS.opencodeCLI!.pass).toBe('Cernum Pass 7');
  });

  it('states, for OpenCode, that substitution is undetectable and not merely unproven', () => {
    // The one thing a reader must not take from this admission: that OpenCode's position equals
    // Codex's. It is weaker, the approval was given knowing that, and the reason string says so.
    expect(IDENTITY_UNNAMEABLE_BECAUSE.opencodeCLI).toMatch(/SUBSTITUTED model would return the same bytes/);
    expect(IDENTITY_UNNAMEABLE_BECAUSE.opencodeCLI).toMatch(/cannot detect substitution/);
    expect(ADMISSION_PROVIDER_APPROVALS.opencodeCLI!.evidence).toMatch(/UNDETECTABLE/);
  });
});

describe('the builder admits a named candidate, and nothing else', () => {
  it('ADMITS a Codex configuration the record names, and stamps the binding', () => {
    const built = buildCampaignPlan(planRequest({ identityAdmission: admissionFor() }));
    const binding = built.envelope.bindings[0];
    expect(binding.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(built.admittedWithoutProvenIdentity).toHaveLength(1);
    expect(built.admittedWithoutProvenIdentity[0].requestedModelID).toBe('gpt-6-astra');
  });

  // THE FIELD THIS WHOLE EXCEPTION EXISTS TO KEEP EMPTY.
  it('leaves the returned-model field empty, with the requested identifier sitting right there', () => {
    const built = buildCampaignPlan(planRequest({ identityAdmission: admissionFor() }));
    expect(built.envelope.bindings[0].requestedModelID).toBe('gpt-6-astra');
    expect(built.envelope.bindings[0].verifiedModelID).toBe('');
  });

  it('records the provenance the record carried, so a reader can judge the exception later', () => {
    const built = buildCampaignPlan(planRequest({ identityAdmission: admissionFor() }));
    const written = built.envelope.bindings[0].identityEvidence;
    expect(written).toMatch(/codex-cli 0\.154\.0/);
    expect(written).toMatch(/ChatGPT subscription session/);
    expect(written).toMatch(/returned model: none/);
  });

  // FAIL-CLOSED IS STILL THE DEFAULT, asserted through the real builder.
  it('refuses the same candidate when the campaign carries no record at all', () => {
    expect(() => buildCampaignPlan(planRequest())).toThrow(/has not been proven callable/);
  });

  it('refuses a candidate the record does not name, and says it was the record and not the proof', () => {
    const other = admissionFor(LABEL, evidence({ requestedModelID: 'gpt-5.6-sol' }));
    expect(() => buildCampaignPlan(planRequest({ identityAdmission: other })))
      .toThrow(/carries an identity admission record, and it does not admit this candidate/);
  });

  it('refuses a record written for a different campaign', () => {
    expect(() => buildCampaignPlan(planRequest({ identityAdmission: admissionFor('some-other-campaign') })))
      .toThrow(/never inherited/);
  });

  it('refuses a record whose seal was broken after it was authorised', () => {
    const admission = admissionFor();
    const tampered = { ...admission, admitted: [{ ...admission.admitted[0], requestedEffort: 'medium' as const }] };
    expect(() => buildCampaignPlan(planRequest({ identityAdmission: tampered })))
      .toThrow(/seal does not match/);
  });

  it('admits per configuration: the same model at the other effort is refused', () => {
    const request = planRequest({
      identityAdmission: admissionFor(),
      frontier: [{
        name: 'codexCLI:gpt-6-astra@medium', provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'medium',
        thinkingMode: 'runtimeDefault',
      }],
    });
    expect(() => buildCampaignPlan(request)).toThrow(/not named in this campaign's admission record/);
  });

  // A record must not be able to downgrade a candidate that discovery actually proved.
  it('prefers a real proof over an admission when both would apply', () => {
    const built = buildCampaignPlan(planRequest({
      identityAdmission: admissionFor(),
      provenModels: [provenModel('codexCLI', 'gpt-6-astra', ['max'])],
    }));
    expect(built.envelope.bindings[0].identityState).toBe('verified');
    expect(built.envelope.bindings[0].verifiedModelID).toBe('gpt-6-astra');
    expect(built.admittedWithoutProvenIdentity).toHaveLength(0);
  });
});

describe('the binding validator refuses the two ways this state could be abused', () => {
  const admitted = () => buildCampaignPlan(planRequest({ identityAdmission: admissionFor() })).envelope.bindings[0];

  it('refuses the state on any provider but Codex, even hand-assembled', () => {
    expect(() => validateBinding({ ...admitted(), provider: 'claudeCLI', executionClass: 'subscriptionCLI' }))
      .toThrow(ProviderBindingError);
    try {
      validateBinding({ ...admitted(), provider: 'claudeCLI', executionClass: 'subscriptionCLI' });
    } catch (error) {
      expect((error as ProviderBindingError).code).toBe('identityAdmissionProviderNotAdmissible');
    }
  });

  it('refuses the state beside a returned identifier — the backfill, blocked a second time', () => {
    expect(() => validateBinding({ ...admitted(), verifiedModelID: 'gpt-6-astra' }))
      .toThrow(/Never backfill/);
  });

  it('describes the binding in words that cannot be skimmed as verified', () => {
    const line = describeBinding(admitted());
    expect(line).toMatch(/UNVERIFIABLE/);
    expect(line).toMatch(/not a claim that this model answered/);
    expect(line).not.toMatch(/identity verified/);
  });
});

describe('the frozen manifest carries the authorization, and notices it moving', () => {
  const manifestInputs = (admission?: IdentityAdmission) => ({
    label: LABEL,
    catalogDigest: 'catalog',
    caseCount: 1,
    repeatsPerCase: 1,
    prompts: [{ caseID: 'c1', text: 'hello' }],
    scoredCore: [{ caseID: 'c1', caseDigest: 'd', comparabilityKey: 'k', scoringMode: 'exact', maxOutputTokens: 10 }],
    evaluators: [{ evaluatorID: 'e', source: 'source' }],
    candidates: [{ name: 'a', modelID: 'a', runtimeDigest: '', parameterSize: '', quantization: '' }],
    guards: { minimumFreeDiskBytes: 1 },
    hardware: { platform: 'darwin', architecture: 'arm64', model: 't', cpuCoreCount: 1, physicalMemoryBytes: 1, osVersion: 't' },
    runtimeVersion: 'test',
    execution: { residency: 'managed' as const, thinkingMode: 'disabled' as const },
    identityAdmission: admission,
    frozenAt: '2026-09-13T21:00:00Z',
  });

  it('binds the admission into the manifest identity: the same campaign with one is a different manifest', () => {
    const without = freezeManifest(manifestInputs());
    const with_ = freezeManifest(manifestInputs(admissionFor()));
    expect(with_.manifestDigest).not.toBe(without.manifestDigest);
    expect(with_.identityAdmissionDigest).toBe(admissionFor().admissionDigest);
  });

  // The property that keeps every campaign frozen before Pass 6 readable: an absent admission is
  // absent from the bound body, not present as a null.
  it('leaves a manifest with no admission byte-identical to what it always was', () => {
    expect(freezeManifest(manifestInputs()).identityAdmissionDigest).toBeUndefined();
    expect(freezeManifest(manifestInputs()).manifestDigest)
      .toBe(freezeManifest(manifestInputs()).manifestDigest);
  });

  it('refuses to freeze an admission whose seal was already broken', () => {
    const admission = admissionFor();
    const tampered = { ...admission, authorizedBy: 'somebody else' };
    expect(() => freezeManifest(manifestInputs(tampered))).toThrow(/seal does not match/);
  });

  it('reports a drift when the live admission is not the one that was frozen', () => {
    const manifest = freezeManifest(manifestInputs(admissionFor()));
    const swapped = admissionFor(LABEL, evidence({ requestedModelID: 'gpt-5.6-sol' }));
    const report = verifyManifest(manifest, { identityAdmission: swapped }, 'now');
    expect(report.intact).toBe(false);
    expect(report.drifts.map((drift) => drift.field)).toContain('identityAdmissionDigest');
  });

  it('reports a drift when the live admission was edited without its seal being recomputed', () => {
    const admission = admissionFor();
    const manifest = freezeManifest(manifestInputs(admission));
    // The digest still says what it said; the contents no longer match it.
    const edited = { ...admission, admitted: [{ ...admission.admitted[0], requestedEffort: 'low' as const }] };
    const report = verifyManifest(manifest, { identityAdmission: edited }, 'now');
    expect(report.intact).toBe(false);
  });
});

// MARK: - A whole campaign, with an admitted candidate, run end to end

describe('every surface stamps it', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => {
    campaignRoot = temporaryRoot('pass6-admission-');
    root = path.join(campaignRoot, 'run');
  });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  const admittedBinding = () => subscriptionBinding('codexCLI:gpt-6-astra@max', 'codexCLI', {
    requestedModelID: 'gpt-6-astra',
    effort: 'max',
    identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    verifiedModelID: '',
    identityEvidence: 'admitted under the Pass 6 identity exception',
  });

  async function runAdmittedCampaign() {
    const envelope = envelopeOf(admittedBinding());
    // The Codex CLI names no model, which is the whole reason this exception exists — so the
    // scripted adapter reports none either. A fixture that named one would be testing a provider
    // that does not behave like the one this is for.
    const adapter = scriptedAdapter('codexCLI', {}, { reportedModelID: '' });
    const { host } = routingHost({ envelope, adapters: { codexCLI: adapter } });
    const campaign = Campaign.create(root, configurationFor(envelope, {
      label: LABEL,
      identityAdmission: admissionFor(),
    }), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    return { campaign, status };
  }

  it('stamps EVERY ledger row, and none of them names a model', async () => {
    const { campaign, status } = await runAdmittedCampaign();
    expect(status.state).toBe('complete');
    expect(status.terminalCount).toBeGreaterThan(0);
    for (const row of campaign.ledger.results.values()) {
      expect(row.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(String(row.identityAdmissionStamp)).toMatch(/named no model/);
      expect(row.reportedModelID).toBe('');
      expect(row.requestedModelID).toBe('gpt-6-astra');
    }
  });

  it('records the admission in the campaign\'s own event stream, at the moment it took effect', async () => {
    const { campaign } = await runAdmittedCampaign();
    const event = campaign.ledger.events().find((entry) => entry.kind === 'identityAdmitted');
    expect(event).toBeDefined();
    expect(String(event!.authorizedBy)).toMatch(/repository owner/);
  });

  it('stamps the live campaign STATUS, before any report exists', async () => {
    const envelope = envelopeOf(admittedBinding());
    const { host } = routingHost({ envelope, adapters: { codexCLI: scriptedAdapter('codexCLI', {}, { reportedModelID: '' }) } });
    const campaign = Campaign.create(root, configurationFor(envelope, { label: LABEL, identityAdmission: admissionFor() }), host);
    const status = campaign.status();
    expect(status.admittedWithoutProvenIdentity).toHaveLength(1);
    expect(status.admittedWithoutProvenIdentity[0].stamp).toMatch(/named no model/);
  });

  it('stamps every metrics row and every candidate aggregate', async () => {
    const { campaign } = await runAdmittedCampaign();
    const rows = [...campaign.ledger.results.values()] as unknown as Record<string, unknown>[];
    const attempt = attemptMetricsFromRow(rows[0])!;
    expect(attempt.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(attempt.identityDisclosureRequired).toBe(true);
    expect(attempt.reportedModelID).toBe('');

    const aggregates = aggregateFromRows(rows, (row) => row.status === 'pass');
    expect(aggregates[0].identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(aggregates[0].reportedModelID).toBe('');
    expect(describeCandidateMetrics(aggregates[0])).toMatch(/unverifiable/);
  });

  it('carries the disclosure into the final report, and the authorization with it', async () => {
    const { campaign } = await runAdmittedCampaign();
    const report = campaign.finalize({ lockOptions: { } });
    expect(report.identityConfidence.admitted).toHaveLength(1);
    expect(report.identityConfidence.stamps[0]).toMatch(/returned model: none/);
    expect(report.identityConfidence.disclosure).toMatch(/NOT "this model/);
    expect(report.identityConfidence.admission?.authorizedBy).toMatch(/repository owner/);
    expect(report.guardTrace.map((entry) => entry.kind)).toContain('identityAdmitted');
  });

  // THE NON-PROMOTION RULE, end to end, on real measurements.
  it('publishes the rate in full and qualifies the candidate for NO role', async () => {
    const { campaign } = await runAdmittedCampaign();
    const report = campaign.finalize({ lockOptions: { } });
    const ranking = report.rankings.rankings[0];
    expect(ranking.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(ranking.promotable).toBe(false);
    expect(ranking.notPromotableBecause).toBe(NOT_PROMOTABLE_BECAUSE);
    // The measurement is NOT withheld. Withholding it would defeat the point of taking it.
    expect(ranking.scoredCount).toBeGreaterThan(0);
    expect(ranking.roles.every((role) => !role.qualified)).toBe(true);
    expect(ranking.roles.every((role) => /never established|identity/i.test(role.reason))).toBe(true);
  });

  // The scripted answers in this fixture trip a governance rule, so the recommendation this campaign
  // produces is `disqualified` — which is CORRECT and is the ordering `retention.ts` chose
  // deliberately: "do not use this" is a sound thing to say about an answerer nobody can name, and
  // it is a stronger statement than silence. What must never appear on an admitted candidate is a
  // recommendation to USE it, and that is what this asserts. The ordering itself, and the clean
  // `identityNeverEstablished` branch, are tested on fixtures below where the governance outcome can
  // be controlled rather than inherited from a scripted answer.
  it('offers no recommendation to USE it — not "keep", not "keep for one role"', async () => {
    const { campaign } = await runAdmittedCampaign();
    const report = campaign.finalize({ lockOptions: { } });
    const recommendation = report.retention.recommendations[0];
    expect(['identityNeverEstablished', 'disqualified']).toContain(recommendation.outcome);
    expect(recommendation.statement).not.toMatch(/^Keep/);
    expect(recommendation.rolesQualified).toEqual([]);
  });

  it('leaves an ordinary campaign\'s report with an EMPTY disclosure rather than no disclosure', async () => {
    const envelope = envelopeOf(subscriptionBinding('claudeCLI:sonnet'));
    const { host } = routingHost({ envelope });
    const campaign = Campaign.create(root, configurationFor(envelope), host);
    await campaign.run({ campaignRootDirectory: campaignRoot });
    const report = campaign.finalize({ lockOptions: { } });
    // Present and empty, so a reader can tell "nothing was admitted" from "this report predates the
    // question being asked".
    expect(report.identityConfidence.admitted).toEqual([]);
    expect(report.identityConfidence.disclosure).toBe('');
    expect(report.rankings.rankings.every((ranking) => ranking.promotable)).toBe(true);
  });
});

describe('a surface that cannot say it must not show it', () => {
  it('refuses an admitted candidate when the stamp would be blank', () => {
    expect(() => assertSurfaceCanStamp('a chart legend', REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, ''))
      .toThrow(/must not display this candidate/);
  });

  it('lets an ordinary candidate through without a stamp, because it needs none', () => {
    expect(() => assertSurfaceCanStamp('a chart legend', 'verified', '')).not.toThrow();
  });

  it('offers one caveat for a whole table, and it says what the rows are NOT', () => {
    expect(IDENTITY_UNVERIFIABLE_CAVEAT).toMatch(/not the same claim/);
    expect(IDENTITY_UNVERIFIABLE_CAVEAT).toMatch(/no capability role/);
  });
});

describe('routing and promotion never consult it', () => {
  it('routes only a verified identity', () => {
    expect(isRoutable('verified')).toBe(true);
    expect(isRoutable('unverifiable')).toBe(false);
    expect(isRoutable(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)).toBe(false);
  });

  // `unverifiable` IS promotable and that is deliberate: a model whose reply named nothing is an
  // ordinary, long-standing state, and this pass is not the place to change what it means. What is
  // new is the admitted state, and only it is refused.
  it('promotes a verified or ordinarily-unverifiable candidate, and never an admitted one', () => {
    expect(isPromotable('verified')).toBe(true);
    expect(isPromotable('unverifiable')).toBe(true);
    expect(isPromotable(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)).toBe(false);
  });

  it('refuses a role through the ranking itself, on outcomes that would otherwise clear every bar', () => {
    const perfect = ['conversation', 'emotionalUnderstanding', 'memoryHonesty', 'hallucinationResistance']
      .flatMap((dimension) => [1, 2, 3, 4, 5].map((n) => ({
        candidate: 'admitted', caseID: `${dimension}-${n}`, dimension: dimension as never,
        status: 'pass', governanceViolated: false,
        identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
      })));
    const rankings = rankCandidates({ outcomes: perfect, derivedAt: 'now' });
    const ranking = rankings.rankings[0];
    // A flawless 100%, and still no role.
    expect('measured' in ranking.overallPassRateMilli && ranking.overallPassRateMilli.measured).toBe(1000);
    expect(ranking.roles.every((role) => !role.qualified)).toBe(true);
    expect(recommendRetention(rankings).recommendations[0].outcome).toBe('identityNeverEstablished');
  });

  it('reports identityNeverEstablished for a clean admitted candidate, and says nothing about using it', () => {
    const outcomes = [1, 2, 3, 4, 5].map((n) => ({
      candidate: 'admitted', caseID: `c${n}`, dimension: 'conversation' as never, status: 'pass',
      governanceViolated: false, identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    }));
    const recommendation = recommendRetention(rankCandidates({ outcomes, derivedAt: 'now' })).recommendations[0];
    expect(recommendation.outcome).toBe('identityNeverEstablished');
    expect(recommendation.statement).toMatch(/No retention recommendation/);
    expect(recommendation.statement).toMatch(/establish the identity first/);
  });

  // ORDER MATTERS, and this is the one case where something still gets said. A governance failure is
  // a reason not to use a thing, and that stays sayable whether or not anybody can name the thing.
  it('still reports a governance disqualification on an admitted candidate, rather than swallowing it', () => {
    const outcomes = [1, 2, 3, 4, 5].map((n) => ({
      candidate: 'admitted', caseID: `c${n}`, dimension: 'conversation' as never, status: 'fail',
      governanceViolated: true, identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    }));
    const recommendation = recommendRetention(rankCandidates({ outcomes, derivedAt: 'now' })).recommendations[0];
    expect(recommendation.outcome).toBe('disqualified');
    expect(recommendation.statement).toMatch(/^Do not use/);
  });

  it('reads the state off the ledger rows rather than being told it separately', () => {
    const outcomes = outcomesFromLedger([{
      slotKey: 'admitted|s|1|c1', status: 'pass', seq: 1, recordedAt: 'now', caseID: 'c1',
      governanceViolated: false, bindingIdentityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    }], () => 'conversation');
    expect(outcomes[0].identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
  });

  // One admitted attempt is enough. An aggregate is only as attributable as its least attributable row.
  it('treats a candidate with ONE admitted attempt among many as unpromotable', () => {
    const outcomes = [
      { candidate: 'x', caseID: 'a', dimension: 'conversation' as never, status: 'pass', governanceViolated: false, identityState: 'verified' },
      { candidate: 'x', caseID: 'b', dimension: 'conversation' as never, status: 'pass', governanceViolated: false, identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE },
    ];
    expect(rankCandidates({ outcomes, derivedAt: 'now' }).rankings[0].promotable).toBe(false);
  });
});
