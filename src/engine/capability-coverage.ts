// Benchmark engine · DEBUGGING and INSTRUCTION COMPLIANCE as first-class capabilities, derived — never
// measured separately — from the workspace dimensions the sealed cases already declare.
//
// WHAT THIS IS. Ordra asks "may this route debug?" and "does this route do what it was told?". No case
// declares either word; the cases declare finer dimensions. This file is ONE documented, versioned
// mapping from those dimensions to the two capabilities, and one rule for combining the dimensions'
// existing verdicts into a verdict for each. The mapping and its justification are in
// `docs/ordra-lane/capability-coverage.md`; the version is `CAPABILITY_MAPPING_VERSION`.
//
// WHAT IT IS NOT, AND EACH OF THESE IS A RULE.
//
//   NOT A NEW POLICY. It decides nothing about runs. Every component verdict is the `workspace:<dimension>`
//   verdict `route-qualification.ts` already gave under whichever qualification policy the record carries
//   (cqp1 by default), and this file only combines them. A stricter policy there is a stricter verdict here.
//   NOT A SCORE. Nothing is averaged and no run count is summed across components: the components are
//   VIEWS of the same runs — a case declaring two of them counts under both — so a total would count a run
//   twice. Each component is carried on the entry with its own counts and cases.
//   NO EVIDENCE IS UNCOVERED, NEVER QUALIFIED. A capability none of whose dimensions has a row, or whose
//   only rows never exercised the dimension (a retry dimension over first-attempt passes), is `uncovered`.
//   `uncovered` is not `notQualified` — that is a finding — and it is not `insufficientEvidence` either,
//   which means some evidence exists and is too thin.
//
// THE COMBINATION RULE (ccm1), over the components that are COVERED — have a verdict other than
// `notExercised`:
//   none covered                          → uncovered
//   any covered component notQualified    → notQualified
//   any covered component insufficient    → insufficientEvidence
//   every covered component qualified     → qualified, with `coverage` saying `full` or `partial`
// A partial qualification names the components that were not covered, so a reader can see that
// "debugging qualified" rests on failure interpretation and not yet on recovery.

import { CapabilityQualification, CapabilityVerdict, RouteQualificationRecord } from './route-qualification';
import { WorkspaceDimension } from './workspace-case';

export const CAPABILITY_COVERAGE_SCHEMA = 'ccc1';
export const CAPABILITY_MAPPING_VERSION = 'ccm1';

export type DerivedCapability = 'debugging' | 'instructionCompliance';

/**
 * THE MAPPING, version ccm1. Changing a list here changes what a verdict means, so it is a new version:
 * the coverage test pins this exact table to `ccm1`.
 */
export const DERIVED_CAPABILITY_MAPPING: Readonly<Record<DerivedCapability, readonly WorkspaceDimension[]>> = {
  // Reading what a failing check says, repairing from it, and repairing from the engine's own report.
  debugging: ['failureInterpretation', 'recoveryFromError', 'verificationDrivenRecovery'],
  // Staying inside the asked-for scope, meeting the stated contract rather than the visible tests, and
  // changing only what was asked while leaving the rest exactly as it was.
  instructionCompliance: ['scopeDiscipline', 'contractOverVisibleTests', 'preservationUnderTransformation'],
};

export const ALL_DERIVED_CAPABILITIES: DerivedCapability[] = ['debugging', 'instructionCompliance'];

export const UNCOVERED_IS_NOT_QUALIFIED =
  'A derived capability with no covered component is UNCOVERED: there is no evidence about it, which is neither a '
  + 'qualification nor a finding against the route. Run cases that declare its dimensions to cover it.';

export type DerivedCapabilityVerdict = Exclude<CapabilityVerdict, 'notExercised'> | 'uncovered';
export type CapabilityCoverageExtent = 'none' | 'partial' | 'full';

/** One mapped dimension as the route's record holds it. */
export interface CapabilityCoverageComponent {
  dimension: WorkspaceDimension;
  /** `workspace:<dimension>`, the record entry it was read from. */
  capability: string;
  /** The component's own verdict; `uncovered` when the record has no entry or the entry was never exercised. */
  state: CapabilityVerdict | 'uncovered';
  covered: boolean;
  scoredRunCount: number;
  successCount: number;
  evidenceRefs: string[];
  reason: string;
}

export interface DerivedCapabilityCoverage {
  /** `derived:debugging` or `derived:instructionCompliance`. */
  capability: string;
  derivedCapability: DerivedCapability;
  verdict: DerivedCapabilityVerdict;
  coverage: CapabilityCoverageExtent;
  components: CapabilityCoverageComponent[];
  uncoveredDimensions: WorkspaceDimension[];
  /** The cases behind every covered component, once each. Not a run count. */
  evidenceRefs: string[];
  reason: string;
}

export interface CapabilityCoverageRecord {
  schema: typeof CAPABILITY_COVERAGE_SCHEMA;
  mappingVersion: typeof CAPABILITY_MAPPING_VERSION;
  routeKey: string;
  /** The qualification policy the component verdicts were given under. Carried, never re-decided. */
  policyID: string;
  capabilities: DerivedCapabilityCoverage[];
  disclosure: string;
}

function componentOf(dimension: WorkspaceDimension, entries: CapabilityQualification[]): CapabilityCoverageComponent {
  const capability = `workspace:${dimension}`;
  const entry = entries.find((candidate) => candidate.source === 'workspace' && candidate.capability === capability);
  if (entry === undefined) {
    return { dimension, capability, state: 'uncovered', covered: false, scoredRunCount: 0, successCount: 0, evidenceRefs: [],
      reason: `no case in the evidence declares ${dimension}` };
  }
  const covered = entry.verdict !== 'notExercised';
  return {
    dimension, capability, state: covered ? entry.verdict : 'uncovered', covered,
    scoredRunCount: entry.scoredRunCount, successCount: entry.successCount, evidenceRefs: [...entry.evidenceRefs],
    reason: covered ? entry.reason : `cases declare ${dimension} but no run exercised it (${entry.reason})`,
  };
}

/** The combination rule, ccm1. Exported so the test can hold every combination to it. */
export function combineComponentVerdicts(components: CapabilityCoverageComponent[]):
  { verdict: DerivedCapabilityVerdict; coverage: CapabilityCoverageExtent } {
  const covered = components.filter((component) => component.covered);
  const coverage: CapabilityCoverageExtent = covered.length === 0 ? 'none' : covered.length === components.length ? 'full' : 'partial';
  if (covered.length === 0) return { verdict: 'uncovered', coverage };
  if (covered.some((component) => component.state === 'notQualified')) return { verdict: 'notQualified', coverage };
  if (covered.some((component) => component.state !== 'qualified')) return { verdict: 'insufficientEvidence', coverage };
  return { verdict: 'qualified', coverage };
}

function reasonFor(verdict: DerivedCapabilityVerdict, components: CapabilityCoverageComponent[]): string {
  const covered = components.filter((component) => component.covered);
  const uncovered = components.filter((component) => !component.covered).map((component) => component.dimension);
  const by = (state: string) => covered.filter((component) => component.state === state).map((component) => component.dimension);
  const missing = uncovered.length === 0 ? '' : `; not covered: ${uncovered.join(', ')}`;
  switch (verdict) {
    case 'uncovered': return `none of ${components.map((component) => component.dimension).join(', ')} has evidence. ${UNCOVERED_IS_NOT_QUALIFIED}`;
    case 'notQualified': return `not qualified on ${by('notQualified').join(', ')}${missing}`;
    case 'insufficientEvidence': return `too little evidence on ${by('insufficientEvidence').join(', ')}${missing}`;
    default: return `qualified on ${covered.map((component) => component.dimension).join(', ')}${missing}`;
  }
}

/**
 * Derive both capabilities from a route's qualification record. PURE: it reads the record's
 * `workspace:` entries and returns a value; the record itself is not changed.
 */
export function deriveCapabilityCoverage(
  record: Pick<RouteQualificationRecord, 'routeKey' | 'policy' | 'capabilities'>,
): CapabilityCoverageRecord {
  return {
    schema: CAPABILITY_COVERAGE_SCHEMA,
    mappingVersion: CAPABILITY_MAPPING_VERSION,
    routeKey: record.routeKey,
    policyID: record.policy.policyID,
    capabilities: ALL_DERIVED_CAPABILITIES.map((derivedCapability) => {
      const components = DERIVED_CAPABILITY_MAPPING[derivedCapability].map((dimension) => componentOf(dimension, record.capabilities));
      const { verdict, coverage } = combineComponentVerdicts(components);
      return {
        capability: `derived:${derivedCapability}`,
        derivedCapability,
        verdict,
        coverage,
        components,
        uncoveredDimensions: components.filter((component) => !component.covered).map((component) => component.dimension),
        evidenceRefs: [...new Set(components.filter((component) => component.covered).flatMap((component) => component.evidenceRefs))].sort(),
        reason: reasonFor(verdict, components),
      };
    }),
    disclosure: `${CAPABILITY_MAPPING_VERSION}: derived from workspace dimension verdicts given under ${record.policy.policyID}; `
      + `no run is counted twice and nothing is averaged. ${UNCOVERED_IS_NOT_QUALIFIED}`,
  };
}

/** One line per derived capability. */
export function describeCapabilityCoverage(entry: DerivedCapabilityCoverage): string {
  return [
    entry.capability.padEnd(30),
    entry.verdict.padEnd(21),
    `coverage ${entry.coverage}`.padEnd(17),
    entry.components.map((component) => `${component.dimension}=${component.state}`).join(' '),
  ].join('  ').trimEnd();
}
