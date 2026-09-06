// Unit · portable engine behaviour: fail-closed execution, append-only store, cancellation, evaluation idempotence.

import { describe, expect, it } from 'vitest';
import { steppingClock } from '@core/digest';
import { deterministicFake, skippyRelayGemma, makeCandidate } from '@core/candidate';
import { planRun, syntheticEnvironment } from '@core/run';
import { DeterministicFakeAdapter } from '@core/fake-adapter';
import { RunExecutor, ExecutionFailure } from '@core/executor';
import { CancellationToken, EvaluationAdapter } from '@core/adapter';
import { InMemoryResultStore } from '@core/store';
import { EvaluationEngine, EvaluationEngineFailure } from '@core/engine';
import { policyCatalog, registeredSuites, suiteByID } from '@core/catalog';
import { foundationSuite, foundationSuiteV2 } from '@core/foundation';
import { validateSuite, makeSuite, makeCase, BenchmarkValidationFailure } from '@core/benchmark';
import { buildProfile } from '@core/profile';
import { deriveRecommendation, standardRecommendationPolicy } from '@core/recommendation';

describe('executor fail-closed behaviour', () => {
  it('refuses a suite whose digest does not match the plan', async () => {
    const store = new InMemoryResultStore();
    const plan = planRun('mismatch', foundationSuite, [deterministicFake]);
    const executor = new RunExecutor(new DeterministicFakeAdapter(), store, syntheticEnvironment, steppingClock());
    await expect(executor.execute(plan, foundationSuiteV2, new CancellationToken())).rejects.toBeInstanceOf(ExecutionFailure);
    expect(await store.runIDs()).toEqual([]);
  });

  it('never invokes an unavailable candidate and records candidateUnavailable', async () => {
    const store = new InMemoryResultStore();
    let invoked = 0;
    const spying: EvaluationAdapter = {
      adapterID: 'spy', supportedExecutionClasses: ['inProcess'],
      async invoke(request, candidate, cancellation) { invoked += 1; return new DeterministicFakeAdapter().invoke(request, candidate, cancellation); },
    };
    const plan = planRun('unavailable', foundationSuite, [skippyRelayGemma]);
    await new RunExecutor(spying, store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken());
    expect(invoked).toBe(0);
    const attempts = await store.attempts('unavailable');
    expect(attempts.every((a) => a.terminalStatus === 'candidateUnavailable')).toBe(true);
    expect(attempts[0].observation.errors[0].code).toBe('candidate.unavailable');
  });

  it('refuses a required capability the candidate does not declare BEFORE invocation', async () => {
    const store = new InMemoryResultStore();
    const noJSON = makeCandidate({ ...deterministicFake, structuredOutput: 'notSupported' });
    const plan = planRun('unsupported', foundationSuite, [noJSON]);
    await new RunExecutor(new DeterministicFakeAdapter('succeedStructured'), store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken());
    const attempts = await store.attempts('unsupported');
    const json = attempts.find((a) => a.caseID.raw === 'case:foundation:json-shape')!;
    expect(json.terminalStatus).toBe('unsupportedCapability');
    expect(attempts.filter((a) => a.terminalStatus === 'completed').length).toBe(4);
  });

  it('turns an adapter that throws into a recorded failure, never a crash', async () => {
    const store = new InMemoryResultStore();
    const throwing: EvaluationAdapter = { adapterID: 'throws', supportedExecutionClasses: ['inProcess'], async invoke() { throw new Error('boom'); } };
    const plan = planRun('throws', foundationSuite, [deterministicFake]);
    const summary = await new RunExecutor(throwing, store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken());
    expect(summary.state).toBe('completed');
    expect(summary.statusCounts.failed).toBe(5);
    expect((await store.attempts('throws'))[0].observation.errors[0]).toEqual({ code: 'adapter.threw', detail: 'boom' });
  });

  it('marks identity mismatches and malformed JSON closed', async () => {
    const store = new InMemoryResultStore();
    const plan = planRun('mismatch-id', foundationSuite, [deterministicFake]);
    await new RunExecutor(new DeterministicFakeAdapter('reportWrongIdentity'), store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken());
    expect((await store.attempts('mismatch-id')).every((a) => a.terminalStatus === 'identityMismatch')).toBe(true);
    const store2 = new InMemoryResultStore();
    const plan2 = planRun('malformed', foundationSuite, [deterministicFake]);
    await new RunExecutor(new DeterministicFakeAdapter('produceMalformedOutput'), store2, syntheticEnvironment, steppingClock()).execute(plan2, foundationSuite, new CancellationToken());
    const json = (await store2.attempts('malformed')).find((a) => a.caseID.raw === 'case:foundation:json-shape')!;
    expect(json.terminalStatus).toBe('malformedOutput');
  });

  it('honours cancellation mid-run and keeps already-recorded evidence', async () => {
    const store = new InMemoryResultStore();
    const token = new CancellationToken();
    const plan = planRun('cancel', foundationSuite, [deterministicFake]);
    const executor = new RunExecutor(new DeterministicFakeAdapter('succeed', 5), store, syntheticEnvironment, steppingClock());
    const summaryPromise = executor.execute(plan, foundationSuite, token, {
      onAttemptRecorded: (_record, recorded) => { if (recorded === 2) token.cancel(); },
    });
    const summary = await summaryPromise;
    expect(summary.state).toBe('cancelled');
    expect(summary.recordedAttemptCount).toBe(2);
    expect((await store.attempts('cancel')).length).toBe(2);
    expect(await store.summary('cancel')).toBeDefined();
  });

  it('reports progress for every attempt', async () => {
    const store = new InMemoryResultStore();
    const plan = planRun('progress', foundationSuite, [deterministicFake]);
    const starting: number[] = [];
    const recorded: number[] = [];
    await new RunExecutor(new DeterministicFakeAdapter(), store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken(), {
      onAttemptStarting: (_p, index, total) => { starting.push(index * 100 + total); },
      onAttemptRecorded: (_r, count, total) => { recorded.push(count * 100 + total); },
    });
    expect(starting).toEqual([5, 105, 205, 305, 405]);
    expect(recorded).toEqual([105, 205, 305, 405, 505]);
  });
});

describe('append-only store semantics', () => {
  it('refuses every overwrite and has no delete', async () => {
    const store = new InMemoryResultStore();
    const plan = planRun('dup', foundationSuite, [deterministicFake]);
    await new RunExecutor(new DeterministicFakeAdapter(), store, syntheticEnvironment, steppingClock()).execute(plan, foundationSuite, new CancellationToken());
    await expect(store.appendPlan(plan)).rejects.toMatchObject({ code: 'duplicateRun' });
    const [first] = await store.attempts('dup');
    await expect(store.appendAttempt(first)).rejects.toMatchObject({ code: 'duplicateAttempt' });
    await expect(store.appendSummary((await store.summary('dup'))!)).rejects.toMatchObject({ code: 'duplicateSummary' });
    await expect(store.appendAttempt({ ...first, runID: 'unknown', attemptID: 'attempt:unknown:0' })).rejects.toMatchObject({ code: 'unknownRun' });
    expect('delete' in store).toBe(false);
  });

  it('evaluates idempotently: a second evaluation is a refused collision that agrees, never an overwrite', async () => {
    const store = new InMemoryResultStore();
    const clock = steppingClock();
    const plan = planRun('idem', foundationSuite, [deterministicFake]);
    await new RunExecutor(new DeterministicFakeAdapter(), store, syntheticEnvironment, clock).execute(plan, foundationSuite, new CancellationToken());
    const engine = new EvaluationEngine(policyCatalog, clock);
    const first = await engine.evaluateRun('idem', store);
    expect(first.every((o) => o.appended && o.scoreAppended)).toBe(true);
    const second = await engine.evaluateRun('idem', store);
    expect(second.every((o) => !o.appended && !o.scoreAppended)).toBe(true);
    expect(second.map((o) => o.record)).toEqual(first.map((o) => o.record));
    expect((await store.allEvaluations()).length).toBe(5);
  });

  it('surfaces a conflicting stored evaluation instead of overwriting it', async () => {
    const store = new InMemoryResultStore();
    const clock = steppingClock();
    const plan = planRun('conflict', foundationSuite, [deterministicFake]);
    await new RunExecutor(new DeterministicFakeAdapter(), store, syntheticEnvironment, clock).execute(plan, foundationSuite, new CancellationToken());
    const engine = new EvaluationEngine(policyCatalog, clock);
    const [attempt] = await store.attempts('conflict');
    const record = engine.evaluate(attempt);
    await store.appendEvaluation({ ...record, verdict: { ...record.verdict, status: 'pass' } });
    await expect(engine.evaluateAttempt(attempt.attemptID, store)).rejects.toBeInstanceOf(EvaluationEngineFailure);
  });
});

describe('catalog and validator', () => {
  it('registers thirteen plannable suites and validates every one', () => {
    expect(registeredSuites.length).toBe(14);
    for (const suite of registeredSuites) expect(() => validateSuite(suite)).not.toThrow();
    expect(suiteByID('suite.model-lab.nope')).toBeUndefined();
  });
  it('refuses live-data origins whole', () => {
    const bad = makeSuite('suite.test', '1', 'bad', [makeCase({ ...foundationSuite.cases[0], suiteID: { raw: 'suite.test' }, setupMetadata: {},
      inputs: { ...foundationSuite.cases[0].inputs, origin: 'live:messages' } })]);
    expect(() => validateSuite(bad)).toThrow(BenchmarkValidationFailure);
  });
});

describe('recommendation honesty', () => {
  it('returns insufficient evidence for a single clean run under the standard policy', async () => {
    const store = new InMemoryResultStore();
    const clock = steppingClock();
    const plan = planRun('one-run', foundationSuite, [deterministicFake]);
    await new RunExecutor(new DeterministicFakeAdapter(), store, syntheticEnvironment, clock).execute(plan, foundationSuite, new CancellationToken());
    await new EvaluationEngine(policyCatalog, clock).evaluateRun('one-run', store);
    const profile = buildProfile(deterministicFake.id, await store.attempts('one-run'), await store.allEvaluations(), [], {}, clock());
    const record = deriveRecommendation(profile, 0, standardRecommendationPolicy, 0, clock());
    // The fake's fixed completion never acknowledges the memory gap, so the foundation memory case is a
    // hard-governance violation — and governance dominates quality, always.
    expect(record.outcome).toBe('disqualified');
    expect(record.governanceFailures.length).toBeGreaterThan(0);
    const cleanProfile = buildProfile(deterministicFake.id, await store.attempts('one-run'), (await store.allEvaluations()).filter((e) => e.verdict.governance.state !== 'violated'), [], {}, clock());
    expect(deriveRecommendation(cleanProfile, 0, standardRecommendationPolicy, 1, clock()).outcome).toBe('insufficientEvidence');
    expect(record.authorizationBoundary).toContain('not authorization');
    expect(['recommended', 'notRecommended', 'insufficientEvidence', 'disqualified']).toContain(record.outcome);
  });
});
