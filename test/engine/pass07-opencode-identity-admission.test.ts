// Pass 7 — opencodeCLI inside the identity exception, and every place it is still not allowed to reach.
//
// WHAT WAS DECIDED, AND WHAT WAS NOT. An OpenCode request whose identifier was ACCEPTED and whose
// reply was successfully MEASURED may enter the benchmark evidence set even though nothing in that
// reply names the model that answered. That is the whole of it. It is not a proof, it does not qualify
// anything for production, it is not a routing target, and it is not promotable.
//
// WHY OPENCODE QUALIFIED FOR A TREATMENT DESIGNED FOR CODEX. `opencode run --format json` emits no
// assistant message — the only event carrying `providerID`/`modelID` — because `run` reads that event
// solely in its `format !== "json"` branch, to print `> agent · modelID` for a person. One authorized
// live request on 2026-09-20 confirmed it: `opencode/big-pickle` answered, every measured figure came
// back readable, and the envelope named nobody. So the inability is STRUCTURAL, which is the bar for
// membership — not "this candidate turned out to be hard to prove".
//
// AND THE ONE WAY OPENCODE IS WORSE THAN CODEX, tested here so it cannot be forgotten. Codex names no
// model in ANY reply; its silence is total and declared. OpenCode HAS the field and routes it away from
// stdout, so a SUBSTITUTED model returns byte-identical output and `modelMismatch` cannot fire.
// Substitution on this path is UNDETECTABLE rather than merely unproven. The approval was given knowing
// that, and the difference is recorded on every surface that quotes a reason.
//
// NOTHING HERE CONTACTS ANY PROVIDER. The OpenCode replies are the captured bytes; the campaign lane is
// scripted, exactly as in the rest of the frontier suite.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Campaign } from '../../src/engine/campaign';
import { buildCampaignPlan, CampaignBuildError } from '../../src/engine/campaign-builder';
import { OpenCodeAdapter } from '../../src/engine/opencode-adapter';
import { buildSmokeBinding } from '../../src/engine/smoke-binding';
import { identitySmokeTest } from '../../src/engine/identity-smoke';
import { modelsFromSmokes } from '../../src/engine/discovery-store';
import {
  ADMISSIBLE_PROVIDERS, AdmittedCandidateEvidence, IdentityAdmission, IdentityAdmissionError,
  NOT_PROMOTABLE_BECAUSE, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, authorizeIdentityAdmission,
  isPromotable, isRoutable,
} from '../../src/engine/identity-admission';
import { ProviderBindingError, validateBinding } from '../../src/engine/provider';
import { aggregateFromRows, attemptMetricsFromRow } from '../../src/engine/frontier-metrics';
import {
  catalogue, configurationFor, envelopeOf, meteredBinding, provenModel, routingHost, scriptedAdapter,
  temporaryRoot,
} from './frontier-harness';
import { authorizeSpending, estimateSpending } from '../../src/engine/spending';
import { operationalEnvelopeDigest } from '../../src/engine/provider';
import { plannedWorkFor } from '../../src/engine/campaign-builder';
import {
  OPENCODE_BIG_PICKLE_CAPTURED_STDOUT, OPENCODE_BIG_PICKLE_OBSERVED, capturedLine, errorEvent,
} from './fixtures/opencode-run-json';

const MODEL = 'opencode/big-pickle';
const LABEL = 'pass-7-opencode-pilot';
const CANDIDATE = `opencodeCLI:${MODEL}`;

/** A fake `opencode` on disk that replays a given body for `run`. No request leaves this machine. */
function fakeOpenCode(directory: string, body: string): string {
  const executable = path.join(directory, 'opencode');
  const payload = path.join(directory, 'run-events.txt');
  fs.writeFileSync(payload, body);
  fs.writeFileSync(executable, ['#!/bin/sh', 'cat > /dev/null', `cat ${JSON.stringify(payload)}`, ''].join('\n'), { mode: 0o755 });
  return executable;
}

let scratch: string;
beforeEach(() => { scratch = temporaryRoot('pass7-opencode-'); });
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

const smokeOf = (body: string, modelID = MODEL) => identitySmokeTest(
  buildSmokeBinding({ provider: 'opencodeCLI', modelID, effort: 'none' }),
  new OpenCodeAdapter({ executablePath: fakeOpenCode(scratch, body) }),
);

function evidence(over: Partial<AdmittedCandidateEvidence> = {}): AdmittedCandidateEvidence {
  return {
    provider: 'opencodeCLI',
    requestedModelID: MODEL,
    requestedEffort: 'none',
    cliVersion: 'opencode-ai 1.18.31',
    authenticationBasis: 'toolManagedCredential — OpenCode Zen [api]',
    evidenceDigest: 'mlo1:0123456789abcdef',
    evidenceCapturedAt: '2026-09-20T18:53:30Z',
    returnedModelID: '',
    state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    ...over,
  };
}

const admissionFor = (campaignLabel = LABEL, ...admitted: AdmittedCandidateEvidence[]): IdentityAdmission =>
  authorizeIdentityAdmission({
    campaignLabel,
    authorizedAt: '2026-09-20T19:00:00Z',
    authorizedBy: 'the repository owner, approving the Pass 7 governance decision in writing',
    admitted: admitted.length > 0 ? admitted : [evidence()],
  });

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
      name: CANDIDATE, provider: 'opencodeCLI', modelID: MODEL, effort: 'none',
      thinkingMode: 'disabled',
      pricing: { source: 'a fixture', capturedAt: '2026-01-01T00:00:00Z', currency: 'USD',
        inputMicroUSDPerMillionTokens: 0, outputMicroUSDPerMillionTokens: 0, reasoningMicroUSDPerMillionTokens: null },
    }],
    provenModels: [],
    ...over,
  } as never;
}

describe('Pass 7 · an accepted, measured OpenCode request reaches the admission state', () => {
  it('records requestAcceptedIdentityUnverifiable when the reply parses and names nobody', async () => {
    const result = await smokeOf(OPENCODE_BIG_PICKLE_CAPTURED_STDOUT);

    // THE DECISION, in one assertion. Before Pass 7 this was plain `unverifiable`.
    expect(result.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(result.answerText).toBe(OPENCODE_BIG_PICKLE_OBSERVED.answerText);
  });

  it('is NOT labelled identityProven, and carries no returned model', async () => {
    const result = await smokeOf(OPENCODE_BIG_PICKLE_CAPTURED_STDOUT);

    expect(result.identityState).not.toBe('verified');
    expect(result.verdict).not.toBe('proven');
    expect(result.verdict).toBe('unverifiable');
    // The requested identifier is sitting right there. It is never copied in.
    expect(result.reportedModelID).toBe('');
    expect(result.requestedModelID).toBe(MODEL);
    expect(JSON.stringify(result)).not.toContain('identityProven');
  });

  it('says WHY the tool could not name a model, in OpenCode\'s own terms and not Codex\'s', async () => {
    const result = await smokeOf(OPENCODE_BIG_PICKLE_CAPTURED_STDOUT);

    expect(result.evidence).toMatch(/emits no assistant message/);
    expect(result.evidence).toMatch(/requestAcceptedIdentityUnverifiable/);
    // A message describing `codex exec` would be false about OpenCode. The reason is per provider.
    expect(result.evidence).not.toMatch(/codex exec/);
  });

  it('REMAINS FULLY MEASURED — this is an accepted request, not a degraded one', async () => {
    const result = await smokeOf(OPENCODE_BIG_PICKLE_CAPTURED_STDOUT);

    // The point of admitting it at all: every figure the envelope carried is readable and recorded,
    // each as a Quantity whose provenance says the PROVIDER reported it rather than this engine.
    expect(result.visibleOutputTokens.value).toBe(OPENCODE_BIG_PICKLE_OBSERVED.tokens.output);
    expect(result.visibleOutputTokens.provenance).toBe('providerReported');
    expect(result.inputTokens.value).toBe(
      OPENCODE_BIG_PICKLE_OBSERVED.tokens.input + OPENCODE_BIG_PICKLE_OBSERVED.tokens.cacheRead);
    expect(result.inputTokens.provenance).toBe('providerReported');
    expect(result.totalWallClockMilliseconds.value).toBeGreaterThan(0);
    // And still metered, recorded as metered, with the charge unavailable rather than zero.
    expect(result.billingBasis).toBe('meteredAPI');
    expect(result.marginalAPIChargeMicroUSD.provenance).toBe('unavailable');
  });
});

describe('Pass 7 · the state survives to disk, which is where a reader will meet it', () => {
  it('persists the unverifiable identity on the discovery row, not a proof', async () => {
    const result = await smokeOf(OPENCODE_BIG_PICKLE_CAPTURED_STDOUT);
    const [row] = modelsFromSmokes([result]);

    expect(row.provider).toBe('opencodeCLI');
    expect(row.availability).not.toBe('proven');
    expect(row.verifiedModelID).toBe('');
    expect(row.evidence).toMatch(/unverifiable/);
  });

  it('survives a JSON round trip, because the artefact outlives the process that wrote it', async () => {
    const result = await smokeOf(OPENCODE_BIG_PICKLE_CAPTURED_STDOUT);
    const file = path.join(scratch, 'smoke.json');
    fs.writeFileSync(file, JSON.stringify(result));
    const reread = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof result;

    expect(reread.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(reread.reportedModelID).toBe('');
  });
});

describe('Pass 7 · admission is still an authorization, and its absence still refuses', () => {
  it('REFUSES the candidate when the campaign carries no admission record', () => {
    // The default, unchanged by this decision. A measured-but-unnamed request buys nothing on its own.
    expect(() => buildCampaignPlan(planRequest())).toThrow(CampaignBuildError);
    expect(() => buildCampaignPlan(planRequest())).toThrow(/has not been proven callable/);
  });

  it('REFUSES a record written for another campaign', () => {
    expect(() => buildCampaignPlan(planRequest({ identityAdmission: admissionFor('some-other-campaign') })))
      .toThrow(/never inherited/);
  });

  it('REFUSES a record whose seal was broken after it was written', () => {
    const tampered = { ...admissionFor(), admitted: [evidence({ requestedModelID: 'opencode/something-else' })] };
    expect(() => buildCampaignPlan(planRequest({ identityAdmission: tampered })))
      .toThrow(/does not match its contents|not named in this campaign/);
  });

  it('ADMITS the candidate the record names, and stamps the binding with the state', () => {
    const built = buildCampaignPlan(planRequest({ identityAdmission: admissionFor() }));
    const binding = built.envelope.bindings[0];

    expect(binding.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(binding.verifiedModelID).toBe('');
    expect(built.admittedWithoutProvenIdentity).toHaveLength(1);
    expect(built.admittedWithoutProvenIdentity[0].provider).toBe('opencodeCLI');
  });

  it('prefers a real proof to the exception, where both would have applied', () => {
    // If discovery ever DID prove an OpenCode model, the stronger evidence wins and an unnecessary
    // admission must not downgrade it. Guards the reverse mistake to the one Pass 7 was about.
    const built = buildCampaignPlan(planRequest({
      identityAdmission: admissionFor(),
      provenModels: [provenModel('opencodeCLI', MODEL)],
    }));
    expect(built.envelope.bindings[0].identityState).toBe('verified');
    expect(built.admittedWithoutProvenIdentity).toHaveLength(0);
  });
});

describe('Pass 7 · what the admission must never reach', () => {
  it('is NOT routable — routing requires a verified identity', () => {
    expect(isRoutable(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)).toBe(false);
    expect(isRoutable('verified')).toBe(true);
  });

  it('is NOT promotable — no capability role, no retention recommendation', () => {
    expect(isPromotable(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)).toBe(false);
    expect(isPromotable('verified')).toBe(true);
    expect(NOT_PROMOTABLE_BECAUSE).toMatch(/recommendation about a model nobody can name/);
  });

  it('refuses the state on a binding for any provider that DOES name its model', () => {
    const laundered = meteredBinding('anthropicAPI:claude-opus-5', 'anthropicAPI', {
      identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: '',
    });
    expect(() => validateBinding(laundered)).toThrow(ProviderBindingError);
    expect(() => validateBinding(laundered)).toThrow(/applies only to codexCLI, opencodeCLI/);
  });

  it('refuses an OpenCode binding that carries the state AND a returned identity', () => {
    // The backfill this whole design exists to prevent, now reachable on a second provider.
    const both = meteredBinding(CANDIDATE, 'opencodeCLI', {
      identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, verifiedModelID: MODEL,
    });
    expect(() => validateBinding(both)).toThrow(/cannot both be true/);
  });

  it('keeps the admissible list closed', () => {
    expect(ADMISSIBLE_PROVIDERS).toEqual(['codexCLI', 'opencodeCLI']);
    expect(() => authorizeIdentityAdmission({
      campaignLabel: LABEL, authorizedAt: '2026-09-20T19:00:00Z', authorizedBy: 'someone',
      admitted: [evidence({ provider: 'claudeCLI' })],
    })).toThrow(IdentityAdmissionError);
  });
});

describe('Pass 7 · a failed or unreadable OpenCode reply is a failure, never admitted evidence', () => {
  it('a MALFORMED envelope stays plain unverifiable and is not admitted', async () => {
    const result = await smokeOf("echo 'not json at all'");

    expect(result.verdict).toBe('unverifiable');
    // NOT the admission state. A request that could not be read established nothing, not even
    // acceptance, so there is no accepted request to admit.
    expect(result.identityState).toBe('unverifiable');
    expect(result.identityState).not.toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
  });

  it('an envelope with telemetry but NO answer text is a failure, however complete the telemetry', async () => {
    // The trap this guards: tokens, cost and a finish reason all arrived. None of that is an answer,
    // and a request with no answer is not an accepted request.
    const noAnswer = [capturedLine('step_start'), capturedLine('step_finish'), ''].join('\n');
    const result = await smokeOf(noAnswer);

    expect(result.identityState).toBe('unverifiable');
    expect(result.answerText).toBe('');
  });

  it('a REFUSED request is refused, not admitted', async () => {
    const denied = errorEvent({ name: 'ProviderAuthError', data: { message: 'no credential configured' } });
    const result = await smokeOf(denied);

    expect(result.verdict).toBe('refused');
    expect(result.identityState).toBe('unverifiable');
    expect(result.identityState).not.toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
  });

  it('a SUBSTITUTION, if one were ever visible, is not admitted either', async () => {
    // Unreachable through `--format json`, which is the point recorded elsewhere. Asserted through the
    // server framing so the rule itself is covered: a reply naming a DIFFERENT model is a finding, and
    // `identityStateFrom` never upgrades a verdict that is not `unverifiable`.
    const named = JSON.stringify({
      type: 'message.updated',
      properties: { info: { id: 'm', role: 'assistant', providerID: 'opencode', modelID: 'someone-else' } },
    });
    const result = await smokeOf(`${capturedLine('text')}\n${named}`);

    expect(result.verdict).not.toBe('proven');
    expect(result.identityState).not.toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
  });

  it('discovery alone still qualifies nothing, record or no record', () => {
    // A catalogue listing is not a request. The admission changes what an ANSWERED request may become,
    // and nothing whatever about an unanswered one.
    expect(() => buildCampaignPlan(planRequest({
      frontier: [{ name: 'opencodeCLI:opencode/never-asked', provider: 'opencodeCLI',
        modelID: 'opencode/never-asked', effort: 'none', thinkingMode: 'disabled',
        pricing: { source: 'a fixture', capturedAt: '2026-01-01T00:00:00Z', currency: 'USD',
          inputMicroUSDPerMillionTokens: 0, outputMicroUSDPerMillionTokens: 0, reasoningMicroUSDPerMillionTokens: null } }],
      identityAdmission: admissionFor(),
    }))).toThrow(/does not admit this candidate/);
  });
});

describe('Pass 7 · providers that DO prove identity keep the behaviour they had', () => {
  it('a verified binding is still verified, routable and promotable', () => {
    const verified = meteredBinding('anthropicAPI:claude-opus-5', 'anthropicAPI');
    expect(() => validateBinding(verified)).not.toThrow();
    expect(verified.identityState).toBe('verified');
    expect(isRoutable(verified.identityState)).toBe(true);
    expect(isPromotable(verified.identityState)).toBe(true);
  });

  it('a Codex candidate is admitted exactly as it was before this pass', () => {
    const codex = buildCampaignPlan(planRequest({
      frontier: [{ name: 'codexCLI:gpt-6-astra@max', provider: 'codexCLI', modelID: 'gpt-6-astra',
        effort: 'max', thinkingMode: 'runtimeDefault' }],
      identityAdmission: admissionFor(LABEL, evidence({
        provider: 'codexCLI', requestedModelID: 'gpt-6-astra', requestedEffort: 'max',
        cliVersion: 'codex-cli 0.154.0', authenticationBasis: 'ChatGPT subscription session',
      })),
    }));
    expect(codex.envelope.bindings[0].identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(codex.envelope.bindings[0].verifiedModelID).toBe('');
  });

  it('an unproven candidate on a naming provider is still refused outright, not admitted', () => {
    // claudeCLI names its model, so it can never be admitted — the record cannot even be written.
    expect(() => authorizeIdentityAdmission({
      campaignLabel: LABEL, authorizedAt: '2026-09-20T19:00:00Z', authorizedBy: 'someone',
      admitted: [evidence({ provider: 'claudeCLI', requestedModelID: 'claude-opus-5' })],
    })).toThrow(/cannot be admitted under this exception/);
  });
});

describe('Pass 7 · an admitted OpenCode candidate is measured end to end, and recommended for nothing', () => {
  let campaignRoot: string;
  let root: string;
  beforeEach(() => { campaignRoot = temporaryRoot('pass7-campaign-'); root = path.join(campaignRoot, 'run'); });
  afterEach(() => fs.rmSync(campaignRoot, { recursive: true, force: true }));

  const admittedBinding = () => meteredBinding(CANDIDATE, 'opencodeCLI', {
    requestedModelID: MODEL,
    identityState: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
    verifiedModelID: '',
    identityEvidence: 'admitted under the Pass 7 OpenCode identity decision',
    authorizationMode: 'toolManagedCredential',
  });

  async function runAdmittedCampaign() {
    const envelope = envelopeOf(admittedBinding());
    // OPENCODE IS METERED, so this campaign needs a spending authorization as well as an identity
    // admission. The two are deliberately separate: money and identity are different questions, and
    // authorizing one has never authorized the other.
    const authorization = authorizeSpending(
      estimateSpending(envelope, plannedWorkFor(catalogue(1), [CANDIDATE], 1)), {
        campaignID: 'campaign:pass-7-opencode',
        authorizedAt: '2026-09-20T19:00:00Z',
        authorizedBy: 'the test, standing in for a person who authorized a metered run',
        hardCeilingMicroUSD: 5_000_000,
        operationalEnvelopeDigest: operationalEnvelopeDigest(envelope),
      });
    // The OpenCode path names no model, which is the whole reason this exception now covers it — so the
    // scripted adapter reports none either. A fixture that named one would be testing a different tool.
    const adapter = scriptedAdapter('opencodeCLI', {}, { reportedModelID: '' });
    const { host } = routingHost({ envelope, adapters: { opencodeCLI: adapter }, authorization });
    const campaign = Campaign.create(root, configurationFor(envelope, {
      label: LABEL, identityAdmission: admissionFor(),
    }), host);
    const status = await campaign.run({ campaignRootDirectory: campaignRoot });
    return { campaign, status };
  }

  it('MEASURES it: the campaign completes and every ledger row is stamped and unnamed', async () => {
    const { campaign, status } = await runAdmittedCampaign();

    expect(status.state).toBe('complete');
    expect(status.terminalCount).toBeGreaterThan(0);
    for (const row of campaign.ledger.results.values()) {
      expect(row.bindingIdentityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
      expect(row.reportedModelID).toBe('');
      expect(row.requestedModelID).toBe(MODEL);
    }
  });

  it('carries the state into every metrics row and aggregate, with the disclosure required', async () => {
    const { campaign } = await runAdmittedCampaign();
    const rows = [...campaign.ledger.results.values()] as unknown as Record<string, unknown>[];

    const attempt = attemptMetricsFromRow(rows[0])!;
    expect(attempt.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(attempt.identityDisclosureRequired).toBe(true);
    expect(attempt.reportedModelID).toBe('');

    const aggregates = aggregateFromRows(rows, (row) => row.status === 'pass');
    expect(aggregates[0].identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(aggregates[0].reportedModelID).toBe('');
  });

  it('publishes the rate IN FULL and qualifies it for NO role', async () => {
    const { campaign } = await runAdmittedCampaign();
    const report = campaign.finalize({ lockOptions: {} });
    const ranking = report.rankings.rankings[0];

    expect(ranking.identityState).toBe(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(ranking.promotable).toBe(false);
    expect(ranking.notPromotableBecause).toBe(NOT_PROMOTABLE_BECAUSE);
    // The measurement is NOT withheld. Withholding it would defeat the point of taking it, and the
    // point of the whole decision is that these runs may be measured.
    expect(ranking.scoredCount).toBeGreaterThan(0);
    expect(ranking.roles.every((role) => !role.qualified)).toBe(true);
  });

  it('offers no recommendation to USE it — not "keep", not "keep for one role"', async () => {
    const { campaign } = await runAdmittedCampaign();
    const report = campaign.finalize({ lockOptions: {} });
    const recommendation = report.retention.recommendations[0];

    expect(['identityNeverEstablished', 'disqualified']).toContain(recommendation.outcome);
    expect(recommendation.statement).not.toMatch(/^Keep/);
  });
});
