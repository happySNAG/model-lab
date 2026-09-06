// Parity · plans, executed bundles (fake adapter × suites), hand-authored evaluation cases, derived
// views, and the Ollama wire codec — value-for-value against the canonical Swift implementation.

import { describe, expect, it } from 'vitest';
import { steppingClock, T0 } from '@core/digest';
import { deterministicFake, skippyRelayGemma, descriptorDigest } from '@core/candidate';
import { planRun, PlanningFailure, RunPlan, AttemptRecord, syntheticEnvironment, syntheticEnvironmentWithHardware, RunSummary } from '@core/run';
import { DeterministicFakeAdapter, FakeScript } from '@core/fake-adapter';
import { RunExecutor } from '@core/executor';
import { CancellationToken } from '@core/adapter';
import { InMemoryResultStore, EvidenceBundle, bundleDigest } from '@core/store';
import { EvaluationEngine } from '@core/engine';
import { EvaluationRecord, derivedScoreProjection } from '@core/evaluation';
import { DerivedScoreRecord } from '@core/run';
import { policyCatalog, suiteByID } from '@core/catalog';
import { foundationSuite, foundationSuiteV2 } from '@core/foundation';
import { buildProfile, CapabilityProfile } from '@core/profile';
import { deriveRecommendation, OwnerRecommendationRecord, standardRecommendationPolicy } from '@core/recommendation';
import { cohortComparisons, repetitionConsistency, runOverviews, trendPoints } from '@core/history';
import { buildSideBySide } from '@core/side-by-side';
import { assessQualification } from '@core/qualification';
import { chatReportFrom, chatRequestBody, OllamaChatRequest, OllamaModelReport, OllamaTransportFailure, candidateFromModelReport, ThinkingMode } from '@core/ollama';
import { derivedTokensPerSecondMilli } from '@core/telemetry';
import { Measurement } from '@core/candidate';
import { jsonClone, loadFixture } from './fixtures';

interface PlanFixture { plans: RunPlan[]; refusals: Record<string, string> }
interface ExecutedFixture { script: string; suiteID: string; runID: string; summary: RunSummary; bundle: EvidenceBundle; bundleDigest: string }
interface EvaluationCase { label: string; attempt: AttemptRecord; evaluation: EvaluationRecord; derivedScore: DerivedScoreRecord }
interface ViewsFixture {
  profileUnfiltered: CapabilityProfile; profileFilteredToFoundationV1: CapabilityProfile;
  recommendationStandard: OwnerRecommendationRecord; recommendationLenient: OwnerRecommendationRecord; recommendationExecutedSucceed: OwnerRecommendationRecord;
  runOverviews: unknown[]; cohorts: unknown[]; trendMemoryHonesty: unknown[]; consistencyEcho: unknown[]; sideBySide: unknown[];
  qualificationVerdicts: Record<string, string>;
}
interface OllamaFixture {
  chatBodies: { request: OllamaChatRequest; bodyJSON: string }[];
  chatReports: { rawResponse: string; report?: Record<string, unknown>; failure?: string }[];
  probes: { report: OllamaModelReport; thinkingMode: ThinkingMode; candidate: unknown; descriptorDigest: string }[];
  telemetry: { evalTokens: Measurement<number>; evalDurationNanoseconds: Measurement<number>; tokensPerSecondMilli: Measurement<number> }[];
}

const plans = loadFixture<PlanFixture>('plans.json');
const executed = loadFixture<ExecutedFixture[]>('executed.json');
const evaluationCases = loadFixture<EvaluationCase[]>('evaluations.json');
const views = loadFixture<ViewsFixture>('views.json');
const ollama = loadFixture<OllamaFixture>('ollama.json');

describe('plan parity', () => {
  it('produces identical sealed plans for the fixture inputs', () => {
    const memory = suiteByID('suite.model-lab.memory-honesty')!;
    const expected = new Map(plans.plans.map((p) => [p.runID, p]));
    expect(jsonClone(planRun('parity-foundation', foundationSuite, [deterministicFake]))).toEqual(expected.get('parity-foundation'));
    expect(jsonClone(planRun('parity-two-candidates', foundationSuiteV2, [skippyRelayGemma, deterministicFake]))).toEqual(expected.get('parity-two-candidates'));
    expect(jsonClone(planRun('parity-memory', memory, [deterministicFake]))).toEqual(expected.get('parity-memory'));
  });
  it('refuses the same malformed inputs', () => {
    const code = (fn: () => void) => { try { fn(); return 'NO ERROR'; } catch (e) { return (e as PlanningFailure).code; } };
    expect(code(() => planRun('', foundationSuite, [deterministicFake]))).toBe('emptyRunID');
    expect(code(() => planRun('Bad Run', foundationSuite, [deterministicFake]))).toBe('unsafeRunID');
    expect(code(() => planRun('ok', foundationSuite, []))).toBe('noCandidates');
    expect(code(() => planRun('ok', foundationSuite, [deterministicFake, deterministicFake]))).toBe('duplicateCandidate');
    expect(Object.keys(plans.refusals).sort()).toEqual(['duplicateCandidate', 'emptyRunID', 'noCandidates', 'unsafeRunID']);
  });
});

describe('executed bundle parity (executor + fake adapter + engine + projection + bundle ordering)', () => {
  const suites = new Map([foundationSuite, foundationSuiteV2, suiteByID('suite.model-lab.structured-output')!, suiteByID('suite.model-lab.memory-honesty')!].map((s) => [s.id.raw, s]));
  for (const fixture of executed.filter((f) => f.script !== 'cancelAfterFirstAttempt')) {
    it(`${fixture.script} × ${fixture.suiteID}`, async () => {
      const store = new InMemoryResultStore();
      const clock = steppingClock();
      const suite = suites.get(fixture.suiteID)!;
      const plan = planRun(fixture.runID, suite, [deterministicFake, skippyRelayGemma]);
      const executor = new RunExecutor(new DeterministicFakeAdapter(fixture.script as FakeScript), store, syntheticEnvironmentWithHardware, clock);
      const summary = await executor.execute(plan, suite, new CancellationToken());
      const engine = new EvaluationEngine(policyCatalog, clock);
      await engine.evaluateRun(fixture.runID, store);
      const bundle = await store.exportAll();
      expect(jsonClone(summary)).toEqual(fixture.summary);
      expect(jsonClone(bundle)).toEqual(fixture.bundle);
      expect(bundleDigest(bundle)).toBe(fixture.bundleDigest);
    });
  }
  it('cancels between attempts exactly like Swift (first attempt recorded, run state cancelled)', async () => {
    const fixture = executed.find((f) => f.script === 'cancelAfterFirstAttempt')!;
    const store = new InMemoryResultStore();
    const clock = steppingClock();
    const token = new CancellationToken();
    let calls = 0;
    const cancellingClock = () => { calls += 1; if (calls === 3) token.cancel(); return clock(); };
    const plan = planRun('parity-cancel-midrun', foundationSuite, [deterministicFake]);
    const executor = new RunExecutor(new DeterministicFakeAdapter('succeed'), store, syntheticEnvironment, cancellingClock);
    const summary = await executor.execute(plan, foundationSuite, token);
    expect(jsonClone(summary)).toEqual(fixture.summary);
    expect(jsonClone(await store.exportAll())).toEqual(fixture.bundle);
  });
});

describe('evaluation parity (hand-authored answers across every catalog case)', () => {
  const engine = new EvaluationEngine(policyCatalog, steppingClock());
  it('has one fixture per authored answer', () => {
    expect(evaluationCases.length).toBeGreaterThan(90);
  });
  for (const fixture of evaluationCases) {
    it(fixture.label, () => {
      const record = engine.evaluate(fixture.attempt);
      // The evaluator's judgment (everything but the instant) must be identical; the instant comes from the clock.
      expect(jsonClone({ ...record, evaluatedAt: fixture.evaluation.evaluatedAt })).toEqual(fixture.evaluation);
      expect(jsonClone(derivedScoreProjection(fixture.evaluation))).toEqual(fixture.derivedScore);
    });
  }
});

describe('derived-view parity (profiles, recommendations, history, side-by-side, qualification)', () => {
  const attempts = evaluationCases.map((c) => c.attempt);
  const evaluations = evaluationCases.map((c) => c.evaluation);
  const unionAttempts = executed.flatMap((f) => f.bundle.attempts);
  const unionEvaluations = executed.flatMap((f) => f.bundle.evaluations);
  const unionSummaries = executed.flatMap((f) => f.bundle.summaries);

  it('builds identical capability profiles (unfiltered and filtered)', () => {
    const clock = steppingClock();
    const profile = buildProfile(deterministicFake.id, attempts, evaluations, [], {}, clock());
    expect(jsonClone(profile)).toEqual(views.profileUnfiltered);
    const filtered = buildProfile(deterministicFake.id, attempts, evaluations, [],
      { suiteVersions: new Set(['1']), quantizations: new Set(['none']), from: T0, to: new Date(T0.getTime() + 100_000 * 1000) }, clock());
    expect(jsonClone(filtered)).toEqual(views.profileFilteredToFoundationV1);
  });
  it('derives identical recommendations under the standard and a lenient policy', () => {
    const profile = views.profileUnfiltered;
    const lenient = { minimumSamplesPerDimension: 1, minimumDimensionsWithEvidence: 1, recommendQualityThresholdMilli: 500 };
    const standard = deriveRecommendation(profile, 0, standardRecommendationPolicy, 0, new Date(views.recommendationStandard.derivedAt));
    expect(jsonClone(standard)).toEqual(views.recommendationStandard);
    const lenientRecord = deriveRecommendation(profile, 0, lenient, 1, new Date(views.recommendationLenient.derivedAt));
    expect(jsonClone(lenientRecord)).toEqual(views.recommendationLenient);
    const clean = executed.find((f) => f.script === 'succeedStructured' && f.suiteID === 'suite.model-lab.structured-output')!.bundle;
    const cleanProfile = buildProfile(deterministicFake.id, clean.attempts, clean.evaluations, [], {}, new Date(views.recommendationExecutedSucceed.derivedAt));
    const cleanRecord = deriveRecommendation({ ...cleanProfile, derivedAt: cleanProfile.derivedAt }, 0, lenient, 0, new Date(views.recommendationExecutedSucceed.derivedAt));
    expect(jsonClone(cleanRecord)).toEqual(views.recommendationExecutedSucceed);
    expect(['recommended', 'notRecommended', 'insufficientEvidence', 'disqualified']).toContain(cleanRecord.outcome);
  });
  it('browses history identically: run overviews, cohorts, trends, repetition consistency', () => {
    const overviews = runOverviews(unionAttempts, unionSummaries, unionEvaluations).map((o) => ({
      ...o, suiteID: o.suiteID.raw, candidateIDs: o.candidateIDs.map((c) => c.raw),
    }));
    expect(jsonClone(overviews)).toEqual(views.runOverviews);
    const cohorts = cohortComparisons(deterministicFake.id, unionEvaluations, unionAttempts).map((c) => ({
      comparabilitySignature: c.comparabilitySignature, runs: c.runs, latest: c.latest?.runID, best: c.best?.runID,
    }));
    expect(jsonClone(cohorts)).toEqual(views.cohorts);
    const trend = trendPoints(deterministicFake.id, 'memoryHonesty', unionEvaluations, unionAttempts).map((p) => ({ ...p, caseID: p.caseID.raw }));
    expect(jsonClone(trend)).toEqual(views.trendMemoryHonesty);
    const consistency = repetitionConsistency(deterministicFake.id, { raw: 'case:foundation:echo-instruction' }, unionAttempts, unionEvaluations)
      .map((c) => ({ ...c, caseID: c.caseID.raw }));
    expect(jsonClone(consistency)).toEqual(views.consistencyEcho);
  });
  it('reports identical side-by-side eligibility verdicts', () => {
    const find = (script: string, suiteID: string) => executed.find((f) => f.script === script && f.suiteID === suiteID)!.bundle.attempts;
    const succeedFoundation = find('succeed', 'suite.model-lab.foundation');
    const succeedV2 = find('succeed', 'suite.model-lab.foundation-v2');
    const malformed = find('produceMalformedOutput', 'suite.model-lab.foundation');
    const evaluationsFor = (a: AttemptRecord) => unionEvaluations.filter((e) => e.attemptID === a.attemptID);
    const mirror = (a: AttemptRecord, b: AttemptRecord) => {
      const c = buildSideBySide(a, evaluationsFor(a), [], b, evaluationsFor(b), []);
      return {
        attemptA: a.attemptID, attemptB: b.attemptID, attemptComparabilityKeysMatch: c.attemptComparabilityKeysMatch,
        directlyComparable: c.directlyComparable, ineligibilityReasons: c.ineligibilityReasons,
        pairs: c.evaluationEligibility.map((p) => ({ a: p.evaluationIDA, b: p.evaluationIDB, directlyComparable: p.verdict.directlyComparable, reasons: p.verdict.reasons })),
      };
    };
    const mirrors = [mirror(succeedFoundation[0], malformed[0]), mirror(succeedFoundation[0], succeedV2[0]), mirror(succeedFoundation[0], succeedFoundation[3])];
    expect(jsonClone(mirrors)).toEqual(views.sideBySide);
  });
  it('assesses qualification identically (and can never say approved)', () => {
    for (const fixture of executed.filter((f) => f.suiteID === 'suite.model-lab.foundation')) {
      const verdict = assessQualification(deterministicFake, foundationSuite, fixture.bundle.attempts, fixture.bundle.scores, fixture.bundle.summaries, fixture.bundle.evaluations);
      expect(verdict, fixture.runID).toBe(views.qualificationVerdicts[fixture.runID]);
      const relay = assessQualification(skippyRelayGemma, foundationSuite, fixture.bundle.attempts, fixture.bundle.scores, fixture.bundle.summaries, fixture.bundle.evaluations);
      expect(relay).toBe(views.qualificationVerdicts[fixture.runID + '|relay']);
    }
    expect(assessQualification(deterministicFake, foundationSuite, [], [], [])).toBe(views.qualificationVerdicts['registered-no-attempts']);
  });
});

describe('Ollama wire and prober parity', () => {
  it('builds chat bodies equal (as parsed JSON) to the Swift transport, with the thinking instruction stated', () => {
    for (const vector of ollama.chatBodies) {
      const body = JSON.parse(chatRequestBody(vector.request));
      const expected = JSON.parse(vector.bodyJSON);
      // Swift prints doubles with 17 significant digits (0.69999999999999996); compare numerically.
      expect(normalizeNumbers(body)).toEqual(normalizeNumbers(expected));
      expect(Object.keys(body)).toEqual(Object.keys(expected));
    }
  });
  it('decodes chat responses identically, keeping the reasoning field apart from the answer', () => {
    for (const vector of ollama.chatReports) {
      if (vector.report) {
        expect(jsonClone(chatReportFrom(vector.rawResponse))).toEqual(vector.report);
      } else {
        expect(() => chatReportFrom(vector.rawResponse)).toThrow(OllamaTransportFailure);
        try { chatReportFrom(vector.rawResponse); } catch (e) { expect((e as OllamaTransportFailure).kind).toBe('malformedResponse'); }
      }
    }
  });
  it('probes identical candidate descriptors from the runtime report', () => {
    for (const vector of ollama.probes) {
      const candidate = candidateFromModelReport(vector.report, vector.thinkingMode);
      expect(jsonClone(candidate)).toEqual(vector.candidate);
      expect(descriptorDigest(candidate)).toBe(vector.descriptorDigest);
    }
  });
  it('derives tokens/second identically (never zero, never estimated)', () => {
    for (const vector of ollama.telemetry) {
      expect(derivedTokensPerSecondMilli(vector.evalTokens, vector.evalDurationNanoseconds)).toEqual(vector.tokensPerSecondMilli);
    }
  });
});

function normalizeNumbers(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6;
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, normalizeNumbers(v)]));
  return value;
}
