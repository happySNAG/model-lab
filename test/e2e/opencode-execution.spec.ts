// E2E · OpenCode as an EXECUTION provider, driven end to end through the real terminal command.
//
// NO REAL PROVIDER IS CONTACTED. `opencode` here is a fake executable on PATH that records every
// invocation and replays fixtures shaped from the generated types the tool ships
// (`@opencode-ai/sdk/dist/gen/types.gen.d.ts`). The recording is the point: a test that only checked
// the answer could not tell a request that was sent correctly from one that was never sent at all.
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

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const MODEL = 'opencode/union-alpha';

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

const MODELS = ['opencode/big-pickle', 'opencode/claude-opus-5', MODEL, 'opencode/gpt-5.6-terra'].join('\n');

/** The JSON event stream `opencode run --format json` declares it emits. */
const RUN_EVENTS = [
  JSON.stringify({ type: 'message.part.updated', properties: { part: { id: 'prt_1', sessionID: 's', messageID: 'm', type: 'text', text: 'ok' } } }),
  JSON.stringify({
    type: 'message.updated',
    properties: {
      info: {
        id: 'm', sessionID: 's', role: 'assistant', parentID: 'p',
        providerID: 'opencode', modelID: 'union-alpha', mode: 'build',
        path: { cwd: '/tmp', root: '/tmp' },
        time: { created: 1000, completed: 1400 },
        cost: 0.0031,
        tokens: { input: 42, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: 'stop',
      },
    },
  }),
].join('\n');

function environment(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` };
}

async function cernum(...args: string[]): Promise<string> {
  const { stdout } = await run('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot],
    { cwd: root, encoding: 'utf8', env: environment(), timeout: 300_000 });
  return stdout;
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
  expect(invocations().length).toBe(before);
});

test('a smoke executes through OpenCode, and proves the model because the reply named it', async () => {
  const output = await cernum('smoke', 'opencodeCLI', '--models', MODEL);

  // The pre-flight disclosure precedes the request, every time.
  expect(output).toContain('About to send real requests');
  expect(output).toContain('authorization class   meteredAPI');
  expect(output).toContain(`proven       ${MODEL}`);

  // The invocation itself: explicit model, JSON events, an isolated directory, no plugins.
  const runCall = invocations().find((line) => line.startsWith('run'));
  expect(runCall).toBeDefined();
  expect(runCall).toContain('--model opencode/union-alpha');
  expect(runCall).toContain('--format json');
  expect(runCall).toContain('--pure');
  expect(runCall).toContain('--dir ');
});

test('the proof is recorded, and only then is the model selectable', async () => {
  const store = path.join(campaignRoot, '.providers', 'discovered.json');
  const recorded = JSON.parse(fs.readFileSync(store, 'utf8')) as { models: { modelID: string; provider: string; availability: string; verifiedModelID: string }[] };
  const union = recorded.models.find((model) => model.modelID === MODEL)!;

  expect(union.provider).toBe('opencodeCLI');
  expect(union.availability).toBe('proven');
  // Proven BY A REPLY, so the verified id is what OpenCode returned.
  expect(union.verifiedModelID).toBe(MODEL);

  const providers = await cernum('providers');
  expect(providers).toContain(MODEL);
});

test('a campaign can be frozen against the proven OpenCode candidate', async () => {
  const created = await cernum('create', 'opencode-frozen',
    '--frontier', `opencodeCLI:${MODEL}`, '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--pricing', pricingFile);

  expect(created).toContain('OpenCode');
  expect(created).toContain('This campaign sends prompts to an external provider');

  const manifest = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'opencode-frozen/manifest.json'), 'utf8')) as Record<string, any>;
  const bound = manifest.operationalEnvelope.bindings.find((binding: { provider: string }) => binding.provider === 'opencodeCLI');
  expect(bound).toBeDefined();
  expect(bound.requestedModelID).toBe(MODEL);
  expect(bound.billingBasis).toBe('meteredAPI');
  // Never reported as included in a subscription: OpenCode is billed per token.
  expect(bound.billingBasis).not.toBe('subscriptionIncluded');
});

test('an unproven OpenCode model is still refused at create', async () => {
  const failed = await cernum('create', 'opencode-unproven',
    '--frontier', 'opencodeCLI:opencode/big-pickle', '--suites', 'suite.model-lab.foundation', '--repeats', '1',
    '--pricing', pricingFile)
    .then(() => 'created', (error: { stderr?: string }) => error.stderr ?? 'failed');

  // Discovered in the catalogue, never asked, therefore not selectable.
  expect(failed).toContain('not been proven');
});

test('a metered OpenCode campaign is refused when no pricing snapshot is supplied', async () => {
  // Cernum will not estimate a paid campaign from prices it invented. This is the guard that made
  // the first draft of this very spec fail, and it is correct.
  const refused = await cernum('create', 'opencode-unpriced',
    '--frontier', `opencodeCLI:${MODEL}`, '--suites', 'suite.model-lab.foundation', '--repeats', '1')
    .then(() => 'created', (error: { stderr?: string }) => error.stderr ?? 'failed');

  expect(refused).toContain('billed per token');
  expect(refused).toContain('no pricing snapshot');
  // And it says which candidate, so the message is actionable rather than a category.
  expect(refused).toContain(MODEL);
});
