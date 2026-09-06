// Model Lab core · governed, append-only human-review intake (port of `ModelLabHumanReview`).

import { seal } from './digest';
import { trimWhitespaceAndNewlines } from './text';
import { CapabilityDimension } from './evaluation';

export type HumanReviewOutcome = 'satisfactory' | 'unsatisfactory' | 'mixed' | 'cannotDetermine';
export type HumanReviewConfidence = 'low' | 'medium' | 'high';

export interface HumanReviewItem { label: string; outcome: HumanReviewOutcome; note: string }

export interface HumanReviewRubric {
  id: string;
  version: string;
  dimension: CapabilityDimension;
  title: string;
  itemLabels: string[];
  guidance: string;
}
export function rubricDigest(rubric: HumanReviewRubric): string {
  return seal(rubric, 'mlhr1:');
}

export class HumanReviewFailure extends Error {
  constructor(public readonly code: 'reviewerHandleNotPseudonymous' | 'emptyReviewerHandle' | 'noItems', message: string) {
    super(message);
    this.name = 'HumanReviewFailure';
  }
}

export interface HumanReviewRecord {
  reviewID: string;
  attemptID: string;
  reviewerPseudonym: string;
  rubricID: string;
  rubricVersion: string;
  sequence: number;
  items: HumanReviewItem[];
  overall: HumanReviewOutcome;
  confidence: HumanReviewConfidence;
  notes: string[];
  reviewedAt: string;
}
export const HUMAN_REVIEW_SCHEMA_VERSION = 1;

/** Fails closed if the reviewer handle is not pseudonymous or there are no item judgments. */
export function makeHumanReview(fields: Omit<HumanReviewRecord, 'reviewID'>): HumanReviewRecord {
  const trimmed = trimWhitespaceAndNewlines(fields.reviewerPseudonym);
  if (trimmed.length === 0) throw new HumanReviewFailure('emptyReviewerHandle', 'reviewer handle is empty');
  if (trimmed.includes('@') || trimmed.includes(' ')) {
    throw new HumanReviewFailure('reviewerHandleNotPseudonymous', `reviewer handle '${fields.reviewerPseudonym}' is not a pseudonym — use an opaque developer handle, never a name or email`);
  }
  if (fields.items.length === 0) throw new HumanReviewFailure('noItems', 'a human review must record at least one rubric item judgment');
  return {
    reviewID: `review:${fields.attemptID}:${trimmed}:${fields.rubricID}:${fields.rubricVersion}:${fields.sequence}`,
    ...fields,
    reviewerPseudonym: trimmed,
  };
}
