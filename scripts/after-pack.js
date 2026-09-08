// electron-builder afterPack hook. Two jobs, in this order:
//
// 1. Write the terminal launcher into the packaged application's resources directory, so the
//    supported terminal interface travels with the installed application and needs no checkout, no
//    Node installation and no `npm install`. It runs the bundled `out/main/cernum.js` — the same
//    build inside the same asar that the main process loads — through the bundled Electron binary
//    with ELECTRON_RUN_AS_NODE=1, which makes it a plain Node runtime. The executable's name is
//    read from the packager rather than typed here, so a product rename carries the launcher with
//    it without this file being edited.
//
// 2. macOS only: when no signing identity is configured, ad-hoc sign the whole bundle (identity
//    "-") so that (a) Apple Silicon executes it, (b) the bundle carries its own identifier rather
//    than Electron's, and (c) `codesign --verify` passes. This is NOT Developer ID signing and does
//    NOT notarize; Gatekeeper still warns about a downloaded copy (see README.md).
//
// The launcher is written BEFORE signing. Adding a file to a signed bundle would break its seal.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** The POSIX launcher. Resolves its own directory so the bundle can be moved or renamed. */
function posixLauncher(executableRelativePath) {
  return [
    '#!/bin/sh',
    '# The terminal interface, inside the application bundle.',
    '#',
    '# It runs the SAME engine build the application runs, out of the same asar, through the',
    "# application's own Electron binary in Node mode. There is nothing separate to install and no",
    '# development environment involved.',
    'here=$(cd -- "$(dirname -- "$0")" && pwd)',
    `binary="$here/${executableRelativePath}"`,
    'script="$here/app.asar/out/main/cernum.js"',
    'if [ ! -x "$binary" ]; then',
    '  echo "cernum: this application bundle is incomplete: no executable at $binary" >&2',
    '  exit 127',
    'fi',
    'ELECTRON_RUN_AS_NODE=1 exec "$binary" "$script" "$@"',
    '',
  ].join('\n');
}

/**
 * The Windows launcher.
 *
 * `start "" /b /wait` is deliberate: the Electron executable is a GUI-subsystem binary, so cmd.exe
 * does not wait for it and the shell prompt would return before the campaign printed anything.
 * `/b` keeps it in this console so its output and exit code are the ones the person sees.
 */
function windowsLauncher(executableRelativePath) {
  return [
    '@echo off',
    'rem The terminal interface, inside the application directory. It runs the same engine build',
    "rem the application runs, through the application's own Electron binary in Node mode.",
    'setlocal',
    'set "HERE=%~dp0"',
    `set "BINARY=%HERE%${executableRelativePath}"`,
    'set "SCRIPT=%HERE%app.asar\\out\\main\\cernum.js"',
    'if not exist "%BINARY%" (',
    '  echo cernum: this application is incomplete: no executable at "%BINARY%" 1>&2',
    '  exit /b 127',
    ')',
    'set "ELECTRON_RUN_AS_NODE=1"',
    'start "" /b /wait "%BINARY%" "%SCRIPT%" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** Where the resources directory and the executable are, per platform. */
function layout(context) {
  const product = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'darwin') {
    const app = path.join(context.appOutDir, `${product}.app`);
    return { appPath: app, resources: path.join(app, 'Contents', 'Resources'), executableRelative: `../MacOS/${product}` };
  }
  if (context.electronPlatformName === 'win32') {
    return { appPath: context.appOutDir, resources: path.join(context.appOutDir, 'resources'), executableRelative: `..\\${product}.exe` };
  }
  return { appPath: context.appOutDir, resources: path.join(context.appOutDir, 'resources'), executableRelative: `../${context.packager.executableName ?? product}` };
}

// Exported so the packaging shape can be tested without running a packager.
exports.posixLauncher = posixLauncher;
exports.windowsLauncher = windowsLauncher;
exports.layout = layout;

exports.default = async function afterPack(context) {
  const { appPath, resources, executableRelative } = layout(context);
  const windows = context.electronPlatformName === 'win32';
  const launcherPath = path.join(resources, windows ? 'cernum.cmd' : 'cernum');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(launcherPath, windows ? windowsLauncher(executableRelative) : posixLauncher(executableRelative),
                   { encoding: 'utf8', mode: windows ? 0o644 : 0o755 });
  if (!windows) fs.chmodSync(launcherPath, 0o755);
  console.log(`  • terminal launcher ${launcherPath} -> ${executableRelative} app.asar/out/main/cernum.js`);

  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') return; // a real identity is in play; leave signing to electron-builder
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appPath} (unsigned build: no Developer ID, not notarized)`);
};
