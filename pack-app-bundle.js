// pack-app-bundle.js
//
// Walk a directory tree (a macOS .app bundle, OR a Linux unpacked
// Electron directory) and produce a .tar.gz with explicit Unix
// permissions on every entry. Built so the resulting archive launches
// cleanly on Linux/macOS even though it was produced on a Windows host.
//
// Why we can't just `tar -czf` the directory:
//   NTFS has no Unix executable bit. When `tar` (or any tarball writer)
//   reads file stats on Windows, executables come back as 0o666. The
//   Linux Electron launcher and the macOS launcher both MUST be 0o755
//   or the OS refuses to run them ("damaged and cannot be opened" on
//   macOS, "Permission denied" on Linux). Same for .so / .dylib / .node
//   files, chrome-sandbox, and helper-process launchers. Without
//   forcing those modes ourselves, the cross-built bundle is DOA.
//
// Mode policy (in priority order, first match wins):
//   - directories                                                 0o755
//   - symlinks                                                    0o777 (target governs)
//   - file content starts with ELF magic   (\x7fELF)              0o755
//   - file content starts with Mach-O magic (any variant)         0o755
//   - file content starts with `#!`        (shebang)              0o755
//   - any path ending in .so / .dylib / .node                     0o755
//   - any path containing /Contents/MacOS/ at any depth           0o755
//   - everything else (resources, plists, .icns, JS, etc.)        0o644
//
// The content-sniffing means we don't need separate Linux vs macOS
// helpers — the same script tarballs both correctly. Path heuristics
// remain as a fallback because reading content of every file is the
// slow path; we only fall back to it when the content sniff fails
// (it shouldn't, but the path rules are a safety net).
//
// Usage:
//   node pack-app-bundle.js --out dist\ArcenXmlEd-mac.tar.gz \
//                           --root dist\mac\ArcenXmlEd.app
//   node pack-app-bundle.js --out dist\ArcenXmlEd-linux.tar.gz \
//                           --root dist\linux-unpacked \
//                           --top-name ArcenXmlEd-linux
//
// The root's basename becomes the top-level directory in the tarball
// unless overridden by --top-name. For mac, you want it to stay as
// `ArcenXmlEd.app` so the .app bundle drops in cleanly; for linux
// you usually want a friendlier name than `linux-unpacked`.
//
// --app is accepted as a synonym for --root (legacy from the
// mac-only iteration of this script).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_SIZE = 512;

// ── Magic-byte detection ─────────────────────────────────────────────
//
// Open the file, read up to 4 bytes from the start, see if they identify
// an executable format. Falls back to false on read errors so the caller
// can apply path-based heuristics. We pass the descriptor in so we can
// reuse it when we stream the file content later — opening twice would
// double the syscall cost on a tree of thousands of entries.
function looksExecutableByMagic(absPath) {
  let fd = -1;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    if (n < 2) return false;
    // ELF: 7f 45 4c 46  ("\x7fELF") — Linux / BSD native binaries.
    if (n >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // Mach-O is recorded with the host endianness, so x86_64 / arm64
    // Macs see it byte-swapped from the "documented" big-endian magic.
    // Both forms occur in real Electron bundles (the framework's main
    // dylib is little-endian on every modern Mac), and missing either
    // means the framework loads as data and the app fails to launch.
    //   feedface / feedfacf            big-endian   (32 / 64 bit)
    //   cefaedfe / cffaedfe            little-endian (32 / 64 bit, swapped)
    //   cafebabe / bebafeca            fat/universal (big / little swapped)
    // (cafebabe also matches Java .class files, but no .class file
    // belongs at +x inside an Electron bundle.)
    if (n >= 4) {
      if (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa
          && (buf[3] === 0xce || buf[3] === 0xcf)) return true;
      if (buf[3] === 0xfe && buf[2] === 0xed && buf[1] === 0xfa
          && (buf[0] === 0xce || buf[0] === 0xcf)) return true;
      if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) return true;
      if (buf[0] === 0xbe && buf[1] === 0xba && buf[2] === 0xfe && buf[3] === 0xca) return true;
    }
    // Shebang: scripts that the OS launches via the named interpreter.
    // electron-builder sometimes drops chrome-sandbox shims and similar.
    if (buf[0] === 0x23 && buf[1] === 0x21) return true;
    return false;
  } catch (_) {
    return false;
  } finally {
    if (fd >= 0) try { fs.closeSync(fd); } catch (_) {}
  }
}

// ── Mode classification ──────────────────────────────────────────────
//
// Decide what Unix mode to record for a tar entry based on a content
// sniff plus path heuristics as a fallback. The content sniff catches
// the cases that matter most (ELF launchers on Linux, Mach-O launchers
// on macOS), and the path heuristics cover edge cases where reading
// content might mis-classify (e.g. a small JS that happens to start
// with `#!/usr/bin/env node` is meant to be executable).
function modeForEntry(archivePath, absPath, isDir) {
  if (isDir) return 0o755;
  if (looksExecutableByMagic(absPath)) return 0o755;
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.so') || lower.endsWith('.dylib') || lower.endsWith('.node')) {
    return 0o755;
  }
  // Anything under "Contents/MacOS/" — where macOS launchers live,
  // both for the top-level .app and nested helper apps in Frameworks.
  // Match on path segment boundaries so a literal directory named
  // "MacOS" elsewhere wouldn't accidentally trigger.
  const segs = archivePath.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === 'Contents' && segs[i + 1] === 'MacOS') return 0o755;
  }
  return 0o644;
}

// ── POSIX ustar header writer ────────────────────────────────────────
//
// 512-byte header per entry. See pack-exec-tarball.js for the field
// layout reference — this is the same format with a couple extras:
//   - typeflag '5' for directories (size = 0, no content payload)
//   - trailing slash on directory names is conventional but not required
function buildHeader({ name, mode, size, mtime, typeflag = '0' }) {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    // ustar supports 155-byte prefix + 100-byte name via the prefix
    // field, giving 255 bytes total. Electron .app paths can blow past
    // 100 (Contents/Frameworks/Electron Framework.framework/Versions/A/
    // Libraries/libGLESv2.dylib is already 92, deeper nesting common).
    // We split on the last '/' that fits.
    if (Buffer.byteLength(name, 'utf8') > 255) {
      throw new Error(`Path too long even with prefix split: ${name}`);
    }
    // Find a split point so name <= 100 and prefix <= 155, splitting on '/'.
    let split = -1;
    for (let i = Math.min(name.length - 1, 155); i > 0; i--) {
      if (name[i] !== '/') continue;
      const prefix = name.slice(0, i);
      const tail = name.slice(i + 1);
      if (Buffer.byteLength(prefix, 'utf8') <= 155
          && Buffer.byteLength(tail, 'utf8') <= 100) {
        split = i;
        break;
      }
    }
    if (split < 0) throw new Error(`Cannot split path for ustar prefix: ${name}`);
    return buildHeaderRaw({
      name: name.slice(split + 1),
      prefix: name.slice(0, split),
      mode, size, mtime, typeflag,
    });
  }
  return buildHeaderRaw({ name, prefix: '', mode, size, mtime, typeflag });
}

function buildHeaderRaw({ name, prefix, mode, size, mtime, typeflag }) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  function writeOctal(value, offset, len, trailing = ' \0') {
    const str = value.toString(8).padStart(len - trailing.length, '0') + trailing;
    header.write(str, offset, len, 'ascii');
  }

  header.write(name, 0, 100, 'utf8');
  writeOctal(mode & 0o7777, 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(size, 124, 12, '\0');
  writeOctal(mtime, 136, 12, ' ');
  header.write('        ', 148, 8, 'ascii'); // chksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(0, 329, 8);
  writeOctal(0, 337, 8);
  if (prefix) header.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  return header;
}

function padToBlock(stream, length) {
  const remainder = length % BLOCK_SIZE;
  if (remainder === 0) return;
  stream.write(Buffer.alloc(BLOCK_SIZE - remainder, 0));
}

// ── Directory walk ───────────────────────────────────────────────────
//
// Yield every file and directory under `root`, with the path expressed
// relative to `root`'s parent (so the tarball preserves `topName` as
// its top-level dir — defaults to root's basename).
function* walk(root, topName) {
  function* recurse(abs, rel) {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    // Sort for reproducible output — same input always produces
    // byte-identical tarball, which simplifies caching / integrity checks.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        // Electron bundles contain symlinks inside .framework dirs
        // (Versions/Current → Versions/A, etc.). We must preserve those
        // as actual links, not duplicate the target — otherwise the .app
        // doubles in size and macOS may reject mismatched copies.
        const target = fs.readlinkSync(childAbs);
        yield { kind: 'symlink', archivePath: `${topName}/${childRel}`, target };
      } else if (e.isDirectory()) {
        yield { kind: 'dir', archivePath: `${topName}/${childRel}/` };
        yield* recurse(childAbs, childRel);
      } else if (e.isFile()) {
        const stat = fs.statSync(childAbs);
        yield {
          kind: 'file',
          archivePath: `${topName}/${childRel}`,
          abs: childAbs,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs / 1000),
        };
      }
      // Other types (sockets, devices) shouldn't appear here — skip.
    }
  }
  yield { kind: 'dir', archivePath: `${topName}/` };
  yield* recurse(root, '');
}

function buildSymlinkHeader({ name, target, mtime }) {
  // typeflag '2' = symlink, size = 0, target in linkname[157..256]
  const header = buildHeader({
    name,
    mode: 0o777,
    size: 0,
    mtime,
    typeflag: '2',
  });
  if (Buffer.byteLength(target, 'utf8') > 100) {
    // The PAX header workaround for long symlink targets is involved;
    // for our use case all electron symlinks are short ("A", "Current",
    // relative paths under 30 chars). Fail loudly if we hit one.
    throw new Error(`Symlink target too long for ustar: ${target}`);
  }
  header.write(target, 157, 100, 'utf8');
  // Recompute chksum since we overwrote bytes after the original sum.
  header.write('        ', 148, 8, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    // --app is the legacy name from when this only handled mac; --root
    // is the current general-purpose name. Accept both interchangeably.
    else if (a === '--root' || a === '--app') args.root = argv[++i];
    else if (a === '--top-name') args.topName = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.out) throw new Error('--out required');
  if (!args.root) throw new Error('--root (or --app) required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPath = path.resolve(args.root);
  const outPath = path.resolve(args.out);
  const topName = args.topName || path.basename(rootPath);

  if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
    throw new Error(`Not a directory: ${args.root}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outStream = fs.createWriteStream(outPath);
  const gzip = zlib.createGzip({ level: 9 });
  gzip.pipe(outStream);

  let counts = { files: 0, dirs: 0, symlinks: 0, execs: 0 };

  for (const entry of walk(rootPath, topName)) {
    if (entry.kind === 'dir') {
      gzip.write(buildHeader({
        name: entry.archivePath,
        mode: 0o755,
        size: 0,
        mtime: Math.floor(Date.now() / 1000),
        typeflag: '5',
      }));
      counts.dirs++;
    } else if (entry.kind === 'symlink') {
      gzip.write(buildSymlinkHeader({
        name: entry.archivePath,
        target: entry.target,
        mtime: Math.floor(Date.now() / 1000),
      }));
      counts.symlinks++;
    } else {
      const mode = modeForEntry(entry.archivePath, entry.abs, false);
      if ((mode & 0o111) !== 0) counts.execs++;
      gzip.write(buildHeader({
        name: entry.archivePath,
        mode,
        size: entry.size,
        mtime: entry.mtime,
      }));
      // Stream the file content through gzip without loading it all.
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(entry.abs);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.on('data', (chunk) => gzip.write(chunk));
      });
      padToBlock(gzip, entry.size);
      counts.files++;
    }
  }

  // Two zero blocks signal end-of-archive in POSIX tar.
  gzip.write(Buffer.alloc(BLOCK_SIZE * 2, 0));
  gzip.end();

  await new Promise((resolve, reject) => {
    outStream.on('error', reject);
    outStream.on('close', resolve);
  });

  const finalSize = fs.statSync(outPath).size;
  console.log(
    `Packed ${counts.files} files (${counts.execs} executable), `
    + `${counts.dirs} directories, ${counts.symlinks} symlinks.`
  );
  console.log(`Wrote ${outPath} (${(finalSize / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error('pack-app-bundle failed:', err.message);
  process.exit(1);
});
