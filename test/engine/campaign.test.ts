// A whole campaign, driven end to end without a single request reaching any server.
//
// These tests drive the REAL orchestration — the real ledger, the real guards, the real manifest
// verification, the real residency proof — through a deterministic host. A synthetic campaign that
// shortcut the orchestration would prove the shortcut works and nothing else.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Campaign, CampaignConfiguration, CampaignError, campaignPaths } from '../../src/engine/campaign';
import { Ledger } from '../../src/engine/ledger';
import { GIB } from '../../src/engine/guards';
import { SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SyntheticHost, SyntheticScript, steppingClock, syntheticCandidate } from '../../src/engine/synthetic';

const SUITES = ['suite.model-lab.foundation', 'suite.model-lab.structured-output'];
const SECRET = 'a-blinding-secret-long-enough';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-campaign-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function configuration(overrides: Partial<CampaignConfiguration> = {}): CampaignConfiguration {
  return {
    label: 'synthetic cohort',
    suiteIDs: SUITES,
    repeatsPerCase: 2,
    candidates: [syntheticCandidate('alpha:1b'), syntheticCandidate('beta:2b')],
    hardware: SYNTHETIC_HARDWARE,
    runtimeVersion: 'synthetic-runtime-1.0',
    storeBaseline: SYNTHETIC_STORE_BASELINE,
    residencyDelayMilliseconds: 0,
    ...overrides,
  };
}

function host(script: SyntheticScript = {}): SyntheticHost {
  const pinned = Object.fromEntries(configuration().candidates.map((candidate) => [candidate.name, {
    name: candidate.name, modelID: candidate.modelID, runtimeDigest: candidate.runtimeDigest,
    parameterSize: candidate.parameterSize, quantization: candidate.quantization,
  }]));
  return new SyntheticHost(script, steppingClock(), pinned);
}

describe('creating a campaign', () => {
  it('freezes the manifest and writes the plan before a single request', () => {
    const campaign = Campaign.create(root, configuration(), host());
    const paths = campaignPaths(root);
    expect(fs.existsSync(paths.manifest)).toBe(true);
    expect(fs.existsSync(path.join(paths.ledger, 'plan.json'))).toBe(true);
    expect(campaign.status().terminalCount).toBe(0);
    // 8 cases across the two suites, twice each, for two candidates.
    expect(campaign.status().slotCount).toBe(campaign.ledger.plan.length);
    expect(campaign.status().slotCount).toBe(6 * 2 * 2);
  });

  it('refuses to create a second campaign over the same evidence', () => {
    Campaign.create(root, configuration(), host());
    expect(() => Campaign.create(root, configuration(), host())).toThrow(CampaignError);
  });

  it('seals the manifest with a digest a person can compare by eye', () => {
    const campaign = Campaign.create(root, configuration(), host());
    expect(campaign.status().manifestSeal).toMatch(/^manifest manifest:[0-9a-f]{16} · catalog /);
  });

  it('verifies intact against the configuration it was frozen from', () => {
    const campaign = Campaign.create(root, configuration(), host());
    expect(campaign.verify().intact).toBe(true);
  });
});

describe('running to completion', () => {
  it('records every slot exactly once and reconciles', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    const status = await campaign.run();
    expect(status.state).toBe('complete');
    expect(status.reconciliation.balances).toBe(true);
    expect(status.reconciliation.complete).toBe(true);
    expect(status.terminalCount).toBe(status.slotCount);
    expect(status.reconciliation.duplicateTerminalResults).toBe(0);
  });

  it('proves zero residency at every candidate transition and at the end', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run();
    const proofs = campaign.ledger.events().filter((event) => event.kind === 'residencyVerified');
    expect(proofs).toHaveLength(2);
    expect(proofs.map((proof) => proof.candidate)).toEqual(['alpha:1b', 'beta:2b']);
  });

  it('carries per-attempt telemetry into the ledger', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      defaultAnswer: { status: 'pass', answerText: 'ok', latencyMilliseconds: 250, visibleTokens: 40 },
    }));
    await campaign.run();
    const result = [...campaign.ledger.results.values()][0];
    expect(result.latencyMilliseconds).toBe(250);
    expect(result.timeToFirstTokenMilliseconds).toBe(25);
    expect(result.visibleTokenCount).toBe(40);
    expect(result.streamed).toBe(true);
  });

  it('explains an answer that spent its whole budget thinking, instead of calling it empty', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      defaultAnswer: { status: 'fail', answerText: '', visibleTokens: 0, thinkingTokens: 900, latencyMilliseconds: 4_000 },
    }));
    await campaign.run();
    const result = [...campaign.ledger.results.values()][0];
    expect(result.thinkingOnly).toBe(true);
    expect(String(result.detail)).toMatch(/spent 900 of its \d+-token budget thinking/);
    expect(String(result.detail)).toMatch(/budget setting, not a capability failure/);
  });
});

describe('pause and resume', () => {
  it('stops cleanly at a slot boundary and resumes exactly where it left off', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    let seen = 0;
    const paused = await campaign.run({ shouldPause: () => seen >= 5, onProgress: () => { seen += 1; } });
    expect(paused.state).toBe('paused');
    expect(paused.terminalCount).toBe(5);

    // A brand-new process opens the campaign from disk and carries on.
    const resumed = Campaign.open(root, configuration(), host());
    expect(resumed.ledger.results.size).toBe(5);
    const finished = await resumed.run();
    expect(finished.state).toBe('complete');
    expect(finished.terminalCount).toBe(finished.slotCount);
    expect(finished.reconciliation.duplicateTerminalResults).toBe(0);
  });

  it('never re-runs a slot that already has a terminal result', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ maxAttempts: 4 });
    const firstFour = [...campaign.ledger.results.keys()];

    const resumed = Campaign.open(root, configuration(), host({ defaultAnswer: { status: 'fail', answerText: 'different' } }));
    await resumed.run();
    // The first four keep their original status; only the later slots got the new script.
    for (const key of firstFour) expect(resumed.ledger.results.get(key)?.status).toBe('pass');
    expect([...resumed.ledger.results.values()].filter((r) => r.status === 'fail').length).toBe(resumed.ledger.plan.length - 4);
  });

  it('recovers from a torn write across a process boundary', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ maxAttempts: 3 });
    // The interruption landed mid-append.
    fs.appendFileSync(path.join(campaignPaths(root).ledger, 'results.jsonl'), '{"slotKey":"partial');

    const resumed = Campaign.open(root, configuration(), host());
    expect(resumed.ledger.anomalies.map((a) => a.kind)).toContain('repairedTornWrite');
    const status = await resumed.run();
    expect(status.reconciliation.complete).toBe(true);
    expect(status.reconciliation.balances).toBe(true);
  });

  it('records the pause in the event trace, so an interruption is visible afterwards', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ shouldPause: () => true });
    expect(campaign.ledger.events().map((event) => event.kind)).toContain('paused');
  });
});

describe('the frozen manifest is re-verified on every resume', () => {
  it('refuses to resume when the benchmark itself changed', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ maxAttempts: 2 });

    // A resume that quietly ran a DIFFERENT set of suites would produce evidence nobody could read.
    const changed = Campaign.open(root, configuration({ suiteIDs: ['suite.model-lab.foundation'] }), host());
    await expect(changed.run()).rejects.toThrow(/frozen manifest no longer describes this campaign/);
    expect(changed.status().state).toBe('aborted');
    expect(changed.ledger.standingAbort()?.stage).toBe('manifestVerification');
  });

  it('names what moved, in language a person can act on', () => {
    const campaign = Campaign.create(root, configuration(), host());
    const drifted = Campaign.open(root, configuration({ runtimeVersion: 'synthetic-runtime-2.0' }), host());
    const report = drifted.verify();
    expect(report.intact).toBe(false);
    expect(report.drifts.map((drift) => drift.field)).toContain('runtimeVersion');
    expect(report.drifts[0].meaning).toMatch(/part of the measurement/);
    void campaign;
  });

  it('reports hardware-only drift distinctly, because that is what a retest is for', () => {
    Campaign.create(root, configuration(), host());
    const elsewhere = Campaign.open(root, configuration({ hardware: { ...SYNTHETIC_HARDWARE, model: 'A Different Machine' } }), host());
    const report = elsewhere.verify();
    expect(report.intact).toBe(false);
    expect(report.hardwareOnly).toBe(true);
  });
});

describe('new-hardware retest manifests', () => {
  it('carries the benchmark across byte-identically and back-references the original', () => {
    const campaign = Campaign.create(root, configuration(), host());
    const target = path.join(root, 'retest');
    const derived = campaign.deriveRetest(target, { ...SYNTHETIC_HARDWARE, model: 'Apple M4 Pro' }, 'ollama-9.9', 'moved to the new machine');

    expect(derived.promptsDigest).toBe(campaign.manifest.promptsDigest);
    expect(derived.scoredCoreDigest).toBe(campaign.manifest.scoredCoreDigest);
    expect(derived.candidatesDigest).toBe(campaign.manifest.candidatesDigest);
    expect(derived.hardwareDigest).not.toBe(campaign.manifest.hardwareDigest);
    expect(derived.manifestID).not.toBe(campaign.manifest.manifestID);
    expect(derived.retestOf).toMatchObject({ manifestID: campaign.manifest.manifestID, reason: 'moved to the new machine' });
    expect(fs.existsSync(campaignPaths(target).manifest)).toBe(true);
  });

  it('refuses a retest manifest for the same machine and runtime', () => {
    const campaign = Campaign.create(root, configuration(), host());
    expect(() => campaign.deriveRetest(path.join(root, 'retest'), SYNTHETIC_HARDWARE, 'synthetic-runtime-1.0', 'no change'))
      .toThrow(/would be a duplicate/);
  });
});

describe('safety guards abort rather than warn', () => {
  it('blocks every remaining slot when free space falls below the floor', async () => {
    const campaign = Campaign.create(root, configuration(), host({
      readings: [{}, {}, { freeDiskBytes: 2 * GIB }],
    }));
    const status = await campaign.run();
    expect(status.state).toBe('aborted');
    expect(status.terminalCount).toBe(2);
    expect(status.standingAbort?.reason).toMatch(/disk\.freeSpace: free 2\.00 GiB, floor 15\.00 GiB/);
    expect(status.standingAbort?.blockedSlotCount).toBe(status.slotCount - 2);
    expect(status.reconciliation.balances).toBe(true);
  });

  it('blocks when a port that must be quiet is not', async () => {
    const campaign = Campaign.create(root, configuration(), host({
      readings: [{ listeners: { '11436': 4242, '11435': 999 } }],
    }));
    const status = await campaign.run();
    expect(status.standingAbort?.reason).toMatch(/port\.quiet\.11435/);
  });

  it('blocks when the model store changed under the campaign', async () => {
    const campaign = Campaign.create(root, configuration(), host({
      readings: [{}, { modelStoreCount: 9, modelStoreListingDigest: 'something-else' }],
    }));
    const status = await campaign.run();
    expect(status.standingAbort?.reason).toMatch(/modelStore\.unchanged/);
  });

  it('resumes after the breach is resolved, keeping the abort as a record', async () => {
    const aborting = Campaign.create(root, configuration(), host({ readings: [{}, { freeDiskBytes: 2 * GIB }] }));
    await aborting.run();
    expect(aborting.status().state).toBe('aborted');

    const resumed = Campaign.open(root, configuration(), host());
    const status = await resumed.run();
    expect(status.state).toBe('complete');
    expect(resumed.ledger.standingAbort()).toBeUndefined();
    expect(resumed.ledger.pastAborts()).toHaveLength(1);
    expect(resumed.ledger.pastAborts()[0].supersededBecause).toMatch(/resumed after/);
  });
});

describe('residency release is proven, not assumed', () => {
  it('aborts when a model will not release its weights', async () => {
    const campaign = Campaign.create(root, configuration(), host({ residencyScript: { 'alpha:1b': 'never' } }));
    const status = await campaign.run();
    expect(status.state).toBe('aborted');
    expect(status.standingAbort?.stage).toBe('candidateTransition');
    expect(status.standingAbort?.reason).toMatch(/alpha:1b would not release its weights/);
    // The first candidate's slots are terminal; the second candidate's are blocked, never attempted.
    expect(status.terminalCount).toBe(status.slotCount / 2);
  });
});

describe('model identity verification', () => {
  it('aborts the candidate when the runtime is serving different weights', async () => {
    const campaign = Campaign.create(root, configuration(), host({
      identities: { 'alpha:1b': { name: 'alpha:1b', modelID: 'alpha:1b', runtimeDigest: 'digest-something-else', parameterSize: '4B', quantization: 'Q4_K_M' } },
    }));
    const status = await campaign.run();
    expect(status.state).toBe('aborted');
    expect(status.standingAbort?.stage).toBe('identityVerification');
    expect(status.standingAbort?.reason).toMatch(/serving different weights/);
  });

  it('carries an unverifiable identity rather than blocking on it', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({ identities: { 'alpha:1b': {}, 'beta:2b': {} } }));
    const status = await campaign.run();
    expect(status.state).toBe('complete');
    expect([...campaign.ledger.results.values()].every((result) => result.identityState === 'unverifiable')).toBe(true);
  });
});

describe('supplied-context verification', () => {
  it('records a dropped context as a measurement fault, not a model failure', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      byCaseID: { 'case:foundation:context-recall': { status: 'pass', answerText: 'anything', dropContext: true } },
    }));
    await campaign.run();
    const affected = [...campaign.ledger.results.values()].filter((result) => result.suppliedContextState === 'absent');
    expect(affected.length).toBeGreaterThan(0);
    for (const result of affected) {
      // Pass 11. This test's own name has said `measurement fault` since it was written, and until
      // Pass 11 the row it asserted was `runtimeError` — which the ranking counted as a model-quality
      // fail. The sentence was always right; the arithmetic under it was not.
      expect(result.status).toBe('envelopeFailure');
      expect(result.disposition).toBe('measurementFault');
      expect(String(result.detail)).toMatch(/supplied context absent/);
      expect(String(result.detail)).toMatch(/measures guessing rather than retrieval/);
    }
  });

  it('names truncation distinctly from mutation, because the fix differs', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      byCaseID: { 'case:foundation:context-recall': { status: 'pass', answerText: 'x', truncateContextTo: 10 } },
    }));
    await campaign.run();
    const affected = [...campaign.ledger.results.values()].filter((result) => result.suppliedContextState === 'truncated');
    expect(affected.length).toBeGreaterThan(0);
    expect(String(affected[0].detail)).toMatch(/cut short at 10 of \d+ characters/);
  });

  it('leaves a case with no supplied context alone', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host());
    await campaign.run();
    const untouched = [...campaign.ledger.results.values()].filter((result) => result.suppliedContextState === 'notSupplied');
    expect(untouched.length).toBeGreaterThan(0);
    expect(untouched.every((result) => result.status === 'pass')).toBe(true);
  });
});

describe('finalizing', () => {
  it('ranks, interprets and writes every artefact', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      byCandidate: {
        'alpha:1b': { status: 'pass', answerText: 'good', latencyMilliseconds: 100 },
        'beta:2b': { status: 'fail', answerText: 'bad', latencyMilliseconds: 900 },
      },
    }));
    await campaign.run();
    const report = campaign.finalize({ blindingSecret: SECRET });

    expect(report.reconciliation.complete).toBe(true);
    expect(report.rankings.provisional).toBe(false);
    expect(report.rankings.rankings[0].candidate).toBe('alpha:1b');
    expect(report.rankings.rankings[0].rank).toBe(1);
    expect(report.rankings.rankings[1].candidate).toBe('beta:2b');

    const paths = campaignPaths(root);
    for (const file of [paths.report, paths.rankings, paths.retention]) expect(fs.existsSync(file), file).toBe(true);
  });

  it('marks an incomplete campaign provisional rather than confident', async () => {
    const campaign = Campaign.create(root, configuration(), host());
    await campaign.run({ maxAttempts: 4 });
    const report = campaign.finalize();
    expect(report.rankings.provisional).toBe(true);
    expect(report.rankings.provisionalBecause.join(' ')).toMatch(/campaign is incomplete/);
    expect(report.retention.provisional).toBe(true);
  });

  it('keeps a governance failure as a disqualification, not a low score', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      byCandidate: {
        'alpha:1b': { status: 'fail', answerText: 'x', governanceViolated: true },
        'beta:2b': { status: 'pass', answerText: 'y' },
      },
    }));
    await campaign.run();
    const report = campaign.finalize();
    const alpha = report.rankings.rankings.find((ranking) => ranking.candidate === 'alpha:1b')!;
    expect(alpha.disqualified).toBe(true);
    expect(alpha.rank).toBe(2);
    expect(report.retention.recommendations.find((r) => r.candidate === 'alpha:1b')?.outcome).toBe('disqualified');
    expect(alpha.roles.every((role) => !role.qualified)).toBe(true);
  });

  it('labels retention as interpretation, in its own heading', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host());
    await campaign.run();
    const report = campaign.finalize();
    expect(report.retention.heading).toMatch(/INTERPRETATION, not measurement/);
    expect(report.retention.preamble.join(' ')).toMatch(/No model is deleted by this engine/);
    for (const ranking of report.rankings.rankings) {
      for (const role of ranking.roles) expect(role.interpretation).toMatch(/not a measurement/);
    }
  });

  it('excludes rubric answers from every rate until the adjudication returns', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      defaultAnswer: { status: 'requiresHumanReview', answerText: 'needs a person' },
    }));
    await campaign.run();
    const report = campaign.finalize({ blindingSecret: SECRET });
    for (const ranking of report.rankings.rankings) {
      expect(ranking.scoredCount).toBe(0);
      expect('unavailableReason' in ranking.overallPassRateMilli).toBe(true);
      expect(ranking.awaitingHumanReviewCount).toBeGreaterThan(0);
    }
    expect(report.humanReview.awaiting).toBe(report.rankings.awaitingHumanReviewTotal);
  });
});

describe('blinded adjudication packets', () => {
  it('writes the packet and the key to different directories', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      defaultAnswer: { status: 'requiresHumanReview', answerText: 'I am alpha:1b and I think so' },
    }));
    await campaign.run();
    const report = campaign.finalize({ blindingSecret: SECRET });
    const paths = campaignPaths(root);

    expect(report.humanReview.packetWritten).toBe(true);
    expect(fs.existsSync(paths.packet)).toBe(true);
    expect(fs.existsSync(paths.key)).toBe(true);
    expect(path.dirname(paths.packet)).not.toBe(path.dirname(paths.key));
  });

  it('produces a packet that survives its own leak audit', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      defaultAnswer: { status: 'requiresHumanReview', answerText: 'As alpha:1b, running beta:2b weights, I would say yes.' },
    }));
    await campaign.run();
    const report = campaign.finalize({ blindingSecret: SECRET });
    expect(report.humanReview.audit?.clean).toBe(true);
    expect(report.humanReview.audit?.leaks).toEqual([]);
    expect(report.humanReview.audit?.duplicateTokens).toEqual([]);

    const packet = campaign.readPacket()!;
    const serialised = JSON.stringify(packet);
    expect(serialised).not.toMatch(/alpha/i);
    expect(serialised).not.toMatch(/beta/i);
    expect(serialised).toMatch(/MODEL NAME REDACTED/);
  });

  it('keeps the key as the only thing that reverses the blinding', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host({
      defaultAnswer: { status: 'requiresHumanReview', answerText: 'an answer' },
    }));
    await campaign.run();
    campaign.finalize({ blindingSecret: SECRET });
    const key = campaign.readPacketKey()!;
    const packet = campaign.readPacket()!;
    const tokens = packet.cases.flatMap((packetCase) => packetCase.responses.map((response) => response.token));
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) expect(key.tokens.some((entry) => entry.token === token)).toBe(true);
  });

  it('writes no packet when nothing awaits review', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host());
    await campaign.run();
    const report = campaign.finalize({ blindingSecret: SECRET });
    expect(report.humanReview.awaiting).toBe(0);
    expect(report.humanReview.packetWritten).toBe(false);
    expect(fs.existsSync(campaignPaths(root).packet)).toBe(false);
  });
});

describe('the ledger a campaign leaves behind stands on its own', () => {
  it('can be opened and reconciled without the campaign object', async () => {
    const campaign = Campaign.create(root, configuration({ repeatsPerCase: 1 }), host());
    await campaign.run();
    const ledger = Ledger.open(campaignPaths(root).ledger);
    expect(ledger.reconcile().complete).toBe(true);
    expect(ledger.meta().label).toBe('synthetic cohort');
    expect(ledger.meta().manifestID).toBe(campaign.manifest.manifestID);
  });
});
