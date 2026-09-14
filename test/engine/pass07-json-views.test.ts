// Pass 7 · two readings of a JSON answer, and the line between them.
//
// The Pass 6 pilot ranked twelve configurations on `json-shape`. All twelve produced correct JSON
// with the required key; six emitted it bare and swept 100%, four wrapped it in a ```json fence and
// scored 75% or 50%. One convention produced the entire apparent ordering.
//
// THE DANGEROUS FIX WOULD HAVE BEEN TO LOOSEN THE SCORER. These tests exist mostly to prove that
// did not happen: the strict verdict is byte-for-byte what it was, the sealed policy version is
// unchanged, and the semantic reading refuses everything a looser parse would have waved through.

import { describe, expect, it } from 'vitest';
import { parseJSONObject, parseJSONObjectAfterSingleFence, unwrapSingleJSONFence } from '../../src/core/json';
import { structuredSchemaEvaluator, structuredSchemaSemanticEvaluator } from '../../src/core/evaluators';
import { policyCatalog } from '../../src/core/catalog';
import { EvaluationEngine } from '../../src/core/engine';
import { attemptRecordForScoring } from '../../src/engine/scoring';
import { jsonShapeV2 } from '../../src/core/foundation';
import { adjudicateJSONViews, explainDivergence } from '../../src/engine/json-views';
import { buildEngineCatalogue } from '../../src/engine/catalogue';
import { CatalogueScorer } from '../../src/engine/scoring';
import { PlanSlot } from '../../src/engine/ledger';
import { rankCandidates } from '../../src/engine/ranking';
import { PASS06_CAPTURED } from './fixtures/pass06-captured';

// MARK: - The fence rule

describe('exactly one enclosing fence, and nothing outside it', () => {
  it('removes a well-formed ```json fence, and says it did', () => {
    const unwrap = unwrapSingleJSONFence('```json\n{"answer": "blue"}\n```');
    expect(unwrap.fenceRemoved).toBe(true);
    expect(unwrap.text).toBe('{"answer": "blue"}');
    expect(unwrap.infoString).toBe('json');
    expect(unwrap.refusedBecause).toBeUndefined();
  });

  it('removes a bare ``` fence and a ~~~ fence, and a multi-line body', () => {
    expect(unwrapSingleJSONFence('```\n{"a":1}\n```').text).toBe('{"a":1}');
    expect(unwrapSingleJSONFence('~~~json\n{"a":1}\n~~~').text).toBe('{"a":1}');
    expect(unwrapSingleJSONFence('```json\n{\n  "answer": "blue"\n}\n```').text).toBe('{\n  "answer": "blue"\n}');
  });

  it('leaves bare JSON exactly as it found it, and refuses nothing', () => {
    const unwrap = unwrapSingleJSONFence('{"answer":"blue"}');
    expect(unwrap.fenceRemoved).toBe(false);
    expect(unwrap.text).toBe('{"answer":"blue"}');
    expect(unwrap.refusedBecause).toBeUndefined();
  });

  it('REFUSES commentary before the fence', () => {
    const unwrap = unwrapSingleJSONFence('Here is the object you asked for:\n```json\n{"answer":"blue"}\n```');
    expect(unwrap.fenceRemoved).toBe(false);
    expect(unwrap.refusedBecause).toMatch(/before the opening fence/);
  });

  it('REFUSES commentary after the fence', () => {
    const unwrap = unwrapSingleJSONFence('```json\n{"answer":"blue"}\n```\nLet me know if you need another colour.');
    expect(unwrap.fenceRemoved).toBe(false);
    expect(unwrap.refusedBecause).toMatch(/after the closing fence/);
  });

  it('REFUSES two fences, because content between them is commentary', () => {
    const unwrap = unwrapSingleJSONFence('```json\n{"answer":"blue"}\n```\nand also\n```json\n{"answer":"teal"}\n```');
    expect(unwrap.fenceRemoved).toBe(false);
    expect(unwrap.refusedBecause).toMatch(/only a single enclosing fence/);
  });

  it('REFUSES an unclosed fence', () => {
    const unwrap = unwrapSingleJSONFence('```json\n{"answer":"blue"}');
    expect(unwrap.fenceRemoved).toBe(false);
    expect(unwrap.refusedBecause).toMatch(/never closes it/);
  });

  it('REFUSES a closing line that carries other content', () => {
    const unwrap = unwrapSingleJSONFence('```json\n{"answer":"blue"}\n``` done');
    expect(unwrap.fenceRemoved).toBe(false);
    expect(unwrap.refusedBecause).toMatch(/carries other content/);
  });

  it('does not make malformed JSON parseable by unwrapping it', () => {
    const { object, unwrap } = parseJSONObjectAfterSingleFence('```json\n{"answer": blue,}\n```');
    expect(unwrap.fenceRemoved).toBe(true);
    expect(object).toBeUndefined();
  });

  it('does not accept a top-level array or scalar, in either reading', () => {
    expect(parseJSONObjectAfterSingleFence('```json\n[1,2]\n```').object).toBeUndefined();
    expect(parseJSONObjectAfterSingleFence('```json\n"blue"\n```').object).toBeUndefined();
    expect(parseJSONObject('[1,2]')).toBeUndefined();
  });
});

// MARK: - The two evaluators, side by side

const SLOT_FOR_POLICY: PlanSlot = {
  slotIndex: 0, slotKey: 'c|suite.model-lab.foundation-v2|1|case:foundation-v2:json-shape',
  candidate: 'c', modelID: 'm', suite: 'suite.model-lab.foundation-v2', block: 'b', pass: 1,
  caseID: 'case:foundation-v2:json-shape', caseDigest: 'd', comparabilityKey: 'k',
  scoringMode: 'deterministic', maxOutputTokens: 1_024, inputBudgetTokens: 4_096, status: 'planned',
};

// The LEAF policy that actually judges `json-shape`, resolved through the engine's own delegation —
// the same resolution the adjudicator uses. Naming the leaf policy by hand here would be a test
// asserting against a policy the engine might not route to.
const POLICY = new EvaluationEngine(policyCatalog, () => new Date())
  .leafPolicyFor(attemptRecordForScoring(jsonShapeV2, SLOT_FOR_POLICY, ''));

function observationOf(text: string) {
  return {
    outputText: text,
    structuredOutputRaw: text,
    toolCallObservationsRaw: [] as string[],
    terminalStatus: 'completed' as const,
    providerReportedUsage: { unavailableReason: 'not needed' },
    timing: { totalElapsedMilliseconds: { unavailableReason: 'x' }, firstTokenMilliseconds: { unavailableReason: 'x' } },
    warnings: [] as never[],
    errors: [] as never[],
    identityVerification: { state: 'unverifiable' as const, reason: 'x' },
    runtimeConfigurationID: '',
    requestDigest: '',
  };
}

describe('the strict evaluator is UNCHANGED', () => {
  it('still fails a fenced object — the frozen behaviour, preserved on purpose', () => {
    for (const fenced of [
      '```json\n{"answer": "cerulean"}\n```',
      '```json\n{"answer": "blue"}\n```',
      '```json\n{\n  "answer": "blue"\n}\n```',
    ]) {
      expect(structuredSchemaEvaluator.evaluate(observationOf(fenced), 'json', POLICY).status).toBe('fail');
    }
  });

  it('still passes bare JSON with the required key', () => {
    expect(structuredSchemaEvaluator.evaluate(observationOf('{"answer": "blue"}'), 'json', POLICY).status).toBe('pass');
    expect(structuredSchemaEvaluator.evaluate(observationOf('{"answer":"blue"}'), 'json', POLICY).status).toBe('pass');
  });

  it('keeps its own evaluator id and version, so nothing it scored has been re-versioned', () => {
    expect(structuredSchemaEvaluator.profile.evaluatorID).toBe('evaluator.structured-schema');
    expect(structuredSchemaEvaluator.profile.version).toBe('1');
  });
});

describe('the semantic evaluator passes the fence and refuses everything else', () => {
  const semantic = (text: string) => structuredSchemaSemanticEvaluator.evaluate(observationOf(text), 'json', POLICY);

  it('passes a correct object inside one fence, and SAYS the fence was removed', () => {
    const verdict = semantic('```json\n{"answer": "blue"}\n```');
    expect(verdict.status).toBe('pass');
    expect(verdict.metrics.map((m) => m.detail).join(' ')).toMatch(/one enclosing.*fence was removed/);
    // And it says what a pass does NOT assert, on the verdict itself.
    expect(verdict.metrics.map((m) => m.detail).join(' ')).toMatch(/NOT a claim that the values are correct/);
  });

  it('REFUSES commentary outside the fence', () => {
    expect(semantic('Sure!\n```json\n{"answer":"blue"}\n```').status).toBe('fail');
    expect(semantic('```json\n{"answer":"blue"}\n```\nHope that helps.').status).toBe('fail');
  });

  it('REFUSES malformed JSON, fenced or bare', () => {
    expect(semantic('```json\n{"answer": blue}\n```').status).toBe('fail');
    expect(semantic('{"answer": blue}').status).toBe('fail');
    expect(semantic('not json at all').status).toBe('fail');
  });

  it('REFUSES a missing required key', () => {
    expect(semantic('```json\n{"colour":"blue"}\n```').status).toBe('fail');
    expect(semantic('{"colour":"blue"}').status).toBe('fail');
  });

  it('REFUSES a key present with nothing under it — a hollow object is not an answer', () => {
    for (const hollow of ['{"answer": null}', '{"answer": ""}', '{"answer": "   "}', '{"answer": []}', '{"answer": {}}']) {
      const verdict = semantic(hollow);
      expect(verdict.status).toBe('fail');
      expect(verdict.metrics.map((m) => m.detail).join(' ')).toMatch(/present but empty/);
    }
    expect(semantic('```json\n{"answer": null}\n```').status).toBe('fail');
  });

  it('is NOT reachable through the evaluator registry, so no policy can select it by accident', async () => {
    const { evaluatorByID, leafEvaluators } = await import('../../src/core/evaluators');
    expect(evaluatorByID('evaluator.structured-schema-semantic')).toBeUndefined();
    expect(leafEvaluators.map((e) => e.profile.evaluatorID)).not.toContain('evaluator.structured-schema-semantic');
  });
});

// MARK: - Both views, adjudicated together

const SLOT = SLOT_FOR_POLICY;

describe('adjudicating both views at once', () => {
  it('records the strict FAILURE and the semantic pass, and marks the divergence', () => {
    const views = adjudicateJSONViews({
      benchmarkCase: jsonShapeV2, slot: SLOT, answerText: '```json\n{"answer": "blue"}\n```', strictStatus: 'fail',
    })!;
    expect(views.strictTransportStatus).toBe('fail');
    expect(views.semanticSchemaStatus).toBe('pass');
    expect(views.fenceRemoved).toBe(true);
    expect(views.fenceInfoString).toBe('json');
    expect(views.divergent).toBe(true);
    expect(views.divergenceExplanation).toMatch(/The strict failure stands as the campaign result/);
  });

  it('marks NO divergence when the answer was bare', () => {
    const views = adjudicateJSONViews({
      benchmarkCase: jsonShapeV2, slot: SLOT, answerText: '{"answer":"blue"}', strictStatus: 'pass',
    })!;
    expect(views.strictTransportStatus).toBe('pass');
    expect(views.semanticSchemaStatus).toBe('pass');
    expect(views.fenceRemoved).toBe(false);
    expect(views.divergent).toBe(false);
  });

  it('agrees with strict on genuinely wrong output, so nothing is rescued by the second reading', () => {
    const views = adjudicateJSONViews({
      benchmarkCase: jsonShapeV2, slot: SLOT, answerText: 'The colour is blue.', strictStatus: 'fail',
    })!;
    expect(views.semanticSchemaStatus).toBe('fail');
    expect(views.divergent).toBe(false);
  });

  it('produces NOTHING for a case that declares no JSON format', async () => {
    const { echoInstructionV2 } = await import('../../src/core/foundation');
    expect(adjudicateJSONViews({
      benchmarkCase: echoInstructionV2, slot: SLOT, answerText: 'pond', strictStatus: 'pass',
    })).toBeUndefined();
  });

  it('SHOUTS when the strict parse passed something the schema reading rejects', () => {
    // The direction that would mean a defect in the strict path rather than a fence convention.
    expect(explainDivergence('pass', 'fail', false)).toMatch(/defect in the strict path/);
    expect(explainDivergence('pass', 'fail', false)).toMatch(/Do not use either result/);
  });
});

describe('the scorer returns both, and the strict one is still the status', () => {
  it('scores a fenced answer as fail, and hands back the semantic pass beside it', async () => {
    const scorer = new CatalogueScorer(buildEngineCatalogue(['suite.model-lab.foundation-v2'], 1), () => new Date('2026-09-14T12:00:00Z'));
    const scored = await scorer.score(SLOT, '```json\n{"answer": "blue"}\n```');
    expect(scored.status).toBe('fail');
    expect(scored.jsonViews?.semanticSchemaStatus).toBe('pass');
    expect(scored.jsonViews?.divergent).toBe(true);
  });

  it('leaves jsonViews undefined for a plain-prose case', async () => {
    const scorer = new CatalogueScorer(buildEngineCatalogue(['suite.model-lab.foundation-v2'], 1));
    const scored = await scorer.score(
      { ...SLOT, caseID: 'case:foundation-v2:echo-instruction', slotKey: 'c|suite.model-lab.foundation-v2|1|case:foundation-v2:echo-instruction' },
      'pond');
    expect(scored.status).toBe('pass');
    expect(scored.jsonViews).toBeUndefined();
  });
});

// MARK: - Two rankings over the same rows

describe('ranking the same outcomes twice', () => {
  const outcomes = [
    { candidate: 'fenced', caseID: 'case:foundation-v2:json-shape', dimension: 'structuredOutputReliability' as const,
      status: 'fail', semanticStatus: 'pass', viewsDivergent: true, governanceViolated: false },
    { candidate: 'bare', caseID: 'case:foundation-v2:json-shape', dimension: 'structuredOutputReliability' as const,
      status: 'pass', semanticStatus: 'pass', viewsDivergent: false, governanceViolated: false },
  ];
  const inputs = { outcomes, derivedAt: '2026-09-14T12:00:00Z' };

  it('ranks the fenced candidate LAST on the strict view and level on the semantic one', () => {
    const strict = rankCandidates({ ...inputs, view: 'strictTransport' });
    expect(strict.view).toBe('strictTransport');
    // A measured ZERO, not an absence: the outcome was scored, and it failed.
    const fenced = strict.rankings.find((r) => r.candidate === 'fenced')!;
    expect(fenced.overallPassRateMilli).toEqual({ measured: 0 });
    expect(fenced.rank).toBe(2);
    expect(strict.rankings.find((r) => r.candidate === 'bare')!.rank).toBe(1);
    const semantic = rankCandidates({ ...inputs, view: 'semanticSchema' });
    expect(semantic.view).toBe('semanticSchema');
    for (const ranking of semantic.rankings) {
      expect('measured' in ranking.overallPassRateMilli ? ranking.overallPassRateMilli.measured : -1).toBe(1_000);
    }
  });

  it('lists the divergence on BOTH tables, so neither can be read without it', () => {
    for (const view of ['strictTransport', 'semanticSchema'] as const) {
      const table = rankCandidates({ ...inputs, view });
      expect(table.divergences).toHaveLength(1);
      expect(table.divergences[0]).toMatchObject({ candidate: 'fenced', strict: 'fail', semantic: 'pass' });
    }
  });

  it('defaults to the STRICT view, so a caller written before Pass 7 gets the frozen table', () => {
    expect(rankCandidates(inputs).view).toBe('strictTransport');
  });

  it('reuses the recorded status on the semantic view when a row has no second reading', () => {
    // A plain-prose case, and every row written before Pass 7. Absent must not read as unmeasured.
    const prose = rankCandidates({
      outcomes: [{ candidate: 'a', caseID: 'case:foundation-v2:echo-instruction', dimension: 'conversation' as const,
        status: 'pass', governanceViolated: false }],
      derivedAt: 'now', view: 'semanticSchema',
    });
    expect('measured' in prose.rankings[0].overallPassRateMilli ? prose.rankings[0].overallPassRateMilli.measured : -1).toBe(1_000);
    expect(prose.divergences).toHaveLength(0);
  });
});

// MARK: - The sealed Pass 6 answers, re-read offline

describe('the 12 captured Pass 6 json-shape answers, under both views', () => {
  const jsonRows = PASS06_CAPTURED.filter((a) => a.caseID === 'case:foundation-v2:json-shape');

  it('re-reads all twelve, and every one of them is semantically correct', () => {
    expect(jsonRows).toHaveLength(12);
    for (const row of jsonRows) {
      const views = adjudicateJSONViews({
        benchmarkCase: jsonShapeV2, slot: { ...SLOT, candidate: row.candidate },
        answerText: row.answerText, strictStatus: row.status as never,
      })!;
      expect(views.semanticSchemaStatus).toBe('pass');
      // And the strict reading reproduces exactly what Pass 6 recorded — the sealed result stands.
      expect(views.strictTransportStatus).toBe(row.status);
    }
  });

  it('finds the four divergences, and they are all fences', () => {
    const divergent = jsonRows.filter((row) => adjudicateJSONViews({
      benchmarkCase: jsonShapeV2, slot: { ...SLOT, candidate: row.candidate },
      answerText: row.answerText, strictStatus: row.status as never,
    })!.divergent);
    expect(divergent).toHaveLength(4);
    expect(divergent.map((row) => row.candidate).sort()).toEqual([
      'claudeCLI:claude-fable-5-1@high',
      'claudeCLI:claude-haiku-4-5',
      'claudeCLI:claude-opus-5',
      'claudeCLI:claude-sonnet-5@max',
    ]);
    for (const row of divergent) expect(unwrapSingleJSONFence(row.answerText).fenceRemoved).toBe(true);
  });
});
