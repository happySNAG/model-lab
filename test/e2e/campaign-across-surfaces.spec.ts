// E2E · one campaign, two surfaces.
//
// This is the acceptance test for the engine boundary: a campaign created and run entirely from the
// supported terminal command is opened, read and finalized by the DESKTOP APPLICATION, with no
// message passing between them and nothing but the shared campaign directory in common. If the two
// callers ever grow separate ideas of what a campaign is, this fails.
//
// Run `npm run build` first. The campaign is synthetic, so no request reaches any server.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
let userData: string;
let campaignRoot: string;

function cernum(...args: string[]): string {
  return execFileSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot], {
    cwd: root, encoding: 'utf8', env: { ...process.env }, timeout: 180_000,
  });
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: { ...process.env, MODEL_LAB_USER_DATA: userData, MODEL_LAB_CAMPAIGN_ROOT: campaignRoot, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');
  return { app, page };
}

test.beforeAll(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-campaign-'));
  campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-campaigns-'));
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ ollamaEndpoint: 'http://127.0.0.1:1', thinkingMode: 'disabled', evidenceRootOverride: '' }));
});

test('a campaign created, paused and resumed in the terminal is read and finalized in the desktop application', async () => {
  // ---- Terminal: create, run partway, resume to completion. Claude Code is not in this loop; this
  // is the supported command a person types.
  const created = cernum('create', 'crossing', '--synthetic', '--models', 'alpha:1b,beta:2b',
    '--suites', 'suite.model-lab.foundation', '--repeats', '1');
  expect(created).toContain('Created crossing');
  expect(created).toMatch(/manifest manifest:[0-9a-f]{16}/);

  const partial = cernum('run', 'crossing', '--synthetic', '--max-attempts', '3');
  expect(partial).toContain('[paused]');
  expect(partial).toContain('3/8 attempts recorded');

  // ---- Desktop: the paused campaign is visible, with its real progress, without this process
  // having started it.
  const first = await launch();
  await first.page.click('[data-nav="campaigns"]');
  await expect(first.page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();
  const table = first.page.locator('[data-testid="campaign-table"]');
  await expect(table).toBeVisible({ timeout: 20_000 });
  await expect(table).toContainText('crossing');
  await expect(table).toContainText('paused');
  await expect(table).toContainText('3/8');

  // The detail view shows the manifest seal, so a person can compare it by eye with the terminal's.
  await table.locator('tr', { hasText: 'crossing' }).first().click();
  await expect(first.page.locator('.modal')).toContainText('manifest manifest:');
  await expect(first.page.locator('.modal')).toContainText('3 of 8');
  // And it names the exact terminal command for the same campaign.
  await expect(first.page.locator('.modal')).toContainText('cernum status crossing');
  await first.app.close();

  // ---- Terminal again: resume to completion. The desktop application held no lock and lost nothing.
  const finished = cernum('resume', 'crossing', '--synthetic');
  expect(finished).toContain('[complete]');
  expect(finished).toContain('8/8 attempts recorded');

  // ---- Desktop again: finalize it, and read the rankings the engine produced.
  const second = await launch();
  await second.page.click('[data-nav="campaigns"]');
  const table2 = second.page.locator('[data-testid="campaign-table"]');
  await expect(table2).toContainText('complete', { timeout: 20_000 });
  await table2.locator('tr', { hasText: 'crossing' }).first().click();

  await second.page.getByRole('button', { name: 'Verify manifest' }).click();
  await expect(second.page.locator('.modal')).toContainText('Intact', { timeout: 20_000 });

  await second.page.getByRole('button', { name: 'Finalize' }).click();
  await expect(second.page.locator('.modal')).toContainText('Rankings', { timeout: 30_000 });
  await expect(second.page.locator('.modal')).toContainText('INTERPRETATION, not measurement');
  await second.app.close();

  // ---- And the artefacts are on disk where both surfaces agreed they would be.
  const directory = path.join(campaignRoot, 'crossing');
  for (const file of ['manifest.json', 'final-report.json', 'rankings.json', 'retention.json']) {
    expect(fs.existsSync(path.join(directory, file)), file).toBe(true);
  }
  for (const file of ['plan.json', 'results.jsonl', 'checkpoint.json', 'events.jsonl']) {
    expect(fs.existsSync(path.join(directory, 'ledger', file)), file).toBe(true);
  }

  // The terminal reads the finalized campaign the application wrote.
  expect(cernum('status', 'crossing', '--synthetic')).toContain('[complete]');
});
