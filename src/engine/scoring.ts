// Benchmark engine · scoring an answer, without caring who produced it.
//
// This was inside the live Ollama host, which was fine while a local runtime was the only thing that
// could produce an answer. It is not fine now: a campaign with no local candidate at all must still
// be scored, and it must be scored by THE SAME RULES — not by a second implementation that agrees
// today and drifts next quarter.
//
// So the scorer is here, provider-blind by construction. It is handed a case and a string. It has no
// way to know whether that string came from weights on this machine, a subscription CLI or a metered
// API, which is exactly the property that makes a cross-provider comparison mean anything: a model
// cannot be scored more generously for being expensive.

import { BenchmarkCase } from '../core/benchmark';
import { EvaluationEngine } from '../core/engine';
import { policyCatalog } from '../core/catalog';
import { isViolation } from '../core/evaluation';
import { makeCandidate, measured, unavailable } from '../core/candidate';
import { PlanSlot, TerminalSlotStatus } from './ledger';
import { EngineCatalogue } from './catalogue';
import { sha256Text } from './canonical';
import { JSONViewAdjudication, adjudicateJSONViews } from './json-views';

/** The core's evaluator wants an attempt record; this is the smallest honest one. */
export function attemptRecordForScoring(benchmarkCase: BenchmarkCase, slot: PlanSlot, answerText: string) {
  return {
    attemptID: `attempt:${sha256Text(slot.slotKey).slice(0, 16)}`,
    runID: slot.slotKey,
    ordinal: slot.slotIndex,
    repetitionIndex: slot.pass - 1,
    candidate: makeCandidate({
      id: { raw: slot.candidate },
      displayName: slot.candidate,
      // Deliberately constant, and deliberately not the real provider. The evaluator must not be
      // able to see who answered: a scorer that could would be a scorer that could be biased.
      provider: 'ollama',
      exactModelIdentity: slot.modelID,
      artifactDigest: slot.caseDigest ? measured(slot.caseDigest) : unavailable('the runtime reported no artifact digest'),
      executionClass: 'localHostProcess',
      quantization: '',
      declaredContextLimitTokens: unavailable('not needed to score an answer from its text'),
      inputModalities: ['text'],
      outputModalities: ['text'],
      streaming: 'unknown',
      structuredOutput: 'declared',
      toolCalls: 'unknown',
      runtimeConfiguration: { settings: [] },
      reproducibility: 'bestEffort',
      privacyClass: 'onDeviceOnly',
      availability: { state: 'available' },
    }),
    candidateDigest: '',
    suiteID: benchmarkCase.suiteID,
    suiteVersion: benchmarkCase.suiteVersion,
    caseID: benchmarkCase.id,
    caseDigest: slot.caseDigest,
    inputPackage: benchmarkCase.inputs,
    inputPackageDigest: '',
    scoringPolicyID: benchmarkCase.scoringPolicyID,
    scoringPolicyVersion: benchmarkCase.scoringPolicyVersion,
    environment: { capturedAt: '', machineIdentifier: { unavailableReason: 'not captured for scoring' }, hardwareModel: { unavailableReason: 'not captured for scoring' },
      cpuCoreCount: { unavailableReason: 'not captured for scoring' }, physicalMemoryBytes: { unavailableReason: 'not captured for scoring' },
      osVersion: { unavailableReason: 'not captured for scoring' }, inferenceRuntimeVersion: { unavailableReason: 'not captured for scoring' } },
    observation: {
      outputText: answerText,
      structuredOutputRaw: benchmarkCase.responseFormat === 'json' ? answerText : undefined,
      toolCallObservationsRaw: [],
      terminalStatus: 'completed' as const,
      providerReportedUsage: { unavailableReason: 'scored from text alone' },
      timing: { totalElapsedMilliseconds: { unavailableReason: 'scored from text alone' }, firstTokenMilliseconds: { unavailableReason: 'scored from text alone' } },
      warnings: [], errors: [],
      identityVerification: { state: 'unverifiable' as const, reason: 'identity is verified by the engine, not the evaluator' },
      runtimeConfigurationID: '', requestDigest: '',
    },
    terminalStatus: 'completed' as const,
    comparabilityKey: slot.comparabilityKey,
    startedAt: '', finishedAt: '',
  };
}

export function terminalStatusFor(status: string): TerminalSlotStatus {
  switch (status) {
    case 'pass': return 'pass';
    case 'partial': return 'partial';
    case 'fail': return 'fail';
    case 'requiresHumanReview': return 'requiresHumanReview';
    case 'notApplicable': return 'unsupported';
    default: return 'fail';
  }
}

/** One scorer, shared by every host. Construct it once per campaign; it holds no per-attempt state. */
export class CatalogueScorer {
  private readonly engine: EvaluationEngine;

  private readonly now: () => Date;

  constructor(private readonly catalogue: EngineCatalogue, now: () => Date = () => new Date()) {
    this.now = now;
    this.engine = new EvaluationEngine(policyCatalog, now);
  }

  async score(slot: PlanSlot, answerText: string): Promise<{
    status: TerminalSlotStatus; governanceViolated: boolean; detail: string;
    /** The second reading, on a JSON case only. Never substituted for `status`. */
    jsonViews?: JSONViewAdjudication;
  }> {
    const benchmarkCase = this.catalogue.cases.get(slot.caseID);
    if (!benchmarkCase) return { status: 'unsupported', governanceViolated: false, detail: `case ${slot.caseID} is not in the catalogue` };
    const verdict = this.engine.evaluate(attemptRecordForScoring(benchmarkCase, slot, answerText));
    // THE STRICT VERDICT, UNCHANGED. Same evaluator, same sealed policy, same version — so a row
    // scored after this change is still comparable with every row Pass 6 measured.
    const status = terminalStatusFor(verdict.verdict.status);
    return {
      status,
      governanceViolated: isViolation(verdict.verdict.governance),
      detail: verdict.verdict.disqualificationReason
        ?? (verdict.verdict.metrics.map((metric) => metric.detail).filter(Boolean).join('; ')
          || `${verdict.evaluatorID} returned ${verdict.verdict.status}`),
      // Computed beside it, never instead of it. Undefined on a case that declares no JSON format.
      jsonViews: adjudicateJSONViews({ benchmarkCase, slot, answerText, strictStatus: status, now: this.now }),
    };
  }
}
