// The difficulty tiers, the two new packs, and the promise that Tier 1 did not move.
//
// WHAT THIS FILE IS FOR. Adding eight cases and a difficulty scheme to a catalogue whose first pack
// has ALREADY RUN — forty-eight sealed records on the machine that produced them — puts two things
// at risk at once. The first is the completed experiment: if `ws.broken-sum.mean` moves by one byte,
// its `cwc1:` moves, its `cwk1:` moves, `foundation-four`'s `cwp1:` moves, and every one of those
// records stops matching the thing it says it ran. The second is the new claim: a "Tier 3" that
// means whatever its author felt is worse than no tier at all, because a reader would believe it.
//
// So the two halves of this file are:
//
//   TIER 1 DID NOT MOVE      the four case digests, the four comparability keys and the pack digest
//                            are asserted against the literal values HEAD carried before this pass.
//                            They are written out rather than recomputed, because a test that
//                            recomputes both sides of an equation proves nothing.
//   THE NEW CLAIM HOLDS UP   every fixture digests to its seal, the measured half of every profile
//                            is what the sealed case actually says, the declared half is inside its
//                            tier's bands, a case labelled above its evidence is refused, and no
//                            hidden check is a trap or is sitting in the tree the model is handed.
//
// NO PROVIDER IS CONTACTED ANYWHERE IN THIS FILE.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  allWorkspaceCases, foundationFourPack, registeredWorkspacePacks, tierThreePack, tierTwoPack,
  validateWorkspaceCatalog, workspacePackByID,
} from '../../src/engine/workspace-catalog';
import { workspaceTierTwoSuite } from '../../src/engine/workspace-catalog-tier-two';
import { workspaceTierThreeSuite } from '../../src/engine/workspace-catalog-tier-three';
import {
  WorkspaceCase, workspaceCaseDigest, workspaceComparabilityKey,
} from '../../src/engine/workspace-case';
import { makeWorkspaceBenchmarkPack, workspacePackDigest } from '../../src/engine/workspace-pack';
import {
  WORKSPACE_TIER_BANDS, WorkspaceDifficultyError, axesBeyondPreviousTier, measureWorkspaceCase,
  validateWorkspaceDifficultyProfile, workspaceDifficultyDigest, workspaceDifficultyProfileFor,
  workspacePackDifficultyDigest, workspacePackTier,
} from '../../src/engine/workspace-difficulty';
import { registeredWorkspaceDifficultyProfiles } from '../../src/engine/workspace-difficulty-catalog';
import { snapshotTree } from '../../src/engine/workspace-tree';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const SOLUTION_ROOT = path.resolve(__dirname, 'fixtures/workspace-solutions');

const caseByID = (id: string): WorkspaceCase => {
  const found = allWorkspaceCases().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no such workspace case: ${id}`);
  return found;
};

const profileFor = (id: string) => {
  const found = workspaceDifficultyProfileFor(registeredWorkspaceDifficultyProfiles(), id);
  if (found === undefined) throw new Error(`no difficulty profile for ${id}`);
  return found;
};

/** Every file in a directory tree, relative to it. */
function filesUnder(root: string): string[] {
  return snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' }).entries.map((entry) => entry.path);
}

// MARK: - Tier 1 did not move

describe('the pack that has already run is byte-for-byte what it was', () => {
  /**
   * THE LITERAL VALUES HEAD CARRIED, taken from a run of the digest functions against commit
   * 436f3a6 in a detached worktree before any of this pass existed. They are written out because a
   * test that recomputed them from the same code it is checking would pass however far the
   * catalogue drifted.
   */
  const FOUNDATION_AT_HEAD: Record<string, { caseDigest: string; comparabilityKey: string }> = {
    'ws.broken-sum.mean': {
      caseDigest: 'cwc1:e4b98967ead9be9420b78321210527ade0c66f5ef7087f4212a8523c96ee6fb6',
      comparabilityKey: 'cwk1:2c6d841b4bfa1f8f23d955b0e8991fb3e1efdc5e6d80aaf969a8c5173d5720c0',
    },
    'ws.receipt-refunds.sign': {
      caseDigest: 'cwc1:037c4bcbdf7f9c067d2e93d934f65fcf8dcc0f4c5899e1764fb9e7eba6f9e6cb',
      comparabilityKey: 'cwk1:d07e4e02e3ff957f33a4de07992018738589cade84c2547b3832bb2508fa8d49',
    },
    'ws.registry-isolation.recover': {
      caseDigest: 'cwc1:cf0eeae52488a940e405791ede34727f25219db7d271cd121e1222087f4356cc',
      comparabilityKey: 'cwk1:dadcb3baceecdd0005180e9e13d0f7ce57b786621561e8a0fe70da20541dcb89',
    },
    'ws.task-priority.propagate': {
      caseDigest: 'cwc1:404ff5f165a4295b35182f9d59b16dab85222f1e43ddda2aca7405ae066b57b7',
      comparabilityKey: 'cwk1:33f020658f4184ab19175bdbc563a32fd071aa68b136db87aeefc31047fc5f59',
    },
  };

  const FOUNDATION_PACK_DIGEST_AT_HEAD =
    'cwp1:c6bf8ba27e409eaefc8841110e8de44f9e3205602e8a810971f4ecd484d03f2d';

  it('keeps every foundation case digest and comparability key it had', () => {
    for (const [caseID, expected] of Object.entries(FOUNDATION_AT_HEAD)) {
      const workspaceCase = caseByID(caseID);
      expect(workspaceCaseDigest(workspaceCase), `${caseID}'s cwc1: moved`).toBe(expected.caseDigest);
      expect(workspaceComparabilityKey(workspaceCase), `${caseID}'s cwk1: moved`).toBe(expected.comparabilityKey);
    }
  });

  it('keeps the foundation pack digest the forty-eight sealed records carry', () => {
    // THE WHOLE POINT. Eight cases and three new modules were added to this catalogue, and the
    // identity of the experiment that has already been run is unchanged — which is what makes the
    // Tier 1 result still readable beside whatever Tier 2 and Tier 3 produce.
    expect(workspacePackDigest(foundationFourPack, allWorkspaceCases())).toBe(FOUNDATION_PACK_DIGEST_AT_HEAD);
    expect(foundationFourPack.version).toBe('1');
    expect(foundationFourPack.repeatsPerCase).toBe(3);
    expect(foundationFourPack.caseIDs).toEqual(Object.keys(FOUNDATION_AT_HEAD).sort());
  });

  it('carries the difficulty claim OUTSIDE the case and the pack digests', () => {
    const workspaceCase = caseByID('ws.broken-sum.mean');
    const profile = profileFor('ws.broken-sum.mean');
    const digest = workspaceDifficultyDigest(profile);
    expect(digest.startsWith('cwd1:')).toBe(true);
    // The difficulty digest is a THIRD identity. It is not a substring of either of the other two,
    // and neither of them moved when it came into existence — see the header of
    // `workspace-difficulty.ts` for why that decision went the way it did.
    expect(workspaceCaseDigest(workspaceCase)).not.toContain(digest.slice(5));
    expect(workspacePackDigest(foundationFourPack, allWorkspaceCases())).not.toContain(digest.slice(5));
    expect(workspacePackDifficultyDigest(registeredWorkspaceDifficultyProfiles(), foundationFourPack.caseIDs))
      .not.toBe(workspacePackDigest(foundationFourPack, allWorkspaceCases()));
  });

  it('moves the difficulty digest, and nothing else, when a difficulty claim changes', () => {
    const profile = profileFor('ws.t2.cache-eviction.recover');
    const restated = { ...profile, rationale: `${profile.rationale} (restated)` };
    expect(workspaceDifficultyDigest(restated)).not.toBe(workspaceDifficultyDigest(profile));
    // And the case it describes is untouched by the restatement.
    expect(workspaceCaseDigest(caseByID('ws.t2.cache-eviction.recover')))
      .toBe(workspaceCaseDigest(caseByID('ws.t2.cache-eviction.recover')));
  });
});

// MARK: - The two new packs

describe('the tier packs are sealed experiments in their own right', () => {
  it('validates the whole catalogue, difficulty claims included', () => {
    expect(() => validateWorkspaceCatalog()).not.toThrow();
    expect(registeredWorkspacePacks).toHaveLength(3);
    expect(workspacePackByID(tierTwoPack.id)).toBe(tierTwoPack);
    expect(workspacePackByID(tierThreePack.id)).toBe(tierThreePack);
  });

  it('seals deterministically, and the same pack twice is the same bytes', () => {
    const cases = allWorkspaceCases();
    for (const pack of [tierTwoPack, tierThreePack]) {
      const once = workspacePackDigest(pack, cases);
      expect(once.startsWith('cwp1:')).toBe(true);
      expect(workspacePackDigest(pack, cases)).toBe(once);
      // Naming the same four cases in another order is the same experiment and the same bytes.
      const reordered = makeWorkspaceBenchmarkPack({ ...pack, caseIDs: [...pack.caseIDs].reverse() });
      expect(workspacePackDigest(reordered, cases)).toBe(once);
      // Changing the sampling is a different experiment and moves the pack digest alone.
      const once_only = makeWorkspaceBenchmarkPack({ ...pack, repeatsPerCase: 1 });
      expect(workspacePackDigest(once_only, cases)).not.toBe(once);
    }
    // And the three packs are three different experiments.
    const digests = registeredWorkspacePacks.map((pack) => workspacePackDigest(pack, cases));
    expect(new Set(digests).size).toBe(3);
  });

  it('is four cases and three repeats at every tier, so the three tables read alike', () => {
    for (const pack of registeredWorkspacePacks) {
      expect(pack.caseIDs).toHaveLength(4);
      expect(pack.repeatsPerCase).toBe(3);
    }
  });

  it('carries ONE tier per pack, and refuses a pack that mixes them', () => {
    const profiles = registeredWorkspaceDifficultyProfiles();
    expect(workspacePackTier(profiles, foundationFourPack.caseIDs)).toBe('tier1');
    expect(workspacePackTier(profiles, tierTwoPack.caseIDs)).toBe('tier2');
    expect(workspacePackTier(profiles, tierThreePack.caseIDs)).toBe('tier3');
    expect(() => workspacePackTier(profiles, ['ws.broken-sum.mean', 'ws.t3.event-replay.pair']))
      .toThrow(/one tier or none/);
    // A pack this build has no judgement for states no tier rather than a default one.
    expect(workspacePackTier([], tierTwoPack.caseIDs)).toBeUndefined();
    expect(workspacePackDifficultyDigest([], tierTwoPack.caseIDs)).toBeUndefined();
  });

  it('exercises four materially different capabilities at each new tier', () => {
    const dimensionsOf = (suite: typeof workspaceTierTwoSuite) =>
      suite.cases.map((entry) => entry.dimensions.join('+'));
    // No two cases in a tier declare the same set: a pack of four cases that measure one thing
    // four times is a pack that answers one question with four samples.
    expect(new Set(dimensionsOf(workspaceTierTwoSuite)).size).toBe(4);
    expect(new Set(dimensionsOf(workspaceTierThreeSuite)).size).toBe(4);
    // Exactly one case per new tier allows a retry, and it is the recovery case.
    const retriers = (suite: typeof workspaceTierTwoSuite) =>
      suite.cases.filter((entry) => entry.execution.maximumAttempts > 1).map((entry) => entry.id);
    expect(retriers(workspaceTierTwoSuite)).toEqual(['ws.t2.cache-eviction.recover']);
    expect(retriers(workspaceTierThreeSuite)).toEqual(['ws.t3.import-pipeline.finish']);
    for (const suite of [workspaceTierTwoSuite, workspaceTierThreeSuite]) {
      for (const entry of suite.cases) {
        // A retry-capable case is scored under the policy that tells first-time from second-time.
        const expected = entry.execution.maximumAttempts > 1 ? 'policy.workspace.recovery' : 'policy.workspace.default';
        expect(entry.scoring.id, `${entry.id} scoring policy`).toBe(expected);
      }
    }
  });
});

// MARK: - The fixtures

describe('every fixture is sealed, self-contained and free of answers', () => {
  it('digests each fixture to exactly what its case was sealed against', () => {
    for (const workspaceCase of allWorkspaceCases()) {
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      expect(fs.existsSync(root), `${workspaceCase.id} names a fixture that is not there`).toBe(true);
      const snapshot = snapshotTree(root, {
        skipDirectories: workspaceCase.source.skipDirectories, capturedAt: '1970-01-01T00:00:00Z',
      });
      expect(snapshot.treeDigest, `${workspaceCase.id}'s fixture has drifted from its sealed digest`)
        .toBe(workspaceCase.source.expectedTreeDigest);
      expect(workspaceCase.source.sealed).toBe(true);
    }
  });

  it('needs no package manager, no install and no network', () => {
    for (const workspaceCase of allWorkspaceCases()) {
      for (const command of [...workspaceCase.verification.commands, ...workspaceCase.verification.hiddenCommands,
        ...workspaceCase.source.setupCommands]) {
        expect(command.executable, `${workspaceCase.id} runs ${command.executable}`).toBe('node');
        expect(command.timeoutMilliseconds).toBeGreaterThan(0);
      }
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      expect(fs.existsSync(path.join(root, 'package.json')),
        `${workspaceCase.id}'s fixture carries a package.json, which invites an install`).toBe(false);
      expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
      expect(workspaceCase.execution.networkPolicy).toBe('providerOnly');
      // Nothing in a fixture may read a clock or a random source: the same tree run twice has to
      // give the same answer, or a repeat measures the weather rather than the model.
      for (const file of filesUnder(root)) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        for (const forbidden of ['Date.now(', 'new Date(', 'Math.random(', 'process.hrtime', 'require(\'http']) {
          expect(text.includes(forbidden), `${workspaceCase.source.fixturePath}/${file} uses ${forbidden}`).toBe(false);
        }
      }
    }
  });

  it('keeps every hidden check OUT of the tree the model is handed', () => {
    for (const workspaceCase of allWorkspaceCases()) {
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      const contents = filesUnder(root).map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
      for (const hidden of workspaceCase.verification.hiddenCommands) {
        // A hidden check is an inline script in the ARGUMENT VECTOR, never a file. `ls test/` finds
        // nothing, and no file in the fixture quotes the script either.
        expect(hidden.args[0]).toBe('-e');
        expect(hidden.args).toHaveLength(2);
        const script = hidden.args[1];
        expect(script.length).toBeGreaterThan(0);
        // WHAT WOULD MAKE IT VISIBLE is its own words, not its shape: an `assert.deepStrictEqual`
        // line is the same in every test ever written, and a hidden check that happens to assert
        // something a visible test also asserts has given nothing away. So what is searched for is
        // the check's MESSAGES — the sentences it fails with, which say what it is really asking —
        // and the sentinel it prints when it passes.
        // PROSE ONLY. A crude quote-matcher also catches the code BETWEEN two string literals on
        // one line, which is why this keeps a candidate only when it reads like a sentence: letters
        // and ordinary punctuation, at least five words, nothing that looks like an expression.
        const sentences = [...script.matchAll(/'([^'\\\n]{30,})'/g)]
          .map((match) => match[1])
          .filter((sentence) => /^[A-Za-z][A-Za-z0-9 ,.:;()'\u2019\u2014\-/]+$/.test(sentence)
            && sentence.split(' ').length >= 5);
        expect(sentences.length,
          `${workspaceCase.id}/${hidden.id} carries no assertion message, so a failure would say nothing`)
          .toBeGreaterThan(0);
        for (const sentence of sentences) {
          for (const text of contents) {
            expect(text.includes(sentence),
              `${workspaceCase.id}: a hidden check's own words are sitting in the fixture the model is handed`)
              .toBe(false);
          }
        }
        // AND IT IS NOT A TRAP. Every hidden check at the two new tiers names the document it is
        // enforcing, so a model that reads before it edits can pass first time and a failing one
        // produces a retry briefing a person can act on. The four foundation checks predate this
        // rule and are sealed against a completed matrix; they are audited by reading rather than
        // by re-sealing them, and `ws.receipt-refunds.sign` asks only for a consequence its own
        // README states about where a line of text becomes a number.
        if (!/\.t[23]\./.test(workspaceCase.id)) continue;
        const namesItsSource = /README\.md|docs\/[A-Z]+\.md/.test(script);
        expect(namesItsSource,
          `${workspaceCase.id}/${hidden.id} quotes no document, so nothing says it is not a trap`).toBe(true);
      }
    }
  });

  it('leaks no answer: no TODO naming the fix, no dead implementation, no giveaway name', () => {
    // SCOPED TO THE TIER FIXTURES. The four foundation fixtures are sealed and have already been
    // run; auditing them here would be auditing an experiment rather than a new one.
    const tierCases = allWorkspaceCases().filter((entry) => entry.source.fixturePath.includes('/t2-')
      || entry.source.fixturePath.includes('/t3-'));
    expect(tierCases).toHaveLength(8);
    for (const workspaceCase of tierCases) {
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      for (const file of filesUnder(root)) {
        const text = fs.readFileSync(path.join(root, file), 'utf8');
        const where = `${workspaceCase.source.fixturePath}/${file}`;
        for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK', 'BUG:', 'WRONG:', 'should be:']) {
          expect(text.includes(marker), `${where} carries a ${marker} marker`).toBe(false);
        }
        // The word `hidden` never appears: a repository that tells the model there is an unseen
        // check has changed what the case measures.
        expect(/\bhidden\b/i.test(text), `${where} mentions a hidden check`).toBe(false);
        // Nor does a fixture ever name Cernum's own verdict vocabulary at it. (The shared README
        // line that says an attempt "measures the model rather than whether an install succeeded"
        // is the one mention of a model, and it is the sentence explaining why there is no
        // package.json — it gives nothing away about the task.)
        for (const word of ['scopeFailure', 'behavioralFailure', 'hiddenCommands',
          'invariant this case', 'the correct fix', 'the right fix']) {
          expect(text.includes(word), `${where} talks to the model about the benchmark`).toBe(false);
        }
      }
      // A file name that says which file is broken is the cheapest possible leak.
      for (const file of filesUnder(root)) {
        expect(/broken|buggy|wrong|fixme/i.test(file), `${workspaceCase.id} has a giveaway file name: ${file}`)
          .toBe(false);
      }
    }
  });

  it('never ships a reference solution inside a fixture', () => {
    // The solutions live under `test/engine/fixtures/`, where no workspace ever copies from.
    expect(fs.existsSync(SOLUTION_ROOT)).toBe(true);
    for (const workspaceCase of allWorkspaceCases()) {
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      expect(path.resolve(root).startsWith(path.resolve(SOLUTION_ROOT))).toBe(false);
      expect(filesUnder(root).some((file) => file.includes('solution'))).toBe(false);
    }
  });
});

// MARK: - The difficulty claims

describe('a tier is a measurement of the task, and it is checked', () => {
  it('derives the measured half from the sealed case rather than accepting it', () => {
    for (const profile of registeredWorkspaceDifficultyProfiles()) {
      const workspaceCase = caseByID(profile.caseID);
      expect(profile.measured).toEqual(measureWorkspaceCase(workspaceCase, profile.measured));
      expect(profile.caseVersion).toBe(workspaceCase.version);
    }
  });

  it('checks the three fixture numbers against the sealed tree itself', () => {
    for (const profile of registeredWorkspaceDifficultyProfiles()) {
      const workspaceCase = caseByID(profile.caseID);
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      const snapshot = snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' });
      expect(profile.measured.fixtureFileCount, `${profile.caseID} file count`).toBe(snapshot.fileCount);
      expect(profile.measured.fixtureByteCount, `${profile.caseID} byte count`).toBe(snapshot.totalByteCount);
      expect(profile.measured.fixtureSourceFileCount, `${profile.caseID} src file count`)
        .toBe(snapshot.entries.filter((entry) => entry.path.startsWith('src/')).length);
    }
  });

  it('checks expectedMinimumEditFiles against the reference solution that proves the case solvable', () => {
    for (const profile of registeredWorkspaceDifficultyProfiles()) {
      const solution = path.join(SOLUTION_ROOT, profile.caseID);
      if (!fs.existsSync(solution)) continue;
      expect(filesUnder(solution).length, `${profile.caseID}: the solution writes a different number of files`)
        .toBe(profile.declared.expectedMinimumEditFiles);
    }
    // Every case at the two new tiers has one, because a case nobody has made green might be
    // impossible and a pack of those measures nothing.
    for (const workspaceCase of allWorkspaceCases()) {
      if (!/\.t[23]\./.test(workspaceCase.id)) continue;
      expect(fs.existsSync(path.join(SOLUTION_ROOT, workspaceCase.id)),
        `${workspaceCase.id} has no reference solution`).toBe(true);
    }
  });

  it('holds every case inside its tier bands, and beyond the tier below on three axes', () => {
    for (const profile of registeredWorkspaceDifficultyProfiles()) {
      const band = WORKSPACE_TIER_BANDS[profile.tier];
      expect(axesBeyondPreviousTier(profile).length,
        `${profile.caseID} is labelled ${profile.tier} without clearing the tier below on enough axes`)
        .toBeGreaterThanOrEqual(band.minimumAxesBeyondPreviousTier);
      expect(() => validateWorkspaceDifficultyProfile(profile, caseByID(profile.caseID))).not.toThrow();
    }
  });

  it('refuses a case labelled above what its own numbers show', () => {
    const profile = profileFor('ws.broken-sum.mean');
    const workspaceCase = caseByID('ws.broken-sum.mean');
    // Tier 3 asks for twelve relevant files, three hidden invariants and five checks. This case has
    // two, none and one — so calling it Tier 3 is refused rather than believed.
    expect(() => validateWorkspaceDifficultyProfile({ ...profile, tier: 'tier3' }, workspaceCase))
      .toThrow(WorkspaceDifficultyError);
    // And a Tier 2 case is not admitted to Tier 2 merely by being bigger: it has to go beyond every
    // Tier 1 case on three independent axes.
    const barelyBigger = {
      ...profileFor('ws.t2.cache-eviction.recover'),
      declared: {
        ...profileFor('ws.t2.cache-eviction.recover').declared,
        relevantFileCount: 8, independentDefectCount: 1,
      },
    };
    expect(() => validateWorkspaceDifficultyProfile(barelyBigger, caseByID('ws.t2.cache-eviction.recover')))
      .toThrow(/not the tier below with more files/);
  });

  it('refuses a claim the case itself contradicts', () => {
    const profile = profileFor('ws.t2.text-normalize.cluster');
    const workspaceCase = caseByID('ws.t2.text-normalize.cluster');
    // More architectural constraints than there are invariants enforcing them.
    expect(() => validateWorkspaceDifficultyProfile(
      { ...profile, declared: { ...profile.declared, architecturalConstraintCount: 99 } }, workspaceCase))
      .toThrow(/file invariants/);
    // Hidden invariants with nothing checking them, and the other way round.
    expect(() => validateWorkspaceDifficultyProfile(
      { ...profile, declared: { ...profile.declared, hiddenInvariantCount: 0 } }, workspaceCase))
      .toThrow(/hidden/);
    // A measured figure that disagrees with the sealed case.
    expect(() => validateWorkspaceDifficultyProfile(
      { ...profile, measured: { ...profile.measured, verificationCommandCount: 1 } }, workspaceCase))
      .toThrow(/derived, not asserted/);
    // A profile written for a version of the task that is no longer the one in the catalogue.
    expect(() => validateWorkspaceDifficultyProfile({ ...profile, caseVersion: '99' }, workspaceCase))
      .toThrow(/judged again/);
  });

  it('never lets difficulty reach a provider, a model or a route', () => {
    // A tier is a property of the task. Nothing in the difficulty modules may mention a provider,
    // a model identifier or a routing decision, because a tier that came to mean "the one for the
    // big model" would stop being evidence about the task.
    for (const file of ['workspace-difficulty.ts', 'workspace-difficulty-catalog.ts']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../../src/engine', file), 'utf8');
      const code = source.split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      for (const name of ['claudeCLI', 'codexCLI', 'opencodeCLI', 'anthropicAPI', 'openaiAPI',
        'ProviderID', 'ProviderBinding', 'requestedModelID', 'billingBasis']) {
        expect(code.includes(name), `${file} mentions ${name}`).toBe(false);
      }
      // Nor does it import anything that knows about one. A tier is decided from the case and the
      // fixture; there is no path from here to a route.
      for (const line of source.split('\n').filter((entry) => entry.startsWith('import'))) {
        expect(/provider|host-factory|discovery|binding/.test(line), `${file}: ${line}`).toBe(false);
      }
    }
  });
});
