// electron-builder afterPack hook.
//
// With the default configuration (mac.identity: null) the app is not signed with a Developer ID.
// Renaming Electron.app and adding resources leaves its original linker signature inconsistent,
// which makes macOS report a downloaded copy as "damaged". An ad-hoc signature (no identity, no
// Apple account) keeps the bundle consistent so that the usual first-launch procedure works
// (right click › Open, or System Settings › Privacy & Security › Open Anyway).
//
// When a real identity is configured (-c.mac.identity="Developer ID Application: …"), this hook
// does nothing and electron-builder signs (and notarises) the app itself.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (context.packager.platformSpecificBuildOptions.identity !== null) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signature applied  app=${path.basename(appPath)}`);
};
