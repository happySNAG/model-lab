// Proves the engine's canonical encoding is byte-identical to the proven Python harness's.
// Every manifest digest, ledger plan digest and blinding token downstream of this file inherits
// its parity from here, so this is the first test in the engine suite and the one that must never
// be relaxed. The fixture is machine-generated (scripts/regenerate-engine-parity-fixtures.py) and
// is never hand-edited.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CanonicalEncodingFailure, canonicalJSON, digestObject, hmacSha256Hex, sha256Text } from '../../src/engine/canonical';
import type { CanonicalValue } from '../../src/engine/canonical';

interface Vectors {
  pythonVersion: string;
  vectors: { name: string; value: CanonicalValue; canonicalJSON: string; digest: string }[];
  hmacVectors: { secret: string; message: string; hex: string }[];
  textDigests: { text: string; sha256: string }[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../fixtures/parity/engine/canonical-vectors.json', import.meta.url)), 'utf8'),
) as Vectors;

describe('canonical encoding parity with the Python harness', () => {
  it('reads a fixture that was produced by Python, not by hand', () => {
    expect(fixture.pythonVersion).toMatch(/^3\./);
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(12);
  });

  for (const vector of fixture.vectors) {
    it(`encodes "${vector.name}" byte-identically`, () => {
      expect(canonicalJSON(vector.value)).toBe(vector.canonicalJSON);
      expect(digestObject(vector.value)).toBe(vector.digest);
    });
  }

  it('does not escape the solidus, which is where core/digest.ts deliberately differs', () => {
    expect(canonicalJSON('a/b')).toBe('"a/b"');
  });

  for (const [index, vector] of fixture.hmacVectors.entries()) {
    it(`computes HMAC-SHA-256 vector ${index} identically`, () => {
      expect(hmacSha256Hex(vector.secret, vector.message)).toBe(vector.hex);
    });
  }

  for (const vector of fixture.textDigests) {
    it(`digests text ${JSON.stringify(vector.text)} identically`, () => {
      expect(sha256Text(vector.text)).toBe(vector.sha256);
    });
  }
});

describe('canonical encoding refuses what the two runtimes would disagree on', () => {
  it('refuses a non-integer number rather than guess at a float repr', () => {
    expect(() => canonicalJSON(1.5)).toThrow(CanonicalEncodingFailure);
  });
  it('refuses an integer outside the exactly-representable range', () => {
    expect(() => canonicalJSON(2 ** 53)).toThrow(CanonicalEncodingFailure);
  });
  it('refuses a lone surrogate', () => {
    expect(() => canonicalJSON('\ud800')).toThrow(CanonicalEncodingFailure);
  });
  it('omits undefined properties instead of encoding them', () => {
    expect(canonicalJSON({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
