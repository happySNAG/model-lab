// Cernum Pass 8 · the figures a report needs and a ledger does not hold.
//
// Three jobs, all read-only against sealed campaign evidence:
//
//   1  JOIN the OTLP observations onto the attempts that produced them. The Codex CLI's trace spans
//      arrive seconds after an attempt closes, so the row records a correlation key and the join
//      happens here. See `otlp-observer.ts` for why that is the design rather than a longer wait.
//   2  CONFIDENCE INTERVALS on every pass rate. A rate over 88 observations and a rate over 44 are
//      not the same claim, and a leaderboard that prints both as bare percentages invites a reader
//      to rank differences that the sample cannot support. Wilson score intervals, because the
//      normal approximation is wrong at exactly the rates a good model produces.
//   3  REPEAT VARIANCE, which only Campaign A can have: two passes over one case, and the question
//      of how often they disagree. This is the first variance figure this project has ever had.
//
// NOTHING HERE MODIFIES A CAMPAIGN. Every input is opened read-only and digested before and after.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { attributeSets } from '../src/engine/otlp-observer';

interface Row { [key: string]: unknown }

const campaignDirectory = process.argv[2];
const outputFile = process.argv[3];
const otlpIndexFile = process.argv[4];
if (!campaignDirectory || !outputFile) {
  process.stderr.write('usage: tsx pass08-analysis.ts <campaign dir> <output.json> [otlp index.json] [otlp payloads.jsonl]\n');
  process.exit(2);
}

const resultsFile = path.join(campaignDirectory, 'ledger', 'results.jsonl');
const digestOf = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const digestBefore = digestOf(resultsFile);

const rows: Row[] = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row);
const text = (row: Row, key: string): string | undefined => (typeof row[key] === 'string' ? row[key] as string : undefined);
const count = (row: Row, key: string): number | undefined => (typeof row[key] === 'number' ? row[key] as number : undefined);

/**
 * Wilson score interval at 95%.
 *
 * Not the normal approximation, and the reason is the rates that matter: at 0 of 44 or 44 of 44 the
 * textbook interval has zero width, which would let a report claim certainty from a small sample
 * precisely where it has least. Wilson keeps a width there.
 */
export function wilson(successes: number, trials: number): { low: number; high: number; width: number } | undefined {
  if (trials === 0) return undefined;
  const z = 1.959963984540054;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  const low = Math.max(0, centre - spread);
  const high = Math.min(1, centre + spread);
  return { low, high, width: high - low };
}

const candidates = [...new Set(rows.map((row) => text(row, 'candidate') ?? ''))].filter(Boolean).sort();

// MARK: - Quality, with an interval on every rate

const strictOf = (row: Row): string => String(row.status);
const semanticOf = (row: Row): string => text(row, 'jsonSemanticSchemaStatus') ?? String(row.status);

function rate(mine: Row[], statusOf: (row: Row) => string) {
  // THE ENGINE'S OWN COUNTING RULE, so the interval attaches to the rate the report publishes.
  //
  // `rankCandidates` excludes a governance-violating outcome from the dimension rate and then
  // disqualifies the candidate outright — the violation is a disqualification, not a low score. A
  // second opinion about the denominator here would produce a percentage that appears nowhere in
  // `rankings.json` and cannot be checked against it.
  //
  // The all-scored rate is computed too, and published beside it. On this campaign the two differ
  // by 9 to 12 points, entirely because of the governance rows — which the governance finding says
  // are dominated by false positives. A reader is entitled to both bounds.
  const qualified = mine.filter((row) => row.governanceViolated !== true);
  const tally = (pool: Row[]) => {
    const awaiting = pool.filter((row) => statusOf(row) === 'requiresHumanReview').length;
    const notApplicable = pool.filter((row) => ['unsupported', 'notApplicable'].includes(statusOf(row))).length;
    const scored = pool.length - awaiting - notApplicable;
    const passes = pool.filter((row) => statusOf(row) === 'pass').length;
    const partials = pool.filter((row) => statusOf(row) === 'partial').length;
    const interval = wilson(passes, scored);
    return {
      scored, passes, partials, fails: scored - passes - partials, awaitingHumanReview: awaiting,
      passRate: scored === 0 ? null : Number((passes / scored).toFixed(4)),
      confidence95: interval === undefined ? null : {
        low: Number(interval.low.toFixed(4)), high: Number(interval.high.toFixed(4)),
        width: Number(interval.width.toFixed(4)),
      },
    };
  };
  const published = tally(qualified);
  const allScored = tally(mine);
  return {
    attempts: mine.length,
    // The engine's published figure, and the interval that belongs to it.
    ...published,
    countingRule: 'the engine\'s: governance-violating outcomes are excluded from the rate and disqualify the '
      + 'candidate instead. This is the rate in rankings.json.',
    allScoredIncludingGovernanceRows: allScored,
    governanceViolations: mine.filter((row) => row.governanceViolated === true).length,
    governanceViolatingCases: [...new Set(mine.filter((row) => row.governanceViolated === true)
      .map((row) => text(row, 'caseID') ?? ''))].sort(),
    disqualified: mine.some((row) => row.governanceViolated === true),
  };
}

// MARK: - Repeat variance

/**
 * How often two passes over the SAME case by the SAME candidate disagree.
 *
 * Present only where `repeatsPerCase` was above one. It is the figure that says how much of a
 * published difference between two candidates is real and how much is the run.
 */
function repeatVariance(mine: Row[], statusOf: (row: Row) => string) {
  const byCase = new Map<string, string[]>();
  for (const row of mine) {
    const caseID = text(row, 'caseID') ?? '';
    byCase.set(caseID, [...(byCase.get(caseID) ?? []), statusOf(row)]);
  }
  const pairs = [...byCase.entries()].filter(([, statuses]) => statuses.length === 2);
  const disagreed = pairs.filter(([, statuses]) => statuses[0] !== statuses[1]);
  const flipped = pairs.filter(([, statuses]) => (statuses[0] === 'pass') !== (statuses[1] === 'pass'));
  return {
    casesWithTwoPasses: pairs.length,
    disagreedOnStatus: disagreed.length,
    flippedPassFail: flipped.length,
    disagreementRate: pairs.length === 0 ? null : Number((disagreed.length / pairs.length).toFixed(4)),
    passFlipRate: pairs.length === 0 ? null : Number((flipped.length / pairs.length).toFixed(4)),
    flippedCases: flipped.map(([caseID, statuses]) => ({ caseID, first: statuses[0], second: statuses[1] })),
  };
}

// MARK: - Cost, tokens, latency

function economics(mine: Row[]) {
  const sum = (key: string): number => mine.reduce((total, row) => total + (count(row, key) ?? 0), 0);
  const allowances = mine.map((row) => count(row, 'subscriptionIncludedUsageMicroUSD'));
  const everyAttemptReported = allowances.every((value) => value !== undefined);
  const median = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  return {
    inputTokensAll: sum('inputTokens'),
    freshInputTokens: sum('freshInputTokens'),
    cacheCreationInputTokens: sum('cacheCreationInputTokens'),
    cacheReadInputTokens: sum('cacheReadInputTokens'),
    visibleOutputTokens: sum('visibleOutputTokens'),
    reasoningTokens: sum('reasoningTokens'),
    // The marginal API charge. A true zero on a subscription, and reported as measured rather than absent.
    marginalAPIChargeMicroUSD: sum('costMicroUSD'),
    // NOT summed when any attempt failed to report one: a partial total presented as a total is the
    // defect Pass 7 existed to correct.
    subscriptionAllowanceMicroUSD: everyAttemptReported
      ? allowances.reduce<number>((total, value) => total + (value ?? 0), 0) : null,
    subscriptionAllowanceReportedOn: allowances.filter((value) => value !== undefined).length,
    subscriptionAllowanceMissingOn: allowances.filter((value) => value === undefined).length,
    // What the person actually paid at the margin: unknown for a subscription, and never zero.
    effectiveUserCost: 'not derivable — a share of a flat plan fee cannot be computed from one request',
    retries: sum('retryCount'),
    wastedTokens: sum('wastedTokens'),
    timeouts: mine.filter((row) => row.timedOut === true).length,
    medianTimeToFirstOutputMilliseconds: median(mine.map((row) => count(row, 'timeToFirstTokenMilliseconds'))
      .filter((value): value is number => value !== undefined)),
    medianWallMilliseconds: median(mine.map((row) => count(row, 'latencyMilliseconds'))
      .filter((value): value is number => value !== undefined)),
    totalWallMilliseconds: sum('latencyMilliseconds'),
  };
}

// MARK: - The OTLP join

const otlpIndex: Record<string, Record<string, unknown>> = otlpIndexFile !== undefined && fs.existsSync(otlpIndexFile)
  ? JSON.parse(fs.readFileSync(otlpIndexFile, 'utf8')) as Record<string, Record<string, unknown>>
  : {};

/**
 * WHAT THE TELEMETRY CAN AND CANNOT ATTRIBUTE, established on Campaign B's own payloads.
 *
 * Pass 7 concluded that `codex.turn.reasoning_effort` makes effort obtainable. That is true, and
 * Pass 7 overstated what follows from it: the span carrying the effort carries NO `conversation.id`
 * — only an OS-level `thread.id` — and the trace payloads carry no conversation identifier at
 * resource level either. Proven here over 260 such spans: 260 carry the effort, 0 carry a
 * conversation id.
 *
 * So the effort is verifiable IN AGGREGATE and not per attempt. Cernum publishes the aggregate and
 * refuses the per-attempt claim. Ordering would suggest one — the campaign is strictly sequential,
 * so the k-th span is almost certainly the k-th turn — but "almost certainly" is not the standard
 * this engine uses for attribution, and a benchmark that attributed by ordering would be a benchmark
 * whose attribution nobody could check.
 */
function otlpPerAttempt(mine: Row[]) {
  const observed = mine.filter((row) => row.otlpObserved === true);
  const joined = observed.map((row) => {
    const key = text(row, 'otlpCorrelationKey');
    const observation = key === undefined ? undefined : otlpIndex[key];
    return { row, observation };
  }).filter((entry): entry is { row: Row; observation: Record<string, unknown> } => entry.observation !== undefined);

  const effortAgrees = joined.filter((entry) => {
    const binding = text(entry.row, 'candidate')?.split('@')[1] ?? 'none';
    return entry.observation.turnReasoningEffort === binding;
  });
  const tokensAgree = joined.filter((entry) =>
    typeof entry.observation.nonCachedInputTokens === 'number'
    && entry.observation.nonCachedInputTokens === count(entry.row, 'freshInputTokens'));
  const withEffort = joined.filter((entry) => typeof entry.observation.turnReasoningEffort === 'string');

  return {
    attemptsObserved: observed.length,
    attemptsJoined: joined.length,
    // Zero on this interface, and that is a finding rather than a fault. See the note above.
    attemptsWithReportedEffort: withEffort.length,
    perAttemptEffortAttributable: withEffort.length > 0,
    perAttemptNote: withEffort.length > 0 ? ''
      : 'The span carrying codex.turn.reasoning_effort carries no conversation.id, so no effort figure can be '
        + 'attributed to a specific attempt. The aggregate is reported at campaign level instead.',
    reportedEfforts: [...new Set(withEffort.map((entry) => String(entry.observation.turnReasoningEffort)))].sort(),
    effortMatchesFrozenBinding: effortAgrees.length,
    effortMismatches: withEffort.length - effortAgrees.length,
    tokenDecompositionAgreesWithStdout: tokensAgree.length,
    tokenDecompositionCheckable: joined.filter((entry) => typeof entry.observation.nonCachedInputTokens === 'number').length,
    // This DOES arrive on a log record beside the conversation id, so it is attributable.
    mcpServers: [...new Set(joined.map((entry) => String(entry.observation.mcpServers ?? '')).filter(Boolean))].sort(),
    // Stated on every summary, because this is the figure a reader is most likely to over-read.
    identityEstablished: false,
    identityNote: 'The telemetry names the model this client REQUESTED. It is not a model naming itself in a '
      + 'reply, so it establishes no identity and every Codex row remains requestAcceptedIdentityUnverifiable.',
  };
}

/**
 * The campaign-level effort check: what the manifest FROZE against what the tool says it APPLIED.
 *
 * Read straight from the redacted payload file rather than from the join index, because the figures
 * live on spans the index cannot key. Every attempt that produced no turn at all is subtracted from
 * the frozen side first — a turn that never happened has no effort to report.
 */
function otlpAggregate(payloadFile: string | undefined, rows: Row[]) {
  if (payloadFile === undefined || !fs.existsSync(payloadFile)) return null;
  const turnEfforts: Record<string, number> = {};
  const requestEfforts: Record<string, number> = {};
  let turnSpans = 0;
  let turnSpansWithConversationID = 0;
  // Streamed a line at a time: this file is hundreds of megabytes on a full campaign, and splitting it
  // in memory would make the analysis the reason the disk guard fired.
  const stream = fs.readFileSync(payloadFile, 'utf8');
  for (const line of stream.split('\n')) {
    if (line.length === 0 || !line.includes('reasoning_effort')) continue;
    const payload = (JSON.parse(line) as { json?: unknown }).json;
    for (const attributes of attributeSetsOf(payload)) {
      const turn = attributes['codex.turn.reasoning_effort'];
      if (typeof turn === 'string') {
        turnEfforts[turn] = (turnEfforts[turn] ?? 0) + 1;
        turnSpans += 1;
        if (typeof attributes['conversation.id'] === 'string') turnSpansWithConversationID += 1;
      }
      const request = attributes['codex.request.reasoning_effort'];
      if (typeof request === 'string') requestEfforts[request] = (requestEfforts[request] ?? 0) + 1;
    }
  }
  const effortOf = (row: Row): string => {
    const candidate = text(row, 'candidate') ?? '';
    return candidate.includes('@') ? candidate.slice(candidate.lastIndexOf('@') + 1) : 'none';
  };
  const frozen: Record<string, number> = {};
  const producedATurn: Record<string, number> = {};
  for (const row of rows) {
    const effort = effortOf(row);
    frozen[effort] = (frozen[effort] ?? 0) + 1;
    // A turn that the service refused outright produced no span and no effort to report. A turn the
    // engine refused to SCORE (tool contamination) still happened, so it counts here.
    const refusedBeforeATurn = String(row.status) === 'runtimeError'
      && (text(row, 'detail') ?? '').includes('turn.failed');
    if (!refusedBeforeATurn) producedATurn[effort] = (producedATurn[effort] ?? 0) + 1;
  }
  const matches = Object.keys(producedATurn).every((effort) => producedATurn[effort] === (turnEfforts[effort] ?? 0));
  return {
    turnSpansCarryingEffort: turnSpans,
    turnSpansCarryingAConversationID: turnSpansWithConversationID,
    perAttemptAttributionPossible: turnSpansWithConversationID > 0,
    effortsTheToolReportsApplying: turnEfforts,
    effortsOnRequestSpans: requestEfforts,
    effortsTheManifestFroze: frozen,
    frozenExcludingAttemptsThatProducedNoTurn: producedATurn,
    aggregateMatchesExactly: matches,
    note: matches
      ? 'The efforts the tool reports applying match the efforts the manifest froze, exactly, once the attempts '
        + 'the service refused before a turn began are subtracted. This is the first verification of applied '
        + 'effort on a Codex cohort. It is an AGGREGATE check and is not attribution to any single attempt.'
      : 'The aggregate does NOT match. Investigate before any effort claim is made.',
  };
}

/** `attributeSets` from the engine, re-exported through this script so it reads one payload shape. */
function attributeSetsOf(payload: unknown): Record<string, unknown>[] {
  return attributeSets(payload);
}

// MARK: - Assemble

const perCandidate = candidates.map((candidate) => {
  const mine = rows.filter((row) => text(row, 'candidate') === candidate);
  return {
    candidate,
    identityState: text(mine[0], 'bindingIdentityState') ?? 'verified',
    reportedModelID: text(mine[0], 'reportedModelID') ?? '',
    strict: rate(mine, strictOf),
    semantic: rate(mine, semanticOf),
    repeatVarianceStrict: repeatVariance(mine, strictOf),
    repeatVarianceSemantic: repeatVariance(mine, semanticOf),
    economics: economics(mine),
    otlp: otlpPerAttempt(mine),
  };
});

const humanReview = rows.filter((row) => String(row.status) === 'requiresHumanReview')
  .map((row) => ({ candidate: text(row, 'candidate'), caseID: text(row, 'caseID'), pass: count(row, 'pass') }));
const governance = rows.filter((row) => row.governanceViolated === true)
  .map((row) => ({
    candidate: text(row, 'candidate'), caseID: text(row, 'caseID'), pass: count(row, 'pass'),
    status: String(row.status), detail: text(row, 'detail'),
    kind: String(text(row, 'detail') ?? '').includes('omits required') ? 'omitsRequiredPhrase'
      : String(text(row, 'detail') ?? '').includes('contains prohibited') ? 'containsProhibitedPhrase' : 'other',
  }));

const otlpPayloadFile = process.argv[5];

const artefact = {
  campaign: path.basename(campaignDirectory),
  otlpAggregateEffortCheck: otlpAggregate(otlpPayloadFile, rows),
  resultsFile,
  resultsDigest: digestBefore,
  attemptCount: rows.length,
  derivedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  perCandidate,
  divergences: rows.filter((row) => row.jsonViewsDivergent === true)
    .map((row) => ({ candidate: text(row, 'candidate'), caseID: text(row, 'caseID'), pass: count(row, 'pass'),
      strict: String(row.status), semantic: text(row, 'jsonSemanticSchemaStatus') })),
  humanReviewRequired: humanReview,
  governanceViolations: governance,
  governanceViolationsByKind: {
    omitsRequiredPhrase: governance.filter((entry) => entry.kind === 'omitsRequiredPhrase').length,
    containsProhibitedPhrase: governance.filter((entry) => entry.kind === 'containsProhibitedPhrase').length,
  },
  throttling: {
    // A throttle aborts and records nothing, so its evidence is the abort record and not a row.
    rowsRecordedAsThrottled: 0,
    note: 'Provider throttling never appears as a row: it aborts the campaign and leaves the slot runnable. '
      + 'Check the campaign\'s abort records for stage `providerThrottling`.',
  },
};

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(path.resolve(outputFile), `${JSON.stringify(artefact, null, 2)}\n`, 'utf8');

const digestAfter = digestOf(resultsFile);
if (digestAfter !== digestBefore) {
  process.stderr.write(`REFUSED: the campaign ledger changed during analysis.\n  before ${digestBefore}\n  after  ${digestAfter}\n`);
  process.exit(1);
}
process.stdout.write(`analysed ${rows.length} attempts from ${path.basename(campaignDirectory)}\n`);
process.stdout.write(`ledger digest unchanged: ${digestAfter}\n`);
process.stdout.write(`written to ${path.resolve(outputFile)}\n`);
