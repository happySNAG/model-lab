// The installed terminal command: what gets packaged, what gets installed, and what gets removed.
//
// The claim under test is narrow and worth being exact about. Installing this command writes ONE
// file into a directory the person already owns. It does not edit PATH, a shell profile, the
// registry, /usr/local, or anything requiring elevation, and it does not add a login item. The
// uninstall removes exactly the file the install wrote and refuses anything it did not write —
// which is why the file carries a marker rather than being identified by its name.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  LAUNCHER_MARKER, TerminalCommandError, installDirectory, installPath, installTerminalCommand,
  launcherScript, packagedLauncher, terminalCommandStatus, uninstallTerminalCommand,
} from '../../src/shared/terminal-install';
import { CAMPAIGN_DIRECTORY_NAME, PRODUCT, TERMINAL_COMMAND } from '../../src/shared/product';
import { defaultCampaignRoot } from '../../src/cli/cernum';

const afterPack = require('../../scripts/after-pack.js') as {
  posixLauncher: (executableRelativePath: string) => string;
  windowsLauncher: (executableRelativePath: string) => string;
  layout: (context: any) => { appPath: string; resources: string; executableRelative: string };
};

let sandbox: string;
let resources: string;
let installDir: string;
const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const originalInstallDir = process.env.CERNUM_TERMINAL_COMMAND_DIR;
const originalPath = process.env.PATH;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-command-'));
  resources = path.join(sandbox, 'Resources');
  installDir = path.join(sandbox, 'bin');
  fs.mkdirSync(resources, { recursive: true });
  // Stand in for the launcher electron-builder's afterPack writes into the bundle.
  fs.writeFileSync(path.join(resources, TERMINAL_COMMAND), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(path.join(resources, TERMINAL_COMMAND), 0o755);
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = resources;
  process.env.CERNUM_TERMINAL_COMMAND_DIR = installDir;
});

afterEach(() => {
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  if (originalInstallDir === undefined) delete process.env.CERNUM_TERMINAL_COMMAND_DIR;
  else process.env.CERNUM_TERMINAL_COMMAND_DIR = originalInstallDir;
  process.env.PATH = originalPath;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('what the packager puts in the bundle', () => {
  it('finds the launcher the application ships', () => {
    expect(packagedLauncher().path).toBe(path.join(resources, TERMINAL_COMMAND));
    expect(terminalCommandStatus().supported).toBe(true);
  });

  it('says plainly that a development checkout has none', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = path.join(sandbox, 'nothing-here');
    const status = terminalCommandStatus();
    expect(status.supported).toBe(false);
    expect(status.launcherReason).toMatch(/development checkout/);
    expect(status.message).toMatch(new RegExp(`npm run ${TERMINAL_COMMAND}`));
  });

  it('points the macOS launcher at the bundled binary and the bundled script', () => {
    const script = afterPack.posixLauncher('../MacOS/Cernum');
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain('"$here/../MacOS/Cernum"');
    // The pre-rename binary was `Model Lab`: a name with a space must still arrive quoted.
    expect(afterPack.posixLauncher('../MacOS/Cernum Preview')).toContain('"$here/../MacOS/Cernum Preview"');
    expect(script).toContain('app.asar/out/main/cernum.js');
    // The bundle can be moved or renamed: nothing absolute is baked in.
    expect(script).not.toMatch(/\/Applications\//);
    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it('points the Windows launcher at the bundled binary and waits for it', () => {
    const script = afterPack.windowsLauncher('..\\Cernum.exe');
    expect(script).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(script).toContain('%HERE%..\\Cernum.exe');
    expect(script).toContain('app.asar\\out\\main\\cernum.js');
    // A GUI-subsystem binary would otherwise return the prompt before printing anything.
    expect(script).toContain('start "" /b /wait');
    expect(script).toContain('exit /b %ERRORLEVEL%');
    expect(script.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
  });

  it('takes the executable name from the packager, so a product rename carries the launcher', () => {
    const darwin = afterPack.layout({ electronPlatformName: 'darwin', appOutDir: '/out', packager: { appInfo: { productFilename: 'Cernum' } } });
    expect(darwin.resources).toBe(path.join('/out', 'Cernum.app', 'Contents', 'Resources'));
    expect(darwin.executableRelative).toBe('../MacOS/Cernum');
    const win = afterPack.layout({ electronPlatformName: 'win32', appOutDir: '/out', packager: { appInfo: { productFilename: 'Cernum' } } });
    expect(win.resources).toBe(path.join('/out', 'resources'));
    expect(win.executableRelative).toBe('..\\Cernum.exe');
  });
});

describe('installing the command', () => {
  it('writes exactly one file, and nothing else anywhere', () => {
    const before = fs.existsSync(installDir) ? fs.readdirSync(installDir) : [];
    expect(before).toEqual([]);
    const status = installTerminalCommand();
    expect(status.installed).toBe(true);
    expect(status.installPath).toBe(path.join(installDir, TERMINAL_COMMAND));
    expect(fs.readdirSync(installDir)).toEqual([TERMINAL_COMMAND]);
  });

  it('makes it executable and points it at this application', () => {
    installTerminalCommand();
    const target = installPath();
    expect(fs.statSync(target).mode & 0o111).toBeGreaterThan(0);
    const contents = fs.readFileSync(target, 'utf8');
    expect(contents).toContain(LAUNCHER_MARKER);
    expect(contents).toContain(path.join(resources, TERMINAL_COMMAND));
    expect(terminalCommandStatus().installedPointsHere).toBe(true);
  });

  it('actually runs, and hands its arguments through', () => {
    // Replace the in-bundle launcher with one that echoes what it was given, so the installed file
    // is proved to be a working path to the application rather than merely a plausible one.
    fs.writeFileSync(path.join(resources, TERMINAL_COMMAND), '#!/bin/sh\necho "launcher saw: $*"\n', { mode: 0o755 });
    fs.chmodSync(path.join(resources, TERMINAL_COMMAND), 0o755);
    installTerminalCommand();
    const output = execFileSync(installPath(), ['status', '--root', '/tmp'], { encoding: 'utf8' });
    expect(output.trim()).toBe('launcher saw: status --root /tmp');
  });

  it('fails loudly, not silently, once the application is gone', () => {
    installTerminalCommand();
    fs.rmSync(resources, { recursive: true, force: true });
    let code = 0;
    let stderr = '';
    try { execFileSync(installPath(), [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) {
      code = (error as { status: number }).status;
      stderr = String((error as { stderr: string }).stderr);
    }
    expect(code).toBe(127);
    expect(stderr).toMatch(/no longer at/);
  });

  it('reports whether the directory is on PATH without touching PATH', () => {
    const pathBefore = process.env.PATH;
    let status = installTerminalCommand();
    expect(status.directoryOnPath).toBe(false);
    expect(status.pathHint).toContain(installDir);
    expect(status.pathHint).toMatch(/Nothing here edits a profile for you/);
    expect(process.env.PATH).toBe(pathBefore);

    process.env.PATH = `${installDir}:${pathBefore ?? ''}`;
    status = terminalCommandStatus();
    expect(status.directoryOnPath).toBe(true);
    expect(status.pathHint).toBe('');
  });

  it('refuses to overwrite a file it did not write', () => {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(installPath(), '#!/bin/sh\n# somebody else\n', 'utf8');
    expect(() => installTerminalCommand()).toThrow(TerminalCommandError);
    expect(fs.readFileSync(installPath(), 'utf8')).toContain('somebody else');
  });

  it('refuses to install from a checkout, where there is nothing packaged to install', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = path.join(sandbox, 'nothing-here');
    expect(() => installTerminalCommand()).toThrow(/nothing to install from/);
  });

  it('is idempotent: installing twice leaves one file', () => {
    installTerminalCommand();
    installTerminalCommand();
    expect(fs.readdirSync(installDir)).toEqual([TERMINAL_COMMAND]);
  });
});

describe('removing the command', () => {
  it('removes exactly the file the install wrote', () => {
    installTerminalCommand();
    const status = uninstallTerminalCommand();
    expect(status.installed).toBe(false);
    expect(fs.readdirSync(installDir)).toEqual([]);
    expect(status.message).toMatch(/no PATH, profile or system directory was touched/);
  });

  it('refuses to remove a file it did not write', () => {
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(installPath(), '#!/bin/sh\n# somebody else\n', 'utf8');
    expect(() => uninstallTerminalCommand()).toThrow(/does not carry the/);
    expect(fs.existsSync(installPath())).toBe(true);
  });

  it('says so plainly when there is nothing to remove', () => {
    expect(uninstallTerminalCommand().message).toMatch(/Nothing to remove/);
  });

  it('leaves the application\'s own launcher alone', () => {
    installTerminalCommand();
    uninstallTerminalCommand();
    expect(fs.existsSync(path.join(resources, TERMINAL_COMMAND))).toBe(true);
  });
});

describe('the command and the application share one campaign store', () => {
  it('computes the directory the desktop application reads', () => {
    delete process.env.CERNUM_CAMPAIGN_ROOT;
    delete process.env.MODEL_LAB_CAMPAIGN_ROOT;
    const expected = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', PRODUCT.name, CAMPAIGN_DIRECTORY_NAME)
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), PRODUCT.name, CAMPAIGN_DIRECTORY_NAME)
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), PRODUCT.slug, CAMPAIGN_DIRECTORY_NAME);
    // This is Electron's own `app.getPath('userData')` layout — `<Application Support>/<productName>`
    // on macOS — with the campaigns directory under it, which is what makes "a run started in the
    // terminal appears on the Campaigns screen" true without any message passing.
    expect(defaultCampaignRoot()).toBe(expected);
  });

  it('honours the same override the service honours', () => {
    process.env.CERNUM_CAMPAIGN_ROOT = path.join(sandbox, 'elsewhere');
    expect(defaultCampaignRoot()).toBe(path.join(sandbox, 'elsewhere'));
    delete process.env.CERNUM_CAMPAIGN_ROOT;
  });

  it('still honours the pre-rename override, so an old script keeps working', () => {
    delete process.env.CERNUM_CAMPAIGN_ROOT;
    process.env.MODEL_LAB_CAMPAIGN_ROOT = path.join(sandbox, 'legacy');
    expect(defaultCampaignRoot()).toBe(path.join(sandbox, 'legacy'));
    delete process.env.MODEL_LAB_CAMPAIGN_ROOT;
  });

  it('names the launcher for the platform it will run on', () => {
    expect(path.basename(installPath())).toBe(process.platform === 'win32' ? `${TERMINAL_COMMAND}.cmd` : TERMINAL_COMMAND);
    expect(installDirectory()).toBe(installDir);
  });

  it('writes a launcher script that carries the marker an uninstall looks for', () => {
    expect(launcherScript('/Volumes/My Apps/Cernum.app/Contents/Resources/cernum')).toContain(LAUNCHER_MARKER);
    expect(launcherScript("/quote'd/path/cernum")).toContain(`'/quote'\\''d/path/cernum'`);
  });
});

describe('the command behaves like a command', () => {
  it('exits quietly when its reader goes away, instead of raising a stack trace', () => {
    // `cernum suites | head -3` closes the pipe with output still queued. A terminal interface that
    // answers that with an unhandled 'error' event is broken in the most ordinary use there is.
    const output = execFileSync('/bin/sh', ['-c',
      `npx tsx ${path.resolve(__dirname, '../../src/cli/cernum.ts')} suites 2>&1 | head -3`],
      { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 180_000 });
    expect(output).not.toMatch(/EPIPE|Unhandled|node:events/);
    expect(output).toMatch(/suite\(s\), \d+ case\(s\)/);
  });
});
