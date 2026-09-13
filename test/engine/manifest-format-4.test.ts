// Manifest format 4, and the promise it makes to format 3.
//
// THE LOAD-BEARING CLAIM OF THIS FILE is that adding format 4 changed nothing about format 3. Not
// "changed nothing important" — changed NOTHING: the same inputs produce the same bytes, the same
// digest, the same manifest ID and the same seal they produced before this pass existed. Campaigns
// already on disk were frozen under those bytes, and a format bump that quietly reissued their
// identities would invalidate every result they hold.

import { describe, expect, it } from 'vitest';
import {
  FrozenManifest, MANIFEST_FORMAT_VERSION, MANIFEST_FORMAT_VERSION_LOCAL_ONLY,
  MANIFEST_FORMAT_VERSION_WITH_PROVIDERS, ManifestError, ManifestInputs, deriveRetestManifest,
  freezeManifest, manifestBytes, manifestSeal, verifyManifest,
} from '../../src/engine/manifest';
import { buildOperationalEnvelope, operationalEnvelopeDigest } from '../../src/engine/provider';
import { localBinding, meteredBinding, subscriptionBinding } from './frontier-harness';

/**
 * The inputs a Pass 3 campaign froze from.
 *
 * Kept byte-identical to the ones `units.test.ts` uses, so the two files pin the same format-3
 * identity from two directions.
 */
const BASE: ManifestInputs = {
  label: 'cohort',
  catalogDigest: 'catalog-1',
  caseCount: 2,
  repeatsPerCase: 1,
  prompts: [{ caseID: 'b', text: 'second' }, { caseID: 'a', text: 'first', suppliedContext: 'context' }],
  scoredCore: [
    { caseID: 'a', caseDigest: 'da', comparabilityKey: 'ka', scoringMode: 'plainText', maxOutputTokens: 100 },
    { caseID: 'b', caseDigest: 'db', comparabilityKey: 'kb', scoringMode: 'json', maxOutputTokens: 200 },
  ],
  evaluators: [{ evaluatorID: 'e1', source: 'source-1' }],
  candidates: [
    { name: 'alpha:1b', modelID: 'alpha:1b', runtimeDigest: 'digest-alpha:1b', parameterSize: '1B', quantization: 'Q4' },
  ],
  guards: { minimumFreeDiskBytes: 1 },
  hardware: { platform: 'x', architecture: 'y', model: 'z', cpuCoreCount: 8, physicalMemoryBytes: 1, osVersion: 'v' },
  runtimeVersion: 'runtime-1',
  execution: { residency: 'managed', thinkingMode: 'disabled' },
  frozenAt: '2026-01-01T00:00:00Z',
};

/**
 * The exact format-3 identity, RECORDED FROM THE PASS 3 ENGINE ITSELF.
 *
 * Produced by checking out 162d14d4 into a worktree and freezing `BASE` there. It is a recorded
 * vector rather than a value this file recomputes, which is the whole point: a test that recomputed
 * both sides would pass even if format 3 had quietly moved, and format 3 not moving is the promise
 * every campaign already on disk is relying on.
 */
const RECORDED_FORMAT_3_DIGEST = '14a0ccfb566ef74e13460a5fcc67d1e33cc25c70bb89ca02f381ac30148180c6';
const RECORDED_FORMAT_3_ID = 'manifest:14a0ccfb566ef74e';

describe('format 3 is untouched', () => {
  it('still freezes at version 3 when no envelope is supplied', () => {
    const manifest = freezeManifest(BASE);
    expect(manifest.manifestFormatVersion).toBe(MANIFEST_FORMAT_VERSION_LOCAL_ONLY);
    expect(manifest.manifestFormatVersion).toBe(3);
  });

  it('binds no envelope digest at all, rather than binding an empty one', () => {
    const manifest = freezeManifest(BASE);
    expect(manifest.operationalEnvelopeDigest).toBeUndefined();
    expect(manifest.operationalEnvelope).toBeUndefined();
    // The canonical bytes must not carry the key either: a null would change the digest.
    expect(manifestBytes(manifest)).not.toContain('operationalEnvelope');
  });

  it('produces a seal that reads exactly as a Pass 3 seal did', () => {
    expect(manifestSeal(freezeManifest(BASE)))
      .toMatch(/^manifest manifest:[0-9a-f]{16} · catalog \S+ · prompts [0-9a-f]{12} · core [0-9a-f]{12} · candidates [0-9a-f]{12} · hardware [0-9a-f]{12}$/);
  });

  it('is stable: the same inputs freeze to the same identity every time', () => {
    expect(freezeManifest(BASE).manifestDigest).toBe(freezeManifest(BASE).manifestDigest);
    expect(freezeManifest(BASE).manifestID).toBe(freezeManifest(BASE).manifestID);
  });

  it('freezes to the EXACT identity the Pass 3 engine produced, byte for byte', () => {
    const manifest = freezeManifest(BASE);
    expect(manifest.manifestDigest).toBe(RECORDED_FORMAT_3_DIGEST);
    expect(manifest.manifestID).toBe(RECORDED_FORMAT_3_ID);
  });

  it('verifies intact against its own inputs, and is never asked about an envelope it never froze', () => {
    const manifest = freezeManifest(BASE);
    const report = verifyManifest(manifest, {
      catalogDigest: BASE.catalogDigest,
      prompts: BASE.prompts,
      scoredCore: BASE.scoredCore,
      evaluators: BASE.evaluators,
      candidates: BASE.candidates,
      guards: BASE.guards,
      hardware: BASE.hardware,
      runtimeVersion: BASE.runtimeVersion,
      execution: BASE.execution,
      // A live envelope IS offered. A format-3 manifest must not treat its own absence as a drift.
      operationalEnvelope: buildOperationalEnvelope([localBinding('alpha:1b')]),
    }, 'now');
    expect(report.intact).toBe(true);
    expect(report.drifts).toEqual([]);
  });

  it('carries its own version across a retest rather than being reissued at today\'s', () => {
    const original = freezeManifest(BASE);
    const retest = deriveRetestManifest(original, { ...BASE.hardware, model: 'another machine' }, 'runtime-1', '2026-02-01T00:00:00Z', 'new machine');
    expect(retest.manifestFormatVersion).toBe(3);
    expect(retest.operationalEnvelopeDigest).toBeUndefined();
    expect(retest.retestOf?.manifestID).toBe(original.manifestID);
  });
});

describe('format 4 binds the envelope into the identity', () => {
  const envelope = buildOperationalEnvelope([localBinding('alpha:1b')]);
  const withEnvelope: ManifestInputs = { ...BASE, operationalEnvelope: envelope };

  it('freezes at version 4 and carries the envelope and its digest', () => {
    const manifest = freezeManifest(withEnvelope);
    expect(manifest.manifestFormatVersion).toBe(MANIFEST_FORMAT_VERSION_WITH_PROVIDERS);
    expect(MANIFEST_FORMAT_VERSION).toBe(4);
    expect(manifest.operationalEnvelopeDigest).toBe(operationalEnvelopeDigest(envelope));
    expect(manifest.operationalEnvelope?.bindings).toHaveLength(1);
  });

  it('is a DIFFERENT identity from its format-3 twin over identical prompts', () => {
    expect(freezeManifest(withEnvelope).manifestDigest).not.toBe(freezeManifest(BASE).manifestDigest);
  });

  it('is deterministic', () => {
    expect(freezeManifest(withEnvelope).manifestDigest).toBe(freezeManifest(withEnvelope).manifestDigest);
  });

  it('gives a local campaign and an API campaign over the same prompts two different identities', () => {
    const local = freezeManifest({ ...BASE, operationalEnvelope: buildOperationalEnvelope([localBinding('alpha:1b')]) });
    const api = freezeManifest({
      ...BASE,
      candidates: [{ name: 'anthropicAPI:m', modelID: 'm', runtimeDigest: '', parameterSize: '', quantization: '' }],
      operationalEnvelope: buildOperationalEnvelope([meteredBinding('anthropicAPI:m')]),
    });
    expect(local.manifestDigest).not.toBe(api.manifestDigest);
  });

  it('reports a changed binding as a drift that names what moved', () => {
    const manifest = freezeManifest(withEnvelope);
    const report = verifyManifest(manifest, {
      operationalEnvelope: buildOperationalEnvelope([{ ...localBinding('alpha:1b'), maxOutputTokens: 99 }]),
    }, 'now');
    expect(report.intact).toBe(false);
    expect(report.drifts.map((drift) => drift.field)).toContain('operationalEnvelopeDigest');
    expect(report.drifts[0].meaning).toMatch(/a provider, a model identifier, an effort level/);
  });

  it('refuses to freeze a candidate with no binding: nobody could say who would be asked', () => {
    expect(() => freezeManifest({
      ...BASE,
      candidates: [...BASE.candidates, { name: 'beta:2b', modelID: 'beta:2b', runtimeDigest: 'd', parameterSize: '', quantization: '' }],
      operationalEnvelope: envelope,
    })).toThrow(/has no provider binding/);
  });

  it('refuses to freeze a binding for a candidate the campaign will never run', () => {
    expect(() => freezeManifest({
      ...BASE,
      operationalEnvelope: buildOperationalEnvelope([localBinding('alpha:1b'), localBinding('ghost')]),
    })).toThrow(/describes a request that is never made/);
  });

  it('appends provider clauses to the seal only when execution is not purely local', () => {
    const localOnly = manifestSeal(freezeManifest(withEnvelope));
    expect(localOnly).not.toMatch(/providers/);

    const mixedInputs: ManifestInputs = {
      ...BASE,
      candidates: [...BASE.candidates, { name: 'claudeCLI:s', modelID: 's', runtimeDigest: '', parameterSize: '', quantization: '' }],
      operationalEnvelope: buildOperationalEnvelope([localBinding('alpha:1b'), subscriptionBinding('claudeCLI:s')]),
    };
    const mixed = manifestSeal(freezeManifest(mixedInputs));
    expect(mixed).toMatch(/providers claudeCLI\+ollama/);
    expect(mixed).toMatch(/MIXED-EXECUTION/);
  });

  it('carries its version and envelope across a retest', () => {
    const original = freezeManifest(withEnvelope);
    const retest = deriveRetestManifest(original, { ...BASE.hardware, model: 'another' }, 'runtime-1', '2026-02-01T00:00:00Z', 'new machine');
    expect(retest.manifestFormatVersion).toBe(4);
    expect(retest.operationalEnvelopeDigest).toBe(original.operationalEnvelopeDigest);
    expect(retest.operationalEnvelope).toEqual(original.operationalEnvelope);
  });

  it('still refuses the things format 3 refused', () => {
    expect(() => freezeManifest({ ...withEnvelope, prompts: [] })).toThrow(ManifestError);
    expect(() => freezeManifest({ ...withEnvelope, candidates: [] })).toThrow(ManifestError);
  });
});

describe('a format-3 manifest read back off disk behaves exactly as it did', () => {
  it('round-trips through its canonical bytes with its digest unchanged', () => {
    const manifest = freezeManifest(BASE);
    const reread = JSON.parse(manifestBytes(manifest)) as FrozenManifest;
    expect(reread.manifestDigest).toBe(manifest.manifestDigest);
    expect(reread.manifestFormatVersion).toBe(3);
    expect(reread.operationalEnvelope).toBeUndefined();
  });

  it('is verified without an envelope comparison even when one is offered', () => {
    const manifest = freezeManifest(BASE);
    const withLiveEnvelope = verifyManifest(manifest, {
      operationalEnvelope: buildOperationalEnvelope([meteredBinding('anthropicAPI:something-else')]),
    }, 'now');
    // Nothing to compare: the manifest froze no envelope, so nothing about it can have moved.
    expect(withLiveEnvelope.intact).toBe(true);
  });
});
