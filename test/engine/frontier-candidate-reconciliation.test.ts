// Pass 5C — the cohort cannot quietly shrink, and the Codex exception stays shut.
//
// TWO JOBS, AND THE FIRST ONE IS THE UNUSUAL ONE.
//
// Most tests here assert that something works. These assert that a QUESTION IS STILL BEING ASKED.
// Pass 5B lost `claude-opus-5` and `claude-fable-5-1` from its candidate list without a single
// failure anywhere: nothing refused them, nothing recorded them absent, no test went red, because a
// list of what was tested looks exactly like a list of what was requested once the request itself is
// forgotten. So the requested cohort is declared independently in `reconciliation.ts` and compared
// against the ladder here — and dropping a model now takes two deliberate deletions and still fails.
//
// The second job is the Codex admission state, which Pass 5C wrote and did not switch on. PASS 6
// SWITCHED IT ON, under decision 1(b), and the two tests that asserted its inertness now assert what
// replaced it: that being active means a record MAY exist, and nothing more. Every other test in
// that section is unchanged and still passes, which is the useful part — the refusals approved in
// 5C are the refusals that shipped in 6, not a redesign wearing the same name. The heavier Pass 6
// tests, covering the surfaces and the non-promotion rule, live in `identity-admission-pass6.test.ts`.
//
// NOTHING IN THIS FILE CONTACTS ANY PROVIDER.

import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SUBSTITUTIONS, HISTORICAL_IDENTITY_EVIDENCE, RECONCILED_IN_PASS_5C, REQUESTED_COHORT,
  assertCohortComplete, configurationKey, historicalEvidenceFor, ladderConfigurations, reconcileCohort,
} from '../../src/engine/reconciliation';
import {
  ACTIVATION_REQUIREMENTS, ADMISSIBLE_PROVIDERS, ADMISSION_IS_ACTIVE, ADMISSION_STAMP_LONG,
  ADMISSION_STAMP_SHORT, AdmittedCandidateEvidence, IdentityAdmissionError,
  REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionFor, admissionProvenance, admissionSealIsIntact,
  admissionStamp, authorizeIdentityAdmission, isRoutable,
} from '../../src/engine/identity-admission';
import { DESIRED_CANDIDATE_LADDER } from '../../src/engine/discovery';
import { buildCampaignPlan } from '../../src/engine/campaign-builder';

describe('the requested cohort survives being forgotten', () => {
  it('asks for exactly 12 configurations', () => {
    expect(REQUESTED_COHORT).toHaveLength(12);
    expect(REQUESTED_COHORT.filter((entry) => entry.provider === 'claudeCLI')).toHaveLength(6);
    expect(REQUESTED_COHORT.filter((entry) => entry.provider === 'codexCLI')).toHaveLength(6);
  });

  // THE REGRESSION, NAMED. This is the test that would have gone red in Pass 5B.
  it('still asks for Opus 5 and Fable 5.1, the two models Pass 5B lost', () => {
    for (const modelID of RECONCILED_IN_PASS_5C) {
      expect(REQUESTED_COHORT.some((entry) => entry.modelID === modelID)).toBe(true);
      expect(DESIRED_CANDIDATE_LADDER.some((entry) => entry.modelID === modelID)).toBe(true);
    }
  });

  it('asks for Opus 5 and Fable 5.1 under their exact identifiers, not a near spelling', () => {
    const ids = REQUESTED_COHORT.map((entry) => entry.modelID);
    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-fable-5-1');
    // The wrong spellings, each of which is a real model or a plausible typo of one.
    expect(ids).not.toContain('claude-opus-5-1');
    expect(ids).not.toContain('claude-fable-5');
    expect(ids).not.toContain('claude-fable-5.1');
  });

  it('requests Fable 5.1 at high effort, which the installed CLI documents', () => {
    const fable = REQUESTED_COHORT.find((entry) => entry.modelID === 'claude-fable-5-1')!;
    expect(fable.effort).toBe('high');
  });

  it('keeps the smaller and older comparison candidates — the correction was additive', () => {
    const ids = REQUESTED_COHORT.map((entry) => entry.modelID);
    for (const kept of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8', 'gpt-5.6-terra']) {
      expect(ids).toContain(kept);
    }
  });

  it('counts Sonnet at two efforts as two configurations, so losing one is visible', () => {
    const sonnet = REQUESTED_COHORT.filter((entry) => entry.modelID === 'claude-sonnet-5');
    expect(sonnet.map((entry) => entry.effort).sort()).toEqual(['high', 'max']);
  });

  it('reconciles the ladder against the request with nothing missing and nothing extra', () => {
    const result = reconcileCohort();
    expect(result.missingFromLadder).toEqual([]);
    expect(result.extraInLadder).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.requestedCount).toBe(12);
  });

  it('expands the ladder to the same 12 configurations the request names', () => {
    expect(ladderConfigurations()).toHaveLength(12);
    expect(new Set(ladderConfigurations().map(configurationKey)))
      .toEqual(new Set(REQUESTED_COHORT.map(configurationKey)));
  });

  it('does not throw while the cohort is whole', () => {
    expect(() => assertCohortComplete()).not.toThrow();
  });

  it('names the forbidden substitutions rather than trusting anyone to remember them', () => {
    const pairs = FORBIDDEN_SUBSTITUTIONS.map((entry) => `${entry.requested}<-${entry.notThis}`);
    expect(pairs).toContain('claude-opus-5<-claude-opus-4-8');
    expect(pairs).toContain('claude-fable-5-1<-claude-sonnet-5');
    // Both stand-ins are themselves legitimate cohort members, which is exactly what makes the
    // substitution tempting: swapping one in leaves a list that still looks full.
    const ids = REQUESTED_COHORT.map((entry) => entry.modelID);
    for (const entry of FORBIDDEN_SUBSTITUTIONS) expect(ids).toContain(entry.notThis);
  });
});

describe('historical identity evidence, preserved and not mistaken for proof', () => {
  it('keeps the record for both reconciled models', () => {
    expect(HISTORICAL_IDENTITY_EVIDENCE).toHaveLength(2);
    for (const modelID of RECONCILED_IN_PASS_5C) {
      expect(historicalEvidenceFor(modelID)).toBeDefined();
    }
  });

  it('records a verified match for each, with the source that established it', () => {
    for (const entry of HISTORICAL_IDENTITY_EVIDENCE) {
      expect(entry.verdict).toBe('verifiedMatch');
      expect(entry.identitySource.length).toBeGreaterThan(0);
      expect(entry.evidencePath.length).toBeGreaterThan(0);
    }
  });

  // THE NUANCE WORTH NOT LOSING. Fable's prose said "Claude Fable 5" while the structured stream
  // said `claude-fable-5-1`. A reader keying on prose would have recorded a mismatch on a correct
  // answer, which is why the distinction is carried in the evidence rather than in somebody's memory.
  it('records that Fable was identified from the structured stream, never from its prose', () => {
    const fable = historicalEvidenceFor('claude-fable-5-1')!;
    expect(fable.identitySource).toMatch(/structured/i);
    expect(fable.detail).toMatch(/prose/i);
  });

  it('says why each record cannot stand in for a current proof', () => {
    for (const entry of HISTORICAL_IDENTITY_EVIDENCE) {
      expect(entry.notCurrentProofBecause.length).toBeGreaterThan(0);
    }
  });
});

// MARK: - The Codex admission state

const evidence = (over: Partial<AdmittedCandidateEvidence> = {}): AdmittedCandidateEvidence => ({
  provider: 'codexCLI',
  requestedModelID: 'gpt-6-astra',
  requestedEffort: 'max',
  cliVersion: 'codex-cli 0.154.0',
  authenticationBasis: 'ChatGPT subscription session',
  evidenceDigest: 'mlo1:abcdef0123456789',
  evidenceCapturedAt: '2026-09-14T00:52:20Z',
  returnedModelID: '',
  state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  ...over,
});

const admissionOf = (...admitted: AdmittedCandidateEvidence[]) => authorizeIdentityAdmission({
  campaignLabel: 'pass-6-pilot', authorizedAt: '2026-09-14T01:00:00Z',
  authorizedBy: 'a person, at the terminal', admitted,
});

describe('requestAcceptedIdentityUnverifiable — approved in Pass 6, and still fail-closed', () => {
  it('IS ACTIVE AS OF PASS 6 — which means a record MAY exist, not that anything is admitted', () => {
    expect(ADMISSION_IS_ACTIVE).toBe(true);
  });

  // THE DISTINCTION THE FLAG'S NAME INVITES A READER TO MISS, asserted so it cannot be lost: with
  // the exception fully active, a campaign carrying no record still refuses every unproven candidate.
  it('still refuses a candidate when the campaign carries no record, active or not', () => {
    const result = admissionFor({
      provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max', campaignLabel: 'pass-6-pilot',
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toMatch(/no identity admission record/i);
  });

  it('refuses every candidate if it is ever switched back off, even one a record names', () => {
    const admission = admissionOf(evidence());
    const result = admissionFor({
      provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max',
      campaignLabel: 'pass-6-pilot', admission, active: false,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toMatch(/not active/i);
  });

  it('lists what a person must decide before it may be switched on', () => {
    expect(ACTIVATION_REQUIREMENTS.length).toBeGreaterThanOrEqual(5);
    expect(ACTIVATION_REQUIREMENTS.join(' ')).toMatch(/manifest/i);
    expect(ACTIVATION_REQUIREMENTS.join(' ')).toMatch(/routing/i);
  });

  // FAIL-CLOSED REMAINS THE DEFAULT, asserted through the real builder rather than a comment.
  it('leaves the campaign builder refusing an unproven Codex candidate exactly as before', () => {
    expect(() => buildCampaignPlan({
      label: 'attempted', suiteIDs: ['suite.model-lab.foundation'], repeatsPerCase: 1,
      local: [], endpoint: 'http://127.0.0.1:11434',
      hardware: { machine: 't', cpu: 't', cores: 1, memoryBytes: 1, os: 't', arch: 't' },
      runtimeVersion: 'test',
      frontier: [{
        name: 'astra', provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max',
        thinkingMode: 'runtimeDefault',
      }],
      provenModels: [],
    } as never)).toThrow(/has not been proven callable/);
  });
});

describe('the admission record, if a person ever writes one', () => {
  it('applies to codexCLI and to nothing else', () => {
    expect(ADMISSIBLE_PROVIDERS).toEqual(['codexCLI']);
  });

  it('refuses a Claude candidate outright — that CLI names its model, so this would hide a real fault', () => {
    expect(() => admissionOf(evidence({ provider: 'claudeCLI', requestedModelID: 'claude-opus-5' })))
      .toThrow(IdentityAdmissionError);
    try {
      admissionOf(evidence({ provider: 'claudeCLI', requestedModelID: 'claude-opus-5' }));
    } catch (error) {
      expect((error as IdentityAdmissionError).code).toBe('providerNotAdmissible');
    }
  });

  it('refuses an empty record, which would be a provider-wide exception', () => {
    expect(() => admissionOf()).toThrow(/empty record/i);
  });

  // THE BACKFILL PASS 5B FORBADE, enforced rather than remembered.
  it('refuses a record whose returned-model field was filled in', () => {
    expect(() => admissionOf(evidence({ returnedModelID: 'gpt-6-astra' as '' })))
      .toThrow(/never backfill/i);
  });

  it('requires every piece of provenance, and names what is missing', () => {
    for (const field of ['cliVersion', 'authenticationBasis', 'evidenceDigest', 'evidenceCapturedAt'] as const) {
      expect(() => admissionOf(evidence({ [field]: '' }))).toThrow(new RegExp(field));
    }
  });

  it('preserves requested identifier, requested effort, CLI version, auth basis and evidence digest', () => {
    const admission = admissionOf(evidence());
    const stored = admission.admitted[0];
    expect(stored.requestedModelID).toBe('gpt-6-astra');
    expect(stored.requestedEffort).toBe('max');
    expect(stored.cliVersion).toBe('codex-cli 0.154.0');
    expect(stored.authenticationBasis).toBe('ChatGPT subscription session');
    expect(stored.evidenceDigest).toBe('mlo1:abcdef0123456789');
    expect(stored.returnedModelID).toBe('');
  });

  it('seals itself, and notices when its contents change afterwards', () => {
    const admission = admissionOf(evidence());
    expect(admissionSealIsIntact(admission)).toBe(true);
    const tampered = { ...admission, admitted: [{ ...admission.admitted[0], requestedEffort: 'medium' as const }] };
    expect(admissionSealIsIntact(tampered)).toBe(false);
  });

  it('is granted to one campaign and is never inherited by another', () => {
    const admission = admissionOf(evidence());
    const result = admissionFor({
      provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max',
      campaignLabel: 'a-different-campaign', admission, active: true,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toMatch(/never inherited/i);
  });

  it('admits per configuration, never per provider', () => {
    const admission = admissionOf(evidence({ requestedEffort: 'max' }));
    // Same model, the other effort. Not admitted.
    expect(admissionFor({
      provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'medium',
      campaignLabel: 'pass-6-pilot', admission, active: true,
    }).admitted).toBe(false);
    expect(admissionFor({
      provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max',
      campaignLabel: 'pass-6-pilot', admission, active: true,
    }).admitted).toBe(true);
  });

  it('refuses when the manifest carries no record at all', () => {
    expect(admissionFor({
      provider: 'codexCLI', modelID: 'gpt-6-astra', effort: 'max',
      campaignLabel: 'pass-6-pilot', active: true,
    }).admitted).toBe(false);
  });

  it('refuses a record whose seal was broken', () => {
    const admission = admissionOf(evidence());
    const tampered = { ...admission, admitted: [{ ...admission.admitted[0], requestedModelID: 'gpt-5.6-sol' }] };
    expect(admissionFor({
      provider: 'codexCLI', modelID: 'gpt-5.6-sol', effort: 'max',
      campaignLabel: 'pass-6-pilot', admission: tampered, active: true,
    }).admitted).toBe(false);
  });
});

describe('the stamp every surface prints', () => {
  it('never reads as verified identity', () => {
    expect(admissionStamp(evidence())).toContain(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE);
    expect(admissionStamp(evidence())).toMatch(/unverifiable/i);
    expect(admissionStamp(evidence())).toMatch(/returned model: none/i);
    expect(ADMISSION_STAMP_SHORT).toMatch(/unverifiable/i);
    expect(ADMISSION_STAMP_LONG).toMatch(/NOT "this model/);
  });

  it('carries the requested identifier and effort into the stamp itself', () => {
    const stamp = admissionStamp(evidence({ requestedModelID: 'gpt-5.6-luna', requestedEffort: 'max' }));
    expect(stamp).toContain('gpt-5.6-luna');
    expect(stamp).toContain('max');
  });

  it('offers a full provenance block for a surface with room for it', () => {
    const lines = admissionProvenance(evidence()).join('\n');
    expect(lines).toMatch(/requested model: gpt-6-astra/);
    expect(lines).toMatch(/returned model: none/);
    expect(lines).toMatch(/CLI version: codex-cli 0\.154\.0/);
    expect(lines).toMatch(/authentication: ChatGPT subscription session/);
    expect(lines).toMatch(/evidence digest: mlo1:/);
  });
});

describe('routing never touches an admitted candidate', () => {
  it('routes a verified identity and refuses an admitted one', () => {
    expect(isRoutable('verified')).toBe(true);
    expect(isRoutable(REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE)).toBe(false);
  });
});
