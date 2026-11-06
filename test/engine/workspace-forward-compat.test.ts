// The forward-compatibility pack, proven to ask the asset-container question twice more — and proven
// not to have moved anything that already existed — without a frontier model.
//
// FOUR THINGS ARE PROVEN HERE.
//
//   NOTHING THAT HAS RUN MOVED   every discriminator case digest and comparability key, and every
//                                pack digest including discriminator-one's, is asserted against the
//                                literal value the branch carried before this pass (d1a755c), written
//                                out rather than recomputed. The tier cases and packs are pinned the
//                                same way in `workspace-discriminator.test.ts`, which is untouched.
//   THE NEW PACK IS ONE THING    exactly two cases, in a new suite, found by id and by id@version,
//                                sealed deterministically, each declaring forwardCompatibilityReasoning
//                                and preservationUnderTransformation, with a structural profile of the
//                                discriminator family and no tier — in a registry routing never reads.
//   THE RULES ARE KEPT           ids name the task; no provider, model or outcome in the module or the
//                                instructions; fixtures deterministic and sealed; no marker, giveaway
//                                name or talk of unseen checks; every hidden check quotes a document
//                                in its fixture and reaches the package through src/index.js.
//   EACH CASE DISCRIMINATES      offline, with no model call: the untouched fixture fails its visible
//                                suites; the LOSSY reference fix passes every visible suite and fails a
//                                hidden check; the PRESERVING reference fix passes everything within the
//                                case's change limits; and every wrong answer a profile names is written
//                                by a scripted agent and refused by the check it names.
//
// NO PROVIDER IS CONTACTED ANYWHERE IN THIS FILE. Verification is real `node` against the real
// sealed fixtures; the agents are scripted; the reference fixes live in
// `workspace-forward-compat-fixes.ts` and nowhere under `fixtures/`.

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  allWorkspaceCases, discriminatorOnePack, forwardCompatOnePack, foundationFourPack, registeredWorkspacePacks,
  registeredWorkspaceSuites, tierThreePack, tierTwoPack, validateWorkspaceCatalog, workspacePackByID,
  workspaceSuiteByID,
} from '../../src/engine/workspace-catalog';
import {
  FC_AGENDA_FILE_RESCHEDULE, FC_MEMBER_ROSTER_TRANSFER, FORWARD_COMPAT_GENERALISES, WORKSPACE_SUITE_FORWARD_COMPAT,
  registeredWorkspaceForwardCompatProfiles, validateWorkspaceForwardCompatCatalogue, workspaceForwardCompatSuite,
} from '../../src/engine/workspace-catalog-forward-compat';
import { workspaceDiscriminatorSuite } from '../../src/engine/workspace-catalog-discriminator';
import {
  WORKSPACE_DIMENSIONS_REQUIRING_A_RETRY, WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey,
  workspaceInstructionText,
} from '../../src/engine/workspace-case';
import { makeWorkspaceBenchmarkPack, workspacePackDigest } from '../../src/engine/workspace-pack';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { workspacePackTier } from '../../src/engine/workspace-difficulty';
import {
  WorkspaceDiscriminatorError, validateWorkspaceStructuralProfile, workspacePackStructuralDigest,
  workspaceStructuralProfileDigest,
} from '../../src/engine/workspace-discriminator';
import { registeredWorkspaceStructuralProfiles } from '../../src/engine/workspace-discriminator-catalog';
import { routingDifficultyProfiles } from '../../src/engine/workspace-structural-tier';
import { ScriptedAttempt, ScriptedStep, ScriptedWorkspaceAgent } from '../../src/engine/workspace-agent';
import { CommandOutcome, InvariantOutcome, WorkspaceRunResult, runWorkspaceCase } from '../../src/engine/workspace-execution';
import { WorkspaceScorecard, scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { snapshotTree } from '../../src/engine/workspace-tree';
import {
  AGENDA_LOSSY, AGENDA_PRESERVING, ROSTER_LOSSY, ROSTER_PRESERVING, ReferenceFix, mangled,
} from './workspace-forward-compat-fixes';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const SOLUTION_ROOT = path.resolve(__dirname, 'fixtures/workspace-solutions');
const ENGINE_ROOT = path.resolve(__dirname, '../../src/engine');

const AGENDA = 'ws.fc.agenda-file.reschedule';
const ROSTER = 'ws.fc.member-roster.transfer';
const FORWARD_COMPAT_CASE_IDS = [...forwardCompatOnePack.caseIDs];
const DISCRIMINATOR_CASE_IDS = [...discriminatorOnePack.caseIDs];

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-fc-'));
  temporaries.push(directory);
  return directory;
}

const caseByID = (id: string): WorkspaceCase => {
  const found = allWorkspaceCases().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no such workspace case: ${id}`);
  return found;
};

const profileFor = (id: string) => {
  const found = registeredWorkspaceForwardCompatProfiles().find((profile) => profile.caseID === id);
  if (found === undefined) throw new Error(`no forward-compatibility profile for ${id}`);
  return found;
};

const filesUnder = (root: string): string[] =>
  snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' }).entries.map((entry) => entry.path);

const fixtureOf = (caseID: string): string => path.join(FIXTURE_ROOT, caseByID(caseID).source.fixturePath);

/** One turn of the event loop, between iterations of a loop that reads or snapshots trees synchronously. */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// MARK: - Nothing that has run moved

describe('every discriminator case and every pack that existed before this pass is byte-for-byte what it was', () => {
  /** Taken from the digest functions at d1a755c, before any of this pass existed. Written out on purpose. */
  const DISCRIMINATOR_CASES_AT_HEAD: Record<string, { cwc: string; cwk: string }> = {
    'ws.d1.asset-container.retitle': { cwc: 'cwc1:58cbbf3b6059561dcdd059e7c064faf8310e937d2ad5aa485c8968b4d1faf6d8', cwk: 'cwk1:0d277e1b220f69e923028f16acc4278c4bdaa7d8873e0ed84ad81e17cd568696' },
    'ws.d1.catalog-paging.walk': { cwc: 'cwc1:db7561743d39b426e28ba54cba024d18868787e4a00898047bab5413cf509a22', cwk: 'cwk1:dc5778b61587490a9cf22e4ca15002dc0a97bda0517daacbbdb6e6991a9e7dfa' },
    'ws.d1.config-migrate.upgrade': { cwc: 'cwc1:15f3b005a8bb7034a60be244413a83b9765ed53b62334e9db377d6e57d9eb299', cwk: 'cwk1:65b2971b56b4ea7f00f3929321f613a60f16b714f11ed777aa75484a518e7ca5' },
    'ws.d1.log-redact.mask': { cwc: 'cwc1:405d71670657d58c443be6f03b0dcccf310d8f962e580e884830b2ceb38120f2', cwk: 'cwk1:6c163227f8a8bebafc8af572ac7e9a8d92137cb847ea4c4ba48ab6857e2324d8' },
    'ws.d1.query-codec.nest': { cwc: 'cwc1:45e32b37d2c6358e10b747f43f1df8f619a02b006c589ba2b6782c21dcf4fc17', cwk: 'cwk1:957881b8cd60eeedaf12ffcc846af5b790c5496db9a84d9166d1ac12c82a535e' },
    'ws.d1.task-board.reassign': { cwc: 'cwc1:e304bc22b266f15a97d350a3d09a30ae6f3f252c3e2407c1cd5c3a2a1b31a066', cwk: 'cwk1:8e78994da6ff96fecdc26aa0bb3dcbabe1694567ddf7b7d119809f4bd762f5aa' },
  };
  const PACKS_AT_HEAD: Record<string, string> = {
    'pack.cernum.workspace.foundation-four': 'cwp1:c6bf8ba27e409eaefc8841110e8de44f9e3205602e8a810971f4ecd484d03f2d',
    'pack.cernum.workspace.tier-two': 'cwp1:e7e675e4ed02ddfea659d606bc747818de21a8ef23b46a757aa07eea3592d381',
    'pack.cernum.workspace.tier-three': 'cwp1:ea6becd1873d95c8d30f45d7ffd9ff6c073594f1e22e2e319a11a541de9bf7e2',
    'pack.cernum.workspace.discriminator-one': 'cwp1:03afd8f384dfe800245beb3e3f7ccf1eef1667c37a04672d0f3c1f91bd388edf',
  };

  it('keeps every discriminator case digest and comparability key', () => {
    expect(Object.keys(DISCRIMINATOR_CASES_AT_HEAD).sort()).toEqual([...DISCRIMINATOR_CASE_IDS].sort());
    for (const [caseID, expected] of Object.entries(DISCRIMINATOR_CASES_AT_HEAD)) {
      expect(workspaceCaseDigest(caseByID(caseID)), `${caseID}'s cwc1: moved`).toBe(expected.cwc);
      expect(workspaceComparabilityKey(caseByID(caseID)), `${caseID}'s cwk1: moved`).toBe(expected.cwk);
    }
  });

  it('keeps every existing pack digest, membership and sampling, discriminator-one included', () => {
    const cases = allWorkspaceCases();
    for (const pack of [foundationFourPack, tierTwoPack, tierThreePack, discriminatorOnePack]) {
      expect(workspacePackDigest(pack, cases), `${pack.id}'s cwp1: moved`).toBe(PACKS_AT_HEAD[pack.id]);
      expect(pack.version).toBe('1');
      expect(pack.repeatsPerCase).toBe(3);
    }
    expect([...discriminatorOnePack.caseIDs].sort()).toEqual([
      'ws.d1.asset-container.retitle', 'ws.d1.catalog-paging.walk', 'ws.d1.config-migrate.upgrade',
      'ws.d1.log-redact.mask', 'ws.d1.query-codec.nest', 'ws.d1.task-board.reassign',
    ]);
    for (const pack of [foundationFourPack, tierTwoPack, tierThreePack]) expect(pack.caseIDs).toHaveLength(4);
  });

  it('keeps the discriminator suite, its structural registry, the tier profiles and the routing inputs as they were', () => {
    const sortedDiscriminatorIDs = [...DISCRIMINATOR_CASE_IDS].sort();
    expect(workspaceDiscriminatorSuite.cases.map((entry) => entry.id).sort()).toEqual(sortedDiscriminatorIDs);
    expect(registeredWorkspaceStructuralProfiles().map((profile) => profile.caseID).sort()).toEqual(sortedDiscriminatorIDs);
    expect(registeredWorkspaceDifficultyProfiles()).toHaveLength(12);
    expect(workspacePackStructuralDigest(registeredWorkspaceStructuralProfiles(), discriminatorOnePack.caseIDs)?.startsWith('cwx1:')).toBe(true);
    // The forward-compatibility cases are in no routing input: neither registry routing reads carries them.
    const routing = routingDifficultyProfiles(registeredWorkspaceDifficultyProfiles(), registeredWorkspaceStructuralProfiles());
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      expect(routing.some((profile) => profile.caseID === caseID), `${caseID} reached the routing profiles`).toBe(false);
      expect(registeredWorkspaceDifficultyProfiles().some((profile) => profile.caseID === caseID)).toBe(false);
      expect(registeredWorkspaceStructuralProfiles().some((profile) => profile.caseID === caseID)).toBe(false);
    }
    // No forward-compatibility case is in any earlier pack, and no earlier case is in this one.
    for (const pack of [foundationFourPack, tierTwoPack, tierThreePack, discriminatorOnePack]) {
      expect(pack.caseIDs.some((caseID) => FORWARD_COMPAT_CASE_IDS.includes(caseID))).toBe(false);
    }
    expect(FORWARD_COMPAT_CASE_IDS.every((caseID) => caseID.startsWith('ws.fc.'))).toBe(true);
  });
});

// MARK: - The new pack is one thing

describe('pack.cernum.workspace.forward-compat-one@1 is a sealed, untiered pack of exactly two cases', () => {
  it('validates with the whole catalogue and is found by id and by id@version', () => {
    expect(() => validateWorkspaceCatalog()).not.toThrow();
    expect(() => validateWorkspaceForwardCompatCatalogue()).not.toThrow();
    expect(registeredWorkspacePacks).toContain(forwardCompatOnePack);
    expect(registeredWorkspaceSuites).toContain(workspaceForwardCompatSuite);
    expect(workspacePackByID('pack.cernum.workspace.forward-compat-one')).toBe(forwardCompatOnePack);
    expect(workspacePackByID('pack.cernum.workspace.forward-compat-one@1')).toBe(forwardCompatOnePack);
    expect(workspacePackByID('pack.cernum.workspace.forward-compat-one@2')).toBeUndefined();
    expect(workspaceSuiteByID(WORKSPACE_SUITE_FORWARD_COMPAT)).toBe(workspaceForwardCompatSuite);
    expect(workspaceForwardCompatSuite.id).toBe('suite.cernum.workspace.forward-compat');
    expect(workspaceForwardCompatSuite.version).toBe('1');
  });

  it('is two cases, three repeats, one suite, one attempt each', () => {
    expect(forwardCompatOnePack.version).toBe('1');
    expect(forwardCompatOnePack.caseIDs).toEqual([AGENDA, ROSTER]);
    expect(forwardCompatOnePack.repeatsPerCase).toBe(3);
    expect(workspaceForwardCompatSuite.cases).toEqual([FC_AGENDA_FILE_RESCHEDULE, FC_MEMBER_ROSTER_TRANSFER]);
    expect(workspaceForwardCompatSuite.cases.map((entry) => entry.id)).toEqual(FORWARD_COMPAT_CASE_IDS);
    for (const entry of workspaceForwardCompatSuite.cases) {
      expect(entry.suiteID).toBe(WORKSPACE_SUITE_FORWARD_COMPAT);
      expect(entry.version).toBe('1');
      expect(entry.source.sealed).toBe(true);
      expect(entry.execution.environmentAllowlist).toEqual(['HOME', 'USER']);
      expect(entry.execution.networkPolicy).toBe('providerOnly');
      expect(entry.execution.maximumAttempts).toBe(1);
      expect(entry.scoring.id).toBe('policy.workspace.default');
      expect(entry.dimensions.some((dimension) => WORKSPACE_DIMENSIONS_REQUIRING_A_RETRY.includes(dimension))).toBe(false);
    }
  });

  it('declares forwardCompatibilityReasoning and preservationUnderTransformation on both cases, and differs between them', () => {
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      expect(caseByID(caseID).dimensions).toContain('forwardCompatibilityReasoning');
      expect(caseByID(caseID).dimensions).toContain('preservationUnderTransformation');
    }
    expect(caseByID(AGENDA).dimensions.join('+')).not.toBe(caseByID(ROSTER).dimensions.join('+'));
    // Three cases in the catalogue now ask this question, each in its own fixture.
    const asking = allWorkspaceCases().filter((entry) => entry.dimensions.includes('forwardCompatibilityReasoning'));
    expect(asking.map((entry) => entry.id).sort()).toEqual([FORWARD_COMPAT_GENERALISES, AGENDA, ROSTER].sort());
    expect(new Set(asking.map((entry) => entry.source.fixturePath)).size).toBe(3);
  });

  it('seals deterministically, and is a different experiment from every other pack', () => {
    const cases = allWorkspaceCases();
    const once = workspacePackDigest(forwardCompatOnePack, cases);
    expect(once.startsWith('cwp1:')).toBe(true);
    expect(workspacePackDigest(forwardCompatOnePack, cases)).toBe(once);
    const reordered = makeWorkspaceBenchmarkPack({ ...forwardCompatOnePack, caseIDs: [...forwardCompatOnePack.caseIDs].reverse() });
    expect(workspacePackDigest(reordered, cases)).toBe(once);
    expect(workspacePackDigest(makeWorkspaceBenchmarkPack({ ...forwardCompatOnePack, repeatsPerCase: 1 }), cases)).not.toBe(once);
    const digests = registeredWorkspacePacks.map((pack) => workspacePackDigest(pack, cases));
    expect(new Set(digests).size).toBe(registeredWorkspacePacks.length);
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      expect(workspaceCaseDigest(caseByID(caseID))).toBe(workspaceCaseDigest(caseByID(caseID)));
      expect(workspaceCaseDigest(caseByID(caseID)).startsWith('cwc1:')).toBe(true);
    }
  });

  it('is in two domains unrelated to slabs and to each other', () => {
    const textOf = (caseID: string) => filesUnder(fixtureOf(caseID))
      .map((file) => fs.readFileSync(path.join(fixtureOf(caseID), file), 'utf8').toLowerCase()).join('\n');
    const agenda = textOf(AGENDA);
    const roster = textOf(ROSTER);
    for (const word of ['slab', 'chunk', 'pixel', 'crc']) {
      expect(agenda.includes(word), `the agenda fixture says "${word}"`).toBe(false);
      expect(roster.includes(word), `the roster fixture says "${word}"`).toBe(false);
    }
    for (const word of ['roster', 'promote', 'retire']) expect(agenda.includes(word), `the agenda fixture says "${word}"`).toBe(false);
    for (const word of ['agenda', 'event', 'reschedule', 'calendar']) expect(roster.includes(word), `the roster fixture says "${word}"`).toBe(false);
    expect(caseByID(AGENDA).source.fixturePath).not.toBe(caseByID(ROSTER).source.fixturePath);
    expect(caseByID(AGENDA).source.expectedTreeDigest).not.toBe(caseByID(ROSTER).source.expectedTreeDigest);
  });
});

describe('each forward-compatibility case carries a structural profile of the discriminator family, and no tier', () => {
  it('profiles exactly the two cases, untiered, in a registry of their own', () => {
    const profiles = registeredWorkspaceForwardCompatProfiles();
    expect(profiles.map((profile) => profile.caseID).sort()).toEqual([...FORWARD_COMPAT_CASE_IDS].sort());
    expect(workspacePackTier(registeredWorkspaceDifficultyProfiles(), forwardCompatOnePack.caseIDs)).toBeUndefined();
    for (const profile of profiles) {
      expect(profile.family).toBe('empiricalDiscriminator');
      expect(Object.keys(profile)).not.toContain('tier');
      expect(profile.design.reasoningPattern).toBe('forwardCompatibleRewrite');
      expect(profile.design.generalises).toBe(FORWARD_COMPAT_GENERALISES);
      expect(profile.design.recoveryDesigned).toBe(false);
      expect(profile.design.refusedWrongAnswers).toHaveLength(3);
      expect(workspaceStructuralProfileDigest(profile).startsWith('cwx1:')).toBe(true);
      expect(() => validateWorkspaceStructuralProfile(profile, caseByID(profile.caseID))).not.toThrow();
      expect(() => validateWorkspaceStructuralProfile({ ...profile, tier: 'tier2' } as typeof profile, caseByID(profile.caseID)))
        .toThrow(/untiered by design/);
      expect(() => validateWorkspaceStructuralProfile({ ...profile, measured: { ...profile.measured, hiddenCommandCount: 9 } }, caseByID(profile.caseID)))
        .toThrow(WorkspaceDiscriminatorError);
    }
    expect(() => validateWorkspaceStructuralProfile(profileFor(AGENDA), caseByID(ROSTER))).toThrow(/checked against/);
    // The pack's own structural digest exists, from its own registry, and is not the discriminator pack's.
    const packDigest = workspacePackStructuralDigest(registeredWorkspaceForwardCompatProfiles(), forwardCompatOnePack.caseIDs);
    expect(packDigest?.startsWith('cwx1:')).toBe(true);
    expect(packDigest).not.toBe(workspacePackStructuralDigest(registeredWorkspaceStructuralProfiles(), discriminatorOnePack.caseIDs));
    // And the discriminator registry answers nothing for this pack: it never learned these cases.
    expect(workspacePackStructuralDigest(registeredWorkspaceStructuralProfiles(), forwardCompatOnePack.caseIDs)).toBeUndefined();
  });

  it('checks the fixture figures against the sealed tree and the edit count against the preserving fix', async () => {
    const fixes: Record<string, ReferenceFix> = { [AGENDA]: AGENDA_PRESERVING, [ROSTER]: ROSTER_PRESERVING };
    for (const profile of registeredWorkspaceForwardCompatProfiles()) {
      await yieldToEventLoop();
      const snapshot = snapshotTree(fixtureOf(profile.caseID), { capturedAt: '1970-01-01T00:00:00Z' });
      expect(profile.measured.fixtureFileCount, `${profile.caseID} file count`).toBe(snapshot.fileCount);
      expect(profile.measured.fixtureByteCount, `${profile.caseID} byte count`).toBe(snapshot.totalByteCount);
      expect(profile.measured.fixtureSourceFileCount, `${profile.caseID} source file count`)
        .toBe(snapshot.entries.filter((entry) => entry.path.startsWith('src/')).length);
      expect(Object.keys(fixes[profile.caseID]).length, `${profile.caseID} preserving-fix file count`)
        .toBe(profile.declared.expectedMinimumEditFiles);
    }
  }, 120_000);

  it('never lets a provider, a model or an outcome into the case module or the instructions', async () => {
    for (const file of ['workspace-catalog-forward-compat.ts']) {
      await yieldToEventLoop();
      const source = fs.readFileSync(path.join(ENGINE_ROOT, file), 'utf8');
      const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
      for (const name of ['claudeCLI', 'codexCLI', 'opencodeCLI', 'anthropicAPI', 'openaiAPI', 'ProviderID', 'ProviderBinding',
        'requestedModelID: \'', 'haiku', 'sonnet', 'fable', 'opus']) {
        expect(code.toLowerCase().includes(name.toLowerCase()), `${file} mentions ${name}`).toBe(false);
      }
    }
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      const text = workspaceInstructionText(caseByID(caseID)).toLowerCase();
      for (const word of ['claude', 'haiku', 'sonnet', 'fable', 'opus', 'gpt', 'model', 'tier', 'benchmark', 'hidden']) {
        expect(text.includes(word), `${caseID}'s instruction says "${word}"`).toBe(false);
      }
      expect(text).toContain('docs/format.md');
    }
  }, 120_000);
});

// MARK: - The fixtures

describe('the two fixtures are deterministic, compact and give nothing away', () => {
  it('digest to their seals, twice, and stay inside the size the discriminator pack was designed at', async () => {
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      await yieldToEventLoop();
      const root = fixtureOf(caseID);
      const first = snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' });
      const second = snapshotTree(root, { capturedAt: '2001-01-01T00:00:00Z' });
      expect(first.treeDigest, `${caseID}'s seal`).toBe(caseByID(caseID).source.expectedTreeDigest);
      expect(second.treeDigest).toBe(first.treeDigest);
      expect(first.fileCount).toBeGreaterThanOrEqual(10);
      expect(first.fileCount).toBeLessThanOrEqual(30);
      const lines = filesUnder(root).reduce((sum, file) => sum + fs.readFileSync(path.join(root, file), 'utf8').split('\n').length, 0);
      expect(lines, `${caseID} is ${lines} lines`).toBeGreaterThanOrEqual(300);
      expect(lines, `${caseID} is ${lines} lines`).toBeLessThanOrEqual(1200);
      expect(fs.existsSync(path.join(root, 'package.json'))).toBe(false);
    }
  }, 120_000);

  it('leaks no answer: no marker, no giveaway name, no talk of unseen checks, and no reference fix in the tree', async () => {
    const fixes: Record<string, ReferenceFix[]> = { [AGENDA]: [AGENDA_LOSSY, AGENDA_PRESERVING], [ROSTER]: [ROSTER_LOSSY, ROSTER_PRESERVING] };
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      await yieldToEventLoop();
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
      // The reference fixes are test code: no tree under fixtures/ or under the solutions directory carries them.
      expect(fs.existsSync(path.join(SOLUTION_ROOT, caseID)), `${caseID} has a solution directory`).toBe(false);
      for (const fix of fixes[caseID]) {
        for (const [file, contents] of Object.entries(fix)) {
          expect(fs.existsSync(path.join(root, file)), `${caseID}: the fix writes ${file}, which the fixture does not ship`).toBe(true);
          expect(fs.readFileSync(path.join(root, file), 'utf8'), `${caseID}: ${file} already is the fix`).not.toBe(contents);
        }
      }
    }
  }, 120_000);

  it('names the task in each case id, never the answer', () => {
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      for (const word of ['preserve', 'recover', 'forward', 'selective', 'unknown', 'keep', 'interact', 'trap', 'diagnose',
        'cluster', 'retry', 'hidden', 'copy', 'lossy']) {
        expect(caseID.includes(word), `${caseID} says "${word}"`).toBe(false);
      }
    }
  });

  it('grounds every hidden check in a document the fixture carries, which the check quotes', async () => {
    for (const caseID of FORWARD_COMPAT_CASE_IDS) {
      await yieldToEventLoop();
      const workspaceCase = caseByID(caseID);
      expect(workspaceCase.verification.hiddenCommands.length).toBe(2);
      for (const hidden of workspaceCase.verification.hiddenCommands) {
        const cited = [...hidden.args[1].matchAll(/(docs\/[A-Z0-9]+\.md|README\.md)/g)].map((match) => match[1]);
        expect(cited.length, `${caseID}/${hidden.id} cites no document`).toBeGreaterThan(0);
        for (const document of cited) {
          expect(fs.existsSync(path.join(fixtureOf(caseID), document)), `${caseID}/${hidden.id} cites ${document}, which is not there`)
            .toBe(true);
        }
        expect(hidden.args[1]).toContain("require('./src/index.js')");
        expect(/require\('\.\/src\/(?!index\.js)/.test(hidden.args[1]), `${caseID}/${hidden.id} requires an internal module`).toBe(false);
        for (const forbidden of ['Math.random(', 'Date.now(', 'new Date(', 'process.hrtime']) {
          expect(hidden.args[1].includes(forbidden), `${caseID}/${hidden.id} uses ${forbidden}`).toBe(false);
        }
      }
      // The same scope discipline as every other case: the forbidden list is told and enforced.
      expect(workspaceCase.task.scope.forbidden).toEqual(workspaceCase.verification.forbiddenChanges);
      expect(workspaceCase.task.scope.forbidden).toContain('test/**');
      expect(workspaceCase.task.scope.forbidden).toContain('docs/**');
    }
  }, 120_000);
});

// MARK: - Scripted runs

interface Scored {
  card: WorkspaceScorecard;
  result: WorkspaceRunResult;
  visible: CommandOutcome[];
  hidden: CommandOutcome[];
  invariants: InvariantOutcome[];
}

async function score(workspaceCase: WorkspaceCase, attempts: ScriptedAttempt[]): Promise<Scored> {
  const agent = new ScriptedWorkspaceAgent(attempts);
  const result = await runWorkspaceCase({ case: workspaceCase, driver: agent, fixtureRoot: FIXTURE_ROOT, sandboxRoot: temporary() });
  const deciding = result.attempts[result.attempts.length - 1];
  return {
    card: scoreWorkspaceRun(workspaceCase, result),
    result,
    visible: deciding?.verificationOutcomes ?? [],
    hidden: deciding?.hiddenOutcomes ?? [],
    invariants: deciding?.invariantOutcomes ?? [],
  };
}

const outcome = (outcomes: CommandOutcome[], id: string) => outcomes.find((entry) => entry.commandID === id);
const allPassed = (outcomes: CommandOutcome[]) => outcomes.every((entry) => entry.passed);
const failedIDs = (outcomes: CommandOutcome[]) => outcomes.filter((entry) => !entry.passed).map((entry) => entry.commandID).sort();

const writes = (fix: ReferenceFix): ScriptedStep[] =>
  Object.entries(fix).map(([file, contents]) => ({ do: 'write', path: file, contents }));
const attempt = (steps: ScriptedStep[], finalMessage = 'Done.'): ScriptedAttempt => ({ steps, finalMessage });
const withFile = (fix: ReferenceFix, file: string, from: string, to: string): ReferenceFix =>
  ({ ...fix, [file]: mangled(fix[file], from, to) });

const CHANGES_NOTHING: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'I have read the repository and everything looks correct to me.' }],
  finalMessage: 'No change was needed.',
};

function editsAForbiddenTest(workspaceCase: WorkspaceCase): ScriptedAttempt {
  return attempt([{ do: 'write', path: workspaceCase.verification.commands[0].args[0], contents: 'process.exit(0);\n' }],
    'I adjusted the test.');
}

interface Reference {
  lossy: ReferenceFix;
  preserving: ReferenceFix;
  /** The visible suites the untouched fixture fails, and the ones it passes. */
  failsUntouched: string[];
  passesUntouched: string[];
}

const REFERENCE: Record<string, Reference> = {
  [AGENDA]: {
    lossy: AGENDA_LOSSY, preserving: AGENDA_PRESERVING,
    failsUntouched: ['edit-tests', 'time-tests'], passesUntouched: ['decode-tests', 'lines-tests'],
  },
  [ROSTER]: {
    lossy: ROSTER_LOSSY, preserving: ROSTER_PRESERVING,
    failsUntouched: ['decode-tests', 'edit-tests'], passesUntouched: ['query-tests', 'table-tests'],
  },
};

describe('each case, offline and with no model call: the untouched fixture fails, the lossy fix is refused, the preserving fix passes', () => {
  it.each(FORWARD_COMPAT_CASE_IDS)('%s · the untouched fixture fails exactly the visible suites its instruction says fail', async (caseID) => {
    const run = await score(caseByID(caseID), [CHANGES_NOTHING]);
    expect(run.card.status).not.toBe('pass');
    expect(run.card.changedFileCount).toBe(0);
    expect(failedIDs(run.visible)).toEqual(REFERENCE[caseID].failsUntouched);
    expect(run.visible.filter((entry) => entry.passed).map((entry) => entry.commandID).sort()).toEqual(REFERENCE[caseID].passesUntouched);
    expect(workspaceInstructionText(caseByID(caseID))).toContain('Two test suites');
  }, 120_000);

  it.each(FORWARD_COMPAT_CASE_IDS)('%s · the LOSSY fix passes every visible suite and fails a hidden check', async (caseID) => {
    const run = await score(caseByID(caseID), [attempt(writes(REFERENCE[caseID].lossy))]);
    expect(allPassed(run.visible), `visible suites still failing: ${failedIDs(run.visible)}`).toBe(true);
    expect(run.hidden.length).toBe(2);
    expect(run.hidden.some((entry) => !entry.passed), 'no hidden check refused the lossy fix').toBe(true);
    expect(run.card.status).toBe('behavioralFailure');
    expect(run.invariants.filter((entry) => !entry.satisfied)).toEqual([]);
  }, 120_000);

  it.each(FORWARD_COMPAT_CASE_IDS)('%s · the PRESERVING fix passes every visible suite, every hidden check and every invariant within the limits', async (caseID) => {
    const workspaceCase = caseByID(caseID);
    const run = await score(workspaceCase, [attempt(writes(REFERENCE[caseID].preserving))]);
    expect(run.card.status, run.card.detail).toBe('pass');
    expect(run.card.attemptsUsed).toBe(1);
    for (const entry of [...run.visible, ...run.hidden]) expect(entry.passed, `${caseID}: ${entry.commandID}`).toBe(true);
    expect(run.hidden.length).toBe(2);
    expect(run.invariants.length).toBe(workspaceCase.verification.invariants.length);
    expect(run.invariants.filter((entry) => !entry.satisfied)).toEqual([]);
    expect(run.card.regressionCount).toBe(0);
    expect(run.card.changedFileCount).toBe(Object.keys(REFERENCE[caseID].preserving).length);
    expect(run.card.changedFileCount).toBeLessThanOrEqual(workspaceCase.verification.maximumChangedFiles);
    expect(run.card.changedLineCount).toBeGreaterThan(0);
    expect(run.card.changedLineCount).toBeLessThanOrEqual(workspaceCase.verification.maximumChangedLines);
  }, 120_000);

  it.each(FORWARD_COMPAT_CASE_IDS)('%s · editing a forbidden test is a scope failure, not a pass', async (caseID) => {
    const workspaceCase = caseByID(caseID);
    const run = await score(workspaceCase, [editsAForbiddenTest(workspaceCase)]);
    expect(run.card.status).toBe('scopeFailure');
  }, 120_000);

  it.each(FORWARD_COMPAT_CASE_IDS)('%s · editing the documentation the contract lives in is a scope failure', async (caseID) => {
    const run = await score(caseByID(caseID), [attempt([
      ...writes(REFERENCE[caseID].preserving),
      { do: 'write', path: 'docs/FORMAT.md', contents: '# The format\n\nAnything goes.\n' },
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

const WRONG_ANSWERS: Record<string, Record<string, WrongAnswer>> = {
  [AGENDA]: {
    'rebuild the agenda from the decoded model after fixing every visible failure': {
      attempt: () => attempt(writes(AGENDA_LOSSY)), visibleStayGreen: true, refusedBy: 'edits-copy-other-lines',
    },
    'cancel by removing the event from the file': {
      attempt: () => attempt(writes(withFile(AGENDA_PRESERVING, 'src/edit.js',
        "  setValue(eventOf(root, id), 'STATUS', 'CANCELLED');",
        '  root.entries.splice(root.entries.indexOf(eventOf(root, id)), 1);'))),
      visibleStayGreen: false, refusedBy: 'edit-tests',
    },
    'add the status line at the top of the event': {
      attempt: () => attempt(writes(withFile(AGENDA_PRESERVING, 'src/edit.js',
        '  if (index === -1) component.entries.push(formatLine({ name, value }));',
        '  if (index === -1) component.entries.unshift(formatLine({ name, value }));'))),
      visibleStayGreen: true, refusedBy: 'cancel-marks-and-keeps',
    },
  },
  [ROSTER]: {
    'rebuild the roster from the decoded members after fixing every visible failure': {
      attempt: () => attempt(writes(ROSTER_LOSSY)), visibleStayGreen: true, refusedBy: 'edits-copy-other-cells',
    },
    'write a new row in the package\'s own column order': {
      attempt: () => attempt(writes(withFile(ROSTER_PRESERVING, 'src/edit.js',
        "  table.entries.push({ kind: 'row', cells: table.header.map((name) => (KNOWN.includes(name) ? values[name] : '')) });",
        "  table.entries.push({ kind: 'row', cells: [...KNOWN.map((name) => values[name]), ...table.header.slice(KNOWN.length).map(() => '')] });"))),
      visibleStayGreen: true, refusedBy: 'add-and-retire',
    },
    'drop the comment lines when rewriting': {
      attempt: () => attempt(writes(withFile(ROSTER_PRESERVING, 'src/edit.js',
        '  const table = readTable(text);',
        "  const table = readTable(text);\n  table.entries = table.entries.filter((entry) => entry.kind === 'row');"))),
      visibleStayGreen: true, refusedBy: 'edits-copy-other-cells',
    },
  },
};

describe('every plausible wrong answer a case claims to refuse is written, and refused', () => {
  it('names exactly the answers the structural profiles name, so no design claim goes unproven', () => {
    for (const profile of registeredWorkspaceForwardCompatProfiles()) {
      expect(Object.keys(WRONG_ANSWERS[profile.caseID] ?? {}).sort()).toEqual([...profile.design.refusedWrongAnswers].sort());
    }
    expect(Object.keys(WRONG_ANSWERS).sort()).toEqual([...FORWARD_COMPAT_CASE_IDS].sort());
  });

  const table = Object.entries(WRONG_ANSWERS).flatMap(([caseID, answers]) =>
    Object.entries(answers).map(([name, answer]) => [caseID, name, answer] as const));

  it.each(table)('%s · refuses "%s"', async (caseID, _name, answer) => {
    const run = await score(caseByID(caseID), [answer.attempt()]);
    expect(run.card.status).not.toBe('pass');
    if (answer.visibleStayGreen) {
      // THE DISCRIMINATING KIND: green on everything visible, refused by the contract.
      expect(allPassed(run.visible), `every visible suite should be green: ${failedIDs(run.visible)}`).toBe(true);
      expect(outcome(run.hidden, answer.refusedBy)?.passed, `${answer.refusedBy} should refuse it`).toBe(false);
      expect(run.card.status).toBe('behavioralFailure');
      // The refusal quotes the document the fixture carries, so a reader of the record knows what rule was broken.
      const report = outcome(run.hidden, answer.refusedBy)!;
      expect(`${report.stdoutTail}\n${report.stderrTail}`).toContain('docs/FORMAT.md');
    } else {
      expect(outcome(run.visible, answer.refusedBy)?.passed, `${answer.refusedBy} should refuse it`).toBe(false);
    }
  }, 180_000);
});

// MARK: - And the fixtures were never touched

afterAll(async () => {
  // Every run above worked on a copy. The sealed trees digest exactly as they did before.
  for (const caseID of FORWARD_COMPAT_CASE_IDS) {
    await yieldToEventLoop();
    expect(snapshotTree(fixtureOf(caseID), { capturedAt: '1970-01-01T00:00:00Z' }).treeDigest)
      .toBe(caseByID(caseID).source.expectedTreeDigest);
  }
}, 120_000);
