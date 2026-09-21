// Benchmark engine · the TIER 3 workspace suite: the cases meant to separate strong frontier agents.
//
// WHAT CHANGES AT TIER 3. Not size. Every fixture here is between fifteen and twenty-four files and
// under seven hundred lines of JavaScript — small enough to read in a sitting, which is the point:
// a case nobody can hold in mind measures reading speed. What changes is that the answer has to be
// RIGHT IN MORE THAN ONE WAY AT ONCE. A Tier 2 case has a defect and a contract; a Tier 3 case has a
// boundary that has to exist, consumers that have to go through it, behaviour that has to be
// identical afterwards, and an invariant that only holds if the first three did. There are several
// answers that are plausible and incomplete, and the incomplete ones are not careless — they are
// what a competent engineer produces on a first pass.
//
//   ws.t3.permission-gate.centralize   introduce an authorization boundary that does not exist,
//                                      route five handlers through it, and leave the role names
//                                      behind. Patching the caller that leaks passes every
//                                      behaviour test and fails the architecture.
//   ws.t3.event-replay.pair            four suites, two independent defects, and neither one alone
//                                      makes the suite green. Decomposition.
//   ws.t3.validator-rules.refactor     a two-hundred-line chain becomes a rule registry with the
//                                      caller-visible behaviour byte-identical. A partial migration
//                                      passes the behaviour tests; a wrapper passes those too.
//   ws.t3.import-pipeline.finish       the longest one: read the pipeline, find the design point,
//                                      change several stages, run the suites, read what is still
//                                      wrong, and finish. The plausible first answer is correct
//                                      about the key and wrong about what a blank cell means.
//
// EACH ONE IS A CASE A PERSON COULD BE GIVEN. None of them is a puzzle, a trick, or a guess at a
// hidden name: every requirement the hidden checks enforce is written in the fixture's own
// `docs/`, in the words the check quotes back when it fails. What is hard about them is the
// engineering.
//
// TWO OF THE FOUR ALLOW A SECOND ATTEMPT AND TWO DO NOT, and the split is deliberate. `pair` and
// `refactor` measure whether the work was decomposed and executed correctly the first time;
// `import-pipeline` measures sustained agentic work across a whole pipeline, where the first
// attempt is EXPECTED to produce useful verification feedback, and it is scored under the
// recovery-weighted policy so that first-time and second-time do not land within a rounding error
// of each other.

import {
  RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY, WorkspaceCase, WorkspaceSuite, fileInvariant, makeWorkspaceCase,
  makeWorkspaceSuite, workspaceCommand,
} from './workspace-case';
import { hiddenScript } from './workspace-hidden-script';

export const WORKSPACE_SUITE_TIER_THREE = 'suite.cernum.workspace.tier-three';
export const WORKSPACE_SUITE_TIER_THREE_VERSION = '1';

const SUBSCRIPTION_SESSION_ENVIRONMENT = ['HOME', 'USER'];

// MARK: - Hidden checks · permission-gate

/** `docs/AUTHZ.md`: the whole table, and an actor whose role is not one of the four. */
const AUTHZ_IS_TOTAL_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { ACTIONS, authorize } = require('./src/authz/policy.js');",
  "const { createActor } = require('./src/model/actor.js');",
  "const { createStore, fetch } = require('./src/store/index.js');",
  "const { ForbiddenError } = require('./src/errors.js');",
  "const actor = (role) => createActor({ id: 'u', role });",
  "const ALLOWED = {",
  "  reader: ['read'],",
  "  writer: ['read', 'update'],",
  "  curator: ['read', 'update', 'delete', 'export', 'archive'],",
  "  admin: ['read', 'update', 'delete', 'export', 'archive'],",
  "};",
  "const ordinary = fetch(createStore(), 'd1');",
  "for (const [role, allowed] of Object.entries(ALLOWED)) {",
  "  for (const action of ACTIONS) {",
  "    if (allowed.includes(action)) {",
  "      assert.strictEqual(authorize(actor(role), action, ordinary), undefined,",
  "        `docs/AUTHZ.md says a ${role} may ${action}`);",
  "    } else {",
  "      assert.throws(() => authorize(actor(role), action, ordinary), ForbiddenError,",
  "        `docs/AUTHZ.md says a ${role} may not ${action}`);",
  "    }",
  "  }",
  "}",
  "for (const action of ACTIONS) {",
  "  assert.throws(() => authorize(actor('guest'), action, ordinary), ForbiddenError,",
  "    'docs/AUTHZ.md: an actor whose role is not one of the four may do nothing at all');",
  "}",
  "console.log('ok - the boundary answers for every action and every role');",
]);

/** `docs/AUTHZ.md`: confidentiality and locking narrow, for the roles the table marks and no others. */
const AUTHZ_NARROWING_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { authorize } = require('./src/authz/policy.js');",
  "const { createActor } = require('./src/model/actor.js');",
  "const { createStore, fetch } = require('./src/store/index.js');",
  "const { ForbiddenError } = require('./src/errors.js');",
  "const actor = (role) => createActor({ id: 'u', role });",
  "const store = createStore();",
  "const confidential = fetch(store, 'd2');",
  "const locked = fetch(store, 'd3');",
  "assert.throws(() => authorize(actor('reader'), 'read', confidential), ForbiddenError,",
  "  'docs/AUTHZ.md: a confidential document is not readable by a reader');",
  "assert.throws(() => authorize(actor('writer'), 'read', confidential), ForbiddenError);",
  "assert.strictEqual(authorize(actor('curator'), 'read', confidential), undefined,",
  "  'and confidentiality narrows for the two roles the table marks, not for everybody');",
  "assert.strictEqual(authorize(actor('admin'), 'read', confidential), undefined);",
  "assert.throws(() => authorize(actor('writer'), 'update', locked), ForbiddenError,",
  "  'docs/AUTHZ.md: a locked document may not be updated by a writer');",
  "assert.strictEqual(authorize(actor('curator'), 'update', locked), undefined,",
  "  'and a curator or an admin may update a locked document');",
  "assert.strictEqual(authorize(actor('admin'), 'update', locked), undefined);",
  "console.log('ok - narrowing narrows and does not widen');",
]);

/** `docs/ARCHITECTURE.md`: every handler asks — including the one nothing visible exercises. */
const AUTHZ_EVERY_HANDLER_ASKS_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { createActor } = require('./src/model/actor.js');",
  "const { createStore } = require('./src/store/index.js');",
  "const { archiveDocument } = require('./src/handlers/archive.js');",
  "const { ForbiddenError, ConflictError } = require('./src/errors.js');",
  "const actor = (role) => createActor({ id: 'u', role });",
  "const store = createStore();",
  "assert.throws(() => archiveDocument(store, actor('reader'), 'd5'), ForbiddenError,",
  "  'docs/ARCHITECTURE.md: every handler asks the boundary, every time, before it touches the store');",
  "assert.throws(() => archiveDocument(store, actor('writer'), 'd5'), ForbiddenError);",
  "assert.strictEqual(archiveDocument(store, actor('curator'), 'd5').archived, true);",
  "assert.throws(() => archiveDocument(store, actor('admin'), 'd4'), ConflictError,",
  "  'and a document that is already archived is a fact about the document, not about the caller');",
  "console.log('ok - every handler asks, including the one nothing else here exercises');",
]);

// MARK: - Hidden checks · event-replay

/** `docs/REPLAY.md`: inOrder answers with a new list, ascending, at any size. */
const REPLAY_ORDER_IS_ORDER_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { createEvent } = require('./src/event.js');",
  "const { inOrder } = require('./src/order.js');",
  "const { logOf, shuffledForTransport } = require('./src/log.js');",
  "const log = logOf(Array.from({ length: 12 }, () => ({ kind: 'deposit', amountCents: 1 })));",
  "const arriving = shuffledForTransport(log);",
  "const asGiven = arriving.map((event) => event.sequence);",
  "inOrder(arriving);",
  "assert.deepStrictEqual(arriving.map((event) => event.sequence), asGiven,",
  "  'docs/REPLAY.md: inOrder answers with a new list and leaves the one it was given as it found it');",
  "const wide = Array.from({ length: 120 }, (unused, index) => createEvent({",
  "  kind: 'deposit', amountCents: 1, sequence: ((index * 37) % 120) + 1,",
  "}));",
  "assert.deepStrictEqual(inOrder(wide).map((event) => event.sequence),",
  "  Array.from({ length: 120 }, (unused, index) => index + 1),",
  "  'a log of any size comes back ascending by sequence number');",
  "console.log('ok - order is order');",
]);

/** `docs/REPLAY.md`: applying an event answers with a new state, so every state along a replay is its own. */
const REPLAY_STATES_ARE_THEIR_OWN_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { inOrder } = require('./src/order.js');",
  "const { createState, statesEqual } = require('./src/state.js');",
  "const { applyEvent } = require('./src/apply.js');",
  "const { logOf } = require('./src/log.js');",
  "const LOG = logOf([",
  "  { kind: 'deposit', amountCents: 10000 }, { kind: 'hold', reference: 'h1' },",
  "  { kind: 'deposit', amountCents: 2500 }, { kind: 'withdraw', amountCents: 500 },",
  "  { kind: 'hold', reference: 'h2' }, { kind: 'release', reference: 'h1' },",
  "  { kind: 'deposit', amountCents: 100 }, { kind: 'withdraw', amountCents: 2000 },",
  "  { kind: 'hold', reference: 'h3' }, { kind: 'release', reference: 'h2' },",
  "  { kind: 'deposit', amountCents: 50 }, { kind: 'withdraw', amountCents: 25 },",
  "]);",
  "const along = [];",
  "let state = createState();",
  "for (const event of inOrder(LOG)) {",
  "  along.push(state);",
  "  state = applyEvent(state, event);",
  "}",
  "along.push(state);",
  "for (let earlier = 0; earlier < along.length; earlier += 1) {",
  "  for (let later = earlier + 1; later < along.length; later += 1) {",
  "    assert.notStrictEqual(along[earlier], along[later],",
  "      'docs/REPLAY.md: applying an event answers with a new state, so every state along a replay is its own');",
  "  }",
  "}",
  "assert.strictEqual(statesEqual(along[0], createState()), true,",
  "  'and the state a replay started from is still the state it started from');",
  "assert.strictEqual(along[along.length - 1].balanceCents, 10125);",
  "console.log('ok - every state along a replay is its own');",
]);

/** `docs/REPLAY.md`: a snapshot cut anywhere replays to the state the whole log replays to. */
const REPLAY_SNAPSHOT_EQUIVALENCE_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { statesEqual } = require('./src/state.js');",
  "const { replay, replayUpTo, tailAfter } = require('./src/replay.js');",
  "const { snapshotOf, restore } = require('./src/snapshot.js');",
  "const { logOf, shuffledForTransport } = require('./src/log.js');",
  "const LOG = logOf([",
  "  { kind: 'deposit', amountCents: 10000 }, { kind: 'hold', reference: 'h1' },",
  "  { kind: 'deposit', amountCents: 2500 }, { kind: 'withdraw', amountCents: 500 },",
  "  { kind: 'hold', reference: 'h2' }, { kind: 'release', reference: 'h1' },",
  "  { kind: 'deposit', amountCents: 100 }, { kind: 'withdraw', amountCents: 2000 },",
  "  { kind: 'hold', reference: 'h3' }, { kind: 'release', reference: 'h2' },",
  "  { kind: 'deposit', amountCents: 50 }, { kind: 'withdraw', amountCents: 25 },",
  "]);",
  "for (const arrival of [LOG, shuffledForTransport(LOG)]) {",
  "  const whole = replay(arrival);",
  "  for (let cut = 0; cut <= 12; cut += 1) {",
  "    const snapshot = snapshotOf(replayUpTo(arrival, cut));",
  "    assert.strictEqual(statesEqual(replay(tailAfter(arrival, cut), restore(snapshot)), whole), true,",
  "      `docs/REPLAY.md: a snapshot cut after event ${cut} must replay to the same state as the whole log`);",
  "  }",
  "}",
  "console.log('ok - a snapshot at any cut agrees with the whole log');",
]);

// MARK: - Hidden checks · validator-rules

/** `docs/ARCHITECTURE.md`: each of the six rules is its own module and can be asked on its own. */
const RULES_STAND_ALONE_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { withDefaults } = require('./src/defaults.js');",
  "const EXPECTED = [",
  "  ['name-format', 'name', 'NAME_FORMAT', { name: 'Bad Name' }],",
  "  ['replica-count', 'replicas', 'REPLICA_COUNT', { replicas: 0 }],",
  "  ['port-range', 'port', 'PORT_RANGE', { port: 80 }],",
  "  ['image-tag', 'image', 'IMAGE_TAG', { image: 'service:latest' }],",
  "  ['env-names', 'env', 'ENV_NAME', { env: { myVar: '1', OK: '2' } }],",
  "  ['limits-present', 'limits', 'LIMITS', { limits: { cpuMilli: 250, memoryMiB: 32 } }],",
  "];",
  "for (const [id, appliesTo, code, breaking] of EXPECTED) {",
  "  const rule = require(`./src/rules/${id}.js`);",
  "  assert.strictEqual(rule.id, id,",
  "    'docs/ARCHITECTURE.md: each rule is its own module under src/rules/, named after its id');",
  "  assert.strictEqual(rule.code, code, `${id} says which code its errors carry`);",
  "  assert.strictEqual(rule.appliesTo, appliesTo, `${id} says which field it is about`);",
  "  assert.strictEqual(typeof rule.check, 'function');",
  "  const found = rule.check(withDefaults(breaking));",
  "  assert.strictEqual(found.length, 1, `${id} reports its own failure when it is asked on its own`);",
  "  assert.strictEqual(found[0].code, code);",
  "  assert.strictEqual(found[0].rule, id);",
  "  assert.deepStrictEqual(rule.check(withDefaults({})), [],",
  "    `${id} is satisfied by a configuration that does not break it`);",
  "}",
  "console.log('ok - each of the six rules stands on its own');",
]);

/** `docs/RULES.md`: errors come back in rule order, never in the order the fields were written. */
const RULES_ORDER_NOT_FILE_ORDER_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { validate } = require('./src/validate.js');",
  "const IN_RULE_ORDER = ['NAME_FORMAT', 'REPLICA_COUNT', 'PORT_RANGE', 'IMAGE_TAG', 'ENV_NAME', 'LIMITS'];",
  "const backwards = {",
  "  limits: { cpuMilli: 0, memoryMiB: 0 },",
  "  env: { myVar: '1' },",
  "  image: 'service:latest',",
  "  port: 80,",
  "  replicas: 0,",
  "  name: 'Bad Name',",
  "};",
  "assert.deepStrictEqual(validate(backwards).map((error) => error.code), IN_RULE_ORDER,",
  "  'docs/RULES.md: errors come back in rule order, never in the order the fields happen to appear');",
  "const forwards = {",
  "  name: 'Bad Name', replicas: 0, port: 80, image: 'service:latest',",
  "  env: { myVar: '1' }, limits: { cpuMilli: 0, memoryMiB: 0 },",
  "};",
  "assert.deepStrictEqual(validate(forwards).map((error) => error.code), IN_RULE_ORDER,",
  "  'and two configurations breaking the same rules give the same list whichever way round they were written');",
  "assert.deepStrictEqual(",
  "  validate({ env: { zed: '1', alpha: '2', OK: '3' } }).filter((e) => e.code === 'ENV_NAME').map((e) => e.path),",
  "  ['env.zed', 'env.alpha'],",
  "  'within one rule that reports more than once, the offending items keep the order they appear in');",
  "console.log('ok - rule order, not file order');",
]);

/** `docs/ARCHITECTURE.md`: the registry is the one statement of what runs, and both readers use it. */
const RULES_REGISTRY_IS_THE_ORDER_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { RULES, listRules } = require('./src/rules/index.js');",
  "const { describeRules } = require('./src/explain.js');",
  "const { validate } = require('./src/validate.js');",
  "const IDS = ['name-format', 'replica-count', 'port-range', 'image-tag', 'env-names', 'limits-present'];",
  "assert.deepStrictEqual(listRules(), IDS,",
  "  'docs/ARCHITECTURE.md: the registry holds the rules in the order docs/RULES.md lists them');",
  "assert.deepStrictEqual(describeRules().map((line) => line.split('  ')[0]), IDS,",
  "  'and everything that needs to know which rules there are reads that one list');",
  "const everythingWrong = {",
  "  name: 'Bad Name', replicas: 0, port: 80, image: 'service:latest',",
  "  env: { myVar: '1' }, limits: { cpuMilli: 0, memoryMiB: 0 },",
  "};",
  "assert.deepStrictEqual(validate(everythingWrong).map((error) => error.rule), RULES.map((rule) => rule.id),",
  "  'and the validator runs exactly the rules the registry holds, in exactly that order');",
  "console.log('ok - the registry is the order');",
]);

// MARK: - Hidden checks · import-pipeline

/** `docs/PIPELINE.md`: a later partial row adds to a record rather than replacing it. */
const IMPORT_LATER_ROWS_ADD_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { importText } = require('./src/pipeline.js');",
  "const PARTIAL = [",
  "  'id,email,name,city,age',",
  "  '10,zoe@example.com,Zoe Byrne,Dublin,30',",
  "  '11,zoe@example.com,Zoe B,,',",
  "  '',",
  "].join('\\n');",
  "const partial = importText('person', PARTIAL);",
  "assert.strictEqual(partial.records.length, 1);",
  "assert.deepStrictEqual(partial.records[0].fields, {",
  "  id: '11', email: 'zoe@example.com', name: 'Zoe B', city: 'Dublin', age: 30,",
  "}, 'docs/PIPELINE.md: a field the later row leaves blank does not win — a blank cell means the exporter had '",
  "  + 'nothing to say about that field, and a later partial row must never erase what an earlier complete row knew');",
  "console.log('ok - a later partial row adds to a record rather than replacing it');",
]);

/** `docs/PIPELINE.md`: the surviving record keeps the place of the first row that mentioned it. */
const IMPORT_FIRST_MET_ORDER_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { importText } = require('./src/pipeline.js');",
  "const REVISITED = [",
  "  'id,email,name,city,age',",
  "  '1,alpha@example.com,Alpha,London,1',",
  "  '2,beta@example.com,Beta,Paris,2',",
  "  '3,gamma@example.com,Gamma,Rome,3',",
  "  '4,alpha@example.com,Alpha Two,Leeds,4',",
  "  '',",
  "].join('\\n');",
  "const revisited = importText('person', REVISITED);",
  "assert.deepStrictEqual(revisited.records.map((record) => record.fields.name), ['Alpha Two', 'Beta', 'Gamma'],",
  "  'docs/PIPELINE.md: the surviving record keeps the place of the first row that mentioned it, not the place '",
  "  + 'of the last one that touched it');",
  "assert.deepStrictEqual(revisited.records.map((record) => record.lineNumber), [2, 3, 4]);",
  "assert.strictEqual(revisited.report.dropped.duplicate, 1);",
  "console.log('ok - the order of the output is the order the things were first met');",
]);

/** `docs/PIPELINE.md`: the natural key is the natural key, for every type, compared its own way. */
const IMPORT_NATURAL_KEY_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { importText } = require('./src/pipeline.js');",
  "const COMPANIES = [",
  "  'id,taxID,name,country,employees',",
  "  '1,GB-1,Acme,GB,10',",
  "  '2, gb-1 ,Acme Holdings,,',",
  "  '',",
  "].join('\\n');",
  "const companies = importText('company', COMPANIES);",
  "assert.strictEqual(companies.records.length, 1,",
  "  'docs/PIPELINE.md: a natural key is compared without regard to case or surrounding space');",
  "assert.deepStrictEqual(companies.records[0].fields,",
  "  { id: '2', taxID: 'gb-1', name: 'Acme Holdings', country: 'GB', employees: 10 });",
  "assert.deepStrictEqual(companies.report.reasons, ['line 3: the same company as line 2']);",
  "const SAME_ID = [",
  "  'id,email,name,city,age',",
  "  '7,one@example.com,One,London,1',",
  "  '7,two@example.com,Two,Paris,2',",
  "  '',",
  "].join('\\n');",
  "assert.strictEqual(importText('person', SAME_ID).records.length, 2,",
  "  'docs/PIPELINE.md: two rows with different natural keys are different things even if their id columns match');",
  "console.log('ok - the natural key is what identifies a record');",
]);

// MARK: - The cases

/**
 * Introduce an authorization boundary that is not there, and route every handler through it.
 *
 * WHY THIS CASE EXISTS. Everything before it asks for a defect to be fixed in the place it lives.
 * This asks for a STRUCTURE that does not exist yet: `docs/ARCHITECTURE.md` describes a module at
 * `src/authz/policy.js` exporting `ACTIONS` and `authorize(actor, action, resource)`, and there is
 * no `src/authz/` at all. Five handlers each make their own role decision inline, two of them make
 * none — which is how `export` came to hand a confidential document to anybody who asked — and the
 * work is to build the boundary, move every decision into it, and leave the handlers not knowing
 * what a role is.
 *
 * WHY "JUST PATCH THE CALLER" IS CAUGHT THREE WAYS, AND HAS TO BE. Adding the missing check to
 * `export.js` fixes the reported leak and passes every behaviour test in the repository — it is the
 * answer a benchmark that only checked behaviour would score full marks. `test/policy.test.js`
 * requires the module and fails when it is not there; the file invariants refuse a handler that
 * still names a role; and the hidden checks walk the whole of `docs/AUTHZ.md` against `authorize`
 * itself, which a per-caller patch never wrote. The third is the one that matters: a policy
 * implemented only for the actions the visible tests exercise is a partial boundary, and a partial
 * boundary is what this case exists to distinguish from a real one.
 *
 * NOTHING IS GUESSED. The module path, the two export names, the five action names, the four role
 * names and the complete decision table are all in `docs/`, and each hidden assertion quotes the
 * document it is enforcing.
 */
export const T3_PERMISSION_GATE_CENTRALIZE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t3.permission-gate.centralize',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_THREE,
  suiteVersion: WORKSPACE_SUITE_TIER_THREE_VERSION,
  title: 'Build the authorization boundary the architecture describes and nothing implements',
  description: 'Five handlers decide permission for themselves and two decide nothing at all. Patching '
    + 'the one that leaks passes every behaviour test; the case is about where the decision lives.',
  dimensions: ['repositoryComprehension', 'multiFileEditing', 'toolUse', 'scopeDiscipline', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/t3-permission-gate',
    expectedTreeDigest: 'c590d62529f75a03391e13b98a6a0a778dc521b3e2de7eb252e0de65b6890184',
  },
  task: {
    instruction: [
      'This service hands a confidential document to anybody who asks for it to be exported, and there is a second',
      'action with the same problem. Both are symptoms: docs/ARCHITECTURE.md says every permission decision in this',
      'service is made in one module, and that module does not exist — each handler decides for itself, which is how',
      'two of them came to decide nothing.',
      '',
      'Build the boundary docs/ARCHITECTURE.md describes, at the path it names, exporting what it says it exports, and',
      'route every handler through it. docs/AUTHZ.md is the decision itself, in full: the roles, the actions, the',
      'table, and what confidentiality, locking and archiving do to it.',
      '',
      'When you are done, no file under src/handlers/ knows the name of a role.',
      '',
      'Do not change any test. Do not change what the tests assert. Do not change anything under docs/.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 1_200_000,
    // ONE ATTEMPT. This case measures whether the structure was got right, and a second go after
    // being shown which cell of the table is wrong would measure filling in a table.
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'read-tests', kind: 'test', executable: 'node', args: ['test/read.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'update-tests', kind: 'test', executable: 'node', args: ['test/update.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'delete-tests', kind: 'test', executable: 'node', args: ['test/delete.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'export-tests', kind: 'test', executable: 'node', args: ['test/export.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'policy-tests', kind: 'test', executable: 'node', args: ['test/policy.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'browse-tests', kind: 'test', executable: 'node', args: ['test/browse.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'authorize-is-total', kind: 'hidden', executable: 'node',
        args: ['-e', AUTHZ_IS_TOTAL_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'narrowing-narrows', kind: 'hidden', executable: 'node',
        args: ['-e', AUTHZ_NARROWING_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'every-handler-asks', kind: 'hidden', executable: 'node',
        args: ['-e', AUTHZ_EVERY_HANDLER_ASKS_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      fileInvariant({ path: 'src/authz/policy.js', mustExist: true, mustContain: ['authorize', 'ACTIONS'] }),
      // `docs/ARCHITECTURE.md`: a handler must not know role names. Checked against the final tree,
      // because a boundary every caller walks around is not a boundary.
      fileInvariant({ path: 'src/handlers/read.js', mustExist: true, mustNotContain: ["'reader'", "'writer'", "'curator'", "'admin'"] }),
      fileInvariant({ path: 'src/handlers/update.js', mustExist: true, mustNotContain: ["'reader'", "'writer'", "'curator'", "'admin'"] }),
      fileInvariant({ path: 'src/handlers/delete.js', mustExist: true, mustNotContain: ["'reader'", "'writer'", "'curator'", "'admin'"] }),
      fileInvariant({ path: 'src/handlers/export.js', mustExist: true, mustNotContain: ["'reader'", "'writer'", "'curator'", "'admin'"] }),
      fileInvariant({ path: 'src/handlers/archive.js', mustExist: true, mustNotContain: ["'reader'", "'writer'", "'curator'", "'admin'"] }),
      fileInvariant({ path: 'src/handlers/index.js', mustExist: true,
        mustContain: ['readDocument', 'updateDocument', 'deleteDocument', 'exportDocument', 'archiveDocument'] }),
      // `docs/ARCHITECTURE.md`: the store knows nothing about actors, and must still not.
      fileInvariant({ path: 'src/store/documents.js', mustExist: true, mustNotContain: ['actor'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 12,
    maximumChangedLines: 500,
  },
  tags: ['architecture', 'javascript', 'multi-file', 'tier3'],
});

/**
 * Four failing suites, two independent defects, and neither one alone is enough.
 *
 * WHY THIS CASE EXISTS. `ws.t2.text-normalize.cluster` measures whether many symptoms can be traced
 * to ONE cause. This measures the opposite mistake and is harder for it: the symptoms trace to TWO,
 * they interact, and stopping after the first is the natural thing to do because the first fix makes
 * a whole suite go green. `src/order.js` sorts with a comparator that returns a boolean, so a log
 * that arrived out of a queue is only partly reordered; `src/apply.js` mutates the state it was
 * handed instead of answering with a new one, so replaying from a state somebody is holding changes
 * it. Fix the ordering and `order` passes while `apply`, `replay` and `snapshot` do not. Fix the
 * mutation and `apply` passes while `order`, `replay` and `snapshot` do not.
 *
 * THE INVARIANTS KEEP THE TWO DEFECTS WHERE THEY ARE. `replay.js` must still go through both
 * `inOrder` and `applyEvent`, so the failures cannot be routed around by reimplementing the loop —
 * which would pass the suites and leave the public surface answering wrongly for every other caller.
 */
export const T3_EVENT_REPLAY_PAIR: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t3.event-replay.pair',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_THREE,
  suiteVersion: WORKSPACE_SUITE_TIER_THREE_VERSION,
  title: 'Separate two interacting defects behind four failing suites',
  description: 'Ordering and purity are both broken, they interact, and fixing either one on its own '
    + 'makes one suite green and leaves three red.',
  dimensions: ['failureInterpretation', 'repositoryComprehension', 'testExecution', 'regressionAvoidance'],
  source: {
    fixturePath: 'workspace/t3-event-replay',
    expectedTreeDigest: 'e1617152c6d58423eec596acf57a5451a13d14f3cd50483ab6967412879d19d9',
  },
  task: {
    instruction: [
      'Four of the six test suites in this repository fail. Replaying a log gives the wrong balance, replaying the',
      'tail of a log from a snapshot does not agree with replaying the whole of it from nothing, and a state that a',
      'caller is holding does not survive being replayed from.',
      '',
      'These are not one problem seen four ways. Run the suites, read the failures, work out how many distinct things',
      'are wrong, and fix all of them. docs/REPLAY.md states what ordering, applying and replay each promise.',
      '',
      'Do not change any test. Do not change what the tests assert. Fix the code they are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 1_200_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'order-tests', kind: 'test', executable: 'node', args: ['test/order.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'apply-tests', kind: 'test', executable: 'node', args: ['test/apply.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'replay-tests', kind: 'test', executable: 'node', args: ['test/replay.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'snapshot-tests', kind: 'test', executable: 'node', args: ['test/snapshot.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'log-tests', kind: 'test', executable: 'node', args: ['test/log.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'report-tests', kind: 'test', executable: 'node', args: ['test/report.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'order-is-order', kind: 'hidden', executable: 'node',
        args: ['-e', REPLAY_ORDER_IS_ORDER_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'states-are-their-own', kind: 'hidden', executable: 'node',
        args: ['-e', REPLAY_STATES_ARE_THEIR_OWN_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'snapshot-equivalence', kind: 'hidden', executable: 'node',
        args: ['-e', REPLAY_SNAPSHOT_EQUIVALENCE_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      fileInvariant({ path: 'src/apply.js', mustExist: true, mustContain: ['applyEvent'] }),
      fileInvariant({ path: 'src/order.js', mustExist: true, mustContain: ['inOrder'] }),
      // `replay` must still be the two of them composed, so the suites cannot be satisfied by a loop
      // that reimplements ordering or application and leaves the exported ones wrong.
      fileInvariant({ path: 'src/replay.js', mustExist: true, mustContain: ['inOrder', 'applyEvent'] }),
      fileInvariant({ path: 'src/state.js', mustExist: true, mustContain: ['cloneState'] }),
      fileInvariant({ path: 'src/snapshot.js', mustExist: true, mustContain: ['cloneState'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 3,
    maximumChangedLines: 120,
  },
  tags: ['bugfix', 'decomposition', 'javascript', 'tier3'],
});

/**
 * Turn a two-hundred-line chain into a rule registry without a caller being able to tell.
 *
 * WHY THIS CASE EXISTS. Every other case asks for behaviour that is wrong to be made right. This
 * asks for behaviour that is already right to stay EXACTLY as it is while the thing producing it is
 * taken apart and put back together differently — which is most of what changing a real codebase
 * consists of, and which no amount of "make the failing test pass" measures.
 *
 * FOUR OUTCOMES, AND THE VERIFICATION TELLS THEM APART.
 *
 *   A correct refactor          six rule modules, a registry that is the order, a validator that is a
 *                               driver, identical errors. Passes everything.
 *   A partial migration         three rules moved, the rest left in the chain. The behaviour suites
 *                               still pass; `test/registry.test.js` and the standalone hidden check
 *                               do not.
 *   An architecture-violating   the chain kept somewhere and six thin objects filtering its output.
 *   workaround                  Behaviour is preserved and the registry exists, and the per-rule
 *                               invariants refuse it: the module that owns a condition has to be the
 *                               module the condition is written in.
 *   A regression                anything that changes a code, a message, a path or the order. The
 *                               behaviour suites catch it, and the baseline reading proves it was a
 *                               regression rather than a failure that was already there.
 *
 * `docs/RULES.md` is declared unchanging and `docs/` is forbidden, so the contract cannot be edited
 * to match whatever the answer did.
 */
export const T3_VALIDATOR_RULES_REFACTOR: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t3.validator-rules.refactor',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_THREE,
  suiteVersion: WORKSPACE_SUITE_TIER_THREE_VERSION,
  title: 'Refactor a validator into a rule registry with the behaviour byte-identical',
  description: 'Six rules inside one chain become six modules and a registry, and a caller must not be '
    + 'able to tell it happened. A partial migration and a wrapper both pass the behaviour suites.',
  // `patchCleanliness` rather than `toolUse`, and that is the difference between this case and
  // `ws.t3.permission-gate.centralize`: both rearrange a package, but this one is judged on what is
  // LEFT BEHIND. A wrapper that keeps the old chain somewhere passes every behaviour check and is
  // exactly the residue this dimension names.
  dimensions: ['repositoryComprehension', 'multiFileEditing', 'regressionAvoidance', 'scopeDiscipline',
    'patchCleanliness'],
  source: {
    fixturePath: 'workspace/t3-validator-rules',
    expectedTreeDigest: '6722dd4f8e968d9e24f2321954a9d996ca096ac4abd4dda19819cac03e25b966',
  },
  task: {
    instruction: [
      'This package checks a service configuration against six rules. They are all implemented as branches of one',
      'chain in src/validate.js, and docs/ARCHITECTURE.md says they are meant to be six modules under src/rules/ with',
      'a registry that holds them in order and a validator that does nothing but drive it.',
      '',
      'Make the package match docs/ARCHITECTURE.md.',
      '',
      'docs/RULES.md is the contract with a caller: the ids, the codes, the paths, the messages, the order the errors',
      'come back in, and the shape of an error. None of it changes. A caller must not be able to tell that anything',
      'happened.',
      '',
      'Two suites fail at the moment and both are about the arrangement rather than the behaviour.',
      '',
      'Do not change any test. Do not change what the tests assert. Do not change anything under docs/.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 1_200_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'rules-tests', kind: 'test', executable: 'node', args: ['test/rules.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'validate-tests', kind: 'test', executable: 'node', args: ['test/validate.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'registry-tests', kind: 'test', executable: 'node', args: ['test/registry.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'explain-tests', kind: 'test', executable: 'node', args: ['test/explain.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'report-tests', kind: 'test', executable: 'node', args: ['test/report.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'rules-stand-alone', kind: 'hidden', executable: 'node',
        args: ['-e', RULES_STAND_ALONE_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'rule-order-not-file-order', kind: 'hidden', executable: 'node',
        args: ['-e', RULES_ORDER_NOT_FILE_ORDER_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'registry-is-the-order', kind: 'hidden', executable: 'node',
        args: ['-e', RULES_REGISTRY_IS_THE_ORDER_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // `docs/ARCHITECTURE.md`: every condition lives in the rule module that owns it. Each rule
      // names its own id and carries its own distinctive literal, so a set of thin objects filtering
      // a chain that was kept somewhere else is refused rather than scored.
      fileInvariant({ path: 'src/rules/index.js', mustExist: true,
        mustContain: ['name-format', 'replica-count', 'port-range', 'image-tag', 'env-names', 'limits-present'] }),
      fileInvariant({ path: 'src/rules/name-format.js', mustExist: true, mustContain: ['name-format', 'NAME_FORMAT'] }),
      fileInvariant({ path: 'src/rules/replica-count.js', mustExist: true, mustContain: ['replica-count', '20'] }),
      fileInvariant({ path: 'src/rules/port-range.js', mustExist: true, mustContain: ['port-range', '1024', '65535'] }),
      fileInvariant({ path: 'src/rules/image-tag.js', mustExist: true, mustContain: ['image-tag', 'latest'] }),
      fileInvariant({ path: 'src/rules/env-names.js', mustExist: true, mustContain: ['env-names', 'ENV_NAME'] }),
      fileInvariant({ path: 'src/rules/limits-present.js', mustExist: true, mustContain: ['limits-present', '64'] }),
      // And the validator is a driver: none of the six conditions may still be written in it.
      fileInvariant({ path: 'src/validate.js', mustExist: true, mustContain: ['RULES'],
        mustNotContain: ['1024', '65535', 'NAME_FORMAT', 'latest'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 14,
    maximumChangedLines: 600,
  },
  tags: ['refactor', 'javascript', 'multi-file', 'tier3'],
});

/**
 * The longest one: read a pipeline, find the design point, change several stages, and finish.
 *
 * WHY THIS IS THE CASE THAT MEASURES SUSTAINED AGENTIC WORK. Four of six suites fail, for reasons
 * that live in three different stages, and none of them can be fixed without first working out what
 * the pipeline is doing: the importer decides that two rows are the same thing by looking at a
 * column called `id`, `docs/PIPELINE.md` is emphatic that the `id` column is not what identifies a
 * record, and the types already declare what does. Rows are dropped with no reason recorded, and
 * nothing collects the reasons into the report. That is a read, a design decision, edits in three
 * stages, a run, a reading of what is still red, and a finish — which is the shape of ordinary work
 * and the thing a single-file bug fix cannot measure.
 *
 * WHAT THE FIRST ATTEMPT IS EXPECTED TO GET WRONG, AND WHY THAT IS THE POINT. The natural
 * implementation of "later rows win" is to replace the surviving record with the later one. It is
 * correct about the key, correct about the counts, correct about the reasons, and it passes all six
 * visible suites. It is wrong about what a blank cell means: `docs/PIPELINE.md` says a blank in a
 * later row means the exporter had nothing to say, not that the field should be emptied, because
 * import files are assembled from partial exports. The hidden check hands it exactly that file, and
 * its output — quoted verbatim into the retry briefing — is a real report about a city that
 * disappeared.
 *
 * TWO ATTEMPTS, RECOVERY-WEIGHTED, for that reason: a model that reads the contract first can pass
 * on attempt 1, a model that recovers from a good failure report scores visibly below it, and a
 * model that cannot do either scores below both.
 */
export const T3_IMPORT_PIPELINE_FINISH: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.t3.import-pipeline.finish',
  version: '1',
  suiteID: WORKSPACE_SUITE_TIER_THREE,
  suiteVersion: WORKSPACE_SUITE_TIER_THREE_VERSION,
  title: 'Finish an import pipeline: the natural key, the merge, and the report',
  description: 'Four failing suites across three stages of a pipeline. The plausible first answer is '
    + 'right about what identifies a record and wrong about what a blank cell in a later row means.',
  dimensions: ['recoveryFromError', 'multiFileEditing', 'repositoryComprehension', 'failureInterpretation',
    'autonomousCompletion'],
  source: {
    fixturePath: 'workspace/t3-import-pipeline',
    expectedTreeDigest: '09c98fd2666c2aebe03babc76d551090b7413de2c5be10aa399714e88ec075d3',
  },
  task: {
    instruction: [
      'This importer reads a CSV file and produces records and a report. Four of its six test suites fail.',
      '',
      'Two things are wrong with it. It decides that two rows are about the same thing by comparing a column called',
      'id, and it drops rows without recording why, so the report cannot say what happened to them.',
      '',
      'docs/PIPELINE.md is the contract: what identifies a record of each type, what happens when several rows are',
      'the same record, and what the report says. Read it before you change the stages — it settles several questions',
      'the visible tests do not ask about.',
      '',
      'Run the suites, work out which stage each failure belongs to, and finish the pipeline.',
      '',
      'Do not change any test. Do not change what the tests assert. Do not change anything under docs/.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['test/**', 'docs/**'] },
  },
  execution: {
    timeoutMilliseconds: 1_500_000,
    // TWO. This is the case where the first attempt is EXPECTED to produce useful verification
    // feedback rather than to be wasted: the plausible first answer passes everything visible and
    // fails one hidden check whose output names precisely what went missing.
    maximumAttempts: 2,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      workspaceCommand({ id: 'csv-tests', kind: 'test', executable: 'node', args: ['test/csv.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'coerce-tests', kind: 'test', executable: 'node', args: ['test/coerce.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'validate-tests', kind: 'test', executable: 'node', args: ['test/validate.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'dedupe-tests', kind: 'test', executable: 'node', args: ['test/dedupe.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'pipeline-tests', kind: 'test', executable: 'node', args: ['test/pipeline.test.js'], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'report-tests', kind: 'test', executable: 'node', args: ['test/report.test.js'], timeoutMilliseconds: 30_000 }),
    ],
    hiddenCommands: [
      workspaceCommand({ id: 'later-rows-add', kind: 'hidden', executable: 'node',
        args: ['-e', IMPORT_LATER_ROWS_ADD_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'first-met-order', kind: 'hidden', executable: 'node',
        args: ['-e', IMPORT_FIRST_MET_ORDER_CHECK], timeoutMilliseconds: 30_000 }),
      workspaceCommand({ id: 'natural-key-is-the-key', kind: 'hidden', executable: 'node',
        args: ['-e', IMPORT_NATURAL_KEY_CHECK], timeoutMilliseconds: 30_000 }),
    ],
    invariants: [
      // The stages stay stages, and the one place that says what identifies a record stays that place.
      fileInvariant({ path: 'src/types.js', mustExist: true, mustContain: ['naturalKeyOf', 'naturalKeyField'] }),
      fileInvariant({ path: 'src/stages/dedupe.js', mustExist: true, mustContain: ['naturalKeyOf'], mustNotContain: ['record.fields.id'] }),
      fileInvariant({ path: 'src/stages/validate.js', mustExist: true, mustContain: ['naturalKeyOf'] }),
      fileInvariant({ path: 'src/stages/collect.js', mustExist: true, mustContain: ['reasons'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 6,
    maximumChangedLines: 300,
  },
  scoring: RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY,
  tags: ['agentic', 'javascript', 'multi-file', 'recovery', 'tier3'],
});

export const workspaceTierThreeSuite: WorkspaceSuite = makeWorkspaceSuite(
  WORKSPACE_SUITE_TIER_THREE,
  WORKSPACE_SUITE_TIER_THREE_VERSION,
  'Workspace tier three',
  [T3_PERMISSION_GATE_CENTRALIZE, T3_EVENT_REPLAY_PAIR, T3_VALIDATOR_RULES_REFACTOR, T3_IMPORT_PIPELINE_FINISH],
);
