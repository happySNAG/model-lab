// Cernum · Pass 7 · what the proposed OpenCode cohort is estimated to cost, at the provider's
// PUBLISHED prices, WITHOUT creating a campaign, sealing anything, or sending anything.
//
// WHAT THIS SCRIPT IS FOR. The figures in a pass report have to be re-derivable by somebody who was
// not there. `cernum cost <name>` can only price a campaign that already EXISTS on disk, and creating
// one freezes a manifest and seals an admission record — which is precisely the step that has not
// been approved. So the estimate is taken the way `campaign-builder` takes it, through the same
// `buildCampaignPlan` and the same `estimateSpending`, and nothing is written.
//
// WHAT IT DOES NOT DO, ENUMERATED BECAUSE A SCRIPT NAMED AFTER A COHORT INVITES THE ASSUMPTION THAT
// IT RUNS ONE:
//
//   · no campaign directory is created, no manifest is frozen, no admission record is written;
//   · no `SpendingAuthorization` is produced, so nothing here could authorize a paid run;
//   · no provider process is launched — not `opencode`, not `claude`, not `ollama`;
//   · no model is asked anything, and no network request is made.
//
// It reads two things off disk: the sealed benchmark suites, and the committed pricing file. Both are
// in this repository.
//
// -- THE PREVIEW ADMISSION, AND WHY IT IS NOT AN ADMISSION -------------------------------------
//
// `buildCampaignPlan` refuses an unproven candidate unless a sealed admission record names it, and
// every OpenCode candidate is unproven by design. To PRICE the cohort the plan has to be buildable,
// so this script constructs a record in memory whose evidence fields say, in the field values
// themselves, that they are a preview and not evidence. It is never written to disk, it names a
// campaign label that no real campaign uses, and its digest is therefore valid for nothing.
//
// THE REASON THIS IS SAFE TO DO AND UNSAFE TO COPY. A preview that quietly supplied plausible
// evidence strings would be manufacturing the exact artefact the admission design exists to require a
// person to write by hand. That remains true now that all six HAVE been smoked: a real admission
// record cites a real artifact and is sealed by a person, and neither of those happens here — see
// `SMOKE_EVIDENCE` and `EVIDENCE_STATUS` below, which name the artifacts rather than assert them.
// When this was written five of the six had never been sent a request by anything, so no record for
// them could honestly exist at all; the safeguard is unchanged, only the shortfall it guards is.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCampaignPlan } from '../src/engine/campaign-builder';
import { plannedWorkFor } from '../src/engine/campaign-builder';
import { buildEngineCatalogue } from '../src/engine/catalogue';
import { FREE_OPENCODE_DEVELOPMENT_POOL } from '../src/engine/discovery';
import {
  AdmittedCandidateEvidence, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, authorizeIdentityAdmission,
} from '../src/engine/identity-admission';
import {
  OPENCODE_FIRST_LIVE_REQUEST_AT, OPENCODE_FIRST_LIVE_REQUEST_MODEL, OPENCODE_INPUT_BUDGET_DERIVATION,
  OPENCODE_INPUT_FLOOR_DERIVATION,
} from '../src/engine/opencode-cli';
import {
  OPENCODE_CACHE_TIER_TREATMENT, OPENCODE_REPORTED_COST_IS_NOT_A_CHARGE, OPENCODE_ZEN_PRICING_CAPTURED_AT,
  OPENCODE_ZEN_PRICING_SOURCE, POST_RUN_RECONCILIATION_REQUIRED, PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE,
  ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL, assertNoUnpricedTier, openCodePricingFileEntries, publishedPriceFor,
} from '../src/engine/opencode-pricing';
import { pricingFor } from '../src/engine/provider';
import { authorizationDisclosure, estimateSpending, formatMicroUSD } from '../src/engine/spending';

/** The committed capture. Read through the ordinary loader, so the file is validated as a user's would be. */
export const PRICING_FILE = path.join('fixtures', 'pricing', 'opencode-zen-free-pool-2026-09-20.json');

/**
 * The cohort as proposed, in the shape the earlier Pass 7 corrections were already sized against.
 *
 * Six zero-list-price development models on `suite.model-lab.foundation`, which carries FOUR cases, at
 * ONE repeat — so four attempts per candidate and twenty-four in total. Those are the numbers
 * `OPENCODE_INPUT_FLOOR_DERIVATION` cites: 840 prompt characters, a 210-token generic floor, and
 * 31,712 tokens of injected scaffolding per candidate. Changing `REPEATS` here changes the cohort, not
 * the presentation, which is why it is a named constant next to the note saying so.
 */
const SUITES = ['suite.model-lab.foundation'];
const REPEATS = 1;
const PREVIEW_LABEL = 'pass-7-opencode-cost-preview-NOT-A-CAMPAIGN';

/**
 * The smoke artifact each cohort member's evidence rests on.
 *
 * Named here rather than found by scanning a directory. The artifacts live in the user data directory,
 * outside this repository, so a script that went looking would report whatever happened to be on one
 * machine and would call a cohort evidenced because a file was present. These six are the ones the Pass 7
 * admission record cites, and a member of the pool that is not in this table reads as unsmoked.
 */
export const SMOKE_EVIDENCE: Record<string, { artifact: string; capturedAt: string }> = {
  'opencode/big-pickle': { artifact: 'pass07-big-pickle-smoke-20260920T205400Z.json', capturedAt: '2026-09-20T20:52:05Z' },
  'opencode/mimo-v2.5-free': { artifact: 'pass07-mimo-v2.5-free-smoke-20260920T205000Z.json', capturedAt: '2026-09-20T20:49:55Z' },
  'opencode/muse-spark-1.2-contributor-free': { artifact: 'pass07-muse-spark-1.2-smoke-20260920T205500Z.json', capturedAt: '2026-09-20T20:52:16Z' },
  'opencode/muse-spark-1.3-contributor-free': { artifact: 'pass07-muse-spark-1.3-smoke-20260920T205600Z.json', capturedAt: '2026-09-20T20:52:27Z' },
  'opencode/nemotron-3-ultra-free': { artifact: 'pass07-nemotron-3-ultra-free-smoke-20260920T205100Z.json', capturedAt: '2026-09-20T20:50:08Z' },
  'opencode/nemotron-3.5-lightning-free': { artifact: 'pass07-nemotron-3.5-lightning-free-smoke-20260920T205200Z.json', capturedAt: '2026-09-20T20:50:19Z' },
};

/**
 * Which cohort members have execution evidence, and which have none.
 *
 * SIX OF SIX, as of 2026-09-20T20:52Z. Every member of the pool has now been sent exactly one authorized
 * identity smoke, each with `--evidence`, and each came back ACCEPTED and PARSED at
 * `requestAcceptedIdentityUnverifiable`. THAT IS THE WHOLE CLAIM. The request was accepted and something
 * answered; WHICH model answered is not known and cannot be known on this path, because `opencode run
 * --format json` emits no assistant message and a substituted model would return the same bytes. Nothing
 * here is proven or selectable, and scoring these still takes a sealed admission a person writes.
 *
 * This read ONE OF SIX until the six smokes above: only `opencode/big-pickle` had been asked anything, and
 * the other five carried `noRequestEverSent` — a cached catalogue row, a published price, and nothing else.
 * `noRequestEverSent` is kept in the union rather than deleted as unreachable, so a model added to the pool
 * without a smoke reads as what it is instead of inheriting this line's status.
 */
export const EVIDENCE_STATUS: Record<string, 'requestAcceptedIdentityUnverifiable' | 'noRequestEverSent'> =
  Object.fromEntries(FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => [entry.modelID,
    SMOKE_EVIDENCE[entry.modelID] === undefined ? 'noRequestEverSent' : 'requestAcceptedIdentityUnverifiable']));

/** Field values that say what they are. Nothing reads these as evidence, and nothing should. */
const PREVIEW_EVIDENCE = 'PREVIEW-ONLY — this is a cost preview, not an admission; no evidence is asserted here';

function previewAdmitted(): AdmittedCandidateEvidence[] {
  return FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => ({
    provider: 'opencodeCLI' as const,
    requestedModelID: entry.modelID,
    requestedEffort: 'none' as const,
    cliVersion: PREVIEW_EVIDENCE,
    authenticationBasis: PREVIEW_EVIDENCE,
    evidenceDigest: PREVIEW_EVIDENCE,
    evidenceCapturedAt: PREVIEW_EVIDENCE,
    returnedModelID: '' as const,
    state: REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE,
  }));
}

export interface CohortEstimate {
  candidates: number;
  plannedAttemptsPerCandidate: number;
  tokenFloor: number;
  tokenCeiling: number;
  dollarFloorMicroUSD: number;
  dollarCeilingMicroUSD: number;
  pricingSource: string;
  capturedAt: string;
  lines: string[];
}

/** Build the plan and price it. Returns the figures; writes nothing, sends nothing. */
export function estimateCohort(repositoryRoot = process.cwd()): CohortEstimate {
  assertNoUnpricedTier();

  const pricingFile = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, PRICING_FILE), 'utf8')) as Record<string, unknown>;

  // THROUGH THE LOADER, NOT AROUND IT. `pricingFor` is what `cernum create --pricing` calls, and it
  // refuses a row with no source, no capture time, or a non-integer rate. A preview that bypassed it
  // could price a cohort the real command would refuse to.
  const frontier = FREE_OPENCODE_DEVELOPMENT_POOL.map((entry) => {
    const pricing = pricingFor(pricingFile, 'opencodeCLI', entry.modelID);
    if (!pricing) {
      throw new Error(`${PRICING_FILE} carries no loadable pricing row for opencodeCLI:${entry.modelID}. `
        + 'The loader refuses a row missing its source, its capture time, or a non-negative integer rate — '
        + 'and an unpriced metered candidate makes this cohort NOT ESTIMABLE rather than free.');
    }
    return {
      name: `opencodeCLI:${entry.modelID}`,
      provider: 'opencodeCLI',
      modelID: entry.modelID,
      effort: 'none',
      thinkingMode: 'disabled',
      pricing,
    };
  });

  const plan = buildCampaignPlan({
    label: PREVIEW_LABEL,
    suiteIDs: SUITES,
    repeatsPerCase: REPEATS,
    local: [],
    endpoint: 'http://127.0.0.1:11434',
    hardware: {
      platform: process.platform, architecture: process.arch, model: 'preview',
      cpuCoreCount: 1, physicalMemoryBytes: 1, osVersion: 'preview',
    },
    runtimeVersion: 'cost-preview',
    frontier,
    provenModels: [],
    identityAdmission: authorizeIdentityAdmission({
      campaignLabel: PREVIEW_LABEL,
      authorizedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      authorizedBy: PREVIEW_EVIDENCE,
      admitted: previewAdmitted(),
    }),
  } as never);

  const catalogue = buildEngineCatalogue(SUITES, REPEATS);
  const work = plannedWorkFor(catalogue, plan.configuration.candidates.map((c) => c.name), REPEATS);
  const estimate = estimateSpending(plan.envelope, work);
  if (!estimate.estimable) {
    throw new Error(`this cohort is NOT ESTIMABLE:\n${estimate.notEstimableBecause.map((r) => `  · ${r}`).join('\n')}`);
  }

  return {
    candidates: estimate.perCandidate.length,
    plannedAttemptsPerCandidate: work[0]?.plannedAttempts ?? 0,
    tokenFloor: estimate.perCandidate.reduce((sum, e) => sum + e.estimatedInputTokens, 0),
    tokenCeiling: estimate.perCandidate.reduce((sum, e) => sum + e.maximumInputTokens + e.maximumOutputTokens, 0),
    dollarFloorMicroUSD: estimate.totalMinimumMicroUSD,
    dollarCeilingMicroUSD: estimate.totalMaximumMicroUSD,
    pricingSource: OPENCODE_ZEN_PRICING_SOURCE,
    capturedAt: estimate.oldestPricingCapturedAt ?? OPENCODE_ZEN_PRICING_CAPTURED_AT,
    lines: authorizationDisclosure(estimate, 0),
  };
}

/**
 * Re-emit the committed pricing file from the capture module.
 *
 * The file is GENERATED, not hand-maintained, and `pass07-opencode-published-pricing.test.ts` asserts
 * the two are equal — so a wording change in the module fails that test until this is run. Keeping the
 * regeneration command in the repository rather than in somebody's shell history is the difference
 * between a generated file and a file that was generated once.
 *
 *     npx tsx scripts/pass07-opencode-cost-estimate.ts --emit-pricing-file
 *
 * It rewrites prices ONLY from the module's recorded capture. It does not read the live catalogue, and
 * it cannot change a price: a new capture is a new reading, done deliberately, with a new `capturedAt`.
 */
function emitPricingFile(repositoryRoot = process.cwd()): void {
  assertNoUnpricedTier();
  const target = path.join(repositoryRoot, PRICING_FILE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(openCodePricingFileEntries(), null, 2)}\n`);
  process.stdout.write(`rewrote ${PRICING_FILE} from the recorded capture (capturedAt ${OPENCODE_ZEN_PRICING_CAPTURED_AT}).\n`);
}

function main(): void {
  if (process.argv.includes('--emit-pricing-file')) { emitPricingFile(); return; }
  const result = estimateCohort();
  const say = (text = ''): void => { process.stdout.write(`${text}\n`); };

  say('CERNUM · PASS 7 · OPENCODE COHORT COST ESTIMATE (NON-EXECUTING)');
  say('Nothing was created, frozen, sealed, authorized or sent. No model was asked anything.');
  say();
  say(`Cohort              ${result.candidates} OpenCode candidates · ${SUITES.join(', ')} · `
    + `${result.plannedAttemptsPerCandidate} attempt(s) each`);
  say();
  say('DOLLARS (calculated from the PUBLISHED list price)');
  say(`  estimated floor   ${formatMicroUSD(result.dollarFloorMicroUSD)}`);
  say(`  estimated ceiling ${formatMicroUSD(result.dollarCeilingMicroUSD)}`);
  say();
  say('TOKENS (measured magnitudes, independent of any price)');
  say(`  floor             ${result.tokenFloor.toLocaleString('en-US')} input tokens`);
  say(`  ceiling           ${result.tokenCeiling.toLocaleString('en-US')} input + output tokens`);
  say();
  say('PRICING PROVENANCE');
  say(`  source            ${result.pricingSource}`);
  say(`  capturedAt        ${result.capturedAt}`);
  say(`  provenance        publishedCataloguePrice — NOT measured billing`);
  say();
  say('EXECUTION EVIDENCE PER CANDIDATE');
  say('  ACCEPTED AND PARSED is not identity proven: the reply names no model on this path.');
  for (const [modelID, status] of Object.entries(EVIDENCE_STATUS)) {
    const evidence = SMOKE_EVIDENCE[modelID];
    say(`  ${status.padEnd(36)} ${modelID}`);
    say(`  ${' '.repeat(36)}   ${evidence ? `${evidence.artifact} · captured ${evidence.capturedAt}` : 'no artifact'}`);
  }
  say();
  for (const [heading, body] of [
    ['DOES THE $0 LIST PRICE MAKE THE CEILING $0?', ZERO_LIST_PRICE_DOES_NOT_MEAN_ZERO_BILL],
    ['PUBLISHED IS NOT OBSERVED', PUBLISHED_PRICE_IS_NOT_A_MEASURED_CHARGE],
    ['THE ONE FIGURE OPENCODE REPORTED', OPENCODE_REPORTED_COST_IS_NOT_A_CHARGE],
    ['CACHE TIERS', OPENCODE_CACHE_TIER_TREATMENT],
    ['TOKEN CEILING DERIVATION', OPENCODE_INPUT_BUDGET_DERIVATION],
    ['TOKEN FLOOR DERIVATION', OPENCODE_INPUT_FLOOR_DERIVATION],
    ['STILL REQUIRED AFTER ANY RUN', POST_RUN_RECONCILIATION_REQUIRED],
  ] as [string, string][]) {
    say(heading);
    for (const line of wrap(body, 108)) say(`  ${line}`);
    say();
  }
  say('PER-CANDIDATE DISCLOSURE, as a person would read it before authorizing');
  for (const line of result.lines) for (const wrapped of wrap(line, 108)) say(`  ${wrapped}`);
  say();
  say(`First live OpenCode request: ${OPENCODE_FIRST_LIVE_REQUEST_MODEL} on ${OPENCODE_FIRST_LIVE_REQUEST_AT}. `
    + `All ${FREE_OPENCODE_DEVELOPMENT_POOL.length} cohort members have since been smoked once each with --evidence `
    + '(2026-09-20T20:49Z–20:52Z). Each returned a reported cost of zero in an UNDECLARED UNIT, which corroborates '
    + 'the published zero no more than it would corroborate any other number — no charge was observed for any of them.');
  say(`Pricing file: ${PRICING_FILE} · published price for `
    + `${FREE_OPENCODE_DEVELOPMENT_POOL.filter((e) => publishedPriceFor(e.modelID)).length} of `
    + `${FREE_OPENCODE_DEVELOPMENT_POOL.length} cohort members.`);
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length > 0 && current.length + 1 + word.length > width) { lines.push(current); current = word; }
    else current = current.length === 0 ? word : `${current} ${word}`;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

if (process.argv[1] && /pass07-opencode-cost-estimate\.ts$/.test(process.argv[1])) main();
