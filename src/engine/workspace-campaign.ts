// Benchmark engine · sealing ONE workspace execution into the durable record the rest of this
// engine already keeps.
//
// WHAT THIS IS NOT. It is not a second manifest format, not a second ledger, not a second spend
// system and not a second evidence layout. Every one of those already exists and is used here
// unchanged: `freezeManifest` freezes, `Ledger` records, `SpendTracker` counts, and the terminal
// status is the same `TerminalSlotStatus` a prose row lands in. What this module contributes is the
// ASSEMBLY — which facts about a workspace run go into which of those existing places, and in what
// order, so a later reader can answer one question without reconstructing anything from console
// output:
//
//     What exact task, fixture, tool policy, model route and evaluator produced this score?
//
// WHY THE FIRST LIVE RUN COULD NOT ANSWER IT. It went through `WorkspaceRoutingHost` and stopped
// there. The host authorises, runs, maps usage onto the shared record and scores — deliberately a
// small object, and deliberately not one that writes files. Nothing above it wrote a manifest or a
// ledger row, so the whole proof existed as a scorecard printed to a terminal and a patch on a
// disk that was then deleted. Everything below was already able to record it; nothing had been
// asked to.
//
// WHERE A RECORD LIVES, AND WHY NOT BESIDE A CAMPAIGN. Under `<campaign root>/workspace/<name>/`,
// not `<campaign root>/<name>/`. A workspace record contains a `manifest.json` and a `ledger/`, so
// dropping one into the campaign namespace would make `Campaign.exists` true for a directory that
// has no `configuration.json`, no prose catalogue and no suite IDs — and `cernum status` would meet
// it and fail. A separate namespace costs one path segment and keeps both readers correct.
//
// THE SEAL IS THE MANIFEST'S, AND THE MANIFEST BINDS THE CASE. `workspacePromptRecordOf` and
// `workspaceScoredCoreEntryOf` have existed since the workspace foundation for exactly this: the
// instruction is the prompt, `cwc1:` is the case digest, `cwk1:` is the comparability key, and
// `freezeManifest` binds all three plus the candidate, the hardware, the guards and the operational
// envelope into `manifestDigest`. The fixture digest rides inside `cwc1:` and is ALSO written onto
// the row in plain sight, because a reader checking which tree produced a score should not have to
// recompute a digest to find out.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CanonicalValue, canonicalJSON, digestObject } from './canonical';
import { DEFAULT_EXECUTION_POLICY, ExecutionPolicy } from './execution';
import { guardPolicyForFrontierOnly } from './guards';
import { FrozenManifest, HardwareIdentity, freezeManifest, manifestSeal } from './manifest';
import { Ledger, PlannableCatalog, atomicWriteJSON, slotKey } from './ledger';
import { OperationalEnvelope, ProviderBinding, buildOperationalEnvelope, isMetered } from './provider';
import { SpendTracker, SpendingAuthorization } from './spending';
import { PreRunIdentity } from './workspace-binding';
import { IdentityAdmission, admissionFor, admissionStamp } from './identity-admission';
import { WORKSPACE_REPEAT_IS_NOT_RETRY, WorkspaceRepeat } from './workspace-pack';
import {
  WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey, workspaceInstructionText,
  workspacePlannableCaseOf, workspacePromptRecordOf, workspaceScoredCoreEntryOf, workspaceScoringMode,
} from './workspace-case';
import { WorkspaceAgentDriver, WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, driverShortfalls } from './workspace-agent';
import { WorkspaceAttemptRecord, WorkspaceRunOptions } from './workspace-execution';
import { WorkspaceHostError, WorkspaceOutcome, WorkspaceRoutingHost } from './workspace-host';
import { PATH_RECONCILIATION_IS_NOT_OBSERVATION } from './workspace-path-reconciliation';

export class WorkspaceCampaignError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceCampaignError';
  }
}

export const WORKSPACE_RECORD_FORMAT_VERSION = 1;

/** Where one workspace record lives. One directory, everything in it, nothing outside it. */
export function workspaceRecordPaths(root: string) {
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    ledger: path.join(root, 'ledger'),
    /** The frozen case, verbatim, so a reader never has to find the build that defined it. */
    workspaceCase: path.join(root, 'workspace-case.json'),
    /** The one-file answer to "what produced this score". Derived from the ledger row, never instead of it. */
    record: path.join(root, 'workspace-record.json'),
    /** Per-attempt trees, patches and transcripts, written by the runner's own evidence path. */
    evidence: path.join(root, 'evidence'),
  };
}

/** Every workspace record under a campaign root. Kept out of the campaign namespace deliberately. */
export function workspaceRecordRoot(campaignRoot: string): string {
  return path.join(campaignRoot, 'workspace');
}

// MARK: - What the driver will do, disclosed before it does it

/**
 * A driver that can describe the invocation it WOULD make without making it.
 *
 * DUCK-TYPED ON PURPOSE. `WorkspaceAgentDriver` is the contract every driver honours and it does not
 * require this, because a driver whose tool takes no arguments has nothing to disclose. Widening the
 * contract to demand a method most of its implementations would return an empty object from would be
 * a contract shaped by one tool. A driver that HAS one gets its invocation sealed into the record; a
 * driver that has not is recorded as having disclosed nothing, which is the true statement.
 */
export interface WorkspaceInvocationPlan {
  args: string[];
  toolNames: string[];
  allowedToolRules: string[];
  activeIsolation: string[];
  notEnforceable: string[];
  unexpressed: string[];
}

interface DriverWithPreflight {
  executablePath?: string;
  argumentsFor(tools: WorkspaceCase['execution']['tools'], networkPolicy: WorkspaceCase['execution']['networkPolicy'],
               sampling?: { temperatureMilli?: number; seed?: number }): WorkspaceInvocationPlan;
}

function preflightOf(driver: WorkspaceAgentDriver): DriverWithPreflight | undefined {
  const candidate = driver as unknown as Partial<DriverWithPreflight>;
  return typeof candidate.argumentsFor === 'function' ? candidate as DriverWithPreflight : undefined;
}

/** Everything about the driver a record must carry, and a preflight must print. */
export interface WorkspaceDriverDisclosure extends Record<string, CanonicalValue | undefined> {
  driverID: string;
  provider: string;
  executablePath?: string;
  capabilities: CanonicalValue;
  /** Non-empty means the case CANNOT be run through this driver. Refused before anything is spent. */
  capabilityShortfalls: string[];
  /** The argument vector, when the driver can state one. Never the instruction: that goes on stdin. */
  invocation?: string[];
  toolNames?: string[];
  allowedToolRules?: string[];
  activeIsolation?: string[];
  /** Settings sent and not enforced. Recorded on every run; never a refusal. */
  notEnforceable?: string[];
  /** Settings the case froze and the tool cannot express. Non-empty means nothing is sent. */
  unexpressed?: string[];
  /** True when this driver could not describe its own invocation. Stated rather than left blank. */
  invocationUndisclosed: boolean;
  /** What `argv[0]` is called, so a preflight prints the tool's name rather than a driver id. */
  commandName?: string;
  /** The CLI version the driver's flags were read from. Absent when the driver states none. */
  cliVersionVerifiedAgainst?: string;
}

export function discloseWorkspaceDriver(driver: WorkspaceAgentDriver, workspaceCase: WorkspaceCase): WorkspaceDriverDisclosure {
  const shortfalls = driverShortfalls(driver, workspaceCase.execution.tools, workspaceCase.execution.networkPolicy);
  const preflight = preflightOf(driver);
  const described = driver as unknown as { commandName?: unknown; cliVersionVerifiedAgainst?: unknown };
  const naming = {
    commandName: typeof described.commandName === 'string' ? described.commandName : undefined,
    cliVersionVerifiedAgainst: typeof described.cliVersionVerifiedAgainst === 'string'
      ? described.cliVersionVerifiedAgainst : undefined,
  };
  if (preflight === undefined) {
    return {
      driverID: driver.driverID,
      provider: driver.provider,
      capabilities: driver.capabilities as unknown as CanonicalValue,
      capabilityShortfalls: shortfalls,
      invocationUndisclosed: true,
      ...naming,
    };
  }
  const plan = preflight.argumentsFor(workspaceCase.execution.tools, workspaceCase.execution.networkPolicy, {
    temperatureMilli: workspaceCase.execution.temperatureMilli,
    seed: workspaceCase.execution.seed,
  });
  return {
    driverID: driver.driverID,
    provider: driver.provider,
    executablePath: preflight.executablePath,
    capabilities: driver.capabilities as unknown as CanonicalValue,
    capabilityShortfalls: shortfalls,
    invocation: plan.args,
    toolNames: plan.toolNames,
    allowedToolRules: plan.allowedToolRules,
    activeIsolation: plan.activeIsolation,
    notEnforceable: plan.notEnforceable,
    unexpressed: plan.unexpressed,
    invocationUndisclosed: false,
    ...naming,
  };
}

// MARK: - The catalogue a workspace case plans as

/**
 * `cwx1:` — the identity of the set of workspace cases a record plans.
 *
 * Its own tag, for the reason every digest in this codebase has one: a reader must be able to tell
 * which scheme produced a string, and a workspace catalogue is not the prose `EngineCatalogue`.
 */
export function workspaceCatalogDigest(cases: WorkspaceCase[]): string {
  return 'cwx1:' + digestObject(cases.map(workspaceCaseDigest).sort());
}

/** The plan the shared `buildPlan` takes. Nothing in the ledger learns this is a workspace case. */
export function workspacePlannableCatalog(workspaceCase: WorkspaceCase): PlannableCatalog {
  return {
    catalogDigest: workspaceCatalogDigest([workspaceCase]),
    caseCount: 1,
    repeatsPerCase: 1,
    suites: [{
      slug: workspaceCase.suiteID,
      block: 'workspace',
      executionOrdinal: 0,
      cases: [workspacePlannableCaseOf(workspaceCase, 0)],
    }],
  };
}

/**
 * The evaluators a workspace verdict rests on, as the manifest binds them.
 *
 * NOT A SOURCE FILE'S TEXT, which is what `evaluatorBindings()` digests on the prose side. A
 * workspace verdict is decided by the case's own declared checks — its verification commands, its
 * hidden checks, its invariants and its scoring weights — and those are DATA. Digesting the data is
 * what makes "the same evaluator" a checkable claim: change a command and the manifest moves.
 */
export function workspaceEvaluatorBindings(workspaceCase: WorkspaceCase): { evaluatorID: string; source: string }[] {
  return [
    {
      evaluatorID: `workspace.verification@${workspaceCase.id}`,
      source: canonicalJSON(workspaceCase.verification as unknown as CanonicalValue),
    },
    {
      evaluatorID: `${workspaceCase.scoring.id}@${workspaceCase.scoring.version}`,
      source: canonicalJSON(workspaceCase.scoring as unknown as CanonicalValue),
    },
  ];
}

/**
 * The execution policy a workspace record freezes.
 *
 * `managed` IS THE HONEST VALUE HERE, and the reasoning is the same one `buildCampaignPlan` already
 * applies to a frontier-only campaign: residency is about unloading a LOCAL candidate's weights
 * before the next one loads, a workspace run reaches no local runtime, and there is therefore
 * nothing whose release could have gone unproved. Recording `observeOnly` would stamp the row
 * `NONCANONICAL` and attach `NONCANONICAL_REASONS`, every line of which is about a second local
 * model being measured against a machine still holding the first one's weights — a caution that is
 * not merely unnecessary here but false.
 *
 * `runtimeDefault` for thinking, because no workspace driver expresses a thinking mode and
 * asserting `disabled` would describe a setting nobody sent.
 */
export const WORKSPACE_EXECUTION_POLICY: ExecutionPolicy = {
  ...DEFAULT_EXECUTION_POLICY,
  residency: 'managed',
  thinkingMode: 'runtimeDefault',
};

// MARK: - Inputs

export interface WorkspaceCampaignInputs {
  /** The record directory. Created here; refused if one already exists. */
  root: string;
  label: string;
  case: WorkspaceCase;
  /** The frozen binding, already validated by `buildWorkspaceBinding`. */
  binding: ProviderBinding;
  /** What was known about the route BEFORE the request. Sealed; never overwritten afterwards. */
  identity: PreRunIdentity;
  /**
   * The sealed authorization under which an unprovable route runs, when it runs under one.
   *
   * Frozen INTO THE MANIFEST, exactly as a prose campaign freezes it, so the record carries the
   * authorization it ran under and a changed one breaks the seal. Required whenever the identity was
   * resolved from an admission; refused when it was not.
   */
  identityAdmission?: IdentityAdmission;
  driver: WorkspaceAgentDriver;
  hardware: HardwareIdentity;
  runtimeVersion: string;
  /** Absolute. The case's `fixturePath` resolves inside it. */
  fixtureRoot: string;
  /** Absolute, outside every Git working tree. `assertSandboxRootIsSafe` enforces it. */
  sandboxRoot: string;
  /**
   * WHICH SAMPLE OF THIS CELL THIS RECORD IS, when the run was planned as part of a repeated matrix.
   *
   * ABSENT ON A ONE-OFF RUN, and absent is the truth there: `cernum workspace <case>` takes one
   * sample and was never one of a set. Present, it says which of how many, and carries the group id
   * every sibling repeat carries — which is what lets an aggregate prove it combined SEPARATE runs
   * rather than re-counting one. Each repeat still gets its own record directory, its own manifest
   * and its own ledger; nothing here makes two repeats share a file.
   */
  repeat?: WorkspaceRepeat;
  /** The pack this run was planned from, when it was planned from one. Recorded, never acted on. */
  pack?: { id: string; version: string; digest: string };
  /** The OPERATOR's ceiling on attempts, when there is one. Never raises the case's own. */
  attemptCeiling?: number;
  preserveFailedWorkspaces?: boolean;
  /** Required before a metered binding may run. Subscription and local runs need none. */
  authorization?: SpendingAuthorization;
  environmentSource?: NodeJS.ProcessEnv;
  now?: () => Date;
  shouldCancel?: () => boolean;
  onAttempt?: (record: WorkspaceAttemptRecord) => void;
  /** Injected by the tests so a verification command need not be a real process. */
  runCommand?: WorkspaceRunOptions['runCommand'];
}

/**
 * The one-file answer to "what produced this score".
 *
 * DERIVED FROM THE LEDGER ROW AND THE MANIFEST, never written independently of them: it is a
 * convenience for a reader, and a convenience that could disagree with the evidence would be worse
 * than no convenience. Everything in it appears in the row or the manifest too.
 */
export interface WorkspaceDurableRecord extends Record<string, CanonicalValue | undefined> {
  workspaceRecordFormatVersion: number;
  recordedAt: string;
  label: string;
  manifestID: string;
  manifestDigest: string;
  manifestSeal: string;
  slotKey: string;
  status: string;
  detail: string;
  compositeMilli?: number;

  caseID: string;
  caseVersion: string;
  caseDigest: string;
  comparabilityKey: string;
  scoringMode: string;
  /** Which sample of its cell this run was, and how many were planned. Absent on a one-off run. */
  repeatIndex?: number;
  repeatsPlanned?: number;
  repeatGroupID?: string;
  packID?: string;
  packVersion?: string;
  packDigest?: string;
  /** What a repeat is, and what it is not, carried on every record that has one. */
  repeatDisclosure?: string;
  fixturePath: string;
  /** What the case was SEALED against. Absent on an unsealed case, which is stated rather than hidden. */
  fixtureExpectedTreeDigest?: string;
  /** What this run actually copied in. Equal to the above on every sealed case that ran. */
  fixtureObservedTreeDigest?: string;

  provider: string;
  executionClass: string;
  billingBasis: string;
  requestedModelID: string;
  executionContract: string;
  tokenCeiling: string;
  /** WHAT WAS KNOWN BEFORE THE REQUEST. Sealed at creation; never rewritten by what came back. */
  bindingIdentityState: string;
  bindingIdentityEvidence: string;
  bindingIdentityResolvedFrom: string;
  bindingIdentityProvenAt?: string;
  /** The sealed admission this run was permitted under, when it was. Present exactly on an admitted run. */
  identityAdmissionDigest?: string;
  /** The one-line stamp every surface prints beside an admitted candidate. See `admissionStamp`. */
  identityAdmissionStamp?: string;
  /**
   * Present exactly when a MATRIX admission produced this run's admission: `workspaceMatrix`, the
   * matrix admission's `cma1:` digest, the authorising entry's `cme1:` digest, and the identity
   * limitation the operator accepted. Absent on a single-record admission, so those rows are unchanged.
   */
  identityAdmissionScope?: string;
  matrixAdmissionDigest?: string;
  matrixAdmissionEntryDigest?: string;
  identityLimitation?: string;
  /** WHAT THIS EXECUTION ESTABLISHED. Written after; never written over the three fields above. */
  executionIdentityVerdict?: string;
  executionIdentityDetail?: string;
  reportedModelID?: string;

  driverID: string;
  driverExecutablePath?: string;
  driverCapabilities: CanonicalValue;
  capabilityShortfalls: string[];
  driverInvocation?: string[];
  driverNotEnforceable?: string[];
  driverUnexpressed?: string[];

  environmentAllowlist: string[];
  networkPolicy: string;
  toolPolicy: CanonicalValue;
  timeoutMilliseconds: number;
  caseMaximumAttempts: number;
  attemptCeilingApplied?: number;

  workspaceBaselineTreeDigest?: string;
  workspaceFinalTreeDigest?: string;
  patchDigest?: string;
  patchByteCount?: number;
  changedFileCount?: number;
  changedLineCount?: number;
  scopeClean?: boolean;
  verification?: CanonicalValue;
  transitions?: CanonicalValue;
  regressionCount?: number;
  transcriptDigest?: string;
  /** Where the sealed per-attempt transcript was written. Relative to this record's root. */
  transcriptEvidencePath?: string;

  inputTokens?: number;
  visibleOutputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  usageProvenance?: string;
  costMicroUSD?: number;
  costProvenance?: string;
  subscriptionIncludedUsageMicroUSD?: number;
  subscriptionAllowanceState?: string;

  attemptsUsed?: number;
  retriesRequired?: number;
  wallClockMilliseconds?: number;
  wastedMilliseconds?: number;
  wastedTokens?: number;

  disclosures: string[];
}

// MARK: - The record

/**
 * One workspace case, for one bound candidate, sealed into a durable record.
 *
 * `create` freezes and writes. `run` executes through the SAME `WorkspaceRoutingHost` a caller
 * without a record would use, then appends one terminal row and writes the evidence. Splitting them
 * is what lets a preflight freeze nothing and a live run resume nothing: a record exists exactly
 * when something was actually committed to.
 */
export class WorkspaceCampaign {
  private constructor(
    readonly root: string,
    readonly manifest: FrozenManifest,
    readonly ledger: Ledger,
    readonly inputs: WorkspaceCampaignInputs,
    readonly envelope: OperationalEnvelope,
    readonly driverDisclosure: WorkspaceDriverDisclosure,
    readonly spend: SpendTracker,
  ) {}

  static create(inputs: WorkspaceCampaignInputs): WorkspaceCampaign {
    const paths = workspaceRecordPaths(inputs.root);
    if (fs.existsSync(paths.manifest)) {
      throw new WorkspaceCampaignError('recordExists',
        `a workspace record already exists at ${inputs.root}. A second manifest frozen over the same evidence would `
        + 'make it impossible to say which run produced which row. Name a different record.');
    }

    // THE ADMISSION AND THE IDENTITY MUST AGREE. An admitted identity with no record to freeze would be
    // an exception nobody can audit; a record beside a proven identity would freeze an authorization
    // that authorised nothing.
    if ((inputs.identity.resolvedFrom === 'identityAdmission') !== (inputs.identityAdmission !== undefined)) {
      throw new WorkspaceCampaignError('identityAdmissionMismatch',
        inputs.identityAdmission === undefined
          ? 'this run\'s identity was resolved from an identity admission, and no admission record was given to freeze. '
            + 'An exception that is not in the manifest is an exception nobody can audit.'
          : 'an identity admission was given, and this run\'s identity was not resolved from it. Freezing an '
            + 'authorization that authorised nothing would make the manifest claim an exception this run did not use.');
    }

    // AND THE ADMISSION MUST ADMIT THIS RUN — this record's label, this binding's exact route — through
    // the same gate a prose campaign uses. An admission sealed for another record, another model or
    // another effort is refused here even if a caller hands it over.
    if (inputs.identityAdmission !== undefined) {
      assertAdmissionAdmitsThisRun(inputs);
    }

    const workspaceCase = inputs.case;
    const now = inputs.now ?? (() => new Date());
    const frozenAt = now().toISOString().replace(/\.\d{3}Z$/, 'Z');

    // ONE ENVELOPE, ONE BINDING, AND `buildOperationalEnvelope` VALIDATES IT. This is the line the
    // first live run could not get past: a workspace binding's zero budgets were refused as an
    // `emptyBudget` by a rule written for prose requests. It now declares its contract and passes.
    const envelope = buildOperationalEnvelope([inputs.binding]);

    const catalogue = workspacePlannableCatalog(workspaceCase);
    const manifest = freezeManifest({
      label: inputs.label,
      catalogDigest: catalogue.catalogDigest,
      caseCount: 1,
      repeatsPerCase: 1,
      // THE INSTRUCTION IS THE PROMPT, composed by the case and never by the driver, so the
      // manifest's `promptsDigest` seals the exact text the model was handed.
      prompts: [workspacePromptRecordOf(workspaceCase)],
      scoredCore: [workspaceScoredCoreEntryOf(workspaceCase)],
      evaluators: workspaceEvaluatorBindings(workspaceCase),
      candidates: [{
        name: inputs.binding.candidate,
        modelID: inputs.binding.requestedModelID,
        // A frontier model has no local weights. The identifier the provider itself confirmed is the
        // strongest identity available for one, and it is empty when nothing confirmed it.
        runtimeDigest: inputs.binding.verifiedModelID,
        parameterSize: '',
        quantization: '',
      }],
      // A workspace run reaches no local runtime, so there is no benchmark lane to hold and no model
      // store to drift. Everything that is a property of THIS machine still is.
      guards: guardPolicyForFrontierOnly() as unknown as CanonicalValue,
      hardware: inputs.hardware,
      runtimeVersion: inputs.runtimeVersion,
      execution: WORKSPACE_EXECUTION_POLICY,
      operationalEnvelope: envelope,
      identityAdmission: inputs.identityAdmission,
      frozenAt,
    });

    fs.mkdirSync(inputs.root, { recursive: true });
    atomicWriteJSON(paths.manifest, manifest as unknown as CanonicalValue);
    // THE CASE ITSELF, VERBATIM, BESIDE ITS DIGEST. `cwc1:` proves a case did not change; it does not
    // tell a reader six months from now what the task WAS. Both are needed and neither substitutes.
    atomicWriteJSON(paths.workspaceCase, {
      case: workspaceCase as unknown as CanonicalValue,
      caseDigest: workspaceCaseDigest(workspaceCase),
      comparabilityKey: workspaceComparabilityKey(workspaceCase),
      instructionAsSent: workspaceInstructionText(workspaceCase),
    });

    const ledger = Ledger.create(paths.ledger, catalogue, [{
      name: inputs.binding.candidate, modelID: inputs.binding.requestedModelID,
    }], {
      workspaceRecordFormatVersion: WORKSPACE_RECORD_FORMAT_VERSION,
      label: inputs.label,
      manifestID: manifest.manifestID,
      manifestDigest: manifest.manifestDigest,
      manifestFormatVersion: manifest.manifestFormatVersion,
      caseID: workspaceCase.id,
      caseVersion: workspaceCase.version,
      caseDigest: workspaceCaseDigest(workspaceCase),
      comparabilityKey: workspaceComparabilityKey(workspaceCase),
      providers: envelope.providers as unknown as CanonicalValue,
      executionClasses: envelope.executionClasses as unknown as CanonicalValue,
      mixedExecution: envelope.mixed,
      hasMeteredBinding: envelope.hasMeteredBinding,
      canonical: true,
    });

    const disclosure = discloseWorkspaceDriver(inputs.driver, workspaceCase);
    ledger.event('workspaceRecordCreated', {
      manifestID: manifest.manifestID,
      caseID: workspaceCase.id,
      caseDigest: workspaceCaseDigest(workspaceCase),
      driverID: disclosure.driverID,
      requestedModelID: inputs.binding.requestedModelID,
      // THE PRE-RUN FACT, WRITTEN BEFORE THE REQUEST AND TIMESTAMPED BY THE EVENT STREAM. An event
      // appended at creation cannot be confused with a verdict reached afterwards, whatever a later
      // reader does with the row.
      bindingIdentityState: inputs.binding.identityState,
      bindingIdentityResolvedFrom: inputs.identity.resolvedFrom,
      bindingIdentityProvenAt: inputs.identity.provenAt,
      bindingIdentityEvidence: inputs.identity.evidence,
      repeatIndex: inputs.repeat?.repeatIndex,
      repeatsPlanned: inputs.repeat?.repeatsPlanned,
      repeatGroupID: inputs.repeat?.repeatGroupID,
      packID: inputs.pack?.id,
      packDigest: inputs.pack?.digest,
    });
    ledger.writeCheckpoint();

    const spend = new SpendTracker(inputs.authorization, envelopeDigestOf(envelope));
    return new WorkspaceCampaign(inputs.root, manifest, ledger, inputs, envelope, disclosure, spend);
  }

  get paths() {
    return workspaceRecordPaths(this.root);
  }

  /** `candidate|suite|1|caseID` — the same identity a prose slot has, from the same function. */
  get slotKey(): string {
    return slotKey(this.inputs.binding.candidate, this.inputs.case.suiteID, 1, this.inputs.case.id);
  }

  /**
   * Execute, seal the row, write the evidence, and return both.
   *
   * THE EXECUTION ITSELF IS THE HOST'S, unchanged. This method adds the durability the host
   * deliberately does not have: it decides nothing about the outcome and computes no metric.
   */
  async run(): Promise<{ outcome: WorkspaceOutcome; record: WorkspaceDurableRecord }> {
    const host = new WorkspaceRoutingHost({ spend: this.spend });

    // THE SPEND CHECK COMES FIRST, and before any directory is made. A subscription binding is
    // allowed and spends no money; a metered one is checked against its authorized ceiling, and a
    // refusal here has cost nothing.
    const authorization = await host.authorizeAttempt({ case: this.inputs.case, binding: this.inputs.binding });
    if (!authorization.allowed) {
      this.ledger.event('workspaceRunRefused', {
        code: authorization.code, reason: authorization.reason, detail: authorization.detail,
      });
      throw new WorkspaceCampaignError(authorization.code ?? 'notAuthorized',
        authorization.reason ?? 'this workspace run is not authorized and nothing was started');
    }

    this.ledger.event('workspaceRunStarted', {
      slotKey: this.slotKey,
      attemptCeiling: this.inputs.attemptCeiling,
      caseMaximumAttempts: this.inputs.case.execution.maximumAttempts,
      sandboxRoot: this.inputs.sandboxRoot,
      fixtureRoot: this.inputs.fixtureRoot,
    });

    let outcome: WorkspaceOutcome;
    try {
      outcome = await host.run({
        case: this.inputs.case,
        binding: this.inputs.binding,
        driver: this.inputs.driver,
        fixtureRoot: this.inputs.fixtureRoot,
        sandboxRoot: this.inputs.sandboxRoot,
        // THE RUNNER'S OWN EVIDENCE PATH, pointed inside this record. Patches and transcripts land
        // beside the ledger that references them rather than in a directory somebody has to be told
        // about separately.
        evidenceRoot: this.paths.evidence,
        preserveFailedWorkspaces: this.inputs.preserveFailedWorkspaces,
        attemptCeiling: this.inputs.attemptCeiling,
        environmentSource: this.inputs.environmentSource,
        shouldCancel: this.inputs.shouldCancel,
        onAttempt: this.inputs.onAttempt,
        runCommand: this.inputs.runCommand,
      });
    } catch (error) {
      // A THROW HERE IS THE CALLER HAVING ASKED FOR SOMETHING IMPOSSIBLE — a missing fixture, a
      // sandbox inside a working tree. It is recorded in the event stream and re-thrown: it is not
      // an outcome of the model, so it must not become a terminal row that looks like one.
      this.ledger.event('workspaceRunFaulted', {
        code: error instanceof WorkspaceHostError ? error.code : 'executionError',
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const record = this.seal(outcome);
    return { outcome, record };
  }

  /**
   * Append the terminal row, write the derived record, and checkpoint.
   *
   * ONE ROW PER RUN, through `Ledger.appendResult`, which refuses a status it cannot name and puts
   * every string through the secret scrubber on its way to disk. Nothing here writes a second file
   * that a reader might take for the evidence.
   */
  private seal(outcome: WorkspaceOutcome): WorkspaceDurableRecord {
    const card = outcome.scorecard;
    const deciding = outcome.run.attempts[outcome.run.attempts.length - 1];
    const workspaceCase = this.inputs.case;
    const binding = this.inputs.binding;
    const transcriptEvidencePath = deciding === undefined ? undefined
      : path.posix.join('evidence', workspaceCase.id, `attempt-${deciding.attemptIndex}`, 'transcript.jsonl');

    const row = {
      slotKey: this.slotKey,
      status: card.status,
      caseID: workspaceCase.id,
      candidate: binding.candidate,
      suite: workspaceCase.suiteID,
      pass: 1,
      detail: card.detail,

      // ---- the task, the fixture and the evaluator -------------------------------------------
      caseVersion: workspaceCase.version,
      caseDigest: card.caseDigest,
      comparabilityKey: card.comparabilityKey,
      scoringMode: workspaceScoringMode(workspaceCase),
      // WHICH SAMPLE, AND OF WHAT. On the row as well as on the record, because the row is the
      // authority and an aggregate that had to read a directory name to tell two repeats apart
      // would be an aggregate built on a filename convention.
      repeatIndex: this.inputs.repeat?.repeatIndex,
      repeatsPlanned: this.inputs.repeat?.repeatsPlanned,
      repeatGroupID: this.inputs.repeat?.repeatGroupID,
      packID: this.inputs.pack?.id,
      packVersion: this.inputs.pack?.version,
      packDigest: this.inputs.pack?.digest,
      scoringPolicyID: card.scoringPolicyID,
      scoringPolicyVersion: card.scoringPolicyVersion,
      fixturePath: workspaceCase.source.fixturePath,
      fixtureExpectedTreeDigest: workspaceCase.source.expectedTreeDigest,
      fixtureObservedTreeDigest: deciding?.fixtureTreeDigest,
      networkPolicy: workspaceCase.execution.networkPolicy,
      toolPolicy: workspaceCase.execution.tools,
      environmentAllowlist: workspaceCase.execution.environmentAllowlist,
      timeoutMilliseconds: workspaceCase.execution.timeoutMilliseconds,
      caseMaximumAttempts: workspaceCase.execution.maximumAttempts,
      attemptCeilingApplied: outcome.attemptCeilingApplied?.ceiling,

      // ---- the route ---------------------------------------------------------------------------
      provider: outcome.frontier.provider,
      executionClass: outcome.frontier.executionClass,
      billingBasis: outcome.frontier.billingBasis,
      requestedModelID: outcome.frontier.requestedModelID,
      reportedModelID: outcome.frontier.reportedModelID,
      executionContract: binding.executionContract ?? 'proseCompletion',
      tokenCeiling: binding.tokenCeiling ?? 'boundedByBinding',
      effort: binding.effort,

      // ---- identity, in two halves that never overwrite each other ----------------------------
      bindingIdentityState: outcome.frontier.bindingIdentityState,
      bindingIdentityEvidence: this.inputs.identity.evidence,
      bindingIdentityResolvedFrom: this.inputs.identity.resolvedFrom,
      bindingIdentityProvenAt: this.inputs.identity.provenAt,
      ...admissionFieldsOf(this.inputs.identityAdmission),
      executionIdentityVerdict: outcome.frontier.executionIdentityVerdict,
      executionIdentityDetail: outcome.frontier.executionIdentityDetail,

      // ---- the driver --------------------------------------------------------------------------
      driverID: outcome.run.driverID,
      driverExecutablePath: this.driverDisclosure.executablePath,
      driverCapabilities: this.driverDisclosure.capabilities,
      capabilityShortfalls: [...this.driverDisclosure.capabilityShortfalls, ...outcome.run.refusedBecause],
      driverInvocation: this.driverDisclosure.invocation,
      driverNotEnforceable: (deciding?.agent.notEnforceable ?? this.driverDisclosure.notEnforceable),
      driverUnexpressed: (deciding?.agent.unexpressed ?? this.driverDisclosure.unexpressed),
      driverActiveIsolation: (deciding?.agent.activeIsolation ?? this.driverDisclosure.activeIsolation),

      // ---- what the engine OBSERVED ------------------------------------------------------------
      workspaceBaselineTreeDigest: deciding?.baselineTreeDigest,
      workspaceFinalTreeDigest: deciding?.finalTreeDigest,
      patchDigest: card.patchDigest,
      patchByteCount: card.patchByteCount,
      changedFileCount: card.changedFileCount,
      changedLineCount: card.changedLineCount,
      changedPaths: (deciding?.diff.changedPaths ?? []),
      scopeClean: deciding?.scope.clean,
      scopeViolations: (deciding?.scope.violations ?? []),
      executablesOutsidePolicy: (deciding?.executablesOutsidePolicy ?? []),
      verificationOutcomes: (deciding?.verificationOutcomes ?? []),
      hiddenOutcomes: (deciding?.hiddenOutcomes ?? []),
      baselineOutcomes: (deciding?.baselineOutcomes ?? []),
      invariantOutcomes: (deciding?.invariantOutcomes ?? []),
      transitions: card.transitions,
      regressionCount: card.regressionCount,
      fixedCount: card.fixedCount,
      terminationReason: deciding?.terminationReason,
      harnessFaultCode: deciding?.harnessFault?.code,
      preservedAt: deciding?.preservedAt,

      // ---- the transcript ----------------------------------------------------------------------
      transcriptDigest: card.transcriptDigest,
      transcriptEvidencePath,
      transcriptSummary: (deciding?.transcript.summary ?? undefined),

      // ---- the score ---------------------------------------------------------------------------
      compositeMilli: card.compositeMilli.valueMilli,
      compositeUnavailableReason: card.compositeMilli.unavailableReason,
      metricsMilli: card.metricsMilli,

      // ---- tokens, cost, allowance, timing and waste -------------------------------------------
      inputTokens: outcome.frontier.inputTokens,
      freshInputTokens: outcome.frontier.freshInputTokens,
      cacheCreationInputTokens: outcome.frontier.cacheCreationInputTokens,
      cacheReadInputTokens: outcome.frontier.cacheReadInputTokens,
      visibleOutputTokens: outcome.frontier.visibleOutputTokens,
      reasoningTokens: outcome.frontier.reasoningTokens,
      totalTokens: outcome.frontier.totalTokens,
      usageProvenance: outcome.frontier.usageProvenance,
      costMicroUSD: outcome.frontier.costMicroUSD,
      costProvenance: outcome.frontier.costProvenance,
      subscriptionIncludedUsageMicroUSD: outcome.frontier.subscriptionIncludedUsageMicroUSD,
      subscriptionAllowanceState: outcome.frontier.subscriptionAllowanceState,
      subscriptionAllowanceProvenance: outcome.frontier.subscriptionAllowanceProvenance,
      subscriptionAllowanceExplanation: outcome.frontier.subscriptionAllowanceExplanation,
      providerReportedUsage: outcome.frontier.rawUsage,
      attemptsUsed: card.attemptsUsed,
      retryCount: outcome.frontier.retryCount,
      retriesRequired: card.retriesRequired,
      wastedTokens: outcome.frontier.wastedTokens,
      wastedMilliseconds: card.wastedMilliseconds,
      wallClockMilliseconds: card.wallClockMilliseconds,
      // THE SAME NUMBER UNDER THE NAME EVERY EXISTING READER ALREADY LOOKS FOR. `attemptMetricsFromRow`
      // — the one place in this engine that turns a ledger row into metrics — reads
      // `latencyMilliseconds`, and it has read it since Pass 3. A workspace row that recorded its wall
      // clock only as `wallClockMilliseconds` would have been a row the shared aggregator saw as
      // having no timing at all, and the alternative to writing this key is a second aggregator.
      // `wallClockMilliseconds` stays beside it, spelled the way a workspace reader expects.
      latencyMilliseconds: card.wallClockMilliseconds,
      timeToFirstTokenMilliseconds: outcome.frontier.timeToFirstTokenMilliseconds,
      timedOut: outcome.frontier.timedOut,
      providerThrottled: card.providerThrottled,

      // The caveats that travel with every workspace row, so a row read on its own still carries them.
      workspaceEnvironmentDisclosure: WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX,
      pathReconciliationDisclosure: PATH_RECONCILIATION_IS_NOT_OBSERVATION,
      repeatDisclosure: this.inputs.repeat === undefined ? undefined : WORKSPACE_REPEAT_IS_NOT_RETRY,
      canonical: true,
    };

    const stored = this.ledger.appendResult(row as unknown as Parameters<Ledger['appendResult']>[0]);
    this.ledger.writeCheckpoint();
    this.ledger.event('workspaceRunSealed', {
      slotKey: this.slotKey, status: card.status, patchDigest: card.patchDigest,
      transcriptDigest: card.transcriptDigest, compositeMilli: card.compositeMilli.valueMilli,
      executionIdentityVerdict: outcome.frontier.executionIdentityVerdict,
    });

    const record: WorkspaceDurableRecord = {
      workspaceRecordFormatVersion: WORKSPACE_RECORD_FORMAT_VERSION,
      recordedAt: stored.recordedAt,
      label: this.inputs.label,
      manifestID: this.manifest.manifestID,
      manifestDigest: this.manifest.manifestDigest,
      manifestSeal: manifestSeal(this.manifest),
      slotKey: this.slotKey,
      status: card.status,
      detail: card.detail,
      compositeMilli: card.compositeMilli.valueMilli,

      caseID: workspaceCase.id,
      caseVersion: workspaceCase.version,
      caseDigest: card.caseDigest,
      comparabilityKey: card.comparabilityKey,
      scoringMode: workspaceScoringMode(workspaceCase),
      repeatIndex: this.inputs.repeat?.repeatIndex,
      repeatsPlanned: this.inputs.repeat?.repeatsPlanned,
      repeatGroupID: this.inputs.repeat?.repeatGroupID,
      packID: this.inputs.pack?.id,
      packVersion: this.inputs.pack?.version,
      packDigest: this.inputs.pack?.digest,
      repeatDisclosure: this.inputs.repeat === undefined ? undefined : WORKSPACE_REPEAT_IS_NOT_RETRY,
      fixturePath: workspaceCase.source.fixturePath,
      fixtureExpectedTreeDigest: workspaceCase.source.expectedTreeDigest,
      fixtureObservedTreeDigest: deciding?.fixtureTreeDigest,

      provider: binding.provider,
      executionClass: binding.executionClass,
      billingBasis: binding.billingBasis,
      requestedModelID: binding.requestedModelID,
      executionContract: binding.executionContract ?? 'proseCompletion',
      tokenCeiling: binding.tokenCeiling ?? 'boundedByBinding',
      bindingIdentityState: binding.identityState,
      bindingIdentityEvidence: this.inputs.identity.evidence,
      bindingIdentityResolvedFrom: this.inputs.identity.resolvedFrom,
      bindingIdentityProvenAt: this.inputs.identity.provenAt,
      ...admissionFieldsOf(this.inputs.identityAdmission),
      executionIdentityVerdict: outcome.frontier.executionIdentityVerdict,
      executionIdentityDetail: outcome.frontier.executionIdentityDetail,
      reportedModelID: outcome.frontier.reportedModelID,

      driverID: outcome.run.driverID,
      driverExecutablePath: this.driverDisclosure.executablePath,
      driverCapabilities: this.driverDisclosure.capabilities,
      capabilityShortfalls: [...this.driverDisclosure.capabilityShortfalls, ...outcome.run.refusedBecause],
      driverInvocation: this.driverDisclosure.invocation,
      driverNotEnforceable: deciding?.agent.notEnforceable ?? this.driverDisclosure.notEnforceable,
      driverUnexpressed: deciding?.agent.unexpressed ?? this.driverDisclosure.unexpressed,

      environmentAllowlist: workspaceCase.execution.environmentAllowlist,
      networkPolicy: workspaceCase.execution.networkPolicy,
      toolPolicy: workspaceCase.execution.tools as unknown as CanonicalValue,
      timeoutMilliseconds: workspaceCase.execution.timeoutMilliseconds,
      caseMaximumAttempts: workspaceCase.execution.maximumAttempts,
      attemptCeilingApplied: outcome.attemptCeilingApplied?.ceiling,

      workspaceBaselineTreeDigest: deciding?.baselineTreeDigest,
      workspaceFinalTreeDigest: deciding?.finalTreeDigest,
      patchDigest: card.patchDigest,
      patchByteCount: card.patchByteCount,
      changedFileCount: card.changedFileCount,
      changedLineCount: card.changedLineCount,
      scopeClean: deciding?.scope.clean,
      verification: (deciding?.verificationOutcomes ?? []) as unknown as CanonicalValue,
      transitions: card.transitions as unknown as CanonicalValue,
      regressionCount: card.regressionCount,
      transcriptDigest: card.transcriptDigest,
      transcriptEvidencePath,

      inputTokens: outcome.frontier.inputTokens,
      visibleOutputTokens: outcome.frontier.visibleOutputTokens,
      reasoningTokens: outcome.frontier.reasoningTokens,
      totalTokens: outcome.frontier.totalTokens,
      usageProvenance: outcome.frontier.usageProvenance,
      costMicroUSD: outcome.frontier.costMicroUSD,
      costProvenance: outcome.frontier.costProvenance,
      subscriptionIncludedUsageMicroUSD: outcome.frontier.subscriptionIncludedUsageMicroUSD,
      subscriptionAllowanceState: outcome.frontier.subscriptionAllowanceState,

      attemptsUsed: card.attemptsUsed,
      retriesRequired: card.retriesRequired,
      wallClockMilliseconds: card.wallClockMilliseconds,
      wastedMilliseconds: card.wastedMilliseconds,
      wastedTokens: outcome.frontier.wastedTokens,

      disclosures: [WORKSPACE_ENVIRONMENT_IS_NOT_A_SANDBOX, PATH_RECONCILIATION_IS_NOT_OBSERVATION],
    };
    atomicWriteJSON(this.paths.record, record as unknown as CanonicalValue);
    return record;
  }
}

function envelopeDigestOf(envelope: OperationalEnvelope): string {
  return digestObject(envelope as unknown as CanonicalValue);
}

export function isMeteredWorkspaceRun(binding: ProviderBinding): boolean {
  return isMetered(binding);
}

/**
 * The admission fields a row and a record carry, or none. Empty on every run that was not admitted,
 * so a record written before admissions existed and one written after without one are byte-identical.
 */
function admissionFieldsOf(admission: IdentityAdmission | undefined): {
  identityAdmissionDigest?: string; identityAdmissionStamp?: string; identityAdmissionScope?: string;
  matrixAdmissionDigest?: string; matrixAdmissionEntryDigest?: string; identityLimitation?: string;
} {
  if (admission === undefined) return {};
  const fields = {
    identityAdmissionDigest: admission.admissionDigest,
    identityAdmissionStamp: admission.admitted.map(admissionStamp).join(' · '),
  };
  if (admission.matrixAdmission === undefined) return fields;
  return {
    ...fields,
    identityAdmissionScope: admission.matrixAdmission.admissionScope,
    matrixAdmissionDigest: admission.matrixAdmission.matrixAdmissionDigest,
    matrixAdmissionEntryDigest: admission.matrixAdmission.entryDigest,
    identityLimitation: admission.matrixAdmission.identityLimitation,
  };
}

/**
 * Refuse an admission that does not admit THIS run.
 *
 * The existing gate first: this record's label, this binding's provider, model and effort. Then, for a
 * record admission a matrix produced, every fact the matrix admission was sealed to must be the fact
 * this record is about to freeze — the pack, the driver, the execution class and the billing basis. A
 * matrix admission for one route can therefore never be carried onto a record of another.
 */
function assertAdmissionAdmitsThisRun(inputs: WorkspaceCampaignInputs): void {
  const admission = inputs.identityAdmission;
  if (admission === undefined) return;
  const decision = admissionFor({
    provider: inputs.binding.provider,
    modelID: inputs.binding.requestedModelID,
    effort: inputs.binding.effort,
    campaignLabel: inputs.label,
    admission,
  });
  if (!decision.admitted) {
    throw new WorkspaceCampaignError('identityAdmissionMismatch',
      `the identity admission given does not admit this run: ${decision.reason}`);
  }
  const reference = admission.matrixAdmission;
  if (reference === undefined) return;
  const mismatches = ([
    ['pack id', reference.packID, inputs.pack?.id],
    ['pack version', reference.packVersion, inputs.pack?.version],
    ['pack digest', reference.packDigest, inputs.pack?.digest],
    ['driver', reference.driverID, inputs.driver.driverID],
    ['execution class', reference.executionClass, inputs.binding.executionClass],
    ['billing basis', reference.billingBasis, inputs.binding.billingBasis],
  ] as const).filter(([, admitted, bound]) => admitted !== bound);
  if (mismatches.length > 0) {
    throw new WorkspaceCampaignError('identityAdmissionMismatch',
      `this run's matrix admission (${reference.matrixAdmissionDigest}) was sealed to a different `
      + `${mismatches.map(([name, admitted, bound]) => `${name} (admitted ${admitted}, bound ${bound ?? 'none'})`).join('; ')}. `
      + 'A matrix admission covers the exact route, pack, driver and billing basis it names, and nothing else.');
  }
}
