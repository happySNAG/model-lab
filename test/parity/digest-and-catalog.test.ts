// Parity · digests, canonical encoding, normalization, and the sealed catalog identity — every
// value here was produced by the canonical Swift implementation (`swift run SkippyModelLabParityFixtures`).

import { describe, expect, it } from 'vitest';
import { canonicalJSON, fnv1a64Hex, seal, T0 } from '@core/digest';
import { containsPhrase, excerpt, firstIndex, normalize, tokens } from '@core/text';
import { configurationID, deterministicFake, descriptorDigest, registryAll, skippyRelayGemma } from '@core/candidate';
import { caseDigest, comparabilityKey, packageDigest, suiteDigest } from '@core/benchmark';
import { allGovernedSuites, allPolicies, humanReviewRubrics, policyCatalog } from '@core/catalog';
import { policyDigest } from '@core/scoring-policy';
import { echoInstruction } from '@core/foundation';
import { rubricDigest } from '@core/human-review';
import { loadFixture } from './fixtures';

interface DigestFixture {
  digestVectors: { input: string; fnv1a64Hex: string }[];
  encodingVectors: { name: string; canonicalJSON: string; sealedDigest: string }[];
}
interface NormalizationVector {
  input: string; normalized: string; tokens: string[]; excerpt: string;
  containsPhrase: Record<string, boolean>; firstIndex: Record<string, number | null>;
}
interface CatalogFixture {
  suites: { suiteID: string; version: string; title: string; suiteDigest: string; cases: {
    caseID: string; category: string; caseDigest: string; comparabilityKey: string; inputPackageDigest: string;
    scoringPolicyID: string; scoringPolicyVersion: string; canonicalJSON: string;
  }[] }[];
  policies: { id: string; version: string; method: string; dimension: string; policyDigest: string; canonicalJSON: string }[];
  catalogDigest: string;
  candidates: { id: string; descriptorDigest: string; configurationID: string; canonicalJSON: string }[];
  humanReviewRubricDigests: Record<string, string>;
}

const digest = loadFixture<DigestFixture>('digest.json');
const normalization = loadFixture<NormalizationVector[]>('normalization.json');
const catalog = loadFixture<CatalogFixture>('catalog.json');

describe('FNV-1a-64 digest parity', () => {
  it('reproduces every Swift digest vector', () => {
    for (const vector of digest.digestVectors) expect(fnv1a64Hex(vector.input)).toBe(vector.fnv1a64Hex);
  });
});

describe('canonical JSON parity', () => {
  it('encodes the probe value byte-for-byte like Swift JSONEncoder(.sortedKeys)', () => {
    const probe = {
      z: 'a/b "q" \\ tab\t nl\n cr\r bs\b ff\f ctl del é ü 日本 😀   <>& \'single\'',
      a: -5, optional: undefined, d: '2025-10-09T11:00:00Z', empty: [], dictionary: { b: 2, a: 1, A: 0, _: 3, 'z z': 4 },
      flag: true, nested: [[], ['x']], measurement: { measured: 42 }, measurementMissing: { unavailableReason: 'not reported' },
    };
    const vector = digest.encodingVectors.find((v) => v.name === 'probe')!;
    expect(canonicalJSON(probe)).toBe(vector.canonicalJSON);
    expect(seal(probe, 'test:')).toBe(vector.sealedDigest);
    expect(new Date(T0).toISOString().startsWith('2025-10-09T11:00:00')).toBe(true);
  });
  it('encodes the foundation echo case and both registry rows identically', () => {
    const byName = new Map(digest.encodingVectors.map((v) => [v.name, v]));
    expect(canonicalJSON(echoInstruction)).toBe(byName.get('foundation.echoInstruction')!.canonicalJSON);
    expect(caseDigest(echoInstruction)).toBe(byName.get('foundation.echoInstruction')!.sealedDigest);
    expect(canonicalJSON(deterministicFake)).toBe(byName.get('registry.deterministicFake')!.canonicalJSON);
    expect(descriptorDigest(deterministicFake)).toBe(byName.get('registry.deterministicFake')!.sealedDigest);
    expect(canonicalJSON(skippyRelayGemma)).toBe(byName.get('registry.skippyRelayGemma')!.canonicalJSON);
    expect(descriptorDigest(skippyRelayGemma)).toBe(byName.get('registry.skippyRelayGemma')!.sealedDigest);
  });
});

describe('text normalization parity', () => {
  it('normalizes, tokenizes, excerpts, and matches phrases like Swift', () => {
    for (const vector of normalization) {
      expect(normalize(vector.input), vector.input).toBe(vector.normalized);
      expect(tokens(vector.input), vector.input).toEqual(vector.tokens);
      expect(excerpt(vector.input, 40), vector.input).toBe(vector.excerpt);
      for (const [phrase, expected] of Object.entries(vector.containsPhrase)) {
        expect(containsPhrase(vector.input, phrase), `${vector.input} contains ${phrase}`).toBe(expected);
      }
      for (const [phrase, expected] of Object.entries(vector.firstIndex)) {
        expect(firstIndex(phrase, vector.input), `${vector.input} index of ${phrase}`).toBe(expected);
      }
    }
  });
});

describe('sealed catalog identity parity', () => {
  it('registers exactly the same suites, in the same order, with identical suite digests', () => {
    expect(allGovernedSuites.map((s) => s.id.raw)).toEqual(catalog.suites.map((s) => s.suiteID));
    for (const expected of catalog.suites) {
      const suite = allGovernedSuites.find((s) => s.id.raw === expected.suiteID)!;
      expect(suite.version).toBe(expected.version);
      expect(suite.title).toBe(expected.title);
      expect(suite.cases.map((c) => c.id.raw)).toEqual(expected.cases.map((c) => c.caseID));
      for (const expectedCase of expected.cases) {
        const c = suite.cases.find((x) => x.id.raw === expectedCase.caseID)!;
        expect(canonicalJSON(c), expectedCase.caseID).toBe(expectedCase.canonicalJSON);
        expect(caseDigest(c)).toBe(expectedCase.caseDigest);
        expect(comparabilityKey(c)).toBe(expectedCase.comparabilityKey);
        expect(packageDigest(c.inputs)).toBe(expectedCase.inputPackageDigest);
        expect(c.category).toBe(expectedCase.category);
        expect(c.scoringPolicyID).toBe(expectedCase.scoringPolicyID);
        expect(c.scoringPolicyVersion).toBe(expectedCase.scoringPolicyVersion);
      }
      expect(suiteDigest(suite), expected.suiteID).toBe(expected.suiteDigest);
    }
  });
  it('registers every scoring policy with an identical canonical form and digest', () => {
    expect(policyCatalog.policies.length).toBe(catalog.policies.length);
    expect(allPolicies.length).toBe(catalog.policies.length);
    for (const expected of catalog.policies) {
      const policy = policyCatalog.policy(expected.id, expected.version);
      expect(policy, `${expected.id}@${expected.version}`).toBeDefined();
      expect(canonicalJSON(policy), expected.id).toBe(expected.canonicalJSON);
      expect(policyDigest(policy!)).toBe(expected.policyDigest);
      expect(policy!.method).toBe(expected.method);
      expect(policy!.dimension).toBe(expected.dimension);
    }
    expect(policyCatalog.catalogDigest()).toBe(catalog.catalogDigest);
  });
  it('validates the catalog and every governed suite reference exactly like Swift', () => {
    expect(() => policyCatalog.validate()).not.toThrow();
    expect(() => policyCatalog.validateReferences(allGovernedSuites)).not.toThrow();
  });
  it('registers the same candidate rows with identical digests and configuration ids', () => {
    expect(registryAll.map((c) => c.id.raw)).toEqual(catalog.candidates.map((c) => c.id));
    for (const expected of catalog.candidates) {
      const candidate = registryAll.find((c) => c.id.raw === expected.id)!;
      expect(canonicalJSON(candidate)).toBe(expected.canonicalJSON);
      expect(descriptorDigest(candidate)).toBe(expected.descriptorDigest);
      expect(configurationID(candidate.runtimeConfiguration)).toBe(expected.configurationID);
    }
  });
  it('seals the human-review rubrics identically', () => {
    for (const rubric of humanReviewRubrics) {
      expect(rubricDigest(rubric)).toBe(catalog.humanReviewRubricDigests[`${rubric.id}@${rubric.version}`]);
    }
  });
});
