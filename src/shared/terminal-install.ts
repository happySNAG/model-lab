// The installed terminal command: finding the one the application ships, and putting a launcher for
// it somewhere a shell will find it.
//
// WHY THIS EXISTS. Until now the supported terminal interface was `npm run cernum` — which needs the
// repository, a Node installation and `npm install`. That is a developer instruction wearing a
// user-facing command's clothes. A person who installed the application has everything required to
// run a campaign already: the same engine build, and an interpreter, both inside the application
// bundle. What was missing was a path to them.
//
// HOW IT RUNS WITHOUT NODE. The application ships Electron, and Electron with
// `ELECTRON_RUN_AS_NODE=1` is a Node runtime. The bundled `out/main/cernum.js` is the same build the
// desktop application's main process loads, from the same asar, importing the same
// `src/engine/index.ts`. There is no second engine and no second campaign store — that is a
// structural property of running one file out of one bundle, not a claim two code paths are kept in
// step.
//
// NOTHING PRIVILEGED, NOTHING SILENT. Installing writes exactly ONE file, into a directory the user
// already owns, and never edits a shell profile, a system PATH, a registry key or anything under
// /usr/local. If that directory is not on PATH this module says so and prints the exact line to add;
// deciding to add it stays the person's. Uninstalling removes exactly the file this module wrote,
// identified by a marker inside it, and refuses to delete anything it did not write.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PRODUCT, TERMINAL_COMMAND } from './product';

/** The line that identifies a launcher as ours. An uninstall that cannot find it removes nothing. */
export const LAUNCHER_MARKER = 'CERNUM-TERMINAL-COMMAND v1';

/** Directory override, for tests and for a person who wants the launcher somewhere else. */
export const INSTALL_DIRECTORY_ENVIRONMENT_KEY = 'CERNUM_TERMINAL_COMMAND_DIR';

export interface TerminalCommandStatus {
  command: string;
  /** True when a packaged launcher was found, i.e. this is an installed application rather than a checkout. */
  supported: boolean;
  /** The launcher inside the application bundle. */
  launcherPath?: string;
  /** Why no launcher was found, when none was. */
  launcherReason?: string;
  installDirectory: string;
  installPath: string;
  installed: boolean;
  /** True when the installed file carries this module's marker. Only such a file is ever removed. */
  installedIsOurs: boolean;
  /** True when the installed file points at THIS application bundle. */
  installedPointsHere: boolean;
  directoryOnPath: boolean;
  /** The exact line to add to a shell profile, when the directory is not on PATH. */
  pathHint: string;
  /** What just happened, or what stands in the way. Printable to a person as-is. */
  message: string;
}

export class TerminalCommandError extends Error {
  constructor(readonly code: 'notPackaged' | 'foreignFile' | 'writeFailed', message: string) {
    super(message);
    this.name = 'TerminalCommandError';
  }
}

const launcherFileName = process.platform === 'win32' ? `${TERMINAL_COMMAND}.cmd` : TERMINAL_COMMAND;

/**
 * The launcher the packager put inside the application bundle.
 *
 * Two ways of finding it, because this module is loaded both by the Electron main process and by the
 * bundled terminal command itself, and only one of them can rely on `process.resourcesPath`.
 */
export function packagedLauncher(): { path?: string; reason?: string } {
  const candidates: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resources === 'string' && resources.length > 0) candidates.push(path.join(resources, launcherFileName));
  // The bundled command lives at `<Resources>/app.asar/out/main/cernum.js`, so three levels up
  // from this module's directory is the resources directory, whether or not `resourcesPath` was set.
  if (typeof __dirname === 'string') candidates.push(path.resolve(__dirname, '..', '..', '..', launcherFileName));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate };
    } catch { /* an unreadable candidate is simply not the answer */ }
  }
  return {
    reason: candidates.length === 0
      ? 'this build exposes no application resources directory, so it is running from a checkout rather than an installed application'
      : `no packaged launcher at ${candidates.join(' or ')}; this is a development checkout, where the supported command is 'npm run ${TERMINAL_COMMAND} -- …'`,
  };
}

/**
 * Where the launcher goes. A directory the user owns on every platform:
 *   macOS / Linux   ~/.local/bin        the conventional user-owned bin directory
 *   Windows         %LOCALAPPDATA%\<product>\bin
 * Neither requires elevation, and neither is on a system search path.
 */
export function installDirectory(): string {
  const override = process.env[INSTALL_DIRECTORY_ENVIRONMENT_KEY];
  if (override) return override;
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, PRODUCT.name, 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export function installPath(): string {
  return path.join(installDirectory(), launcherFileName);
}

function directoryIsOnPath(directory: string): boolean {
  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = (process.env.PATH ?? '').split(separator).filter((entry) => entry.length > 0);
  const normalise = (value: string) => {
    const trimmed = path.resolve(value.replace(/^"(.*)"$/, '$1'));
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const wanted = normalise(directory);
  return entries.some((entry) => {
    try { return normalise(entry) === wanted; } catch { return false; }
  });
}

function pathHintFor(directory: string): string {
  if (process.platform === 'win32') {
    return `${directory} is not on PATH. Add it for your account with:\r\n`
      + `  setx PATH "%PATH%;${directory}"\r\n`
      + 'then open a new terminal. Nothing here changes PATH for you.';
  }
  return `${directory} is not on PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):\n`
    + `  export PATH="${directory}:$PATH"\n`
    + 'then open a new terminal. Nothing here edits a profile for you.';
}

/** The launcher's text. It carries the marker, and it fails loudly if the application has moved. */
export function launcherScript(applicationLauncher: string): string {
  if (process.platform === 'win32') {
    return [
      '@echo off',
      `rem ${LAUNCHER_MARKER} — installed by ${PRODUCT.name} ${PRODUCT.version}`,
      `rem Remove it exactly with:  ${TERMINAL_COMMAND} uninstall-command`,
      'setlocal',
      `set "LAUNCHER=${applicationLauncher}"`,
      'if not exist "%LAUNCHER%" (',
      `  echo ${TERMINAL_COMMAND}: the ${PRODUCT.name} application is no longer at "%LAUNCHER%". 1>&2`,
      `  echo ${TERMINAL_COMMAND}: reinstall the terminal command from the application, or delete this file. 1>&2`,
      '  exit /b 127',
      ')',
      'call "%LAUNCHER%" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# ${LAUNCHER_MARKER} — installed by ${PRODUCT.name} ${PRODUCT.version}`,
    `# Remove it exactly with:  ${TERMINAL_COMMAND} uninstall-command`,
    '#',
    '# This file does one thing: hand every argument to the launcher inside the application bundle,',
    '# which runs the engine the application itself runs. It is the only file the install wrote.',
    `LAUNCHER='${applicationLauncher.replace(/'/g, `'\\''`)}'`,
    'if [ ! -x "$LAUNCHER" ]; then',
    `  echo "${TERMINAL_COMMAND}: the ${PRODUCT.name} application is no longer at $LAUNCHER" >&2`,
    `  echo "${TERMINAL_COMMAND}: reinstall the terminal command from the application, or delete this file" >&2`,
    '  exit 127',
    'fi',
    'exec "$LAUNCHER" "$@"',
    '',
  ].join('\n');
}

function readInstalled(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

export function terminalCommandStatus(): TerminalCommandStatus {
  const launcher = packagedLauncher();
  const directory = installDirectory();
  const target = installPath();
  const contents = readInstalled(target);
  const installed = contents !== undefined;
  const installedIsOurs = installed && contents.includes(LAUNCHER_MARKER);
  const installedPointsHere = installedIsOurs && launcher.path !== undefined && contents.includes(launcher.path);
  const onPath = directoryIsOnPath(directory);
  let message: string;
  if (!launcher.path) message = launcher.reason ?? 'no packaged launcher was found';
  else if (!installed) message = `${TERMINAL_COMMAND} is not installed. Installing writes one file, ${target}, and changes nothing else.`;
  else if (!installedIsOurs) message = `${target} exists and was not written by ${PRODUCT.name}. It will not be replaced or removed.`;
  else if (!installedPointsHere) message = `${target} was installed by ${PRODUCT.name} but points at a different copy of the application. Install again to point it here.`;
  else if (!onPath) message = `${TERMINAL_COMMAND} is installed at ${target}, but that directory is not on PATH.`;
  else message = `${TERMINAL_COMMAND} is installed at ${target} and is on PATH.`;

  return {
    command: TERMINAL_COMMAND,
    supported: launcher.path !== undefined,
    launcherPath: launcher.path,
    launcherReason: launcher.reason,
    installDirectory: directory,
    installPath: target,
    installed,
    installedIsOurs,
    installedPointsHere,
    directoryOnPath: onPath,
    pathHint: onPath ? '' : pathHintFor(directory),
    message,
  };
}

/** Write the launcher. One file, one directory, no PATH change, no elevation. */
export function installTerminalCommand(): TerminalCommandStatus {
  const before = terminalCommandStatus();
  if (!before.supported || !before.launcherPath) {
    throw new TerminalCommandError('notPackaged',
      `${before.launcherReason ?? 'no packaged launcher was found'} — there is nothing to install from.`);
  }
  if (before.installed && !before.installedIsOurs) {
    throw new TerminalCommandError('foreignFile',
      `${before.installPath} already exists and was not written by ${PRODUCT.name}. It was left exactly as it is; `
      + 'move it aside yourself if you want this command there.');
  }
  try {
    fs.mkdirSync(before.installDirectory, { recursive: true });
    const temporary = `${before.installPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, launcherScript(before.launcherPath), 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, before.installPath);
  } catch (error) {
    throw new TerminalCommandError('writeFailed',
      `could not write ${before.installPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const after = terminalCommandStatus();
  return {
    ...after,
    message: after.directoryOnPath
      ? `Installed ${after.installPath}. Run '${TERMINAL_COMMAND} help' in any terminal.`
      : `Installed ${after.installPath}.\n${after.pathHint}\n`
        + `Until then, run it by its full path: ${after.installPath}`,
  };
}

/** Remove exactly the file this module wrote, and nothing else. */
export function uninstallTerminalCommand(): TerminalCommandStatus {
  const before = terminalCommandStatus();
  if (!before.installed) {
    return { ...before, message: `Nothing to remove: there is no file at ${before.installPath}.` };
  }
  if (!before.installedIsOurs) {
    throw new TerminalCommandError('foreignFile',
      `${before.installPath} does not carry the ${LAUNCHER_MARKER} marker, so it was not written by ${PRODUCT.name}. `
      + 'It has been left exactly as it is. Remove it yourself if you are sure.');
  }
  fs.unlinkSync(before.installPath);
  const after = terminalCommandStatus();
  return {
    ...after,
    message: `Removed ${before.installPath}. That was the only file the install created; no PATH, profile or system directory was touched.`,
  };
}
