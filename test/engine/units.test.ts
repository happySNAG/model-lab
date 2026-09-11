// Focused tests for the behaviours the campaign composes: manifest freezing and drift, guards,
// residency proof, the two verifications, telemetry, blinding, ranking and retention.

import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD_POLICY, GIB, describeBreach, evaluateGuards } from '../../src/engine/guards';
import { LiveResidency, LiveResidencyDisabled, ResidencyError, ScriptedResidency, unloadAndVerify } from '../../src/engine/residency';
import { ManifestError, deriveRetestManifest, freezeManifest, manifestSeal, verifyManifest } from '../../src/engine/manifest';
import type { ManifestInputs } from '../../src/engine/manifest';
import { identityPermitsExecution, suppliedContextIsUsable, verifyModelIdentity, verifySuppliedContext } from '../../src/engine/verification';
import { explainEmptyAnswer, summariseAttempt } from '../../src/engine/attempt-telemetry';
import { BlindingError, auditPacket, blindingToken, buildBlindedPacket, identityTerms, redact, unblind } from '../../src/engine/blinded';
import { rankCandidates } from '../../src/engine/ranking';
import type { RankableOutcome } from '../../src/engine/ranking';
import { recommendRetention } from '../../src/engine/retention';
import { HEALTHY_READING, SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { chatRequestBody } from '../../src/core/ollama';
import type { OllamaChatRequest } from '../../src/core/ollama';

const noSleep = async () => undefined;

// MARK: - Manifest

const BASE_INPUTS: ManifestInputs = {
  label: 'a cohort',
  catalogDigest: 'catalog-1',
  caseCount: 2,
  repeatsPerCase: 1,
  prompts: [
    { caseID: 'c1', text: 'user: what is the capital of France?' },
    { caseID: 'c2', text: 'user: summarise this', suppliedContext: 'the quick brown fox' },
  ],
  scoredCore: [
    { caseID: 'c1', caseDigest: 'd1', comparabilityKey: 'k1', scoringMode: 'plainText:p@1', maxOutputTokens: 128 },
    { caseID: 'c2', caseDigest: 'd2', comparabilityKey: 'k2', scoringMode: 'json:p@1', maxOutputTokens: 256 },
  ],
  evaluators: [{ evaluatorID: 'e1', source: 'exact match v1' }],
  execution: { residency: 'managed', thinkingMode: 'disabled' },
  candidates: [
    { name: 'alpha', modelID: 'alpha', runtimeDigest: 'sha-a', parameterSize: '4B', quantization: 'Q4' },
    { name: 'beta', modelID: 'beta', runtimeDigest: 'sha-b', parameterSize: '7B', quantization: 'Q4' },
  ],
  guards: { floor: 15 },
  hardware: SYNTHETIC_HARDWARE,
  runtimeVersion: 'runtime-1',
  frozenAt: '2026-01-01T00:00:00Z',
};

function live(overrides: Partial<Parameters<typeof verifyManifest>[1]> = {}) {
  return {
    catalogDigest: BASE_INPUTS.catalogDigest,
    prompts: BASE_INPUTS.prompts,
    scoredCore: BASE_INPUTS.scoredCore,
    evaluators: BASE_INPUTS.evaluators,
    candidates: BASE_INPUTS.candidates,
    guards: BASE_INPUTS.guards,
    hardware: BASE_INPUTS.hardware,
    runtimeVersion: BASE_INPUTS.runtimeVersion,
    ...overrides,
  };
}

describe('frozen manifest', () => {
  it('binds every prompt so a single changed byte is visible', () => {
    const manifest = freezeManifest(BASE_INPUTS);
    const changed = verifyManifest(manifest, live({
      prompts: [{ ...BASE_INPUTS.prompts[0], text: 'user: what is the capital of france?' }, BASE_INPUTS.prompts[1]],
    }), 'now');
    expect(changed.intact).toBe(false);
    expect(changed.drifts.map((d) => d.field)).toContain('promptsDigest');
    expect(changed.drifts[0].meaning).toMatch(/no longer being asked the same question/);
  });

  it('binds supplied context separately from the prompt', () => {
    const manifest = freezeManifest(BASE_INPUTS);
    const changed = verifyManifest(manifest, live({
      prompts: [BASE_INPUTS.prompts[0], { ...BASE_INPUTS.prompts[1], suppliedContext: 'the quick brown dog' }],
    }), 'now');
    expect(changed.intact).toBe(false);
  });

  it('binds candidate ORDER, not just membership', () => {
    const manifest = freezeManifest(BASE_INPUTS);
    const reordered = verifyManifest(manifest, live({ candidates: [...BASE_INPUTS.candidates].reverse() }), 'now');
    expect(reordered.intact).toBe(false);
    expect(reordered.drifts.map((d) => d.field)).toContain('candidatesDigest');
    expect(reordered.drifts.find((d) => d.field === 'candidatesDigest')?.meaning).toMatch(/thermal state is not reset/);
  });

  it('binds the guards, so loosening a floor is visible', () => {
    const manifest = freezeManifest(BASE_INPUTS);
    expect(verifyManifest(manifest, live({ guards: { floor: 5 } }), 'now').intact).toBe(false);
  });

  it('binds the evaluators, so the same answer cannot be rejudged by different rules', () => {
    const manifest = freezeManifest(BASE_INPUTS);
    expect(verifyManifest(manifest, live({ evaluators: [{ evaluatorID: 'e1', source: 'exact match v2' }] }), 'now').intact).toBe(false);
  });

  it('verifies intact against its own inputs', () => {
    expect(verifyManifest(freezeManifest(BASE_INPUTS), live(), 'now').intact).toBe(true);
  });

  it('does not claim a binding is intact when its input was not supplied', () => {
    const report = verifyManifest(freezeManifest(BASE_INPUTS), { catalogDigest: 'catalog-1' }, 'now');
    expect(report.intact).toBe(true);
    expect(report.drifts).toEqual([]);
  });

  it('refuses to freeze a manifest over zero prompts or zero candidates', () => {
    expect(() => freezeManifest({ ...BASE_INPUTS, prompts: [] })).toThrow(ManifestError);
    expect(() => freezeManifest({ ...BASE_INPUTS, candidates: [] })).toThrow(ManifestError);
  });

  it('refuses a scored case whose prompt is unbound', () => {
    expect(() => freezeManifest({
      ...BASE_INPUTS,
      scoredCore: [...BASE_INPUTS.scoredCore, { caseID: 'ghost', caseDigest: 'd', comparabilityKey: 'k', scoringMode: 'x', maxOutputTokens: 1 }],
    })).toThrow(/has no prompt/);
  });

  it('is deterministic: the same inputs freeze to the same digest', () => {
    expect(freezeManifest(BASE_INPUTS).manifestDigest).toBe(freezeManifest(BASE_INPUTS).manifestDigest);
  });

  it('offers a seal a person can read out loud', () => {
    expect(manifestSeal(freezeManifest(BASE_INPUTS))).toMatch(/^manifest manifest:[0-9a-f]{16} · catalog \S+ · prompts [0-9a-f]{12} · core [0-9a-f]{12} · candidates [0-9a-f]{12} · hardware [0-9a-f]{12}$/);
  });
});

describe('new-hardware retest manifest', () => {
  it('carries the benchmark across and records the lineage', () => {
    const original = freezeManifest(BASE_INPUTS);
    const derived = deriveRetestManifest(original, { ...SYNTHETIC_HARDWARE, model: 'Another Machine' }, 'runtime-2', 'new machine', 'moved house');
    expect(derived.promptsDigest).toBe(original.promptsDigest);
    expect(derived.scoredCoreDigest).toBe(original.scoredCoreDigest);
    expect(derived.evaluatorsDigest).toBe(original.evaluatorsDigest);
    expect(derived.retestOf?.manifestID).toBe(original.manifestID);
    expect(derived.manifestDigest).not.toBe(original.manifestDigest);
  });

  it('refuses a retest for hardware and runtime that did not change', () => {
    const original = freezeManifest(BASE_INPUTS);
    expect(() => deriveRetestManifest(original, SYNTHETIC_HARDWARE, 'runtime-1', 'now', 'no reason')).toThrow(ManifestError);
  });
});

// MARK: - Guards

describe('safety guards', () => {
  const baseline = { listingDigest: HEALTHY_READING.modelStoreListingDigest, count: HEALTHY_READING.modelStoreCount };

  it('passes a healthy machine', () => {
    expect(evaluateGuards(DEFAULT_GUARD_POLICY, HEALTHY_READING, baseline, 'now').allPassed).toBe(true);
  });

  it('reports a measurement alongside every verdict', () => {
    const verdict = evaluateGuards(DEFAULT_GUARD_POLICY, { ...HEALTHY_READING, freeDiskBytes: 12 * GIB + Math.round(0.41 * GIB) }, baseline, 'now');
    expect(describeBreach(verdict)).toMatch(/free 12\.41 GiB, floor 15\.00 GiB/);
  });

  it('catches swap, memory pressure, a noisy lane and a missing benchmark lane', () => {
    const breaches = (reading: Partial<typeof HEALTHY_READING>) =>
      evaluateGuards(DEFAULT_GUARD_POLICY, { ...HEALTHY_READING, ...reading }, baseline, 'now').breaches.map((b) => b.guardID);
    expect(breaches({ swapUsedBytes: 9 * GIB })).toContain('memory.swapUsed');
    expect(breaches({ freeMemoryBytes: GIB })).toContain('memory.free');
    expect(breaches({ listeners: { '11436': 1, '11435': 2 } })).toContain('port.quiet.11435');
    expect(breaches({ listeners: {} })).toContain('port.benchmarkLane');
  });

  it('is strictest about the production listener: a different pid is a breach', () => {
    const policy = { ...DEFAULT_GUARD_POLICY, productionListener: { port: 11434, pid: 900 } };
    const same = evaluateGuards(policy, { ...HEALTHY_READING, listeners: { '11436': 1, '11434': 900 } }, baseline, 'now');
    expect(same.allPassed).toBe(true);
    const different = evaluateGuards(policy, { ...HEALTHY_READING, listeners: { '11436': 1, '11434': 901 } }, baseline, 'now');
    expect(describeBreach(different)).toMatch(/held by pid 901, not the pid 900 recorded at freeze time/);
    const gone = evaluateGuards(policy, { ...HEALTHY_READING, listeners: { '11436': 1 } }, baseline, 'now');
    expect(describeBreach(gone)).toMatch(/the process recorded at freeze time \(pid 900\) is gone/);
  });

  it('catches a model store that changed under the campaign', () => {
    const verdict = evaluateGuards(DEFAULT_GUARD_POLICY, { ...HEALTHY_READING, modelStoreCount: 9 }, baseline, 'now');
    expect(verdict.breaches.map((b) => b.guardID)).toContain('modelStore.unchanged');
  });

  it('is a pure function of the reading, so an abort is reproducible from what it recorded', () => {
    const a = evaluateGuards(DEFAULT_GUARD_POLICY, HEALTHY_READING, baseline, 'now');
    const b = evaluateGuards(DEFAULT_GUARD_POLICY, HEALTHY_READING, baseline, 'now');
    expect(a.measurements).toEqual(b.measurements);
  });
});

// MARK: - Residency

describe('residency proof', () => {
  it('proves an empty resident set rather than trusting the unload', async () => {
    const controller = new ScriptedResidency({ 'alpha': 2 });
    controller.load('alpha');
    const proof = await unloadAndVerify(controller, 'alpha', { delayMilliseconds: 0, sleep: noSleep });
    expect(proof.verifiedEmpty).toBe(true);
    expect(proof.rounds).toBe(2);
    expect(proof.trace).toHaveLength(2);
    expect(proof.trace[0].resident).toEqual(['alpha']);
    expect(proof.trace[1].resident).toEqual([]);
  });

  it('throws with the resident set recorded when a model never releases', async () => {
    const controller = new ScriptedResidency({ 'alpha': 'never' });
    controller.load('alpha');
    await expect(unloadAndVerify(controller, 'alpha', { attempts: 3, delayMilliseconds: 0, sleep: noSleep })).rejects.toThrow(ResidencyError);
    try {
      await unloadAndVerify(controller, 'alpha', { attempts: 3, delayMilliseconds: 0, sleep: noSleep });
    } catch (error) {
      const detail = (error as ResidencyError).detail as { rounds: number; why: string };
      expect(detail.rounds).toBe(3);
      expect(detail.why).toMatch(/already holding weights/);
    }
  });

  it('keeps the live controller gated until it is explicitly enabled', async () => {
    const disabled = new LiveResidency(async () => [], async () => undefined, false);
    await expect(disabled.resident()).rejects.toThrow(LiveResidencyDisabled);
    await expect(disabled.unload('x')).rejects.toThrow(LiveResidencyDisabled);
    const enabled = new LiveResidency(async () => ['x'], async () => undefined, true);
    expect(await enabled.resident()).toEqual(['x']);
  });
});

// MARK: - Verification

describe('supplied-context verification', () => {
  it('accepts a context that arrived byte for byte', () => {
    const result = verifySuppliedContext('hello world', 'hello world');
    expect(result.state).toBe('intact');
    expect(suppliedContextIsUsable(result)).toBe(true);
  });

  it('names an absent context as absent, and says why it matters', () => {
    const result = verifySuppliedContext('hello world', undefined);
    expect(result.state).toBe('absent');
    expect(result.detail).toMatch(/measures guessing rather than retrieval/);
    expect(suppliedContextIsUsable(result)).toBe(false);
  });

  it('distinguishes truncation from mutation', () => {
    expect(verifySuppliedContext('hello world', 'hello').state).toBe('truncated');
    expect(verifySuppliedContext('hello world', 'goodbye world').state).toBe('mutated');
  });

  it('catches a context the harness added that the manifest never froze', () => {
    expect(verifySuppliedContext(undefined, 'injected').state).toBe('mutated');
  });

  it('passes a case that supplies no context', () => {
    const result = verifySuppliedContext(undefined, undefined);
    expect(result.state).toBe('notSupplied');
    expect(suppliedContextIsUsable(result)).toBe(true);
  });
});

describe('model identity verification', () => {
  const pinned = { name: 'alpha', modelID: 'alpha', runtimeDigest: 'sha-a', parameterSize: '4B', quantization: 'Q4' };

  it('verifies when the runtime reports the pinned digest', () => {
    const result = verifyModelIdentity(pinned, pinned);
    expect(result.state).toBe('verified');
    expect(identityPermitsExecution(result)).toBe(true);
  });

  it('is a mismatch when the digest differs, and says so plainly', () => {
    const result = verifyModelIdentity(pinned, { ...pinned, runtimeDigest: 'sha-other' });
    expect(result.state).toBe('mismatch');
    expect(result.detail).toMatch(/serving different weights/);
    expect(identityPermitsExecution(result)).toBe(false);
  });

  it('never treats an unreported field as a match', () => {
    const result = verifyModelIdentity(pinned, { name: 'alpha' });
    expect(result.state).toBe('unverifiable');
    expect(result.unreported).toContain('runtimeDigest');
    expect(result.mismatches).toEqual([]);
    expect(identityPermitsExecution(result)).toBe(true);
  });

  it('is unverifiable, not verified, when nothing was pinned to contradict', () => {
    const result = verifyModelIdentity({ ...pinned, runtimeDigest: '' }, { name: 'alpha' });
    expect(result.state).toBe('unverifiable');
    expect(result.detail).toMatch(/nothing contradicts the pin, but nothing confirms it either/);
  });

  it('reports a quantization change as a mismatch even when the digest matches', () => {
    const result = verifyModelIdentity(pinned, { ...pinned, quantization: 'Q8' });
    expect(result.state).toBe('mismatch');
    expect(result.mismatches[0].field).toBe('quantization');
  });
});

// MARK: - Telemetry

describe('per-attempt telemetry', () => {
  it('times the first VISIBLE token, not the first thinking token', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'thinking', tokens: 50, atMilliseconds: 100 }, { channel: 'visible', tokens: 20, atMilliseconds: 900 }],
      { evalTokenCount: 70, evalDurationNanoseconds: 1_000_000_000, doneReason: 'stop' }, 1_000);
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({ measured: 900 });
    expect(telemetry.firstThinkingTokenMilliseconds).toEqual({ measured: 100 });
  });

  it('records unavailable WITH A REASON rather than guessing', () => {
    const telemetry = summariseAttempt([], {}, undefined);
    expect(telemetry.timeToFirstTokenMilliseconds).toEqual({ unavailableReason: 'the adapter did not stream, so no token arrival time was observed' });
    expect(telemetry.throughputTokensPerSecondMilli).toEqual({ unavailableReason: 'the runtime reported no completion token count' });
    expect(telemetry.doneReason).toEqual({ unavailableReason: 'the runtime gave no reason for stopping' });
    expect(telemetry.streamed).toBe(false);
  });

  it('never turns a missing token count into a zero throughput', () => {
    const telemetry = summariseAttempt([], { evalTokenCount: 10, evalDurationNanoseconds: 0 }, 100);
    expect('unavailableReason' in telemetry.throughputTokensPerSecondMilli).toBe(true);
  });

  it('counts the thinking and visible channels separately', () => {
    const telemetry = summariseAttempt(
      [{ channel: 'thinking', tokens: 900, atMilliseconds: 10 }],
      { evalTokenCount: 900, evalDurationNanoseconds: 4_000_000_000, doneReason: 'length' }, 4_000);
    expect(telemetry.thinkingTokenCount).toEqual({ measured: 900 });
    expect(telemetry.visibleTokenCount).toEqual({ measured: 0 });
    expect(telemetry.thinkingOnly).toBe(true);
    expect(explainEmptyAnswer(telemetry, 1_024)).toMatch(/spent 900 of its 1024-token budget thinking/);
  });

  it('does not call a warm response warm when the weights were loaded during it', () => {
    const cold = summariseAttempt([], { weightsWereLoaded: true, loadDurationNanoseconds: 3_000_000_000 }, 5_000);
    expect(cold.coldLoadMilliseconds).toEqual({ measured: 3_000 });
    expect('unavailableReason' in cold.warmResponseMilliseconds).toBe(true);
  });

  it('offers no explanation when there is a visible answer', () => {
    const telemetry = summariseAttempt([{ channel: 'visible', tokens: 5, atMilliseconds: 10 }], {}, 20);
    expect(explainEmptyAnswer(telemetry, 512)).toBeUndefined();
  });
});

// MARK: - Blinding

describe('blinded adjudication', () => {
  const candidates = [{ name: 'qwen3.8:27b' }, { name: 'gemma3:4b' }];
  const responses = [
    { slotKey: 'qwen3.8:27b|s|1|c1', caseID: 'c1', candidate: 'qwen3.8:27b', answerText: 'As Qwen, I would say yes.', status: 'requiresHumanReview' },
    { slotKey: 'gemma3:4b|s|1|c1', caseID: 'c1', candidate: 'gemma3:4b', answerText: 'Gemma here. No.', status: 'requiresHumanReview' },
  ];
  const secret = 'a-secret-that-is-long-enough';

  it('catches the fragments a model actually names itself by', () => {
    const terms = identityTerms(candidates);
    expect(terms).toContain('qwen3.8:27b');
    expect(terms).toContain('qwen3.8');
    expect(terms).toContain('qwen');
    expect(terms).toContain('gemma3');
    expect(terms).toContain('gemma');
  });

  it('leaves ordinary English that happens to appear in a model name alone', () => {
    const terms = identityTerms([{ name: 'mistral-7b-instruct' }]);
    expect(terms).not.toContain('instruct');
    expect(terms).toContain('mistral');
  });

  it('redacts longest-first, so a longer name is not eaten by its own prefix', () => {
    const { text } = redact('qwen3.8:27b said something', identityTerms(candidates));
    expect(text).toBe('[MODEL NAME REDACTED] said something');
  });

  it('derives a token that is not linkable across cases', () => {
    expect(blindingToken(secret, 'm|s|1|c1')).not.toBe(blindingToken(secret, 'm|s|1|c2'));
    expect(blindingToken(secret, 'm|s|1|c1')).toBe(blindingToken(secret, 'm|s|1|c1'));
    expect(blindingToken(secret, 'm|s|1|c1')).toMatch(/^R-[0-9a-f]{12}$/);
  });

  it('refuses a secret too short to be worth having', () => {
    expect(() => buildBlindedPacket(responses, {}, candidates, 'short', 'now')).toThrow(BlindingError);
  });

  it('produces a packet with no identity in it, and audits itself clean', () => {
    const { packet } = buildBlindedPacket(responses, { c1: 'the prompt' }, candidates, secret, 'now');
    const audit = auditPacket(packet, candidates);
    expect(audit.clean).toBe(true);
    expect(JSON.stringify(packet)).not.toMatch(/qwen|gemma/i);
  });

  it('shuffles per case, reproducibly from the seed', () => {
    const a = buildBlindedPacket(responses, {}, candidates, secret, 'now', 42).packet;
    const b = buildBlindedPacket(responses, {}, candidates, secret, 'now', 42).packet;
    expect(a.cases[0].responses.map((r) => r.token)).toEqual(b.cases[0].responses.map((r) => r.token));
  });

  it('reverses only with the key, and refuses a verdict from another packet', () => {
    const { packet, key } = buildBlindedPacket(responses, {}, candidates, secret, 'now');
    const token = packet.cases[0].responses[0].token;
    const [unblinded] = unblind([{ token, outcome: 'satisfactory', note: 'fine' }], key);
    expect(['qwen3.8:27b', 'gemma3:4b']).toContain(unblinded.candidate);
    expect(() => unblind([{ token: 'R-000000000000', outcome: 'mixed', note: '' }], key)).toThrow(/different packets/);
  });

  it('notices a packet that still carries an identity field', () => {
    const { packet } = buildBlindedPacket(responses, {}, candidates, secret, 'now');
    const tampered = JSON.parse(JSON.stringify(packet));
    tampered.cases[0].responses[0].candidate = 'qwen3.8:27b';
    const audit = auditPacket(tampered, candidates);
    expect(audit.clean).toBe(false);
    expect(audit.identityFieldsPresent).toContain('"candidate"');
  });
});

// MARK: - Ranking and retention

function outcome(candidate: string, caseID: string, status: string, extra: Partial<RankableOutcome> = {}): RankableOutcome {
  return { candidate, caseID, dimension: 'conversation', status, governanceViolated: false, latencyMilliseconds: 100, ...extra };
}

describe('final rankings', () => {
  it('marks everything provisional without a reconciliation', () => {
    const result = rankCandidates({ outcomes: [outcome('a', 'c1', 'pass')], derivedAt: 'now' });
    expect(result.provisional).toBe(true);
    expect(result.provisionalBecause[0]).toMatch(/not backed by a balanced ledger/);
  });

  it('counts only `pass` as a pass and reports `partial` beside it', () => {
    const result = rankCandidates({
      outcomes: [outcome('a', 'c1', 'pass'), outcome('a', 'c2', 'partial'), outcome('a', 'c3', 'fail')],
      derivedAt: 'now',
    });
    const dimension = result.rankings[0].dimensions[0];
    expect(dimension.passCount).toBe(1);
    expect(dimension.partialCount).toBe(1);
    expect(dimension.failCount).toBe(1);
    expect(dimension.passRateMilli).toEqual({ measured: 333 });
  });

  it('excludes awaiting-review outcomes from the denominator entirely', () => {
    const result = rankCandidates({
      outcomes: [outcome('a', 'c1', 'pass'), outcome('a', 'c2', 'requiresHumanReview')],
      derivedAt: 'now',
    });
    expect(result.rankings[0].dimensions[0].scoredCount).toBe(1);
    expect(result.rankings[0].overallPassRateMilli).toEqual({ measured: 1000 });
    expect(result.awaitingHumanReviewTotal).toBe(1);
  });

  it('gives a dimension with no scored results no rate at all, never a zero', () => {
    const result = rankCandidates({ outcomes: [outcome('a', 'c1', 'requiresHumanReview')], derivedAt: 'now' });
    expect('unavailableReason' in result.rankings[0].dimensions[0].passRateMilli).toBe(true);
    expect('unavailableReason' in result.rankings[0].overallPassRateMilli).toBe(true);
  });

  it('ranks a disqualified candidate below every qualified one, whatever its rate', () => {
    const result = rankCandidates({
      outcomes: [
        outcome('perfect-but-unsafe', 'c1', 'pass', { governanceViolated: true }),
        ...Array.from({ length: 9 }, (_, i) => outcome('perfect-but-unsafe', `c${i + 2}`, 'pass')),
        outcome('mediocre', 'c1', 'pass'), outcome('mediocre', 'c2', 'fail'),
      ],
      derivedAt: 'now',
    });
    expect(result.rankings[0].candidate).toBe('mediocre');
    expect(result.rankings[1].candidate).toBe('perfect-but-unsafe');
    expect(result.rankings[1].disqualified).toBe(true);
  });

  it('assesses capability roles, and labels each as interpretation', () => {
    const dimensions = ['conversation', 'emotionalUnderstanding', 'memoryHonesty', 'hallucinationResistance'] as const;
    const result = rankCandidates({
      outcomes: dimensions.flatMap((dimension) => Array.from({ length: 10 }, (_, i) => outcome('a', `${dimension}-${i}`, 'pass', { dimension }))),
      derivedAt: 'now',
    });
    const companion = result.rankings[0].roles.find((role) => role.role === 'conversational companion')!;
    expect(companion.qualified).toBe(true);
    expect(companion.reason).toMatch(/reached 80\.0%/);
    expect(companion.interpretation).toMatch(/not a measurement/);
  });

  it('refuses a role on insufficient evidence and says which dimensions are missing', () => {
    const result = rankCandidates({ outcomes: [outcome('a', 'c1', 'pass')], derivedAt: 'now' });
    const companion = result.rankings[0].roles.find((role) => role.role === 'conversational companion')!;
    expect(companion.qualified).toBe(false);
    expect(companion.reason).toMatch(/no evidence for emotionalUnderstanding, memoryHonesty, hallucinationResistance/);
  });
});

describe('retention recommendations', () => {
  const many = (candidate: string, passes: number, total: number) =>
    Array.from({ length: total }, (_, i) => outcome(candidate, `c${i}`, i < passes ? 'pass' : 'fail'));

  it('carries a heading that names it interpretation', () => {
    const report = recommendRetention(rankCandidates({ outcomes: many('a', 18, 20), derivedAt: 'now' }));
    expect(report.heading).toMatch(/INTERPRETATION, not measurement/);
    expect(report.preamble.join(' ')).toMatch(/No model is deleted by this engine/);
  });

  it('recommends keeping a strong model and attaches the evidence', () => {
    const report = recommendRetention(rankCandidates({ outcomes: many('a', 18, 20), derivedAt: 'now' }));
    const recommendation = report.recommendations[0];
    expect(recommendation.outcome).toBe('keep');
    expect(recommendation.statement).toMatch(/^Keep a\./);
    expect(recommendation.evidence.join(' ')).toMatch(/90\.0% overall pass rate across 20 scored outcomes/);
  });

  it('recommends replacing a weak one', () => {
    const report = recommendRetention(rankCandidates({ outcomes: many('a', 4, 20), derivedAt: 'now' }));
    expect(report.recommendations[0].outcome).toBe('replace');
    expect(report.recommendations[0].statement).toMatch(/Consider replacing a\./);
  });

  it('offers no recommendation at all on thin evidence', () => {
    const report = recommendRetention(rankCandidates({ outcomes: many('a', 2, 3), derivedAt: 'now' }));
    expect(report.recommendations[0].outcome).toBe('insufficientEvidence');
    expect(report.recommendations[0].statement).toMatch(/rather than a guess/);
  });

  it('stays provisional while a blinded adjudication is outstanding', () => {
    const outcomes = [...many('a', 18, 20), outcome('a', 'rubric', 'requiresHumanReview')];
    const report = recommendRetention(rankCandidates({ outcomes, derivedAt: 'now' }));
    expect(report.provisional).toBe(true);
    expect(report.recommendations[0].awaitingHumanReview).toBe(1);
  });
});


// MARK: - The one core change this pass makes

describe('keep_alive is additive and only ever present when asked for', () => {
  const base: OllamaChatRequest = {
    model: 'alpha:1b', messages: [{ role: 'user', content: 'hello' }], stopSequences: [],
    requireJSONFormat: false, thinkingMode: 'disabled', timeoutMilliseconds: 1_000,
  };

  it('emits exactly the body it always emitted when no keep-alive is asked for', () => {
    expect(chatRequestBody(base)).toBe(chatRequestBody({ ...base, keepAliveSeconds: undefined }));
    expect(JSON.parse(chatRequestBody(base))).not.toHaveProperty('keep_alive');
  });

  it('asks the runtime to release the weights now when it is zero', () => {
    // The residency guard caught the version of this that did NOT send keep_alive: the model stayed
    // resident and the campaign refused to continue. This is the field that actually releases it.
    expect(JSON.parse(chatRequestBody({ ...base, keepAliveSeconds: 0 })).keep_alive).toBe(0);
  });

  it('passes a non-zero keep-alive through unchanged', () => {
    expect(JSON.parse(chatRequestBody({ ...base, keepAliveSeconds: 300 })).keep_alive).toBe(300);
  });
});
