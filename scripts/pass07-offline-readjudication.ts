// Cernum Pass 7 · re-read the sealed Pass 6 ledger, and change nothing about it.
//
// WHAT THIS ANSWERS. Pass 6 finished 48 of 48 attempts and published two figures it should not have:
// an input-token column that was the fresh remainder on both providers, and a single ranking whose
// entire ordering turned on whether a correct JSON object arrived inside a markdown fence. Both are
// recoverable from the evidence Pass 6 sealed, because every row kept the provider's usage block
// verbatim and every row kept the answer text.
//
// WHAT IT MAY NOT DO. It may not write to the sealed ledger, and it does not: the file is opened
// read-only, its digest is taken before and after, and the run FAILS if the two differ. The Pass 6
// rankings, retention and reports stand exactly as published. This produces a SEPARATE artefact
// under the Pass 7 evidence directory, labelled as a re-reading rather than a correction of the
// record — the Pass 6 numbers were correctly derived from a defective measurement, and rewriting
// them would destroy the only evidence of what the defect did.
//
// The allowance is NOT recoverable here, and the artefact says so rather than leaving a gap a reader
// might fill with a zero: Pass 6 kept `parsed.usage`, and Claude Code's `total_cost_usd` is an
// envelope-level field that sits outside it. That value is gone for those 48 attempts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { totalInputTokens } from '../src/engine/frontier-adapter';
import { readCodexUsage } from '../src/engine/codex-cli';
import { adjudicateJSONViews } from '../src/engine/json-views';
import { rankCandidates, RankableOutcome, RankingView } from '../src/engine/ranking';
import { buildEngineCatalogue } from '../src/engine/catalogue';
import { PlanSlot, TerminalSlotStatus } from '../src/engine/ledger';

const sealedLedger = process.argv[2];
const outputFile = process.argv[3];
if (!sealedLedger || !outputFile) {
  process.stderr.write('usage: tsx pass07-offline-readjudication.ts <pass06 results.jsonl> <output.json>\n');
  process.exit(2);
}

const digestOf = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digestBefore = digestOf(sealedLedger);

interface Row {
  slotKey: string; candidate: string; caseID: string; suite: string; pass: number; status: string;
  provider: string; answerText: string; inputTokens?: number; visibleOutputTokens?: number;
  reasoningTokens?: number; latencyMilliseconds?: number; bindingIdentityState?: string;
  providerReportedUsage?: Record<string, unknown>;
  comparabilityKey?: string; caseDigest?: string;
}

const rows: Row[] = fs.readFileSync(sealedLedger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row);

// The Claude envelope's decomposition. `input_tokens` is the FRESH remainder and the cache fields are
// additional; the Codex reader is the engine's own, because that tool means the opposite by the same
// field name and a second opinion about it here is how the two drift.
function usageOf(row: Row) {
  const usage = row.providerReportedUsage ?? {};
  const n = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  if (row.provider === 'codexCLI') return readCodexUsage(usage);
  return {
    inputTokens: n(usage.input_tokens),
    cacheCreationInputTokens: n(usage.cache_creation_input_tokens),
    cacheReadInputTokens: n(usage.cache_read_input_tokens),
    visibleOutputTokens: n(usage.output_tokens),
  };
}

const catalogue = buildEngineCatalogue(['suite.model-lab.foundation-v2'], 1);

const readjudicated = rows.map((row) => {
  const usage = usageOf(row);
  const slot: PlanSlot = {
    slotIndex: 0, slotKey: row.slotKey, candidate: row.candidate, modelID: '', suite: row.suite,
    block: 'frontier', pass: row.pass, caseID: row.caseID, caseDigest: row.caseDigest ?? '',
    comparabilityKey: row.comparabilityKey ?? '', scoringMode: 'deterministic',
    maxOutputTokens: 1_024, inputBudgetTokens: 4_096, status: 'planned',
  };
  const benchmarkCase = catalogue.cases.get(row.caseID);
  const views = benchmarkCase === undefined ? undefined : adjudicateJSONViews({
    benchmarkCase, slot, answerText: row.answerText, strictStatus: row.status as TerminalSlotStatus,
  });
  return {
    slotKey: row.slotKey,
    candidate: row.candidate,
    caseID: row.caseID,
    provider: row.provider,
    // What the sealed ledger says, kept beside the correction rather than replaced by it.
    pass06RecordedInputTokens: row.inputTokens,
    correctedTotalInputTokens: totalInputTokens(usage),
    freshInputTokens: usage.inputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    visibleOutputTokens: row.visibleOutputTokens,
    reasoningTokens: row.reasoningTokens,
    latencyMilliseconds: row.latencyMilliseconds,
    strictTransportStatus: row.status,
    semanticSchemaStatus: views?.semanticSchemaStatus,
    jsonCase: views !== undefined,
    fenceRemoved: views?.fenceRemoved ?? false,
    divergent: views?.divergent ?? false,
    divergenceExplanation: views?.divergent === true ? views.divergenceExplanation : undefined,
    // Absent, with the reason stated. See the header: this is not a gap to be filled with zero.
    subscriptionIncludedUsageMicroUSD: null,
    allowanceUnavailableBecause:
      'Pass 6 kept `parsed.usage` as the row\'s verbatim provider block, and Claude Code reports its list '
      + 'valuation in the envelope-level `total_cost_usd` OUTSIDE that block. The value existed at request time '
      + 'and was not persisted, so it is unrecoverable for these 48 attempts. It is not zero.',
  };
});

const outcomes: RankableOutcome[] = readjudicated.map((entry) => ({
  candidate: entry.candidate,
  caseID: entry.caseID,
  dimension: catalogue.dimensions.get(entry.caseID)!,
  status: entry.strictTransportStatus,
  semanticStatus: entry.semanticSchemaStatus,
  viewsDivergent: entry.divergent,
  governanceViolated: false,
  latencyMilliseconds: entry.latencyMilliseconds,
  identityState: rows.find((row) => row.slotKey === entry.slotKey)?.bindingIdentityState,
}));

const derivedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
// No reconciliation is supplied on purpose: these rankings are a re-reading of a sealed ledger this
// process did not run, so they are PROVISIONAL by the engine's own rule and say so.
const table = (view: RankingView) => rankCandidates({ outcomes, derivedAt, view });

const sumBy = (provider: string, pick: (entry: typeof readjudicated[number]) => number | undefined): number =>
  readjudicated.filter((entry) => entry.provider === provider).reduce((sum, entry) => sum + (pick(entry) ?? 0), 0);

const artefact = {
  what: 'Cernum Pass 7 offline re-adjudication of the SEALED Pass 6 frontier pilot. A re-reading, not a correction '
    + 'of the record: the Pass 6 ledger, rankings, retention and reports stand exactly as published.',
  sealedLedger: path.resolve(sealedLedger),
  sealedLedgerDigestBefore: digestBefore,
  attemptCount: readjudicated.length,
  derivedAt,
  tokenAccounting: {
    note: 'The Pass 6 report published the Claude undercount and called the Codex column exact. It was not: one '
      + 'line understated BOTH providers, by different factors, in a column that looked like-for-like.',
    claude: {
      attempts: readjudicated.filter((entry) => entry.provider === 'claudeCLI').length,
      pass06Recorded: sumBy('claudeCLI', (entry) => entry.pass06RecordedInputTokens),
      corrected: sumBy('claudeCLI', (entry) => entry.correctedTotalInputTokens),
      fresh: sumBy('claudeCLI', (entry) => entry.freshInputTokens),
      cacheCreation: sumBy('claudeCLI', (entry) => entry.cacheCreationInputTokens),
      cacheRead: sumBy('claudeCLI', (entry) => entry.cacheReadInputTokens),
    },
    codex: {
      attempts: readjudicated.filter((entry) => entry.provider === 'codexCLI').length,
      pass06Recorded: sumBy('codexCLI', (entry) => entry.pass06RecordedInputTokens),
      corrected: sumBy('codexCLI', (entry) => entry.correctedTotalInputTokens),
      fresh: sumBy('codexCLI', (entry) => entry.freshInputTokens),
      cacheCreation: sumBy('codexCLI', (entry) => entry.cacheCreationInputTokens),
      cacheRead: sumBy('codexCLI', (entry) => entry.cacheReadInputTokens),
    },
  },
  allowance: {
    obtained: false,
    because: readjudicated[0]?.allowanceUnavailableBecause,
  },
  jsonViews: {
    jsonCaseCount: readjudicated.filter((entry) => entry.jsonCase).length,
    divergentCount: readjudicated.filter((entry) => entry.divergent).length,
    divergences: readjudicated.filter((entry) => entry.divergent).map((entry) => ({
      candidate: entry.candidate, caseID: entry.caseID,
      strict: entry.strictTransportStatus, semantic: entry.semanticSchemaStatus,
      fenceRemoved: entry.fenceRemoved,
    })),
  },
  strictTransportRanking: table('strictTransport'),
  semanticSchemaRanking: table('semanticSchema'),
  attempts: readjudicated,
};

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(path.resolve(outputFile), `${JSON.stringify(artefact, null, 2)}\n`, 'utf8');

// Proof, not assertion. The sealed ledger is re-digested AFTER everything above has run.
const digestAfter = digestOf(sealedLedger);
if (digestAfter !== digestBefore) {
  process.stderr.write(`REFUSED: the sealed Pass 6 ledger changed during this run.\n  before ${digestBefore}\n  after  ${digestAfter}\n`);
  process.exit(1);
}
process.stdout.write(`re-adjudicated ${readjudicated.length} sealed Pass 6 attempts\n`);
process.stdout.write(`sealed ledger digest unchanged: ${digestAfter}\n`);
process.stdout.write(`written to ${path.resolve(outputFile)}\n`);
