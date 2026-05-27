// Thin wrapper around svn.exe for status queries.
//
// We call `svn status --xml --depth <depth> <path>` and parse the XML
// response into a Map<absPath, VcsStatus>. Parsing is hand-rolled regex —
// we depend on the schemaParser style of XML in the rest of the app, but
// here we're consuming svn's output which is machine-generated and small,
// so a full DOMParser is overkill in the main process.
//
// Status string mapping (svn → our VcsStatus enum):
//   normal       → clean
//   modified     → modified
//   added        → added
//   deleted      → deleted
//   replaced     → modified
//   conflicted   → conflicted
//   unversioned  → unversioned
//   missing      → missing
//   ignored      → ignored
//   obstructed   → conflicted
//   external     → clean  (svn:externals dir — content handled by its own WC)
//   incomplete   → modified
//   (any other)  → clean

const { spawn } = require('child_process');
const path = require('path');

const SVN_STATUS_MAP = {
  normal: 'clean',
  none: 'clean',
  unversioned: 'unversioned',
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  replaced: 'modified',
  conflicted: 'conflicted',
  missing: 'missing',
  ignored: 'ignored',
  obstructed: 'conflicted',
  external: 'clean',
  incomplete: 'modified',
};

const STATUS_SEVERITY = {
  clean: 0,
  ignored: 0,
  unversioned: 1,
  missing: 2,
  added: 3,
  deleted: 3,
  modified: 4,
  conflicted: 5,
};

function mapStatus(svnStatus) {
  return SVN_STATUS_MAP[svnStatus] || 'clean';
}

function severity(status) {
  return STATUS_SEVERITY[status] || 0;
}

function worstOf(a, b) {
  return severity(a) >= severity(b) ? a : b;
}

/**
 * Run svn with the given args. Resolves with { stdout, stderr, code }; never
 * rejects. Times out at 30s (large trees with slow disks).
 */
function runSvn(svnExe, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code });
    };

    let proc;
    try {
      proc = spawn(svnExe, args, {
        windowsHide: true,
        cwd: opts.cwd,
      });
    } catch (e) {
      return finish(-1);
    }

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) { /* ignore */ }
      finish(-2);
    }, opts.timeoutMs || 30000);

    proc.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
    proc.on('close', (code) => { clearTimeout(timer); finish(code); });
    proc.on('error', () => { clearTimeout(timer); finish(-1); });
  });
}

/**
 * Parse `svn status --xml` output. Returns { entries: Array<{path, status}>,
 * hasChanges }. `hasChanges` is true if any entry is not clean/ignored.
 */
function parseStatusXml(xml) {
  const entries = [];
  if (!xml) return { entries, hasChanges: false };

  // Match each <entry path="..."> ... <wc-status item="..." ...> block.
  const entryRe = /<entry\b[^>]*\bpath\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/entry>/g;
  const wcRe = /<wc-status\b[^>]*\bitem\s*=\s*"([^"]+)"/;
  let m;
  while ((m = entryRe.exec(xml))) {
    const p = m[1];
    const inner = m[2];
    const wm = wcRe.exec(inner);
    const svnStatus = wm ? wm[1] : 'normal';
    const status = mapStatus(svnStatus);
    entries.push({ path: p, status });
  }

  const hasChanges = entries.some(e => severity(e.status) > 0);
  return { entries, hasChanges };
}

/**
 * Recursively status a path. Returns a Map<absPath, VcsStatus> (only entries
 * that are not-clean are included), plus an aggregate `rollup` status for
 * the scope as a whole.
 */
async function getStatusRecursive(svnExe, scopePath) {
  if (!svnExe || !scopePath) return { map: new Map(), rollup: 'clean' };
  // --depth=infinity is the default for svn status on a dir, but set it
  // explicitly for clarity. --xml for machine output. --quiet to suppress
  // clean entries from the output (smaller parse).
  //
  // NOTE: --quiet hides unmodified files but still shows unversioned,
  // missing, modified, added, deleted, conflicted. That's exactly what we
  // want: we only care about non-clean files.
  const { stdout, code } = await runSvn(svnExe, ['status', '--xml', '--depth', 'infinity', scopePath], {
    timeoutMs: 45000,
  });
  if (code !== 0) return { map: new Map(), rollup: 'clean' };

  const { entries } = parseStatusXml(stdout);
  const map = new Map();
  let rollup = 'clean';
  for (const e of entries) {
    const abs = path.isAbsolute(e.path) ? e.path : path.resolve(scopePath, e.path);
    map.set(abs, e.status);
    rollup = worstOf(rollup, e.status);
  }
  return { map, rollup };
}

/**
 * Status a single file. Returns the VcsStatus for that file ('clean' if
 * unmodified / not reported by svn).
 */
async function getStatusFile(svnExe, filePath) {
  if (!svnExe || !filePath) return 'clean';
  const { stdout, code } = await runSvn(svnExe, ['status', '--xml', '--depth', 'empty', filePath], {
    timeoutMs: 10000,
  });
  if (code !== 0) return 'clean';
  const { entries } = parseStatusXml(stdout);
  if (!entries.length) return 'clean';
  // If the exact path is reported, use its status; else worst.
  const normTarget = path.resolve(filePath).toLowerCase();
  for (const e of entries) {
    const norm = path.resolve(e.path).toLowerCase();
    if (norm === normTarget) return e.status;
  }
  let worst = 'clean';
  for (const e of entries) worst = worstOf(worst, e.status);
  return worst;
}

/**
 * Fetch the BASE (working-copy base revision) content for a file. Returns
 * the file as SVN sees it before any local modifications, or null if SVN
 * rejects the path — unversioned/added files, files outside the WC, etc.
 */
async function getBaseContent(svnExe, absPath) {
  if (!svnExe || !absPath) return null;
  const { stdout, code } = await runSvn(
    svnExe,
    ['cat', '-r', 'BASE', absPath],
    { timeoutMs: 15000 }
  );
  if (code !== 0) return null;
  return stdout;
}

module.exports = {
  runSvn,
  parseStatusXml,
  getStatusRecursive,
  getStatusFile,
  getBaseContent,
  mapStatus,
  severity,
  worstOf,
};
