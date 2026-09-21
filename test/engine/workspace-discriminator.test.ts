// The empirical discriminator pack, proven to discriminate — and proven not to have moved anything
// that already existed — without a frontier model.
//
// FOUR THINGS ARE PROVEN HERE.
//
//   NOTHING THAT HAS RUN MOVED   every existing case digest, comparability key, pack digest and
//                                difficulty digest is asserted against the literal value the branch
//                                carried before this pass (d8f8658), written out rather than
//                                recomputed. Forty-eight sealed records per tier matrix carry them.
//   THE NEW PACK IS ONE THING    deterministic digests, deterministic fixtures, a structural
//                                profile per case with no tier, and design claims that agree with the
//                                sealed cases they describe.
//   EVERY CASE DISCRIMINATES     the reference solution passes every check, hidden ones included;
//                                changing nothing fails; editing a forbidden path is a scope failure;
//                                and every plausible wrong answer a profile says the case refuses is
//                                written by a scripted agent and IS refused, with the check that
//                                refused it named.
//   RECOVERY IS OBSERVABLE       for the two recovery cases: right first time passes on attempt 1;
//                                wrong then right passes on attempt 2; wrong twice fails after two;
//                                and the briefing attempt 2 receives is the engine's fixed text plus
//                                the failed check's own output — no line of advice, and no file name
//                                the check did not print itself.
//
// NO PROVIDER IS CONTACTED ANYWHERE IN THIS FILE. Verification is real `node` against the real
// sealed fixtures; the agents are scripted.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  allWorkspaceCases, discriminatorOnePack, foundationFourPack, registeredWorkspacePacks, tierThreePack, tierTwoPack,
  validateWorkspaceCatalog, workspacePackByID,
} from '../../src/engine/workspace-catalog';
import { workspaceDiscriminatorSuite } from '../../src/engine/workspace-catalog-discriminator';
import {
  WORKSPACE_DIMENSIONS_REQUIRING_A_RETRY, WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey,
  workspaceInstructionText,
} from '../../src/engine/workspace-case';
import { makeWorkspaceBenchmarkPack, workspacePackDigest } from '../../src/engine/workspace-pack';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { workspaceDifficultyDigest, workspacePackTier } from '../../src/engine/workspace-difficulty';
import {
  WorkspaceDiscriminatorError, validateWorkspaceStructuralProfile, workspacePackStructuralDigest,
  workspaceStructuralProfileDigest,
} from '../../src/engine/workspace-discriminator';
import {
  registeredWorkspaceStructuralProfiles, workspaceStructuralProfileFor,
} from '../../src/engine/workspace-discriminator-catalog';
import {
  ScriptedAttempt, ScriptedStep, ScriptedWorkspaceAgent, WorkspaceAgentRequest, WorkspaceAgentResult,
  retryBriefingText,
} from '../../src/engine/workspace-agent';
import { CommandOutcome, InvariantOutcome, WorkspaceRunResult, runWorkspaceCase } from '../../src/engine/workspace-execution';
import { WorkspaceScorecard, scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { snapshotTree } from '../../src/engine/workspace-tree';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const SOLUTION_ROOT = path.resolve(__dirname, 'fixtures/workspace-solutions');
const DISCRIMINATOR_CASE_IDS = [...discriminatorOnePack.caseIDs];

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-disc-'));
  temporaries.push(directory);
  return directory;
}

const caseByID = (id: string): WorkspaceCase => {
  const found = allWorkspaceCases().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no such workspace case: ${id}`);
  return found;
};

const filesUnder = (root: string): string[] =>
  snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' }).entries.map((entry) => entry.path);

const fixtureOf = (caseID: string): string => path.join(FIXTURE_ROOT, caseByID(caseID).source.fixturePath);

// MARK: - Nothing that has run moved

describe('every pack, case and difficulty claim that existed before this pass is byte-for-byte what it was', () => {
  /** Taken from the digest functions at d8f8658, before any of this pass existed. Written out on purpose. */
  const CASES_AT_HEAD: Record<string, { cwc: string; cwk: string }> = {
    'ws.broken-sum.mean': { cwc: 'cwc1:e4b98967ead9be9420b78321210527ade0c66f5ef7087f4212a8523c96ee6fb6', cwk: 'cwk1:2c6d841b4bfa1f8f23d955b0e8991fb3e1efdc5e6d80aaf969a8c5173d5720c0' },
    'ws.receipt-refunds.sign': { cwc: 'cwc1:037c4bcbdf7f9c067d2e93d934f65fcf8dcc0f4c5899e1764fb9e7eba6f9e6cb', cwk: 'cwk1:d07e4e02e3ff957f33a4de07992018738589cade84c2547b3832bb2508fa8d49' },
    'ws.registry-isolation.recover': { cwc: 'cwc1:cf0eeae52488a940e405791ede34727f25219db7d271cd121e1222087f4356cc', cwk: 'cwk1:dadcb3baceecdd0005180e9e13d0f7ce57b786621561e8a0fe70da20541dcb89' },
    'ws.task-priority.propagate': { cwc: 'cwc1:404ff5f165a4295b35182f9d59b16dab85222f1e43ddda2aca7405ae066b57b7', cwk: 'cwk1:33f020658f4184ab19175bdbc563a32fd071aa68b136db87aeefc31047fc5f59' },
    'ws.t2.cache-eviction.recover': { cwc: 'cwc1:fb89f98691eb694473fe3c860a25bb51ce379ab6b00510f27df8be896a23b3b9', cwk: 'cwk1:f8b5461780f1d8065769544022da55594583671d5bae9301613b3ac915752569' },
    'ws.t2.ledger-currency.propagate': { cwc: 'cwc1:7ced091434ed4b0f470ecbca05a712ece0a5d66db1b8bfaeab20bf7a5ea2c74a', cwk: 'cwk1:cc20a8536988ed7a1b3c7554fa4091b41d569eab61df309c2223bcacb711a21e' },
    'ws.t2.schedule-window.diagnose': { cwc: 'cwc1:223bd3f7ebaef6c572b7da4ef0aa3576e3065abb2691faaeb4c9d12ddb6ab64d', cwk: 'cwk1:9d7c5ea70dd5a12cd8f2143cfdf69c0f021266415f6fe55e8bf4b3151d86c854' },
    'ws.t2.text-normalize.cluster': { cwc: 'cwc1:70a66718aeb4ee33702edce0860b0323d0c27c9fd7034b4c6d90dbfc5f9c7574', cwk: 'cwk1:ff58c95d73f94a416f2da63c08d31ccad53a902adc6289c2b4a85a993f1e9299' },
    'ws.t3.event-replay.pair': { cwc: 'cwc1:306458a1adc73c8b7e9252a703452932070957905e732a95c79911fb49610f2b', cwk: 'cwk1:1c2cfcad25791198da18f2e6330eb4b0efb59dad52bb7669e29ba3758b40c3a8' },
    'ws.t3.import-pipeline.finish': { cwc: 'cwc1:f8667d5a55e5bfcc7e3d9bba58d20d7ce004eea3cf7622502d33e0ac29eb67c2', cwk: 'cwk1:7dc12cdfbfd5d1eadaf638de06b3b411873e45411ca3749f3ca4182026911226' },
    'ws.t3.permission-gate.centralize': { cwc: 'cwc1:6d0a0264428424f4ab9b016724e909f9d64ccef69d81a47febd86356d2428839', cwk: 'cwk1:b35e7b734aac3dbd7a6d574d17dcfe15fe1a417dc4da07d6ddc0a82c9d4b254c' },
    'ws.t3.validator-rules.refactor': { cwc: 'cwc1:fab1280f8e8bece1a3274e97f21f35bd5d79625e7331ec8ab00ace1947ba3af2', cwk: 'cwk1:560c96def1c31ef2c1b28adc39b815015c6322cdc9db72b87c50ad2899ac2d6d' },
  };
  const PACKS_AT_HEAD: Record<string, string> = {
    'pack.cernum.workspace.foundation-four': 'cwp1:c6bf8ba27e409eaefc8841110e8de44f9e3205602e8a810971f4ecd484d03f2d',
    'pack.cernum.workspace.tier-two': 'cwp1:e7e675e4ed02ddfea659d606bc747818de21a8ef23b46a757aa07eea3592d381',
    'pack.cernum.workspace.tier-three': 'cwp1:ea6becd1873d95c8d30f45d7ffd9ff6c073594f1e22e2e319a11a541de9bf7e2',
  };
  const DIFFICULTY_AT_HEAD: Record<string, string> = {
    'ws.broken-sum.mean': 'cwd1:359e4324310aaad038c198658ccae48fe6633a61c4492a82aaa9770417223875',
    'ws.task-priority.propagate': 'cwd1:4648b728420689daa8ec3ed507eb005ee4d71af8d4da218f720cd2d82034a5be',
    'ws.receipt-refunds.sign': 'cwd1:0c84c809c072049ebaabd18bd26c1f6340f38ad708c50eedac62e63b769afad6',
    'ws.registry-isolation.recover': 'cwd1:11bfe44125251b1a875caa1d0ac945efe229296a42253cceba5f43762d9c0d2d',
    'ws.t2.ledger-currency.propagate': 'cwd1:3113a1f0c889e09feb6c7a2916ddf5935839e55dac04689a46cd98c18d26f038',
    'ws.t2.schedule-window.diagnose': 'cwd1:0dc244698037f6c91b7fa88b7e37f4ae0d9ecb254ee7e6b6fff7ee104f1fe28f',
    'ws.t2.text-normalize.cluster': 'cwd1:25d08f8af8c9d3f9ea52229a3836202b5bcfc810dfe2fd3eeb98e224a9823fde',
    'ws.t2.cache-eviction.recover': 'cwd1:7872648f7d8bd1ed8d531f233a2c4fce0612ff6792b6f52c24d025740c3f1c81',
    'ws.t3.permission-gate.centralize': 'cwd1:9d5ecb48f090c97ae20fc18787fce50ac842622e9ee82e415c70f418fe485867',
    'ws.t3.event-replay.pair': 'cwd1:c139882aa0c1384af2afa19a03fe2384c7551ed253a9613e7e39427a8c81e2fe',
    'ws.t3.validator-rules.refactor': 'cwd1:2554689fe2d5c95753341a38bb93f63b196630786c0dc2cbab33b6d8bd67fbb5',
    'ws.t3.import-pipeline.finish': 'cwd1:45e4760ee986f6d6f473459eb9962dc329f4081cd0e728c8f28dbe4eb583cd5e',
  };

  it('keeps every existing case digest and comparability key', () => {
    for (const [caseID, expected] of Object.entries(CASES_AT_HEAD)) {
      expect(workspaceCaseDigest(caseByID(caseID)), `${caseID}'s cwc1: moved`).toBe(expected.cwc);
      expect(workspaceComparabilityKey(caseByID(caseID)), `${caseID}'s cwk1: moved`).toBe(expected.cwk);
    }
  });

  it('keeps every existing pack digest, membership and sampling', () => {
    const cases = allWorkspaceCases();
    for (const pack of [foundationFourPack, tierTwoPack, tierThreePack]) {
      expect(workspacePackDigest(pack, cases), `${pack.id}'s cwp1: moved`).toBe(PACKS_AT_HEAD[pack.id]);
      expect(pack.version).toBe('1');
      expect(pack.repeatsPerCase).toBe(3);
      expect(pack.caseIDs).toHaveLength(4);
    }
  });

  it('keeps every existing difficulty claim, and every tier', () => {
    const profiles = registeredWorkspaceDifficultyProfiles();
    expect(profiles).toHaveLength(12);
    for (const [caseID, expected] of Object.entries(DIFFICULTY_AT_HEAD)) {
      const profile = profiles.find((entry) => entry.caseID === caseID);
      expect(profile && workspaceDifficultyDigest(profile), `${caseID}'s cwd1: moved`).toBe(expected);
    }
    expect(workspacePackTier(profiles, foundationFourPack.caseIDs)).toBe('tier1');
    expect(workspacePackTier(profiles, tierTwoPack.caseIDs)).toBe('tier2');
    expect(workspacePackTier(profiles, tierThreePack.caseIDs)).toBe('tier3');
  });

  it('adds no discriminator case to any tier pack, and no tier case to the discriminator pack', () => {
    for (const pack of [foundationFourPack, tierTwoPack, tierThreePack]) {
      expect(pack.caseIDs.some((caseID) => DISCRIMINATOR_CASE_IDS.includes(caseID))).toBe(false);
    }
    expect(DISCRIMINATOR_CASE_IDS.every((caseID) => caseID.startsWith('ws.d1.'))).toBe(true);
  });
});

// MARK: - The new pack is one thing

describe('pack.cernum.workspace.discriminator-one@1 is a sealed, untiered experiment', () => {
  it('validates with the whole catalogue and is found by id and by id@version', () => {
    expect(() => validateWorkspaceCatalog()).not.toThrow();
    expect(registeredWorkspacePacks).toContain(discriminatorOnePack);
    expect(workspacePackByID('pack.cernum.workspace.discriminator-one')).toBe(discriminatorOnePack);
    expect(workspacePackByID('pack.cernum.workspace.discriminator-one@1')).toBe(discriminatorOnePack);
    // A version this build does not carry is refused rather than quietly mapped to the one it does.
    expect(workspacePackByID('pack.cernum.workspace.discriminator-one@2')).toBeUndefined();
    expect(workspacePackByID('pack.cernum.workspace.tier-two@1')).toBe(tierTwoPack);
  });

  it('is six cases, three repeats, and one suite', () => {
    expect(discriminatorOnePack.version).toBe('1');
    expect(discriminatorOnePack.caseIDs).toHaveLength(6);
    expect(discriminatorOnePack.repeatsPerCase).toBe(3);
    expect(workspaceDiscriminatorSuite.cases.map((entry) => entry.id).sort()).toEqual([...DISCRIMINATOR_CASE_IDS].sort());
    for (const entry of workspaceDiscriminatorSuite.cases) {
      expect(entry.source.sealed).toBe(true);
      expect(entry.execution.environmentAllowlist).toEqual(['HOME', 'USER']);
      expect(entry.execution.networkPolicy).toBe('providerOnly');
    }
  });

  it('seals deterministically: same bytes twice, same bytes in any order, different bytes for different sampling', () => {
    const cases = allWorkspaceCases();
    const once = workspacePackDigest(discriminatorOnePack, cases);
    expect(once.startsWith('cwp1:')).toBe(true);
    expect(workspacePackDigest(discriminatorOnePack, cases)).toBe(once);
    const reordered = makeWorkspaceBenchmarkPack({ ...discriminatorOnePack, caseIDs: [...discriminatorOnePack.caseIDs].reverse() });
    expect(workspacePackDigest(reordered, cases)).toBe(once);
    expect(workspacePackDigest(makeWorkspaceBenchmarkPack({ ...discriminatorOnePack, repeatsPerCase: 1 }), cases)).not.toBe(once);
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      expect(workspaceCaseDigest(caseByID(caseID))).toBe(workspaceCaseDigest(caseByID(caseID)));
    }
  });

  it('allows one attempt on four cases and two on the two recovery cases, under the recovery policy', () => {
    const attempts = Object.fromEntries(DISCRIMINATOR_CASE_IDS.map((caseID) => [caseID, caseByID(caseID).execution.maximumAttempts]));
    expect(attempts).toEqual({
      'ws.d1.config-migrate.upgrade': 1, 'ws.d1.asset-container.retitle': 1, 'ws.d1.log-redact.mask': 1,
      'ws.d1.catalog-paging.walk': 1, 'ws.d1.query-codec.nest': 2, 'ws.d1.task-board.reassign': 2,
    });
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      const workspaceCase = caseByID(caseID);
      expect(workspaceCase.scoring.id).toBe(workspaceCase.execution.maximumAttempts > 1
        ? 'policy.workspace.recovery' : 'policy.workspace.default');
      // A retry dimension is declared exactly where a retry is possible — never on a one-attempt case.
      const declaresRetry = workspaceCase.dimensions.some((dimension) => WORKSPACE_DIMENSIONS_REQUIRING_A_RETRY.includes(dimension));
      expect(declaresRetry, `${caseID} declares a retry dimension it cannot exercise`).toBe(workspaceCase.execution.maximumAttempts > 1);
    }
    // Four models, three repeats: 72 runs, and at most 4 x 3 x (1+1+1+1+2+2) = 96 attempts.
    const perRepeat = DISCRIMINATOR_CASE_IDS.reduce((sum, caseID) => sum + caseByID(caseID).execution.maximumAttempts, 0);
    expect(4 * 3 * DISCRIMINATOR_CASE_IDS.length).toBe(72);
    expect(4 * 3 * perRepeat).toBe(96);
  });

  it('declares materially different capability sets, and at least three cases in the preserve family', () => {
    const sets = DISCRIMINATOR_CASE_IDS.map((caseID) => caseByID(caseID).dimensions.join('+'));
    expect(new Set(sets).size).toBe(6);
    const preserving = DISCRIMINATOR_CASE_IDS.filter((caseID) => caseByID(caseID).dimensions.includes('preservationUnderTransformation'));
    expect(preserving.length).toBeGreaterThanOrEqual(3);
  });
});

describe('each discriminator case carries a structural profile, and no tier', () => {
  const profiles = registeredWorkspaceStructuralProfiles();

  it('profiles exactly the six cases, and none of them is in a tier', () => {
    expect(profiles.map((profile) => profile.caseID).sort()).toEqual([...DISCRIMINATOR_CASE_IDS].sort());
    const tiered = registeredWorkspaceDifficultyProfiles().map((profile) => profile.caseID);
    for (const caseID of DISCRIMINATOR_CASE_IDS) expect(tiered).not.toContain(caseID);
    expect(workspacePackTier(registeredWorkspaceDifficultyProfiles(), discriminatorOnePack.caseIDs)).toBeUndefined();
    for (const profile of profiles) {
      expect(profile.family).toBe('empiricalDiscriminator');
      expect(Object.keys(profile)).not.toContain('tier');
      expect(workspaceStructuralProfileDigest(profile).startsWith('cwx1:')).toBe(true);
    }
    const packDigest = workspacePackStructuralDigest(profiles, discriminatorOnePack.caseIDs);
    expect(packDigest?.startsWith('cwx1:')).toBe(true);
    expect(packDigest).not.toBe(workspacePackDigest(discriminatorOnePack, allWorkspaceCases()));
  });

  it('checks the fixture figures against the sealed tree and the edit count against the reference solution', () => {
    for (const profile of profiles) {
      const snapshot = snapshotTree(fixtureOf(profile.caseID), { capturedAt: '1970-01-01T00:00:00Z' });
      expect(profile.measured.fixtureFileCount, `${profile.caseID} file count`).toBe(snapshot.fileCount);
      expect(profile.measured.fixtureByteCount, `${profile.caseID} byte count`).toBe(snapshot.totalByteCount);
      expect(profile.measured.fixtureSourceFileCount)
        .toBe(snapshot.entries.filter((entry) => entry.path.startsWith('src/')).length);
      expect(filesUnder(path.join(SOLUTION_ROOT, profile.caseID)).length, `${profile.caseID} solution file count`)
        .toBe(profile.declared.expectedMinimumEditFiles);
    }
  });

  it('refuses a profile that carries a tier, disagrees about recovery, or misstates the case', () => {
    const profile = workspaceStructuralProfileFor(profiles, 'ws.d1.query-codec.nest')!;
    const workspaceCase = caseByID('ws.d1.query-codec.nest');
    expect(() => validateWorkspaceStructuralProfile(profile, workspaceCase)).not.toThrow();
    expect(() => validateWorkspaceStructuralProfile({ ...profile, tier: 'tier3' } as typeof profile, workspaceCase))
      .toThrow(/untiered by design/);
    expect(() => validateWorkspaceStructuralProfile({ ...profile, design: { ...profile.design, recoveryDesigned: false } }, workspaceCase))
      .toThrow(WorkspaceDiscriminatorError);
    expect(() => validateWorkspaceStructuralProfile({ ...profile, measured: { ...profile.measured, hiddenCommandCount: 5 } }, workspaceCase))
      .toThrow(/derived, not asserted/);
    expect(() => validateWorkspaceStructuralProfile({ ...profile, design: { ...profile.design, refusedWrongAnswers: [] } }, workspaceCase))
      .toThrow(/names no plausible wrong answer/);
    expect(() => validateWorkspaceStructuralProfile(profile, caseByID('ws.d1.log-redact.mask'))).toThrow(/checked against/);
  });

  it('never lets a provider, a model or an outcome into the design modules or the cases', () => {
    for (const file of ['workspace-discriminator.ts', 'workspace-discriminator-catalog.ts', 'workspace-catalog-discriminator.ts',
      'workspace-empirical-evidence.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../../src/engine', file), 'utf8');
      const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
      for (const name of ['claudeCLI', 'codexCLI', 'opencodeCLI', 'anthropicAPI', 'openaiAPI', 'ProviderID', 'ProviderBinding',
        'requestedModelID: \'', 'haiku', 'sonnet', 'fable', 'opus']) {
        expect(code.toLowerCase().includes(name.toLowerCase()), `${file} mentions ${name}`).toBe(false);
      }
    }
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      const text = workspaceInstructionText(caseByID(caseID)).toLowerCase();
      for (const word of ['claude', 'haiku', 'sonnet', 'fable', 'opus', 'gpt', 'model', 'tier', 'benchmark', 'hidden']) {
        expect(text.includes(word), `${caseID}'s instruction says "${word}"`).toBe(false);
      }
    }
  });
});

// MARK: - The fixtures

describe('the six fixtures are deterministic, compact and give nothing away', () => {
  it('digest to their seals, twice, and stay inside the size the pack was designed at', () => {
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      const root = fixtureOf(caseID);
      const first = snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' });
      const second = snapshotTree(root, { capturedAt: '2001-01-01T00:00:00Z' });
      expect(first.treeDigest).toBe(caseByID(caseID).source.expectedTreeDigest);
      expect(second.treeDigest).toBe(first.treeDigest);
      expect(first.fileCount).toBeGreaterThanOrEqual(10);
      expect(first.fileCount).toBeLessThanOrEqual(30);
      const lines = filesUnder(root).reduce((sum, file) => sum + fs.readFileSync(path.join(root, file), 'utf8').split('\n').length, 0);
      expect(lines, `${caseID} is ${lines} lines`).toBeGreaterThanOrEqual(300);
      expect(lines, `${caseID} is ${lines} lines`).toBeLessThanOrEqual(1200);
    }
  });

  it('leaks no answer: no marker, no giveaway name, no talk of unseen checks, no reference solution', () => {
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      const root = fixtureOf(caseID);
      for (const file of filesUnder(root)) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        const where = `${caseByID(caseID).source.fixturePath}/${file}`;
        for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK', 'BUG:', 'WRONG:', 'should be:', 'the correct fix', 'the right fix',
          'scopeFailure', 'behavioralFailure', 'hiddenCommands', 'Cernum verifies']) {
          expect(text.includes(marker), `${where} carries "${marker}"`).toBe(false);
        }
        expect(/\bhidden\b/i.test(text), `${where} mentions a hidden check`).toBe(false);
        expect(/broken|buggy|wrong|fixme|solution|answer/i.test(file), `${caseID} has a giveaway file name: ${file}`).toBe(false);
      }
      // The reference solution is not sitting in the tree: every file it writes differs from the
      // fixture's version of that file.
      const solution = path.join(SOLUTION_ROOT, caseID);
      for (const file of filesUnder(solution)) {
        const shipped = path.join(root, file);
        if (!fs.existsSync(shipped)) continue;
        expect(fs.readFileSync(shipped, 'utf8'), `${caseID}: ${file} already is the solution`)
          .not.toBe(fs.readFileSync(path.join(solution, file), 'utf8'));
      }
    }
  });

  it('names the task in each case id, never the answer', () => {
    // The workspace directory an agent is handed is named after the case, so an id is model-visible.
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      for (const word of ['preserve', 'recover', 'forward', 'selective', 'unknown', 'keep', 'interact', 'trap', 'diagnose',
        'cluster', 'retry', 'hidden']) {
        expect(caseID.includes(word), `${caseID} says "${word}"`).toBe(false);
      }
    }
  });

  it('grounds every hidden check in a document the fixture carries, which the check quotes', () => {
    for (const caseID of DISCRIMINATOR_CASE_IDS) {
      const workspaceCase = caseByID(caseID);
      expect(workspaceCase.verification.hiddenCommands.length).toBeGreaterThan(0);
      for (const hidden of workspaceCase.verification.hiddenCommands) {
        const cited = [...hidden.args[1].matchAll(/(docs\/[A-Z0-9]+\.md|README\.md)/g)].map((match) => match[1]);
        expect(cited.length, `${caseID}/${hidden.id} cites no document`).toBeGreaterThan(0);
        for (const document of cited) {
          expect(fs.existsSync(path.join(fixtureOf(caseID), document)), `${caseID}/${hidden.id} cites ${document}, which is not there`)
            .toBe(true);
        }
        // A hidden check reaches the package through its public entry point, so a check that fails
        // names no module a model should go and look in.
        expect(hidden.args[1]).toContain("require('./src/index.js')");
        expect(/require\('\.\/src\/(?!index\.js)/.test(hidden.args[1]), `${caseID}/${hidden.id} requires an internal module`)
          .toBe(false);
        // No randomness from the environment: the property check seeds its own generator.
        for (const forbidden of ['Math.random(', 'Date.now(', 'new Date(', 'process.hrtime']) {
          expect(hidden.args[1].includes(forbidden), `${caseID}/${hidden.id} uses ${forbidden}`).toBe(false);
        }
      }
    }
  });
});

// MARK: - Scripted runs

class RecordingScriptedAgent extends ScriptedWorkspaceAgent {
  readonly instructions: string[] = [];

  async run(request: WorkspaceAgentRequest): Promise<WorkspaceAgentResult> {
    this.instructions.push(request.instruction);
    return super.run(request);
  }
}

interface Scored {
  card: WorkspaceScorecard;
  result: WorkspaceRunResult;
  agent: RecordingScriptedAgent;
  visible: CommandOutcome[];
  hidden: CommandOutcome[];
  invariants: InvariantOutcome[];
}

async function score(workspaceCase: WorkspaceCase, attempts: ScriptedAttempt[]): Promise<Scored> {
  const agent = new RecordingScriptedAgent(attempts);
  const result = await runWorkspaceCase({ case: workspaceCase, driver: agent, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary() });
  const deciding = result.attempts[result.attempts.length - 1];
  return {
    card: scoreWorkspaceRun(workspaceCase, result),
    result,
    agent,
    visible: deciding?.verificationOutcomes ?? [],
    hidden: deciding?.hiddenOutcomes ?? [],
    invariants: deciding?.invariantOutcomes ?? [],
  };
}

const outcome = (outcomes: CommandOutcome[], id: string) => outcomes.find((entry) => entry.commandID === id);
const allPassed = (outcomes: CommandOutcome[]) => outcomes.every((entry) => entry.passed);

/** The reference solution's writes, optionally mangled; a mangling that matches nothing is an error. */
function solutionWrites(caseID: string, edit?: (file: string, contents: string) => string | undefined): ScriptedStep[] {
  const root = path.join(SOLUTION_ROOT, caseID);
  const steps: ScriptedStep[] = [];
  for (const file of filesUnder(root)) {
    const original = fs.readFileSync(path.join(root, file), 'utf8');
    const contents = edit === undefined ? original : edit(file, original);
    if (contents !== undefined) steps.push({ do: 'write', path: file, contents });
  }
  return steps;
}

function mangled(contents: string, from: string, to: string): string {
  if (!contents.includes(from)) throw new Error(`the mangling no longer matches: ${from.slice(0, 80)}`);
  return contents.split(from).join(to);
}

/** A fixture file as shipped, mangled. */
function shippedWith(caseID: string, file: string, from: string, to: string): ScriptedStep {
  return { do: 'write', path: file, contents: mangled(fs.readFileSync(path.join(fixtureOf(caseID), file), 'utf8'), from, to) };
}

const attempt = (steps: ScriptedStep[], finalMessage = 'Done.'): ScriptedAttempt => ({ steps, finalMessage });
const solves = (caseID: string): ScriptedAttempt => attempt(solutionWrites(caseID));
const CHANGES_NOTHING: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'I have read the repository and everything looks correct to me.' }],
  finalMessage: 'No change was needed.',
};

function editsAForbiddenTest(workspaceCase: WorkspaceCase): ScriptedAttempt {
  return attempt([{ do: 'write', path: workspaceCase.verification.commands[0].args[0], contents: 'process.exit(0);\n' }],
    'I adjusted the test.');
}

describe('every discriminator case is solvable, is not free, and enforces its forbidden paths', () => {
  it.each(DISCRIMINATOR_CASE_IDS)('%s · the reference solution passes on the first attempt, hidden checks included', async (caseID) => {
    const run = await score(caseByID(caseID), [solves(caseID)]);
    expect(run.card.status, run.card.detail).toBe('pass');
    expect(run.card.attemptsUsed).toBe(1);
    for (const entry of [...run.visible, ...run.hidden]) expect(entry.passed, `${caseID}: ${entry.commandID}`).toBe(true);
    expect(run.invariants.filter((entry) => !entry.satisfied)).toEqual([]);
    expect(run.card.regressionCount).toBe(0);
  }, 120_000);

  it.each(DISCRIMINATOR_CASE_IDS)('%s · changing nothing does not pass', async (caseID) => {
    const run = await score(caseByID(caseID), [CHANGES_NOTHING, CHANGES_NOTHING]);
    expect(run.card.status).not.toBe('pass');
    expect(run.card.changedFileCount).toBe(0);
    expect(allPassed(run.visible)).toBe(false);
  }, 120_000);

  it.each(DISCRIMINATOR_CASE_IDS)('%s · editing a forbidden test is a scope failure, not a pass', async (caseID) => {
    const workspaceCase = caseByID(caseID);
    const run = await score(workspaceCase, [editsAForbiddenTest(workspaceCase), editsAForbiddenTest(workspaceCase)]);
    expect(run.card.status).toBe('scopeFailure');
  }, 120_000);

  it('refuses a change to the redaction policy lists, which are not the redactor\'s to widen', async () => {
    const run = await score(caseByID('ws.d1.log-redact.mask'), [attempt([
      ...solutionWrites('ws.d1.log-redact.mask'),
      shippedWith('ws.d1.log-redact.mask', 'src/formats.js', '  /\\bacme_sk_[0-9a-f]{32}\\b/g,', '  /\\bacme_sk_[0-9a-f]{32}\\b/g,\n  /[A-Za-z0-9]{32,}/g,'),
    ])]);
    expect(run.card.status).toBe('scopeFailure');
  }, 120_000);
});

/**
 * Every plausible wrong answer a structural profile says its case refuses, as a scripted attempt,
 * with the check expected to refuse it. The test below requires this table and the profiles to name
 * exactly the same answers, so a design claim can never outlive its proof.
 */
interface WrongAnswer {
  attempt: () => ScriptedAttempt;
  /** Whether every visible suite stays green — the answers that make the case discriminate. */
  visibleStayGreen: boolean;
  /** The check that refuses it: a hidden command id or a visible command id. */
  refusedBy: string;
}

const CONFIG = 'ws.d1.config-migrate.upgrade';
const SLAB = 'ws.d1.asset-container.retitle';
const REDACT = 'ws.d1.log-redact.mask';
const PAGING = 'ws.d1.catalog-paging.walk';
const QUERY = 'ws.d1.query-codec.nest';
const BOARD = 'ws.d1.task-board.reassign';

const QUERY_NUMERIC_INDEX = ['    const wantsArray = keys[index + 1] === APPEND;',
  '    const wantsArray = keys[index + 1] === APPEND || /^\\d+$/.test(keys[index + 1]);'] as const;
const QUERY_DECODE_NAME_FIRST = ['function parseName(rawName) {',
  'function parseName(undecoded) {\n  const rawName = decodeURIComponent(undecoded);'] as const;
const QUERY_PLUS_AFTER = ["const decodeComponent = (text) => decodeURIComponent(text.replace(/\\+/g, ' '));",
  "const decodeComponent = (text) => decodeURIComponent(text).replace(/\\+/g, ' ');"] as const;
const queryWith = (...manglings: (readonly [string, string])[]): ScriptedAttempt => attempt(solutionWrites(QUERY,
  (_file, contents) => manglings.reduce((out, [from, to]) => mangled(out, from, to), contents)));

/** The board operations written the natural way: set the value, re-index, record. */
const BOARD_REINDEX_ONLY = `function reassignTask(board, id, owner) {
  const task = taskOf(board, id);
  if (task.state === 'closed') throw new TaskClosedError(id);
  if (!isMember(board.members, owner)) throw new UnknownMemberError(owner);
  const from = task.owner;
  task.owner = owner;
  indexTask(board.indexes, task);
  record(board.history, { kind: 'reassigned', id, from, to: owner });
  return getTask(board, id);
}

function relabelTask(board, id, labels) {
  const task = taskOf(board, id);
  if (task.state === 'closed') throw new TaskClosedError(id);
  const from = [...task.labels];
  task.labels = [...new Set(labels)].sort();
  indexTask(board.indexes, task);
  record(board.history, { kind: 'relabelled', id, from, to: [...task.labels] });
  return getTask(board, id);
}
`;
/** The same, after reading "tasksFor(ada) still lists t-1": the one stale entry is removed by hand. */
const BOARD_REMOVES_THE_ENTRY_IT_WAS_SHOWN = BOARD_REINDEX_ONLY
  .replace("  const from = task.owner;\n  task.owner = owner;", "  const from = task.owner;\n  board.indexes.byOwner.get(from)?.delete(id);\n  task.owner = owner;")
  .replace("  const from = [...task.labels];\n  task.labels", "  const from = [...task.labels];\n  for (const label of from) board.indexes.byLabel.get(label)?.delete(id);\n  task.labels");
/** Correct indexing, but the membership check comes after the task has changed. */
const BOARD_VALIDATES_LATE = BOARD_REINDEX_ONLY
  .replace("  if (!isMember(board.members, owner)) throw new UnknownMemberError(owner);\n  const from = task.owner;\n  task.owner = owner;\n  indexTask(board.indexes, task);",
    "  const from = task.owner;\n  unindexTask(board.indexes, task);\n  task.owner = owner;\n  indexTask(board.indexes, task);\n  if (!isMember(board.members, owner)) throw new UnknownMemberError(owner);")
  .replace("  const from = [...task.labels];\n  task.labels = [...new Set(labels)].sort();\n  indexTask",
    "  const from = [...task.labels];\n  unindexTask(board.indexes, task);\n  task.labels = [...new Set(labels)].sort();\n  indexTask");
function boardWith(operations: string): ScriptedAttempt {
  const shipped = fs.readFileSync(path.join(fixtureOf(BOARD), 'src/board.js'), 'utf8');
  const stubs = shipped.slice(shipped.indexOf('/** Give a task to another member of the team. */'), shipped.indexOf('function tasksFor'));
  return attempt([{
    do: 'write',
    path: 'src/board.js',
    contents: mangled(mangled(shipped, stubs, `${operations}\n`),
      'const { createIndexes, indexTask, markClosed,', 'const { createIndexes, indexTask, unindexTask, markClosed,'),
  }]);
}

const WRONG_ANSWERS: Record<string, Record<string, WrongAnswer>> = {
  [CONFIG]: {
    'fix the rules and keep the rebuilding driver': {
      attempt: () => attempt(solutionWrites(CONFIG, (file, contents) => (file === 'src/upgrade.js' ? undefined : contents))),
      visibleStayGreen: true, refusedBy: 'unrecognised-keys-survive',
    },
    'preserve unknown keys but default what cannot be read': {
      attempt: () => attempt(solutionWrites(CONFIG, (file, contents) => (file !== 'src/rules.js' ? contents : mangled(mangled(
        contents,
        "      ? keepAsWritten('timeout', value, context, `${JSON.stringify(value)} is not a duration, so it was left as written`)",
        '      ? { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS }'),
        "    return keepAsWritten('color', value, context, `${JSON.stringify(value)} is not a colour setting, so it was left as written`);",
        "    return { color: 'auto' };")))),
      visibleStayGreen: true, refusedBy: 'unreadable-values-left-as-written',
    },
    'rebuild known sections from the fields they know': {
      attempt: () => attempt(solutionWrites(CONFIG, (file, contents) => (file !== 'src/rules.js' ? contents : mangled(contents,
        '  const section = { ...value };',
        '  const section = {};\n  if (value.maxSurge !== undefined) section.maxSurge = value.maxSurge;')))),
      visibleStayGreen: true, refusedBy: 'unrecognised-keys-survive',
    },
  },
  [SLAB]: {
    'repair the encoder and keep editing through the decoded model': {
      attempt: () => attempt([
        ...solutionWrites(SLAB, (file, contents) => (file === 'src/encode.js' ? contents : undefined)),
        shippedWith(SLAB, 'src/edit.js',
          "  return writeChunks([...readChunks(buffer), { type: 'note', data: Buffer.from(text, 'utf8') }]);",
          '  const image = decode(buffer);\n  return encode({ ...image, notes: [...image.notes, text] });'),
      ]),
      visibleStayGreen: true, refusedBy: 'edits-copy-other-chunks',
    },
    'let the decoder skip unknown critical chunks so the model round trip succeeds': {
      attempt: () => attempt([
        ...solutionWrites(SLAB, (file, contents) => (file === 'src/encode.js' ? contents : undefined)),
        shippedWith(SLAB, 'src/edit.js',
          "  return writeChunks([...readChunks(buffer), { type: 'note', data: Buffer.from(text, 'utf8') }]);",
          '  const image = decode(buffer);\n  return encode({ ...image, notes: [...image.notes, text] });'),
        shippedWith(SLAB, 'src/decode.js',
          "    else if (isCritical(chunk.type)) throw new SlabError(`cannot display a slab carrying a ${chunk.type} chunk`);\n", ''),
      ]),
      visibleStayGreen: true, refusedBy: 'edits-copy-other-chunks',
    },
    'strip every ancillary chunk when removing notes': {
      attempt: () => attempt(solutionWrites(SLAB, (file, contents) => (file !== 'src/edit.js' ? contents : mangled(mangled(contents,
        "const { readChunks, writeChunks } = require('./chunks.js');", "const { readChunks, writeChunks, isCritical } = require('./chunks.js');"),
        "  return writeChunks(chunksOf(buffer).filter((chunk) => chunk.type !== 'note'));",
        "  return writeChunks(chunksOf(buffer).filter((chunk) => isCritical(chunk.type) || chunk.type === 'name'));")))),
      visibleStayGreen: true, refusedBy: 'remove-notes-removes-notes',
    },
  },
  [REDACT]: {
    'recurse and re-serialise every JSON line': {
      attempt: () => attempt(solutionWrites(REDACT, (file, contents) => (file !== 'src/redact.js' ? contents : mangled(contents,
        '    return masked.changed ? JSON.stringify(masked.value) : line;', '    return JSON.stringify(masked.value);')))),
      visibleStayGreen: true, refusedBy: 'untouched-lines-stay-identical',
    },
    'run the machine-looking heuristic over JSON values': {
      attempt: () => attempt(solutionWrites(REDACT, (file, contents) => (file !== 'src/redact.js' ? contents : mangled(mangled(contents,
        "const { scanLogfmt } = require('./logfmt.js');",
        "const { scanLogfmt } = require('./logfmt.js');\nconst { maskMachineLooking } = require('./heuristics.js');"),
        '    const masked = maskCredentials(value);', '    const masked = maskMachineLooking(maskCredentials(value));')))),
      visibleStayGreen: true, refusedBy: 'masking-is-precise',
    },
    'keep the heuristic on lines that do not parse': {
      attempt: () => attempt(solutionWrites(REDACT, (file, contents) => (file !== 'src/redact.js' ? contents : mangled(mangled(contents,
        "const { scanLogfmt } = require('./logfmt.js');",
        "const { scanLogfmt } = require('./logfmt.js');\nconst { maskMachineLooking } = require('./heuristics.js');"),
        '  return maskCredentials(line);\n}', '  return maskMachineLooking(maskCredentials(line));\n}')))),
      visibleStayGreen: true, refusedBy: 'untouched-lines-stay-identical',
    },
  },
  [PAGING]: {
    'make the order total and keep the offset cursor': {
      attempt: () => attempt(solutionWrites(PAGING, (file, contents) => (file === 'src/order.js' ? contents : undefined))),
      visibleStayGreen: false, refusedBy: 'page-tests',
    },
    'resume after the last product found by id': {
      attempt: () => attempt(solutionWrites(PAGING, (file, contents) => (file !== 'src/page.js' ? contents : mangled(mangled(contents,
        '    listed = listed.filter((product) => compareProducts(product, place) > 0);',
        '    listed = listed.slice(listed.findIndex((product) => product.id === place.id) + 1);'),
        'function listPage', 'function listPage')))),
      visibleStayGreen: true, refusedBy: 'cursor-outlives-its-product',
    },
    'resume by rank alone': {
      attempt: () => attempt(solutionWrites(PAGING, (file, contents) => (file !== 'src/page.js' ? contents : mangled(contents,
        '    listed = listed.filter((product) => compareProducts(product, place) > 0);',
        '    listed = listed.filter((product) => product.rank < place.rank);')))),
      visibleStayGreen: false, refusedBy: 'page-tests',
    },
  },
  [QUERY]: {
    'read a numeric key as an array index': {
      attempt: () => queryWith(QUERY_NUMERIC_INDEX), visibleStayGreen: true, refusedBy: 'round-trip-property',
    },
    'percent-decode a name before finding its brackets': {
      attempt: () => queryWith(QUERY_DECODE_NAME_FIRST), visibleStayGreen: true, refusedBy: 'round-trip-property',
    },
    'turn + into a space after decoding': {
      attempt: () => queryWith(QUERY_PLUS_AFTER), visibleStayGreen: true, refusedBy: 'round-trip-property',
    },
  },
  [BOARD]: {
    'set the new value and re-index': {
      attempt: () => boardWith(BOARD_REINDEX_ONLY), visibleStayGreen: true, refusedBy: 'lists-agree-with-tasks',
    },
    'remove the stale owner entry by hand': {
      attempt: () => boardWith(BOARD_REMOVES_THE_ENTRY_IT_WAS_SHOWN), visibleStayGreen: true, refusedBy: 'lists-agree-with-tasks',
    },
    'validate after changing the task': {
      attempt: () => boardWith(BOARD_VALIDATES_LATE), visibleStayGreen: true, refusedBy: 'refused-change-changes-nothing',
    },
  },
};

describe('every plausible wrong answer a case claims to refuse is written, and refused', () => {
  it('names exactly the answers the structural profiles name, so no design claim goes unproven', () => {
    for (const profile of registeredWorkspaceStructuralProfiles()) {
      expect(Object.keys(WRONG_ANSWERS[profile.caseID] ?? {}).sort()).toEqual([...profile.design.refusedWrongAnswers].sort());
    }
  });

  const table = Object.entries(WRONG_ANSWERS).flatMap(([caseID, answers]) =>
    Object.entries(answers).map(([name, answer]) => [caseID, name, answer] as const));

  it.each(table)('%s · refuses "%s"', async (caseID, _name, answer) => {
    const workspaceCase = caseByID(caseID);
    // Twice, for the recovery cases: this is the answer given both times, which must not pass either.
    const run = await score(workspaceCase, Array.from({ length: workspaceCase.execution.maximumAttempts }, () => answer.attempt()));
    expect(run.card.status).not.toBe('pass');
    if (answer.visibleStayGreen) {
      // THE DISCRIMINATING KIND: green on everything visible, refused by the contract.
      expect(allPassed(run.visible), `every visible suite should be green: ${run.visible.filter((entry) => !entry.passed).map((entry) => entry.commandID)}`)
        .toBe(true);
      expect(outcome(run.hidden, answer.refusedBy)?.passed, `${answer.refusedBy} should refuse it`).toBe(false);
      expect(run.card.status).toBe('behavioralFailure');
    } else {
      expect(outcome(run.visible, answer.refusedBy)?.passed, `${answer.refusedBy} should refuse it`).toBe(false);
    }
  }, 180_000);
});

// MARK: - Recovery that can be observed

/** The engine's own fixed wording, with every variable part removed. Nothing else may be engine-authored. */
const BRIEFING_TEMPLATE = retryBriefingText({
  attemptIndex: 0, terminationReason: 'X', outcome: 'X', failureDetail: '', transcriptDigest: 'x', patchDigest: 'x',
}).split('\n').filter((line) => !line.includes('X') && line !== 'The checks produced no output to show you.');

/**
 * Split a briefing into what the engine wrote and what the check printed, and prove the first half
 * is only the fixed template: every line that is not template must appear verbatim in the failed
 * check's command line or output. This is the "no advice" guarantee stated as a property rather
 * than as a list of forbidden words.
 */
function expectEvidenceOnly(briefing: string, failed: CommandOutcome): void {
  const evidence = [failed.executable, ...failed.argv, failed.stdoutTail, failed.stderrTail].join('\n');
  for (const line of briefing.split('\n')) {
    if (line.trim().length === 0 || BRIEFING_TEMPLATE.includes(line)) continue;
    if (line.startsWith('ATTEMPT 1 OF THIS TASK DID NOT PASS') || line.startsWith('How it ended:')
      || line === 'This is what the checks reported, verbatim:') continue;
    expect(evidence.includes(line.trim()) || `${failed.executable} ${failed.argv.join(' ')}`.includes(line.trim()),
      `the briefing carries a line the check did not print: ${line}`).toBe(true);
  }
}

function briefingOf(run: Scored): string {
  expect(run.agent.instructions.length).toBe(2);
  const [first, second] = run.agent.instructions;
  expect(second.startsWith(first)).toBe(true);
  expect(second).not.toBe(first);
  return second.slice(first.length);
}

/** Advice words, matched as whole words — `entry !==` in a check's own source is not the word "try". */
const ADVICE = ['you should', 'instead', 'try', 'consider', 'hint', 'the fix', 'look at', 'unindexTask', 'src/query.js',
  'src/indexes.js', 'src/board.js', 'parseName', 'encodeURIComponent'];
/**
 * Whether the briefing advises, OUTSIDE the failed command line it quotes. The command line is the
 * check's own source — a `try {` in it is JavaScript, not a suggestion — and `expectEvidenceOnly`
 * has already proven every line of it came from the check.
 */
const saysAdvice = (briefing: string, failed: CommandOutcome, advice: string): boolean =>
  new RegExp(`\\b${advice.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'i')
    .test(briefing.split(`${failed.executable} ${failed.argv.join(' ')}`).join(''));

describe('the evidence-only check is itself able to fail', () => {
  it('rejects a briefing into which a line of advice has been inserted', () => {
    const failed = {
      commandID: 'x', kind: 'hidden', executable: 'node', argv: ['-e', 'check()'], exitCode: 1, passed: false, required: true,
      stdoutTail: 'counterexample 3 of 600:', stderrTail: '',
    } as unknown as CommandOutcome;
    const honest = `${retryBriefingText({
      attemptIndex: 0, terminationReason: 'completed', outcome: 'x failed', transcriptDigest: 'x', patchDigest: 'x',
      failureDetail: 'node -e check()\ncounterexample 3 of 600:',
    })}`;
    expect(() => expectEvidenceOnly(honest, failed)).not.toThrow();
    expect(() => expectEvidenceOnly(`${honest}\nYou should look at how names are decoded.`, failed)).toThrow(/did not print/);
  });
});

describe('ws.d1.query-codec.nest measures recovery from a counterexample', () => {
  it('passes a right first attempt on attempt 1', async () => {
    const run = await score(caseByID(QUERY), [solves(QUERY)]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(1);
    expect(run.card.retriesRequired).toBe(0);
  }, 120_000);

  it('recovers on attempt 2 after a plausible first attempt, and scores it below a first-time pass', async () => {
    const run = await score(caseByID(QUERY), [queryWith(QUERY_PLUS_AFTER), solves(QUERY)]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(2);
    expect(run.card.retriesRequired).toBe(1);
    expect(run.card.scoringPolicyID).toBe('policy.workspace.recovery');
    const firstTime = await score(caseByID(QUERY), [solves(QUERY)]);
    expect(run.card.compositeMilli.valueMilli!).toBeLessThan(firstTime.card.compositeMilli.valueMilli!);
  }, 180_000);

  it('fails after two attempts when the second fixes only the counterexample it was shown', async () => {
    // Attempt 1 carries two faults; the property check reports the one it meets first. Attempt 2
    // repairs exactly that one — and the check meets the other.
    const run = await score(caseByID(QUERY), [
      queryWith(QUERY_PLUS_AFTER, QUERY_NUMERIC_INDEX), queryWith(QUERY_NUMERIC_INDEX),
    ]);
    expect(run.card.status).toBe('behavioralFailure');
    expect(run.card.attemptsUsed).toBe(2);
    const [first, second] = run.result.attempts;
    const report = (attemptRecord: typeof first) => outcome(attemptRecord.hiddenOutcomes, 'round-trip-property')!.stdoutTail;
    expect(report(first)).toContain('counterexample');
    expect(report(second)).toContain('counterexample');
    // Two DIFFERENT counterexamples: the second attempt was shown something new, not the same thing.
    expect(report(second)).not.toBe(report(first));
  }, 180_000);

  it('hands attempt 2 the counterexample verbatim, and nothing the check did not print', async () => {
    const run = await score(caseByID(QUERY), [queryWith(QUERY_PLUS_AFTER), queryWith(QUERY_PLUS_AFTER)]);
    const briefing = briefingOf(run);
    const failed = outcome(run.result.attempts[0].hiddenOutcomes, 'round-trip-property')!;
    expect(briefing).toContain('ATTEMPT 1 OF THIS TASK DID NOT PASS');
    expect(briefing).toContain('FRESH COPY');
    expect(briefing).toContain('round-trip-property failed');
    expect(briefing).toContain('counterexample');
    expect(briefing).toContain('  parameters  ');
    expect(briefing).toContain('  decoded     ');
    expectEvidenceOnly(briefing, failed);
    for (const advice of ADVICE) expect(saysAdvice(briefing, failed, advice), `the briefing says "${advice}"`).toBe(false);
  }, 180_000);
});

describe('ws.d1.task-board.reassign measures recovery from an integration report', () => {
  it('passes a right first attempt on attempt 1', async () => {
    const run = await score(caseByID(BOARD), [solves(BOARD)]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(1);
  }, 120_000);

  it('recovers on attempt 2 after the natural first attempt', async () => {
    const run = await score(caseByID(BOARD), [boardWith(BOARD_REINDEX_ONLY), solves(BOARD)]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(2);
    expect(run.card.retriesRequired).toBe(1);
    // Attempt 1 really did pass everything visible: the failure it recovered from was not in plain sight.
    expect(allPassed(run.result.attempts[0].verificationOutcomes)).toBe(true);
  }, 180_000);

  it('fails after two attempts when the second removes only the stale entry it was shown', async () => {
    const run = await score(caseByID(BOARD), [boardWith(BOARD_REINDEX_ONLY), boardWith(BOARD_REMOVES_THE_ENTRY_IT_WAS_SHOWN)]);
    expect(run.card.status).toBe('behavioralFailure');
    expect(run.card.attemptsUsed).toBe(2);
    const [first, second] = run.result.attempts.map((entry) => outcome(entry.hiddenOutcomes, 'lists-agree-with-tasks')!.stderrTail);
    expect(first).toContain('tasksFor(ada) returned');
    expect(second).toContain('openCount');
  }, 180_000);

  it('hands attempt 2 the stale list verbatim, and nothing the check did not print', async () => {
    const run = await score(caseByID(BOARD), [boardWith(BOARD_REINDEX_ONLY), boardWith(BOARD_REINDEX_ONLY)]);
    const briefing = briefingOf(run);
    const failed = outcome(run.result.attempts[0].hiddenOutcomes, 'lists-agree-with-tasks')!;
    expect(briefing).toContain('lists-agree-with-tasks failed');
    expect(briefing).toContain("after t-1 moved from ada to lin, this is what tasksFor(ada) returned");
    expectEvidenceOnly(briefing, failed);
    for (const advice of ADVICE) expect(saysAdvice(briefing, failed, advice), `the briefing says "${advice}"`).toBe(false);
  }, 180_000);
});

// MARK: - And the fixtures were never touched

afterAll(() => {
  // Every run above worked on a copy. The sealed trees digest exactly as they did before.
  for (const caseID of DISCRIMINATOR_CASE_IDS) {
    expect(snapshotTree(fixtureOf(caseID), { capturedAt: '1970-01-01T00:00:00Z' }).treeDigest)
      .toBe(caseByID(caseID).source.expectedTreeDigest);
  }
});
