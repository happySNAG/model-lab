// E2E · the critical user flows against the BUILT application (run `npm run build` first):
// launch → machine + Ollama detection → models → configure a benchmark of the built-in reference
// model → live progress → results (ranking, cases, recommendation) → close → reopen → history and
// results persist → settings/diagnostics render. Ollama is deliberately absent in this test
// (a closed loopback port), so the "unavailable" path is exercised too.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
let userData: string;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: { ...process.env, MODEL_LAB_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');
  return { app, page };
}

test.beforeAll(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ollamaEndpoint: 'http://127.0.0.1:1', thinkingMode: 'disabled', evidenceRootOverride: '' }));
});

test('install-to-results flow with the built-in reference model, surviving a relaunch', async () => {
  const { app, page } = await launch();

  // HOME: machine summary and Ollama guidance render.
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('.kv').first()).toContainText('Processor');
  await expect(page.locator('text=Ollama').first()).toBeVisible();
  await expect(page.locator('.pill', { hasText: /Not installed|Installed, not running|Endpoint problem/ }).first()).toBeVisible({ timeout: 30_000 });

  // MODELS: the reference model is always listed.
  await page.click('[data-nav="models"]');
  await expect(page.getByRole('heading', { name: 'Built-in reference model' })).toBeVisible();

  // BENCHMARK: pick the reference model and the foundation suite, start.
  await page.click('[data-nav="benchmark"]');
  const reference = page.locator('[data-testid="model-reference:deterministic"]');
  await expect(reference).toBeVisible();
  if (!(await reference.isChecked())) await reference.check();
  await page.getByRole('button', { name: 'None' }).click();
  await page.locator('[data-testid="suite-suite.model-lab.foundation-v2"]').check();
  await page.locator('[data-testid="suite-suite.model-lab.structured-output"]').check();
  await expect(page.locator('[data-testid="start-benchmark"]')).toBeEnabled({ timeout: 20_000 });
  await page.click('[data-testid="start-benchmark"]');
  await expect(page.getByRole('dialog')).toContainText(/Nothing leaves this (Mac|PC)/);
  await page.click('[data-testid="confirm-start"]');

  // LIVE RUN: progress reaches completion.
  await expect(page.getByRole('heading', { name: 'Live run' })).toBeVisible();
  await expect(page.locator('[data-testid="view-results"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="overall-progress"]')).toContainText('7');
  await page.click('[data-testid="view-results"]');

  // RESULTS: ranking, cases, drill-down, recommendation.
  await expect(page.getByRole('heading', { name: 'Results', exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="ranking-table"]')).toContainText('deterministic-reference:1');
  await page.click('[data-testid="tab-cases"]');
  const rows = page.locator('[data-testid="cases-table"] tbody tr');
  await expect(rows).toHaveCount(7);
  await rows.first().click();
  await expect(page.getByRole('dialog')).toContainText('Judgment');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.click('[data-testid="tab-recommendation"]');
  await expect(page.locator('.pill', { hasText: /Insufficient evidence|Disqualified|Recommended|Not recommended/ }).first()).toBeVisible();

  // The evidence store on disk has the canonical layout.
  const evidence = path.join(userData, 'evidence');
  expect(fs.existsSync(path.join(evidence, 'store-manifest.json'))).toBe(true);
  const runs = fs.readdirSync(path.join(evidence, 'runs'));
  expect(runs.length).toBe(2);
  await app.close();

  // RELAUNCH: history and results persist.
  const second = await launch();
  await second.page.click('[data-nav="history"]');
  await expect(second.page.locator('[data-testid="history-table"] tbody tr')).toHaveCount(1);
  await expect(second.page.locator('[data-testid="history-table"]')).toContainText('Completed');
  await second.page.locator('[data-testid="history-table"] tbody tr').first().click();
  await expect(second.page.locator('[data-testid="ranking-table"]')).toContainText('deterministic-reference:1');

  // SETTINGS / DIAGNOSTICS.
  await second.page.click('[data-nav="settings"]');
  await expect(second.page.getByText('Benchmark catalog')).toBeVisible();
  await expect(second.page.locator('text=all intact')).toBeVisible();
  await second.app.close();
});

test('a benchmark can be cancelled and the partial evidence is kept honestly', async () => {
  const { app, page } = await launch();
  await page.click('[data-nav="benchmark"]');
  const reference = page.locator('[data-testid="model-reference:deterministic"]');
  if (!(await reference.isChecked())) await reference.check();
  await page.getByRole('button', { name: 'Full lab' }).click();
  await expect(page.locator('[data-testid="start-benchmark"]')).toBeEnabled({ timeout: 20_000 });
  await page.click('[data-testid="start-benchmark"]');
  await page.click('[data-testid="confirm-start"]');
  await expect(page.getByRole('heading', { name: 'Live run' })).toBeVisible();
  await page.click('[data-testid="cancel-benchmark"]');
  await expect(page.locator('[data-testid="view-results"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.pill', { hasText: /Cancelled|Completed/ }).first()).toBeVisible();
  await page.click('[data-nav="history"]');
  await expect(page.locator('[data-testid="history-table"] tbody tr')).toHaveCount(2);
  await app.close();
});
