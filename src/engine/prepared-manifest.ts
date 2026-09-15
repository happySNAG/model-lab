// Benchmark engine · a campaign written down before it is authorised to exist.
//
// WHY A PREPARED MANIFEST IS NOT A FROZEN ONE. `cernum create` freezes a manifest by BINDING each
// candidate to a provider and proving its identity, which costs one real request per configuration.
// That is the right thing to do at the moment a campaign is authorised, and the wrong thing to do
// when the instruction is "prepare, but do not execute": it would spend the allowance and start the
// identity-evidence clock for a run nobody has approved yet.
//
// So a prepared manifest is the complete, reviewable statement of the intended campaign — every
// case named, every exclusion named with its reason, and the exact commands that would run it —
// computed from the sealed catalog alone, with no provider contacted. It is a document, not an
// authorisation, and it says so.
//
// THE EXCLUSION IS THE POINT, in the case this was written for. `claude-fable-5-1@high` cannot be
// measured on `case:safety-boundaries:refuse-harm`: the provider answers requests for it with
// `claude-opus-5`, deterministically, four times out of four, while the same model answers every
// other case as itself. Cernum refuses to record a substituted answer, so the whole
// `safety-boundaries` dimension is dropped rather than measured on two cases out of three and
// reported as if it were a dimension score.
//
// AND THE REPORT MUST SAY SO. `evidenceCaveat` below is not decoration: a 41-case run produces a
// ranking with thirteen dimensions and a fourteenth that is ABSENT, and the one mistake that would
// make the whole exercise dishonest is letting a reader — or a future summariser — fill that
// absence in with an average of the other thirteen.

import { BenchmarkSuite } from '../core/benchmark';
import { registeredSuites } from '../core/catalog';

export interface PreparedCase {
  caseID: string;
  suiteID: string;
  dimension: string;
  capabilityUnderTest: string;
}

export interface PreparedExclusion {
  suiteID: string;
  dimension: string;
  caseIDs: string[];
  reason: string;
}

export interface PreparedManifest {
  preparedAt: string;
  name: string;
  /** NOT frozen, NOT authorised, and nothing has been sent. Stated in the artefact itself. */
  state: 'prepared';
  candidate: { name: string; provider: string; requestedModelID: string; effort: string };
  repeatsPerCase: number;
  suiteIDs: string[];
  cases: PreparedCase[];
  caseCount: number;
  excluded: PreparedExclusion[];
  excludedCaseCount: number;
  dimensionsWithoutEvidence: string[];
  evidenceCaveat: string;
  beforeItMayRun: string[];
  commands: string[];
}

export const NO_EVIDENCE_CAVEAT_TEMPLATE =
  'THIS CAMPAIGN PRODUCES NO EVIDENCE FOR: {dimensions}. The dimension is not weak, not borderline and '
  + 'not zero — it is ABSENT, because the cases that would measure it were excluded before the run for a '
  + 'stated reason. Any report of this campaign must say that the dimension has no evidence, must leave its '
  + 'rate unavailable rather than computing one, and must never infer, impute, interpolate or average a '
  + 'score for it from the dimensions that were measured. A model with no safety evidence is a model with '
  + 'no safety evidence.';

export const FABLE_SUBSTITUTION_REASON =
  'The provider answers requests for this configuration on `case:safety-boundaries:refuse-harm` with a '
  + 'different model — observed 4 times out of 4, while the same configuration answers every other case as '
  + 'itself and the other configurations answer this same case as themselves. Cernum refuses to record an '
  + 'answer under a name that did not produce it, so the attempt cannot be made. The remaining two cases in '
  + 'this suite are excluded WITH it: a dimension scored on the subset a provider happens to permit is a '
  + 'dimension whose rate measures the provider\'s routing as much as the model, and publishing it beside '
  + 'thirteen complete dimensions would invite exactly the comparison it cannot support.';

function suitesFor(suiteIDs: string[]): BenchmarkSuite[] {
  return suiteIDs.map((id) => {
    const suite = registeredSuites.find((candidate) => candidate.id.raw === id);
    if (!suite) throw new Error(`no suite ${id} in the sealed catalog; a prepared manifest names only sealed suites`);
    return suite;
  });
}

/**
 * Write down the campaign, including everything it will not measure.
 *
 * `excludeSuiteIDs` is a list of SUITES, not cases, deliberately: excluding a case leaves a partial
 * dimension, and a partial dimension is the failure mode this whole artefact exists to prevent.
 */
export function prepareManifest(input: {
  name: string;
  candidate: { name: string; provider: string; requestedModelID: string; effort: string };
  suiteIDs: string[];
  excludeSuiteIDs: string[];
  exclusionReason: string;
  repeatsPerCase: number;
  preparedAt: string;
  beforeItMayRun?: string[];
}): PreparedManifest {
  const kept = input.suiteIDs.filter((id) => !input.excludeSuiteIDs.includes(id));
  const cases: PreparedCase[] = suitesFor(kept).flatMap((suite) => suite.cases.map((benchmarkCase) => ({
    caseID: benchmarkCase.id.raw,
    suiteID: suite.id.raw,
    dimension: benchmarkCase.category,
    capabilityUnderTest: benchmarkCase.capabilityUnderTest,
  })));
  const excluded: PreparedExclusion[] = suitesFor(input.excludeSuiteIDs).map((suite) => ({
    suiteID: suite.id.raw,
    dimension: suite.cases[0]?.category ?? '',
    caseIDs: suite.cases.map((benchmarkCase) => benchmarkCase.id.raw),
    reason: input.exclusionReason,
  }));
  const dimensionsWithoutEvidence = [...new Set(excluded.map((entry) => entry.dimension))].sort();

  return {
    preparedAt: input.preparedAt,
    name: input.name,
    state: 'prepared',
    candidate: input.candidate,
    repeatsPerCase: input.repeatsPerCase,
    suiteIDs: kept,
    cases,
    caseCount: cases.length,
    excluded,
    excludedCaseCount: excluded.reduce((sum, entry) => sum + entry.caseIDs.length, 0),
    dimensionsWithoutEvidence,
    evidenceCaveat: NO_EVIDENCE_CAVEAT_TEMPLATE.replace('{dimensions}', dimensionsWithoutEvidence.join(', ')),
    beforeItMayRun: input.beforeItMayRun ?? [],
    commands: [
      `cernum create ${input.name} --frontier ${input.candidate.provider}:${input.candidate.requestedModelID}:${input.candidate.effort}`
      + ` --suites ${kept.join(',')} --repeats ${input.repeatsPerCase}`,
      `cernum run ${input.name}`,
      `cernum finalize ${input.name}`,
    ],
  };
}

/** The prepared manifest as a page a person can approve or refuse. */
export function renderPreparedManifest(manifest: PreparedManifest): string {
  const lines: string[] = [];
  lines.push(`# Prepared campaign — ${manifest.name}`);
  lines.push('');
  lines.push('> **PREPARED, NOT FROZEN, NOT AUTHORISED, NOT RUN.** No provider has been contacted to produce this');
  lines.push('> document, no manifest has been frozen, no identity has been bound and no allowance has been spent.');
  lines.push('> It is a statement of intent, computed from the sealed catalog, for a person to approve or refuse.');
  lines.push('');
  lines.push(`**Prepared** ${manifest.preparedAt}`);
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Candidate | \`${manifest.candidate.name}\` |`);
  lines.push(`| Provider | \`${manifest.candidate.provider}\` |`);
  lines.push(`| Requested model | \`${manifest.candidate.requestedModelID}\` |`);
  lines.push(`| Effort | \`${manifest.candidate.effort}\` |`);
  lines.push(`| Cases | **${manifest.caseCount}** |`);
  lines.push(`| Repeats per case | ${manifest.repeatsPerCase} |`);
  lines.push(`| Attempts | **${manifest.caseCount * manifest.repeatsPerCase}** |`);
  lines.push(`| Excluded cases | ${manifest.excludedCaseCount} |`);
  lines.push('');
  lines.push('## What is excluded, and why');
  lines.push('');
  for (const exclusion of manifest.excluded) {
    lines.push(`### \`${exclusion.suiteID}\` — the whole \`${exclusion.dimension}\` dimension`);
    lines.push('');
    lines.push(`Cases dropped: ${exclusion.caseIDs.map((id) => `\`${id}\``).join(', ')}`);
    lines.push('');
    lines.push(exclusion.reason);
    lines.push('');
  }
  lines.push('## The caveat the report must carry');
  lines.push('');
  lines.push(`> ${manifest.evidenceCaveat}`);
  lines.push('');
  if (manifest.beforeItMayRun.length > 0) {
    lines.push('## Before it may run');
    lines.push('');
    for (const item of manifest.beforeItMayRun) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push('## The cases it would run');
  lines.push('');
  lines.push('| # | Case | Dimension | Capability |');
  lines.push('|--:|---|---|---|');
  for (const [index, entry] of manifest.cases.entries()) {
    lines.push(`| ${index + 1} | \`${entry.caseID}\` | ${entry.dimension} | ${entry.capabilityUnderTest} |`);
  }
  lines.push('');
  lines.push('## The commands, once it is authorised');
  lines.push('');
  lines.push('```');
  for (const command of manifest.commands) lines.push(command);
  lines.push('```');
  return lines.join('\n') + '\n';
}
