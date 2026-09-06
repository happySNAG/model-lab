// Model Lab core · durable file-backed result store (port of `ModelLabFileResultStore`).
//
// One JSON document per record, each wrapped in a self-describing envelope (schema version, record
// type, `mla1:` integrity digest, payload). The layout IS the index and is byte-compatible with the
// canonical Swift store, so a store written by either implementation is readable by the other:
//
//   <root>/store-manifest.json
//   <root>/runs/<runID>/plan.json
//   <root>/runs/<runID>/summary.json
//   <root>/runs/<runID>/attempts/<ordinal>.json
//   <root>/scores/<fnv(scoreID)>.json          <root>/evaluations/<fnv(evaluationID)>.json
//   <root>/reviews/<fnv(reviewID)>.json        <root>/recommendations/<fnv(recommendationID)>.json
//
// Append-only: an existing path is a COLLISION (refused). Writes are atomic (temp file + rename).
// Corruption — undecodable JSON or a failed digest check — is an explicit error on targeted reads
// and is counted honestly by `integrity()`.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fnv1a64Hex, seal, inspectableJSON, compareCodePoints } from './digest';
import { CandidateID } from './candidate';
import { BenchmarkCaseID } from './benchmark';
import { AttemptRecord, DerivedScoreRecord, RunPlan, RunSummary, attemptOrderAscending,
         ATTEMPT_SCHEMA_VERSION, DERIVED_SCORE_SCHEMA_VERSION, RUN_PLAN_SCHEMA_VERSION, RUN_SUMMARY_SCHEMA_VERSION } from './run';
import { EvaluationRecord, EVALUATION_SCHEMA_VERSION } from './evaluation';
import { HumanReviewRecord, HUMAN_REVIEW_SCHEMA_VERSION } from './human-review';
import { OwnerRecommendationRecord, RECOMMENDATION_SCHEMA_VERSION } from './recommendation';
import { EvidenceBundle, ResultStore, ResultStoreError, STORE_SCHEMA_VERSION, StoreIntegrity, makeEvidenceBundle } from './store';

interface Envelope<Payload> { schemaVersion: number; recordType: string; payloadDigest: string; payload: Payload }

export const STORE_MANIFEST_PURPOSE =
  'Skippy Model Lab permanent evaluation history. Evidence, not authorization. Append-only; records are never overwritten; model files are never stored here.';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export class FileResultStore implements ResultStore {
  private constructor(public readonly root: string) {}

  private get runsDirectory() { return path.join(this.root, 'runs'); }
  private get scoresDirectory() { return path.join(this.root, 'scores'); }
  private get evaluationsDirectory() { return path.join(this.root, 'evaluations'); }
  private get reviewsDirectory() { return path.join(this.root, 'reviews'); }
  private get recommendationsDirectory() { return path.join(this.root, 'recommendations'); }
  private get manifestPath() { return path.join(this.root, 'store-manifest.json'); }

  /** Opens (or initializes) a store rooted at an explicit directory. Never chooses its own location. */
  static async open(root: string): Promise<FileResultStore> {
    const store = new FileResultStore(root);
    for (const dir of [root, store.runsDirectory, store.scoresDirectory, store.evaluationsDirectory, store.reviewsDirectory, store.recommendationsDirectory]) {
      await fs.mkdir(dir, { recursive: true });
    }
    if (await exists(store.manifestPath)) {
      let manifest: { storeSchemaVersion?: number };
      try {
        manifest = JSON.parse(await fs.readFile(store.manifestPath, 'utf8'));
      } catch {
        throw new ResultStoreError('corruptRecord', 'record store-manifest is corrupt: manifest is not decodable', 'store-manifest');
      }
      if (typeof manifest.storeSchemaVersion !== 'number') {
        throw new ResultStoreError('corruptRecord', 'record store-manifest is corrupt: manifest is not decodable', 'store-manifest');
      }
      if (manifest.storeSchemaVersion > STORE_SCHEMA_VERSION) {
        throw new ResultStoreError('unsupportedSchemaVersion', `record schema ${manifest.storeSchemaVersion} is newer than supported ${STORE_SCHEMA_VERSION}`);
      }
    } else {
      await atomicWrite(store.manifestPath, inspectableJSON({ storeSchemaVersion: STORE_SCHEMA_VERSION, purpose: STORE_MANIFEST_PURPOSE }));
    }
    return store;
  }

  // MARK: Envelope I/O

  private async writeNew<Payload>(payload: Payload, recordType: string, schemaVersion: number, file: string, identity: string,
                                  collision: () => ResultStoreError): Promise<void> {
    if (await exists(file)) throw collision();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const envelope: Envelope<Payload> = { schemaVersion, recordType, payloadDigest: seal(payload, 'mla1:'), payload };
    try {
      await atomicWrite(file, inspectableJSON(envelope));
    } catch (error) {
      throw new ResultStoreError('ioFailure', `store I/O failure: writing ${identity}: ${String(error)}`, identity);
    }
  }

  private async readEnvelope<Payload>(recordType: string, supportedSchema: number, file: string, identity: string): Promise<Payload> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      throw new ResultStoreError('ioFailure', `store I/O failure: reading ${identity}: ${String(error)}`, identity);
    }
    let envelope: Envelope<Payload>;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new ResultStoreError('corruptRecord', `record ${identity} is corrupt: envelope is not decodable`, identity);
    }
    if (!envelope || typeof envelope !== 'object' || typeof envelope.schemaVersion !== 'number' || typeof envelope.recordType !== 'string'
        || typeof envelope.payloadDigest !== 'string' || envelope.payload === undefined) {
      throw new ResultStoreError('corruptRecord', `record ${identity} is corrupt: envelope is not decodable`, identity);
    }
    if (envelope.schemaVersion > supportedSchema) {
      throw new ResultStoreError('unsupportedSchemaVersion', `record schema ${envelope.schemaVersion} is newer than supported ${supportedSchema}`, identity);
    }
    if (envelope.recordType !== recordType) {
      throw new ResultStoreError('corruptRecord', `record ${identity} is corrupt: record type '${envelope.recordType}' is not '${recordType}'`, identity);
    }
    const recomputed = seal(envelope.payload, 'mla1:');
    if (recomputed !== envelope.payloadDigest) {
      throw new ResultStoreError('corruptRecord',
        `record ${identity} is corrupt: integrity digest mismatch (stored ${envelope.payloadDigest}, recomputed ${recomputed})`, identity);
    }
    return envelope.payload;
  }

  // MARK: Paths

  private runDirectory(runID: string) { return path.join(this.runsDirectory, runID); }
  private planPath(runID: string) { return path.join(this.runDirectory(runID), 'plan.json'); }
  private summaryPath(runID: string) { return path.join(this.runDirectory(runID), 'summary.json'); }
  private attemptsDirectory(runID: string) { return path.join(this.runDirectory(runID), 'attempts'); }
  private attemptPath(runID: string, ordinal: number) { return path.join(this.attemptsDirectory(runID), `${ordinal}.json`); }
  private scorePath(scoreID: string) { return path.join(this.scoresDirectory, fnv1a64Hex(scoreID) + '.json'); }
  private evaluationPath(evaluationID: string) { return path.join(this.evaluationsDirectory, fnv1a64Hex(evaluationID) + '.json'); }
  private reviewPath(reviewID: string) { return path.join(this.reviewsDirectory, fnv1a64Hex(reviewID) + '.json'); }
  private recommendationPath(id: string) { return path.join(this.recommendationsDirectory, fnv1a64Hex(id) + '.json'); }

  // MARK: Appends

  async appendPlan(plan: RunPlan): Promise<void> {
    await this.writeNew(plan, 'run-plan', RUN_PLAN_SCHEMA_VERSION, this.planPath(plan.runID), plan.runID,
      () => new ResultStoreError('duplicateRun', `store already holds run ${plan.runID}`, plan.runID));
  }
  async appendAttempt(record: AttemptRecord): Promise<void> {
    if (!(await exists(this.planPath(record.runID)))) throw new ResultStoreError('unknownRun', `store holds no run ${record.runID}`, record.runID);
    await this.writeNew(record, 'attempt', ATTEMPT_SCHEMA_VERSION, this.attemptPath(record.runID, record.ordinal), record.attemptID,
      () => new ResultStoreError('duplicateAttempt', `store already holds attempt ${record.attemptID}`, record.attemptID));
  }
  async appendScore(record: DerivedScoreRecord): Promise<void> {
    await this.writeNew(record, 'derived-score', DERIVED_SCORE_SCHEMA_VERSION, this.scorePath(record.scoreID), record.scoreID,
      () => new ResultStoreError('duplicateScore', `store already holds score ${record.scoreID}`, record.scoreID));
  }
  async appendEvaluation(record: EvaluationRecord): Promise<void> {
    await this.writeNew(record, 'evaluation', EVALUATION_SCHEMA_VERSION, this.evaluationPath(record.evaluationID), record.evaluationID,
      () => new ResultStoreError('duplicateEvaluation', `store already holds evaluation ${record.evaluationID}`, record.evaluationID));
  }
  async appendHumanReview(record: HumanReviewRecord): Promise<void> {
    await this.writeNew(record, 'human-review', HUMAN_REVIEW_SCHEMA_VERSION, this.reviewPath(record.reviewID), record.reviewID,
      () => new ResultStoreError('duplicateHumanReview', `store already holds human review ${record.reviewID}`, record.reviewID));
  }
  async appendRecommendation(record: OwnerRecommendationRecord): Promise<void> {
    await this.writeNew(record, 'owner-recommendation', RECOMMENDATION_SCHEMA_VERSION, this.recommendationPath(record.recommendationID), record.recommendationID,
      () => new ResultStoreError('duplicateRecommendation', `store already holds recommendation ${record.recommendationID}`, record.recommendationID));
  }
  async appendSummary(summary: RunSummary): Promise<void> {
    if (!(await exists(this.planPath(summary.runID)))) throw new ResultStoreError('unknownRun', `store holds no run ${summary.runID}`, summary.runID);
    await this.writeNew(summary, 'run-summary', RUN_SUMMARY_SCHEMA_VERSION, this.summaryPath(summary.runID), summary.runID,
      () => new ResultStoreError('duplicateSummary', `store already holds a summary for run ${summary.runID}`, summary.runID));
  }

  // MARK: Lookups

  async runIDs(): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(this.runsDirectory, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || (await exists(path.join(this.runsDirectory, entry.name, 'plan.json')))) ids.push(entry.name);
    }
    return ids.sort(compareCodePoints);
  }
  async plan(runID: string): Promise<RunPlan | undefined> {
    const file = this.planPath(runID);
    if (!(await exists(file))) return undefined;
    return this.readEnvelope<RunPlan>('run-plan', RUN_PLAN_SCHEMA_VERSION, file, `plan:${runID}`);
  }
  async summary(runID: string): Promise<RunSummary | undefined> {
    const file = this.summaryPath(runID);
    if (!(await exists(file))) return undefined;
    return this.readEnvelope<RunSummary>('run-summary', RUN_SUMMARY_SCHEMA_VERSION, file, `summary:${runID}`);
  }
  async attempts(runID: string): Promise<AttemptRecord[]> {
    const dir = this.attemptsDirectory(runID);
    if (!(await exists(dir))) return [];
    const records: AttemptRecord[] = [];
    for (const name of await this.jsonFiles(dir)) {
      records.push(await this.readEnvelope<AttemptRecord>('attempt', ATTEMPT_SCHEMA_VERSION, path.join(dir, name), `attempt-file:${name}`));
    }
    return records.sort((a, b) => a.ordinal - b.ordinal);
  }
  async attempt(attemptID: string): Promise<AttemptRecord | undefined> {
    for (const runID of await this.runIDs()) {
      for (const record of await this.attempts(runID)) if (record.attemptID === attemptID) return record;
    }
    return undefined;
  }
  async attemptHistoryForCandidate(candidateID: CandidateID): Promise<AttemptRecord[]> {
    return (await this.allAttempts()).filter((a) => a.candidate.id.raw === candidateID.raw).sort(attemptOrderAscending);
  }
  async attemptHistoryForCase(caseID: BenchmarkCaseID): Promise<AttemptRecord[]> {
    return (await this.allAttempts()).filter((a) => a.caseID.raw === caseID.raw).sort(attemptOrderAscending);
  }
  async scores(attemptID: string): Promise<DerivedScoreRecord[]> {
    return (await this.allScores()).filter((s) => s.attemptID === attemptID).sort((a, b) => compareCodePoints(a.scoreID, b.scoreID));
  }
  async evaluations(attemptID: string): Promise<EvaluationRecord[]> {
    return (await this.allEvaluations()).filter((e) => e.attemptID === attemptID).sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID));
  }
  async allEvaluations(): Promise<EvaluationRecord[]> {
    const records = await this.readDirectory<EvaluationRecord>(this.evaluationsDirectory, 'evaluation', EVALUATION_SCHEMA_VERSION, 'evaluation-file');
    return records.sort((a, b) => compareCodePoints(a.evaluationID, b.evaluationID));
  }
  async humanReviews(attemptID: string): Promise<HumanReviewRecord[]> {
    return (await this.allHumanReviews()).filter((r) => r.attemptID === attemptID).sort((a, b) => compareCodePoints(a.reviewID, b.reviewID));
  }
  async allHumanReviews(): Promise<HumanReviewRecord[]> {
    return this.readDirectory<HumanReviewRecord>(this.reviewsDirectory, 'human-review', HUMAN_REVIEW_SCHEMA_VERSION, 'review-file');
  }
  async recommendations(candidateID: CandidateID): Promise<OwnerRecommendationRecord[]> {
    return (await this.allRecommendations()).filter((r) => r.candidateID.raw === candidateID.raw).sort((a, b) => a.sequence - b.sequence);
  }
  async allRecommendations(): Promise<OwnerRecommendationRecord[]> {
    const records = await this.readDirectory<OwnerRecommendationRecord>(this.recommendationsDirectory, 'owner-recommendation', RECOMMENDATION_SCHEMA_VERSION, 'recommendation-file');
    return records.sort((a, b) => compareCodePoints(a.recommendationID, b.recommendationID));
  }

  /** Every attempt in the store, in run-id order then ordinal. */
  async allAttempts(): Promise<AttemptRecord[]> {
    const records: AttemptRecord[] = [];
    for (const runID of await this.runIDs()) records.push(...(await this.attempts(runID)));
    return records;
  }
  async allSummaries(): Promise<RunSummary[]> {
    const summaries: RunSummary[] = [];
    for (const runID of await this.runIDs()) {
      const s = await this.summary(runID);
      if (s) summaries.push(s);
    }
    return summaries;
  }
  private async allScores(): Promise<DerivedScoreRecord[]> {
    return this.readDirectory<DerivedScoreRecord>(this.scoresDirectory, 'derived-score', DERIVED_SCORE_SCHEMA_VERSION, 'score-file');
  }
  private async jsonFiles(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort(compareCodePoints);
    } catch {
      return [];
    }
  }
  private async readDirectory<Payload>(dir: string, recordType: string, schema: number, identityPrefix: string): Promise<Payload[]> {
    const records: Payload[] = [];
    for (const name of await this.jsonFiles(dir)) {
      records.push(await this.readEnvelope<Payload>(recordType, schema, path.join(dir, name), `${identityPrefix}:${name}`));
    }
    return records;
  }

  // MARK: Integrity / export

  async integrity(): Promise<StoreIntegrity> {
    let total = 0;
    let decodable = 0;
    const check = async (recordType: string, schema: number, file: string, identity: string) => {
      total += 1;
      try {
        await this.readEnvelope(recordType, schema, file, identity);
        decodable += 1;
      } catch {
        // counted, never hidden
      }
    };
    for (const runID of await this.runIDs()) {
      if (await exists(this.planPath(runID))) await check('run-plan', RUN_PLAN_SCHEMA_VERSION, this.planPath(runID), `plan:${runID}`);
      if (await exists(this.summaryPath(runID))) await check('run-summary', RUN_SUMMARY_SCHEMA_VERSION, this.summaryPath(runID), `summary:${runID}`);
      const dir = this.attemptsDirectory(runID);
      for (const name of await this.jsonFiles(dir)) await check('attempt', ATTEMPT_SCHEMA_VERSION, path.join(dir, name), `attempt-file:${name}`);
    }
    for (const name of await this.jsonFiles(this.scoresDirectory)) await check('derived-score', DERIVED_SCORE_SCHEMA_VERSION, path.join(this.scoresDirectory, name), `score-file:${name}`);
    for (const name of await this.jsonFiles(this.evaluationsDirectory)) await check('evaluation', EVALUATION_SCHEMA_VERSION, path.join(this.evaluationsDirectory, name), `evaluation-file:${name}`);
    for (const name of await this.jsonFiles(this.reviewsDirectory)) await check('human-review', HUMAN_REVIEW_SCHEMA_VERSION, path.join(this.reviewsDirectory, name), `review-file:${name}`);
    for (const name of await this.jsonFiles(this.recommendationsDirectory)) await check('owner-recommendation', RECOMMENDATION_SCHEMA_VERSION, path.join(this.recommendationsDirectory, name), `recommendation-file:${name}`);
    return { totalRecords: total, decodableRecords: decodable, corruptRecords: total - decodable };
  }

  async exportAll(): Promise<EvidenceBundle> {
    const plans: RunPlan[] = [];
    const summaries: RunSummary[] = [];
    for (const runID of await this.runIDs()) {
      const p = await this.plan(runID);
      if (p) plans.push(p);
      const s = await this.summary(runID);
      if (s) summaries.push(s);
    }
    return makeEvidenceBundle({
      storeSchemaVersion: STORE_SCHEMA_VERSION,
      plans,
      attempts: await this.allAttempts(),
      scores: await this.allScores(),
      evaluations: await this.allEvaluations(),
      humanReviews: await this.allHumanReviews(),
      recommendations: await this.allRecommendations(),
      summaries,
    });
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, file);
}
