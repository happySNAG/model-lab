// Cernum development benchmark · scoring contract 2 — the terminal-object reading.
//
// No model runs here. What is proven: the one shape contract 2 newly accepts (prose, then exactly one
// JSON object ending the reply) is accepted deterministically and still recorded as non-compliant;
// every looser shape is refused with a reason; an object of the wrong shape is refused on every
// reading; a wrong answer read this way still fails the metric it should; contract 1's reading is
// reproducible unchanged; and a sealed campaign can be re-read under contract 2 without a byte of it
// moving.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { developmentTaskByID, developmentSuites } from '../../src/core/development-catalog';
import { developmentComparabilityKey, developmentTaskDigest, DevelopmentTask } from '../../src/core/development-benchmark';
import { gradeRepositoryQuestion, readAnswer } from '../../src/core/development-evaluation';
import { ledgerlite } from '../../src/core/development-fixtures/ledgerlite';
import { DEVELOPMENT_SCORING_CONTRACT_VERSION, developmentContractDigest } from '../../src/core/development-scoring';
import { answerShapeViolations, extractTerminalJSONObject, matchingObjectEnd } from '../../src/core/json';
import {
  DEVELOPMENT_ARTEFACTS_DIRECTORY, DEVELOPMENT_PLAN_FILE, DevelopmentCampaignError, contractVersionRefusal,
  createDevelopmentCampaign, developmentArtefactFileName, openDevelopmentCampaign, runDevelopmentCampaign,
} from '../../src/engine/development-campaign';
import { DevelopmentCampaignPlan, buildDevelopmentPlan } from '../../src/engine/development-plan';
import {
  answerFormatOf, buildDevelopmentCampaignReport, describeDevelopmentCampaignReport, readDevelopmentCampaignState,
} from '../../src/engine/development-report';
import {
  DEVELOPMENT_REINTERPRETATIONS_DIRECTORY, contract1EquivalentTask, reinterpretDevelopmentCampaign,
} from '../../src/engine/development-reinterpretation';
import { FrontierAdapter, FrontierRequest, FrontierResponse } from '../../src/engine/frontier-adapter';
import { DEFAULT_RETRY } from '../../src/engine/provider';
import { CORRECT_ANSWERS } from './fixtures/ledgerlite-solutions';

const TRACE = 'task.dev.repo-understanding.trace-flow';
const TESTS = 'task.dev.repo-understanding.relevant-tests';
const BUG = 'task.dev.repo-understanding.explain-bug';
const ABSENT = 'task.dev.repo-understanding.absent-feature';
const SOURCE = 'task.dev.repo-understanding.source-of-truth';

// Three replies `dev-cohort-2` recorded from claude-sonnet-5@high, verbatim. Each scored zero under
// contract 1 because of the sentence before the object.
const RECORDED_TRACE = 'Confirmed this is just a field list, excluded per the criteria.\n\n'
  + '{"files": ["src/index.js", "src/api/charges.js", "src/core/charge-pipeline.js", "src/core/stages/validate.js", '
  + '"src/core/stages/tax.js", "src/core/stages/round.js", "src/util/money.js"]}';
const RECORDED_FENCED_TESTS = 'Confirmed. This matches the documented convention entirely.\n\n```json\n'
  + '{"caseFile": "test/cases/rounding.cases.json", "testModule": "test/money.test.js", "otherTestsAffected": []}\n```';
const RECORDED_BUG = '`rates.json` declares `"roundingMode": "halfUp"`, confirming the intended semantics (round half '
  + 'away from zero, symmetric for both signs) that `roundHalfUp` fails to implement for negative values.\n\n'
  + '{"file": "src/util/money.js", "symbol": "roundHalfUp", "cause": "roundHalfUp delegates to Math.round, which breaks '
  + 'ties toward positive infinity rather than away from zero, so a negative amount exactly on a half-minor-unit boundary '
  + 'rounds toward zero instead of away from it.", "evidence": ["src/util/money.js", "src/core/stages/round.js", '
  + '"src/config/rates.json", "test/cases/rounding.cases.json", "test/money.test.js"]}';

function task(id: string): DevelopmentTask {
  return developmentTaskByID(id)!;
}

function grade(id: string, text: string, contractVersion?: string) {
  const current = task(id);
  const sealed = contractVersion === '1' ? contract1EquivalentTask(current) : current;
  return gradeRepositoryQuestion(sealed, ledgerlite, text,
    { taskDigest: developmentTaskDigest(sealed), comparabilityKey: developmentComparabilityKey(sealed) },
    { contractVersion });
}

const failed = (result: ReturnType<typeof grade>) =>
  result.outcomes.filter((outcome) => !outcome.held).map((outcome) => outcome.id).sort();
const failedMetrics = (result: ReturnType<typeof grade>) =>
  result.grade.metrics.filter((metric) => metric.status === 'fail').map((metric) => metric.id).sort();
const correct = (id: string) => JSON.stringify(CORRECT_ANSWERS[id]);

// MARK: - The extractor

describe('extracting the one terminal JSON object', () => {
  it('finds an object that ends the reply after prose, and says how much prose came first', () => {
    const extraction = extractTerminalJSONObject('I checked.\n\n{"a": 1}');
    expect(extraction).toMatchObject({ extracted: true, fenced: false, text: '{"a": 1}', prefixLength: 10 });
    expect(extraction.object).toEqual({ a: 1 });
    expect(extraction.refusedBecause).toBeUndefined();
  });

  it('reads a pretty-printed object with nested objects and arrays as one object', () => {
    const body = JSON.stringify({ a: [{ b: 1 }, { c: { d: [] } }], e: 'x' }, null, 2);
    const extraction = extractTerminalJSONObject(`Done.\n${body}`);
    expect(extraction.extracted).toBe(true);
    expect(extraction.object).toEqual({ a: [{ b: 1 }, { c: { d: [] } }], e: 'x' });
  });

  it('treats braces and quotes inside JSON strings as text, not structure', () => {
    const body = '{"cause": "calls round({x}) and then } closes \\"nothing\\""}';
    expect(matchingObjectEnd(body, 0)).toBe(body.length - 1);
    expect(extractTerminalJSONObject(`Note.\n${body}`).object).toEqual({ cause: 'calls round({x}) and then } closes "nothing"' });
  });

  it('reads a terminal object in the reply\'s only fence', () => {
    const extraction = extractTerminalJSONObject('Here it is.\n```json\n{"a": 1}\n```');
    expect(extraction).toMatchObject({ extracted: true, fenced: true, text: '{"a": 1}' });
  });

  it('refuses text after the object', () => {
    expect(extractTerminalJSONObject('{"a": 1}\n\nHope that helps!').refusedBecause).toMatch(/does not end with a JSON object/);
    expect(extractTerminalJSONObject('Intro.\n```json\n{"a": 1}\n```\nThanks').refusedBecause).toMatch(/text follows the fenced block/);
    expect(extractTerminalJSONObject('{"a": 1} ok').extracted).toBe(false);
  });

  it('refuses a second JSON object anywhere before the terminal one, rather than choosing', () => {
    expect(extractTerminalJSONObject('{"a": 1}\n{"a": 2}').refusedBecause).toMatch(/1 other JSON object/);
    expect(extractTerminalJSONObject('The config says {"mode": "halfUp"}, so:\n{"a": 2}').refusedBecause).toMatch(/ambiguous/);
    // Prose braces that are not JSON are not a competing answer.
    expect(extractTerminalJSONObject('Uses {x} and {y: 1} internally.\n{"a": 2}').extracted).toBe(true);
  });

  it('refuses a malformed terminal object, and repairs nothing', () => {
    expect(extractTerminalJSONObject("Answer:\n{file: 'src/util/money.js'}").refusedBecause).toMatch(/not valid JSON/);
    expect(extractTerminalJSONObject('Answer:\n{"a": 1,}').refusedBecause).toMatch(/not valid JSON/);
    expect(extractTerminalJSONObject('Answer:\n```json\n{"a": 1,}\n```').extracted).toBe(false);
  });

  it('refuses an object that does not begin a line, a stray fence, and more than one fenced block', () => {
    expect(extractTerminalJSONObject('The answer is {"a": 1}').refusedBecause).toMatch(/no object beginning a line/);
    expect(extractTerminalJSONObject('```\nnote\n```\n{"a": 1}').refusedBecause).toMatch(/text follows the fenced block|fence line/);
    expect(extractTerminalJSONObject('```json\n{"a": 1}\n```\n```json\n{"a": 2}\n```').refusedBecause).toMatch(/4 fence line/);
    expect(extractTerminalJSONObject('Two in one fence:\n```json\n{"a": 1}\n{"a": 2}\n```').refusedBecause).toMatch(/not exactly one JSON object/);
  });

  it('refuses an array, an empty reply and a reply with no object at all', () => {
    expect(extractTerminalJSONObject('Here:\n[1, 2]').extracted).toBe(false);
    expect(extractTerminalJSONObject('   ').refusedBecause).toMatch(/empty/);
    expect(extractTerminalJSONObject('no json here').extracted).toBe(false);
  });

  it('is deterministic: the same reply always extracts the same bytes', () => {
    const results = new Set(Array.from({ length: 5 }, () => JSON.stringify(extractTerminalJSONObject(RECORDED_BUG))));
    expect(results.size).toBe(1);
  });
});

describe('the declared answer shape', () => {
  it('names each missing key, unexpected key and wrong type', () => {
    const shape = { file: 'string', present: 'boolean', files: 'stringArray' } as const;
    expect(answerShapeViolations({ file: 'a', present: false, files: ['x'] }, shape)).toEqual([]);
    expect(answerShapeViolations({ file: 'a', present: 'false', files: ['x', 1], extra: 1 }, shape)).toEqual([
      'key "files" is not a list of strings', 'key "present" is not a boolean', 'unexpected key "extra"',
    ]);
    expect(answerShapeViolations({ present: false, files: [] }, shape)).toEqual(['missing key "file"']);
  });

  it('is declared on every repository-understanding task and accepts that task\'s correct answer', () => {
    const questions = developmentSuites.flatMap((suite) => suite.tasks).filter((entry) => entry.kind === 'repositoryQuestion');
    expect(questions).toHaveLength(7);
    for (const question of questions) {
      expect(question.answerShape, question.id).toBeDefined();
      expect(answerShapeViolations(CORRECT_ANSWERS[question.id] as Record<string, unknown>, question.answerShape!), question.id).toEqual([]);
    }
  });
});

// MARK: - Grading under contract 2

describe('reading an answer under contract 2', () => {
  it('reads a JSON-only reply strictly, extracts nothing, and records it as compliant', () => {
    const result = grade(SOURCE, correct(SOURCE));
    expect(result.answer).toMatchObject({
      strictlyParsed: true, semanticallyParsed: true, reading: 'strict', terminalObjectExtracted: false,
      shapeValid: true, rules: 'strictSingleFenceOrTerminalObject',
    });
    expect(result.grade.credit).toBe('full');
  });

  it('grades prose followed by one correct terminal object as correct, and records strictlyParsed = false', () => {
    const result = grade(TRACE, RECORDED_TRACE);
    expect(result.answer).toMatchObject({
      strictlyParsed: false, semanticallyParsed: true, reading: 'terminalObject', terminalObjectExtracted: true, shapeValid: true,
    });
    expect(failed(result)).toEqual([]);
    expect(result.grade.credit).toBe('full');
  });

  it('reads the fenced object that follows prose, which contract 1 refused', () => {
    const result = grade(TESTS, RECORDED_FENCED_TESTS);
    expect(result.answer).toMatchObject({ strictlyParsed: false, fenceRemoved: false, reading: 'terminalObject', terminalObjectExtracted: true });
    expect(result.grade.credit).toBe('full');
    // A reply that IS one fence is still the single-fence reading, as it was under contract 1.
    const fencedOnly = grade(TESTS, '```json\n' + correct(TESTS) + '\n```');
    expect(fencedOnly.answer).toMatchObject({ reading: 'singleFence', fenceRemoved: true, terminalObjectExtracted: false });
  });

  it('still fails a semantically wrong answer read this way, on the metric the mistake belongs to', () => {
    // dev-cohort-2's explain-bug reply: right diagnosis, but the rate table cited as evidence.
    const result = grade(BUG, RECORDED_BUG);
    expect(result.answer!.reading).toBe('terminalObject');
    expect(failed(result)).toEqual(['bug.evidence-not-rates']);
    expect(failedMetrics(result)).toEqual(['irrelevantFileRestraint']);
    expect(result.grade.credit).toBe('partial');

    const invented = grade(ABSENT, 'Found it.\n{"present": true, "files": ["src/util/money.js"]}');
    expect(invented.answer!.reading).toBe('terminalObject');
    expect(failed(invented)).toEqual(['absent.no-files', 'absent.present']);
  });

  it('refuses prose after the object, and grades it as the unreadable reply it is', () => {
    const result = grade(ABSENT, '{"present": false, "files": []}\n\nI could not write the file, but that is the answer.');
    expect(result.answer).toMatchObject({ strictlyParsed: false, semanticallyParsed: false, reading: 'none', terminalObjectExtracted: false });
    expect(result.answer!.terminalExtractionRefusedBecause).toMatch(/does not end with a JSON object/);
    expect(result.grade.credit).toBe('none');
  });

  it('refuses two candidate objects rather than grading either', () => {
    const result = grade(ABSENT, '{"present": true, "files": ["src/util/money.js"]}\nOn reflection:\n{"present": false, "files": []}');
    expect(result.answer!.reading).toBe('none');
    expect(result.answer!.terminalExtractionRefusedBecause).toMatch(/ambiguous/);
    expect(result.grade.credit).toBe('none');
  });

  it('refuses a malformed terminal object', () => {
    const result = grade(ABSENT, 'Answer:\n{"present": false, "files": [],}');
    expect(result.answer!.reading).toBe('none');
    expect(result.answer!.terminalExtractionRefusedBecause).toMatch(/not valid JSON/);
    expect(result.grade.credit).toBe('none');
  });

  it('refuses an object of the wrong shape on every reading, and says so in every assertion', () => {
    for (const reply of [
      '{"present": false, "files": [], "note": "nothing converts currency"}', // strict, extra key
      'Checked.\n{"present": "false", "files": []}', //                        terminal, wrong type
      '```json\n{"files": []}\n```', //                                         fenced, missing key
    ]) {
      const result = grade(ABSENT, reply);
      expect(result.answer!.shapeValid, reply).toBe(false);
      expect(result.answer!.semanticallyParsed, reply).toBe(false);
      expect(result.answer!.reading, reply).toBe('none');
      expect(result.outcomes.every((outcome) => !outcome.held), reply).toBe(true);
      expect(result.outcomes[0].detail, reply).toMatch(/does not have the shape the task states/);
      expect(result.grade.credit, reply).toBe('none');
    }
    // The strict flag is still the transport fact: that first reply WAS pure JSON.
    expect(grade(ABSENT, '{"present": false, "files": [], "note": "x"}').answer!.strictlyParsed).toBe(true);
  });
});

describe('contract 1 is still reproducible exactly', () => {
  it('refuses the prose-then-object reply and checks no shape, as it always did', () => {
    const result = grade(TRACE, RECORDED_TRACE, '1');
    expect(result.answer).toMatchObject({
      strictlyParsed: false, semanticallyParsed: false, reading: 'none', rules: 'strictOrSingleFence',
      terminalObjectExtracted: false, shapeValid: undefined,
    });
    expect(result.grade.credit).toBe('none');
    expect(grade(ABSENT, '{"present": false, "files": [], "note": "x"}', '1').grade.credit).toBe('full');
  });

  it('refuses to guess the rules of a contract version it does not know', () => {
    expect(() => readAnswer('{}', { contractVersion: '9' })).toThrow(/no answer reading rules/);
  });
});

// MARK: - The row, the report, resume

const MACHINE = { machineIdentifier: 'test-machine', platform: 'darwin-arm64' };
const CLOCK = () => '2026-09-21T12:00:00Z';
const FIXED_NOW = () => new Date('2026-09-21T12:00:00Z');

function plan(): DevelopmentCampaignPlan {
  return buildDevelopmentPlan({
    label: 'answer-contract', repeats: 1,
    candidates: [{
      name: 'claudeCLI:model-a', provider: 'claudeCLI', modelID: 'model-a', effort: 'high',
      retry: { ...DEFAULT_RETRY, maxRetries: 0, backoffMilliseconds: 0 },
    }],
    benchmarkVersion: '0.2.4', createdAt: '2026-09-21T00:00:00Z', machine: MACHINE,
    benchmarkCommit: 'c'.repeat(40), workingTreeDirty: false,
    suiteIDs: ['suite.cernum.development.repo-understanding'],
  });
}

/** Prefaces every other correct answer with a sentence, the way dev-cohort-2's Sonnet did. */
function chattyAdapter(): FrontierAdapter {
  let call = 0;
  return {
    provider: 'claudeCLI',
    async complete(request: FrontierRequest): Promise<FrontierResponse> {
      const question = developmentSuites.flatMap((suite) => suite.tasks)
        .find((entry) => entry.kind === 'repositoryQuestion' && request.promptText.includes(entry.prompt.user))!;
      call += 1;
      const answer = JSON.stringify(CORRECT_ANSWERS[question.id]);
      return {
        answerText: call % 2 === 0 ? `Confirmed, that is the whole chain.\n\n${answer}` : answer,
        reportedModelID: '', usage: { inputTokens: 100, visibleOutputTokens: 20 }, usageProvenance: 'providerReported',
        totalElapsedMilliseconds: 7, retryCount: 0, wastedTokens: 0,
      };
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function campaign(): Promise<{ root: string; plan: DevelopmentCampaignPlan }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-development-answer-contract-test-'));
  roots.push(base);
  const root = path.join(base, 'campaign');
  const built = plan();
  createDevelopmentCampaign(root, built, CLOCK);
  const { ledger } = openDevelopmentCampaign(root, CLOCK, built.promptVersion);
  await runDevelopmentCampaign({ root, ledger, plan: built, adapters: { claudeCLI: chattyAdapter() }, now: FIXED_NOW, sleep: async () => undefined });
  return { root, plan: built };
}

describe('what a contract-2 row and report record', () => {
  it('writes the reading, the extraction and the shape verdict beside the strict flag on every answer row', async () => {
    const { root } = await campaign();
    const { rows } = readDevelopmentCampaignState(root);
    expect(rows).toHaveLength(7);
    const extracted = rows.filter((row) => row.answerReading === 'terminalObject');
    const strict = rows.filter((row) => row.answerReading === 'strict');
    expect(extracted).toHaveLength(3);
    expect(strict).toHaveLength(4);
    for (const row of extracted) {
      expect(row).toMatchObject({ answerStrictlyParsed: false, answerTerminalObjectExtracted: true, answerShapeValid: true, status: 'pass' });
    }
    for (const row of strict) expect(row).toMatchObject({ answerStrictlyParsed: true, answerTerminalObjectExtracted: false });
    for (const row of rows) {
      expect(row.contractVersion).toBe(DEVELOPMENT_SCORING_CONTRACT_VERSION);
      expect(row.answerReadingRules).toBe('strictSingleFenceOrTerminalObject');
    }
  });

  it('reports the strict compliance rate separately from the score', async () => {
    const { root, plan: built } = await campaign();
    const { rows } = readDevelopmentCampaignState(root);
    expect(answerFormatOf(rows)).toEqual({
      gradedAnswers: 7, strict: 4, singleFence: 0, terminalObject: 3, unread: 0, shapeRefused: 0, inferredFromLegacyColumns: 0,
    });
    const report = buildDevelopmentCampaignReport({ plan: built, rows, derivedAt: CLOCK() });
    const lines = describeDevelopmentCampaignReport(report).join('\n');
    expect(lines).toContain('answer format JSON-only (strict) 4/7 (57.1%) · single fence 0 · terminal object after prose 3 · unread 0');
    expect(lines).toContain(`contract          contract.cernum.development@${DEVELOPMENT_SCORING_CONTRACT_VERSION}`);
    expect(report.candidates[0].statusCounts.pass).toBe(7);
  });

  it('infers the reading of a contract-1 row from the parse flags it did record', () => {
    expect(answerFormatOf([
      { dimension: 'repositoryUnderstanding', measurementState: 'graded', answerStrictlyParsed: true },
      { dimension: 'repositoryUnderstanding', measurementState: 'graded', answerStrictlyParsed: false, answerSemanticallyParsed: true, answerFenceRemoved: true },
      { dimension: 'repositoryUnderstanding', measurementState: 'graded', answerStrictlyParsed: false, answerSemanticallyParsed: false },
      { dimension: 'multiFileEditing', measurementState: 'graded' },
    ])).toEqual({ gradedAnswers: 3, strict: 1, singleFence: 1, terminalObject: 0, unread: 1, shapeRefused: 0, inferredFromLegacyColumns: 3 });
  });

  it('refuses to resume a campaign graded under another contract version', () => {
    const built = plan();
    expect(contractVersionRefusal(built)).toBeUndefined();
    const old = { ...built, contractVersion: '1' };
    expect(contractVersionRefusal(old)).toMatch(/grade one campaign by two contracts/);
  });

  it('refuses at open, before anything runs, when the plan on disk names another contract', async () => {
    const { root } = await campaign();
    const file = path.join(root, DEVELOPMENT_PLAN_FILE);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), contractVersion: '1' }));
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(DevelopmentCampaignError);
    expect(() => openDevelopmentCampaign(root, CLOCK)).toThrow(/two contracts/);
  });
});

// MARK: - Reinterpretation

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every file a campaign holds, hashed, so "untouched" is a comparison. */
function hashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full); else out[path.relative(root, full)] = sha(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Rewrite a campaign as a contract-1 build recorded it: the same answers, graded by the task as it
 * was sealed then and by the reading rules of contract 1. This is what `dev-cohort-2` looks like.
 */
function asRecordedUnderContract1(root: string): void {
  const resultsFile = path.join(root, 'results.jsonl');
  const rows = fs.readFileSync(resultsFile, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const rewritten = rows.map((row) => {
    const artefact = JSON.parse(fs.readFileSync(path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY, developmentArtefactFileName(row.slotKey)), 'utf8'));
    const result = grade(row.taskID, artefact.answerText, '1');
    const credit = result.grade.credit;
    const {
      answerReadingRules: _a, answerReading: _b, answerTerminalObjectExtracted: _c,
      answerTerminalExtractionRefusedBecause: _d, answerShapeValid: _e, answerShapeViolations: _f, ...rest
    } = row;
    return {
      ...rest,
      status: credit === 'full' ? 'pass' : credit === 'partial' ? 'partial' : 'fail',
      contractVersion: '1', contractDigest: 'mldc1:cafc30af44a5f467',
      taskDigest: developmentTaskDigest(contract1EquivalentTask(task(row.taskID))),
      structuralCredit: result.grade.structuralCredit, credit,
      assertionOutcomes: result.outcomes.map((outcome) => ({ id: outcome.id, metric: outcome.metric, visibility: outcome.visibility,
        held: outcome.held, shortcutProbe: outcome.shortcutProbe, detail: outcome.detail })),
      answerStrictlyParsed: result.answer!.strictlyParsed,
      answerSemanticallyParsed: result.answer!.semanticallyParsed,
      answerFenceRemoved: result.answer!.fenceRemoved,
    };
  });
  fs.writeFileSync(resultsFile, rewritten.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const planFile = path.join(root, DEVELOPMENT_PLAN_FILE);
  fs.writeFileSync(planFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(planFile, 'utf8')), contractVersion: '1',
    contractDigest: 'mldc1:cafc30af44a5f467' }));
}

const REGRADE = { producedAt: '2026-09-22T09:00:00Z', benchmarkVersion: '0.2.4', benchmarkCommit: 'd'.repeat(40), workingTreeDirty: false };

describe('re-reading a contract-1 campaign under contract 2', () => {
  it('re-grades the recorded answers, moves exactly the prose-prefixed ones, and keeps strict compliance on record', async () => {
    const { root } = await campaign();
    asRecordedUnderContract1(root);
    const before = hashes(root);

    const { reinterpretation, writtenTo } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: true });

    expect(reinterpretation.original.contract).toBe('contract.cernum.development@1');
    expect(reinterpretation.regradedUnder).toMatchObject({
      contract: `contract.cernum.development@${DEVELOPMENT_SCORING_CONTRACT_VERSION}`, contractDigest: developmentContractDigest(),
      readingRules: 'strictSingleFenceOrTerminalObject', benchmarkCommit: 'd'.repeat(40),
    });
    expect(reinterpretation.reinterpretationID).toMatch(/^mldri1:[0-9a-f]{1,16}$/);
    expect(reinterpretation.rows).toHaveLength(7);
    for (const row of reinterpretation.rows) {
      expect(row.reproducedUnderOriginalContract).toBe(true);
      expect(row.answerKey.unchanged).toBe(true);
      expect(row.answerKey.originalContractEquivalentDigest).toBe(row.answerKey.recordedTaskDigest);
    }
    const moved = reinterpretation.rows.filter((row) => row.changed);
    expect(moved).toHaveLength(3);
    for (const row of moved) {
      expect(row.before).toMatchObject({ status: 'fail', strictlyParsed: false, reading: 'none' });
      expect(row.after).toMatchObject({ status: 'pass', strictlyParsed: false, reading: 'terminalObject', terminalObjectExtracted: true });
    }

    const [beforeSummary] = reinterpretation.summary.before;
    const [afterSummary] = reinterpretation.summary.after;
    expect(beforeSummary.repositoryUnderstanding.statusCounts).toEqual({ pass: 4, fail: 3 });
    expect(afterSummary.repositoryUnderstanding.statusCounts).toEqual({ pass: 7 });
    expect(beforeSummary.repositoryUnderstanding.answerFormat).toMatchObject({ strict: 4, terminalObject: 0, unread: 3 });
    expect(afterSummary.repositoryUnderstanding.answerFormat).toMatchObject({ strict: 4, terminalObject: 3, unread: 0 });
    expect(afterSummary.repositoryUnderstanding.tasksFullyCovered).toBe('7/7');
    expect(afterSummary.repositoryUnderstanding.repeatsGraded).toBe('7/7');

    // Beside the campaign, never over it: every original file is byte-for-byte what it was.
    expect(path.dirname(writtenTo!)).toBe(path.join(root, DEVELOPMENT_REINTERPRETATIONS_DIRECTORY));
    const after = hashes(root);
    for (const [file, hash] of Object.entries(before)) expect(after[file], file).toBe(hash);
    expect(Object.keys(after).filter((file) => !(file in before))).toEqual([path.relative(root, writtenTo!)]);
    expect(reinterpretation.original.resultsSha256).toBe(`sha256:${before['results.jsonl']}`);

    // And never twice under one identity.
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: true })).toThrow(/never overwritten/);
  });

  it('writes nothing on a dry run', async () => {
    const { root } = await campaign();
    asRecordedUnderContract1(root);
    const before = hashes(root);
    const { writtenTo } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false });
    expect(writtenTo).toBeUndefined();
    expect(hashes(root)).toEqual(before);
  });

  it('refuses, writing nothing, when a recorded answer no longer reproduces its recorded grade', async () => {
    const { root } = await campaign();
    asRecordedUnderContract1(root);
    const { rows } = readDevelopmentCampaignState(root);
    const passing = rows.find((row) => row.status === 'pass')!;
    const artefact = path.join(root, DEVELOPMENT_ARTEFACTS_DIRECTORY, developmentArtefactFileName(String(passing.slotKey)));
    fs.writeFileSync(artefact, JSON.stringify({ ...JSON.parse(fs.readFileSync(artefact, 'utf8')), answerText: 'tampered' }));
    const before = hashes(root);
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: true })).toThrow(/does not reproduce the recorded row/);
    expect(hashes(root)).toEqual(before);
  });

  it('refuses when a row was graded against a task this build no longer has', async () => {
    const { root } = await campaign();
    asRecordedUnderContract1(root);
    const resultsFile = path.join(root, 'results.jsonl');
    const lines = fs.readFileSync(resultsFile, 'utf8').trim().split('\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), taskDigest: 'mldt1:0000000000000000' });
    fs.writeFileSync(resultsFile, lines.join('\n') + '\n');
    expect(() => reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false })).toThrow(/task itself changed/);
  });

  it('reproduces a contract-2 campaign under contract 2 with nothing moving', async () => {
    const { root } = await campaign();
    const { reinterpretation } = reinterpretDevelopmentCampaign({ root, ...REGRADE, write: false });
    expect(reinterpretation.rows.filter((row) => row.changed)).toEqual([]);
  });
});
