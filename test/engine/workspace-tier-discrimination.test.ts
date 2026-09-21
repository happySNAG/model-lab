// The eight tier cases, proven to DISCRIMINATE — without a frontier model.
//
// WHAT A CASE HAS TO SURVIVE BEFORE IT IS WORTH SPENDING AN EVENING ON. A workspace case is an
// assertion about what a model's work looks like, and an unproven one is an assertion about
// nothing. Four ways a case can be worthless, and all four are cheap mistakes to make:
//
//   IT IS IMPOSSIBLE           nobody has ever made the fixture green, so the pack measures which
//                              model gets closest to a thing that cannot be done.
//   IT IS FREE                 the suite passes on an empty change, or the forbidden list is not
//                              enforced and the shortest path is to edit the test.
//   THE TRAP DOES NOT SPRING   the "plausible wrong answer" the case was built around quietly
//                              passes, so four models by three repeats measure the wrong thing.
//   THE TRAP IS THE WHOLE CASE the correct answer ALSO fails, because the hidden check asks for
//                              something the repository never said.
//
// So every case below is driven through the real runner, against the real sealed fixture, with real
// `node` verification, by scripted agents that write:
//
//   the reference solution       must PASS, and must pass the hidden checks too
//   no change at all             must NOT pass
//   an edit to a forbidden test  must be a scopeFailure, whatever else it achieved
//   one or two plausible WRONG   must fail — and the comment on each says WHICH check catches it,
//   answers                      because "it failed" is not evidence that the case discriminates
//
// And for the two recovery cases: right first time, wrong-then-recovered, and wrong twice all land
// where they should, with the retry briefing carrying the verification's own output and no advice.
//
// THE SOLUTIONS ARE FILES, NOT STRINGS IN THIS FILE. `test/engine/fixtures/workspace-solutions/`
// holds one directory per case; they are read here and written through the ordinary driver
// contract. A wrong answer is expressed as a small EDIT to the solution rather than as a second
// copy of it, so the two cannot drift apart and a reader can see exactly what makes it wrong.
//
// NO PROVIDER IS CONTACTED ANYWHERE IN THIS FILE.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { allWorkspaceCases } from '../../src/engine/workspace-catalog';
import { tierTwoPack, tierThreePack } from '../../src/engine/workspace-catalog';
import { WorkspaceCase } from '../../src/engine/workspace-case';
import {
  ScriptedAttempt, ScriptedStep, ScriptedWorkspaceAgent, WorkspaceAgentRequest, WorkspaceAgentResult,
} from '../../src/engine/workspace-agent';
import {
  CommandOutcome, InvariantOutcome, WorkspaceRunResult, runWorkspaceCase,
} from '../../src/engine/workspace-execution';
import { WorkspaceScorecard, scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { snapshotTree } from '../../src/engine/workspace-tree';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');
const SOLUTION_ROOT = path.resolve(__dirname, 'fixtures/workspace-solutions');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-ws-tier-'));
  temporaries.push(directory);
  return directory;
}

const caseByID = (id: string): WorkspaceCase => {
  const found = allWorkspaceCases().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no such workspace case: ${id}`);
  return found;
};

/**
 * A scripted agent that also keeps the text it was sent.
 *
 * The runner appends the retry briefing to `request.instruction` — see `WorkspaceAgentRequest` —
 * so recording what a driver actually received is how a test reads the briefing that reached
 * attempt 2 without reaching for a function the engine does not export.
 */
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
  /** The deciding attempt's visible checks. */
  visible: CommandOutcome[];
  /** The deciding attempt's hidden checks. */
  hidden: CommandOutcome[];
  invariants: InvariantOutcome[];
}

/** One case, one scripted agent, the real sealed fixture and real `node` verification. */
async function score(workspaceCase: WorkspaceCase, attempts: ScriptedAttempt[]): Promise<Scored> {
  const agent = new RecordingScriptedAgent(attempts);
  const result = await runWorkspaceCase({
    case: workspaceCase,
    driver: agent,
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary(),
  });
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

const outcome = (outcomes: CommandOutcome[], id: string): CommandOutcome | undefined =>
  outcomes.find((entry) => entry.commandID === id);

const failedIDs = (outcomes: CommandOutcome[]): string[] =>
  outcomes.filter((entry) => !entry.passed).map((entry) => entry.commandID);

const unsatisfied = (outcomes: InvariantOutcome[]): InvariantOutcome[] =>
  outcomes.filter((entry) => !entry.satisfied);

/**
 * The reference solution's file writes, optionally mangled.
 *
 * `edit` returns the contents to write, or `undefined` to leave that file out of the answer
 * entirely — which is how a PARTIAL answer is expressed. Every mangling is checked for having
 * actually applied: a `replace` that silently matched nothing would turn a "wrong answer must fail"
 * test into a second copy of the "correct answer must pass" one.
 */
function solutionWrites(
  caseID: string, edit?: (filePath: string, contents: string) => string | undefined,
): ScriptedStep[] {
  const root = path.join(SOLUTION_ROOT, caseID);
  if (!fs.existsSync(root)) throw new Error(`no reference solution for ${caseID}`);
  const files = snapshotTree(root, { capturedAt: '1970-01-01T00:00:00Z' }).entries.map((entry) => entry.path);
  const steps: ScriptedStep[] = [];
  for (const file of files) {
    const original = fs.readFileSync(path.join(root, file), 'utf8');
    const contents = edit === undefined ? original : edit(file, original);
    if (contents === undefined) continue;
    steps.push({ do: 'write', path: file, contents });
  }
  return steps;
}

/** A replacement that must have applied. Used by every wrong answer below. */
function mangled(contents: string, from: string, to: string): string {
  if (!contents.includes(from)) throw new Error(`the mangling no longer matches the solution: ${from}`);
  return contents.split(from).join(to);
}

const attempt = (steps: ScriptedStep[], finalMessage: string): ScriptedAttempt => ({ steps, finalMessage });

const solves = (caseID: string, message = 'Done.'): ScriptedAttempt =>
  attempt(solutionWrites(caseID), message);

const CHANGES_NOTHING: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'I have read the repository and everything looks correct to me.' }],
  finalMessage: 'No change was needed.',
};

/** The shortest path to a green run on every one of these cases, and it is a scope failure. */
function editsAForbiddenTest(workspaceCase: WorkspaceCase): ScriptedAttempt {
  const firstTest = workspaceCase.verification.commands[0].args[0];
  return attempt([{ do: 'write', path: firstTest, contents: '// deleted the assertions\nprocess.exit(0);\n' }],
    'I adjusted the test.');
}

const TIER_CASE_IDS = [...tierTwoPack.caseIDs, ...tierThreePack.caseIDs];

// MARK: - What every tier case owes, whatever else it measures

describe('every tier case is solvable, is not free, and enforces its own forbidden list', () => {
  it.each(TIER_CASE_IDS)('%s · the reference solution passes, hidden checks included', async (caseID) => {
    const run = await score(caseByID(caseID), [solves(caseID)]);
    expect(run.card.status, `${caseID} is not solvable by its own reference solution: ${run.card.detail}`)
      .toBe('pass');
    // EVERY check, not just the visible ones. A solution that passed the suites and failed a hidden
    // check would mean the hidden check asks for something the repository never stated.
    for (const entry of [...run.visible, ...run.hidden]) {
      expect(entry.passed, `${caseID}: ${entry.commandID} failed for the correct answer`).toBe(true);
    }
    expect(unsatisfied(run.invariants)).toEqual([]);
    expect(run.card.regressionCount).toBe(0);
  }, 120_000);

  it.each(TIER_CASE_IDS)('%s · changing nothing does not pass', async (caseID) => {
    const run = await score(caseByID(caseID), [CHANGES_NOTHING, CHANGES_NOTHING]);
    expect(run.card.status).not.toBe('pass');
    // And announcing that it is done changes nothing about that.
    expect(run.card.detail.length).toBeGreaterThan(0);
    expect(run.card.changedFileCount).toBe(0);
  }, 120_000);

  it.each(TIER_CASE_IDS)('%s · editing a forbidden test is a scope failure, not a pass', async (caseID) => {
    const workspaceCase = caseByID(caseID);
    const run = await score(workspaceCase, [editsAForbiddenTest(workspaceCase), editsAForbiddenTest(workspaceCase)]);
    expect(run.card.status).toBe('scopeFailure');
  }, 120_000);
});

// MARK: - Tier 2 · the traps, one case at a time

describe('ws.t2.ledger-currency.propagate separates a whole answer from most of one', () => {
  const CASE = 'ws.t2.ledger-currency.propagate';

  it('fails a partial answer that changes the model and stops', async () => {
    // Entry and journal only: the wire format, the rendering and the public surface are untouched,
    // and three of the five visible suites stay red. CAUGHT BY: the visible suites.
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => (file === 'src/entry.js' || file === 'src/journal.js' ? contents : undefined)),
      'I added the currency to the model.')]);
    expect(run.card.status).toBe('behavioralFailure');
    const failed = failedIDs(run.visible);
    expect(failed).toEqual(expect.arrayContaining(['wire-tests', 'report-tests', 'api-tests']));
  }, 120_000);

  it('fails an answer whose reader builds an entry instead of asking the model to', async () => {
    // The common shortcut: `fromWire` assembles the object itself rather than going through
    // `createEntry`, so a record written before the field existed reads back with no currency at
    // all. Every visible suite passes, because the visible wire test only round-trips a record that
    // HAS the key. CAUGHT BY: the hidden legacy-record check, which is why docs/FORMAT.md says what
    // reading an old record must give you.
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => (file !== 'src/wire.js' ? contents
        : mangled(contents,
          '  return createEntry({\n'
          + '    id: record.i,\n'
          + '    description: record.d,\n'
          + '    amountCents: record.a,\n'
          + '    currency: record.c === undefined ? defaultCurrency() : record.c,\n'
          + '  });',
          '  return {\n'
          + '    id: record.i,\n'
          + '    description: record.d,\n'
          + '    amountCents: record.a,\n'
          + '    currency: record.c,\n'
          + '  };'))),
      'Done.')]);
    expect(run.visible.every((entry) => entry.passed), 'every visible suite should still pass').toBe(true);
    expect(outcome(run.hidden, 'legacy-record')?.passed).toBe(false);
    expect(run.card.status).toBe('behavioralFailure');
  }, 120_000);

  it('fails an answer that sums a journal it has no business summing', async () => {
    // docs/API.md says a mixed journal has NO total. Answering with a number is the failure mode
    // the document exists to forbid, and no visible suite ever mixes currencies.
    // CAUGHT BY: the hidden totalling-is-total check.
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => (file !== 'src/journal.js' ? contents
        : mangled(contents,
          `      throw new RangeError(\`a journal that mixes \${currency} and \${entry.currency} has no total\`);`,
          '      continue;'))),
      'Done.')]);
    expect(run.visible.every((entry) => entry.passed)).toBe(true);
    expect(outcome(run.hidden, 'totalling-is-total')?.passed).toBe(false);
  }, 120_000);
});

describe('ws.t2.schedule-window.diagnose separates a diagnosis from a symptom fix', () => {
  const CASE = 'ws.t2.schedule-window.diagnose';

  it('fails the fix at the module the failure points at', async () => {
    // The first thing anyone reaches for: make `intervalsOverlap` allow for the extra minute. The
    // conflict report goes green and every booking still runs a minute too long.
    // CAUGHT BY: test/agenda.test.js, in plain sight.
    const run = await score(caseByID(CASE), [attempt([{
      do: 'write',
      path: 'src/overlap.js',
      contents: fs.readFileSync(path.join(FIXTURE_ROOT, 'workspace/t2-schedule-window/src/overlap.js'), 'utf8')
        .replace('return a.startMinute < b.endMinute && b.startMinute < a.endMinute;',
          'return a.startMinute < b.endMinute - 1 && b.startMinute < a.endMinute - 1;'),
    }], 'Fixed the overlap comparison.')]);
    expect(run.card.status).toBe('behavioralFailure');
    expect(outcome(run.visible, 'agenda-tests')?.passed).toBe(false);
  }, 120_000);

  it('fails the fix that works around the module that is actually wrong', async () => {
    // Compute the window inside `interval.js` and stop asking `duration.js`. Every visible suite
    // passes and `minutesBetween` — which README.md calls the one place a duration is worked out,
    // and which the public API exports — still answers 61 for an hour.
    // CAUGHT BY: the hidden one-duration check AND the invariant on src/interval.js.
    const run = await score(caseByID(CASE), [attempt([{
      do: 'write',
      path: 'src/interval.js',
      contents: fs.readFileSync(path.join(FIXTURE_ROOT, 'workspace/t2-schedule-window/src/interval.js'), 'utf8')
        .replace("const { minutesBetween } = require('./duration.js');", '')
        .replace('const minutes = minutesBetween(startMinute, parseClock(endText));',
          'const minutes = parseClock(endText) - startMinute;'),
    }], 'Fixed the interval length.')]);
    expect(run.visible.every((entry) => entry.passed), 'the visible suites should be green').toBe(true);
    expect(outcome(run.hidden, 'one-duration')?.passed).toBe(false);
    expect(unsatisfied(run.invariants).length).toBeGreaterThan(0);
    expect(run.card.status).toBe('behavioralFailure');
  }, 120_000);
});

describe('ws.t2.text-normalize.cluster separates one cause from three symptoms', () => {
  const CASE = 'ws.t2.text-normalize.cluster';

  it('fails a fold hand-fitted to the letters the visible tests happen to use', async () => {
    // A table covering exactly the letters in the three failing suites. All three go green, and
    // docs/FOLDING.md said the table in the tree is the complete one.
    // CAUGHT BY: the hidden every-letter-survives check, which walks LETTER_FOLDS itself.
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (_file, contents) => mangled(contents,
        '  const substituted = Array.from(String(text))\n'
        + '    .map((character) => (Object.prototype.hasOwnProperty.call(LETTER_FOLDS, character)\n'
        + '      ? LETTER_FOLDS[character] : character))\n'
        + '    .join(\'\');',
        "  const JUST_THESE = { '\\u00f8': 'o', '\\u00d8': 'O', '\\u00df': 'ss', '\\u0141': 'L', '\\u00c6': 'AE' };\n"
        + '  const substituted = Array.from(String(text))\n'
        + '    .map((character) => (Object.prototype.hasOwnProperty.call(JUST_THESE, character)\n'
        + '      ? JUST_THESE[character] : character))\n'
        + "    .join('');")),
      'Folding fixed.')]);
    expect(run.visible.every((entry) => entry.passed), 'the three suites should be green').toBe(true);
    expect(outcome(run.hidden, 'every-letter-survives')?.passed).toBe(false);
  }, 120_000);

  it('refuses an answer that patches the three consumers instead of the one cause', async () => {
    // Three files changed against a two-file ceiling, and the fourth consumer — which nothing
    // visible tests — is still broken. CAUGHT BY: the change ceiling and the hidden initials check.
    const source = (file: string) =>
      fs.readFileSync(path.join(FIXTURE_ROOT, 'workspace/t2-text-normalize/src', file), 'utf8');
    const PATCH_HERE = "\n  .replace(/[\\u00f8]/g, 'o').replace(/[\\u00d8]/g, 'O')";
    const run = await score(caseByID(CASE), [attempt([
      { do: 'write', path: 'src/slug.js', contents: `${source('slug.js')}${PATCH_HERE}` },
      { do: 'write', path: 'src/search.js', contents: `${source('search.js')}${PATCH_HERE}` },
      { do: 'write', path: 'src/sortkey.js', contents: `${source('sortkey.js')}${PATCH_HERE}` },
    ], 'Patched each consumer.')]);
    expect(run.card.status).not.toBe('pass');
  }, 120_000);
});

describe('ws.t2.cache-eviction.recover separates a read from a look', () => {
  const CASE = 'ws.t2.cache-eviction.recover';

  /** The trap: refresh recency where the entry is already in hand — which `peek` goes through too. */
  const TRAP = (): ScriptedAttempt => attempt(
    solutionWrites(CASE, (_file, contents) => mangled(
      mangled(contents, '  recordHit(cache.stats);\n  touch(cache, entry);\n', '  recordHit(cache.stats);\n'),
      '    return undefined;\n  }\n  return entry;\n}',
      '    return undefined;\n  }\n  touch(cache, entry);\n  return entry;\n}')),
    'Reading a key now refreshes it.');

  it('lets the trap pass every visible check and fails it on the contract', async () => {
    const run = await score(caseByID(CASE), [TRAP(), TRAP()]);
    expect(run.visible.every((entry) => entry.passed), 'every visible suite should be green').toBe(true);
    expect(outcome(run.hidden, 'peek-is-not-a-use')?.passed).toBe(false);
    expect(run.card.status).toBe('behavioralFailure');
    // WRONG TWICE is a failure after two attempts, not a pass and not a recovery.
    expect(run.card.attemptsUsed).toBe(2);
    expect(run.card.retriesRequired === 0).toBe(false);
  }, 180_000);

  it('records a first-time pass as a first-time pass', async () => {
    const run = await score(caseByID(CASE), [solves(CASE)]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(1);
    expect(run.card.retriesRequired === 0).toBe(true);
  }, 120_000);

  it('recovers on the second attempt when the first was the trap, and says which it was', async () => {
    const run = await score(caseByID(CASE), [TRAP(), solves(CASE, 'Moved the refresh out of the shared read.')]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(2);
    // A pass on attempt 2 is NOT a first-attempt pass, and the recovery-weighted policy is what
    // makes the two land at visibly different scores rather than within a rounding error.
    expect(run.card.retriesRequired === 0).toBe(false);
    expect(run.card.scoringPolicyID).toBe('policy.workspace.recovery');
  }, 180_000);
});

// MARK: - Tier 3 · the traps, one case at a time

describe('ws.t3.permission-gate.centralize separates a boundary from a patched caller', () => {
  const CASE = 'ws.t3.permission-gate.centralize';

  it('fails the answer that adds the missing check to the handler that leaks', async () => {
    // It fixes the reported symptom and passes every behaviour test in the repository. There is no
    // boundary, so the module the architecture names does not exist.
    // CAUGHT BY: test/policy.test.js, the file invariants, and all three hidden checks.
    const handler = fs.readFileSync(
      path.join(FIXTURE_ROOT, 'workspace/t3-permission-gate/src/handlers/export.js'), 'utf8');
    const run = await score(caseByID(CASE), [attempt([{
      do: 'write',
      path: 'src/handlers/export.js',
      contents: handler
        .replace("const { renderDocument } = require('../render.js');",
          "const { renderDocument } = require('../render.js');\nconst { ForbiddenError } = require('../errors.js');")
        .replace('  const document = fetch(store, documentID);\n  return renderDocument(document);',
          "  const document = fetch(store, documentID);\n"
          + "  if (actor.role !== 'curator' && actor.role !== 'admin') {\n"
          + "    throw new ForbiddenError('export', actor.role, documentID);\n  }\n"
          + '  return renderDocument(document);'),
    }], 'Fixed the export leak.')]);
    expect(run.card.status).not.toBe('pass');
    expect(outcome(run.visible, 'policy-tests')?.passed).toBe(false);
    expect(unsatisfied(run.invariants).length).toBeGreaterThan(0);
  }, 120_000);

  it('fails a boundary that only answers for the actions the visible tests exercise', async () => {
    // The module exists, the handlers go through it, and `archive` — which nothing visible tests —
    // is let through for everybody. Every visible suite passes.
    // CAUGHT BY: the hidden authorize-is-total and every-handler-asks checks.
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => (file !== 'src/authz/roles.js' ? contents
        : mangled(contents,
          "  reader: ['read'],\n  writer: ['read', 'update'],",
          "  reader: ['read', 'archive'],\n  writer: ['read', 'update', 'archive'],"))),
      'The boundary is in place.')]);
    expect(run.visible.every((entry) => entry.passed), 'every visible suite should be green').toBe(true);
    expect(outcome(run.hidden, 'authorize-is-total')?.passed).toBe(false);
    expect(outcome(run.hidden, 'every-handler-asks')?.passed).toBe(false);
  }, 120_000);
});

describe('ws.t3.event-replay.pair separates two defects from one', () => {
  const CASE = 'ws.t3.event-replay.pair';

  it('fails an answer that fixes the ordering and stops', async () => {
    // `test/order.test.js` goes green and three suites stay red, which is exactly the shape that
    // makes stopping early feel like progress. CAUGHT BY: apply, replay and snapshot.
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => (file === 'src/order.js' ? contents : undefined)),
      'Fixed the comparator.')]);
    expect(run.card.status).toBe('behavioralFailure');
    expect(outcome(run.visible, 'order-tests')?.passed).toBe(true);
    expect(failedIDs(run.visible))
      .toEqual(expect.arrayContaining(['apply-tests', 'replay-tests', 'snapshot-tests']));
  }, 120_000);

  it('fails an answer that fixes the purity and stops', async () => {
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => (file === 'src/apply.js' ? contents : undefined)),
      'applyEvent no longer mutates.')]);
    expect(run.card.status).toBe('behavioralFailure');
    expect(outcome(run.visible, 'apply-tests')?.passed).toBe(true);
    expect(failedIDs(run.visible))
      .toEqual(expect.arrayContaining(['order-tests', 'replay-tests', 'snapshot-tests']));
  }, 120_000);
});

describe('ws.t3.validator-rules.refactor separates a migration from most of one', () => {
  const CASE = 'ws.t3.validator-rules.refactor';

  it('fails a migration that moved three rules of six', async () => {
    // The behaviour suites still pass, because the validator still answers correctly — it is a
    // driver over three rules plus a chain for the rest. CAUGHT BY: the registry suite and the
    // hidden rules-stand-alone check.
    const KEEP = ['src/rules/name-format.js', 'src/rules/replica-count.js', 'src/rules/port-range.js'];
    const run = await score(caseByID(CASE), [attempt(
      solutionWrites(CASE, (file, contents) => {
        if (file === 'src/rules/index.js') {
          return "'use strict';\n\nconst RULES = [\n"
            + KEEP.map((entry) => `  require('./${path.basename(entry)}'),\n`).join('')
            + ']);\n'.replace(']);', '];\n')
            + 'function listRules() { return RULES.map((rule) => rule.id); }\n\n'
            + 'module.exports = { RULES, listRules };\n';
        }
        if (file.startsWith('src/rules/') && !KEEP.includes(file)) return undefined;
        if (file === 'src/validate.js' || file === 'src/explain.js') return contents;
        return contents;
      }),
      'Migrated the first three rules.')]);
    expect(run.card.status).not.toBe('pass');
    expect(outcome(run.visible, 'registry-tests')?.passed).toBe(false);
  }, 120_000);

  it('fails an answer that keeps the chain and wraps it', async () => {
    // The six modules exist, the registry exists, the behaviour is byte-identical — and every
    // condition still lives in one file that the rules delegate to.
    // CAUGHT BY: the per-rule invariants, which say the module that owns a condition is the module
    // the condition is written in.
    const run = await score(caseByID(CASE), [attempt([
      ...solutionWrites(CASE, (file, contents) => (file.startsWith('src/rules/') && file !== 'src/rules/index.js'
        ? "'use strict';\n\n"
          + `const { chainErrors } = require('../chain.js');\n`
          + `const ID = '${path.basename(file, '.js')}';\n\n`
          + 'module.exports = {\n  id: ID,\n'
          + `  code: '${/code: '([A-Z_]+)'/.exec(contents)?.[1] ?? ''}',\n`
          + `  appliesTo: '${/appliesTo: '([a-z]+)'/.exec(contents)?.[1] ?? ''}',\n`
          + '  check(configuration) {\n'
          + '    return chainErrors(configuration).filter((error) => error.rule === ID);\n  },\n};\n'
        : contents)),
      {
        do: 'write',
        path: 'src/chain.js',
        contents: `'use strict';\n\n${
          fs.readFileSync(path.join(FIXTURE_ROOT, 'workspace/t3-validator-rules/src/validate.js'), 'utf8')
            .replace("'use strict';\n", '')
            .replace('function validate(configuration)', 'function chainErrors(configuration)')
            .replace('module.exports = { validate, isValid };', 'module.exports = { chainErrors };')
            .replace(/function isValid[\s\S]*?\n}\n/, '')}`,
      },
    ], 'Rules registry in place.')]);
    expect(run.card.status).not.toBe('pass');
    expect(unsatisfied(run.invariants).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('ws.t3.import-pipeline.finish separates finishing from nearly finishing', () => {
  const CASE = 'ws.t3.import-pipeline.finish';

  /** The plausible first answer: right about the key, wrong about what a blank cell means. */
  const REPLACES_INSTEAD_OF_MERGING = (): ScriptedAttempt => attempt(
    solutionWrites(CASE, (file, contents) => (file !== 'src/stages/dedupe.js' ? contents
      : mangled(contents,
        '    for (const field of type.fields) {\n'
        + '      if (!isBlank(record.fields[field])) already.fields[field] = record.fields[field];\n'
        + '    }',
        '    already.fields = { ...record.fields };'))),
    'Dedupe now uses the natural key, and later rows win.');

  it('lets the plausible first answer pass everything visible and fails it on the contract', async () => {
    const run = await score(caseByID(CASE), [REPLACES_INSTEAD_OF_MERGING(), REPLACES_INSTEAD_OF_MERGING()]);
    expect(run.visible.every((entry) => entry.passed), 'every visible suite should be green').toBe(true);
    expect(outcome(run.hidden, 'later-rows-add')?.passed).toBe(false);
    expect(run.card.status).toBe('behavioralFailure');
    expect(run.card.attemptsUsed).toBe(2);
  }, 180_000);

  it('recovers on the second attempt, and the briefing carries evidence rather than advice', async () => {
    const workspaceCase = caseByID(CASE);
    const run = await score(workspaceCase, [REPLACES_INSTEAD_OF_MERGING(), solves(CASE, 'Merged rather than replaced.')]);
    expect(run.card.status).toBe('pass');
    expect(run.card.attemptsUsed).toBe(2);
    expect(run.card.retriesRequired === 0).toBe(false);
    expect(run.card.scoringPolicyID).toBe('policy.workspace.recovery');
  }, 180_000);

  it('hands attempt two a briefing that quotes the check and proposes nothing', async () => {
    const run = await score(caseByID(CASE), [REPLACES_INSTEAD_OF_MERGING(), REPLACES_INSTEAD_OF_MERGING()]);
    expect(run.agent.instructions).toHaveLength(2);
    const [first, second] = run.agent.instructions;
    // ATTEMPT 2 WAS TOLD SOMETHING ATTEMPT 1 WAS NOT. Without this the case measures resampling.
    expect(second).not.toBe(first);
    expect(second.startsWith(first)).toBe(true);
    const briefing = second.slice(first.length);
    expect(briefing).toContain('ATTEMPT 1 OF THIS TASK DID NOT PASS');
    expect(briefing).toContain('FRESH COPY');
    // IT CARRIES THE CHECK'S OWN OUTPUT, verbatim, which is what makes the second attempt a model
    // reading a real failure report rather than a second roll of the dice.
    expect(briefing).toContain('later-rows-add failed');
    expect(briefing).toContain('a field the later row leaves blank does not win');
    // AND IT PROPOSES NOTHING. A briefing that named the file or suggested the change would measure
    // whether the model can follow an instruction this engine wrote.
    for (const advice of ['you should', 'instead of', 'src/stages/dedupe.js', 'isBlank', 'merge']) {
      expect(briefing.toLowerCase().includes(advice.toLowerCase()), `the briefing says "${advice}"`).toBe(false);
    }
  }, 180_000);
});
