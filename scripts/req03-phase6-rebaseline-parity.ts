// Cernum REQ-03 Phase 6 · P6-PARITY-FIXTURE — the APPROVED parity rebaseline.
//
// Authority: Seth J. Leopold, 2026-09-16 — "Adopt Gate D (§4 option A), then rebaseline."
//
// WHAT THIS DOES NOT DO: it does not touch one byte of the Swift-derived corpus. All 42 policies
// captured from `swift run SkippyModelLabParityFixtures` keep their canonical JSON, their digests and
// their order, and the sub-catalog they form still seals to `mlspc1:42c16e06a941b143`. The
// cross-implementation evidence — the only evidence in this repository that two independently written
// engines agree to the byte — survives this rebaseline intact.
//
// WHAT IT ADDS: the 40 generation-2 twins, which have no Swift counterpart and never did, pinned in a
// separate section that says so. The registry assertion then compares against 42 + 40 rather than
// against 42, and the whole registry's digest is pinned alongside the vintage's.
//
// The result is a STRONGER corpus than before: the additions are now pinned too, where previously they
// were merely the reason a test failed.

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalJSON } from '../src/core/digest';
import { allPolicies, canonicalPolicies, generation2Policies, policyCatalog } from '../src/core/catalog';
import { ScoringPolicyCatalog, policyDigest } from '../src/core/scoring-policy';

const PATH = 'fixtures/parity/catalog.json';
const fixture = JSON.parse(readFileSync(PATH, 'utf8'));

const vintageDigest = new ScoringPolicyCatalog(canonicalPolicies).catalogDigest();
if (vintageDigest !== fixture.catalogDigest) {
  throw new Error(`REFUSING TO REBASELINE: the Swift vintage sub-catalog now seals to ${vintageDigest}, `
    + `not the pinned ${fixture.catalogDigest}. A sealed policy moved. This rebaseline only ever ADDS.`);
}
for (const expected of fixture.policies) {
  const live = policyCatalog.policy(expected.id, expected.version);
  if (!live) throw new Error(`REFUSING TO REBASELINE: sealed policy ${expected.id}@${expected.version} is no longer registered.`);
  if (canonicalJSON(live) !== expected.canonicalJSON) throw new Error(`REFUSING TO REBASELINE: ${expected.id}@${expected.version} canonical form moved.`);
  if (policyDigest(live) !== expected.policyDigest) throw new Error(`REFUSING TO REBASELINE: ${expected.id}@${expected.version} digest moved.`);
}

fixture.postVintagePolicies = generation2Policies.map((p) => ({
  id: p.id, version: p.version, method: p.method, dimension: p.dimension,
  policyDigest: policyDigest(p), canonicalJSON: canonicalJSON(p),
}));
fixture.registryCatalogDigest = policyCatalog.catalogDigest();
fixture.rebaseline = {
  rebaselineFormatVersion: 1,
  approvedBy: 'Seth J. Leopold',
  approvedAt: '2026-09-16',
  authority: 'Cernum REQ-03 Phase 6 · P6-PARITY-FIXTURE — "Adopt Gate D (§4 option A), then rebaseline."',
  swiftVintage: {
    policies: fixture.policies.length,
    catalogDigest: fixture.catalogDigest,
    statement: 'Byte-identical to the captured Swift corpus. Not regenerated, not hand-edited, not reordered.',
  },
  postVintage: {
    policies: generation2Policies.length,
    origin: 'TypeScript-only. Generation-2 twins adopted by Cernum Pass 10 Gate D and REQ-03 Phase 5; '
          + 'no Swift counterpart exists and none is claimed.',
    crossImplementationEvidence: 'NONE for these rows. They are pinned against regression, not against a second implementation.',
  },
  registry: { policies: allPolicies.length, catalogDigest: policyCatalog.catalogDigest() },
};

writeFileSync(PATH, JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify({
  swiftVintagePolicies: fixture.policies.length,
  swiftVintageCatalogDigest: fixture.catalogDigest,
  postVintagePolicies: fixture.postVintagePolicies.length,
  registryPolicies: allPolicies.length,
  registryCatalogDigest: fixture.registryCatalogDigest,
}, null, 2));
