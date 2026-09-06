// electron-builder afterPack hook. macOS only: when no signing identity is configured, ad-hoc sign the
// whole bundle (identity "-") so that (a) Apple Silicon executes it, (b) the bundle carries its own
// identifier rather than Electron's, and (c) `codesign --verify` passes. This is NOT Developer ID
// signing and does NOT notarize; Gatekeeper still warns about a downloaded copy (see README.md).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') return; // a real identity is in play; leave signing to electron-builder
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${appPath} (unsigned build: no Developer ID, not notarized)`);
};
