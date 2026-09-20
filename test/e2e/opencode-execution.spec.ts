// E2E · OpenCode as an EXECUTION provider, driven end to end through the real terminal command.
//
// NO REAL PROVIDER IS CONTACTED. `opencode` here is a fake executable on PATH that records every
// invocation and replays THE BYTES A REAL OPENCODE REQUEST RETURNED — the 922-byte capture in
// `test/engine/fixtures/opencode-run-json.ts`, sanitized of its session identifiers and otherwise
// verbatim. The recording is the point: a test that only checked the answer could not tell a request
// that was sent correctly from one that was never sent at all.
//
// -- WHAT PASS 7 CHANGED HERE, AND WHY THE CHAIN BELOW READS DIFFERENTLY ------------------------
//
// This spec used to replay a fabricated `message.updated` event carrying `providerID`/`modelID`, and
// asserted the chain discover -> smoke -> PROVEN -> selectable -> frozen into a campaign. That reply
// does not exist: `opencode run --format json` emits no assistant message, so no OpenCode reply on
// this path names the model that answered. The fixture was the only reason the chain reached `proven`.
//
// It is replaced by the captured envelope, and NO IDENTITY FIELD WAS ADDED TO IT TO KEEP THE CHAIN
// GREEN. The chain is what changed instead:
//
//     discover -> smoke -> requestAcceptedIdentityUnverifiable -> STILL NOT SELECTABLE
//                                                              -> measurable only under a sealed,
//                                                                 per-campaign admission record
//
// The tests below assert both halves: that the state is reached and recorded, and that it buys
// nothing — not `proven`, not selectable, not promotable, not routable.
//
// Deliberately NOT here: running a campaign. That path is covered by the campaign specs, and on a
// machine under the 15 GiB free-disk guard it aborts at preflight before any candidate is reached —
// which would test the guard rather than OpenCode.

import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OPENCODE_BIG_PICKLE_CAPTURED_STDOUT } from '../engine/fixtures/opencode-run-json';

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
// The model the captured request was actually sent to. The two must agree: replaying big-pickle's
// bytes under another model's name is a thing this spec does deliberately, ONCE, to show that nothing
// can tell the difference — see the substitution test at the end.
const MODEL = 'opencode/big-pickle';

let campaignRoot: string;
let fakeBin: string;
let pricingFile: string;

const ESC = '\x1b';
const CREDENTIALS = [
  `${ESC}[0m`,
  `┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json`,
  `◗  OpenCode Zen ${ESC}[90mapi`,
  '└  1 credentials',
].join('\n');

const MODELS = [MODEL, 'opencode/claude-opus-5', 'opencode/union-alpha', 'opencode/gpt-5.6-terra'].join('\n');

/**
 * THE BYTES A REAL REQUEST RETURNED, replayed byte for byte.
 *
 * Imported rather than restated so this spec and the unit tests cannot describe different OpenCode.
 * Three events — `step_start`, `text`, `step_finish` — carrying the answer, the token counts, the cost
 * and the finish reason, and NO `providerID`, NO `modelID`, no assistant message of any kind.
 *
 * NOTHING WAS ADDED TO IT TO PRESERVE A PROVEN CANDIDATE. That was the temptation and it is the one
 * move this repository exists to refuse: a fabricated identity field here would have kept every
 * assertion below green while making the whole chain a description of a reply that does not exist.
 */
const RUN_EVENTS = OPENCODE_BIG_PICKLE_CAPTURED_STDOUT.trimEnd();

/**
 * The sealed authorization a person has to write before an unprovable candidate may be MEASURED.
 *
 * Every field is required and none is derived from the smoke: `authorizeIdentityAdmission` refuses a
 * record missing any of them, because a weaker claim needs more provenance than a proof does. The
 * digest and capture time below stand for the identity-smoke evidence this admission rests on.
 */
function writeAdmission(directory: string, modelID = MODEL, effort = 'none'): string {
  const file = path.join(directory, 'admission.json');
  fs.writeFileSync(file, JSON.stringify({
    authorizedBy: 'the e2e spec, standing in for a person who wrote this down and meant it',
    admitted: [{
      provider: 'opencodeCLI',
      requestedModelID: modelID,
      requestedEffort: effort,
      cliVersion: '1.18.31',
      authenticationBasis: 'toolManagedCredential — OpenCode Zen [api]',
      evidenceDigest: 'e2e-fixture-digest-not-a-real-smoke',
      evidenceCapturedAt: '2026-09-20T18:53:30Z',
    }],
  }, null, 2));
  return file;
}

function environment(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` };
}

async function cernum(...args: string[]): Promise<string> {
  const { stdout } = await run('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot],
    { cwd: root, encoding: 'utf8', env: environment(), timeout: 300_000 });
  return stdout;
}

/** Run and capture the refusal instead of throwing, for the paths whose point IS the refusal. */
async function cernumRefused(...args: string[]): Promise<string> {
  return cernum(...args).then((stdout) => `UNEXPECTEDLY SUCCEEDED:\n${stdout}`,
    (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`);
}

const invocations = (): string[] => {
  const log = path.join(fakeBin, 'opencode.invocations');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.trim().length > 0);
};

test.beforeAll(() => {
  campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-e2e-opencode-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-e2e-opencode-bin-'));
  fs.writeFileSync(path.join(fakeBin, 'credentials.txt'), `${CREDENTIALS}\n`);
  fs.writeFileSync(path.join(fakeBin, 'models.txt'), `${MODELS}\n`);
  fs.writeFileSync(path.join(fakeBin, 'run-events.txt'), `${RUN_EVENTS}\n`);
  // OpenCode is METERED, and Cernum refuses to freeze a paid campaign it cannot price — it will not
  // invent prices to estimate with. These are a fixture and were never fetched from anyone.
  pricingFile = path.join(fakeBin, 'prices.json');
  fs.writeFileSync(pricingFile, JSON.stringify({
    [`opencodeCLI:${MODEL}`]: {
      source: 'a fixture written by the e2e test; these are not real prices and were never fetched',
      capturedAt: '2026-01-01T00:00:00Z',
      inputMicroUSDPerMillionTokens: 3_000_000,
      outputMicroUSDPerMillionTokens: 15_000_000,
      reasoningMicroUSDPerMillionTokens: null,
    },
  }, null, 2));
  fs.writeFileSync(path.join(fakeBin, 'opencode'), [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(path.join(fakeBin, 'opencode.invocations'))}`,
    'if [ "$1" = "--version" ]; then echo "1.18.31"; exit 0; fi',
    `if [ "$1" = "providers" ]; then cat ${JSON.stringify(path.join(fakeBin, 'credentials.txt'))}; exit 0; fi`,
    `if [ "$1" = "models" ]; then cat ${JSON.stringify(path.join(fakeBin, 'models.txt'))}; exit 0; fi`,
    `if [ "$1" = "run" ]; then cat > /dev/null; cat ${JSON.stringify(path.join(fakeBin, 'run-events.txt'))}; exit 0; fi`,
    'echo "usage: opencode"; exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
});

test.afterAll(() => {
  fs.rmSync(campaignRoot, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

test('discovery finds OpenCode and still proves nothing', async () => {
  const output = await cernum('discover', 'opencodeCLI');

  expect(output).toContain('[ready]');
  expect(output).toContain('1.18.31');
  expect(output).toContain(MODEL);
  // The renderer wraps the detail at 76 columns, so compare on collapsed whitespace rather than on
  // where the terminal happened to break the line.
  expect(output.replace(/\s+/g, ' ')).toContain('none of them proven');
  // A listing is a catalogue. Discovery never reaches `proven`, however complete it is.
  expect(output).not.toMatch(/^ +proven +opencode\//m);
  // And it did NOT send a request: only the three read-only subcommands ran.
  expect(invocations().some((line) => line.startsWith('run'))).toBe(false);
});

test('a dry-run names the request it would send, and sends none', async () => {
  const before = invocations().length;
  const output = await cernum('smoke', 'opencodeCLI', '--models', MODEL, '--dry-run');

  expect(output).toContain('DRY RUN');
  expect(output).toContain(MODEL);
  expect(output).toContain('requests to be sent   1');
  expect(output).toContain('meteredAPI');
  // v0.2.4: the preview also says, before anything is sent, that a live run of this scope would be
  // refused as it stands — rather than letting a person find that out by typing the live command.
  expect(output).toContain('AUTHORIZATION REQUIRED');
  expect(invocations().length).toBe(before);
});

test('v0.2.4 · a live metered smoke with no authorization is refused, and sends nothing', async () => {
  const before = invocations().length;
  const refused = await cernumRefused('smoke', 'opencodeCLI', '--models', MODEL);

  expect(refused).toContain('this run is not authorized');
  expect(refused).toContain('MAY BILL YOU');
  expect(refused).toContain('Nothing was sent');
  // THE ASSERTION THAT MATTERS: the fake `opencode` was never asked to run anything.
  expect(invocations().length).toBe(before);
});

test('v0.2.4 · a priced metered smoke is refused when the worst case exceeds the ceiling', async () => {
  const before = invocations().length;
  const refused = await cernumRefused('smoke', 'opencodeCLI', '--models', MODEL,
    '--pricing', pricingFile, '--authorize-metered', '0.000001');

  expect(refused).toContain('worst case for this scope');
  expect(refused).toContain('Nothing was sent');
  expect(invocations().length).toBe(before);
});

test('a smoke executes through OpenCode under an explicit authorization, and says the reply named nobody', async () => {
  const output = await cernum('smoke', 'opencodeCLI', '--models', MODEL,
    '--pricing', pricingFile, '--authorize-metered', '1.00');

  // The pre-flight disclosure precedes the request, every time.
  expect(output).toContain('About to send real requests');
  expect(output).toContain('authorization class   meteredAPI');
  expect(output).toContain('authorization         pricedCeiling');

  // THE OUTCOME PASS 7 CORRECTED. This read `proven` while the fixture carried an invented identity.
  // Against the real bytes it is `unverifiable`, and the row says why rather than leaving it blank.
  expect(output).toContain(`unverifiable ${MODEL}`);
  expect(output).not.toContain(`proven       ${MODEL}`);
  expect(output).toContain('named nothing');
  expect(output).toContain('identity state requestAcceptedIdentityUnverifiable');

  // AND THE TELEMETRY IS STILL FULLY READ, which is the other half of the decision: this is a
  // measured request whose identity is unknown, not a request that failed.
  expect(output).toMatch(/tokens in \d+ · visible out \d+/);

  // The record agrees with the preview about what this request was: metered, and never a subscription.
  expect(output).toContain('binding meteredAPI · auth toolManagedCredential');
  expect(output).toContain('plan allowance consumed: none — this is not a subscription');

  // The invocation itself: explicit model, JSON events, an isolated directory, no plugins.
  const runCall = invocations().find((line) => line.startsWith('run'));
  expect(runCall).toBeDefined();
  expect(runCall).toContain(`--model ${MODEL}`);
  expect(runCall).toContain('--format json');
  expect(runCall).toContain('--pure');
  expect(runCall).toContain('--dir ');
});

test('the accepted-but-unnamed result is recorded, and does NOT make the model selectable', async () => {
  const store = path.join(campaignRoot, '.providers', 'discovered.json');
  const recorded = JSON.parse(fs.readFileSync(store, 'utf8')) as { models: { modelID: string; provider: string; availability: string; verifiedModelID: string; evidence: string }[] };
  const row = recorded.models.find((model) => model.modelID === MODEL)!;

  expect(row.provider).toBe('opencodeCLI');
  // NOT `proven`. The request was accepted and answered and that is not a proof of identity.
  expect(row.availability).toBe('unproven');
  // Empty, on disk, forever. The requested identifier is sitting right there and is never copied in.
  expect(row.verifiedModelID).toBe('');
  // PERSISTED, not merely printed: the distinction has to survive the run that produced it.
  expect(row.evidence).toContain('unverifiable');
  expect(row.evidence).not.toContain('identityProven');

  const providers = await cernum('providers');
  expect(providers).toContain(MODEL);
  // Listed, and listed as unproven. Being visible is not being selectable.
  expect(providers).toMatch(new RegExp(`unproven\\s+${MODEL.replace('/', '\\/')}`));
});

test('a campaign against it is REFUSED without a sealed admission record — the default, unchanged', async () => {
  const failed = await cernum('create', 'opencode-no-record',
    '--frontier', `opencodeCLI:${MODEL}`, '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--pricing', pricingFile)
    .then(() => 'UNEXPECTEDLY CREATED', (error: { stderr?: string }) => error.stderr ?? 'failed');

  // A measured request that named nobody buys no admission on its own. Somebody has to write one.
  expect(failed).toContain('not been proven');
  expect(fs.existsSync(path.join(campaignRoot, 'opencode-no-record'))).toBe(false);
});

test('supplying the record without confirming it is also refused, and creates nothing', async () => {
  const admission = writeAdmission(fakeBin);
  const refused = await cernum('create', 'opencode-unconfirmed',
    '--frontier', `opencodeCLI:${MODEL}`, '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--pricing', pricingFile, '--admit-identity-unverifiable', admission)
    .then(() => 'UNEXPECTEDLY CREATED', (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`);

  // Naming the file says what you WOULD authorise; --yes-identity-unverifiable says you did.
  expect(refused).toContain('--yes-identity-unverifiable');
  expect(refused).toContain('Nothing was created');
  expect(fs.existsSync(path.join(campaignRoot, 'opencode-unconfirmed'))).toBe(false);
});

test('a campaign CAN be frozen under the sealed admission, stamped as unverifiable throughout', async () => {
  const admission = writeAdmission(fakeBin);
  const created = await cernum('create', 'opencode-admitted',
    '--frontier', `opencodeCLI:${MODEL}`, '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--pricing', pricingFile, '--admit-identity-unverifiable', admission, '--yes-identity-unverifiable');

  expect(created).toContain('OpenCode');
  expect(created).toContain('This campaign sends prompts to an external provider');
  // The disclosure a person has to have read, printed before anything was frozen.
  expect(created).toContain('requestAcceptedIdentityUnverifiable');

  const manifest = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'opencode-admitted/manifest.json'), 'utf8')) as Record<string, any>;
  const bound = manifest.operationalEnvelope.bindings.find((binding: { provider: string }) => binding.provider === 'opencodeCLI');
  expect(bound).toBeDefined();
  expect(bound.requestedModelID).toBe(MODEL);
  expect(bound.billingBasis).toBe('meteredAPI');
  expect(bound.billingBasis).not.toBe('subscriptionIncluded');

  // THE STATE IS FROZEN INTO THE MANIFEST, and the returned-model field is empty in the artefact that
  // outlives the run. This is the assertion that makes the distinction durable rather than displayed.
  expect(bound.identityState).toBe('requestAcceptedIdentityUnverifiable');
  expect(bound.verifiedModelID).toBe('');
  expect(bound.identityState).not.toBe('verified');
});

test('an OpenCode model nobody asked at all is still refused, record or no record', async () => {
  // Discovered in the catalogue, never sent a request, therefore not selectable — and an admission
  // record that names a DIFFERENT candidate does not reach it either.
  const admission = writeAdmission(fakeBin);
  const failed = await cernum('create', 'opencode-unasked',
    '--frontier', 'opencodeCLI:opencode/gpt-5.6-terra', '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--pricing', pricingFile, '--admit-identity-unverifiable', admission, '--yes-identity-unverifiable')
    .then(() => 'UNEXPECTEDLY CREATED', (error: { stderr?: string }) => error.stderr ?? 'failed');

  expect(failed).toContain('not been proven');
  // And it says WHICH of the two problems it was, because a record that refuses looks like a broken one.
  expect(failed).toContain('does not admit this candidate');
});

test('SUBSTITUTION IS UNDETECTABLE on this path, and the spec says so rather than implying it', async () => {
  // The same captured bytes, replayed for a DIFFERENT requested model. Nothing in the reply
  // contradicts the request, because nothing in the reply mentions a model at all — so the smoke
  // reaches exactly the same verdict it reached for big-pickle. This is the cost of the Pass 7
  // admission, demonstrated rather than described.
  const output = await cernum('smoke', 'opencodeCLI', '--models', 'opencode/union-alpha',
    '--authorize-unpriced-metered');

  expect(output).toContain('unverifiable opencode/union-alpha');
  // NOT `substituted`: there is no returned identity to compare against, so no mismatch can fire.
  expect(output).not.toContain('substituted');
});

test('a metered OpenCode campaign is refused when no pricing snapshot is supplied', async () => {
  // Cernum will not estimate a paid campaign from prices it invented. This is the guard that made
  // the first draft of this very spec fail, and it is correct.
  //
  // THE ADMISSION RECORD IS SUPPLIED HERE ON PURPOSE. Since Pass 7 every OpenCode candidate is
  // unproven, and that gate sits AHEAD of the pricing gate — so without the record this would refuse
  // one step early, for the wrong reason, and stop testing the thing it is named for. Passing the
  // record gets the candidate to the pricing check, which must still refuse it.
  const admission = writeAdmission(fakeBin);
  const refused = await cernum('create', 'opencode-unpriced',
    '--frontier', `opencodeCLI:${MODEL}`, '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--admit-identity-unverifiable', admission, '--yes-identity-unverifiable')
    .then(() => 'created', (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ''}${error.stderr ?? ''}`);

  expect(refused).toContain('billed per token');
  expect(refused).toContain('no pricing snapshot');
  // And it says which candidate, so the message is actionable rather than a category.
  expect(refused).toContain(MODEL);
});
