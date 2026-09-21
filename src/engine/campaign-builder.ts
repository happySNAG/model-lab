// Benchmark engine · turning "I want to compare these models" into a frozen campaign, once.
//
// WHY THIS EXISTS AT ALL. Pass 3 already learned this lesson the expensive way: the desktop service
// and the terminal each decided for themselves how to configure a host, they decided differently,
// and the same campaign ran two different ways depending on which button started it. The fix was
// `hostOptionsFor`, one function both call.
//
// The surface area that could drift is now much larger. A frontier campaign has a provider per
// candidate, an effort level, a thinking mode, sampling settings, two token budgets, a timeout, a
// retry policy, a billing basis, a pricing snapshot and an authorization mode — and every one of
// them is bound into the manifest identity. Two surfaces building those separately would not merely
// behave differently; they would produce campaigns with DIFFERENT IDENTITIES for the same request,
// which is the one failure a frozen manifest exists to make impossible.
//
// So there is exactly one builder, and both surfaces call it. `test/engine/surface-parity.test.ts`
// asserts that a request expressed in terminal flags and the same request expressed as an IPC
// payload produce byte-identical configurations.
//
// AN UNPROVEN MODEL IS REFUSED HERE. Not filtered out of a list somewhere, not greyed out in an
// interface — refused, by the builder, with a message naming what would prove it. A model name is a
// plan, and nothing but discovery or an identity smoke test turns a plan into something a campaign
// may spend real money on.
//
// PASS 6 ADDS EXACTLY ONE WAY PAST THAT REFUSAL, and it is not a weakening of it. A campaign may
// carry a sealed `IdentityAdmission` naming specific configurations on a provider whose interface
// structurally cannot name the model that answered — Codex since Pass 6, OpenCode since Pass 7, and
// nothing else; see `IDENTITY_ADMISSIBLE_PROVIDERS`. A candidate that
// record names is built with the identity state `requestAcceptedIdentityUnverifiable` instead of
// being refused. Everything else is unchanged: a campaign without a record refuses every unproven
// candidate exactly as before, on every provider; the record is per campaign and per configuration;
// and the admitted binding's `verifiedModelID` stays empty, because nothing named a model. The
// refusal message for a campaign that HAS a record but does not name this candidate says which of
// those it was, since "unproven" and "not admitted" are different problems with different fixes.

import {
  CostEligibilityVerdict, CostPolicyOverride, ZeroMarginalCostConfirmation,
  costEligibilityAgreesWithBillingBasis, costEligibilityFor,
} from './cost-eligibility';
import { ThinkingMode } from './execution';
import { EngineCatalogue, buildEngineCatalogue } from './catalogue';
import { HardwareIdentity, ManifestCandidate } from './manifest';
import { PlannableCandidate } from './ledger';
import { CampaignConfiguration } from './campaign';
import { GuardPolicy, StoreBaseline, guardPolicyForEndpoint, guardPolicyForFrontierOnly } from './guards';
import { ExecutionPolicy } from './execution';
import {
  DEFAULT_RETRY, EffortLevel, OperationalEnvelope, PricingSnapshot, ProviderBinding, ProviderBindingError,
  ProviderID, RetryPolicy, SamplingSettings, buildOperationalEnvelope, executionClassOf, billingBasisOf,
  localOllamaBinding,
} from './provider';
import { DiscoveredFrontierModel } from './discovery';
import { openCodeInputBudget } from './opencode-cli';
import { PlannedWork } from './spending';
import {
  AdmittedCandidateEvidence, IdentityAdmission, REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE, admissionFor,
  admissionProvenance,
} from './identity-admission';

export class CampaignBuildError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CampaignBuildError';
  }
}

/** A local model, as discovery found it installed. */
export interface LocalCandidateRequest {
  name: string;
  modelID: string;
  runtimeDigest: string;
  parameterSize: string;
  quantization: string;
}

/** A model somebody else runs. Every field is frozen; nothing here is defaulted silently at run time. */
export interface FrontierCandidateRequest {
  /** The candidate name in this campaign. Distinct per candidate, because a model at two efforts is two candidates. */
  name: string;
  provider: ProviderID;
  modelID: string;
  effort: EffortLevel;
  thinkingMode: ThinkingMode;
  /** Required for a metered provider, refused for the others. Never fetched; always supplied by a person. */
  pricing?: PricingSnapshot;
  retry?: RetryPolicy;
  sampling?: SamplingSettings;
  timeoutMilliseconds?: number;
  /** Defaults to the frozen budgets the chosen suites imply. Override only with a reason. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Which of the two key sources the credential was found in. Decided by the resolver, never guessed. */
  authorizationMode?: 'apiKeyEnvironment' | 'apiKeyKeychain' | 'toolManagedCredential';
}

export interface CampaignPlanRequest {
  label: string;
  suiteIDs: string[];
  repeatsPerCase: number;
  local: LocalCandidateRequest[];
  frontier: FrontierCandidateRequest[];
  /** The frozen execution policy for the LOCAL candidates. Frontier candidates have no residency. */
  observeOnly?: boolean;
  thinkingMode?: ThinkingMode;
  endpoint: string;
  hardware: HardwareIdentity;
  runtimeVersion: string;
  storeBaseline?: StoreBaseline;
  residencyDelayMilliseconds?: number;
  guardOverrides?: Partial<GuardPolicy>;
  /**
   * What discovery actually proved this account can invoke.
   *
   * Required whenever there is a frontier candidate. Passing an empty list does not mean "skip the
   * check"; it means nothing is proven, and every frontier candidate is refused.
   */
  provenModels?: DiscoveredFrontierModel[];
  /**
   * A sealed authorization to run named Codex configurations whose identity cannot be proven.
   *
   * Absent on almost every campaign, and absence is the safe state: without it, an unproven
   * candidate is refused. Supplied, it still admits only the exact configurations it names, only on
   * `codexCLI`, and only for the campaign whose label it carries.
   */
  identityAdmission?: IdentityAdmission;
  /**
   * Confirmations that a METERED candidate costs this account nothing at the margin.
   *
   * Absent on almost every campaign, and absence is the safe state: without one, a metered candidate
   * is `metered` and the cost policy blocks it. A published $0 catalogue price is not one of these —
   * see `ZeroMarginalCostConfirmation`, which requires the account's own billing record.
   */
  costConfirmations?: ZeroMarginalCostConfirmation[];
  /**
   * Explicit written overrides permitting a blocked candidate to run anyway.
   *
   * Never inferred from a flag or the presence of a pricing file. One per exact configuration, and
   * an override for `metered` does not cover `unknown_cost`.
   */
  costOverrides?: CostPolicyOverride[];
}

export interface BuiltCampaign {
  configuration: CampaignConfiguration;
  catalogue: EngineCatalogue;
  envelope: OperationalEnvelope;
  /** What the spending estimator needs, derived from the same frozen catalogue the manifest binds. */
  plannedWork: PlannedWork[];
  /** True when no candidate runs on this machine: the campaign takes no endpoint lease. */
  frontierOnly: boolean;
  /**
   * The candidates admitted WITHOUT a proven identity, if any.
   *
   * Returned separately from the bindings so a surface can disclose them without walking the
   * envelope looking for a state — and so a caller that forgets to look gets an empty list rather
   * than silence. Empty on every campaign that carries no admission record.
   */
  admittedWithoutProvenIdentity: AdmittedCandidateEvidence[];
  /**
   * Who pays for each candidate, and what established that.
   *
   * Returned beside the bindings rather than stored in them, deliberately. A binding is frozen into
   * the manifest digest, and cost eligibility is a fact about an ACCOUNT at a moment rather than
   * about the campaign's identity — freezing it would make a campaign re-verified after a billing
   * change fail its own digest check for a reason that has nothing to do with what it measured. The
   * structural `billingBasis` stays in the binding, where it belongs.
   */
  costEligibility: { candidate: string; verdict: CostEligibilityVerdict }[];
}

/**
 * The default budgets a campaign's own suites imply.
 *
 * Derived from the FROZEN catalogue rather than typed in: a budget that does not match the benchmark
 * would either truncate an answer the scoring rules expect in full, or authorise spending on tokens
 * the benchmark never asks for. The input budget is the largest any case declares, with headroom for
 * the prompt itself.
 */
export function budgetsFor(catalogue: EngineCatalogue): { maxInputTokens: number; maxOutputTokens: number } {
  let maxOutputTokens = 0;
  let maxInputTokens = 0;
  for (const entry of catalogue.plannable.suites) {
    for (const benchmarkCase of entry.cases) {
      maxOutputTokens = Math.max(maxOutputTokens, benchmarkCase.maxOutputTokens);
      maxInputTokens = Math.max(maxInputTokens, benchmarkCase.inputBudgetTokens);
    }
  }
  return {
    // A floor of 1 rather than 0: a budget of zero is not a budget, and `validateBinding` refuses it.
    maxOutputTokens: Math.max(1, maxOutputTokens),
    maxInputTokens: Math.max(1, maxInputTokens),
  };
}

/** Every planned attempt's prompt length, per candidate, from the frozen prompts. Exact, not sampled. */
export function plannedWorkFor(catalogue: EngineCatalogue, candidateNames: string[], repeatsPerCase: number): PlannedWork[] {
  let charactersPerPass = 0;
  for (const prompt of catalogue.prompts) {
    charactersPerPass += prompt.text.length + (prompt.suppliedContext?.length ?? 0);
  }
  const attemptsPerCandidate = catalogue.plannable.caseCount * repeatsPerCase;
  return candidateNames.map((candidate) => ({
    candidate,
    plannedAttempts: attemptsPerCandidate,
    promptCharacters: charactersPerPass * repeatsPerCase,
  }));
}

/**
 * Build one campaign's configuration, or refuse with a reason a person can act on.
 *
 * Nothing is written to disk here and nothing is frozen; this produces the configuration that
 * `Campaign.create` then freezes. Keeping the two apart is what lets a cost preview show exactly
 * what a campaign WOULD be without creating it.
 */
export function buildCampaignPlan(request: CampaignPlanRequest): BuiltCampaign {
  if (request.local.length === 0 && request.frontier.length === 0) {
    throw new CampaignBuildError('noCandidates', 'a campaign with no candidates measures nothing');
  }
  const catalogue = buildEngineCatalogue(request.suiteIDs, request.repeatsPerCase);
  const defaults = budgetsFor(catalogue);
  const thinkingMode: ThinkingMode = request.thinkingMode ?? 'disabled';
  const execution: ExecutionPolicy = {
    residency: request.observeOnly === true ? 'observeOnly' : 'managed',
    thinkingMode,
  };

  const names = new Set<string>();
  const candidates: (PlannableCandidate & ManifestCandidate)[] = [];
  const bindings: ProviderBinding[] = [];
  const admitted: AdmittedCandidateEvidence[] = [];
  const costEligibility: { candidate: string; verdict: CostEligibilityVerdict }[] = [];

  for (const local of request.local) {
    if (names.has(local.name)) throw new CampaignBuildError('duplicateCandidate', `${local.name} is named twice`);
    names.add(local.name);
    candidates.push({
      name: local.name, modelID: local.modelID, runtimeDigest: local.runtimeDigest,
      parameterSize: local.parameterSize, quantization: local.quantization,
    });
    // Classified even though the answer is never in doubt. A disclosure that listed only the
    // candidates that COULD cost money would leave a reader to infer the rest, and the whole point
    // of this table is that who pays is stated for every row rather than inferred for most of them.
    costEligibility.push({ candidate: local.name, verdict: costEligibilityFor({
      provider: 'ollama', modelID: local.modelID,
      confirmations: request.costConfirmations, overrides: request.costOverrides,
    }) });
    bindings.push(localOllamaBinding({
      candidate: local.name,
      modelID: local.modelID,
      runtimeDigest: local.runtimeDigest,
      thinkingMode,
      maxInputTokens: defaults.maxInputTokens,
      maxOutputTokens: defaults.maxOutputTokens,
      // The largest execution budget any chosen case declares, so a local timeout is the benchmark's
      // own rather than a number invented here.
      timeoutMilliseconds: Math.max(1_000, ...[...catalogue.cases.values()].map((c) => c.executionBudgetMilliseconds)),
    }));
  }

  const proven = new Map((request.provenModels ?? [])
    .filter((model) => model.availability === 'proven')
    .map((model) => [`${model.provider}:${model.modelID}`, model]));

  for (const frontier of request.frontier) {
    if (names.has(frontier.name)) throw new CampaignBuildError('duplicateCandidate', `${frontier.name} is named twice`);
    names.add(frontier.name);

    const key = `${frontier.provider}:${frontier.modelID}`;
    const discovered = proven.get(key);
    // Consulted only when discovery did not prove the candidate. A proven candidate is built from
    // its proof and never from an exception, even where a record would also have admitted it: the
    // stronger evidence wins, and an unnecessary admission must not downgrade a real identity.
    const admission = discovered ? undefined : admissionFor({
      provider: frontier.provider,
      modelID: frontier.modelID,
      effort: frontier.effort,
      campaignLabel: request.label,
      admission: request.identityAdmission,
    });
    if (!discovered && !admission?.admitted) {
      // The refusal that makes the whole "desired candidate" discipline real. A model nobody proved
      // this account can call must not be spendable on, and must not be recorded as having answered.
      throw new CampaignBuildError('unprovenModel',
        `${frontier.modelID} on ${frontier.provider} has not been proven callable by this account, so it cannot be `
        + 'put in a campaign. A model identifier is a plan, not a capability: run provider discovery, or an identity '
        + 'smoke test that establishes this exact model by name, and select it once something has confirmed it.'
        + (request.identityAdmission === undefined ? ''
          // Said out loud, because a campaign that HAS an authorization and still refuses looks like
          // a broken authorization, and the reader needs to know which of the two it is.
          : ` This campaign carries an identity admission record, and it does not admit this candidate: ${admission?.reason}`));
    }

    const executionClass = executionClassOf(frontier.provider);
    const billingBasis = billingBasisOf(executionClass);

    // COST ELIGIBILITY IS CLASSIFIED HERE AND ENFORCED SOMEWHERE ELSE, ON PURPOSE.
    //
    // This function is the PRICING and PREVIEW path as much as it is the build path: `cernum cost`,
    // the desktop's estimate and the Pass 7 estimate script all reach a campaign plan through it
    // WITHOUT intending to run one. Refusing a blocked candidate here would mean a cohort you may
    // not run is also a cohort you cannot see the price of — which is exactly backwards, because the
    // reason to price an excluded cohort is to decide whether to seek an exception for it.
    //
    // So the verdict is computed here, where the provider and the model are both known, and carried
    // out on `BuiltCampaign`. The refusal lives at the one place a request actually leaves —
    // `RoutingHost.authorizeAttempt` — beside the spending gate it is a sibling of.
    const costVerdict = costEligibilityFor({
      provider: frontier.provider, modelID: frontier.modelID, executionClass,
      confirmations: request.costConfirmations, overrides: request.costOverrides,
    });
    if (!costEligibilityAgreesWithBillingBasis(costVerdict.eligibility, billingBasis)) {
      throw new CampaignBuildError('costEligibilityMismatch',
        `${frontier.name}: cost eligibility ${costVerdict.eligibility} cannot be true of a ${billingBasis} `
        + 'binding. The two describe the same candidate and one of them is wrong.');
    }
    costEligibility.push({ candidate: frontier.name, verdict: costVerdict });

    if (billingBasis === 'meteredAPI' && !frontier.pricing) {
      throw new CampaignBuildError('noPricing',
        `${frontier.name} is billed per token and no pricing snapshot was supplied. Cernum will not estimate a cost `
        + 'from prices it invented, and will not run a paid campaign it cannot price. Supply the provider\'s published '
        + 'prices and when you captured them.');
    }
    if (billingBasis !== 'meteredAPI' && frontier.pricing) {
      throw new CampaignBuildError('pricingOnUnmetered',
        `${frontier.name} is ${billingBasis} and is not billed per token, so a per-token price on it would be a number `
        + 'that looks like a cost and is not one');
    }
    if (billingBasis === 'meteredAPI' && !frontier.authorizationMode && frontier.provider !== 'opencodeCLI') {
      throw new CampaignBuildError('noAuthorizationMode',
        `${frontier.name} is billed per token and its binding does not say where its key comes from. That is recorded `
        + 'in the manifest so a later reader knows which credential produced these answers.');
    }

    // The candidate the manifest pins. A frontier model has no local weights, so `runtimeDigest` is
    // the identifier the provider itself confirmed — which is the strongest identity available for
    // one, and is empty when discovery could not confirm one.
    candidates.push({
      name: frontier.name,
      modelID: frontier.modelID,
      runtimeDigest: '',
      parameterSize: '',
      quantization: '',
    });

    if (admission?.admitted && admission.evidence) admitted.push(admission.evidence);

    bindings.push({
      candidate: frontier.name,
      provider: frontier.provider,
      executionClass,
      requestedModelID: frontier.modelID,
      identityState: discovered === undefined ? REQUEST_ACCEPTED_IDENTITY_UNVERIFIABLE
        : discovered.verifiedModelID.length > 0 ? 'verified' : 'unverifiable',
      // EMPTY FOR AN ADMITTED CANDIDATE, and empty is the point. `frontier.modelID` is sitting right
      // there and putting it here would make every artefact read as though the provider had named
      // it. `validateBinding` refuses a non-empty one in this state, so this is enforced twice.
      verifiedModelID: discovered?.verifiedModelID ?? '',
      identityEvidence: discovered?.evidence ?? admissionProvenance(admission!.evidence!).join(' · '),
      effort: frontier.effort,
      thinkingMode: frontier.thinkingMode,
      sampling: frontier.sampling ?? { temperatureMilli: null, topPMilli: null, seed: null },
      // OPENCODE PAYS A MEASURED TAX ON TOP OF THE PROMPT, AND THE BUDGET SAYS SO.
      //
      // `defaults` describes the campaign's own prompts and nothing else. That is the right number
      // for a provider Cernum hands a prompt to. `opencode run` is handed a prompt and sends an
      // AGENT TURN, and the one live request this engine has made measured 7,933 input-side tokens
      // for a prompt worth about 5 — so the default was 13.5x below the request, in the one figure
      // `worstCaseAttemptMicroUSD` stops a run against. Added rather than maximised, because every
      // attempt is its own `--pure` session and pays the whole overhead again. Applied to an
      // explicit override too: the override sizes the PROMPT, and the tax is not the prompt.
      // See `OPENCODE_INPUT_BUDGET_DERIVATION`.
      maxInputTokens: frontier.provider === 'opencodeCLI'
        ? openCodeInputBudget(frontier.maxInputTokens ?? defaults.maxInputTokens)
        : frontier.maxInputTokens ?? defaults.maxInputTokens,
      maxOutputTokens: frontier.maxOutputTokens ?? defaults.maxOutputTokens,
      timeoutMilliseconds: frontier.timeoutMilliseconds ?? 300_000,
      retry: frontier.retry ?? DEFAULT_RETRY,
      billingBasis,
      pricing: frontier.pricing ?? null,
      authorizationMode: executionClass === 'subscriptionCLI' ? 'subscriptionCLISession'
        // OpenCode is metered AND holds its own credential, so it defaults to neither an environment
        // variable nor the keychain: Cernum has no key for it and must not imply that it does.
        : frontier.provider === 'opencodeCLI' ? 'toolManagedCredential'
          : frontier.authorizationMode ?? 'apiKeyEnvironment',
    });
  }

  let envelope: OperationalEnvelope;
  try {
    envelope = buildOperationalEnvelope(bindings);
  } catch (error) {
    if (error instanceof ProviderBindingError) throw new CampaignBuildError(error.code, error.message);
    throw error;
  }

  const frontierOnly = request.local.length === 0;
  const configuration: CampaignConfiguration = {
    label: request.label,
    suiteIDs: request.suiteIDs,
    repeatsPerCase: request.repeatsPerCase,
    candidates,
    hardware: request.hardware,
    runtimeVersion: request.runtimeVersion,
    execution,
    operationalEnvelope: envelope,
    // A frontier-only campaign has no local lane to hold and no local store to drift, so neither is
    // guarded. Everything that is a property of THIS machine — disk, swap, memory — still is.
    guardPolicy: frontierOnly
      ? guardPolicyForFrontierOnly(request.guardOverrides)
      : guardPolicyForEndpoint(request.endpoint, request.guardOverrides),
    storeBaseline: frontierOnly ? undefined : request.storeBaseline,
    residencyDelayMilliseconds: request.residencyDelayMilliseconds ?? 5_000,
    // Carried onto the configuration only when it actually admitted something. An authorization
    // that admitted nothing is not recorded as having governed this campaign, because it did not.
    identityAdmission: admitted.length > 0 ? request.identityAdmission : undefined,
  };

  return {
    configuration,
    catalogue,
    envelope,
    plannedWork: plannedWorkFor(catalogue, candidates.map((candidate) => candidate.name), request.repeatsPerCase),
    frontierOnly,
    admittedWithoutProvenIdentity: admitted,
    costEligibility,
  };
}
