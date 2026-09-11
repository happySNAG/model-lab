// Canonical and observe-only: what each one is authorised to do, and what each one's numbers mean.
//
// The defect this file exists because of was small and expensive. The desktop service built its
// live host without enabling residency, so the end-of-candidate release threw instead of running,
// and every campaign started from the Start button ended in an error rather than a result. The
// repair is not "turn the flag on in one more place" — it is that BOTH surfaces ask the same
// function how to configure a host, from the same frozen policy, so there is no second place for
// them to disagree.
//
// The rest of this file is about the other half of that decision: if Cernum is going to manage
// residency, then a run where it did not must be impossible to mistake for one where it did.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_EXECUTION_POLICY, ExecutionPolicy, NONCANONICAL_REASONS, describeExecutionPolicy, hostOptionsFor,
  isCanonical, residencyDisclosure,
} from '../../src/engine/execution';
import { Campaign, CampaignConfiguration, campaignPaths } from '../../src/engine/campaign';
import { FrozenManifest, freezeManifest, manifestSeal, verifyManifest } from '../../src/engine/manifest';
import { verifyThinkingMode, thinkingModePermitsExecution } from '../../src/engine/verification';
import { SYNTHETIC_HARDWARE, SYNTHETIC_STORE_BASELINE, SyntheticHost, steppingClock, syntheticCandidate } from '../../src/engine/synthetic';
import { modelCanThink } from '../../src/engine/live-host';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-execution-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const CANONICAL: ExecutionPolicy = { residency: 'managed', thinkingMode: 'disabled' };
const OBSERVE_ONLY: ExecutionPolicy = { residency: 'observeOnly', thinkingMode: 'disabled' };

const SUITES = ['suite.model-lab.foundation'];
const SECRET = 'a-blinding-secret-long-enough';

function configuration(execution: ExecutionPolicy, overrides: Partial<CampaignConfiguration> = {}): CampaignConfiguration {
  return {
    label: 'two candidates',
    suiteIDs: SUITES,
    repeatsPerCase: 1,
    candidates: [syntheticCandidate('alpha:1b'), syntheticCandidate('beta:2b')],
    hardware: SYNTHETIC_HARDWARE,
    runtimeVersion: 'synthetic-runtime-1.0',
    storeBaseline: SYNTHETIC_STORE_BASELINE,
    residencyDelayMilliseconds: 0,
    execution,
    ...overrides,
  };
}

/**
 * A deterministic host whose runtime releases weights as scripted.
 *
 * `'never'` is a runtime that accepts the unload, answers politely, and keeps the model resident —
 * which is the real failure this guard exists for, and the one a warning would hide.
 */
function host(residencyScript: Record<string, number | 'never'> = {}): SyntheticHost {
  const pinned = Object.fromEntries(configuration(CANONICAL).candidates.map((candidate) => [candidate.name, {
    name: candidate.name, modelID: candidate.modelID, runtimeDigest: candidate.runtimeDigest,
    parameterSize: candidate.parameterSize, quantization: candidate.quantization,
  }]));
  return new SyntheticHost({ residencyScript }, steppingClock(), pinned);
}

// MARK: - The fix itself

describe('both surfaces configure a host the same way', () => {
  it('enables residency for a canonical campaign', () => {
    expect(hostOptionsFor(CANONICAL)).toEqual({ enableResidency: true, thinkingMode: 'disabled' });
    expect(hostOptionsFor({ residency: 'managed', thinkingMode: 'enabled' }))
      .toEqual({ enableResidency: true, thinkingMode: 'enabled' });
  });

  it('leaves it off for an observe-only campaign', () => {
    expect(hostOptionsFor(OBSERVE_ONLY)).toEqual({ enableResidency: false, thinkingMode: 'disabled' });
  });

  it('defaults to canonical, so forgetting to choose does not quietly produce noncomparable numbers', () => {
    expect(DEFAULT_EXECUTION_POLICY.residency).toBe('managed');
    expect(isCanonical(DEFAULT_EXECUTION_POLICY)).toBe(true);
    expect(hostOptionsFor(DEFAULT_EXECUTION_POLICY).enableResidency).toBe(true);
  });

  it('discloses the authority in terms of ONE endpoint, before anything runs', () => {
    const lines = residencyDisclosure('http://127.0.0.1:11434', ['alpha:1b', 'beta:2b']).join(' ');
    expect(lines).toContain('load and unload models on http://127.0.0.1:11434');
    expect(lines).toContain('alpha:1b, beta:2b');
    expect(lines).toMatch(/applies to http:\/\/127\.0\.0\.1:11434 only/);
    expect(lines).toMatch(/No other runtime, port or process on this machine is touched/);
    expect(lines).toMatch(/no model is pulled, created or deleted/);
    // Asked once, not per attempt.
    expect(lines).toMatch(/not asked again between attempts/);
  });
});

// MARK: - Canonical completion

describe('a canonical campaign', () => {
  it('runs to clean completion when the runtime releases the weights', async () => {
    const campaign = Campaign.create(root, configuration(CANONICAL), host());
    const status = await campaign.run({ runtimeLease: false });
    expect(status.state).toBe('complete');
    expect(status.canonical).toBe(true);
    expect(status.reconciliation.balances).toBe(true);
    expect(status.reconciliation.unaccounted).toBe(0);
    // The release happened, was proved, and is in the trace — once per candidate transition, plus
    // once at the end.
    const verified = campaign.ledger.events().filter((event) => event.kind === 'residencyVerified');
    expect(verified.length).toBe(2);
    expect(campaign.ledger.events().some((event) => event.kind === 'residencyNotManaged')).toBe(false);
  });

  it('ABORTS when a candidate will not release its weights, and never downgrades it to a warning', async () => {
    // 'never' means the scripted runtime keeps reporting the model resident however often it is asked.
    const campaign = Campaign.create(root, configuration(CANONICAL), host({ 'alpha:1b': 'never' }));
    const status = await campaign.run({ runtimeLease: false });

    expect(status.state).toBe('aborted');
    const abort = campaign.ledger.standingAbort();
    expect(abort?.stage).toBe('candidateTransition');
    expect(abort?.reason).toMatch(/would not release its weights/);
    expect(abort!.blockedSlotCount).toBeGreaterThan(0);
    // Blocked slots carry no result at all — they were never attempted.
    for (const key of abort!.blockedSlotKeys) expect(campaign.ledger.isTerminal(key)).toBe(false);
    // And nothing anywhere recorded this as a warning that the run carried on past.
    expect(campaign.ledger.events().some((event) => event.kind === 'residencyVerified' && event.candidate === 'alpha:1b')).toBe(false);
    expect(status.reconciliation.balances).toBe(true);
  });

  it('resumes after the release problem is resolved, losing and repeating nothing', async () => {
    const campaign = Campaign.create(root, configuration(CANONICAL), host({ 'alpha:1b': 'never' }));
    const aborted = await campaign.run({ runtimeLease: false });
    expect(aborted.state).toBe('aborted');
    const doneBefore = campaign.ledger.reconcile().terminal;

    const resumed = Campaign.open(root, configuration(CANONICAL), host());
    const status = await resumed.run({ runtimeLease: false });
    expect(status.state).toBe('complete');
    expect(status.reconciliation.terminal).toBeGreaterThan(doneBefore);
    expect(status.reconciliation.duplicateTerminalResults).toBe(0);
    expect(status.reconciliation.balances).toBe(true);
  });
});

// MARK: - Observe-only isolation

describe('an observe-only campaign', () => {
  it('touches nothing, and says so in the trace', async () => {
    const campaign = Campaign.create(root, configuration(OBSERVE_ONLY), host({ 'alpha:1b': 'never', 'beta:2b': 'never' }));
    const status = await campaign.run({ runtimeLease: false });

    // A stuck runtime cannot abort a campaign that never asks it to release anything.
    expect(status.state).toBe('complete');
    expect(status.canonical).toBe(false);
    const skipped = campaign.ledger.events().filter((event) => event.kind === 'residencyNotManaged');
    expect(skipped.length).toBe(2);
    expect(String(skipped[0].why)).toMatch(/observe-only/);
    expect(campaign.ledger.events().some((event) => event.kind === 'residencyVerified')).toBe(false);
  });

  it('is a DIFFERENT manifest from its canonical twin, not merely a differently labelled one', () => {
    const canonical = Campaign.create(path.join(root, 'canonical'), configuration(CANONICAL), host());
    const observed = Campaign.create(path.join(root, 'observed'), configuration(OBSERVE_ONLY), host());
    // Same prompts, same scored core, same candidates, same guards, same hardware …
    expect(observed.manifest.promptsDigest).toBe(canonical.manifest.promptsDigest);
    expect(observed.manifest.scoredCoreDigest).toBe(canonical.manifest.scoredCoreDigest);
    expect(observed.manifest.candidatesDigest).toBe(canonical.manifest.candidatesDigest);
    // … and a different identity, because the execution policy is bound into the digest. Two runs
    // that are not comparable cannot present themselves under one seal.
    expect(observed.manifest.executionDigest).not.toBe(canonical.manifest.executionDigest);
    expect(observed.manifest.manifestDigest).not.toBe(canonical.manifest.manifestDigest);
    expect(observed.manifest.manifestID).not.toBe(canonical.manifest.manifestID);
  });

  it('says OBSERVE-ONLY in the one line a person reads aloud, and nothing extra on a canonical one', () => {
    const canonical = Campaign.create(path.join(root, 'canonical'), configuration(CANONICAL), host());
    const observed = Campaign.create(path.join(root, 'observed'), configuration(OBSERVE_ONLY), host());
    expect(manifestSeal(observed.manifest)).toMatch(/· OBSERVE-ONLY$/);
    expect(manifestSeal(canonical.manifest)).not.toContain('OBSERVE-ONLY');
    expect(describeExecutionPolicy(OBSERVE_ONLY)).toContain('noncanonical');
    expect(describeExecutionPolicy(CANONICAL)).toContain('canonical');
  });

  it('labels every ledger row, so a row lifted out of context carries its own comparability', async () => {
    const campaign = Campaign.create(root, configuration(OBSERVE_ONLY), host());
    await campaign.run({ runtimeLease: false });
    const rows = [...campaign.ledger.results.values()];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.canonical).toBe(false);
      expect(row.residencyMode).toBe('observeOnly');
    }
  });

  it('labels the rankings, the counting rules and the retention interpretation', async () => {
    const campaign = Campaign.create(root, configuration(OBSERVE_ONLY), host());
    await campaign.run({ runtimeLease: false });
    const report = campaign.finalize({ blindingSecret: SECRET });

    expect(report.canonical).toBe(false);
    expect(report.noncanonicalBecause).toEqual(NONCANONICAL_REASONS);
    expect(report.rankings.canonical).toBe(false);
    expect(report.rankings.noncanonicalBecause.join(' ')).toMatch(/residency was not managed/);
    // The comparability rule is stated FIRST, because it governs every rule under it.
    expect(report.rankings.countingRules[0]).toMatch(/^OBSERVE-ONLY/);
    expect(report.retention.preamble[0]).toMatch(/^OBSERVE-ONLY/);
    // And it is on disk, not only in the object this call returned.
    const written = JSON.parse(fs.readFileSync(campaignPaths(root).report, 'utf8')) as Record<string, any>;
    expect(written.canonical).toBe(false);
    expect(written.rankings.canonical).toBe(false);
  });

  it('leaves a canonical campaign\'s rankings unlabelled and its rules unchanged', async () => {
    const campaign = Campaign.create(root, configuration(CANONICAL), host());
    await campaign.run({ runtimeLease: false });
    const report = campaign.finalize({ blindingSecret: SECRET });
    expect(report.canonical).toBe(true);
    expect(report.noncanonicalBecause).toEqual([]);
    expect(report.rankings.canonical).toBe(true);
    expect(report.rankings.countingRules[0]).not.toMatch(/OBSERVE-ONLY/);
    expect(report.retention.preamble[0]).not.toMatch(/OBSERVE-ONLY/);
  });

  it('cannot be turned canonical after the freeze by editing the configuration', async () => {
    const campaign = Campaign.create(root, configuration(OBSERVE_ONLY), host());
    // Somebody edits configuration.json to say `managed` and tries to resume.
    const report = Campaign.open(root, configuration(CANONICAL), host()).verify();
    expect(report.intact).toBe(false);
    expect(report.drifts.map((drift) => drift.field)).toContain('executionDigest');
    expect(report.drifts.find((drift) => drift.field === 'executionDigest')!.meaning)
      .toMatch(/neither may be changed after the freeze/);
    // A run under the edited configuration refuses rather than proceeding.
    await expect(Campaign.open(root, configuration(CANONICAL), host()).run({ runtimeLease: false }))
      .rejects.toThrow(/no longer describes this campaign/);
    expect(campaign.canonical).toBe(false);
  });
});

// MARK: - Frozen thinking mode

describe('thinking mode is frozen, and never substituted', () => {
  const pinned = { name: 'm', modelID: 'qwen3:4b', runtimeDigest: 'd', parameterSize: '4B', quantization: 'Q4' };

  it('is bound into the manifest and shown in the seal-adjacent summary', () => {
    const thinking = Campaign.create(path.join(root, 'thinking'), configuration({ residency: 'managed', thinkingMode: 'enabled' }), host());
    const plain = Campaign.create(path.join(root, 'plain'), configuration(CANONICAL), host());
    expect(thinking.manifest.execution?.thinkingMode).toBe('enabled');
    expect(plain.manifest.execution?.thinkingMode).toBe('disabled');
    expect(thinking.manifest.manifestDigest).not.toBe(plain.manifest.manifestDigest);
    expect(describeExecutionPolicy(thinking.execution)).toContain('thinking on');
    expect(describeExecutionPolicy(plain.execution)).toContain('thinking off');
    expect(thinking.status().execution.thinkingMode).toBe('enabled');
  });

  it('refuses a runtime that says it cannot do what was frozen', () => {
    const verification = verifyThinkingMode('enabled', { modelID: 'mistral:7b', capabilities: ['completion', 'tools'] });
    expect(verification.state).toBe('unsupported');
    expect(thinkingModePermitsExecution(verification)).toBe(false);
    expect(verification.detail).toMatch(/cannot think/);
    expect(verification.detail).toMatch(/answers to a different experiment/);
  });

  it('accepts a runtime that says it can', () => {
    const verification = verifyThinkingMode('enabled', { capabilities: ['completion', 'thinking'] });
    expect(verification.state).toBe('supported');
    expect(thinkingModePermitsExecution(verification)).toBe(true);
  });

  it('does not treat an unreported capability list as a refusal', () => {
    const verification = verifyThinkingMode('enabled', { modelID: 'old-runtime:1b' });
    expect(verification.state).toBe('unverifiable');
    expect(thinkingModePermitsExecution(verification)).toBe(true);
    expect(verification.detail).toMatch(/nothing contradicts the request, but nothing confirms it either/);
  });

  it('asks nothing of a model when thinking is off', () => {
    expect(verifyThinkingMode('disabled', { capabilities: ['completion'] }).state).toBe('notRequired');
    expect(verifyThinkingMode('runtimeDefault', {}).state).toBe('notRequired');
  });

  it('reads an unreported capability list as unknown, never as "cannot"', () => {
    expect(modelCanThink({ capabilities: ['thinking'] })).toBe(true);
    expect(modelCanThink({ capabilities: ['completion'] })).toBe(false);
    expect(modelCanThink({})).toBeUndefined();
  });

  it('stops a campaign whose runtime turns out not to support the frozen mode', async () => {
    const cannotThink = host();
    // The host reports capabilities that do not include thinking, as an older or smaller model would.
    const pinnedByName = new Map(configuration(CANONICAL).candidates.map((candidate) => [candidate.name, candidate]));
    cannotThink.observeIdentity = async (candidate) => {
      const known = pinnedByName.get(candidate.name)!;
      // The weights are exactly the pinned ones — only the capability list is the problem, so this
      // proves the thinking preflight stops it rather than the identity check getting there first.
      return {
        name: known.name, modelID: known.modelID, runtimeDigest: known.runtimeDigest,
        parameterSize: known.parameterSize, quantization: known.quantization, capabilities: ['completion'],
      };
    };
    const campaign = Campaign.create(root, configuration({ residency: 'managed', thinkingMode: 'enabled' }), cannotThink);
    const status = await campaign.run({ runtimeLease: false });
    expect(status.state).toBe('aborted');
    expect(campaign.ledger.standingAbort()?.stage).toBe('thinkingModeVerification');
    // Preflight: it stopped BEFORE recording an answer under a configuration it could not honour.
    expect(campaign.ledger.reconcile().terminal).toBe(0);
  });

  it('records the preflight state on every row of a campaign that did run', async () => {
    const campaign = Campaign.create(root, configuration(CANONICAL), host());
    await campaign.run({ runtimeLease: false });
    for (const row of campaign.ledger.results.values()) {
      expect(row.thinkingMode).toBe('disabled');
      expect(row.thinkingModeState).toBe('notRequired');
    }
  });
});

// MARK: - A manifest frozen before any of this existed

describe('a campaign frozen before the policy was bound', () => {
  it('is read as what it actually was — managed residency, thinking off — and does not drift', () => {
    const campaign = Campaign.create(root, configuration(CANONICAL), host());
    const legacy = { ...campaign.manifest } as unknown as Record<string, unknown>;
    delete legacy.execution;
    delete legacy.executionDigest;
    delete legacy.canonical;

    const report = verifyManifest(legacy as unknown as FrozenManifest, { execution: CANONICAL }, '2026-09-11T00:00:00Z');
    // Nothing was frozen to have moved, so its absence is not reported as a drift.
    expect(report.drifts.map((drift) => drift.field)).not.toContain('executionDigest');
    expect(manifestSeal(legacy as unknown as FrozenManifest)).not.toContain('OBSERVE-ONLY');
  });
});
