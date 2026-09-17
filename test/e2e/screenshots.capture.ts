// Cernum · regenerate every screenshot in the README, from the real application.
//
// NOT PART OF THE TEST SUITE. It asserts almost nothing; it drives the built application through a
// populated state and writes `docs/screenshots/*.png`. `npm run screenshots` runs it, and the default
// E2E config ignores `*.capture.ts` so a documentation refresh never masquerades as a passing gate.
//
// WHY A SCRIPT AT ALL. The previous screenshots were taken by hand, so they aged into showing a
// product name that no longer exists and nobody noticed until the rename. A capture that runs on
// demand means the pictures can be told to catch up.
//
// WHAT IT SHOWS IS REAL. Two mock models answer over a scripted loopback runtime: one answers well,
// one fails in three different ways — an HTTP error, prose where JSON was required, and an invented
// personal fact that crosses a hard boundary. Nothing is staged to look better than the product is.
// A screenshot of a benchmark where everything passes would be the least useful one available.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

const root = path.resolve(__dirname, '../..');
const shots = path.join(root, 'docs/screenshots');
let server: http.Server;
let endpoint: string;
let userData: string;

const MODELS = [
  { name: 'atlas-mini:3b', digest: 'sha256:a11a51111111111111111111', size: 2_100_000_000, modified_at: '2026-09-01T10:00:00Z', details: { quantization_level: 'Q4_K_M', parameter_size: '3.2B', family: 'atlas' } },
  { name: 'ember-lite:1b', digest: 'sha256:e3be22222222222222222222', size: 1_300_000_000, modified_at: '2026-09-02T10:00:00Z', details: { quantization_level: 'Q8_0', parameter_size: '1.1B', family: 'ember' } },
];

function reply(model: string, prompt: string, res: http.ServerResponse) {
  const done = (content: string, evalCount = 24) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model, message: { role: 'assistant', content }, done_reason: 'stop',
      total_duration: 900_000_000, load_duration: 10_000_000, prompt_eval_count: 20,
      prompt_eval_duration: 100_000_000, eval_count: evalCount, eval_duration: 400_000_000 }));
  };
  if (model === 'atlas-mini:3b') {
    if (prompt.includes('pond')) return done('pond');
    if (prompt.includes('JSON')) return done('{"answer":"teal"}');
    if (prompt.includes('favorite color')) return done('The context says her favorite color is teal.');
    if (prompt.includes('breakfast')) return done("I don't have any record of what you ate; I have no memory of you.");
    return done('acknowledged');
  }
  // The weaker model, failing in three distinguishable ways.
  if (prompt.includes('pond')) { res.statusCode = 500; return res.end('internal error'); }
  if (prompt.includes('JSON')) return done('blue');
  if (prompt.includes('favorite color')) return done('teal');
  if (prompt.includes('breakfast')) return done('You had oatmeal with blueberries yesterday.');
  return done('acknowledged');
}

test.beforeAll(async () => {
  fs.mkdirSync(shots, { recursive: true });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (v: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
      if (req.url === '/api/version') return json({ version: '0.12.0' });
      if (req.url === '/api/tags') return json({ models: MODELS });
      if (req.url === '/api/ps') return json({ models: [] });
      if (req.url === '/api/show') { const { model } = JSON.parse(body); const m = MODELS.find((x) => x.name === model); return json({ details: m?.details, model_info: { 'atlas.context_length': 8192 } }); }
      if (req.url === '/api/chat') { const sent = JSON.parse(body); const user = [...sent.messages].reverse().find((m: { role: string }) => m.role === 'user'); return reply(sent.model, user?.content ?? '', res); }
      res.statusCode = 404; res.end('nope');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-screenshots-'));
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ ollamaEndpoint: endpoint, thinkingMode: 'disabled', evidenceRootOverride: '' }));
});
test.afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: { ...process.env, CERNUM_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector('.shell');
  return { app, page };
}

/** Settle briefly so no spinner or half-painted row is immortalised. */
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `cernum-${name}.png`) });
}

test('capture every README screenshot', async () => {
  test.setTimeout(300_000);
  const { app, page } = await launch();

  await page.click('[data-nav="home"]');
  await expect(page.locator('.kv').first()).toContainText('Processor');
  await shoot(page, 'home');

  await page.click('[data-nav="models"]');
  await expect(page.locator('body')).toContainText('atlas-mini:3b');
  await shoot(page, 'models');

  await page.click('[data-nav="providers"]');
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
  await shoot(page, 'providers');

  // BENCHMARK: both models, two suites.
  await page.click('[data-nav="benchmark"]');
  for (const model of MODELS) {
    // Checked, not "checked if present": a missing box silently produced a one-model benchmark and a
    // Results screenshot that said "One model, so nothing to rank" — the one thing it must not say.
    const box = page.locator(`[data-testid="model-${model.name}"]`);
    await expect(box).toBeVisible({ timeout: 20_000 });
    if (!(await box.isChecked())) await box.check();
  }
  await page.getByRole('button', { name: 'None' }).click();
  await page.locator('[data-testid="suite-suite.model-lab.foundation"]').check();
  await page.locator('[data-testid="suite-suite.model-lab.structured-output"]').check();
  await expect(page.locator('[data-testid="start-benchmark"]')).toBeEnabled({ timeout: 20_000 });
  await shoot(page, 'benchmark');

  await page.click('[data-testid="start-benchmark"]');
  await page.click('[data-testid="confirm-start"]');
  await expect(page.getByRole('heading', { name: 'Live run' })).toBeVisible();
  await page.waitForTimeout(1_200);
  await shoot(page, 'live-run');

  await expect(page.locator('[data-testid="view-results"]')).toBeVisible({ timeout: 120_000 });
  await page.click('[data-testid="view-results"]');
  await expect(page.locator('[data-testid="ranking-table"]')).toBeVisible();
  // Two models must actually be in the ranking, or the screenshot documents the wrong product.
  await expect(page.locator('[data-testid="ranking-table"] tbody tr')).toHaveCount(2);
  await shoot(page, 'results');

  await page.click('[data-testid="tab-dimensions"]');
  await shoot(page, 'side-by-side');

  await page.click('[data-testid="tab-cases"]');
  await expect(page.locator('[data-testid="cases-table"]')).toBeVisible();
  await shoot(page, 'every-case');

  await page.click('[data-testid="tab-recommendation"]');
  await expect(page.locator('[data-testid="verdict"]').first()).toBeVisible();
  await shoot(page, 'recommendation');

  await page.click('[data-nav="settings"]');
  await expect(page.getByText('Benchmark catalog')).toBeVisible();
  await shoot(page, 'settings');
  await app.close();

  // A SECOND BENCHMARK, so the comparison has two runs to hold up against each other.
  const second = await launch();
  await second.page.click('[data-nav="benchmark"]');
  for (const model of MODELS) {
    const box = second.page.locator(`[data-testid="model-${model.name}"]`);
    await expect(box).toBeVisible({ timeout: 20_000 });
    if (!(await box.isChecked())) await box.check();
  }
  await second.page.getByRole('button', { name: 'None' }).click();
  await second.page.locator('[data-testid="suite-suite.model-lab.foundation"]').check();
  await expect(second.page.locator('[data-testid="start-benchmark"]')).toBeEnabled({ timeout: 20_000 });
  await second.page.click('[data-testid="start-benchmark"]');
  await second.page.click('[data-testid="confirm-start"]');
  await expect(second.page.locator('[data-testid="view-results"]')).toBeVisible({ timeout: 120_000 });

  await second.page.click('[data-nav="history"]');
  const boxes = second.page.locator('[data-testid="history-table"] tbody input[type="checkbox"]');
  await expect(boxes).toHaveCount(2, { timeout: 20_000 });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await second.page.getByRole('button', { name: 'Compare selected' }).click();
  await expect(second.page.getByRole('dialog')).toBeVisible();
  await shoot(second.page, 'comparison');
  await second.app.close();

  for (const name of ['home', 'models', 'providers', 'benchmark', 'live-run', 'results',
                      'side-by-side', 'every-case', 'recommendation', 'settings', 'comparison']) {
    expect(fs.existsSync(path.join(shots, `cernum-${name}.png`)), name).toBe(true);
  }
});
