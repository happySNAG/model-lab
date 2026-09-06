// E2E · the real application against a scripted loopback "Ollama": detection, model enumeration with
// metadata, a two-model benchmark in which one model answers well and the other returns an HTTP error,
// prose where JSON was demanded, a reply that overruns the 30 s budget (timeout), and an invented
// personal fact (hard-boundary violation) — every one visible in Live run, Results, and History.

import { test, expect, _electron as electron } from '@playwright/test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

const root = path.resolve(__dirname, '../..');
let server: http.Server;
let endpoint: string;
let userData: string;

const MODELS = [
  { name: 'mock-good:1b', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaa', size: 1_300_000_000, modified_at: '2026-08-01T10:00:00Z', details: { quantization_level: 'Q4_K_M', parameter_size: '1.2B', family: 'mock' } },
  { name: 'mock-flaky:3b', digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbb', size: 2_100_000_000, modified_at: '2026-08-02T10:00:00Z', details: { quantization_level: 'Q8_0', parameter_size: '3.1B', family: 'mock' } },
];

function reply(model: string, prompt: string, res: http.ServerResponse) {
  const done = (content: string) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model, message: { role: 'assistant', content }, done_reason: 'stop', total_duration: 900_000_000, load_duration: 10_000_000, prompt_eval_count: 20, prompt_eval_duration: 100_000_000, eval_count: 8, eval_duration: 400_000_000 })); };
  if (model === 'mock-good:1b') {
    if (prompt.includes('pond')) return done('pond');
    if (prompt.includes('JSON')) return done('{"answer":"teal"}');
    if (prompt.includes('favorite color')) return done('The context says her favorite color is teal.');
    if (prompt.includes('breakfast')) return done("I don't have any record of what you ate; I have no memory of you.");
    return done('acknowledged');
  }
  // mock-flaky: one failure of each kind.
  if (prompt.includes('pond')) { res.statusCode = 500; return res.end('internal error'); }
  if (prompt.includes('JSON')) return done('blue');                       // prose where JSON was demanded → malformedOutput
  if (prompt.includes('favorite color')) { setTimeout(() => { try { done('teal'); } catch { /* client gone */ } }, 33_000); return; } // > 30 s budget → timedOut
  if (prompt.includes('breakfast')) return done('You had oatmeal with blueberries yesterday.'); // invented personal fact → boundary violated
  return done('acknowledged');
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (v: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
      if (req.url === '/api/version') return json({ version: '0.0.0-mock' });
      if (req.url === '/api/tags') return json({ models: MODELS });
      if (req.url === '/api/ps') return json({ models: [] });
      if (req.url === '/api/show') { const { model } = JSON.parse(body); const m = MODELS.find((x) => x.name === model); return json({ details: m?.details, model_info: { 'mock.context_length': 8192 } }); }
      if (req.url === '/api/chat') { const sent = JSON.parse(body); const user = [...sent.messages].reverse().find((m: { role: string }) => m.role === 'user'); return reply(sent.model, user?.content ?? '', res); }
      res.statusCode = 404; res.end('nope');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-mock-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ollamaEndpoint: endpoint, thinkingMode: 'disabled', evidenceRootOverride: '' }));
});
test.afterAll(async () => { server.closeAllConnections?.(); await new Promise<void>((r) => server.close(() => r())); });

test('detects the runtime, lists its models, benchmarks two of them, and reports every failure kind honestly', async () => {
  test.setTimeout(240_000);
  const app = await electron.launch({ args: [path.join(root, 'out/main/index.js')], env: { ...process.env, MODEL_LAB_USER_DATA: userData } });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');

  // HOME: Ollama detected as running, two models counted.
  await expect(page.locator('.pill', { hasText: 'Running · 0.0.0-mock' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.hero-number').first()).toHaveText('2');

  // MODELS: enumeration with metadata.
  await page.click('[data-nav="models"]');
  const rows = page.locator('[data-testid="models-table"] tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('mock-flaky:3b');
  await expect(rows.first()).toContainText('Q8_0');
  await expect(rows.nth(1)).toContainText('1.2B');
  await expect(page.locator('[data-testid="models-table"]')).toContainText('2.0 GB');

  // BENCHMARK: both Ollama models, foundation suite only.
  await page.click('[data-nav="benchmark"]');
  await page.locator('[data-testid="model-mock-good:1b"]').check();
  await page.locator('[data-testid="model-mock-flaky:3b"]').check();
  const reference = page.locator('[data-testid="model-reference:deterministic"]');
  if (await reference.isChecked()) await reference.uncheck();
  await page.getByRole('button', { name: 'None' }).click();
  await page.locator('[data-testid="suite-suite.model-lab.foundation"]').check();
  await expect(page.locator('[data-testid="start-benchmark"]')).toBeEnabled({ timeout: 20_000 });
  await page.click('[data-testid="start-benchmark"]');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`through Ollama at ${endpoint}`);
  await expect(dialog).toContainText('Attempts');
  await page.click('[data-testid="confirm-start"]');

  // LIVE RUN: real progress, current model/case, and the slow prompt visibly counting up.
  await expect(page.getByRole('heading', { name: 'Live run' })).toBeVisible();
  await expect(page.locator('.note.accent', { hasText: 'is answering' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.pill', { hasText: /Timed out|Malformed|Failed/ }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="view-results"]')).toBeVisible({ timeout: 150_000 });
  await expect(page.locator('[data-testid="overall-progress"]')).toContainText('10 / 10');
  await page.click('[data-testid="view-results"]');

  // RESULTS: the verdict names the clean model first; the flaky one carries each failure kind.
  await expect(page.locator('[data-testid="verdict"]')).toContainText('mock-good:1b ranked first of 2');
  await expect(page.locator('[data-testid="verdict"]')).toContainText('1 of 2 models crossed a hard boundary');
  const ranking = page.locator('[data-testid="ranking-table"] tbody tr');
  await expect(ranking.first()).toContainText('mock-good:1b');
  await expect(ranking.first()).toContainText('none crossed');
  await expect(ranking.nth(1)).toContainText('mock-flaky:3b');
  await expect(ranking.nth(1)).toContainText('violated');
  await expect(page.locator('.card', { hasText: 'Ollama 0.0.0-mock' }).first()).toBeVisible();
  await page.click('[data-testid="tab-cases"]');
  await page.getByLabel('Filter by outcome').selectOption('problems');
  const cases = page.locator('[data-testid="cases-table"]');
  await expect(cases).toContainText('Timed out');
  await expect(cases).toContainText('Malformed');
  await expect(cases).toContainText('Failed');
  await expect(cases).toContainText('Boundary violated');
  await cases.locator('tbody tr', { hasText: 'Timed out' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('ollama.timeout');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.click('[data-testid="tab-recommendation"]');
  await expect(page.locator('.card', { hasText: 'mock-flaky:3b' }).locator('.card-title .pill')).toContainText('Disqualified');

  // HISTORY: the benchmark with its runtime version.
  await page.click('[data-nav="history"]');
  await expect(page.locator('[data-testid="history-table"]')).toContainText('Ollama 0.0.0-mock');
  await expect(page.locator('[data-testid="history-table"]')).toContainText('mock-flaky:3b, mock-good:1b');
  await app.close();
});
