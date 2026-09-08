// E2E · one campaign, two surfaces.
//
// This is the acceptance test for the engine boundary: a campaign created and run entirely from the
// supported terminal command is opened, read and finalized by the DESKTOP APPLICATION, with no
// message passing between them and nothing but the shared campaign directory in common. If the two
// callers ever grow separate ideas of what a campaign is, this fails.
//
// Run `npm run build` first. The campaign is synthetic, so no request reaches any server.

import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
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

/** Run the command expecting it to refuse, and return what it said and the code it said it with. */
function cernumExpectingFailure(...args: string[]): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', 'src/cli/cernum.ts', ...args, '--root', campaignRoot], {
      cwd: root, encoding: 'utf8', env: { ...process.env }, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stderr: '', stdout };
  } catch (error) {
    const failure = error as { status: number; stderr: string; stdout: string };
    return { status: failure.status, stderr: String(failure.stderr ?? ''), stdout: String(failure.stdout ?? '') };
  }
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

// ---------------------------------------------------------------------------------------------
// One campaign, two processes.
//
// The engine boundary makes two surfaces agree about what a campaign IS. The lock makes them agree
// about who is RUNNING it — which the boundary alone cannot do, because neither process can see the
// other's memory. This test uses two real operating-system processes and one campaign directory,
// and it kills one of them, because a crash-recovery claim that was never allowed to crash is not
// a claim about anything.

test('a second runner is refused while a live one holds the campaign, and a crashed one is recovered', async () => {
  cernum('create', 'contested', '--synthetic', '--models', 'alpha:1b',
    '--suites', 'suite.model-lab.foundation', '--repeats', '1');
  const directory = path.join(campaignRoot, 'contested');
  const lockFile = path.join(directory, 'campaign.lock');

  // A separate process takes the campaign and holds it, exactly as a desktop window would.
  const holderScript = path.join(campaignRoot, 'holder.ts');
  fs.writeFileSync(holderScript, `
    import { acquireCampaignLock } from '${path.join(root, 'src/engine/lock')}';
    const handle = acquireCampaignLock(process.argv[2], {
      processType: 'desktop', command: 'Model Lab · Campaigns screen', campaignID: 'campaign:contested', campaignName: 'contested',
    });
    process.stdout.write('held ' + handle.record.pid + '\\n');
    setInterval(() => handle.heartbeat(), 1_000);
  `, 'utf8');

  let holder: ChildProcess | undefined;
  try {
    holder = spawn('npx', ['tsx', holderScript, directory], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const heldByPID = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the holder never took the campaign')), 60_000);
      holder!.stdout!.on('data', (buffer: Buffer) => {
        const match = /held (\d+)/.exec(buffer.toString());
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    expect(fs.existsSync(lockFile)).toBe(true);

    // ---- The terminal refuses, by name, and runs nothing.
    const refused = cernumExpectingFailure('run', 'contested', '--synthetic');
    expect(refused.status).toBe(4);
    expect(refused.stderr).toContain(`desktop process ${heldByPID}`);
    expect(refused.stderr).toContain('Model Lab · Campaigns screen');
    expect(refused.stderr).toMatch(/Pause the first one/);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'ledger', 'checkpoint.json'), 'utf8')).terminalCount).toBe(0);

    // ---- `unlock` will not break a live lock on its own say-so either.
    const notBroken = cernumExpectingFailure('unlock', 'contested');
    expect(notBroken.status).toBe(4);
    expect(notBroken.stderr).toMatch(/Nothing was released/);
    expect(fs.existsSync(lockFile)).toBe(true);

    // ---- The desktop application, which started nothing, still shows who has it.
    const watching = await launch();
    await watching.page.click('[data-nav="campaigns"]');
    const table = watching.page.locator('[data-testid="campaign-table"]');
    await expect(table).toContainText('contested', { timeout: 20_000 });
    await expect(table).toContainText(`running in a desktop · pid ${heldByPID}`);
    await watching.app.close();

    // ---- Now it crashes. SIGKILL to the process that actually recorded itself in the lock, so
    // there is no chance to clean up — which is the point. (Signalling the `npx` wrapper would
    // leave the real holder alive, and the lock would still be honestly live.)
    process.kill(heldByPID, 'SIGKILL');
    holder.kill('SIGKILL');
    holder = undefined;
    const gone = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(heldByPID, 0); } catch { return true; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    expect(await gone()).toBe(true);
    // The lock outlives the process that took it. That is what a crash looks like on disk.
    expect(fs.existsSync(lockFile)).toBe(true);
  } finally {
    holder?.kill('SIGKILL');
  }

  // ---- The next run reclaims the crashed owner's lock, records that it did, and finishes.
  const recovered = cernum('run', 'contested', '--synthetic');
  expect(recovered).toContain('[complete]');
  expect(fs.existsSync(lockFile)).toBe(false);

  const events = fs.readFileSync(path.join(directory, 'ledger', 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events.filter((event) => event.kind === 'lockRefused')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'lockRecovered')).toHaveLength(1);
  expect(events.filter((event) => event.kind === 'lockReleased').length).toBeGreaterThan(0);

  // The crash is kept as evidence rather than tidied away.
  const kept = fs.readdirSync(path.join(directory, 'locks'));
  expect(kept.filter((name) => name.startsWith('recovered-'))).toHaveLength(1);

  // Nothing was lost and nothing was repeated.
  expect(cernum('status', 'contested', '--synthetic')).toContain('4/4 attempts recorded');
});
