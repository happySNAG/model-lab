// E2E · a frontier campaign driven from the terminal, observed in the desktop application.
//
// The same acceptance shape as `campaign-across-surfaces`, extended to a candidate that is not on
// this machine: discovery, creation, a cost preview, a REFUSED run, an explicit authorization, a
// completed run, and a finalized report — all from the supported terminal command, then read in the
// interface with nothing between them but the shared campaign directory.
//
// No provider is contacted. `claude` is a fake executable on PATH, and the metered provider is a
// loopback recorder. That is the point: these are the paths that spend money.
//
// Run `npm run build` first.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { FIXTURE_ANTHROPIC_KEY, FIXTURE_OPENAI_PROJECT_KEY } from '../secret-fixtures';

const root = path.resolve(__dirname, '../..');
const SUITE = 'suite.model-lab.foundation';

let userData: string;
let campaignRoot: string;
let fakeBin: string;
let pricingFile: string;
let providerServer: http.Server;
let providerBaseURL: string;
let providerRequests: string[];

function environment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    CERNUM_ANTHROPIC_BASE_URL: providerBaseURL,
    CERNUM_OPENAI_BASE_URL: providerBaseURL,
    ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY,
  };
}

// ASYNC on purpose, exactly as in `campaign-canonical-ui.spec.ts`. The loopback provider recorder
// lives in THIS process, so a synchronous child-process call would block the event loop that has to
// answer it: the command would wait for a server that cannot reply until the command returns.
const run = promisify(execFile);

async function cernum(...args: string[]): Promise<string> {
  const { stdout } = await run('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot], {
    cwd: root, encoding: 'utf8', env: environment(), timeout: 300_000,
  });
  return stdout;
}

async function cernumExpectingFailure(...args: string[]): Promise<{ status: number; stderr: string; stdout: string }> {
  try {
    const { stdout } = await run('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot], {
      cwd: root, encoding: 'utf8', env: environment(), timeout: 300_000,
    });
    return { status: 0, stderr: '', stdout };
  } catch (error) {
    const failure = error as { code: number; stderr: string; stdout: string };
    return { status: failure.code, stderr: String(failure.stderr ?? ''), stdout: String(failure.stdout ?? '') };
  }
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: { ...environment(), MODEL_LAB_USER_DATA: userData, MODEL_LAB_CAMPAIGN_ROOT: campaignRoot },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');
  return { app, page };
}

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-frontier-'));
  campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-frontier-campaigns-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-frontier-bin-'));

  // A fake `claude` shaped like the real one: it reports authentication as JSON, has NO `models`
  // subcommand, and names the answering model in `modelUsage` rather than in a `model` field. It
  // echoes back whichever `--model` it was given, so a substitution would be visible if one
  // happened.
  //
  // The `luna-max` branch below reproduces the real 404 signature Pass 5 captured. Nothing on the
  // ladder asks for it any more — Luna is a Codex model and lives under `codexCLI` now — so the
  // branch is unreachable through the ladder and is kept only as the documented shape of a refusal
  // a direct `--frontier claudeCLI:<unknown>` would still produce.
  const claude = path.join(fakeBin, 'claude');
  fs.writeFileSync(claude, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fixture)"; exit 0; fi',
    'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}\'; exit 0; fi',
    'MODEL=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "--model" ]; then MODEL="$2"; fi; shift; done',
    'cat > /dev/null',
    'if [ "$MODEL" = "luna-max" ]; then',
    // `subtype` says "success" even here, exactly as the real tool does.
    '  echo \'{"result":"There is an issue with the selected model.","modelUsage":{},"usage":{},"is_error":true,"api_error_status":404,"terminal_reason":"api_error","subtype":"success","total_cost_usd":0}\'',
    '  exit 1',
    'fi',
    'printf \'{"result":"acknowledged","modelUsage":{"%s":{"canonicalModel":"%s","inputTokens":42,"outputTokens":7,"costUSD":0.0012}},"usage":{"input_tokens":42,"output_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens_details":{"thinking_tokens":0}},"total_cost_usd":0.0012,"is_error":false,"ttft_ms":11,"duration_ms":20}\\n\' "$MODEL" "$MODEL"',
  ].join('\n') + '\n', 'utf8');
  fs.chmodSync(claude, 0o755);

  providerRequests = [];
  providerServer = http.createServer((request, response) => {
    providerRequests.push(`${request.method} ${request.url}`);
    // THE ONE COMPLETION REQUEST a metered run sends, answered in the documented streaming shape and
    // naming the model it was asked for. Loopback only.
    if (request.method === 'POST' && request.url === '/v1/messages') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const model = (JSON.parse(body) as { model: string }).model;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 12, output_tokens: 0 } } })}`,
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `I am ${model}.` } })}`,
          `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })}`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
          '',
        ].join('\n\n'));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'a-metered-model' }] }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  providerBaseURL = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  pricingFile = path.join(fakeBin, 'prices.json');
  fs.writeFileSync(pricingFile, JSON.stringify({
    'anthropicAPI:a-metered-model': {
      source: 'a fixture written by the e2e test; these are not real prices and were never fetched',
      capturedAt: '2026-01-01T00:00:00Z',
      inputMicroUSDPerMillionTokens: 3_000_000,
      outputMicroUSDPerMillionTokens: 15_000_000,
      reasoningMicroUSDPerMillionTokens: null,
    },
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ ollamaEndpoint: 'http://127.0.0.1:1', thinkingMode: 'disabled', evidenceRootOverride: '' }));
});

test.afterAll(async () => {
  providerServer.closeAllConnections?.();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
});

test('the terminal reports providers without contacting any of them', async () => {
  const providers = await cernum('providers');
  expect(providers).toContain('Nothing below contacted anything');
  expect(providers).toContain('Claude Subscription');
  expect(providers).toContain('Anthropic API');
  expect(providers).toContain('No provider discovery has been run');
  // The ladder is named, and every entry is unproven.
  expect(providers).toContain('unproven');
  // CORRECTED IN PASS 5B: the ladder entry is GPT-5.6 Luna, under Codex. "Luna Max" was never a
  // model identifier — it is that model at max reasoning effort — and it was never a Claude model.
  expect(providers).toContain('GPT-5.6 Luna');
  expect(providerRequests).toEqual([]);

  const credentials = await cernum('credentials');
  expect(credentials).toContain('ANTHROPIC_API_KEY');
  expect(credentials).toContain('set · ');
  expect(credentials).not.toContain(FIXTURE_ANTHROPIC_KEY);
  expect(credentials).toContain('never reads their stored sessions');
});

test('an unproven model cannot be put in a campaign', async () => {
  const refused = await cernumExpectingFailure('create', 'unproven-run', '--frontier', 'codexCLI:gpt-5.6-luna', '--suites', SUITE);
  expect(refused.status).toBe(2);
  expect(refused.stderr).toMatch(/has not been proven callable by this account/);
  expect(refused.stderr).toMatch(/A model identifier is a plan, not a capability/);
});

test('an identity smoke proves a model — discovery alone cannot — and then a campaign runs end to end', async () => {
  // DISCOVERY IS NOT ENOUGH FOR A SUBSCRIPTION CLI. It establishes that the tool is installed and
  // signed in, and it stops there, because the tool has no model listing to read.
  const discovered = await cernum('discover', 'claudeCLI');
  expect(discovered).toContain('signed in');
  expect(discovered).toContain('offers NO model-listing command');
  // Reworded by d40ec65, which made every listing — and the absence of one — prove nothing. The COUNT
  // is unchanged: no smoke has run, so nothing is proven and nothing is selectable.
  expect(discovered).toContain('0 model(s) are selectable, none of them proved by this run');
  expect(providerRequests).toEqual([]);

  // The smoke test is what proves one, by asking it who it is. It says out loud that it spends.
  //
  // THE SCOPE IS NAMED. v0.2.3 removed this command's default candidate set — naming a provider is
  // not consent to its whole ladder — and this spec was not updated with it, so it has been failing
  // on a refusal since that release rather than on anything it was written to check.
  const smoked = await cernum('smoke', 'claudeCLI', '--all-ladder');
  expect(smoked).toContain('About to send real requests');
  expect(smoked).toContain('proven       claude-haiku-4-5');
  // Every model on the CLAUDE half of the ladder is a Claude model, so this fake proves all of
  // them. The refusal path is exercised against its real captured 404 in the unit suite, and the
  // Codex half — which cannot reach `proven` at all, because `codex exec` names no model — is
  // covered in `codex-identity-preflight.test.ts`.
  expect(smoked).toContain('proven       claude-sonnet-5');
  expect(smoked).not.toContain('luna-max');
  expect(smoked).toContain('No campaign was created');
  // A zero marginal charge is never presented as a zero cost.
  expect(smoked).toContain('marginal API charge $0.000000');
  expect(smoked).toContain('plan allowance consumed');
  // v0.2.4: the binding the record carries is the one the preview described.
  expect(smoked).toContain('authorization class   subscriptionIncluded');
  expect(smoked).toContain('binding subscriptionIncluded · auth subscriptionCLISession');
  expect(providerRequests).toEqual([]);

  const created = await cernum('create', 'sub-run', '--frontier', 'claudeCLI:claude-haiku-4-5', '--suites', SUITE, '--repeats', '1');
  expect(created).toContain('Claude Subscription');
  expect(created).toContain('subscription-included');
  expect(created).toContain('This campaign sends prompts to an external provider');
  expect(created).toContain('takes no Ollama endpoint lease');
  // Subscription execution is never described as free.
  expect(created).toContain('marginal API charge $0');

  const manifest = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'sub-run/manifest.json'), 'utf8')) as Record<string, any>;
  expect(manifest.manifestFormatVersion).toBe(4);
  expect(manifest.operationalEnvelope.bindings[0].provider).toBe('claudeCLI');
  expect(manifest.operationalEnvelope.bindings[0].requestedModelID).toBe('claude-haiku-4-5');
  expect(manifest.operationalEnvelope.bindings[0].billingBasis).toBe('subscriptionIncluded');

  const ran = await cernum('run', 'sub-run');
  expect(ran).toContain('[complete]');

  const finalized = await cernum('finalize', 'sub-run');
  expect(finalized).toContain('Tokens, speed and cost');
  expect(finalized).toContain('subscription');
  expect(finalized).toContain('measurement quality');

  // The desktop application reads the same campaign, and describes it the same way.
  const { app, page } = await launch();
  await page.click('[data-nav="campaigns"]');
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('sub-run', { timeout: 20_000 });
  await page.locator('[data-testid="campaign-table"] tr', { hasText: 'sub-run' }).first().click();
  await expect(page.locator('.modal')).toBeVisible();
  await expect(page.locator('[data-testid="binding-table"]')).toContainText('Claude Subscription');
  await expect(page.locator('[data-testid="binding-table"]')).toContainText('claude-haiku-4-5');
  await expect(page.locator('[data-testid="metrics-table"]')).toContainText('subscription');
  await app.close();

  // And no provider request ever happened: the model answers came from the fake CLI on PATH.
  expect(providerRequests).toEqual([]);
});

test('a metered campaign refuses to run until it is explicitly authorized, with a ceiling', async () => {
  // DISCOVERED, NOT PROVEN (d40ec65): `/v1/models` says what a key is advertised, not what answered.
  await cernum('discover', 'anthropicAPI');
  // THIS SPEC IS ABOUT SPENDING AUTHORIZATION, NOT PROOF, so the proof is SEEDED as the record of an
  // earlier identity smoke — the same arrangement the unit suite's `provenModel` makes. It cannot be
  // produced here: `smoke` asks only for identifiers on the intended ladder, and `a-metered-model` is a
  // fixture name that is deliberately on no ladder.
  const store = path.join(campaignRoot, '.providers', 'discovered.json');
  const existing = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) as { models: unknown[] } : { models: [] };
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, JSON.stringify({ writtenAt: new Date().toISOString(), models: [
    ...existing.models.filter((row) => (row as { modelID?: string }).modelID !== 'a-metered-model'),
    { provider: 'anthropicAPI', modelID: 'a-metered-model', displayName: 'a-metered-model', availability: 'proven',
      evidence: 'identity smoke test (seeded by the e2e fixture): the fake provider named a-metered-model',
      verifiedModelID: 'a-metered-model', desiredEfforts: ['none'], discoveredAt: new Date().toISOString() },
  ] }, null, 2));
  const created = await cernum('create', 'paid-run', '--frontier', 'anthropicAPI:a-metered-model',
    '--suites', SUITE, '--repeats', '1', '--pricing', pricingFile);
  expect(created).toContain('billed per token');
  expect(created).toContain('NOT yet authorised to spend anything');

  // The cost preview names the bracket and the pricing timestamp.
  const cost = await cernum('cost', 'paid-run');
  expect(cost).toContain('Estimated total');
  expect(cost).toContain('prices captured 2026-01-01T00:00:00Z');
  expect(cost).toContain('NOT AUTHORIZED');

  // The run is refused, and nothing is sent.
  const before = providerRequests.length;
  const refused = await cernumExpectingFailure('run', 'paid-run');
  expect(refused.status).toBe(6);
  expect(refused.stderr).toMatch(/no recorded spending authorization/);
  expect(refused.stderr).toMatch(/nothing was run and nothing was sent/);
  expect(providerRequests.length).toBe(before);

  // Authorizing without --yes changes nothing either.
  const notYet = await cernumExpectingFailure('authorize', 'paid-run', '--ceiling', '5.00');
  expect(notYet.status).toBe(3);
  expect(notYet.stdout).toContain('Estimated total');
  expect(notYet.stdout).toContain('This campaign sends prompts to an external provider');
  expect(notYet.stderr).toMatch(/Nothing was authorised/);
  expect(fs.existsSync(path.join(campaignRoot, 'paid-run/authorization.json'))).toBe(false);

  // With --yes, the authorization is written beside the campaign and names its ceiling.
  const authorized = await cernum('authorize', 'paid-run', '--ceiling', '5.00', '--yes');
  expect(authorized).toContain('Authorized. Ceiling $5.00');
  const record = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'paid-run/authorization.json'), 'utf8')) as Record<string, any>;
  expect(record.hardCeilingMicroUSD).toBe(5_000_000);
  expect(record.estimate.meteredCandidateCount).toBe(1);
  expect(record.authorizationDigest).toMatch(/^[0-9a-f]{64}$/);

  // The desktop application shows the same authorization, at the same ceiling.
  const { app, page } = await launch();
  await page.click('[data-nav="campaigns"]');
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('paid-run', { timeout: 20_000 });
  await page.locator('[data-testid="campaign-table"] tr', { hasText: 'paid-run' }).first().click();
  await expect(page.locator('.modal')).toContainText('Authorised with a hard ceiling of $5.00');
  await app.close();
});
