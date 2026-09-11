// E2E · the desktop Start button, against a scripted streaming "Ollama".
//
// This is the regression test for the release-blocking defect. A canonical campaign started from
// the Campaigns screen used to throw `LiveResidencyDisabled` at the end of its first candidate,
// because the desktop service built its live host without enabling residency management. Every one
// of these tests would have failed on that build; the first one is the fix, and the rest are the
// things the fix must not have broken or quietly weakened.
//
// The mock runtime is scriptable in one respect that matters: whether a model actually leaves
// memory when asked. `/api/ps` reports what is resident, and a chat carrying `keep_alive: 0` is what
// makes a model leave — exactly as a real Ollama behaves — so both the success path and the refusal
// path are driven by the runtime's own answers rather than by a flag in the test.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ASYNC on purpose. The scripted runtime lives in THIS process, so a synchronous child-process call
// would block the event loop that has to answer it — the command would wait for a server that
// cannot reply until the command returns.
const run = promisify(execFile);
import { AddressInfo } from 'node:net';

const root = path.resolve(__dirname, '../..');

const MODELS = [
  { name: 'mock-alpha:1b', digest: 'sha256:1111111111111111', size: 1_000_000_000, modified_at: '2026-09-01T10:00:00Z',
    details: { quantization_level: 'Q4_K_M', parameter_size: '1.0B', family: 'mock' }, capabilities: ['completion'] },
  { name: 'mock-beta:2b', digest: 'sha256:2222222222222222', size: 2_000_000_000, modified_at: '2026-09-02T10:00:00Z',
    details: { quantization_level: 'Q4_K_M', parameter_size: '2.0B', family: 'mock' }, capabilities: ['completion', 'thinking'] },
];

interface Runtime {
  server: http.Server;
  endpoint: string;
  /** Models the runtime currently reports as resident. */
  resident: Set<string>;
  /** When true, a keep_alive:0 request is accepted and ignored: the weights never leave. */
  refuseToUnload: boolean;
  chatCount: number;
}

async function startRuntime(): Promise<Runtime> {
  const state: Runtime = { server: undefined as unknown as http.Server, endpoint: '', resident: new Set(), refuseToUnload: false, chatCount: 0 };
  state.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (req.url === '/api/version') return json({ version: '0.0.0-mock' });
      if (req.url === '/api/tags') return json({ models: MODELS });
      if (req.url === '/api/ps') return json({ models: [...state.resident].map((name) => ({ name, size: 1, size_vram: 1 })) });
      if (req.url === '/api/show') {
        const { model } = JSON.parse(body) as { model: string };
        const found = MODELS.find((m) => m.name === model);
        return json({ details: found?.details, capabilities: found?.capabilities, model_info: { 'mock.context_length': 8192 } });
      }
      if (req.url === '/api/chat') {
        const sent = JSON.parse(body) as { model: string; stream?: boolean; keep_alive?: number };
        // keep_alive: 0 is an UNLOAD. Honour it unless this runtime is scripted not to.
        if (sent.keep_alive === 0) {
          if (!state.refuseToUnload) state.resident.delete(sent.model);
          return json({ model: sent.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 0 });
        }
        state.resident.add(sent.model);
        state.chatCount += 1;
        const final = {
          model: sent.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop',
          total_duration: 40_000_000, load_duration: 5_000_000, prompt_eval_count: 12,
          prompt_eval_duration: 5_000_000, eval_count: 6, eval_duration: 20_000_000,
        };
        if (sent.stream) {
          res.setHeader('Content-Type', 'application/x-ndjson');
          res.write(JSON.stringify({ model: sent.model, message: { role: 'assistant', content: 'acknowledged' }, done: false }) + '\n');
          return res.end(JSON.stringify(final) + '\n');
        }
        return json({ ...final, message: { role: 'assistant', content: 'acknowledged' } });
      }
      res.statusCode = 404;
      res.end('nope');
    });
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.endpoint = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  return state;
}

let runtime: Runtime;
let userData: string;
let campaignRoot: string;

test.beforeAll(async () => {
  runtime = await startRuntime();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-canonical-'));
  campaignRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-canonical-campaigns-'));
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ ollamaEndpoint: runtime.endpoint, thinkingMode: 'disabled', evidenceRootOverride: '' }));
});
test.afterAll(async () => {
  runtime.server.closeAllConnections?.();
  await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
});
test.beforeEach(() => { runtime.resident.clear(); runtime.refuseToUnload = false; });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(root, 'out/main/index.js')],
    env: { ...process.env, MODEL_LAB_USER_DATA: userData, MODEL_LAB_CAMPAIGN_ROOT: campaignRoot },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');
  await page.click('[data-nav="campaigns"]');
  return { app, page };
}

/** Create a campaign through the interface: both models, one suite, and the mode chosen explicitly. */
async function createThroughTheInterface(page: Page, name: string, options: { observeOnly?: boolean; thinking?: boolean } = {}): Promise<void> {
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  await page.locator('.modal input').first().fill(name);
  const lists = page.locator('.modal .check-list');
  for (const model of MODELS) await lists.nth(0).locator('label', { hasText: model.name }).locator('input').check();
  const suites = lists.nth(1).locator('input[type=checkbox]');
  const suiteCount = await suites.count();
  for (let index = 0; index < suiteCount; index++) await suites.nth(index).uncheck();
  await suites.nth(0).check();
  if (options.observeOnly) await page.locator('[data-testid="canonical-toggle"]').uncheck();
  if (options.thinking) await page.locator('[data-testid="thinking-toggle"]').check();
  await page.getByRole('button', { name: 'Freeze and create' }).click();
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText(name, { timeout: 20_000 });
}

/**
 * Wait until the run has genuinely finished writing.
 *
 * The Campaigns screen reports `complete` as soon as the ledger accounts for every slot — which is
 * before the final residency release has been proved, because that happens after the last attempt.
 * Reading the event trace at that moment races the run rather than observing it.
 */
async function waitForRunToFinish(name: string): Promise<Record<string, unknown>[]> {
  const file = path.join(campaignRoot, name, 'ledger/events.jsonl');
  for (let attempt = 0; attempt < 240; attempt++) {
    const events = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    if (events.some((event) => event.kind === 'lockReleased')) return events;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${name} never finished writing its event trace`);
}

async function openDetail(page: Page, name: string) {
  await page.locator('[data-testid="campaign-table"] tr', { hasText: name }).first().click();
  await expect(page.locator('.modal')).toBeVisible();
}

/** The detail modal stays open while a campaign runs, which is the point of it. Close it explicitly. */
async function closeModal(page: Page) {
  await page.locator('.modal').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

test('a canonical campaign started from the Start button runs to clean completion', async () => {
  const { app, page } = await launch();
  await createThroughTheInterface(page, 'ui-canonical');
  await openDetail(page, 'ui-canonical');

  // The frozen policy is stated in the detail view before anything runs.
  await expect(page.locator('.modal')).toContainText('canonical · residency managed on the benchmark endpoint');

  // Start discloses the authority, names the endpoint, and asks once.
  await page.getByRole('button', { name: 'Start' }).click();
  const disclosure = page.locator('.modal', { hasText: 'Before this campaign starts' });
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText(runtime.endpoint);
  await expect(disclosure).toContainText('load and unload models on');
  await expect(disclosure).toContainText('No other runtime, port or process on this machine is touched');
  await expect(disclosure).toContainText('not asked again between attempts');
  await page.locator('[data-testid="confirm-start"]').click();

  // THE REGRESSION: this used to end in LiveResidencyDisabled instead of a result.
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('complete', { timeout: 120_000 });
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('8/8');
  const events = await waitForRunToFinish('ui-canonical');
  await app.close();

  // And the evidence says the release happened and was proved: once at the candidate transition,
  // once at the end of the run.
  expect(events.filter((event) => event.kind === 'residencyVerified').length).toBe(2);
  expect(events.some((event) => event.kind === 'abort')).toBe(false);
  expect(events.some((event) => event.kind === 'residencyNotManaged')).toBe(false);
  // The runtime lease was taken and given back.
  expect(events.some((event) => event.kind === 'runtimeLeaseAcquired')).toBe(true);
  expect(events.some((event) => event.kind === 'runtimeLeaseReleased')).toBe(true);

  const report = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'ui-canonical/manifest.json'), 'utf8')) as Record<string, any>;
  expect(report.execution).toEqual({ residency: 'managed', thinkingMode: 'disabled' });
  expect(report.canonical).toBe(true);
});

test('a runtime that will not release its weights aborts the campaign, and never warns instead', async () => {
  runtime.refuseToUnload = true;
  const { app, page } = await launch();
  await createThroughTheInterface(page, 'ui-stuck');
  await openDetail(page, 'ui-stuck');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.locator('[data-testid="confirm-start"]').click();

  // The detail view stays open while it runs — which is how a person watches it stop.
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('aborted', { timeout: 120_000 });
  await expect(page.locator('.modal')).toContainText('Stopped at candidateTransition', { timeout: 30_000 });
  await expect(page.locator('.modal')).toContainText('would not release its weights');
  await expect(page.locator('.modal')).toContainText('were blocked');
  await app.close();

  const abort = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'ui-stuck/ledger/abort.json'), 'utf8')) as Record<string, any>;
  expect(abort.stage).toBe('candidateTransition');
  expect(abort.blockedSlotCount).toBeGreaterThan(0);
  // Blocked slots carry no result: they were never attempted.
  const results = fs.readFileSync(path.join(campaignRoot, 'ui-stuck/ledger/results.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as { slotKey: string });
  const recorded = new Set(results.map((row) => row.slotKey));
  for (const key of abort.blockedSlotKeys as string[]) expect(recorded.has(key)).toBe(false);
});

test('an observe-only campaign is labelled noncanonical everywhere it appears', async () => {
  runtime.refuseToUnload = true; // which an observe-only campaign never notices, because it never asks
  const { app, page } = await launch();
  await createThroughTheInterface(page, 'ui-observed', { observeOnly: true });

  await expect(page.locator('[data-testid="campaign-table"] tr', { hasText: 'ui-observed' })).toContainText('observe-only');
  await openDetail(page, 'ui-observed');
  await expect(page.locator('.modal')).toContainText('observe-only · noncanonical, residency untouched');
  await expect(page.locator('.modal')).toContainText('not comparable with a campaign that managed residency');

  await page.getByRole('button', { name: 'Start' }).click();
  const disclosure = page.locator('.modal', { hasText: 'This campaign is observe-only' });
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText('residency was not managed');
  await page.locator('[data-testid="confirm-start"]').click();

  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('complete', { timeout: 120_000 });
  await waitForRunToFinish('ui-observed');

  // A canonical twin over the same prompts, created but not run — enough to compare identities.
  await closeModal(page);
  await createThroughTheInterface(page, 'ui-observed-twin');
  await app.close();

  const manifest = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'ui-observed/manifest.json'), 'utf8')) as Record<string, any>;
  expect(manifest.canonical).toBe(false);
  expect(manifest.execution.residency).toBe('observeOnly');
  const rows = fs.readFileSync(path.join(campaignRoot, 'ui-observed/ledger/results.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.canonical).toBe(false);

  // Its manifest identity differs from the canonical campaign over the same prompts, so the two
  // cannot present themselves under one seal.
  const canonical = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'ui-observed-twin/manifest.json'), 'utf8')) as Record<string, any>;
  expect(manifest.promptsDigest).toBe(canonical.promptsDigest);
  expect(manifest.manifestDigest).not.toBe(canonical.manifestDigest);
});

test('a second campaign against the same endpoint is refused before a single request', async () => {
  const { app, page } = await launch();
  await createThroughTheInterface(page, 'ui-contender');
  await app.close();

  // A terminal campaign takes the endpoint and holds it, exactly as a long run would.
  const holder = path.join(campaignRoot, 'holder.ts');
  fs.writeFileSync(holder, `
    import { acquireRuntimeLease } from '${path.join(root, 'src/engine/runtime-lease')}';
    const handle = acquireRuntimeLease(process.argv[2], {
      processType: 'terminal', command: 'cernum run other-campaign', campaignID: 'campaign:other',
      campaignName: 'other-campaign', endpoint: process.argv[3],
    });
    process.stdout.write('held ' + process.pid + '\\n');
    setInterval(() => handle.heartbeat(), 1_000);
  `, 'utf8');
  const { spawn } = await import('node:child_process');
  const child = spawn('npx', ['tsx', holder, campaignRoot, runtime.endpoint], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let holderPID = 0;
  try {
    holderPID = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never took the endpoint')), 60_000);
      child.stdout!.on('data', (buffer: Buffer) => {
        const match = /held (\d+)/.exec(buffer.toString());
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });

    const before = runtime.chatCount;
    const second = await launch();
    await openDetail(second.page, 'ui-contender');
    await second.page.getByRole('button', { name: 'Start' }).click();
    await second.page.locator('[data-testid="confirm-start"]').click();

    const refusal = second.page.locator('.note.bad');
    await expect(refusal).toContainText('already held by campaign', { timeout: 30_000 });
    await expect(refusal).toContainText('other-campaign');
    await expect(refusal).toContainText('point this campaign at a different endpoint');
    // The sentence, not the plumbing it arrived in.
    await expect(refusal).not.toContainText('Error invoking remote method');
    await expect(refusal).not.toContainText('RuntimeLeaseError');
    await second.app.close();

    // Refused BEFORE inference: the runtime saw nothing at all.
    expect(runtime.chatCount).toBe(before);
    const events = fs.readFileSync(path.join(campaignRoot, 'ui-contender/ledger/events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.filter((event) => event.kind === 'runtimeLeaseRefused').length).toBe(1);
    expect(events.some((event) => event.kind === 'runtimeLeaseAcquired')).toBe(false);
    expect(fs.existsSync(path.join(campaignRoot, 'ui-contender/ledger/results.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(campaignRoot, 'ui-contender/ledger/results.jsonl'), 'utf8').trim()).toBe('');
  } finally {
    // Signal the process that actually took the lease. Killing the `npx` wrapper alone would leave
    // the real holder alive, still heartbeating, and the next test refused for a good reason.
    if (holderPID) { try { process.kill(holderPID, 'SIGKILL'); } catch { /* already gone */ } }
    child.kill('SIGKILL');
    for (let attempt = 0; attempt < 100 && holderPID; attempt++) {
      try { process.kill(holderPID, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test('a canonical campaign run from the terminal completes the same way, and the UI observes it', async () => {
  const cernum = async (...args: string[]) => (await run('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot, '--endpoint', runtime.endpoint],
    { cwd: root, encoding: 'utf8', timeout: 240_000 })).stdout;

  // No `--live-residency` anywhere: residency management is the default for a canonical campaign,
  // which is the whole point of the terminal half of this correction.
  const created = await cernum('create', 'cli-canonical', '--models', MODELS.map((m) => m.name).join(','),
    '--suites', 'suite.model-lab.foundation');
  expect(created).toContain('canonical · residency managed on the benchmark endpoint');
  expect(created).toContain('This is a CANONICAL campaign');
  expect(created).toContain(`Cernum will load and unload models on ${runtime.endpoint}`);
  expect(created).toContain('No other runtime, port or process on this machine is touched');

  const ran = await cernum('run', 'cli-canonical');
  expect(ran).toContain(`Cernum is managing model residency on ${runtime.endpoint} for this run, and on nothing else.`);
  expect(ran).toContain('[complete]');
  expect(ran).toContain('8/8 attempts recorded');

  const events = fs.readFileSync(path.join(campaignRoot, 'cli-canonical/ledger/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events.filter((event) => event.kind === 'residencyVerified').length).toBe(2);
  expect(events.some((event) => event.kind === 'abort')).toBe(false);
  expect(events.some((event) => event.kind === 'runtimeLeaseAcquired')).toBe(true);

  // The frozen policy is what the desktop application reads it as, from the same directory.
  const { app, page } = await launch();
  await expect(page.locator('[data-testid="campaign-table"]')).toContainText('cli-canonical', { timeout: 20_000 });
  await openDetail(page, 'cli-canonical');
  await expect(page.locator('.modal')).toContainText('canonical · residency managed on the benchmark endpoint');
  await expect(page.locator('.modal')).toContainText('8 of 8');
  await app.close();
});

test('the terminal refuses to change a frozen mode rather than quietly obeying', async () => {
  const attempt = async (...args: string[]) => {
    try {
      await run('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot, '--endpoint', runtime.endpoint],
        { cwd: root, encoding: 'utf8', timeout: 240_000 });
      return { status: 0, stderr: '' };
    } catch (error) {
      const failure = error as { code: number; stderr: string };
      return { status: failure.code, stderr: String(failure.stderr ?? '') };
    }
  };

  const observeOnly = await attempt('run', 'cli-canonical', '--observe-only');
  expect(observeOnly.status).toBe(2);
  expect(observeOnly.stderr).toMatch(/frozen as a CANONICAL campaign/);
  expect(observeOnly.stderr).toMatch(/bound into its manifest and cannot change after the freeze/);

  const thinking = await attempt('run', 'cli-canonical', '--thinking', 'on');
  expect(thinking.status).toBe(2);
  expect(thinking.stderr).toMatch(/bound into its manifest/);

  // And the campaign is untouched by either refusal.
  const { stdout } = await run('npx', ['tsx', 'src/cli/cernum.ts', 'status', 'cli-canonical', '--root', campaignRoot, '--endpoint', runtime.endpoint],
    { cwd: root, encoding: 'utf8', timeout: 240_000 });
  expect(stdout).toContain('[complete]');
  expect(stdout).toContain('canonical · residency managed');
});

test('a model that cannot think is refused at create, not substituted at run', async () => {
  let stderr = '';
  let status = 0;
  try {
    await run('npx', ['tsx', 'src/cli/cernum.ts', 'create', 'cli-thinking', '--models', 'mock-alpha:1b',
      '--suites', 'suite.model-lab.foundation', '--thinking', 'on', '--root', campaignRoot, '--endpoint', runtime.endpoint],
      { cwd: root, encoding: 'utf8', timeout: 240_000 });
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    status = failure.code;
    stderr = String(failure.stderr ?? '');
  }
  expect(status).toBe(1);
  expect(stderr).toMatch(/cannot think/);
  expect(stderr).toMatch(/Nothing was frozen/);
  expect(fs.existsSync(path.join(campaignRoot, 'cli-thinking'))).toBe(false);

  // The thinking-capable model IS accepted, and the mode is frozen into its manifest.
  await run('npx', ['tsx', 'src/cli/cernum.ts', 'create', 'cli-thinking', '--models', 'mock-beta:2b',
    '--suites', 'suite.model-lab.foundation', '--thinking', 'on', '--root', campaignRoot, '--endpoint', runtime.endpoint],
    { cwd: root, encoding: 'utf8', timeout: 240_000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(campaignRoot, 'cli-thinking/manifest.json'), 'utf8')) as Record<string, any>;
  expect(manifest.execution).toEqual({ residency: 'managed', thinkingMode: 'enabled' });
});
