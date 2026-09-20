// The four-case benchmark pack, proven without a frontier model.
//
// WHAT A CASE HAS TO SURVIVE BEFORE IT IS WORTH SPENDING ALLOWANCE ON. A workspace case is an
// assertion about what a model's work looks like, and an unproven one is an assertion about
// nothing: a case whose tests pass on an empty change measures nothing, a case whose forbidden list
// is not enforced measures whether a model will edit its own test, and a case whose "obvious wrong
// fix" quietly passes measures the wrong thing at four models by three repeats. So every case in
// the pack is driven here, through the real runner, against the real sealed fixture, with real
// `node` verification — and four scripted agents each:
//
//   the correct solution         must PASS
//   no change at all             must NOT pass
//   editing a forbidden test     must be a scopeFailure, whatever else it achieved
//   a plausible WRONG fix        must fail on behaviour, not on luck
//
// NO PROVIDER IS CONTACTED ANYWHERE IN THIS FILE. The driver is `ScriptedWorkspaceAgent`, which
// writes exactly what the test author says and nothing else; the verdict comes from the tree this
// engine snapshotted and the commands this engine ran.

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BROKEN_SUM_MEAN, RECEIPT_REFUNDS_SIGN, REGISTRY_ISOLATION_RECOVER, TASK_PRIORITY_PROPAGATE,
  allWorkspaceCases, foundationFourPack, validateWorkspaceCatalog, workspacePackByID,
} from '../../src/engine/workspace-catalog';
import {
  WorkspacePackError, makeWorkspaceBenchmarkPack, planWorkspaceRepeats, resolveWorkspacePack,
  validateWorkspaceBenchmarkPack, workspacePackDigest, workspaceRepeatGroupID,
} from '../../src/engine/workspace-pack';
import { WorkspaceCase, workspaceCaseDigest, workspaceInstructionText } from '../../src/engine/workspace-case';
import {
  ScriptedAttempt, ScriptedWorkspaceAgent, WorkspaceAgentDriver, WorkspaceAgentRequest, retryBriefingText,
} from '../../src/engine/workspace-agent';
import { runWorkspaceCase } from '../../src/engine/workspace-execution';
import { WorkspaceScorecard, scoreWorkspaceRun } from '../../src/engine/workspace-scoring';
import { snapshotTree } from '../../src/engine/workspace-tree';

const FIXTURE_ROOT = path.resolve(__dirname, '../../fixtures');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function temporary(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(directory);
  return directory;
}

/** One case, one scripted agent, the real fixture and real `node` verification. */
async function scoreScripted(workspaceCase: WorkspaceCase, attempts: ScriptedAttempt[],
                             driver?: WorkspaceAgentDriver): Promise<WorkspaceScorecard> {
  const result = await runWorkspaceCase({
    case: workspaceCase,
    driver: driver ?? new ScriptedWorkspaceAgent(attempts),
    fixtureRoot: FIXTURE_ROOT,
    sandboxRoot: temporary('cernum-ws-pack-'),
  });
  return scoreWorkspaceRun(workspaceCase, result);
}

const SAYS_NOTHING_CHANGES_NOTHING: ScriptedAttempt = {
  steps: [{ do: 'say', text: 'I have reviewed the repository and everything looks correct.' }],
  finalMessage: 'No change was needed.',
};

// MARK: - Fixture integrity

describe('every fixture in the pack is sealed, and the seal is checked against the tree on disk', () => {
  it('digests each fixture to exactly what its case was sealed against', () => {
    for (const workspaceCase of allWorkspaceCases()) {
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      expect(fs.existsSync(root), `${workspaceCase.id} names a fixture that is not there`).toBe(true);
      const snapshot = snapshotTree(root, {
        skipDirectories: workspaceCase.source.skipDirectories, capturedAt: '1970-01-01T00:00:00Z',
      });
      // THE WHOLE POINT OF SEALING. An edit to any fixture file moves this digest and fails HERE,
      // in a second, rather than at the fixture check three quarters of the way through a matrix.
      expect(snapshot.treeDigest, `${workspaceCase.id}'s fixture has drifted from its sealed digest`)
        .toBe(workspaceCase.source.expectedTreeDigest);
      expect(workspaceCase.source.sealed).toBe(true);
    }
  });

  it('keeps a fixture free of network, install and timestamp dependencies', () => {
    for (const workspaceCase of allWorkspaceCases()) {
      for (const command of [...workspaceCase.verification.commands, ...workspaceCase.verification.hiddenCommands,
        ...workspaceCase.source.setupCommands]) {
        // `node` and nothing else: no package manager, so no lockfile, no registry and no network.
        expect(command.executable, `${workspaceCase.id} runs ${command.executable}`).toBe('node');
        expect(command.timeoutMilliseconds).toBeGreaterThan(0);
      }
      const root = path.join(FIXTURE_ROOT, workspaceCase.source.fixturePath);
      expect(fs.existsSync(path.join(root, 'package.json')),
        `${workspaceCase.id}'s fixture carries a package.json, which invites an install`).toBe(false);
      expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
    }
  });

  it('leaves the one case that has already run live exactly where it was', () => {
    // A pack is not a reason to re-version a case that nothing about it changed. `broken-sum` was
    // proven end to end before this pack existed, and its digest here is the same one that result
    // carries — so the live evidence on this machine stays comparable with everything run next.
    expect(BROKEN_SUM_MEAN.version).toBe('3');
    expect(BROKEN_SUM_MEAN.source.expectedTreeDigest)
      .toBe('e8b6fd5c963dbe6ff6da5b0e68ad68799abf8947e6b7b88c6ddfacf5077aab0b');
  });
});

// MARK: - The pack itself

describe('a benchmark pack is a sealed experiment, not a folder of cases', () => {
  it('validates, resolves and digests under its own scheme', () => {
    validateWorkspaceCatalog();
    expect(workspacePackByID(foundationFourPack.id)).toBe(foundationFourPack);
    expect(resolveWorkspacePack(foundationFourPack, allWorkspaceCases())).toHaveLength(4);
    expect(foundationFourPack.repeatsPerCase).toBe(3);
    expect(workspacePackDigest(foundationFourPack, allWorkspaceCases()).startsWith('cwp1:')).toBe(true);
  });

  it('moves its digest when the SAMPLING changes and leaves every case digest alone', () => {
    const cases = allWorkspaceCases();
    const once = makeWorkspaceBenchmarkPack({ ...foundationFourPack, repeatsPerCase: 1 });
    expect(workspacePackDigest(once, cases)).not.toBe(workspacePackDigest(foundationFourPack, cases));
    // The cases are untouched: a result from a one-sample run is still comparable with one from a
    // three-sample run, which is exactly why the repeat count is not inside `cwc1:`.
    for (const entry of cases) expect(workspaceCaseDigest(entry).startsWith('cwc1:')).toBe(true);
  });

  it('refuses a pack naming a case this build does not carry', () => {
    const wrong = makeWorkspaceBenchmarkPack({
      id: 'pack.test', version: '1', caseIDs: ['ws.broken-sum.mean', 'ws.not.here'], repeatsPerCase: 1,
    });
    expect(() => resolveWorkspacePack(wrong, allWorkspaceCases())).toThrow(WorkspacePackError);
  });

  it('refuses a pack that would sample nothing, and one with an unsealed member', () => {
    expect(() => validateWorkspaceBenchmarkPack(makeWorkspaceBenchmarkPack({
      id: 'pack.test', version: '1', caseIDs: [BROKEN_SUM_MEAN.id], repeatsPerCase: 0,
    }), allWorkspaceCases())).toThrow(/at least one sample/);

    const unsealed: WorkspaceCase = {
      ...BROKEN_SUM_MEAN,
      id: 'ws.unsealed',
      source: { ...BROKEN_SUM_MEAN.source, sealed: false, expectedTreeDigest: undefined },
    };
    expect(() => validateWorkspaceBenchmarkPack(makeWorkspaceBenchmarkPack({
      id: 'pack.test', version: '1', caseIDs: ['ws.unsealed'], repeatsPerCase: 1,
    }), [unsealed])).toThrow(/not sealed/);
  });

  it('gives every repeat of a cell one group id, and different cells different ones', () => {
    const groupA = workspaceRepeatGroupID({
      packID: 'p', packVersion: '1', candidate: 'claudeCLI:a', comparabilityKey: 'cwk1:one',
    });
    const groupB = workspaceRepeatGroupID({
      packID: 'p', packVersion: '1', candidate: 'claudeCLI:b', comparabilityKey: 'cwk1:one',
    });
    expect(groupA.startsWith('cwr1:')).toBe(true);
    expect(groupA).not.toBe(groupB);
    const repeats = planWorkspaceRepeats(3, groupA);
    expect(repeats.map((repeat) => repeat.repeatIndex)).toEqual([1, 2, 3]);
    expect(new Set(repeats.map((repeat) => repeat.repeatGroupID)).size).toBe(1);
    expect(repeats.every((repeat) => repeat.repeatsPlanned === 3)).toBe(true);
  });

  it('exercises four materially different capabilities across the four cases', () => {
    const byCase = Object.fromEntries(allWorkspaceCases().map((entry) => [entry.id, entry.dimensions]));
    expect(byCase[TASK_PRIORITY_PROPAGATE.id]).toContain('multiFileEditing');
    expect(byCase[RECEIPT_REFUNDS_SIGN.id]).toContain('failureInterpretation');
    expect(byCase[REGISTRY_ISOLATION_RECOVER.id]).toContain('recoveryFromError');
    expect(byCase[BROKEN_SUM_MEAN.id]).toContain('fileLocation');
    // Only the recovery case allows a retry among the three new ones; the other two measure what a
    // model does the first time, and their `firstAttempt` metric is unavailable rather than perfect.
    expect(REGISTRY_ISOLATION_RECOVER.execution.maximumAttempts).toBe(2);
    expect(TASK_PRIORITY_PROPAGATE.execution.maximumAttempts).toBe(1);
    expect(RECEIPT_REFUNDS_SIGN.execution.maximumAttempts).toBe(1);
  });

  it('tells every case the scope it is judged by, in the text it is handed', () => {
    for (const workspaceCase of allWorkspaceCases()) {
      const instruction = workspaceInstructionText(workspaceCase);
      expect(instruction).toContain('You may change only these paths: src/**.');
      expect(instruction).toContain('You must not change these paths: test/**.');
      // The forbidden list is enforced twice, and both lists must name the same thing.
      expect(workspaceCase.verification.forbiddenChanges).toEqual(['test/**']);
    }
  });
});

// MARK: - ws.task-priority.propagate

const TASK_CORE = [
  "'use strict';",
  '',
  "/** Every priority a task may carry, weakest first. The only values `createTask` accepts. */",
  "const PRIORITIES = ['low', 'normal', 'high'];",
  '',
  '/** The priority a task gets when the caller names none. */',
  "const DEFAULT_PRIORITY = 'normal';",
  '',
  '/**',
  ' * Build a task.',
  ' *',
  ' * The ONLY constructor. Nothing else in this package builds a task object literal, so a field added',
  ' * here is a field every task has — including the ones `fromWire` reads back off disk.',
  ' */',
  'function createTask(fields) {',
  "  if (typeof fields.id !== 'string' || fields.id.length === 0) {",
  "    throw new TypeError('a task needs a non-empty id');",
  '  }',
  '  const priority = fields.priority === undefined ? DEFAULT_PRIORITY : fields.priority;',
  '  if (!PRIORITIES.includes(priority)) {',
  "    throw new TypeError(priority + ' is not a priority');",
  '  }',
  '  return {',
  '    id: fields.id,',
  "    title: typeof fields.title === 'string' ? fields.title : '',",
  '    done: false,',
  '    priority,',
  '  };',
  '}',
  '',
  '/** A completed copy. Tasks are values here; nothing is mutated in place. */',
  'function completeTask(task) {',
  '  return { ...task, done: true };',
  '}',
  '',
  'module.exports = { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask };',
].join('\n') + '\n';

/** The adapter, done properly: the key is written, and a record without it reads as the default. */
const TASK_WIRE_CORRECT = [
  "'use strict';",
  '',
  "const { DEFAULT_PRIORITY, createTask } = require('./task.js');",
  '',
  '/**',
  ' * The storage adapter. `docs/FORMAT.md` is the contract for these keys; they are short, they are',
  ' * fixed, and a record written by an older build must keep loading.',
  ' */',
  'function toWire(task) {',
  '  return { i: task.id, t: task.title, d: task.done === true, p: task.priority };',
  '}',
  '',
  '/**',
  ' * Read a record back.',
  ' *',
  ' * Goes through `createTask` rather than building an object literal, so the core model stays the one',
  ' * place a task’s shape is decided.',
  ' */',
  'function fromWire(record) {',
  '  const task = createTask({',
  '    id: record.i,',
  '    title: record.t,',
  '    priority: record.p === undefined ? DEFAULT_PRIORITY : record.p,',
  '  });',
  '  return { ...task, done: record.d === true };',
  '}',
  '',
  'module.exports = { toWire, fromWire };',
].join('\n') + '\n';

/**
 * The adapter that builds the task itself instead of going through the constructor.
 *
 * THE PLAUSIBLE WRONG ANSWER, and the exact one `docs/FORMAT.md` and the fixture's README warn
 * about. Every visible assertion passes — a round trip always carries `p`, so nothing visible ever
 * reads a record without one — and a record written before the field existed comes back with
 * `priority: undefined`, which is the failure a user meets and the tests never see.
 */
const TASK_WIRE_BYPASSING_THE_CONSTRUCTOR = [
  "'use strict';",
  '',
  '/**',
  ' * The storage adapter. `docs/FORMAT.md` is the contract for these keys.',
  ' */',
  'function toWire(task) {',
  '  return { i: task.id, t: task.title, d: task.done === true, p: task.priority };',
  '}',
  '',
  'function fromWire(record) {',
  '  return { id: record.i, title: record.t, done: record.d === true, priority: record.p };',
  '}',
  '',
  'module.exports = { toWire, fromWire };',
].join('\n') + '\n';

const TASK_INDEX = [
  "'use strict';",
  '',
  "const { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask } = require('./task.js');",
  "const { toWire, fromWire } = require('./wire.js');",
  '',
  '/**',
  ' * One task, as a person reads it.',
  ' *',
  ' * The public rendering. A consumer of this package never reaches past it into `src/task.js`.',
  ' */',
  'function describeTask(task) {',
  "  return (task.done ? '[x]' : '[ ]') + ' (' + task.priority + ') ' + task.title;",
  '}',
  '',
  'module.exports = { PRIORITIES, DEFAULT_PRIORITY, createTask, completeTask, describeTask, toWire, fromWire };',
].join('\n') + '\n';

describe('ws.task-priority.propagate — one field, three layers', () => {
  it('passes when all three layers are changed and the old-record rule is honoured', async () => {
    const card = await scoreScripted(TASK_PRIORITY_PROPAGATE, [{
      steps: [
        { do: 'read', path: 'docs/FORMAT.md' },
        { do: 'write', path: 'src/task.js', contents: TASK_CORE },
        { do: 'write', path: 'src/wire.js', contents: TASK_WIRE_CORRECT },
        { do: 'write', path: 'src/index.js', contents: TASK_INDEX },
      ],
    }]);
    expect(card.status).toBe('pass');
    expect(card.changedFileCount).toBe(3);
    expect(card.compositeMilli.valueMilli).toBeGreaterThan(900);
    // Every visible suite went from failing to passing, and nothing regressed.
    expect(card.transitions.filter((transition) => transition.transition === 'fixed')).toHaveLength(3);
    expect(card.regressionCount).toBe(0);
  }, 120_000);

  it('fails when nothing is changed', async () => {
    const card = await scoreScripted(TASK_PRIORITY_PROPAGATE, [SAYS_NOTHING_CHANGES_NOTHING]);
    expect(card.status).toBe('behavioralFailure');
    expect(card.changedFileCount).toBe(0);
  }, 120_000);

  it('fails on SCOPE when a test is edited, whatever else the attempt achieved', async () => {
    const card = await scoreScripted(TASK_PRIORITY_PROPAGATE, [{
      steps: [
        { do: 'write', path: 'src/task.js', contents: TASK_CORE },
        { do: 'write', path: 'src/wire.js', contents: TASK_WIRE_CORRECT },
        { do: 'write', path: 'src/index.js', contents: TASK_INDEX },
        // The fastest way to a green suite is to change what it asserts. It is a scope failure.
        { do: 'write', path: 'test/core.test.js', contents: 'process.exit(0);\n' },
      ],
    }]);
    expect(card.status).toBe('scopeFailure');
    expect(card.detail).toContain('test/core.test.js');
  }, 120_000);

  it('fails when only ONE of the three layers is changed', async () => {
    const card = await scoreScripted(TASK_PRIORITY_PROPAGATE, [{
      steps: [{ do: 'write', path: 'src/task.js', contents: TASK_CORE }],
    }]);
    // The core suite goes green and the other two do not: this is the property that makes the case
    // a multi-file case rather than a single-file one with three test files.
    expect(card.status).toBe('behavioralFailure');
    const byCommand = Object.fromEntries(card.transitions.map((transition) => [transition.commandID, transition.transition]));
    expect(byCommand['core-tests']).toBe('fixed');
    expect(byCommand['wire-tests']).toBe('stillFailing');
    expect(byCommand['api-tests']).toBe('stillFailing');
  }, 120_000);

  it('fails on the HIDDEN check when every visible suite passes but the constructor was bypassed', async () => {
    const card = await scoreScripted(TASK_PRIORITY_PROPAGATE, [{
      steps: [
        { do: 'write', path: 'src/task.js', contents: TASK_CORE },
        { do: 'write', path: 'src/wire.js', contents: TASK_WIRE_BYPASSING_THE_CONSTRUCTOR },
        { do: 'write', path: 'src/index.js', contents: TASK_INDEX },
      ],
    }]);
    expect(card.status).toBe('behavioralFailure');
    expect(card.detail).toContain('legacy-record');
    const visible = card.transitions.filter((transition) => transition.kind === 'test');
    expect(visible.every((transition) => transition.after)).toBe(true);
  }, 120_000);
});

// MARK: - ws.receipt-refunds.sign

const PARSE_CORRECT = [
  "'use strict';",
  '',
  '/** Pulls the amount, and its sign, out of an entry. */',
  'const AMOUNT = /(-?)\\$([0-9]+(?:\\.[0-9]{1,2})?)/;',
  '',
  '/**',
  ' * One line of a receipt file, as a record.',
  ' *',
  ' * `amountCents` is a whole number of cents. This is the only place a line of text becomes a number:',
  ' * everything downstream does arithmetic on the record and never re-reads the line.',
  ' */',
  'function parseLine(line) {',
  "  const separator = line.indexOf(':');",
  "  if (separator < 0) throw new SyntaxError('no colon in receipt line: ' + line);",
  '  const name = line.slice(0, separator).trim();',
  '  const amount = line.slice(separator + 1).trim();',
  '  const match = AMOUNT.exec(amount);',
  "  if (match === null) throw new SyntaxError('no amount in receipt line: ' + line);",
  '  const cents = Math.round(Number.parseFloat(match[2]) * 100);',
  "  return { name, amountCents: match[1] === '-' ? -cents : cents };",
  '}',
  '',
  '/** Every line of a receipt, in order. Blank lines are skipped. */',
  'function parseReceipt(lines) {',
  '  return lines.filter((line) => line.trim().length > 0).map(parseLine);',
  '}',
  '',
  'module.exports = { parseLine, parseReceipt };',
].join('\n') + '\n';

/** The symptom cured at the reporting layer: the report re-reads the text the parser already read. */
const REPORT_PATCHED_AT_THE_SYMPTOM = [
  "'use strict';",
  '',
  "const { parseReceipt } = require('./parse.js');",
  '',
  '/** The sum of every record, in whole cents. */',
  'function totalCents(records) {',
  '  return records.reduce((total, record) => total + record.amountCents, 0);',
  '}',
  '',
  '/** Whole cents as the string a person reads. Negative totals keep their sign. */',
  'function formatCents(cents) {',
  "  return (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toFixed(2);",
  '}',
  '',
  '/** The whole report: how many entries there were, and what they come to. */',
  'function renderReport(lines) {',
  '  const kept = lines.filter((line) => line.trim().length > 0);',
  '  const records = parseReceipt(lines).map((record, index) =>',
  "    (kept[index].includes('-$') ? { ...record, amountCents: -record.amountCents } : record));",
  "  return records.length + ' entries · total ' + formatCents(totalCents(records));",
  '}',
  '',
  'module.exports = { totalCents, formatCents, renderReport };',
].join('\n') + '\n';

describe('ws.receipt-refunds.sign — the symptom is two layers from the cause', () => {
  it('passes when the parser is fixed', async () => {
    const card = await scoreScripted(RECEIPT_REFUNDS_SIGN, [{
      steps: [
        { do: 'read', path: 'src/report.js' },
        { do: 'read', path: 'src/parse.js' },
        { do: 'write', path: 'src/parse.js', contents: PARSE_CORRECT },
      ],
    }]);
    expect(card.status).toBe('pass');
    expect(card.changedFileCount).toBe(1);
    expect(card.regressionCount).toBe(0);
  }, 120_000);

  it('fails when nothing is changed', async () => {
    const card = await scoreScripted(RECEIPT_REFUNDS_SIGN, [SAYS_NOTHING_CHANGES_NOTHING]);
    expect(card.status).toBe('behavioralFailure');
  }, 120_000);

  it('fails on SCOPE when the failing test is edited instead', async () => {
    const card = await scoreScripted(RECEIPT_REFUNDS_SIGN, [{
      steps: [{ do: 'write', path: 'test/report.test.js', contents: 'process.exit(0);\n' }],
    }]);
    expect(card.status).toBe('scopeFailure');
  }, 120_000);

  it('fails the HIDDEN check on a fix applied where the symptom appeared', async () => {
    const card = await scoreScripted(RECEIPT_REFUNDS_SIGN, [{
      steps: [{ do: 'write', path: 'src/report.js', contents: REPORT_PATCHED_AT_THE_SYMPTOM }],
    }]);
    // Every visible assertion is green — this is the fix that LOOKS right — and the parser is still
    // sign-blind, so the hidden check that asks it directly fails and the case does not pass.
    const visible = card.transitions.filter((transition) => transition.commandID === 'report-tests');
    expect(visible[0].transition).toBe('fixed');
    expect(card.status).toBe('behavioralFailure');
    expect(card.detail).toContain('parser-sign');
  }, 120_000);
});

// MARK: - ws.registry-isolation.recover

const REGISTRY_HEAD = [
  "'use strict';",
  '',
  '/** What a registry falls back to when the caller names no options. */',
  "const DEFAULT_OPTIONS = { label: 'registry', entries: [] };",
  '',
  '/**',
  ' * Build a registry.',
  ' *',
  ' * A REGISTRY OWNS ITS ENTRIES — see README.md. Creating one must leave it sharing state with',
  ' * nothing: not with another registry, and not with the options object it was created from.',
  ' */',
  'function createRegistry(options) {',
];
const REGISTRY_TAIL = [
  '}',
  '',
  '/** Add a name. Registries are mutable containers; this is the only thing that writes to one. */',
  'function register(registry, name) {',
  '  registry.entries.push(name);',
  '  return registry;',
  '}',
  '',
  '/** Every name in the registry, in the order it was added. */',
  'function namesOf(registry) {',
  '  return [...registry.entries];',
  '}',
  '',
  'module.exports = { DEFAULT_OPTIONS, createRegistry, register, namesOf };',
];

/** The obvious fix: a fresh default object per call. Cures the visible symptom, keeps the aliasing. */
const REGISTRY_TRAP = [...REGISTRY_HEAD,
  "  const settings = options === undefined ? { label: 'registry', entries: [] } : options;",
  '  return { label: settings.label, entries: settings.entries };',
  ...REGISTRY_TAIL].join('\n') + '\n';

/** The whole fix: the registry owns a COPY, whoever built it and from what. */
const REGISTRY_CORRECT = [...REGISTRY_HEAD,
  '  const settings = options === undefined ? DEFAULT_OPTIONS : options;',
  '  return { label: settings.label, entries: [...settings.entries] };',
  ...REGISTRY_TAIL].join('\n') + '\n';

const trapAttempt: ScriptedAttempt = {
  steps: [
    { do: 'read', path: 'src/registry.js' },
    { do: 'write', path: 'src/registry.js', contents: REGISTRY_TRAP },
    { do: 'runCommand', executable: 'node', args: ['test/registry.test.js'], exitCode: 0 },
  ],
  finalMessage: 'The shared default is gone.',
};

const correctAttempt: ScriptedAttempt = {
  steps: [
    { do: 'read', path: 'README.md' },
    { do: 'write', path: 'src/registry.js', contents: REGISTRY_CORRECT },
  ],
  finalMessage: 'The registry now owns a copy of its entries.',
};

/** A scripted driver that also records the exact text each attempt was handed. */
function recordingDriver(attempts: ScriptedAttempt[]): { driver: WorkspaceAgentDriver; sent: string[] } {
  const scripted = new ScriptedWorkspaceAgent(attempts);
  const sent: string[] = [];
  return {
    sent,
    driver: {
      driverID: scripted.driverID,
      provider: scripted.provider,
      capabilities: scripted.capabilities,
      async run(request: WorkspaceAgentRequest) {
        sent.push(request.instruction);
        return scripted.run(request);
      },
    },
  };
}

describe('ws.registry-isolation.recover — the obvious fix is half a fix', () => {
  it('passes on the FIRST attempt when the aliasing is understood', async () => {
    const card = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [correctAttempt]);
    expect(card.status).toBe('pass');
    expect(card.attemptsUsed).toBe(1);
    expect(card.retriesRequired).toBe(0);
    expect(card.metricsMilli.firstAttempt.valueMilli).toBe(1_000);
  }, 120_000);

  it('fails when nothing is changed', async () => {
    const card = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [SAYS_NOTHING_CHANGES_NOTHING]);
    expect(card.status).toBe('behavioralFailure');
    expect(card.changedFileCount).toBe(0);
  }, 120_000);

  it('fails on SCOPE when the test is edited', async () => {
    const card = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [{
      steps: [{ do: 'write', path: 'test/registry.test.js', contents: 'process.exit(0);\n' }],
    }]);
    expect(card.status).toBe('scopeFailure');
  }, 120_000);

  it('does NOT pass on the plausible fix, however green the visible suite goes', async () => {
    const card = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [trapAttempt, trapAttempt]);
    expect(card.status).toBe('behavioralFailure');
    expect(card.detail).toContain('shared-options');
    // The visible suite passed on both attempts and the case still did not.
    expect(card.transitions.find((transition) => transition.commandID === 'registry-tests')?.transition).toBe('fixed');
    expect(card.attemptsUsed).toBe(2);
    expect(card.metricsMilli.firstAttempt.valueMilli).toBe(0);
  }, 120_000);

  it('recovers on the second attempt, and the SCORE says it was the second', async () => {
    const { driver, sent } = recordingDriver([trapAttempt, correctAttempt]);
    const card = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [], driver);

    expect(card.status).toBe('pass');
    expect(card.attemptsUsed).toBe(2);
    expect(card.retriesRequired).toBe(1);
    // Recovery is worth half of a first-time pass on this metric, and this case weighs the metric
    // heavily enough for that to show in the composite rather than round away.
    expect(card.metricsMilli.firstAttempt.valueMilli).toBe(500);

    // AND THE SECOND ATTEMPT WAS ACTUALLY TOLD SOMETHING. Until the retry briefing existed, every
    // driver sent the identical text twice, which measures resampling rather than recovery.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(workspaceInstructionText(REGISTRY_ISOLATION_RECOVER));
    expect(sent[1].startsWith(sent[0])).toBe(true);
    expect(sent[1]).toContain('ATTEMPT 1 OF THIS TASK DID NOT PASS');
    expect(sent[1]).toContain('FRESH COPY');
    // The hidden check's own words reach the next attempt: hidden means undisclosed in advance,
    // not withheld from the record.
    expect(sent[1]).toContain('two registries built from one options object');
  }, 120_000);

  it('scores first-time, recovered and failed as three visibly different outcomes', async () => {
    const firstTime = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [correctAttempt]);
    const recoveredDriver = recordingDriver([trapAttempt, correctAttempt]);
    const recovered = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [], recoveredDriver.driver);
    const failed = await scoreScripted(REGISTRY_ISOLATION_RECOVER, [trapAttempt, trapAttempt]);

    const score = (card: WorkspaceScorecard): number => card.compositeMilli.valueMilli ?? -1;
    expect(score(firstTime)).toBeGreaterThan(score(recovered));
    expect(score(recovered)).toBeGreaterThan(score(failed));
    // Not a rounding difference: the recovery-weighted policy is what makes the gap readable.
    expect(score(firstTime) - score(recovered)).toBeGreaterThanOrEqual(100);
    expect(REGISTRY_ISOLATION_RECOVER.scoring.id).toBe('policy.workspace.recovery');
  }, 180_000);

  it('composes the retry briefing once, in the engine, with no advice in it', () => {
    const text = retryBriefingText({
      attemptIndex: 0,
      terminationReason: 'completed',
      outcome: 'shared-options failed',
      failureDetail: 'AssertionError: two registries built from one options object must not share entries',
      transcriptDigest: 'd', patchDigest: 'p',
    });
    expect(text).toContain('ATTEMPT 1 OF THIS TASK DID NOT PASS');
    expect(text).toContain('AssertionError');
    // Deterministic: no timestamp, no duration, no absolute path. Two identical failures produce
    // byte-identical briefings, so a transcript digest stays comparable across runs.
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(text).not.toContain('/private/');
  });
});
