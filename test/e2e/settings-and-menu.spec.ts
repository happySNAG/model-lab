// E2E · settings persist across a relaunch and refuse a non-loopback endpoint; the application menu
// navigates; the window and user-data paths are what a desktop app promises.

import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
let userData: string;

const launch = () => electron.launch({ args: [path.join(root, 'out/main/index.js')], env: { ...process.env, MODEL_LAB_USER_DATA: userData } });

test.beforeAll(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-e2e-settings-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ollamaEndpoint: 'http://127.0.0.1:1', thinkingMode: 'disabled', evidenceRootOverride: '' }));
});

test('window, name, user-data location, and the application menu', async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForSelector('.shell');
  expect(await page.title()).toBe('Model Lab');
  const facts = await app.evaluate(({ app: a, Menu }) => ({
    name: a.getName(), userData: a.getPath('userData'), menu: Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [],
  }));
  expect(facts.name).toBe('Model Lab');
  expect(facts.userData).toBe(userData);
  expect(facts.menu).toContain('File');
  expect(facts.menu).toContain('View');
  expect(facts.menu).toContain('Ollama');
  if (process.platform === 'darwin') {
    expect(facts.menu[0]).toBe('Model Lab');
    await expect(page.locator('.shell.mac')).toBeVisible();
  }
  // Menu-driven navigation (View → History) reaches the renderer.
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!;
    view.submenu!.items.find((i) => i.label === 'History')!.click();
  });
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu()!.items.find((i) => i.label === 'File')!.submenu!.items.find((i) => i.label === 'New Benchmark…')!.click(); });
  await expect(page.getByRole('heading', { name: 'Benchmark', exact: true })).toBeVisible();
  // Log file exists at the advertised path.
  expect(fs.existsSync(path.join(userData, 'model-lab.log'))).toBe(true);
  await app.close();
});

test('settings persist across a relaunch and a non-loopback endpoint is refused', async () => {
  const first = await launch();
  const page = await first.firstWindow();
  await page.waitForSelector('.shell');
  await page.click('[data-nav="settings"]');
  await expect(page.locator('#endpoint')).toHaveValue('http://127.0.0.1:1');
  await page.locator('[data-testid="thinking-mode"]').selectOption('enabled');
  await page.fill('#endpoint', 'http://192.168.1.20:11434');
  await page.click('[data-testid="save-settings"]');
  await expect(page.getByRole('status')).toContainText('not loopback');
  await page.fill('#endpoint', 'http://localhost:11434/');
  await page.click('[data-testid="save-settings"]');
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await expect(page.locator('#endpoint')).toHaveValue('http://localhost:11434');
  await first.close();

  const persisted = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  expect(persisted).toEqual({ ollamaEndpoint: 'http://localhost:11434', thinkingMode: 'enabled', evidenceRootOverride: '' });

  const second = await launch();
  const page2 = await second.firstWindow();
  await page2.waitForSelector('.shell');
  await page2.click('[data-nav="settings"]');
  await expect(page2.locator('[data-testid="thinking-mode"]')).toHaveValue('enabled');
  await expect(page2.locator('#endpoint')).toHaveValue('http://localhost:11434');
  await page2.click('[data-nav="benchmark"]');
  await expect(page2.locator('.kv')).toContainText('Enabled; only final answers are judged');
  await second.close();
});
