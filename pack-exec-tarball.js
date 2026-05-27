// pack-exec-tarball.js
//
// Wrap one or more input files inside a single .tar.gz with explicit Unix
// mode bits on each entry. Built for the case where the host has no notion
// of an executable bit (Windows) but the produced artifact will be extracted
// on a host that needs it (Linux, macOS).
//
// Why this exists:
//   The `tar` npm package (v6) reads mode from `fs.statSync`, which on
//   Windows always reports 0o666 for regular files — NTFS just doesn't
//   carry the Unix exec bit. The package's `mode` option masks but never
//   forces a higher mode, and the `filter` callback's stat-mutation
//   doesn't survive the path that actually writes the header. So we
//   build the ustar header by hand for each entry, then gzip the whole
//   stream. POSIX ustar is well-documented and tiny.
//
// Usage:
//   node pack-exec-tarball.js --out dist/AXE-linux.tar.gz \
//        --entry "src=dist/AXE.AppImage,name=AXE.AppImage,mode=0755"
//
//   Multiple --entry flags allowed. `mode` is octal, defaults to 0644.
//   `name` is the path inside the tarball, defaults to basename of src.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_SIZE = 512;

/**
 * Build one 512-byte ustar header for a regular file.
 *
 *   name        100  - filename (truncated at 100 — fine for our use case)
 *   mode          8  - octal, null-terminated, e.g. "000755 \0"
 *   uid           8  - "000000 \0" (root-ish; doesn't matter on extract)
 *   gid           8  - "000000 \0"
 *   size         12  - octal byte count, null-terminated
 *   mtime        12  - octal epoch seconds, null-terminated
 *   chksum        8  - octal sum of all header bytes, null+space-terminated
 *                       (filled with spaces during sum, then overwritten)
 *   typeflag      1  - "0" = regular file
 *   linkname    100  - all zeros for regular files
 *   magic         6  - "ustar\0"
 *   version       2  - "00"
 *   uname        32  - "" (extract-side falls back to current user)
 *   gname        32  - ""
 *   devmajor      8  - "000000 \0"
 *   devminor      8  - "000000 \0"
 *   prefix      155  - extended-name prefix (unused)
 *   padding      12  - zero-fill to 512
 */
function buildHeader({ name, mode, size, mtime }) {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`Filename too long for ustar (max 100 bytes): ${name}`);
  }
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // Helper: write octal string of `len` bytes total. POSIX format is
  // "<digits><space><null>" for most fields, "<digits><null>" for size/mtime.
  // ustar actually accepts either form for size; we use the trailing-NUL form.
  function writeOctal(value, offset, len, trailing = ' \0') {
    const str = value.toString(8).padStart(len - trailing.length, '0') + trailing;
    header.write(str, offset, len, 'ascii');
  }

  header.write(name, 0, 100, 'utf8');
  writeOctal(mode & 0o7777, 100, 8);
  writeOctal(0, 108, 8); // uid
  writeOctal(0, 116, 8); // gid
  writeOctal(size, 124, 12, '\0');
  writeOctal(mtime, 136, 12, ' ');
  // chksum: fill with spaces for computation
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii'); // typeflag = regular file
  // linkname (157..256) stays zero
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // uname (265..296), gname (297..328) stay empty
  writeOctal(0, 329, 8); // devmajor
  writeOctal(0, 337, 8); // devminor
  // prefix (345..499) stays empty

  // Compute checksum: unsigned sum of all 512 header bytes, with chksum
  // field treated as spaces (which we already wrote). Format: 6 octal
  // digits + NUL + space.
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += header[i];
  const sumStr = sum.toString(8).padStart(6, '0') + '\0 ';
  header.write(sumStr, 148, 8, 'ascii');

  return header;
}

function padToBlock(stream, length) {
  const remainder = length % BLOCK_SIZE;
  if (remainder === 0) return;
  const pad = Buffer.alloc(BLOCK_SIZE - remainder, 0);
  stream.write(pad);
}

function parseArgs(argv) {
  const args = { entries: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      args.out = argv[++i];
    } else if (a === '--entry') {
      // src=...,name=...,mode=0755
      const parts = argv[++i].split(',');
      const entry = { mode: 0o644 };
      for (const p of parts) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        const k = p.slice(0, eq);
        const v = p.slice(eq + 1);
        if (k === 'src') entry.src = v;
        else if (k === 'name') entry.name = v;
        else if (k === 'mode') entry.mode = parseInt(v, 8);
      }
      if (!entry.src) throw new Error('--entry needs src=...');
      if (!entry.name) entry.name = path.basename(entry.src);
      args.entries.push(entry);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.out) throw new Error('--out required');
  if (args.entries.length === 0) throw new Error('at least one --entry required');
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve sources and stat them up front so we can fail before opening
  // the output (avoids leaving a half-written tarball on errors).
  const resolved = args.entries.map((e) => {
    const abs = path.resolve(e.src);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${e.src}`);
    return { ...e, abs, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
  });

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  const outStream = fs.createWriteStream(args.out);
  const gzip = zlib.createGzip({ level: 9 });
  gzip.pipe(outStream);

  return new Promise((resolve, reject) => {
    outStream.on('error', reject);
    outStream.on('close', () => resolve(args.out));

    (async () => {
      try {
        for (const e of resolved) {
          const header = buildHeader({
            name: e.name,
            mode: e.mode,
            size: e.size,
            mtime: e.mtime,
          });
          gzip.write(header);
          // Pipe file content into gzip without buffering whole thing in memory.
          await new Promise((res, rej) => {
            const rs = fs.createReadStream(e.abs);
            rs.on('error', rej);
            rs.on('end', res);
            rs.on('data', (chunk) => gzip.write(chunk));
          });
          padToBlock(gzip, e.size);
          process.stdout.write(`  packed ${e.name} (${e.size} bytes, mode ${(e.mode).toString(8)})\n`);
        }
        // Two zero blocks signal end-of-archive in POSIX tar.
        gzip.write(Buffer.alloc(BLOCK_SIZE * 2, 0));
        gzip.end();
      } catch (err) {
        reject(err);
      }
    })();
  });
}

main()
  .then((out) => {
    const finalSize = fs.statSync(out).size;
    console.log(`Wrote ${out} (${finalSize} bytes)`);
  })
  .catch((err) => {
    console.error('pack-exec-tarball failed:', err.message);
    process.exit(1);
  });
