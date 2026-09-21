// Planning the two new matrices, and reading a finished one BY DIFFICULTY and BY CAPABILITY.
//
// TWO THINGS ARE PROVEN HERE AND THEY ARE DIFFERENT KINDS OF THING.
//
//   THE PLAN, BEFORE ANYTHING IS SENT. Each tier pack across four models is forty-eight independent
//   runs and at most sixty provider attempts, every cell carries the tier it will run under and the
//   `cwd1:` of that claim, and the throttle breaker is armed. A dry run that got any of those wrong
//   would be a preview an operator could not act on — and the whole reason the preview exists is
//   that the live version of it spends an evening.
//
//   THE READING, AFTERWARDS. A finished matrix grouped by tier and by capability, with every rule
//   `workspace-routing-evidence.ts` states held to: no composite averaged across cases, no ordering
//   of candidates, no rate invented for an empty denominator, and a tier a candidate never ran
//   ABSENT rather than present with zeros. The last one is the one that matters for routing: "did
//   not attempt Tier 3" and "failed Tier 3" are different facts, and a rule that read the second
//   when the first was true would be a wrong rule.
//
// NO PROVIDER IS CONTACTED. The driver factory is scripted, the verification commands are real
// `node` against the real sealed fixtures, and the discovery store is written by hand.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DiscoveryEvidence } from '../../src/engine/discovery-store';
import { SYNTHETIC_HARDWARE } from '../../src/engine/synthetic';
import { provenModel } from './frontier-harness';
import {
  allWorkspaceCases, tierThreePack, tierTwoPack,
} from '../../src/engine/workspace-catalog';
import { makeWorkspaceBenchmarkPack } from '../../src/engine/workspace-pack';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest,
} from '../../src/engine/workspace-agent';
import {
  WorkspaceMatrixRequest, buildWorkspaceMatrixPlan, describeWorkspaceMatrixPlan, runWorkspaceMatrix,
} from '../../src/engine/workspace-matrix';
import { aggregateWorkspaceRuns, collectWorkspaceRunRows } from '../../src/engine/workspace-aggregate';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { workspacePackDifficultyDigest } from '../../src/engine/workspace-difficulty';
import {
  describeWorkspaceCapabilityEvidence, describeWorkspaceTierEvidence, observedAdequacy,
  workspaceCapabilityEvidence, workspaceTierEvidence,
} from '../../src/engine/workspace-routing-evidence';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const LINEUP = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5'];

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

/** A discovery store proving the lineup, written by hand. No provider was contacted for it. */
const proven = (modelIDs: string[]): DiscoveryEvidence => ({
  writtenAt: new Date().toISOString(),
  models: modelIDs.map((modelID) => ({ ...provenModel('claudeCLI', modelID), discoveredAt: new Date().toISOString() })),
});

const CHANGES_NOTHING: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'Everything looks correct to me.' }],
  finalMessage: 'No change was needed.',
};

/** The reference solution for one case, read from disk and written through the driver contract. */
function solves(caseID: string): ScriptedAttempt {
  const root = path.resolve(__dirname, 'fixtures/workspace-solutions', caseID);
  const walk = (directory: string, prefix: string): { do: 'write'; path: string; contents: string }[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? walk(path.join(directory, entry.name), `${prefix}${entry.name}/`)
      : [{
        do: 'write' as const,
        path: `${prefix}${entry.name}`,
        contents: fs.readFileSync(path.join(directory, entry.name), 'utf8'),
      }]));
  return { steps: walk(root, ''), finalMessage: 'Done.' };
}

/** A factory whose script depends on the model and the case, so the rows are genuinely different. */
function scriptedFactory(scripts: Record<string, Record<string, ScriptedAttempt[]>>):
NonNullable<WorkspaceMatrixRequest['driverFactory']> {
  return (binding) => {
    const forModel = scripts[binding.requestedModelID] ?? {};
    const driver: WorkspaceAgentDriver = {
      driverID: 'driver.scripted',
      provider: 'claudeCLI',
      capabilities: new ScriptedWorkspaceAgent([]).capabilities,
      async run(request: WorkspaceAgentRequest) {
        const attempts = forModel[request.caseID] ?? [CHANGES_NOTHING];
        const result = await new ScriptedWorkspaceAgent(attempts).run(request);
        return { ...result, reportedModelID: binding.requestedModelID };
      },
    };
    return driver;
  };
}

function request(overrides: Partial<WorkspaceMatrixRequest> = {}): WorkspaceMatrixRequest {
  return {
    pack: tierTwoPack,
    cases: allWorkspaceCases(),
    provider: 'claudeCLI',
    modelIDs: LINEUP,
    effort: 'none',
    discovery: proven(LINEUP),
    campaignRoot: temporary('cernum-tier-matrix-'),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-tier-sandbox-'),
    runLabel: 'tier',
    difficultyProfiles: registeredWorkspaceDifficultyProfiles(),
    driverFactory: scriptedFactory({}),
    environmentSource: { PATH: process.env.PATH, HOME: '/tmp/home', USER: 'somebody' },
    ...overrides,
  };
}

// MARK: - The plan

describe('each tier pack plans forty-eight runs and says what difficulty they are', () => {
  it.each([
    ['tier2', tierTwoPack],
    ['tier3', tierThreePack],
  ])('%s · four models x four cases x three repeats = 48 runs, at most 60 attempts', (tier, pack) => {
    const plan = buildWorkspaceMatrixPlan(request({ pack }));

    expect(plan.taskRunCount).toBe(48);
    expect(plan.runnableRunCount).toBe(48);
    expect(plan.refusedRunCount).toBe(0);
    // ONE of the four cases at each new tier allows a second attempt, so a model's twelve runs may
    // use at most fifteen attempts: (2 + 1 + 1 + 1) per repeat, three times, four models.
    expect(plan.maximumProviderAttemptCount).toBe(4 * 3 * (2 + 1 + 1 + 1));
    expect(plan.maximumProviderAttemptCount).toBeGreaterThan(plan.taskRunCount);
    expect(plan.repeatsPerCase).toBe(3);
    expect(plan.repeatsFrom).toBe('pack');

    // THE DIFFICULTY, ON THE PLAN AND ON EVERY CELL.
    expect(plan.difficultyTier).toBe(tier);
    expect(plan.packDifficultyDigest)
      .toBe(workspacePackDifficultyDigest(registeredWorkspaceDifficultyProfiles(), pack.caseIDs));
    expect(plan.packDifficultyDigest?.startsWith('cwd1:')).toBe(true);
    expect(plan.packDifficultyDigest).not.toBe(plan.packDigest);
    expect(plan.difficultyProfiles).toHaveLength(4);
    for (const cell of plan.cells) {
      expect(cell.difficultyTier).toBe(tier);
      expect(cell.difficultyDigest?.startsWith('cwd1:')).toBe(true);
      expect(cell.dimensions.length).toBeGreaterThan(0);
    }
    // AND THE BREAKER IS ARMED, said in the preview rather than left to be discovered live.
    expect(plan.throttleProtectionArmed).toBe(true);
  });

  it('prints the tier, the capability dimensions and the guard in the preview', () => {
    const printed = describeWorkspaceMatrixPlan(buildWorkspaceMatrixPlan(request({ pack: tierThreePack }))).join('\n');
    expect(printed).toContain('difficulty      tier3 for every case in this pack');
    expect(printed).toContain('difficulty dig. cwd1:');
    expect(printed).toContain('throttle guard  ARMED');
    expect(printed).toContain('4 models x 4 cases x 3 repeats = 48 independent runs');
    expect(printed).toContain('Tier 3 is not "the Opus case"');
    for (const profile of registeredWorkspaceDifficultyProfiles().filter((entry) => entry.tier === 'tier3')) {
      expect(printed).toContain(profile.rationale);
      expect(printed).toContain(`relevantFileCount ${profile.declared.relevantFileCount}`);
      expect(printed).toContain('allowance');
    }
  });

  it('claims no tier for a pack this build has not judged', () => {
    const plan = buildWorkspaceMatrixPlan(request({ difficultyProfiles: undefined }));
    expect(plan.difficultyTier).toBeUndefined();
    expect(plan.packDifficultyDigest).toBeUndefined();
    expect(plan.difficultyProfiles).toEqual([]);
    expect(plan.cells.every((cell) => cell.difficultyTier === undefined)).toBe(true);
    // The dimensions are still there: they come off the sealed case, not off a difficulty claim.
    expect(plan.cells.every((cell) => cell.dimensions.length > 0)).toBe(true);
    expect(describeWorkspaceMatrixPlan(plan).join('\n')).toContain('NOT JUDGED');
  });
});

// MARK: - The reading

describe('a finished matrix reads by tier and by capability without inventing anything', () => {
  /**
   * A small REAL matrix: two cases from two different tiers, two models, one repeat each.
   *
   * Four runs of real `node` verification against real sealed fixtures. One model solves both, the
   * other solves the Tier 1 case and changes nothing on the Tier 2 one — which is the shape the
   * foundation result actually had, and the shape a tier reading has to be able to describe.
   *
   * The pack itself is deliberately UNJUDGED (`difficultyProfiles` is not passed to the plan),
   * because a pack mixing tiers is refused — and refusing it is the right behaviour. The grouping
   * below is applied to the CELLS afterwards, which is what a reader combining tables does.
   */
  async function smallMatrix() {
    const mixed = makeWorkspaceBenchmarkPack({
      id: 'pack.test.mixed', version: '1', title: 'two tiers',
      caseIDs: ['ws.broken-sum.mean', 'ws.t2.cache-eviction.recover'], repeatsPerCase: 1,
    });
    const campaignRoot = temporary('cernum-tier-read-');
    const models = ['claude-haiku-4-5', 'claude-opus-5'];
    const CORRECT_STATS = "'use strict';\n"
      + 'function sum(values) { let total = 0; for (const value of values) total += value; return total; }\n'
      + 'function mean(values) {\n'
      + "  if (values.length === 0) throw new RangeError('empty');\n"
      + '  return sum(values) / values.length;\n}\n'
      + 'module.exports = { sum, mean };\n';
    const fixesBrokenSum: ScriptedAttempt = {
      steps: [{ do: 'write', path: 'src/stats.js', contents: CORRECT_STATS }],
      finalMessage: 'Fixed the divisor.',
    };
    const base = request({
      pack: mixed,
      modelIDs: models,
      discovery: proven(models),
      campaignRoot,
      difficultyProfiles: undefined,
      driverFactory: scriptedFactory({
        'claude-opus-5': {
          'ws.broken-sum.mean': [fixesBrokenSum],
          'ws.t2.cache-eviction.recover': [solves('ws.t2.cache-eviction.recover')],
        },
        'claude-haiku-4-5': {
          'ws.broken-sum.mean': [fixesBrokenSum],
          'ws.t2.cache-eviction.recover': [CHANGES_NOTHING, CHANGES_NOTHING],
        },
      }),
    });
    const plan = buildWorkspaceMatrixPlan(base);
    await runWorkspaceMatrix(plan, base, {
      hardware: SYNTHETIC_HARDWARE, runtimeVersion: 'test',
    });
    return aggregateWorkspaceRuns(collectWorkspaceRunRows(campaignRoot));
  }

  it('groups by tier, counts what happened and ranks nobody', async () => {
    const cells = await smallMatrix();
    expect(cells).toHaveLength(4);
    const rows = workspaceTierEvidence(cells, registeredWorkspaceDifficultyProfiles());

    const opusTier2 = rows.find((row) => row.candidate.includes('opus') && row.tier === 'tier2');
    const haikuTier2 = rows.find((row) => row.candidate.includes('haiku') && row.tier === 'tier2');
    expect(opusTier2?.successCount).toBe(1);
    expect(opusTier2?.scoredRunCount).toBe(1);
    expect(opusTier2?.successRateMilli.value).toBe(1000);
    expect(haikuTier2?.successCount).toBe(0);
    expect(haikuTier2?.successRateMilli.value).toBe(0);

    // BOTH passed Tier 1, and the row says so as counts rather than as a score.
    for (const row of rows.filter((entry) => entry.tier === 'tier1')) {
      expect(row.successCount).toBe(1);
      expect(row.casesPassedEveryTime).toBe(1);
      expect(row.unanimousCaseCount).toBe(1);
    }
    // NO COMPOSITE IS AVERAGED ACROSS CASES. There is no tier score on the row at all.
    expect(Object.keys(rows[0])).not.toContain('compositeMilli');
    expect(rows[0].evidenceDisclosure).toContain('never an average of per-case composites');
    expect(rows[0].tierDisclosure).toContain('Tier 3 is not "the Opus case"');
    // AND NOTHING IS ORDERED. The rows come back grouped, not ranked.
    expect(describeWorkspaceTierEvidence(rows[0])).toContain(rows[0].candidate);
  }, 180_000);

  it('leaves a tier nobody ran ABSENT rather than present with zeros', async () => {
    const cells = await smallMatrix();
    const rows = workspaceTierEvidence(cells, registeredWorkspaceDifficultyProfiles());
    // Neither model ran a Tier 3 case, so there is no Tier 3 row for either of them. A zero here
    // would say they tried and failed.
    expect(rows.some((row) => row.tier === 'tier3')).toBe(false);
    expect(new Set(rows.map((row) => row.tier))).toEqual(new Set(['tier1', 'tier2']));
    // And a rate with nothing in its denominator is unavailable WITH A REASON. The Tier 1 rows
    // here had no second attempt at all, so there is nothing to compute a recovery rate FROM —
    // which is a different finding from a candidate that retried and did not recover.
    const neverRetried = rows.filter((row) => row.tier === 'tier1');
    expect(neverRetried.length).toBe(2);
    for (const row of neverRetried) {
      expect(row.recoverySuccessRateMilli.provenance).toBe('unavailable');
      expect(row.recoverySuccessRateMilli.note).toContain('not a recovery rate of zero');
    }
    // Whereas the candidate that DID use its second attempt and still failed has a real zero, and
    // the two are not written the same way.
    const retriedAndFailed = rows.find((row) => row.tier === 'tier2' && row.candidate.includes('haiku'));
    expect(retriedAndFailed?.recoverySuccessRateMilli.provenance).toBe('measured');
    expect(retriedAndFailed?.recoverySuccessRateMilli.value).toBe(0);
  }, 180_000);

  it('groups by capability dimension, and says which cases are behind each number', async () => {
    const cells = await smallMatrix();
    const rows = workspaceCapabilityEvidence(cells, allWorkspaceCases(), registeredWorkspaceDifficultyProfiles());
    expect(rows.length).toBeGreaterThan(0);

    // A case counts under EVERY dimension it declared, so the rows overlap and the case ids are on
    // the row — which is what lets a reader tell two dimensions resting on the same case apart from
    // two resting on different ones.
    const recovery = rows.filter((row) => row.dimension === 'recoveryFromError');
    expect(recovery.length).toBe(2);
    for (const row of recovery) {
      expect(row.caseIDs).toEqual(['ws.t2.cache-eviction.recover']);
      expect(row.tiers).toEqual(['tier2']);
    }
    expect(recovery.find((row) => row.candidate.includes('opus'))?.successRateMilli.value).toBe(1000);
    expect(recovery.find((row) => row.candidate.includes('haiku'))?.successRateMilli.value).toBe(0);

    // A dimension no case in this matrix declared produces NO ROW. Nothing is manufactured.
    expect(rows.some((row) => row.dimension === 'autonomousCompletion')).toBe(false);
    expect(describeWorkspaceCapabilityEvidence(rows[0])).toContain(rows[0].dimension);
  }, 180_000);

  it('answers a threshold question with the evidence, and refuses to answer on too little', async () => {
    const cells = await smallMatrix();
    const rows = workspaceTierEvidence(cells, registeredWorkspaceDifficultyProfiles());
    const opusTier2 = rows.find((row) => row.candidate.includes('opus') && row.tier === 'tier2')!;

    const answerable = observedAdequacy(opusTier2, { minimumSuccessRateMilli: 900, minimumScoredRunCount: 1 });
    expect(answerable.adequate).toBe(true);
    expect(answerable.meets).toBe(true);
    expect(answerable.statement).toContain('meets');

    // TOO FEW RUNS IS NOT A FAILURE. `meets` is undefined rather than false, and the sentence says
    // the question has no answer yet — because a routing rule that read a `false` here would be
    // routing on absence of evidence.
    const notYet = observedAdequacy(opusTier2, { minimumSuccessRateMilli: 900, minimumScoredRunCount: 9 });
    expect(notYet.adequate).toBe(false);
    expect(notYet.meets).toBeUndefined();
    expect(notYet.statement).toContain('no answer yet');
    expect(notYet.statement).toContain('not the same finding');
  }, 180_000);
});
