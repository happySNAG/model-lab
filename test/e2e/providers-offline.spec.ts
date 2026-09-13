// E2E · opening the application sends ZERO provider requests.
//
// This is the acceptance test for the central promise of the Providers screen. It is not asserted by
// reading the code: the application is launched with a PATH containing fake `claude` and `codex`
// executables that RECORD EVERY INVOCATION, and with its API base URLs pointed at a loopback server
// that records every request. The test then opens the app, opens the Providers screen, opens the New
// campaign dialog, and asserts that both logs are still empty.
//
// Then it presses the button that says it will ask, and asserts that the invocation appears — because
// a screen that never contacted anything and a screen that could not contact anything look identical
// from the outside, and only the second half of this test tells them apart.
//
// Run `npm run build` first.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { FIXTURE_ANTHROPIC_KEY, FIXTURE_OPENAI_PROJECT_KEY } from '../secret-fixtures';

const root = path.resolve(__dirname, '../..');

let userData: string;
let campaignRoot: string;
let fakeBin: string;
let cliLog: string;
let providerServer: http.Server;
let providerBaseURL: string;
let providerRequests: string[];

/** A fake CLI that logs every invocation before answering. Executable, on PATH, never a stub. */
function writeFakeCLI(name: string, listing: string): void {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `printf '%s %s\\n' "${name}" "$*" >> '${cliLog}'`,
    'if [ "$1" = "--version" ]; then echo "9.9.9 (fixture)"; exit 0; fi',
    `echo '${listing}'`,
  ].join('\n') + '\n', 'utf8');
  fs.chmodSync(file, 0o755);
}

function cliInvocations(): string[] {
  if (!fs.existsSync(cliLog)) return [];
  return fs.readFileSync(cliLog, 'utf8').split('\n').filter(Boolean);
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: {
      ...process.env,
      MODEL_LAB_USER_DATA: userData,
      MODEL_LAB_CAMPAIGN_ROOT: campaignRoot,
      // The fake CLIs come first, so nothing can reach a real one.
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      // Any API request would land on the loopback recorder, never on a provider.
      CERNUM_ANTHROPIC_BASE_URL: providerBaseURL,
      CERNUM_OPENAI_BASE_URL: providerBaseURL,
      // A key IS configured, so "no key" cannot be the reason nothing was sent.
      ANTHROPIC_API_KEY: FIXTURE_ANTHROPIC_KEY,
      OPENAI_API_KEY: FIXTURE_OPENAI_PROJECT_KEY,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');
  return { app, page };
}

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-providers-'));
  campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-provider-campaigns-'));
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-bin-'));
  cliLog = path.join(fakeBin, 'invocations.log');
  writeFakeCLI('claude', '{"models":[{"id":"claude-sonnet-5","display_name":"Claude Sonnet 5"}]}');
  writeFakeCLI('codex', '{"models":[{"id":"a-codex-model"}]}');

  providerRequests = [];
  providerServer = http.createServer((request, response) => {
    providerRequests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'a-metered-model' }] }));
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  providerBaseURL = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  // A loopback endpoint with nothing on it, so Ollama detection cannot hang the window.
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ ollamaEndpoint: 'http://127.0.0.1:1', thinkingMode: 'disabled', evidenceRootOverride: '' }));
});

test.afterAll(async () => {
  providerServer.closeAllConnections?.();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
});

test('opening the application, and the Providers screen, contacts no provider at all', async () => {
  const { app, page } = await launch();

  // Every screen a person might open on the way, including the one whose whole subject is providers.
  await page.click('[data-nav="providers"]');
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await expect(page.getByText('Opening this screen contacted nothing')).toBeVisible();

  // All five providers are described.
  for (const label of ['Local Models', 'Claude Subscription', 'Codex Subscription', 'Anthropic API', 'OpenAI API']) {
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  }
  // The installed CLI is found — a PATH lookup — and is NOT reported as ready.
  await expect(page.locator('.card', { hasText: 'Claude Subscription' })).toContainText(path.join(fakeBin, 'claude'));
  await expect(page.locator('.card', { hasText: 'Claude Subscription' })).toContainText('not checked');
  // The key is configured, and is shown only as a length.
  await expect(page.locator('.card', { hasText: 'Anthropic API' })).toContainText('set · ');
  await expect(page.locator('.card', { hasText: 'Anthropic API' })).not.toContainText(FIXTURE_ANTHROPIC_KEY);

  // And the New campaign dialog, which also lists frontier models.
  await page.click('[data-nav="campaigns"]');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await expect(page.locator('.modal')).toContainText('Models somebody else runs');
  await page.getByRole('button', { name: 'Cancel' }).first().click();

  await page.click('[data-nav="settings"]');
  await page.click('[data-nav="home"]');

  // THE ASSERTION. Not one CLI was run, and not one request reached the API recorder.
  expect(cliInvocations(), `the application invoked: ${cliInvocations().join(' | ')}`).toEqual([]);
  expect(providerRequests, `the application requested: ${providerRequests.join(' | ')}`).toEqual([]);

  await app.close();
});

test('asking a subscription CLI what it can call runs it, and only then', async () => {
  const { app, page } = await launch();
  await page.click('[data-nav="providers"]');
  expect(cliInvocations()).toEqual([]);

  await page.locator('[data-testid="discover-claudeCLI"]').click();
  await expect(page.locator('.modal')).toContainText('This runs');
  await expect(page.locator('.modal')).toContainText('no tokens are generated and nothing is charged');
  await page.locator('[data-testid="confirm-discover"]').click();

  // The model listing appears, and only the listed model is selectable.
  const card = page.locator('.card', { hasText: 'Claude Subscription' });
  await expect(card.locator('[data-testid="frontier-model-table"]')).toContainText('Claude Sonnet 5', { timeout: 20_000 });
  await expect(card.locator('tr', { hasText: 'Claude Sonnet 5' })).toContainText('proven');
  // A ladder entry the tool did not list is shown as refused, not quietly dropped.
  await expect(card.locator('[data-testid="frontier-model-table"]')).toContainText('Luna Max');
  await expect(card.locator('tr', { hasText: 'Luna Max' })).toContainText('refused');

  // It ran `claude`, and it did not touch anything else.
  const invocations = cliInvocations();
  expect(invocations.some((line) => line.startsWith('claude --version'))).toBe(true);
  expect(invocations.some((line) => line.startsWith('claude models list'))).toBe(true);
  expect(invocations.some((line) => line.startsWith('codex'))).toBe(false);
  expect(providerRequests).toEqual([]);

  // And a proven model is now offered in the New campaign dialog, where an unproven one is not.
  await page.click('[data-nav="campaigns"]');
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  const picker = page.locator('[data-testid="frontier-claudeCLI"]');
  await expect(picker).toContainText('Claude Sonnet 5', { timeout: 20_000 });
  // Two effort levels, because the same model at two efforts is two candidates.
  await expect(picker.locator('input[type=checkbox]:not([disabled])')).toHaveCount(2);
  // Luna Max is present but cannot be chosen.
  await expect(picker.locator('label', { hasText: 'Luna Max' }).locator('input')).toBeDisabled();

  await app.close();
});
