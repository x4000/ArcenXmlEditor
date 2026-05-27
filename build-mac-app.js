// build-mac-app.js
//
// Drive @electron/packager to assemble a macOS .app bundle from a
// Windows host. We use this instead of `electron-builder --mac` because
// electron-builder 25.x rejects mac builds from non-mac hosts ("Build
// for macOS is supported only on macOS"). @electron/packager has no
// such restriction — it's been cross-building macOS apps from Windows
// for years.
//
// The output `.app` is intentionally UNSIGNED. End users will need to
// bypass Gatekeeper on first launch (right-click → Open, or
// `xattr -dr com.apple.quarantine`). That's an Apple requirement;
// signing requires a macOS host with Xcode + Apple Developer cert.
//
// Output:  dist/ArcenXmlEd-darwin-x64/ArcenXmlEd.app
// (Subsequent build-mac.bat step tar.gz's this with proper modes.)
//
// CLI:
//   node build-mac-app.js [--arch x64|arm64]
//
// Defaults to x64 since that's still the broadest macOS install base.
// arm64 produces an Apple Silicon native build (smaller and faster on
// M1+ machines). We don't build universal (both) by default because
// the resulting bundle is ~2x the size and the Rosetta path on M1
// Macs runs the x64 build acceptably.

const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

function parseArgs(argv) {
  const args = { arch: 'x64' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arch') args.arch = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['x64', 'arm64'].includes(args.arch)) {
    throw new Error(`--arch must be x64 or arm64 (got: ${args.arch})`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = require('./package.json');

  // Ignore patterns: @electron/packager copies the entire source dir
  // by default. We need to keep that copy lean — without this the
  // .app would balloon to several GB with dev deps + the user's data
  // dirs + dist artifacts from previous builds. Patterns are
  // anchored regexes (matched against paths starting with "/").
  //
  // We intentionally KEEP node_modules/ because the app depends on
  // runtime libraries (chokidar, nspell, etc.). Packager auto-excludes
  // the electron / electron-builder / electron-packager deps from
  // the copy, so we don't have to enumerate those.
  const ignore = [
    // Build outputs from previous runs — never want to nest a .app
    // inside the next .app's resources.
    /^\/dist($|\/)/,
    // VCS and IDE noise
    /^\/\.git($|\/)/,
    /^\/\.claude($|\/)/,
    /^\/\.vscode($|\/)/,
    /^\/\.idea($|\/)/,
    // Sample data folders the dev keeps adjacent for testing
    /^\/HotMConfig($|\/)/,
    /^\/ArcenXmlEdContents($|\/)/,
    // Windows-specific build artifacts
    /^\/.*\.bat$/,
    /^\/.*\.lnk$/,
    /^\/build-mac-app\.js$/,
    /^\/pack-app-bundle\.js$/,
    /^\/pack-exec-tarball\.js$/,
    // Docs and design files — useful for developers, not needed at
    // runtime. design.md alone is over 100 KB.
    /^\/.*\.(md|MD|markdown)$/,
    /^\/Design($|\/)/,
    // Editor config that ends up in user's data dir at runtime, not
    // something we want shipped in the app's resources.
    /^\/_editor_config\.json$/,
    // Dev-only deps we don't want in the shipped node_modules. The
    // packager already strips electron / electron-builder / packager
    // itself, but a few others are large and not used at runtime.
    /^\/node_modules\/esbuild($|\/)/,
    /^\/node_modules\/@esbuild($|\/)/,
    /^\/node_modules\/cross-env($|\/)/,
  ];

  const opts = {
    dir: __dirname,
    name: 'ArcenXmlEd',
    platform: 'darwin',
    arch: args.arch,
    out: path.join(__dirname, 'dist'),
    overwrite: true,
    electronVersion: pkg.devDependencies.electron.replace(/^[\^~]/, ''),
    appBundleId: pkg.build && pkg.build.appId ? pkg.build.appId : 'com.arcen.xmleditor',
    appVersion: pkg.version,
    appCategoryType: 'public.app-category.developer-tools',
    ignore,
    // No --icon: we don't have an .icns file; packager will use the
    // default Electron icon. Add an .icns to icons/ and set
    // `icon: path.join(__dirname, 'icons/icon.icns')` here to override.
  };

  console.log('Packaging .app with @electron/packager:');
  console.log(`  name:       ${opts.name}`);
  console.log(`  platform:   ${opts.platform}-${opts.arch}`);
  console.log(`  electron:   ${opts.electronVersion}`);
  console.log(`  bundleId:   ${opts.appBundleId}`);
  console.log(`  out:        ${opts.out}`);
  console.log('');

  const appPaths = await packager(opts);
  // packager returns an array of output directories (one per arch).
  // For a single-arch build that's a single entry; print it so the
  // .bat caller can locate the .app for its pack-app-bundle.js step.
  for (const p of appPaths) {
    const apps = fs.readdirSync(p).filter((f) => f.endsWith('.app'));
    for (const a of apps) {
      console.log(`Built: ${path.join(p, a)}`);
    }
  }
}

main().catch((err) => {
  console.error('build-mac-app failed:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
