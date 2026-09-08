// Benchmark engine · build the blinded adjudication packet. Model identity must not survive into
// it. A port of the proven `blinded_packet_v2.py`.
//
// The person adjudicating is the official reviewer; no model generates the official verdicts. That
// decision only means something if the packet the reviewer reads cannot tell them which model
// wrote which answer — otherwise "blinded" is a label rather than a property.
//
// THE THREE WAYS IDENTITY LEAKS, and what is done about each:
//
//   1  THE OBVIOUS WAY — a field called `candidate`. Every response is keyed by an opaque token
//      instead. The token is HMAC-SHA256(secret, slotKey) truncated; the secret lives in the KEY,
//      which is written to a DIFFERENT directory from the packet. Without the secret the tokens
//      are not invertible, and they are not even linkable across cases, because the slot key
//      differs per case.
//
//   2  THE ORDERING WAY — if responses always appear in candidate order, the first answer on every
//      page is always the same model. Responses are shuffled per case with a seeded PRNG, and the
//      seed is recorded in the KEY so the shuffle is reproducible and auditable afterwards, but not
//      predictable from the packet.
//
//   3  THE SELF-DISCLOSURE WAY — a model that writes "As Qwen, I would say…". Identity terms are
//      redacted from the answer text, including the fragments a model actually names itself by.
//
// AND THEN IT IS AUDITED. `auditPacket` re-scans the finished packet for every identity term. A
// redactor that is never checked is a redactor that eventually misses one.

import { hmacSha256Hex, sha256Text } from './canonical';

export const REDACTION = '[MODEL NAME REDACTED]';
export const TOKEN_PREFIX = 'R-';

/**
 * Fragments that appear in model names but are ordinary English. Redacting these would strike words
 * out of the adjudicator's own instructions ("instructions" contains "instruct") and out of honest
 * answers, and would make the leak scanner cry wolf on every packet. They carry no identifying
 * information on their own: every candidate in a local cohort is an instruct model.
 */
export const GENERIC_NAME_PARTS = new Set([
  'instruct', 'small', 'large', 'base', 'chat', 'code', 'coder', 'text', 'latest',
  'gguf', 'qat', 'main', 'beta', 'preview', 'turbo', 'mini', 'medium', 'vision',
  'tools', 'think', 'reason', 'model', 'test',
]);

export function blindingToken(secret: string, slotKey: string): string {
  return TOKEN_PREFIX + hmacSha256Hex(secret, slotKey).slice(0, 12);
}

/**
 * Every string that would identify a candidate, including its parts.
 *
 * `qwen3.8:27b` leaks as `qwen3.8`, as `qwen3`, and as `qwen`. Splitting on separators and keeping
 * fragments of four characters or more catches the way a model actually names itself. Longest
 * first, so a longer term is redacted before one of its own prefixes eats it.
 */
export function identityTerms(candidates: { name: string; modelID?: string }[]): string[] {
  const terms = new Set<string>();
  for (const candidate of candidates) {
    for (const base of new Set([candidate.name, candidate.modelID ?? candidate.name])) {
      if (!base) continue;
      terms.add(base);
      for (const part of base.split(/[:@/_\-\s]+/)) {
        if (part.length >= 4 && !GENERIC_NAME_PARTS.has(part.toLowerCase())) {
          terms.add(part);
          const leading = /^([A-Za-z]{4,})/.exec(part);
          if (leading && !GENERIC_NAME_PARTS.has(leading[1].toLowerCase())) terms.add(leading[1]);
        }
      }
    }
  }
  return [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(text: string, terms: string[]): { text: string; redactions: number } {
  let out = text ?? '';
  let count = 0;
  for (const term of terms) {
    const pattern = new RegExp(escapeRegExp(term), 'gi');
    out = out.replace(pattern, () => { count += 1; return REDACTION; });
  }
  return { text: out, redactions: count };
}

/**
 * A seeded PRNG so the shuffle is reproducible from the KEY and unpredictable from the packet.
 * mulberry32: small, deterministic, and identical on every platform — which matters, because a
 * shuffle that differs between machines cannot be audited afterwards.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface AdjudicableResponse {
  slotKey: string;
  caseID: string;
  candidate: string;
  answerText: string;
  status: string;
}

export interface PacketResponse {
  token: string;
  answerText: string;
  redactions: number;
}

export interface PacketCase {
  caseID: string;
  prompt: string;
  responses: PacketResponse[];
}

export interface BlindedPacket {
  packetFormatVersion: number;
  builtAt: string;
  caseCount: number;
  responseCount: number;
  candidateCount: number;
  cases: PacketCase[];
  instructions: string;
}

export interface PacketKey {
  builtAt: string;
  seed: number;
  secretSHA256: string;
  /** token -> the slot it came from. This is the ONLY thing that reverses the blinding. */
  tokens: { token: string; slotKey: string; candidate: string; caseID: string }[];
  note: string;
}

export const PACKET_FORMAT_VERSION = 2;

const INSTRUCTIONS = [
  'Each case below shows one prompt and every answer that was given to it, in a shuffled order.',
  'The answers are labelled with opaque tokens. Nothing in this packet says which model wrote which answer, and the order carries no information.',
  'Judge each answer on the prompt alone. If an answer names a model, that name has been redacted; treat the redaction as absent information, not as a hint.',
  'Record a verdict per token. The key that maps tokens back to models is held separately and is applied only after every verdict is recorded.',
].join('\n');

export class BlindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlindingError';
  }
}

/** Returns the packet, which is safe to share, and the key, which is not. */
export function buildBlindedPacket(responses: AdjudicableResponse[], prompts: Record<string, string>,
                                   candidates: { name: string; modelID?: string }[], secret: string,
                                   builtAt: string, seed = 20260904): { packet: BlindedPacket; key: PacketKey } {
  if (secret.length < 16) throw new BlindingError('the blinding secret is too short to be worth having; a token derived from a guessable secret is not blinded');
  const terms = identityTerms(candidates);
  const byCase = new Map<string, AdjudicableResponse[]>();
  for (const response of responses) {
    const bucket = byCase.get(response.caseID) ?? [];
    bucket.push(response);
    byCase.set(response.caseID, bucket);
  }

  const cases: PacketCase[] = [];
  const tokens: PacketKey['tokens'] = [];
  for (const caseID of [...byCase.keys()].sort()) {
    const bucket = byCase.get(caseID)!;
    // Seed per case, derived from the campaign seed and the case, so one case's order tells you
    // nothing about another's.
    const random = mulberry32(seed ^ Number.parseInt(sha256Text(caseID).slice(0, 8), 16));
    const ordered = shuffled([...bucket].sort((a, b) => (a.slotKey < b.slotKey ? -1 : 1)), random);
    const packetResponses: PacketResponse[] = ordered.map((response) => {
      const token = blindingToken(secret, response.slotKey);
      const { text, redactions } = redact(response.answerText, terms);
      tokens.push({ token, slotKey: response.slotKey, candidate: response.candidate, caseID: response.caseID });
      return { token, answerText: text, redactions };
    });
    cases.push({ caseID, prompt: prompts[caseID] ?? '', responses: packetResponses });
  }

  const packet: BlindedPacket = {
    packetFormatVersion: PACKET_FORMAT_VERSION,
    builtAt,
    caseCount: cases.length,
    responseCount: responses.length,
    candidateCount: new Set(responses.map((r) => r.candidate)).size,
    cases,
    instructions: INSTRUCTIONS,
  };
  const key: PacketKey = {
    builtAt,
    seed,
    secretSHA256: sha256Text(secret),
    tokens: tokens.sort((a, b) => (a.token < b.token ? -1 : 1)),
    note: 'This file reverses the blinding. Keep it apart from the packet until every verdict is recorded.',
  };
  return { packet, key };
}

export interface PacketAudit {
  clean: boolean;
  leaks: { caseID: string; token: string; term: string }[];
  /** A token that appears twice would let a reader link two answers to one model. */
  duplicateTokens: string[];
  identityFieldsPresent: string[];
  termsChecked: number;
}

/**
 * Re-scan the finished packet. A redactor that is never checked is a redactor that eventually
 * misses one, and the audit is cheap compared to a packet that quietly was not blinded.
 */
export function auditPacket(packet: BlindedPacket, candidates: { name: string; modelID?: string }[]): PacketAudit {
  const terms = identityTerms(candidates);
  const leaks: PacketAudit['leaks'] = [];
  const seen = new Map<string, number>();
  for (const packetCase of packet.cases) {
    for (const response of packetCase.responses) {
      seen.set(response.token, (seen.get(response.token) ?? 0) + 1);
      const haystack = `${response.answerText}\n${packetCase.prompt}`;
      for (const term of terms) {
        if (haystack.toLowerCase().includes(term.toLowerCase())) leaks.push({ caseID: packetCase.caseID, token: response.token, term });
      }
    }
  }
  // A `candidate` or `model` field anywhere in the packet defeats the whole exercise.
  const serialised = JSON.stringify(packet);
  const identityFieldsPresent = ['"candidate"', '"modelID"', '"model"'].filter((field) => serialised.includes(field));
  return {
    clean: leaks.length === 0 && identityFieldsPresent.length === 0,
    leaks,
    duplicateTokens: [...seen.entries()].filter(([, count]) => count > 1).map(([token]) => token).sort(),
    identityFieldsPresent,
    termsChecked: terms.length,
  };
}

export interface AdjudicationVerdict { token: string; outcome: 'satisfactory' | 'unsatisfactory' | 'mixed' | 'cannotDetermine'; note: string }

export interface UnblindedVerdict extends AdjudicationVerdict { slotKey: string; candidate: string; caseID: string }

/** Apply the key AFTER the verdicts are recorded. A verdict for an unknown token is refused, not dropped. */
export function unblind(verdicts: AdjudicationVerdict[], key: PacketKey): UnblindedVerdict[] {
  const byToken = new Map(key.tokens.map((entry) => [entry.token, entry]));
  return verdicts.map((verdict) => {
    const entry = byToken.get(verdict.token);
    if (!entry) throw new BlindingError(`verdict names token ${verdict.token}, which this key does not contain; the verdict and the key are from different packets`);
    return { ...verdict, slotKey: entry.slotKey, candidate: entry.candidate, caseID: entry.caseID };
  });
}
