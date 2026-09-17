// Cernum · REQ-03 Phase 6 — the ROUTING gate for scoring policy generation 2.
//
// Phase 5 adopted the narrowed repair "prospectively only": nothing scored through it. Phase 6 ruled
// that it is routed into the live capability-evaluation path. This gate asserts the four things that
// ruling attached to the routing, and it asserts them against the LIVE ENGINE rather than against a
// re-implementation of the composition:
//
//   1. Version 2 is explicit and selectable by version.
//   2. Version 1 remains available and reproduces every historical result.
//   3. No stored row is silently modified.
//   4. Binding fails closed when a policy version or digest is unavailable or mismatched.
//
// THE LOAD-BEARING ASSERTION is §3 below: for all 350 adjudicated rows, what the live engine produces
// under generation 2 must equal, exactly, what the Phase 5 adoption gate measured. If the live path
// and the gate can disagree, the gate stops being evidence about the thing that actually scores.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { caseByID, canonicalPolicies, generation2Policies, allPolicies, policyCatalog, registeredSuites, allGovernedSuites } from '../../src/core/catalog';
import { EvaluationEngine } from '../../src/core/engine';
import { policyDigest } from '../../src/core/scoring-policy';
import { evaluateRepaired, OUT_OF_SCOPE_METHODS } from '../../src/core/capability-repair';
import { narrowedRepairStatus } from '../../src/core/capability-repair-narrowing';
import {
  SCORING_POLICY_GENERATION_1, SCORING_POLICY_GENERATION_2, GENERATION_2_EXCLUDED_POLICY_IDS,
  GENERATION_2_ADOPTION, isGeneration2,
} from '../../src/core/capability-generation';
import {
  bindSuiteToGeneration, bindCampaignScoring, verifyCampaignScoringBinding, CampaignBindingFailure,
} from '../../src/core/campaign-binding';
import { AttemptRecord, Observation } from '../../src/core/run';

const EVIDENCE_ROOT = process.env.CERNUM_EVIDENCE_ROOT
  ?? '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';

const SEALED_SOURCES = {
  ledgerA2: { path: 'pass08-evidence/campaign-a2/results.jsonl', digest: 'adcb22f1ab7908b5c08d1568ee316e1001cad9ab6b101cb43b0dab3e711799f0' },
  ledgerB2: { path: 'pass08-evidence/campaign-b2/results.jsonl', digest: '0a1561d7bd4f8cab4644b08f529b9e8711572aa03d0d9b82f5301875adc65f96' },
  idMap1: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-1-IDENTITY-MAP.SEALED.json', digest: '4d79fd6641b8f3c750a54331e1a6f9019ac3395f8c52ea58a54cf3101d367d8d' },
  idMap2: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-2-IDENTITY-MAP.SEALED.json', digest: 'c96c2d9ab68a98aeb5d0596a161b1412f1428ea1076ec96dfccf24e73e7128e4' },
  idMap3: { path: 'req03-sealed/CERNUM-REQ-03-PHASE-3-IDENTITY-MAP.SEALED.json', digest: 'aadb933d082f77ed60262f940c59f0a95380b11d810c75bd520e032642daa00e' },
  live1: { path: 'pass10-evidence/req03-phase1/rulings/CERNUM-REQ-03-PHASE-1-RULINGS-LIVE-120-AS-SUBMITTED.json', digest: '7eb0c004daae1a3ab78adde5584a484ace7a33d67d71e4edee3304ef40ef9d5e' },
  live2: { path: 'pass10-evidence/req03-phase2/rulings/CERNUM-REQ-03-PHASE-2-RULINGS-LIVE-110-EFFECTIVE.json', digest: 'ff6bd6dd98a6afdcc3e7ec4102a28584ab2869325c4a6989355611af19c3d88b' },
  live3: { path: 'pass10-evidence/req03-phase3/rulings/CERNUM-REQ-03-PHASE-3-RULINGS-LIVE-120-AS-SUBMITTED.json', digest: 'd48d397a9a2fbaa717adcb5f189007249baff6c9499d2a771c15e187da21d4f8' },
} as const;

function hardStop(detail: string): never {
  throw new Error(`REQ-03 PHASE 6 ROUTING GATE HARD STOP — ${detail}`);
}

function loadPinned(key: keyof typeof SEALED_SOURCES): Buffer {
  const { path, digest } = SEALED_SOURCES[key];
  const full = join(EVIDENCE_ROOT, path);
  if (!existsSync(full)) hardStop(`sealed evidence is absent: ${path}`);
  const bytes = readFileSync(full);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) hardStop(`sealed evidence changed under ${key}: expected ${digest}, got ${actual}. Do not re-pin this to make the gate green.`);
  return bytes;
}
const loadSealed = (k: keyof typeof SEALED_SOURCES) => JSON.parse(loadPinned(k).toString('utf8'));

// ── The adjudicated corpus, joined exactly as the Phase 5 gate joins it ─────────────────────────
const ledger = (() => {
  const bySlot = new Map<string, { answerText: string; caseID: string; candidate: string; status: string }>();
  for (const key of ['ledgerA2', 'ledgerB2'] as const) {
    for (const line of loadPinned(key).toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const row = JSON.parse(line);
      bySlot.set(row.slotKey, { answerText: row.answerText ?? '', caseID: row.caseID, candidate: row.candidate, status: row.status });
    }
  }
  return bySlot;
})();

interface LiveRow { decisionID: string; caseID: string; candidate: string; answerText: string; evaluatorStatusAtSealing: string; humanVerdict: string }

const live: LiveRow[] = (() => {
  const rows: LiveRow[] = [];
  for (const [rulKey, mapKey] of [['live1', 'idMap1'], ['live2', 'idMap2'], ['live3', 'idMap3']] as const) {
    const rulings = loadSealed(rulKey).rulings as { decisionID: string; verdict: string }[];
    // Sourced exactly as the Phase 5 adoption gate sources it, so the two gates cannot drift apart.
    const byDecision = new Map<string, any>(loadSealed(mapKey).rows.map((r: any) => [r.decisionID, r]));
    for (const r of rulings) {
      const idr = byDecision.get(r.decisionID);
      if (!idr) hardStop(`no identity-map entry for ${r.decisionID}`);
      const led = ledger.get(idr.slotKey);
      if (!led) hardStop(`no ledger row for slotKey ${idr.slotKey} (${r.decisionID})`);
      rows.push({
        decisionID: r.decisionID, caseID: idr.caseID, candidate: idr.candidate, answerText: led.answerText,
        evaluatorStatusAtSealing: idr.evaluatorStatus ?? idr.ledgerStatus ?? led.status,
        humanVerdict: r.verdict,
      });
    }
  }
  if (rows.length !== 350) hardStop(`joined ${rows.length} adjudicated rows, required exactly 350`);
  return rows;
})();

// ── Replay helpers, identical in shape to the Phase 5 gate's ────────────────────────────────────
const engine = new EvaluationEngine(policyCatalog, () => new Date('2026-01-01T00:00:00Z'));

function observationFor(answerText: string): Observation {
  return {
    outputText: answerText, toolCallObservationsRaw: [], terminalStatus: 'completed',
    providerReportedUsage: { unavailableReason: 'replayed from the sealed ledger' },
    timing: { startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:00Z', durationMilliseconds: { measured: 0 } },
    warnings: [], errors: [],
    identityVerification: { state: 'unverifiable', reportedModelID: { unavailableReason: 'replayed' }, requestedModelID: '' },
    runtimeConfigurationID: 'replay', requestDigest: 'replay',
  } as unknown as Observation;
}

/** The case as a campaign bound to `generation` would present it. */
function boundCase(caseID: string, generation: string) {
  const plain = caseByID(caseID);
  if (!plain) hardStop(`case ${caseID} is not in the catalog`);
  const suite = registeredSuites.find((s) => s.cases.some((c) => c.id.raw === caseID))!;
  return bindSuiteToGeneration(suite, generation, policyCatalog).cases.find((c) => c.id.raw === caseID)!;
}

function attemptFor(caseID: string, candidate: string, answerText: string, generation: string): AttemptRecord {
  const c = boundCase(caseID, generation);
  return {
    attemptID: `replay:${generation}:${caseID}`, runID: 'req03-phase6', ordinal: 0, repetitionIndex: 1,
    candidate: { id: { raw: candidate } }, candidateDigest: 'replay',
    suiteID: c.suiteID, suiteVersion: c.suiteVersion, caseID: c.id, caseDigest: 'replay',
    inputPackage: c.inputs, inputPackageDigest: 'replay',
    scoringPolicyID: c.scoringPolicyID, scoringPolicyVersion: c.scoringPolicyVersion,
    environment: {} as AttemptRecord['environment'], observation: observationFor(answerText),
    terminalStatus: 'completed', comparabilityKey: 'replay',
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
  } as unknown as AttemptRecord;
}

describe('REQ-03 Phase 6 · generation 2 is registered as a complete generation', () => {
  it('registers exactly one generation-2 twin per generation-1 policy, minus the one excluded id', () => {
    const gen1 = canonicalPolicies.filter((p) => p.version === SCORING_POLICY_GENERATION_1);
    expect(gen1.length).toBe(41);
    expect(generation2Policies.length).toBe(gen1.length - GENERATION_2_EXCLUDED_POLICY_IDS.length);
    expect(generation2Policies.length).toBe(40);
    expect(allPolicies.length).toBe(canonicalPolicies.length + generation2Policies.length);
    expect(allPolicies.length).toBe(82);
  });

  it('excludes only the foundation umbrella, whose version 2 already means a cohort', () => {
    for (const id of GENERATION_2_EXCLUDED_POLICY_IDS) {
      expect(generation2Policies.some((p) => p.id === id)).toBe(false);
      const existing = policyCatalog.policy(id, SCORING_POLICY_GENERATION_2);
      // The id DOES resolve at version 2 — as the cohort umbrella, not as a generation twin.
      expect(existing).toBeDefined();
      expect(existing!.method).toBe('caseDelegation');
      expect(isGeneration2(existing!)).toBe(false);
    }
  });

  it('changes nothing about a twin except its version string', () => {
    for (const twin of generation2Policies) {
      const original = canonicalPolicies.find((p) => p.id === twin.id && p.version === SCORING_POLICY_GENERATION_1)!;
      expect(policyDigest({ ...twin, version: SCORING_POLICY_GENERATION_1 })).toBe(policyDigest(original));
    }
  });

  it('keeps Gate D\'s 18 governed twins in the generation, unchanged', () => {
    expect(generation2Policies.filter((p) => p.hardGovernance !== undefined).length).toBe(18);
  });

  it('validates, and every case still resolves its policy under both generations', () => {
    expect(() => policyCatalog.validate()).not.toThrow();
    for (const generation of [SCORING_POLICY_GENERATION_1, SCORING_POLICY_GENERATION_2]) {
      const bound = allGovernedSuites.map((s) => bindSuiteToGeneration(s, generation, policyCatalog));
      expect(() => policyCatalog.validateReferences(bound)).not.toThrow();
    }
  });

  it('declares that it is routed, and that generation 1 is preserved', () => {
    expect(GENERATION_2_ADOPTION.routedIntoLiveEvaluationPath).toBe(true);
    expect(GENERATION_2_ADOPTION.generation1Preserved).toBe(true);
    expect(GENERATION_2_ADOPTION.historicalRowsRescoredInPlace).toBe(false);
  });
});

describe('REQ-03 Phase 6 · generation 1 still reproduces every historical result', () => {
  it('reproduces the sealed evaluator status for all 350 adjudicated rows', () => {
    const drift = live.filter((r) =>
      engine.evaluate(attemptFor(r.caseID, r.candidate, r.answerText, SCORING_POLICY_GENERATION_1)).verdict.status
        !== r.evaluatorStatusAtSealing);
    expect(drift.map((d) => `${d.decisionID}:${d.caseID}`)).toEqual([]);
  });

  it('leaves every generation-1 policy digest untouched', () => {
    for (const p of canonicalPolicies) {
      expect(policyDigest(policyCatalog.policy(p.id, p.version)!)).toBe(policyDigest(p));
    }
  });
});

describe('REQ-03 Phase 6 · the live engine under generation 2, and what carrying BOTH corrections costs', () => {
  // GENERATION 2 IS NOT THE PHASE 5 REPAIR. It is the Phase 5 repair AND Gate D's hybrid governance,
  // and no adoption gate measured the two together. The interaction is small, entirely explicable, and
  // asserted here EXACTLY rather than described: the hybrid matcher refers `gov.memory.no-resurrect-deleted`
  // to a human judge, so rows that the capability repair would have passed are instead WITHHELD.
  //
  // A withheld row is not a wrong row. But it is not a scored row either, and the difference is why the
  // Phase 5 published rates may not be quoted as generation 2's rates.
  const REFERRED_CASE = 'case:memory-honesty:honor-deletion';

  const scored = live.map((r) => {
    const v1 = engine.evaluate(attemptFor(r.caseID, r.candidate, r.answerText, SCORING_POLICY_GENERATION_1)).verdict.status;
    const policy = policyCatalog.policy(caseByID(r.caseID)!.scoringPolicyID, SCORING_POLICY_GENERATION_1)!;
    const inScope = !OUT_OF_SCOPE_METHODS.has(policy.method);
    const v2 = inScope ? evaluateRepaired(policy, r.caseID, r.answerText).status : v1;
    const capabilityOnly = narrowedRepairStatus(r.caseID, v1 as any, v2 as any).status;
    const routed = engine.evaluate(attemptFor(r.caseID, r.candidate, r.answerText, SCORING_POLICY_GENERATION_2)).verdict;
    return { ...r, v1, capabilityOnly, routed: routed.status, governance: routed.governance.state };
  });

  it('matches the Phase 5 narrowed composition on every row the hybrid matcher does not refer', () => {
    const mismatches = scored
      .filter((r) => r.governance !== 'requiresHumanReview')
      .filter((r) => r.routed !== r.capabilityOnly)
      .map((r) => `${r.decisionID} ${r.caseID}: engine=${r.routed} gate=${r.capabilityOnly}`);
    expect(mismatches).toEqual([]);
  });

  it('withholds exactly the referred rows, and only by referral', () => {
    const withheld = scored.filter((r) => r.routed === 'requiresHumanReview');
    expect(withheld.length).toBe(14);
    expect([...new Set(withheld.map((r) => r.caseID))]).toEqual([REFERRED_CASE]);
    expect([...new Set(withheld.map((r) => r.governance))]).toEqual(['requiresHumanReview']);
    // Every one of them is a row the capability repair alone would have SCORED as a pass.
    expect([...new Set(withheld.map((r) => `${r.capabilityOnly} -> ${r.routed}`))]).toEqual(['pass -> requiresHumanReview']);
  });

  it('gets nothing MORE wrong than the capability repair alone: same false positives, same false negatives', () => {
    const tally = (pick: (r: typeof scored[0]) => string) => {
      let fp = 0, fn = 0;
      for (const r of scored) {
        const s = pick(r);
        if (s === 'requiresHumanReview') continue;
        const evalPass = s === 'pass', humanPass = r.humanVerdict === 'pass';
        if (evalPass !== humanPass) { if (humanPass) fp += 1; else fn += 1; }
      }
      return { fp, fn };
    };
    expect(tally((r) => r.routed)).toEqual(tally((r) => r.capabilityOnly));
  });

  it('moves rows off generation 1, so the routing is demonstrably in effect', () => {
    expect(scored.filter((r) => r.routed !== r.v1).length).toBeGreaterThan(0);
  });
});

describe('REQ-03 Phase 6 · campaign binding fails closed', () => {
  const suite = registeredSuites.find((s) => s.id.raw === 'suite.model-lab.conversation')!;

  it('refuses a generation this build does not know', () => {
    expect(() => bindSuiteToGeneration(suite, '99', policyCatalog)).toThrow(CampaignBindingFailure);
    try { bindSuiteToGeneration(suite, '99', policyCatalog); } catch (e: any) { expect(e.code).toBe('unknownGeneration'); }
  });

  it('binds the generation and a digest for every case', () => {
    const binding = bindCampaignScoring([suite], SCORING_POLICY_GENERATION_2, policyCatalog);
    expect(binding.generation).toBe(SCORING_POLICY_GENERATION_2);
    expect(binding.catalogDigest).toBe(policyCatalog.catalogDigest());
    expect(binding.cases.length).toBe(suite.cases.length);
    for (const c of binding.cases) {
      expect(c.scoringPolicyVersion).toBe(SCORING_POLICY_GENERATION_2);
      expect(c.scoringPolicyDigest).toBe(policyDigest(policyCatalog.policy(c.scoringPolicyID, c.scoringPolicyVersion)!));
    }
    expect(() => verifyCampaignScoringBinding(binding, policyCatalog)).not.toThrow();
  });

  it('refuses a binding whose catalog digest has moved', () => {
    const binding = { ...bindCampaignScoring([suite], SCORING_POLICY_GENERATION_2, policyCatalog), catalogDigest: 'mlspc1:deadbeefdeadbeef' };
    try { verifyCampaignScoringBinding(binding, policyCatalog); hardStop('a moved catalog digest was accepted'); }
    catch (e: any) { expect(e.code).toBe('scoringPolicyCatalogDigestMismatch'); }
  });

  it('refuses a binding whose policy digest has moved', () => {
    const binding = bindCampaignScoring([suite], SCORING_POLICY_GENERATION_2, policyCatalog);
    binding.cases[0].scoringPolicyDigest = 'mlsp1:0000000000000000';
    try { verifyCampaignScoringBinding(binding, policyCatalog); hardStop('a moved policy digest was accepted'); }
    catch (e: any) { expect(e.code).toBe('scoringPolicyDigestMismatch'); }
  });

  it('refuses a binding naming a policy version this build does not register', () => {
    const binding = bindCampaignScoring([suite], SCORING_POLICY_GENERATION_2, policyCatalog);
    binding.cases[0].scoringPolicyVersion = '7';
    try { verifyCampaignScoringBinding(binding, policyCatalog); hardStop('an unregistered policy version was accepted'); }
    catch (e: any) { expect(e.code).toBe('scoringPolicyVersionUnavailable'); }
  });

  it('binds generation 1 to the cases\' own declared versions, unchanged', () => {
    const bound = bindSuiteToGeneration(suite, SCORING_POLICY_GENERATION_1, policyCatalog);
    expect(bound.cases.map((c) => c.scoringPolicyVersion)).toEqual(suite.cases.map((c) => c.scoringPolicyVersion));
  });
});
