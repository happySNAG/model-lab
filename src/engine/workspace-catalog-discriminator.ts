// Benchmark engine · the DISCRIMINATOR suite: cases built from what the tier matrices actually showed.
//
// WHY THIS IS NOT TIER 4. Twelve cells per tier, four Claude models, three repeats: Tier 1 separated
// one model on one case, Tier 2 separated one model on one case, and Tier 3 — structurally the
// hardest pack in the catalogue — was 48/48. The tier number describes the repository and it does
// that job; it did not predict which cases would separate anybody. A Tier 4 built by adding files,
// modules, tests or dependency depth would be the same bet a fourth time. So this suite is a
// different FAMILY, chosen from EVIDENCE: it isolates the kinds of reasoning that have actually
// separated candidates, or that no pack has yet been able to measure, and it claims no tier. Its
// cases carry a structural profile — the same counts every tier case carries, checked the same way
// — but not a tier, because the claim a tier makes ("harder than the one below") is not the claim
// this suite exists to test. See `workspace-discriminator.ts`.
//
// WHAT IT GENERALISES. The one Tier 2 case that separated anybody was `ws.t2.text-normalize.cluster`:
// three models kept a catch-all that deletes what it does not recognise, one model preserved it, and
// the contract said to preserve it. Reading the sealed records back shows the separation was
// decided by a FILE INVARIANT — `src/unicode.js still contains "[^\u0000-\u007f]"` — while both
// behavioural hidden checks passed for every model. That is a real finding about a real reasoning
// difference, and it is also one fixture and one textual check. Three cases here ask the same
// abstract question in unrelated domains, and decide it BEHAVIOURALLY:
//
//   ws.d1.config-migrate.upgrade    a config upgrade whose driver rebuilds the file from the keys
//                                   it knows, and whose rules fall back to defaults. The contract:
//                                   change what you recognise and nothing else.
//   ws.d1.asset-container.retitle   a chunked binary container edited through its decoded model.
//                                   The contract: an editor copies every chunk it was not asked to
//                                   change, including ones it cannot read.
//   ws.d1.log-redact.mask           a redactor that re-serialises what it parses and masks anything
//                                   that "looks random" in what it cannot. The contract: mask two
//                                   named things, pass everything else through byte for byte.
//
// WHAT IT ADDS. `ws.d1.catalog-paging.walk` is two modules whose invariants must agree — a total
// order and a cursor that resumes in it — where either fix alone passes some suites and not others.
// And the two recovery cases are built so that recovery can actually be OBSERVED, which no retry-
// capable case in any tier managed: every one was passed first time by every frontier model, so
// "recovery" was never exercised. `ws.d1.query-codec.nest` is checked by a deterministic property
// check that prints a concrete counterexample; `ws.d1.task-board.reassign` is checked by an
// integration that reads the board's secondary indexes after a change. In both, the visible suites
// pass for a natural first answer, the instruction says plainly that more verification exists and
// deliberately does not say where, and the failure report is specific enough to act on.
//
// THE CASE IDS NAME THE TASK, NEVER THE ANSWER. The workspace directory an agent works in is named
// after the case (`cernum-ws-<case-id>-…`), so an id is text the model can read. The tier ids carry
// their design in their suffix — `.recover`, `.diagnose`, `.cluster` — which is sealed and stays;
// these do not.
//
// NOTHING HERE IS A RIDDLE. Every hidden check asks for a consequence a document in the fixture
// states, and quotes it. Nothing here names a provider or a model, and every candidate receives the
// same sealed case.

import {
  RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY, WorkspaceCase, WorkspaceSuite, fileInvariant, makeWorkspaceCase,
  makeWorkspaceSuite, workspaceCommand,
} from './workspace-case';
import { hiddenScript } from './workspace-hidden-script';

export const WORKSPACE_SUITE_DISCRIMINATOR = 'suite.cernum.workspace.discriminator';
export const WORKSPACE_SUITE_DISCRIMINATOR_VERSION = '1';

/** Every discriminator case unlocks exactly what the tier cases unlock, and for the same reason. */
const SUBSCRIPTION_SESSION_ENVIRONMENT = ['HOME', 'USER'];

const RUN_AFTER_VERIFICATION = 'Your work is also verified by checks that are not in this repository.';

const test = (id: string, file: string) =>
  workspaceCommand({ id, kind: 'test', executable: 'node', args: [file], timeoutMilliseconds: 30_000 });
const hidden = (id: string, script: string) =>
  workspaceCommand({ id, kind: 'hidden', executable: 'node', args: ['-e', script], timeoutMilliseconds: 60_000 });

// MARK: - Hidden checks
//
// Written, run and proven against the reference solutions and the plausible wrong answers before
// they were sealed here; `workspace-discriminator.test.ts` runs them again on every build.

const CONFIG_UNRECOGNISED_KEYS_SURVIVE_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { loadConfig } = require('./src/index.js');",
  "const text = JSON.stringify({",
  "  name: 'svc',",
  "  'x-owner': 'team-payments',",
  "  timeout: '90s',",
  "  plugins: { lint: { strict: true, ignore: ['vendor/**'] } },",
  "  deploy: { strategy: 'blue-green', canaryPercent: 10, maxSurge: 1 },",
  "  notify: { slack: '#deploys', email: 'ops@example.test' },",
  "});",
  "const { config, warnings } = loadConfig(text);",
  "assert.strictEqual(config['x-owner'], 'team-payments',",
  "  'docs/MIGRATION.md: a key the upgrade does not recognise is carried into the result exactly as written');",
  "assert.deepStrictEqual(config.plugins, { lint: { strict: true, ignore: ['vendor/**'] } },",
  "  'docs/V2.md: shipit passes the whole configuration to every plugin, so a plugin section has to survive the upgrade');",
  "assert.strictEqual(config.deploy.canaryPercent, 10,",
  "  'docs/MIGRATION.md: inside deploy, a key the upgrade does not recognise stays where it was written');",
  "assert.strictEqual(config.deploy.strategy, 'blueGreen');",
  "assert.strictEqual(config.notify.email, 'ops@example.test',",
  "  'docs/MIGRATION.md: inside notify, a key the upgrade does not recognise stays where it was written');",
  "assert.deepStrictEqual(config.notify.channels, [{ kind: 'slack', target: '#deploys' }]);",
  "assert.deepStrictEqual(warnings, []);",
  "console.log('ok - what the upgrade does not recognise comes through it');",
]);

const CONFIG_UNREADABLE_VALUES_LEFT_AS_WRITTEN_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { upgrade } = require('./src/index.js');",
  "const { config, warnings } = upgrade({",
  "  name: 'svc', timeout: 'soon', color: 'sometimes', deploy: { strategy: 'canary', maxSurge: 1 },",
  "});",
  "assert.strictEqual(config.timeout, 'soon',",
  "  'docs/MIGRATION.md: a recognised key whose value cannot be interpreted is left exactly as written, under its version 1 name');",
  "assert.strictEqual(config.timeoutSeconds, undefined,",
  "  'docs/MIGRATION.md: a value the upgrade cannot interpret is never replaced with a default');",
  "assert.strictEqual(config.color, 'sometimes',",
  "  'docs/MIGRATION.md: an uninterpretable colour setting is left exactly as written');",
  "assert.strictEqual(config.deploy.strategy, 'canary',",
  "  'docs/MIGRATION.md: an unrecognised deploy strategy is left exactly as written, not swapped for another strategy');",
  "assert.strictEqual(config.deploy.maxSurge, 1);",
  "assert.deepStrictEqual(warnings.map((warning) => warning.path).sort(), ['color', 'deploy.strategy', 'timeout'],",
  "  'docs/MIGRATION.md: every value left as written is named in a warning by its dotted path');",
  "console.log('ok - what the upgrade cannot read is left for its author to see');",
]);

const SLAB_EDITS_COPY_OTHER_CHUNKS_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { readChunks, writeChunks, setName, addNote } = require('./src/index.js');",
  "const chunk = (type, text) => ({ type, data: Buffer.from(text, 'utf8') });",
  "const original = [",
  "  { type: 'HEAD', data: Buffer.from([0, 2, 0, 2]) },",
  "  chunk('grid', 'cell=16x16'),",
  "  chunk('name', 'Old title'),",
  "  { type: 'PIXL', data: Buffer.from([1, 2, 3, 4]) },",
  "  chunk('LAYR', 'layer 2 of 2: shading'),",
  "  { type: 'PIXL', data: Buffer.from([5, 6, 7, 8]) },",
  "  chunk('note', 'drawn by hand'),",
  "  chunk('xmpk', 'palette=warm'),",
  "  { type: 'TAIL', data: Buffer.alloc(0) },",
  "];",
  "const slab = writeChunks(original);",
  "const describe = (chunks) => chunks.map((entry) => `${entry.type}:${entry.data.toString('hex')}`);",
  "const renamed = readChunks(setName(slab, 'Nuevo título'));",
  "const expectedAfterRename = original.map((entry) => (entry.type === 'name' ? chunk('name', 'Nuevo título') : entry));",
  "assert.deepStrictEqual(describe(renamed), describe(expectedAfterRename),",
  "  'docs/FORMAT.md: an editor changes the chunks it was asked to change and copies every other chunk exactly, in the same place, including chunks it does not understand');",
  "const noted = readChunks(addNote(slab, 'second pass'));",
  "const expectedAfterNote = [...original.slice(0, -1), chunk('note', 'second pass'), original[original.length - 1]];",
  "assert.deepStrictEqual(describe(noted), describe(expectedAfterNote),",
  "  'docs/FORMAT.md: adding a note puts one note chunk immediately before TAIL and copies every other chunk exactly');",
  "console.log('ok - edits keep every chunk they were not asked to change');",
]);

const SLAB_REMOVE_NOTES_REMOVES_NOTES_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { readChunks, writeChunks, removeNotes, setName } = require('./src/index.js');",
  "const chunk = (type, text) => ({ type, data: Buffer.from(text, 'utf8') });",
  "const original = [",
  "  { type: 'HEAD', data: Buffer.from([0, 1, 0, 1]) },",
  "  chunk('note', 'first'),",
  "  chunk('prov', 'exported by tilekit 4.2'),",
  "  { type: 'PIXL', data: Buffer.from([9]) },",
  "  chunk('note', 'second'),",
  "  chunk('ANIM', 'frames=1'),",
  "  { type: 'TAIL', data: Buffer.alloc(0) },",
  "];",
  "const describe = (chunks) => chunks.map((entry) => `${entry.type}:${entry.data.toString('hex')}`);",
  "const cleaned = readChunks(removeNotes(writeChunks(original)));",
  "assert.deepStrictEqual(describe(cleaned), describe(original.filter((entry) => entry.type !== 'note')),",
  "  'docs/FORMAT.md: removing notes removes the note chunks, and every other chunk is copied exactly, ancillary or critical');",
  "const named = readChunks(setName(writeChunks(original), 'Walk cycle'));",
  "assert.deepStrictEqual(named.map((entry) => entry.type), ['HEAD', 'note', 'prov', 'name', 'PIXL', 'note', 'ANIM', 'TAIL'],",
  "  'docs/FORMAT.md: a new name chunk goes after HEAD and before the first PIXL, and nothing else moves');",
  "console.log('ok - removing notes removes notes and nothing else');",
]);

const REDACT_UNTOUCHED_LINES_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { redactLine, redactText } = require('./src/index.js');",
  "const untouched = [",
  "  '{\"level\": \"info\", \"msg\": \"charged\", \"amount\": 1.50, \"city\": \"Z\\\\u00fcrich\"}',",
  "  'level=info  msg=\"deploy finished\" status=\"200\" commit=3f9c2e7a1b4d5e6f708192a3b4c5d6e7f8091a2b',",
  "  'level=info request_id=6f1c2a9e-4b7d-4e2a-9c1f-0a2b3c4d5e6f duration_ms=412',",
  "  '    at chargeCard (/srv/app/charge.js:42:13) build=9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc',",
  "  'checksum sha256:1b4f0e9851971998e732078544c96b36c3d01cedf7caa332359d6f1d83567014 verified',",
  "  '',",
  "  '   ',",
  "];",
  "for (const line of untouched) {",
  "  assert.strictEqual(redactLine(line), line,",
  "    'docs/REDACTION.md: a line with nothing to mask is passed on exactly as it arrived, in every shape, and a line is never dropped or replaced');",
  "}",
  "const block = untouched.join('\\n');",
  "assert.strictEqual(redactText(block), block,",
  "  'docs/REDACTION.md: a block with nothing to mask comes back exactly as it arrived, blank lines included');",
  "console.log('ok - lines with nothing to mask are passed on untouched');",
]);

const REDACT_PRECISE_MASKING_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { redactLine } = require('./src/index.js');",
  "const TOKEN = 'acme_pat_R4t7Yu2Io9Pa5Sd8Fg1Hj6Kl';",
  "const signup = JSON.stringify({",
  "  event: 'signup', trace: '0af7651916cd43dd8448eb211c80319c',",
  "  user: { id: 'u_48213', email: 'ada@example.test', plan: 'pro', referrer: { code: 'SPRING24', phone: '5550100' } },",
  "  tags: ['beta', 'eu'],",
  "});",
  "assert.deepStrictEqual(JSON.parse(redactLine(signup)), {",
  "  event: 'signup', trace: '0af7651916cd43dd8448eb211c80319c',",
  "  user: { id: 'u_48213', email: '[masked]', plan: 'pro', referrer: { code: 'SPRING24', phone: '[masked]' } },",
  "  tags: ['beta', 'eu'],",
  "}, 'docs/REDACTION.md: personal-data fields are masked at any depth and every field without a rule is kept with its value');",
  "const deploy = JSON.stringify({ msg: `pushed with ${TOKEN}`, commit: '3f9c2e7a1b4d5e6f708192a3b4c5d6e7f8091a2b' });",
  "assert.deepStrictEqual(JSON.parse(redactLine(deploy)), { msg: 'pushed with [masked]', commit: '3f9c2e7a1b4d5e6f708192a3b4c5d6e7f8091a2b' },",
  "  'docs/REDACTION.md: only the formats in CREDENTIAL_FORMATS are credentials; a commit hash is left alone');",
  "assert.strictEqual(",
  "  redactLine('level=info  user=ada card_number=\"4111 1111 1111 1111\" build=9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc region=\"eu west\"'),",
  "  'level=info  user=ada card_number=\"[masked]\" build=9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc region=\"eu west\"',",
  "  'docs/REDACTION.md: a logfmt line with something to mask changes only in the masked spans');",
  "assert.strictEqual(",
  "  redactLine(`TypeError: cannot read status of undefined (token ${TOKEN}, request 6f1c2a9e-4b7d-4e2a-9c1f-0a2b3c4d5e6f)`),",
  "  'TypeError: cannot read status of undefined (token [masked], request 6f1c2a9e-4b7d-4e2a-9c1f-0a2b3c4d5e6f)',",
  "  'docs/REDACTION.md: on a text line only the credential changes');",
  "console.log('ok - masking is precise');",
]);

const PAGING_CURSOR_OUTLIVES_ITS_PRODUCT_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { createStore, insert, remove, walkAll, filters } = require('./src/index.js');",
  "const make = (id, rank, category) => ({ id, name: id, category, rank, stock: 1 });",
  "const catalogue = () => createStore([",
  "  make('p-07', 90, 'outdoor'), make('p-02', 70, 'kitchen'), make('p-11', 70, 'outdoor'), make('p-04', 70, 'kitchen'),",
  "  make('p-09', 50, 'outdoor'), make('p-01', 50, 'kitchen'), make('p-12', 40, 'outdoor'), make('p-05', 30, 'kitchen'),",
  "  make('p-03', 30, 'garden'), make('p-10', 30, 'garden'), make('p-06', 10, 'garden'), make('p-08', 10, 'kitchen'),",
  "]);",
  "const ids = (products) => products.map((product) => product.id);",
  "const store = catalogue();",
  "const walked = walkAll(store, {",
  "  limit: 5,",
  "  between: (page) => {",
  "    if (page === 1) remove(store, 'p-01');",
  "    if (page === 2) { remove(store, 'p-10'); remove(store, 'p-12'); }",
  "  },",
  "});",
  "assert.deepStrictEqual(ids(walked),",
  "  ['p-07', 'p-02', 'p-04', 'p-11', 'p-01', 'p-09', 'p-12', 'p-03', 'p-05', 'p-10', 'p-06', 'p-08'],",
  "  'docs/PAGING.md: a cursor keeps its meaning after the product it came from is withdrawn, and every product in the catalogue for the whole walk comes back exactly once, in order');",
  "const kitchen = catalogue();",
  "const walkedKitchen = walkAll(kitchen, {",
  "  limit: 2, filter: filters.inCategory('kitchen'),",
  "  between: (page) => { if (page === 1) remove(kitchen, 'p-04'); },",
  "});",
  "assert.deepStrictEqual(ids(walkedKitchen), ['p-02', 'p-04', 'p-01', 'p-05', 'p-08'],",
  "  'docs/PAGING.md: a filtered walk keeps its place when the product its cursor came from is withdrawn');",
  "console.log('ok - a cursor keeps its meaning without its product');",
]);

const PAGING_ADDED_PRODUCTS_LAND_IN_ORDER_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const { createStore, insert, remove, walkAll } = require('./src/index.js');",
  "const make = (id, rank) => ({ id, name: id, category: 'any', rank, stock: 1 });",
  "const store = createStore([",
  "  make('p-07', 90), make('p-02', 70), make('p-11', 70), make('p-04', 70), make('p-09', 50), make('p-01', 50),",
  "  make('p-12', 40), make('p-05', 30), make('p-03', 30), make('p-10', 30), make('p-06', 10), make('p-08', 10),",
  "]);",
  "const walked = walkAll(store, {",
  "  limit: 5,",
  "  between: (page) => {",
  "    if (page !== 1) return;",
  "    insert(store, make('p-000', 50));",
  "    insert(store, make('p-05x', 50));",
  "    remove(store, 'p-01');",
  "  },",
  "}).map((product) => product.id);",
  "assert.deepStrictEqual(walked,",
  "  ['p-07', 'p-02', 'p-04', 'p-11', 'p-01', 'p-05x', 'p-09', 'p-12', 'p-03', 'p-05', 'p-10', 'p-06', 'p-08'],",
  "  'docs/PAGING.md: a product added during a walk is returned if it belongs after the place the walk has reached, and not if it belongs before it, including among products of equal rank');",
  "console.log('ok - added products land where the order puts them');",
]);

const QUERY_ROUND_TRIP_PROPERTY_CHECK = hiddenScript([
  "const { encodeQuery, decodeQuery } = require('./src/index.js');",
  "let state = 0x5eed1e55;",
  "const random = () => {",
  "  state = (state + 0x6d2b79f5) | 0;",
  "  let t = Math.imul(state ^ (state >>> 15), 1 | state);",
  "  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;",
  "  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;",
  "};",
  "const pick = (list) => list[Math.floor(random() * list.length)];",
  "const CHARACTERS = ['a', 'b', 'q', '0', '7', ' ', '&', '=', '[', ']', '%', '+', '?', '#', '/', '.', '-', '_',",
  "  'é', '漢', '😀'];",
  "const text = (least, most) => {",
  "  let out = '';",
  "  const length = least + Math.floor(random() * (most - least + 1));",
  "  for (let index = 0; index < length; index++) out += pick(CHARACTERS);",
  "  return out;",
  "};",
  "const value = (depth) => {",
  "  const roll = random();",
  "  if (depth <= 0 || roll < 0.45) return text(0, 4);",
  "  if (roll < 0.7) return Array.from({ length: 1 + Math.floor(random() * 3) }, () => text(0, 3));",
  "  return parametersOf(depth - 1);",
  "};",
  "const parametersOf = (depth) => {",
  "  const out = {};",
  "  const size = 1 + Math.floor(random() * 3);",
  "  for (let index = 0; index < size; index++) out[text(1, 3)] = value(depth);",
  "  return out;",
  "};",
  "const canonical = (entry) => {",
  "  if (Array.isArray(entry)) return entry.map(canonical);",
  "  if (entry !== null && typeof entry === 'object') {",
  "    return Object.keys(entry).sort().map((key) => [key, canonical(entry[key])]);",
  "  }",
  "  return entry;",
  "};",
  "const CASES = 600;",
  "for (let index = 1; index <= CASES; index++) {",
  "  const parameters = parametersOf(index <= 150 ? 0 : index <= 350 ? 1 : 3);",
  "  const encoded = encodeQuery(parameters);",
  "  let decoded;",
  "  let failure;",
  "  try {",
  "    decoded = decodeQuery(encoded);",
  "    if (JSON.stringify(canonical(decoded)) !== JSON.stringify(canonical(parameters))) failure = 'different';",
  "  } catch (error) {",
  "    failure = `threw ${error.name}: ${error.message}`;",
  "  }",
  "  if (failure !== undefined) {",
  "    console.log('docs/QUERY.md: decodeQuery(encodeQuery(parameters)) gives back parameters for every parameter object the format describes.');",
  "    console.log(`counterexample ${index} of ${CASES}:`);",
  "    console.log(`  parameters  ${JSON.stringify(parameters)}`);",
  "    console.log(`  encoded     ${encoded}`);",
  "    console.log(`  decoded     ${failure === 'different' ? JSON.stringify(decoded) : failure}`);",
  "    process.exit(1);",
  "  }",
  "}",
  "console.log(`ok - ${CASES} generated parameter objects read back as they were written`);",
]);

const BOARD_LISTS_AGREE_WITH_TASKS_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const board = require('./src/index.js');",
  "const ids = (tasks) => tasks.map((task) => task.id);",
  "const scan = (b, test) => ['t-1', 't-2', 't-3', 't-4'].filter((id) => test(board.getTask(b, id)));",
  "const b = board.createBoard({ members: ['ada', 'lin', 'sam'] });",
  "board.addTask(b, { id: 't-1', title: 'Write the importer', owner: 'ada', labels: ['backend'] });",
  "board.addTask(b, { id: 't-2', title: 'Fix the login page', owner: 'ada', labels: ['bug', 'ui'] });",
  "board.addTask(b, { id: 't-3', title: 'Plan the release', owner: 'lin', labels: ['bug'] });",
  "board.addTask(b, { id: 't-4', title: 'Archive old boards', owner: 'sam', labels: [] });",
  "board.closeTask(b, 't-4');",
  "board.reassignTask(b, 't-1', 'lin');",
  "assert.deepStrictEqual(ids(board.tasksFor(b, 'ada')), scan(b, (task) => task.owner === 'ada'),",
  "  'docs/BOARD.md: the lists a view reads always agree with the tasks; after t-1 moved from ada to lin, this is what tasksFor(ada) returned');",
  "assert.deepStrictEqual(ids(board.tasksFor(b, 'lin')), scan(b, (task) => task.owner === 'lin'),",
  "  'docs/BOARD.md: the lists a view reads always agree with the tasks; this is what tasksFor(lin) returned after t-1 moved to lin');",
  "assert.deepStrictEqual([board.openCount(b, 'ada'), board.openCount(b, 'lin')],",
  "  [scan(b, (task) => task.owner === 'ada' && task.state === 'open').length,",
  "    scan(b, (task) => task.owner === 'lin' && task.state === 'open').length],",
  "  'docs/BOARD.md: openCount answers what a scan of the tasks answers; these are openCount(ada) and openCount(lin) after t-1 moved from ada to lin');",
  "board.relabelTask(b, 't-2', ['ui', 'docs']);",
  "for (const label of ['bug', 'ui', 'docs']) {",
  "  assert.deepStrictEqual(ids(board.tasksLabelled(b, label)), scan(b, (task) => task.labels.includes(label)),",
  "    `docs/BOARD.md: the lists a view reads always agree with the tasks; this is what tasksLabelled(${label}) returned after t-2 was relabelled from bug, ui to docs, ui`);",
  "}",
  "console.log('ok - every list a view reads agrees with the tasks after a change');",
]);

const BOARD_REFUSED_CHANGE_CHANGES_NOTHING_CHECK = hiddenScript([
  "const assert = require('node:assert');",
  "const board = require('./src/index.js');",
  "const snapshot = (b) => JSON.stringify({",
  "  tasks: ['t-1', 't-2', 't-3'].map((id) => board.getTask(b, id)),",
  "  lists: ['ada', 'lin', 'sam'].map((name) => [board.tasksFor(b, name).map((task) => task.id), board.openCount(b, name)]),",
  "  labels: ['bug', 'ui'].map((label) => board.tasksLabelled(b, label).map((task) => task.id)),",
  "  history: board.historyOf(b).length,",
  "});",
  "const b = board.createBoard({ members: ['ada', 'lin', 'sam'] });",
  "board.addTask(b, { id: 't-1', title: 'Write the importer', owner: 'ada', labels: ['bug'] });",
  "board.addTask(b, { id: 't-2', title: 'Fix the login page', owner: 'lin', labels: ['ui'] });",
  "board.addTask(b, { id: 't-3', title: 'Ship the fix', owner: 'sam', labels: ['bug'] });",
  "board.closeTask(b, 't-3');",
  "const before = snapshot(b);",
  "assert.throws(() => board.reassignTask(b, 't-1', 'eve'), board.UnknownMemberError);",
  "assert.strictEqual(snapshot(b), before,",
  "  'docs/BOARD.md: a change that is refused changes nothing; reassigning t-1 to eve, who is not on the team, was refused and left this behind');",
  "assert.throws(() => board.reassignTask(b, 't-3', 'ada'), board.TaskClosedError);",
  "assert.strictEqual(snapshot(b), before,",
  "  'docs/BOARD.md: a change that is refused changes nothing; reassigning closed task t-3 was refused and left this behind');",
  "assert.throws(() => board.relabelTask(b, 't-3', ['ui']), board.TaskClosedError);",
  "assert.strictEqual(snapshot(b), before,",
  "  'docs/BOARD.md: a change that is refused changes nothing; relabelling closed task t-3 was refused and left this behind');",
  "console.log('ok - a refused change changes nothing');",
]);

// MARK: - Preserve what you do not recognise

/**
 * Upgrade a version 1 configuration in memory, changing what is recognised and nothing else.
 *
 * THE SHAPE OF THE TEMPTATION. `upgrade` walks the RULES and builds a fresh object from what they
 * return, so every key no rule names is gone; the section rules rebuild `deploy` and `notify` from
 * the fields they know; a timeout that is not a duration becomes the default; an unknown strategy
 * becomes `rolling`. Three suites fail for three different-looking reasons — a minute read as
 * nothing, a colour that disappears, a renamed strategy that comes out as a different one — and
 * every one of them can be fixed inside the rules while the driver keeps deleting.
 *
 * WHAT DECIDES IT. `docs/MIGRATION.md` states the rule in bold and then twice more: a key it does
 * not recognise is carried across as written, inside a section as well as at the top; a value it
 * cannot interpret is left as written with a warning, never defaulted. `docs/V2.md` says why — every
 * plugin reads the whole file. The two hidden checks ask for exactly those, behaviourally.
 */
export const D1_CONFIG_MIGRATE_UPGRADE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.d1.config-migrate.upgrade',
  version: '1',
  suiteID: WORKSPACE_SUITE_DISCRIMINATOR,
  suiteVersion: WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  title: 'Finish a configuration upgrade that must change only what it recognises',
  description: 'Three suites fail three ways in the rules of a v1-to-v2 config upgrade; the driver and the '
    + 'rules both fall back to deleting or defaulting what they do not recognise, which the contract forbids.',
  dimensions: [
    'preservationUnderTransformation', 'destructiveFallbackAvoidance', 'contractOverVisibleTests',
    'failureInterpretation', 'multiFileEditing',
  ],
  source: {
    fixturePath: 'workspace/d1-config-migrate',
    expectedTreeDigest: '45df23ab719bf08525a0e64529a1f720e95184610ba422b79909420f97fcd192',
  },
  task: {
    instruction: [
      'shipit 2 reads configuration files written for shipit 1 by upgrading them as it loads them, and the',
      'upgrade is incomplete: three test suites fail, in different ways.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. docs/V2.md',
      'describes the version 2 format, and docs/MIGRATION.md is the contract the upgrade has to keep.',
      '',
      'Do not change any test, any example file or the documentation. Fix the code the tests are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'examples/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('durations-tests', 'test/durations.test.js'),
      test('upgrade-tests', 'test/upgrade.test.js'),
      test('load-tests', 'test/load.test.js'),
    ],
    hiddenCommands: [
      hidden('unrecognised-keys-survive', CONFIG_UNRECOGNISED_KEYS_SURVIVE_CHECK),
      hidden('unreadable-values-left-as-written', CONFIG_UNREADABLE_VALUES_LEFT_AS_WRITTEN_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/upgrade.js', mustExist: true, mustContain: ['upgrade'] }),
      fileInvariant({ path: 'src/rules.js', mustExist: true, mustContain: ['RULES'] }),
      fileInvariant({ path: 'src/durations.js', mustExist: true, mustContain: ['parseDuration'] }),
    ],
    forbiddenChanges: ['docs/**', 'examples/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 4,
    maximumChangedLines: 160,
  },
  tags: ['bugfix', 'discriminator', 'javascript', 'preserve-unknown'],
});

/**
 * Fix a chunked container's editor, which must copy every chunk it was not asked to change.
 *
 * THE SHAPE OF THE TEMPTATION. `setName` and `removeNotes` decode the file into an image and encode
 * a new one, and `encode` has two visible bugs: the name goes after the pixels, and it is written as
 * Latin-1. Fixing `encode` turns the suites green and leaves the editor throwing away every chunk
 * the image model has no field for — and refusing outright a file that carries a critical chunk it
 * cannot display, since `decode` rightly refuses those. `addNote` fails differently (it appends after
 * `TAIL`) and has two fixes that pass: splice before `TAIL`, or go through the model like the others.
 *
 * WHAT DECIDES IT. `docs/FORMAT.md` distinguishes reading from editing in so many words: a reader
 * skips what it does not understand, an editor copies it exactly, critical or ancillary, in place.
 * `removeNotes` removes notes — not "metadata", not every ancillary chunk. Both hidden checks compare
 * the chunk sequence byte for byte.
 */
export const D1_ASSET_CONTAINER_RETITLE: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.d1.asset-container.retitle',
  version: '1',
  suiteID: WORKSPACE_SUITE_DISCRIMINATOR,
  suiteVersion: WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  title: 'Fix a container editor that must copy every chunk it was not asked to change',
  description: 'Naming, noting and un-noting a chunked image file; the editor goes through a decoded model '
    + 'that has no field for chunks it does not understand, and the format says an editor keeps them.',
  dimensions: [
    'forwardCompatibilityReasoning', 'preservationUnderTransformation', 'destructiveFallbackAvoidance',
    'contractOverVisibleTests', 'failureInterpretation',
  ],
  source: {
    fixturePath: 'workspace/d1-asset-container',
    expectedTreeDigest: '6d7c3960d616b5476630a26847a947446f8d87873366a66834faa8e2c41072d8',
  },
  task: {
    instruction: [
      'Editing slabs is broken: naming an image puts its name in the wrong place, a name written outside ASCII',
      'does not read back, and adding a note produces a file that no longer reads. Two test suites fail.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. docs/FORMAT.md is',
      'the slab format, including what a tool that rewrites a slab may and may not do to it.',
      '',
      'Do not change any test or the documentation. Fix the code the tests are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('chunks-tests', 'test/chunks.test.js'),
      test('encode-tests', 'test/encode.test.js'),
      test('edit-tests', 'test/edit.test.js'),
    ],
    hiddenCommands: [
      hidden('edits-copy-other-chunks', SLAB_EDITS_COPY_OTHER_CHUNKS_CHECK),
      hidden('remove-notes-removes-notes', SLAB_REMOVE_NOTES_REMOVES_NOTES_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/chunks.js', mustExist: true, mustContain: ['readChunks', 'writeChunks'] }),
      fileInvariant({ path: 'src/decode.js', mustExist: true, mustContain: ['decode'] }),
      fileInvariant({ path: 'src/edit.js', mustExist: true, mustContain: ['setName', 'addNote', 'removeNotes'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 3,
    maximumChangedLines: 140,
  },
  tags: ['binary-format', 'bugfix', 'discriminator', 'forward-compatibility', 'javascript'],
});

/**
 * Stop personal data leaking through a log redactor without making it mask what it must not.
 *
 * THE SHAPE OF THE TEMPTATION. The redactor already has a catch-all: text it cannot parse goes
 * through `maskMachineLooking`, which masks any long mixed token. It re-serialises every JSON line
 * and rebuilds every logfmt line, so a line with nothing to mask still comes out different. The
 * visible failures — a nested email, a quoted card number, a token inside a JSON message — are each
 * most quickly fixed by widening what gets masked: recurse and re-serialise, run the heuristic over
 * JSON strings too. Every one of those passes the suites.
 *
 * WHAT DECIDES IT. `docs/REDACTION.md` says exactly two things are masked, lists what is left alone
 * — spacing, quoting, number formatting, unparseable lines, commit hashes and request ids — and says
 * a line with nothing to mask passes byte for byte. The field and format lists are the security
 * team's and are out of scope, so the policy cannot be widened to make a test pass.
 */
export const D1_LOG_REDACT_MASK: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.d1.log-redact.mask',
  version: '1',
  suiteID: WORKSPACE_SUITE_DISCRIMINATOR,
  suiteVersion: WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  title: 'Mask exactly what the policy names in three log shapes, and pass everything else through',
  description: 'Three leaks across JSON and logfmt lines; the redactor re-serialises what it parses and masks '
    + 'anything machine-looking in what it cannot, and the contract forbids both.',
  dimensions: [
    'destructiveFallbackAvoidance', 'preservationUnderTransformation', 'contractOverVisibleTests',
    'failureInterpretation', 'regressionAvoidance',
  ],
  source: {
    fixturePath: 'workspace/d1-log-redact',
    expectedTreeDigest: 'e6a9dd36b4e6fb14c5b090aa414bdb96881c7509c6a751fb1ba8688a16897ea2',
  },
  task: {
    instruction: [
      'Personal data and credentials are getting through the log redactor: a nested email address, a card number',
      'written with spaces, and an access token inside a JSON message all come out unmasked. Two test suites fail.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. docs/REDACTION.md',
      'says exactly what redaction masks and what it must leave alone.',
      '',
      'Do not change any test or the documentation. Fix the code the tests are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'src/fields.js', 'src/formats.js', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('json-tests', 'test/json.test.js'),
      test('logfmt-tests', 'test/logfmt.test.js'),
      test('text-tests', 'test/text.test.js'),
    ],
    hiddenCommands: [
      hidden('untouched-lines-stay-identical', REDACT_UNTOUCHED_LINES_CHECK),
      hidden('masking-is-precise', REDACT_PRECISE_MASKING_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/redact.js', mustExist: true, mustContain: ['redactLine', 'SENSITIVE_FIELDS', 'CREDENTIAL_FORMATS'] }),
      fileInvariant({ path: 'src/pipeline.js', mustExist: true, mustContain: ['redactLine'] }),
    ],
    forbiddenChanges: ['docs/**', 'src/fields.js', 'src/formats.js', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 3,
    maximumChangedLines: 180,
  },
  tags: ['bugfix', 'discriminator', 'javascript', 'redaction'],
});

// MARK: - Two invariants that have to agree

/**
 * Make paging through a changing catalogue reliable: a total order, and a cursor that resumes in it.
 *
 * TWO MODULES, ONE INVARIANT BETWEEN THEM. `order.js` leaves ties unresolved and `page.js` resumes
 * from an offset. Fixing the order turns `order.test.js` green and leaves every walk that crosses a
 * change broken. Replacing the offset with "the id of the last product, find it and carry on" turns
 * every visible suite green — and loses its place the moment that product is withdrawn, which
 * `docs/PAGING.md` names as the case a cursor must survive. Resuming by rank alone skips ties at a
 * page boundary, which a visible suite already catches. Only a cursor that carries the SORT KEY and
 * resumes with the SAME comparison the listing sorts by satisfies both documents at once.
 */
export const D1_CATALOG_PAGING_WALK: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.d1.catalog-paging.walk',
  version: '1',
  suiteID: WORKSPACE_SUITE_DISCRIMINATOR,
  suiteVersion: WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  title: 'Make a cursor walk through a changing catalogue return every product exactly once',
  description: 'The listing order is not total and the cursor is an offset; the order and the cursor must '
    + 'agree, and a cursor must keep its meaning when the product it came from is withdrawn.',
  dimensions: [
    'interactingInvariantReasoning', 'contractOverVisibleTests', 'failureInterpretation', 'multiFileEditing',
    'repositoryComprehension',
  ],
  source: {
    fixturePath: 'workspace/d1-catalog-paging',
    expectedTreeDigest: '4908656ce2296f348e5ef65caab22e3478b969229fa588774b7625f6a13f46e3',
  },
  task: {
    instruction: [
      'Paging through the catalogue is unreliable: products with the same rank come back in the wrong order, and',
      'a walk through the listing skips or repeats products when the catalogue changes between pages. Three test',
      'suites fail.',
      '',
      'Run them, read the failures, and fix the implementation so that every assertion passes. docs/PAGING.md',
      'states the order and what a caller can rely on while the catalogue changes.',
      '',
      'Do not change any test or the documentation. Fix the code the tests are testing.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 1,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('order-tests', 'test/order.test.js'),
      test('page-tests', 'test/page.test.js'),
      test('cursor-tests', 'test/cursor.test.js'),
      test('export-tests', 'test/export.test.js'),
    ],
    hiddenCommands: [
      hidden('cursor-outlives-its-product', PAGING_CURSOR_OUTLIVES_ITS_PRODUCT_CHECK),
      hidden('added-products-land-in-order', PAGING_ADDED_PRODUCTS_LAND_IN_ORDER_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/order.js', mustExist: true, mustContain: ['compareProducts'] }),
      // The listing is sorted by the shared order, not by a second opinion about it inside page.js.
      fileInvariant({ path: 'src/page.js', mustExist: true, mustContain: ['compareProducts'] }),
      fileInvariant({ path: 'src/cursor.js', mustExist: true, mustContain: ['encodeCursor', 'decodeCursor'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 4,
    maximumChangedLines: 120,
  },
  tags: ['bugfix', 'discriminator', 'javascript', 'pagination'],
});

// MARK: - Recovery that can actually be observed

/**
 * Add nested parameters to a query-string codec whose promise is a round trip.
 *
 * WHY RECOVERY IS MEASURABLE HERE WHEN IT WAS NOT IN ANY TIER. Every earlier recovery case pointed
 * its instruction at the paragraph its hidden check enforced, and every frontier model read it and
 * passed first time; the retry was never used. Here the rule is stated — `docs/QUERY.md` promises
 * `decodeQuery(encodeQuery(p))` deep-equals `p` for any key and value, including `&`, `=`, `[`, `]`,
 * `%`, `+` and non-ASCII — and the instruction names the document as the format, but what CANNOT be
 * known in advance is which edge of that promise a particular implementation gets wrong. The visible
 * suites are examples; the hidden check is a deterministic property check over six hundred
 * generated parameter objects that stops at the first counterexample and prints it: the input, the
 * text it was written as, and what came back. Three natural first answers — numeric keys read as
 * array indices, names decoded before their brackets are found, `+` handled after decoding — pass
 * every visible suite and are each caught with a different, concrete counterexample. An answer
 * carrying two of them that fixes only the one it was shown meets the other on attempt two.
 */
export const D1_QUERY_CODEC_NEST: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.d1.query-codec.nest',
  version: '1',
  suiteID: WORKSPACE_SUITE_DISCRIMINATOR,
  suiteVersion: WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  title: 'Add nested query parameters to a codec whose promise is an exact round trip',
  description: 'A feature with example-based visible tests and a property-based check that prints a concrete '
    + 'counterexample; recovery is reading that counterexample and fixing the class of fault, not the instance.',
  dimensions: [
    'verificationDrivenRecovery', 'secondAttemptAdaptation', 'contractOverVisibleTests', 'failureInterpretation',
  ],
  source: {
    fixturePath: 'workspace/d1-query-codec',
    expectedTreeDigest: '11f5ec3396b5137d257da2b2bd6ea877049d26cd4f04e1b6bf078e1fc08fcf19',
  },
  task: {
    instruction: [
      'The issue tracker\'s new filter panel needs structured query parameters, such as',
      'filter[status]=open&filter[labels][]=bug, and src/query.js only handles flat ones.',
      '',
      'Extend encodeQuery and decodeQuery to support nested objects and arrays in the format docs/QUERY.md',
      'defines. The failing tests in test/query.test.js, test/links.test.js and test/url.test.js describe the',
      'behaviour the tracker needs.',
      '',
      RUN_AFTER_VERIFICATION,
      '',
      'Do not change any test or the documentation.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    // TWO, and the recovery-weighted policy. The second attempt starts from a fresh copy and is told
    // exactly what the property check printed — a counterexample, and nothing about where to look.
    maximumAttempts: 2,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('query-tests', 'test/query.test.js'),
      test('links-tests', 'test/links.test.js'),
      test('url-tests', 'test/url.test.js'),
    ],
    hiddenCommands: [
      hidden('round-trip-property', QUERY_ROUND_TRIP_PROPERTY_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/query.js', mustExist: true, mustContain: ['encodeQuery', 'decodeQuery'] }),
      fileInvariant({ path: 'src/url.js', mustExist: true, mustContain: ['encodeQuery', 'decodeQuery'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 160,
  },
  scoring: RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY,
  tags: ['discriminator', 'feature', 'javascript', 'property-check', 'recovery'],
});

/**
 * Implement two writes on a task board whose views are served from secondary indexes.
 *
 * WHY RECOVERY IS MEASURABLE HERE. The interaction that decides this case is between the new code
 * and a module it calls rather than one it is asked to change: `indexTask` ADDS entries and never
 * removes them, so a write that changes an owner or a label and simply re-indexes leaves the old
 * entry answering. The visible suites check the NEW owner's list, the new label's list and the
 * history, and a natural first answer passes all of them. `src/indexes.js` says what `indexTask`
 * does and `docs/BOARD.md` says the lists always agree with the tasks, so a careful first attempt
 * can get it right — and one that did not is shown, concretely, the stale list: which call, after
 * which change, returned what. An answer that removes the one stale entry it was shown, by hand,
 * leaves the open-task count stale beside it, and the same check reports that on attempt two.
 */
export const D1_TASK_BOARD_REASSIGN: WorkspaceCase = makeWorkspaceCase({
  id: 'ws.d1.task-board.reassign',
  version: '1',
  suiteID: WORKSPACE_SUITE_DISCRIMINATOR,
  suiteVersion: WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  title: 'Implement reassign and relabel on a board whose views read secondary indexes',
  description: 'A feature whose visible tests check the new state; an integration check reads every view '
    + 'after the change, and the index module it has to cooperate with only ever adds.',
  dimensions: [
    'verificationDrivenRecovery', 'secondAttemptAdaptation', 'interactingInvariantReasoning',
    'repositoryComprehension',
  ],
  source: {
    fixturePath: 'workspace/d1-task-board',
    expectedTreeDigest: '4d5198d4da312881ffca72587fb88acd4c80e0192286b8d73f48ee4b6b9a63fe',
  },
  task: {
    instruction: [
      'The task board needs two operations it does not have yet: giving a task to another member of the team',
      '(reassignTask) and replacing a task\'s labels (relabelTask). Both are stubbed in src/board.js.',
      '',
      'Implement them. test/reassign.test.js and test/relabel.test.js describe what they must do, and docs/BOARD.md',
      'states the rules every operation on the board keeps.',
      '',
      RUN_AFTER_VERIFICATION,
      '',
      'Do not change any test or the documentation.',
    ].join('\n'),
    scope: { allowed: ['src/**'], forbidden: ['docs/**', 'test/**'] },
  },
  execution: {
    timeoutMilliseconds: 900_000,
    maximumAttempts: 2,
    tools: { fileRead: true, fileWrite: true, commandExecution: true, allowedExecutables: [] },
    networkPolicy: 'providerOnly',
    environmentAllowlist: SUBSCRIPTION_SESSION_ENVIRONMENT,
  },
  verification: {
    commands: [
      test('board-tests', 'test/board.test.js'),
      test('reassign-tests', 'test/reassign.test.js'),
      test('relabel-tests', 'test/relabel.test.js'),
    ],
    hiddenCommands: [
      hidden('lists-agree-with-tasks', BOARD_LISTS_AGREE_WITH_TASKS_CHECK),
      hidden('refused-change-changes-nothing', BOARD_REFUSED_CHANGE_CHANGES_NOTHING_CHECK),
    ],
    invariants: [
      fileInvariant({ path: 'src/board.js', mustExist: true, mustContain: ['reassignTask', 'relabelTask'] }),
      fileInvariant({ path: 'src/indexes.js', mustExist: true, mustContain: ['indexTask', 'unindexTask'] }),
    ],
    forbiddenChanges: ['docs/**', 'test/**'],
    requirePatchCleanliness: true,
    establishBaseline: true,
    maximumChangedFiles: 2,
    maximumChangedLines: 120,
  },
  scoring: RECOVERY_WEIGHTED_WORKSPACE_SCORING_POLICY,
  tags: ['discriminator', 'feature', 'integration-check', 'javascript', 'recovery'],
});

export const workspaceDiscriminatorSuite: WorkspaceSuite = makeWorkspaceSuite(
  WORKSPACE_SUITE_DISCRIMINATOR,
  WORKSPACE_SUITE_DISCRIMINATOR_VERSION,
  'Workspace discriminator',
  [
    D1_CONFIG_MIGRATE_UPGRADE, D1_ASSET_CONTAINER_RETITLE, D1_LOG_REDACT_MASK, D1_CATALOG_PAGING_WALK,
    D1_QUERY_CODEC_NEST, D1_TASK_BOARD_REASSIGN,
  ],
);
