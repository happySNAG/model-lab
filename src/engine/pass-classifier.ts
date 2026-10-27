// Benchmark engine · THE ORDRA PASS CLASSIFIER (cpc1). One exported Ordra pass record in, its ctt1 task
// type and structural tier out — each with the evidence that chose it, a confidence, and the ctt1 query to
// hand to `cernum recommend`.
//
// WHAT THIS IS. Ordra plans a pass as a record: a display number, an objective, a scope, the verification
// commands and the worker's authority (its `pass_planned` payload). Task taxonomy ctt1 needs a task type
// and a tier. This file reads the first and names the second by TRANSPARENT RULES — fixed word lists,
// fixed path shapes, fixed counts — every one of which is named in the answer it contributed to. The rules
// and their weights are in `docs/ordra-lane/pass-classifier.md`; the version is `PASS_CLASSIFIER_VERSION`.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A DEFAULT. A record no rule classifies is REFUSED with every reason: no objective verb names a
//   task type, the types the objective names are all ruled out by the authority, two types tie, or nothing
//   in the record measures its size. A pass classified wrongly is routed on evidence about other work.
//   NOT A MODEL. No model reads the record. Same bytes, same answer.
//   NOT A SELECTION. The output is a ctt1 query. It ranks nothing and picks no route.
//   NOT A GUESS AT CONTEXT. The record states no context requirement, so the query carries none.

import * as fs from 'node:fs';
import { sha256Bytes } from './canonical';
import { ALL_ORDRA_TASK_TYPES, OrdraTaskType, TASK_TAXONOMY_VERSION } from './task-taxonomy';
import { WorkspaceDifficultyTier } from './workspace-difficulty';

export const PASS_CLASSIFIER_VERSION = 'cpc1';

/** Where a piece of evidence was read from in the pass record. */
export type PassEvidenceSource = 'objective' | 'scope' | 'verification' | 'authority';

/** One rule that matched, what it matched, and what it says. */
export interface PassEvidence {
  rule: string;
  source: PassEvidenceSource;
  /** The words, paths or commands the rule matched, verbatim (lower-cased for objective words). */
  matched: string[];
  detail: string;
}

export interface PassTypeEvidence extends PassEvidence {
  taskType: OrdraTaskType;
  weight: number;
}

export interface PassTypeExclusion {
  taskType: OrdraTaskType;
  rule: string;
  source: PassEvidenceSource;
  reason: string;
}

export interface PassTierEvidence extends PassEvidence {
  tier: WorkspaceDifficultyTier;
}

/** The pass record as the classifier read it, normalised. */
export interface PassRecordReading {
  displayNumber: string;
  objective: string;
  scopePaths: string[];
  verification: string[];
  pathsWritable: string[];
}

export interface PassClassificationConfidence {
  /** min(typeShare, tierAgreement), rounded to two places. */
  value: number;
  level: 'high' | 'medium' | 'low';
  /** The chosen type's score over the summed scores of every type not ruled out. */
  typeShare: number;
  /** The share of tier rules that indicated the chosen tier. */
  tierAgreement: number;
  /** How many distinct parts of the record (objective, scope, verification, authority) support the type. */
  sourcesAgreeing: number;
}

/** The ctt1 query the classification hands to `recommend`. Context is never invented. */
export interface PassClassificationQuery {
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  taskType: OrdraTaskType;
  structuralTier: WorkspaceDifficultyTier;
  contextTokens: null;
  contextReason: string;
  arguments: string[];
  command: string;
}

export interface PassClassification {
  schema: typeof PASS_CLASSIFIER_VERSION;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  ok: true;
  displayNumber: string;
  sourceDigest: string | null;
  taskType: OrdraTaskType;
  tier: WorkspaceDifficultyTier;
  evidence: {
    /** Every rule that supported the chosen type. */
    taskType: PassTypeEvidence[];
    /** Every tier rule, the chosen tier's and the others'. */
    tier: PassTierEvidence[];
    /** Every type ruled out, with the rule. */
    exclusions: PassTypeExclusion[];
    /** The summed weight of every type, ruled out or not. */
    scores: Record<OrdraTaskType, number>;
  };
  confidence: PassClassificationConfidence;
  query: PassClassificationQuery;
  disclosure: string;
}

export interface PassClassificationRefusal {
  schema: typeof PASS_CLASSIFIER_VERSION;
  taxonomyVersion: typeof TASK_TAXONOMY_VERSION;
  ok: false;
  displayNumber: string | null;
  sourceDigest: string | null;
  refusals: string[];
  /** What the rules found before refusing, so the refusal can be checked. Absent when the record was unreadable. */
  evidence?: {
    taskType: PassTypeEvidence[];
    tier: PassTierEvidence[];
    exclusions: PassTypeExclusion[];
    scores: Record<OrdraTaskType, number>;
  };
  disclosure: string;
}

export type PassClassifierAnswer = PassClassification | PassClassificationRefusal;

const DISCLOSURE = 'cpc1 classifies by fixed, documented rules over the record\'s objective, scope, verification and '
  + 'worker authority; no model reads it. It is advisory: the query it returns is answered by recommend, '
  + 'which ranks and selects nothing either. A record no rule classifies is refused, never defaulted.';

// ------------------------------------------------------------------ the rules

/** Weights, documented in the table in docs/ordra-lane/pass-classifier.md. */
export const PASS_RULE_WEIGHTS = {
  objectivePhrase: 4,
  objectiveLeadingVerb: 3,
  objectiveKeyword: 1,
  authorityOnly: 2,
  scopeOnly: 1,
  verificationShape: 1,
} as const;

/** Objective words, each naming one task type. Matched as whole words, with -s, -es, -ed, -d and -ing. */
export const PASS_OBJECTIVE_WORDS: Readonly<Record<OrdraTaskType, readonly string[]>> = {
  implement: ['add', 'implement', 'build', 'create', 'introduce', 'support', 'wire', 'extend', 'expose', 'enable', 'ship'],
  fix: ['fix', 'repair', 'correct', 'resolve', 'patch', 'debug', 'bug', 'defect', 'regression', 'crash', 'broken'],
  'test-repair': ['flaky'],
  refactor: ['refactor', 'rename', 'extract', 'restructure', 'reorganise', 'reorganize', 'consolidate', 'deduplicate',
    'simplify', 'split', 'inline'],
  docs: ['document', 'documentation', 'readme', 'changelog', 'describe', 'explain'],
  verify: ['verify', 'check', 'confirm', 'validate', 'run', 'rerun', 're-run', 'gate', 'smoke', 'prove'],
  plan: ['plan', 'design', 'propose', 'investigate', 'assess', 'survey', 'outline', 'spike'],
  review: ['review', 'inspect', 'critique', 'audit', 'examine'],
};

/** Objective phrases, each naming one task type more specifically than any single word. */
export const PASS_OBJECTIVE_PHRASES: readonly { rule: string; taskType: OrdraTaskType; pattern: RegExp }[] = [
  { rule: 'objective.phrase.failing-tests', taskType: 'test-repair', pattern: /\bfailing (?:unit |integration |e2e |end-to-end )?tests?\b/ },
  { rule: 'objective.phrase.tests-failing', taskType: 'test-repair',
    pattern: /\btests? (?:that )?(?:fail|fails|failed|failing|are failing|is failing|went red|broke|are broken|is broken)\b/ },
  { rule: 'objective.phrase.back-to-green', taskType: 'test-repair', pattern: /\b(?:back|return|returns|restore|restores) (?:it |them |the suite )?to green\b/ },
  { rule: 'objective.phrase.repair-tests', taskType: 'test-repair', pattern: /\brepair(?:s|ing)? (?:the )?(?:failing |broken |red )?tests?\b/ },
  { rule: 'objective.phrase.flaky-test', taskType: 'test-repair', pattern: /\bflaky tests?\b/ },
  { rule: 'objective.phrase.behaviour-preserved', taskType: 'refactor',
    pattern: /\b(?:without changing (?:its |their |the |any )?(?:observable )?behaviou?r|behaviou?r[- ]preserving|no (?:functional|behaviou?ral) change)\b/ },
  { rule: 'objective.phrase.update-docs', taskType: 'docs', pattern: /\bupdate (?:the )?(?:readme|docs|documentation|changelog)\b/ },
  { rule: 'objective.phrase.verification-only', taskType: 'verify', pattern: /\bverification[- ]only\b/ },
  { rule: 'objective.phrase.review-change', taskType: 'review', pattern: /\b(?:code review|review (?:the |this )?(?:diff|change|changes|commit|commits|branch|pr))\b/ },
];

/** A cross-cutting phrase in the objective indicates tier 3. */
const CROSS_CUTTING = /\b(?:cross-cutting|architecture|architectural|migrate|migration|end-to-end|across (?:the|all|every)|every (?:caller|module|command|provider|surface|package))\b/;

const WRITING_TYPES: OrdraTaskType[] = ['implement', 'fix', 'test-repair', 'refactor', 'docs'];

function normalisePath(value: string): string {
  return value.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** A documentation path: under docs/ or doc/, a README or CHANGELOG, or a prose file. */
export function isDocsPath(value: string): boolean {
  const p = normalisePath(value);
  const base = p.split('/').pop() ?? p;
  return /^docs?(\/|$)/i.test(p) || /\.(md|mdx|rst|adoc|txt)$/i.test(p) || /^(readme|changelog)(\.|$)/i.test(base);
}

/** A test path: under test/, tests/, __tests__/, spec/ or fixtures/, or a *.test.* / *.spec.* file. */
export function isTestPath(value: string): boolean {
  const p = normalisePath(value);
  return /(^|\/)(test|tests|__tests__|spec|specs|fixture|fixtures)(\/|$)/i.test(p) || /\.(test|spec)\.[a-z0-9]+$/i.test(p);
}

/** Lower-cased objective prose: code spans, paths and file names removed so `test/x.ts` is not the word "test". */
function objectiveProse(objective: string): string {
  return objective
    .replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter((token) => !token.includes('/') && !/\.[a-z0-9]{1,5}[),.;:]*$/i.test(token))
    .join(' ')
    .toLowerCase();
}

function wordsOf(prose: string): string[] {
  return prose.split(/[^a-z-]+/).map((word) => word.replace(/^-+|-+$/g, '')).filter((word) => word.length > 0);
}

/** The task type a single word names, through its -s, -es, -ed, -d or -ing form. */
function typeOfWord(word: string): { taskType: OrdraTaskType; stem: string } | undefined {
  const forms = [word];
  for (const suffix of ['ing', 'es', 'ed', 's', 'd']) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) forms.push(word.slice(0, -suffix.length));
  }
  if (word.endsWith('ing')) forms.push(`${word.slice(0, -3)}e`);
  for (const taskType of ALL_ORDRA_TASK_TYPES) {
    const stem = forms.find((form) => PASS_OBJECTIVE_WORDS[taskType].includes(form));
    if (stem !== undefined) return { taskType, stem };
  }
  return undefined;
}

// ------------------------------------------------------------------ reading the record

function readStrings(value: unknown, field: string, refusals: string[], allowObjects: boolean): string[] | undefined {
  if (!Array.isArray(value)) {
    refusals.push(`${field} is not a list`);
    return undefined;
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    const text = typeof entry === 'string' ? entry
      : allowObjects && typeof entry === 'object' && entry !== null && typeof (entry as { command?: unknown }).command === 'string'
        ? (entry as { command: string }).command : undefined;
    if (text === undefined || text.trim() === '') refusals.push(`${field}[${index}] is not a non-empty ${allowObjects ? 'command string or { command }' : 'string'}`);
    else out.push(text.trim());
  });
  return out;
}

/**
 * Read the five fields cpc1 classifies on. Accepts the record itself, or an Ordra event whose `payload` is
 * the record. Every field that cannot be read is named; none is defaulted.
 */
export function readPassRecord(value: unknown): { ok: true; reading: PassRecordReading } | { ok: false; displayNumber: string | null; refusals: string[] } {
  const refusals: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, displayNumber: null, refusals: ['the pass record is not a JSON object'] };
  }
  let record = value as Record<string, unknown>;
  if (record.objective === undefined && typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)) {
    record = record.payload as Record<string, unknown>;
  }
  const rawNumber = record.display_number;
  const displayNumber = typeof rawNumber === 'string' && rawNumber.trim() !== '' ? rawNumber.trim()
    : typeof rawNumber === 'number' && Number.isFinite(rawNumber) ? String(rawNumber) : null;
  if (displayNumber === null) refusals.push('display_number is missing or empty');

  const objective = typeof record.objective === 'string' && record.objective.trim() !== '' ? record.objective.trim() : null;
  if (objective === null) refusals.push('objective is missing or empty; the objective is what names the task type');

  let scopePaths: string[] | undefined;
  const scope = record.scope;
  if (Array.isArray(scope)) scopePaths = readStrings(scope, 'scope', refusals, false);
  else if (typeof scope === 'object' && scope !== null) {
    const fields = ['paths', 'in_scope', 'include'].filter((name) => (scope as Record<string, unknown>)[name] !== undefined);
    if (fields.length === 0) refusals.push('scope is an object with none of paths, in_scope or include');
    else scopePaths = fields.flatMap((name) => readStrings((scope as Record<string, unknown>)[name], `scope.${name}`, refusals, false) ?? []);
  } else refusals.push('scope is missing; it must be a list of paths or an object with paths, in_scope or include');

  const verification = record.verification === undefined
    ? (refusals.push('verification is missing; an empty list states a pass with no checks, an absent field states nothing'), undefined)
    : readStrings(record.verification, 'verification', refusals, true);

  let pathsWritable: string[] | undefined;
  const authority = record.worker_authority;
  if (typeof authority !== 'object' || authority === null || Array.isArray(authority)) {
    refusals.push('worker_authority is missing or not an object');
  } else if ((authority as Record<string, unknown>).paths_writable === undefined) {
    refusals.push('worker_authority.paths_writable is missing; whether the worker may write is evidence, never assumed');
  } else {
    pathsWritable = readStrings((authority as Record<string, unknown>).paths_writable, 'worker_authority.paths_writable', refusals, false);
  }

  if (refusals.length > 0 || displayNumber === null || objective === null || scopePaths === undefined
    || verification === undefined || pathsWritable === undefined) {
    return { ok: false, displayNumber, refusals };
  }
  return { ok: true, reading: {
    displayNumber, objective,
    scopePaths: scopePaths.map(normalisePath),
    verification,
    pathsWritable: pathsWritable.map(normalisePath),
  } };
}

// ------------------------------------------------------------------ the type rules

function typeEvidence(reading: PassRecordReading): { evidence: PassTypeEvidence[]; exclusions: PassTypeExclusion[] } {
  const evidence: PassTypeEvidence[] = [];
  const exclusions: PassTypeExclusion[] = [];
  const prose = objectiveProse(reading.objective);

  // Objective phrases: the most specific rules.
  for (const phrase of PASS_OBJECTIVE_PHRASES) {
    const match = phrase.pattern.exec(prose);
    if (match !== null) {
      evidence.push({ rule: phrase.rule, source: 'objective', taskType: phrase.taskType, weight: PASS_RULE_WEIGHTS.objectivePhrase,
        matched: [match[0]], detail: `the objective says '${match[0]}'` });
    }
  }
  // The leading verb, then every other word, each distinct word once.
  const words = wordsOf(prose);
  const seen = new Set<string>();
  words.forEach((word, index) => {
    const typed = typeOfWord(word);
    if (typed === undefined) return;
    const leading = index === 0;
    const key = `${leading ? 'lead' : 'word'}:${typed.taskType}:${typed.stem}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push(leading
      ? { rule: 'objective.leading-verb', source: 'objective', taskType: typed.taskType, weight: PASS_RULE_WEIGHTS.objectiveLeadingVerb,
        matched: [word], detail: `the objective opens with '${word}'` }
      : { rule: 'objective.keyword', source: 'objective', taskType: typed.taskType, weight: PASS_RULE_WEIGHTS.objectiveKeyword,
        matched: [word], detail: `the objective uses '${word}'` });
  });

  // Worker authority: what the worker may write.
  const writable = reading.pathsWritable;
  if (writable.length === 0) {
    for (const taskType of WRITING_TYPES) {
      exclusions.push({ taskType, rule: 'authority.read-only', source: 'authority',
        reason: 'worker_authority.paths_writable is empty: the worker may write nothing, and this task type writes' });
    }
  } else if (writable.every(isDocsPath)) {
    evidence.push({ rule: 'authority.docs-only', source: 'authority', taskType: 'docs', weight: PASS_RULE_WEIGHTS.authorityOnly,
      matched: writable, detail: 'every writable path is documentation' });
    for (const taskType of ['implement', 'fix', 'test-repair', 'refactor'] as OrdraTaskType[]) {
      exclusions.push({ taskType, rule: 'authority.docs-only', source: 'authority',
        reason: 'every writable path is documentation, and this task type changes code or tests' });
    }
  } else if (writable.every(isTestPath)) {
    evidence.push({ rule: 'authority.tests-only', source: 'authority', taskType: 'test-repair', weight: PASS_RULE_WEIGHTS.authorityOnly,
      matched: writable, detail: 'every writable path is a test or fixture' });
    for (const taskType of ['implement', 'docs'] as OrdraTaskType[]) {
      exclusions.push({ taskType, rule: 'authority.tests-only', source: 'authority',
        reason: 'every writable path is a test or fixture, and this task type writes source or documentation' });
    }
  }

  // Scope: what the pass is about.
  const scope = reading.scopePaths;
  if (scope.length > 0 && scope.every(isDocsPath)) {
    evidence.push({ rule: 'scope.docs-only', source: 'scope', taskType: 'docs', weight: PASS_RULE_WEIGHTS.scopeOnly,
      matched: scope, detail: 'every scope path is documentation' });
  } else if (scope.length > 0 && scope.every(isTestPath)) {
    evidence.push({ rule: 'scope.tests-only', source: 'scope', taskType: 'test-repair', weight: PASS_RULE_WEIGHTS.scopeOnly,
      matched: scope, detail: 'every scope path is a test or fixture' });
  }

  // Verification: what the pass is checked by.
  const commands = reading.verification;
  if (commands.length === 0) {
    exclusions.push({ taskType: 'verify', rule: 'verification.none', source: 'verification',
      reason: 'the record lists no verification command, and a verification pass is one that runs checks' });
  } else if (writable.length === 0) {
    evidence.push({ rule: 'verification.checks-only', source: 'verification', taskType: 'verify', weight: PASS_RULE_WEIGHTS.verificationShape,
      matched: commands, detail: 'the worker may write nothing and the record lists checks to run' });
  }
  const scopedTests = scope.filter(isTestPath);
  const naming = commands.filter((command) => scopedTests.some((test) => test !== '' && command.includes(test)));
  if (naming.length > 0 && scopedTests.length > 0) {
    evidence.push({ rule: 'verification.runs-scoped-test', source: 'verification', taskType: 'test-repair', weight: PASS_RULE_WEIGHTS.verificationShape,
      matched: naming, detail: 'a verification command runs a test path the scope names' });
  }
  return { evidence, exclusions };
}

// ------------------------------------------------------------------ the tier rules

function tierByCount(count: number, tier2From: number, tier3From: number): WorkspaceDifficultyTier {
  return count >= tier3From ? 'tier3' : count >= tier2From ? 'tier2' : 'tier1';
}

function tierEvidence(reading: PassRecordReading): PassTierEvidence[] {
  const evidence: PassTierEvidence[] = [];
  const commands = reading.verification.length;
  // The tier bands' own verificationCommandCount minima: tier 2 from 4, tier 3 from 5.
  if (commands > 0) {
    evidence.push({ rule: 'tier.verification-count', source: 'verification', tier: tierByCount(commands, 4, 5),
      matched: reading.verification, detail: `${commands} verification command(s): 1-3 is tier 1, 4 is tier 2, 5 or more is tier 3` });
  }
  const scope = reading.scopePaths.length;
  if (scope > 0) {
    evidence.push({ rule: 'tier.scope-count', source: 'scope', tier: tierByCount(scope, 4, 8),
      matched: reading.scopePaths, detail: `${scope} scope path(s): 1-3 is tier 1, 4-7 is tier 2, 8 or more is tier 3` });
  }
  const areas = [...new Set(reading.scopePaths.map((p) => p.split('/')[0]!))];
  if (areas.length > 0) {
    evidence.push({ rule: 'tier.scope-areas', source: 'scope', tier: tierByCount(areas.length, 3, 5),
      matched: areas, detail: `${areas.length} top-level area(s) in scope: 1-2 is tier 1, 3-4 is tier 2, 5 or more is tier 3` });
  }
  const crossCutting = CROSS_CUTTING.exec(objectiveProse(reading.objective));
  if (crossCutting !== null) {
    evidence.push({ rule: 'tier.cross-cutting', source: 'objective', tier: 'tier3',
      matched: [crossCutting[0]], detail: `the objective says '${crossCutting[0]}': cross-cutting work is tier 3` });
  }
  return evidence;
}

const TIER_ORDER: WorkspaceDifficultyTier[] = ['tier1', 'tier2', 'tier3'];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------------------------------ the classifier

/**
 * Classify one pass record. PURE: reads nothing, writes nothing, and refuses rather than defaults — every
 * reason a record cannot be classified is named in `refusals`, all of them at once.
 */
export function classifyPassRecord(value: unknown, sourceDigest: string | null = null): PassClassifierAnswer {
  const base = { schema: PASS_CLASSIFIER_VERSION, taxonomyVersion: TASK_TAXONOMY_VERSION, sourceDigest, disclosure: DISCLOSURE } as const;
  const read = readPassRecord(value);
  if (!read.ok) return { ...base, ok: false, displayNumber: read.displayNumber, refusals: read.refusals };
  const reading = read.reading;

  const { evidence, exclusions } = typeEvidence(reading);
  const tiers = tierEvidence(reading);
  const excluded = new Set(exclusions.map((entry) => entry.taskType));
  const scores = Object.fromEntries(ALL_ORDRA_TASK_TYPES.map((taskType) => [taskType,
    evidence.filter((entry) => entry.taskType === taskType).reduce((sum, entry) => sum + entry.weight, 0)])) as Record<OrdraTaskType, number>;
  const refusals: string[] = [];

  // A type must be named by the objective, and not ruled out, to be chosen.
  const named = ALL_ORDRA_TASK_TYPES.filter((taskType) => evidence.some((entry) => entry.taskType === taskType && entry.source === 'objective'));
  const eligible = named.filter((taskType) => !excluded.has(taskType));
  let taskType: OrdraTaskType | undefined;
  if (named.length === 0) {
    refusals.push('no objective rule matched: the objective\'s verbs and phrases name no ctt1 task type '
      + `(${ALL_ORDRA_TASK_TYPES.join(', ')}); an unclassified pass is refused, never given a default type`);
  } else if (eligible.length === 0) {
    for (const type of named) {
      const why = exclusions.filter((entry) => entry.taskType === type).map((entry) => `${entry.rule}: ${entry.reason}`).join('; ');
      refusals.push(`the objective names '${type}' but it is ruled out (${why})`);
    }
  } else {
    const top = Math.max(...eligible.map((type) => scores[type]));
    const leaders = eligible.filter((type) => scores[type] === top);
    if (leaders.length > 1) {
      refusals.push(`the evidence ties between ${leaders.map((type) => `'${type}'`).join(' and ')} at score ${top}; `
        + 'a tie is refused, never broken by a default order');
    } else taskType = leaders[0];
  }

  let tier: WorkspaceDifficultyTier | undefined;
  if (tiers.length === 0) {
    refusals.push('no tier rule applies: the record has no scope path, no verification command and no cross-cutting objective, '
      + 'so nothing measures its size; a tier is never defaulted');
  } else {
    // The highest tier any rule indicates: under-sizing a pass routes it on evidence from easier work.
    tier = TIER_ORDER[Math.max(...tiers.map((entry) => TIER_ORDER.indexOf(entry.tier)))];
  }

  const found = { taskType: taskType === undefined ? evidence : evidence.filter((entry) => entry.taskType === taskType),
    tier: tiers, exclusions, scores };
  if (refusals.length > 0 || taskType === undefined || tier === undefined) {
    return { ...base, ok: false, displayNumber: reading.displayNumber, refusals, evidence: found };
  }

  const eligibleTotal = ALL_ORDRA_TASK_TYPES.filter((type) => !excluded.has(type)).reduce((sum, type) => sum + scores[type], 0);
  const typeShare = round2(scores[taskType] / eligibleTotal);
  const tierAgreement = round2(tiers.filter((entry) => entry.tier === tier).length / tiers.length);
  const sourcesAgreeing = new Set(found.taskType.map((entry) => entry.source)).size;
  const value_ = round2(Math.min(typeShare, tierAgreement));
  const level = value_ >= 0.75 && sourcesAgreeing >= 2 ? 'high' : value_ >= 0.5 ? 'medium' : 'low';
  const tierDigit = tier.slice(-1);
  const args = ['recommend', taskType, '--tier', tierDigit, '--contract', 'crr2', '--json'];
  return {
    ...base, ok: true, displayNumber: reading.displayNumber, taskType, tier,
    evidence: found,
    confidence: { value: value_, level, typeShare, tierAgreement, sourcesAgreeing },
    query: {
      taxonomyVersion: TASK_TAXONOMY_VERSION, taskType, structuralTier: tier, contextTokens: null,
      contextReason: 'the pass record states no context requirement, so none is invented; add --context <tokens> when it is known',
      arguments: args, command: `cernum ${args.join(' ')}`,
    },
  };
}

/** Read one exported pass record file and classify it. Unparseable JSON is a refusal, not a throw. */
export function classifyPassFile(filePath: string): PassClassifierAnswer {
  const bytes = fs.readFileSync(filePath);
  const sourceDigest = sha256Bytes(bytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return { schema: PASS_CLASSIFIER_VERSION, taxonomyVersion: TASK_TAXONOMY_VERSION, ok: false, displayNumber: null, sourceDigest,
      refusals: [`the file is not JSON: ${(error as Error).message}`], disclosure: DISCLOSURE };
  }
  return classifyPassRecord(value, sourceDigest);
}
