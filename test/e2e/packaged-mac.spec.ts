// E2E · smoke test of the PACKAGED macOS application bundle (skipped when no bundle has been built).
// Launches "Model Lab.app" exactly as Finder would (no user-data override), so this also verifies the
// real data location under ~/Library/Application Support/Model Lab and the bundle's Info.plist.

import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
const candidates = [process.env.MODEL_LAB_APP, path.join(root, 'dist/mac-arm64/Model Lab.app'), path.join(root, 'dist/mac/Model Lab.app')].filter((p): p is string => !!p);
const appBundle = candidates.find((p) => fs.existsSync(p));

test.skip(process.platform !== 'darwin' || !appBundle, 'macOS bundle smoke test needs a built Model Lab.app');

test('Model Lab.app launches from its bundle, names itself, and stores data under Application Support', async () => {
  const bundle = appBundle!;
  const plist = (key: string) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(bundle, 'Contents/Info.plist')]).toString().trim();
  expect(plist('CFBundleName')).toBe('Model Lab');
  expect(plist('CFBundleDisplayName')).toBe('Model Lab');
  expect(plist('CFBundleIdentifier')).toBe('org.modellab.desktop');
  expect(plist('CFBundleShortVersionString')).toMatch(/^\d+\.\d+\.\d+$/);
  expect(fs.existsSync(path.join(bundle, 'Contents/Resources', plist('CFBundleIconFile').replace(/\.icns$/, '') + '.icns'))).toBe(true);
  expect(fs.existsSync(path.join(bundle, 'Contents/Resources/README.md'))).toBe(true);
  expect(fs.existsSync(path.join(bundle, 'Contents/Resources/app.asar'))).toBe(true);

  const app = await electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Model Lab'), args: [] });
  const page = await app.firstWindow();
  await page.waitForSelector('.shell.mac');
  const facts = await app.evaluate(({ app: a }) => ({ name: a.getName(), userData: a.getPath('userData'), packaged: a.isPackaged, version: a.getVersion() }));
  expect(facts.name).toBe('Model Lab');
  expect(facts.packaged).toBe(true);
  expect(facts.userData).toBe(path.join(os.homedir(), 'Library/Application Support/Model Lab'));
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('.kv').first()).toContainText('Processor');
  await expect(page.locator('.pill', { hasText: /Running|Installed, not running|Not installed|Endpoint problem/ }).first()).toBeVisible({ timeout: 30_000 });
  // The real store initialised in the real location (this is exactly what a first Finder launch does).
  expect(fs.existsSync(path.join(facts.userData, 'evidence/store-manifest.json'))).toBe(true);
  await page.click('[data-nav="settings"]');
  await expect(page.getByText('Benchmark catalog')).toBeVisible();
  await expect(page.locator('.kv', { hasText: 'Application data' })).toContainText('Library/Application Support/Model Lab');
  await app.close();
});
