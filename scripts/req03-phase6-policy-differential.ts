// Cernum REQ-03 Phase 6 · P6-PARITY-FIXTURE — the exact 42-to-60 policy differential.
//
// Reads the pinned parity fixture and the live catalog, and reports every policy the live catalog
// registers that the fixture does not pin, every policy the fixture pins that the catalog no longer
// registers, and every policy whose digest moved. Writes nothing.

import { readFileSync } from 'node:fs';
import { allPolicies, canonicalPolicies, hybridGovernancePolicies, policyCatalog, SCORING_POLICY_VERSION } from '../src/core/catalog';
import { policyDigest } from '../src/core/scoring-policy';
import { HYBRID_GOVERNANCE_POLICY_VERSION } from '../src/core/governance-version';
import { FOUNDATION_V2_SCORING_POLICY_VERSION } from '../src/core/foundation';

interface FixturePolicy { id: string; version: string; digest?: string; [k: string]: unknown }
const fixture = JSON.parse(readFileSync('fixtures/parity/catalog.json', 'utf8')) as {
  policies: FixturePolicy[]; catalogDigest: string;
};

const key = (id: string, version: string) => `${id}@${version}`;
const fixtureByKey = new Map(fixture.policies.map((p) => [key(p.id, p.version), p]));
const liveByKey = new Map(allPolicies.map((p) => [key(p.id, p.version), p]));

const added = [...liveByKey.keys()].filter((k) => !fixtureByKey.has(k)).sort();
const removed = [...fixtureByKey.keys()].filter((k) => !liveByKey.has(k)).sort();
const digestMoved: { key: string; fixture: string; live: string }[] = [];
for (const [k, live] of liveByKey) {
  const fx = fixtureByKey.get(k);
  if (!fx) continue;
  const fxDigest = (fx.digest ?? fx.policyDigest) as string | undefined;
  if (fxDigest && fxDigest !== policyDigest(live)) {
    digestMoved.push({ key: k, fixture: fxDigest, live: policyDigest(live) });
  }
}

// Provenance: which registered set each added policy comes from.
const canonicalKeys = new Set(canonicalPolicies.map((p) => key(p.id, p.version)));
const hybridKeys = new Set(hybridGovernancePolicies.map((p) => key(p.id, p.version)));
function origin(k: string): string {
  if (hybridKeys.has(k)) return `Pass 10 Gate D hybrid-governance twin (version ${HYBRID_GOVERNANCE_POLICY_VERSION})`;
  if (canonicalKeys.has(k)) {
    const p = liveByKey.get(k)!;
    if (p.version === FOUNDATION_V2_SCORING_POLICY_VERSION && p.version !== SCORING_POLICY_VERSION) {
      return `foundation v2 cohort umbrella (version ${FOUNDATION_V2_SCORING_POLICY_VERSION})`;
    }
    return 'canonical version-1 policy';
  }
  return 'UNIDENTIFIED — not in canonicalPolicies or hybridGovernancePolicies';
}

const report = {
  reportFormatVersion: 1,
  artifact: 'CERNUM-REQ-03-PHASE-6-POLICY-DIFFERENTIAL',
  purpose: 'P6-PARITY-FIXTURE: audit every registered policy against the pinned fixture before any rebaseline.',
  fixture: { file: 'fixtures/parity/catalog.json', pinnedPolicies: fixture.policies.length, pinnedCatalogDigest: fixture.catalogDigest },
  live: {
    registeredPolicies: allPolicies.length,
    canonicalPolicies: canonicalPolicies.length,
    hybridGovernanceTwins: hybridGovernancePolicies.length,
    catalogDigest: policyCatalog.catalogDigest(),
  },
  differential: {
    addedCount: added.length,
    removedCount: removed.length,
    digestMovedCount: digestMoved.length,
    added: added.map((k) => ({ policy: k, origin: origin(k), governed: liveByKey.get(k)!.hardGovernance !== undefined, method: liveByKey.get(k)!.method })),
    removed,
    digestMoved,
  },
  unidentified: added.filter((k) => origin(k).startsWith('UNIDENTIFIED')),
};

console.log(JSON.stringify(report, null, 2));
