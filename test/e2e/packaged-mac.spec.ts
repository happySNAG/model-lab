// E2E · smoke test of the PACKAGED macOS application bundle (skipped when no bundle has been built).
// Launches "Model Lab.app" exactly as Finder would (no user-data override), so this also verifies the
// real data location under ~/Library/Application Support/Model Lab and the bundle's Info.plist.

import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
// This host's architecture first: an arm64 bundle on an Intel Mac (or the reverse) cannot be
// executed at all, so preferring a fixed order would test whichever build happened to be present
// rather than the one this machine can run. electron-builder writes x64 to `dist/mac` and arm64 to
// `dist/mac-arm64`.
const forThisArchitecture = process.arch === 'arm64'
  ? ['dist/mac-arm64/Model Lab.app', 'dist/mac/Model Lab.app']
  : ['dist/mac/Model Lab.app', 'dist/mac-arm64/Model Lab.app'];
const candidates = [process.env.MODEL_LAB_APP, ...forThisArchitecture.map((relative) => path.join(root, relative))]
  .filter((p): p is string => !!p);
const appBundle = candidates.find((p) => fs.existsSync(p) && runsHere(p));

/** True when this machine can actually execute the bundle's binary. */
function runsHere(bundle: string): boolean {
  try {
    const described = execFileSync('file', ['-b', path.join(bundle, 'Contents/MacOS/Model Lab')], { encoding: 'utf8' });
    return described.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64');
  } catch {
    return false;
  }
}

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

  // The terminal interface travels with the application. This is the whole claim: an installed
  // bundle, with no checkout, no Node installation and no node_modules anywhere near it, answers
  // `cernum`. It is run here from a directory that is not the repository.
  const launcher = path.join(bundle, 'Contents/Resources/cernum');
  expect(fs.existsSync(launcher)).toBe(true);
  expect(fs.statSync(launcher).mode & 0o111).toBeGreaterThan(0);
  const help = execFileSync(launcher, ['help'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 120_000 });
  expect(help).toContain('benchmark engine · cernum');
  expect(help).toContain('install-command');
  const suites = execFileSync(launcher, ['suites'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 120_000 });
  expect(suites).toMatch(/suite\(s\), \d+ case\(s\)/);
  // And it computes the same campaign directory the application will report below.
  const where = execFileSync(launcher, ['where'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 120_000 });
  expect(where).toContain(path.join(os.homedir(), 'Library/Application Support/Model Lab/campaigns'));

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
