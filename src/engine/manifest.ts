// Benchmark engine · freeze the exact thing that will be executed, then keep proving it has not
// moved. A port of the proven `execution_manifest_v2.py`.
//
// WHAT A FROZEN MANIFEST IS FOR. A benchmark result is a claim about a specific set of prompts,
// scored by a specific set of rules, on specific hardware, against specific models. Every one of
// those can drift between the day a run is authorised and the day it finishes, and none of the
// drifts announce themselves. The manifest is what makes a result still readable a fortnight later.
//
// WHAT IS BOUND — everything a later reader would otherwise have to take on trust:
//
//   prompts      SHA-256 of every prompt string and its context, plus one digest over all of them.
//                A single changed byte is visible.
//   catalog      the catalogue digest, which already binds scoring mode, budgets and fixtures
//   scored core  the cross-provider fingerprint: (caseID, caseDigest, comparabilityKey,
//                scoringMode, maxOutputTokens, promptSHA256) for every case
//   evaluators   digests of every evaluator that can decide a verdict
//   candidates   identity AND ORDER — order matters, because thermal state is not reset
//   guards       the safety floors in force
//   hardware     the machine the numbers were produced on
//
// VERIFICATION IS A COMPARISON, NOT A RE-COMPUTATION OF THE SAME THING. `verify` recomputes each
// binding from the live inputs and reports every field that differs. It never repairs a drift:
// a manifest that silently updates itself is a manifest that proves nothing.

import { CanonicalValue, canonicalJSON, digestObject, sha256Text } from './canonical';
import { ExecutionPolicy, isCanonical } from './execution';
import { OperationalEnvelope, operationalEnvelopeDigest } from './provider';

/**
 * 3 adds the execution policy — residency mode and thinking mode — to the bound body.
 *
 * It is a format bump rather than an additive field because the digest changed: an observe-only
 * campaign and a canonical one over identical prompts now produce DIFFERENT manifest identities.
 * That is the point. Two results that are not comparable should not be able to present themselves
 * under the same seal, and making that a property of the digest is stronger than making it a label
 * somebody has to remember to read.
 */
export const MANIFEST_FORMAT_VERSION_LOCAL_ONLY = 3;

/**
 * 4 adds the OPERATIONAL ENVELOPE — who is asked, how they are reached, at what effort, under what
 * budgets and timeouts, on whose bill — to the bound body.
 *
 * WHY A FORMAT BUMP AND NOT AN EXTRA FIELD. The same prompts, scored the same way, answered by the
 * same named model, produce different results depending on whether that model was reached on this
 * machine, through a subscription CLI, or through a metered API. Their latencies are not the same
 * measurement, their costs are not the same currency, and their identities are established by
 * different evidence. Binding the envelope into the digest is what makes a local run and an API run
 * of "the same" model two manifests rather than one — for exactly the reason an observe-only run and
 * a canonical one became two in format 3.
 *
 * WHY THE SCORED CORE STAYS SEPARATE. `scoredCoreDigest` still binds only the prompts, the scoring
 * modes and the output budgets — the things that must be identical for two results to be comparable
 * at all. The envelope binds the things that make them different. Keeping the two digests apart is
 * what lets a reader say "the same benchmark, three ways" instead of choosing between pretending
 * they are identical and refusing to put them on one page.
 *
 * WHAT HAPPENS TO FORMAT 3. Nothing. A format-3 manifest is read, verified, finalized and resumed
 * exactly as it always was; its stored identity is untouched, and its verification never recomputes
 * a binding it never froze. `freezeManifest` still produces a byte-identical format-3 manifest when
 * no envelope is supplied, which is what keeps the recorded parity vectors valid.
 */
export const MANIFEST_FORMAT_VERSION_WITH_PROVIDERS = 4;

/** The version a new campaign freezes at. Every new campaign carries an envelope, so: 4. */
export const MANIFEST_FORMAT_VERSION = MANIFEST_FORMAT_VERSION_WITH_PROVIDERS;

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** One prompt exactly as it will be sent, before any adapter touches it. */
export interface PromptRecord {
  caseID: string;
  /** The full request text, in the order the model will receive it. */
  text: string;
  /** Supplied context, kept separate so a context change is distinguishable from a prompt change. */
  suppliedContext?: string;
}

export interface ScoredCoreEntry {
  caseID: string;
  caseDigest: string;
  comparabilityKey: string;
  scoringMode: string;
  maxOutputTokens: number;
  promptSHA256: string;
}

export interface HardwareIdentity {
  platform: string;
  architecture: string;
  model: string;
  cpuCoreCount: number;
  physicalMemoryBytes: number;
  osVersion: string;
}

export interface ManifestCandidate {
  name: string;
  modelID: string;
  /** The runtime's own digest for the weights, when it reports one. Empty means "the runtime did not say". */
  runtimeDigest: string;
  parameterSize: string;
  quantization: string;
}

export interface FrozenManifest {
  manifestFormatVersion: number;
  manifestID: string;
  frozenAt: string;
  label: string;
  catalogDigest: string;
  caseCount: number;
  repeatsPerCase: number;
  promptDigests: { caseID: string; promptSHA256: string; suppliedContextSHA256: string | null }[];
  promptsDigest: string;
  scoredCore: ScoredCoreEntry[];
  scoredCoreDigest: string;
  evaluatorDigests: { evaluatorID: string; digest: string }[];
  evaluatorsDigest: string;
  candidates: ManifestCandidate[];
  candidatesDigest: string;
  guards: CanonicalValue;
  guardsDigest: string;
  hardware: HardwareIdentity;
  hardwareDigest: string;
  runtimeVersion: string;
  /**
   * How this campaign will be executed. Frozen, bound into `manifestDigest`, and never inferred or
   * adjusted afterwards. Absent on a manifest frozen before format 3.
   */
  execution?: ExecutionPolicy;
  executionDigest?: string;
  /** False for an observe-only campaign. Stored explicitly so a reader never has to derive it. */
  canonical?: boolean;
  /**
   * Who is asked, how, at what effort, under what budgets, on whose bill. Absent on format 3.
   *
   * Present on every format-4 manifest INCLUDING a local-only one, so "this ran on the local
   * runtime" is an assertion somebody made rather than the absence of a claim.
   */
  operationalEnvelope?: OperationalEnvelope;
  operationalEnvelopeDigest?: string;
  /** Set only on a manifest derived for different hardware; names the manifest it descends from. */
  retestOf?: { manifestID: string; hardwareDigest: string; derivedAt: string; reason: string };
  manifestDigest: string;
}

export interface ManifestInputs {
  label: string;
  catalogDigest: string;
  caseCount: number;
  repeatsPerCase: number;
  prompts: PromptRecord[];
  scoredCore: Omit<ScoredCoreEntry, 'promptSHA256'>[];
  evaluators: { evaluatorID: string; source: string }[];
  candidates: ManifestCandidate[];
  guards: CanonicalValue;
  hardware: HardwareIdentity;
  runtimeVersion: string;
  execution: ExecutionPolicy;
  /**
   * Supply it to freeze a format-4 manifest; omit it to freeze a byte-identical format-3 one.
   *
   * The omission path exists for the recorded parity vectors and for nothing else: every caller in
   * this engine supplies an envelope, because a campaign that cannot say who answered it is the
   * ambiguity format 4 was created to remove.
   */
  operationalEnvelope?: OperationalEnvelope;
  frozenAt: string;
}

function promptDigestsOf(prompts: PromptRecord[]): { caseID: string; promptSHA256: string; suppliedContextSHA256: string | null }[] {
  return [...prompts]
    .sort((a, b) => (a.caseID < b.caseID ? -1 : a.caseID > b.caseID ? 1 : 0))
    .map((prompt) => ({
      caseID: prompt.caseID,
      promptSHA256: sha256Text(prompt.text),
      suppliedContextSHA256: prompt.suppliedContext === undefined ? null : sha256Text(prompt.suppliedContext),
    }));
}

/** Freeze. Every binding is computed here, once, and never recomputed into the same record again. */
export function freezeManifest(inputs: ManifestInputs): FrozenManifest {
  if (inputs.prompts.length === 0) throw new ManifestError('a manifest over zero prompts binds nothing; refusing to freeze it');
  if (inputs.candidates.length === 0) throw new ManifestError('a manifest with no candidates cannot be executed; refusing to freeze it');

  const promptDigests = promptDigestsOf(inputs.prompts);
  const promptsDigest = digestObject(promptDigests as unknown as CanonicalValue);
  const promptByCase = new Map(promptDigests.map((p) => [p.caseID, p.promptSHA256]));

  const scoredCore: ScoredCoreEntry[] = [...inputs.scoredCore]
    .sort((a, b) => (a.caseID < b.caseID ? -1 : a.caseID > b.caseID ? 1 : 0))
    .map((entry) => {
      const promptSHA256 = promptByCase.get(entry.caseID);
      if (promptSHA256 === undefined) {
        throw new ManifestError(`case ${entry.caseID} is in the scored core but has no prompt; a scored case whose prompt is unbound is exactly the drift this manifest exists to catch`);
      }
      return { ...entry, promptSHA256 };
    });
  const scoredCoreDigest = digestObject(scoredCore as unknown as CanonicalValue);

  const evaluatorDigests = [...inputs.evaluators]
    .sort((a, b) => (a.evaluatorID < b.evaluatorID ? -1 : a.evaluatorID > b.evaluatorID ? 1 : 0))
    .map((evaluator) => ({ evaluatorID: evaluator.evaluatorID, digest: sha256Text(evaluator.source) }));
  const evaluatorsDigest = digestObject(evaluatorDigests as unknown as CanonicalValue);

  // Candidate ORDER is bound, not just membership: thermal state is not reset between candidates,
  // so running them in a different order is a different experiment.
  const candidatesDigest = digestObject(inputs.candidates as unknown as CanonicalValue);
  const guardsDigest = digestObject(inputs.guards);
  const hardwareDigest = digestObject(inputs.hardware as unknown as CanonicalValue);
  const executionDigest = digestObject(inputs.execution as unknown as CanonicalValue);

  // The envelope decides the FORMAT, and the format decides what is in the bound body. A format-3
  // freeze must remain byte-identical to what Pass 3 produced — not merely equivalent — because the
  // recorded parity vectors and every campaign already on disk are compared against those bytes.
  const envelope = inputs.operationalEnvelope;
  const envelopeDigest = envelope === undefined ? undefined : operationalEnvelopeDigest(envelope);

  if (envelope !== undefined) {
    const names = new Set(inputs.candidates.map((candidate) => candidate.name));
    for (const binding of envelope.bindings) {
      if (!names.has(binding.candidate)) {
        throw new ManifestError(`the operational envelope binds ${binding.candidate}, which is not a candidate of this `
          + 'campaign; a binding for a model nobody will run describes a request that is never made');
      }
    }
    for (const candidate of inputs.candidates) {
      if (!envelope.bindings.some((binding) => binding.candidate === candidate.name)) {
        throw new ManifestError(`${candidate.name} has no provider binding, so this manifest could not say who would be `
          + 'asked, how they would be reached, or who would pay. Refusing to freeze it.');
      }
    }
  }

  const body = {
    manifestFormatVersion: envelope === undefined ? MANIFEST_FORMAT_VERSION_LOCAL_ONLY : MANIFEST_FORMAT_VERSION_WITH_PROVIDERS,
    label: inputs.label,
    catalogDigest: inputs.catalogDigest,
    caseCount: inputs.caseCount,
    repeatsPerCase: inputs.repeatsPerCase,
    promptsDigest,
    scoredCoreDigest,
    evaluatorsDigest,
    candidatesDigest,
    guardsDigest,
    hardwareDigest,
    executionDigest,
    // Present only on format 4. `canonicalJSON` drops an undefined key entirely, so a format-3 body
    // hashes to exactly the bytes it always did.
    operationalEnvelopeDigest: envelopeDigest,
    runtimeVersion: inputs.runtimeVersion,
  };
  const manifestDigest = digestObject(body);

  return {
    ...body,
    manifestID: `manifest:${manifestDigest.slice(0, 16)}`,
    frozenAt: inputs.frozenAt,
    promptDigests,
    scoredCore,
    evaluatorDigests,
    candidates: inputs.candidates,
    guards: inputs.guards,
    hardware: inputs.hardware,
    execution: inputs.execution,
    canonical: isCanonical(inputs.execution),
    operationalEnvelope: envelope,
    manifestDigest,
  };
}

export interface Drift {
  field: string;
  frozen: string;
  observed: string;
  /** Plain language, because the person reading a drift report is usually not the person who froze it. */
  meaning: string;
}

export interface VerificationReport {
  manifestID: string;
  verifiedAt: string;
  intact: boolean;
  drifts: Drift[];
  /** True when the ONLY drift is hardware — the case a retest manifest exists for. */
  hardwareOnly: boolean;
}

export interface VerificationInputs {
  catalogDigest?: string;
  prompts?: PromptRecord[];
  scoredCore?: Omit<ScoredCoreEntry, 'promptSHA256'>[];
  evaluators?: { evaluatorID: string; source: string }[];
  candidates?: ManifestCandidate[];
  guards?: CanonicalValue;
  hardware?: HardwareIdentity;
  runtimeVersion?: string;
  execution?: ExecutionPolicy;
  operationalEnvelope?: OperationalEnvelope;
}

const MEANINGS: Record<string, string> = {
  catalogDigest: 'the benchmark catalogue changed: scoring modes, budgets or fixtures are not the ones that were authorised',
  promptsDigest: 'at least one prompt or supplied context changed; the models are no longer being asked the same question',
  scoredCoreDigest: 'the scored core changed: a case, its digest, its comparability key, its scoring mode or its output budget moved',
  evaluatorsDigest: 'an evaluator changed; the same answer would now be judged by different rules',
  candidatesDigest: 'the candidate set or its ORDER changed; order is bound because thermal state is not reset between candidates',
  guardsDigest: 'the safety floors changed; the run would proceed under different limits than the ones authorised',
  hardwareDigest: 'the machine changed; latency and throughput are not comparable across hardware, and a retest manifest is required',
  executionDigest: 'the execution policy changed: residency management or thinking mode is not the one that was frozen, and neither may be changed after the freeze',
  runtimeVersion: 'the inference runtime version changed; its own behaviour is part of the measurement',
  operationalEnvelopeDigest: 'the operational envelope changed: a provider, a model identifier, an effort level, a thinking mode, a sampling setting, a token budget, a timeout, a retry policy, a billing basis or a pricing snapshot is not the one that was frozen. None of these may change after the freeze — a campaign whose second half was answered by a different model, at a different effort, or on a different bill is not the campaign that was authorised',
};

/**
 * Recompute every binding from the live inputs and report what moved. A binding whose input is not
 * supplied is not checked and is not claimed to be intact — an unchecked field is simply absent
 * from the report rather than silently passing.
 */
export function verifyManifest(manifest: FrozenManifest, live: VerificationInputs, verifiedAt: string): VerificationReport {
  const drifts: Drift[] = [];
  const compare = (field: string, frozen: string, observed: string | undefined): void => {
    if (observed === undefined || frozen === observed) return;
    drifts.push({ field, frozen, observed, meaning: MEANINGS[field] ?? `${field} changed` });
  };

  compare('catalogDigest', manifest.catalogDigest, live.catalogDigest);
  if (live.prompts) compare('promptsDigest', manifest.promptsDigest, digestObject(promptDigestsOf(live.prompts) as unknown as CanonicalValue));
  if (live.scoredCore && live.prompts) {
    const promptByCase = new Map(promptDigestsOf(live.prompts).map((p) => [p.caseID, p.promptSHA256]));
    const recomputed = [...live.scoredCore]
      .sort((a, b) => (a.caseID < b.caseID ? -1 : a.caseID > b.caseID ? 1 : 0))
      .map((entry) => ({ ...entry, promptSHA256: promptByCase.get(entry.caseID) ?? '' }));
    compare('scoredCoreDigest', manifest.scoredCoreDigest, digestObject(recomputed as unknown as CanonicalValue));
  }
  if (live.evaluators) {
    const recomputed = [...live.evaluators]
      .sort((a, b) => (a.evaluatorID < b.evaluatorID ? -1 : a.evaluatorID > b.evaluatorID ? 1 : 0))
      .map((evaluator) => ({ evaluatorID: evaluator.evaluatorID, digest: sha256Text(evaluator.source) }));
    compare('evaluatorsDigest', manifest.evaluatorsDigest, digestObject(recomputed as unknown as CanonicalValue));
  }
  if (live.candidates) compare('candidatesDigest', manifest.candidatesDigest, digestObject(live.candidates as unknown as CanonicalValue));
  if (live.guards !== undefined) compare('guardsDigest', manifest.guardsDigest, digestObject(live.guards));
  if (live.hardware) compare('hardwareDigest', manifest.hardwareDigest, digestObject(live.hardware as unknown as CanonicalValue));
  // A manifest frozen before format 3 bound no execution policy. Its absence is not a drift — there
  // is nothing frozen to have moved — so it is not compared rather than being reported as one.
  if (live.execution !== undefined && manifest.executionDigest !== undefined) {
    compare('executionDigest', manifest.executionDigest, digestObject(live.execution as unknown as CanonicalValue));
  }
  // A manifest frozen before format 4 bound no operational envelope. Its absence is not a drift —
  // there is nothing frozen to have moved — so, exactly as for the format-3 execution policy, it is
  // not compared rather than being reported as one. This is what keeps a format-3 campaign
  // verifiable, finalizable and resumable with its stored identity untouched.
  if (live.operationalEnvelope !== undefined && manifest.operationalEnvelopeDigest !== undefined) {
    compare('operationalEnvelopeDigest', manifest.operationalEnvelopeDigest, operationalEnvelopeDigest(live.operationalEnvelope));
  }
  compare('runtimeVersion', manifest.runtimeVersion, live.runtimeVersion);

  return {
    manifestID: manifest.manifestID,
    verifiedAt,
    intact: drifts.length === 0,
    drifts,
    hardwareOnly: drifts.length > 0 && drifts.every((drift) => drift.field === 'hardwareDigest'),
  };
}

/**
 * Derive a retest manifest for new hardware.
 *
 * The benchmark itself — prompts, scored core, evaluators, candidates, guards — is carried across
 * byte-identically, because the whole point of a retest is that only the machine changed. The new
 * manifest gets its own identity and a `retestOf` back-reference, so a later reader can see that
 * the two results measure the same benchmark on two machines and are therefore comparable on
 * quality but NOT on latency.
 */
export function deriveRetestManifest(original: FrozenManifest, hardware: HardwareIdentity, runtimeVersion: string,
                                     derivedAt: string, reason: string): FrozenManifest {
  const hardwareDigest = digestObject(hardware as unknown as CanonicalValue);
  if (hardwareDigest === original.hardwareDigest && runtimeVersion === original.runtimeVersion) {
    throw new ManifestError('the hardware and runtime are identical to the original; a retest manifest would be a duplicate, so re-run against the original manifest instead');
  }
  const retestOf = { manifestID: original.manifestID, hardwareDigest: original.hardwareDigest, derivedAt, reason };
  const body = {
    // The ORIGINAL's format, not today's. A retest is the same benchmark on a different machine;
    // re-freezing it at a newer format would change what the identity binds, which is the one thing
    // a retest must not do.
    manifestFormatVersion: original.manifestFormatVersion,
    label: original.label,
    catalogDigest: original.catalogDigest,
    caseCount: original.caseCount,
    repeatsPerCase: original.repeatsPerCase,
    promptsDigest: original.promptsDigest,
    scoredCoreDigest: original.scoredCoreDigest,
    evaluatorsDigest: original.evaluatorsDigest,
    candidatesDigest: original.candidatesDigest,
    guardsDigest: original.guardsDigest,
    hardwareDigest,
    executionDigest: original.executionDigest,
    operationalEnvelopeDigest: original.operationalEnvelopeDigest,
    runtimeVersion,
  };
  const manifestDigest = digestObject({ ...body, retestOf } as unknown as CanonicalValue);
  return {
    ...body,
    manifestID: `manifest:${manifestDigest.slice(0, 16)}`,
    frozenAt: derivedAt,
    promptDigests: original.promptDigests,
    scoredCore: original.scoredCore,
    evaluatorDigests: original.evaluatorDigests,
    candidates: original.candidates,
    guards: original.guards,
    hardware,
    execution: original.execution,
    canonical: original.canonical,
    operationalEnvelope: original.operationalEnvelope,
    retestOf,
    manifestDigest,
  };
}

/** The one-line seal a person can read out loud and compare by eye. */
export function manifestSeal(manifest: FrozenManifest): string {
  return [
    `manifest ${manifest.manifestID}`,
    `catalog ${manifest.catalogDigest.slice(0, 12)}`,
    `prompts ${manifest.promptsDigest.slice(0, 12)}`,
    `core ${manifest.scoredCoreDigest.slice(0, 12)}`,
    `candidates ${manifest.candidatesDigest.slice(0, 12)}`,
    `hardware ${manifest.hardwareDigest.slice(0, 12)}`,
    // Appended only when it is NOT canonical, so a canonical seal reads exactly as it always has and
    // the only seals that carry an extra clause are the ones a reader must not mistake for one.
    ...(manifest.canonical === false ? ['OBSERVE-ONLY'] : []),
    // Likewise: a local-only campaign's seal reads exactly as a format-3 seal did, and the only
    // seals that mention providers are the ones whose numbers a reader must not take as local.
    ...(manifest.operationalEnvelope && manifest.operationalEnvelope.executionClasses.some((entry) => entry !== 'localRuntime')
      ? [`providers ${manifest.operationalEnvelope.providers.join('+')}`, `envelope ${(manifest.operationalEnvelopeDigest ?? '').slice(0, 12)}`]
      : []),
    ...(manifest.operationalEnvelope?.mixed === true ? ['MIXED-EXECUTION — speed and cost not comparable across candidates'] : []),
  ].join(' · ');
}

/** The canonical bytes a manifest file holds. Written once; re-reading it must reproduce the digest. */
export function manifestBytes(manifest: FrozenManifest): string {
  return canonicalJSON(manifest as unknown as CanonicalValue);
}
