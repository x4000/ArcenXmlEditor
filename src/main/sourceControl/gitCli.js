// Thin wrapper around git.exe for status queries.
//
// Mirrors svnCli.js shape so gitProvider.js can stay structurally
// identical to svnProvider.js. Status comes from `git status --porcelain=v1
// -z`, which is the documented stable machine-readable format. We use `-z`
// (NUL-separated, no quoting) so paths with spaces / unicode survive
// without parsing surprises.
//
// Status code mapping (porcelain v1 XY → our VcsStatus enum):
//   "??"               → unversioned
//   "!!"               → ignored   (only emitted with --ignored; we omit)
//   "UU"/"AA"/"DD"
//     /"UA"/"UD"/"AU"
//     /"DU"            → conflicted
//   X or Y == "D"      → deleted   (subject to conflict check above)
//   X == "A"           → added
//   X == "R" or "C"    → modified  (rename/copy — close enough)
//   anything non-space → modified
//   "  "               → clean
//
// Severity ordering matches svnCli so worstOf/rollups are interchangeable.

const { spawn } = require('child_process');
const path = require('path');

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

function severity(status) {
  return STATUS_SEVERITY[status] || 0;
}

function worstOf(a, b) {
  return severity(a) >= severity(b) ? a : b;
}

const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'UA', 'UD', 'AU', 'DU']);

/**
 * Map a single XY two-char porcelain code to a VcsStatus. Special cases
 * (??, !!) are handled by the caller before this is reached.
 */
function mapXY(xy) {
  if (!xy || xy.length < 2) return 'clean';
  if (CONFLICT_CODES.has(xy)) return 'conflicted';
  const x = xy[0];
  const y = xy[1];
  if (x === ' ' && y === ' ') return 'clean';
  // Pure deletions (no other change in the index/worktree)
  if ((x === 'D' && y === ' ') || (x === ' ' && y === 'D')) return 'deleted';
  // Pure addition staged in index
  if (x === 'A' && (y === ' ' || y === 'M')) return 'added';
  // Renames and copies — treat as modified (we don't surface rename info)
  if (x === 'R' || x === 'C') return 'modified';
  // Anything else with a non-space code is a modification of some flavor.
  return 'modified';
}

/**
 * Run git with the given args. Resolves with { stdout, stderr, code }; never
 * rejects. Times out at 30 s by default. opts.cwd defaults to undefined —
 * callers that need repo-root invocation should pass `-C <repoRoot>` in args
 * or set `cwd`.
 */
function runGit(gitExe, args, opts = {}) {
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
      proc = spawn(gitExe, args, {
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
 * Parse `git status --porcelain=v1 -z` output into entries. With `-z`, each
 * record is NUL-terminated; rename/copy records are followed by an extra
 * NUL-terminated original-path field that we discard.
 *
 * Each record has the form: "XY <path>" where XY is the two-char status
 * code and a single space separates it from the path.
 */
function parseStatusPorcelain(stdout) {
  const entries = [];
  if (!stdout) return { entries, hasChanges: false };

  // -z emits NUL terminators between records. The trailing record is also
  // NUL-terminated, leaving an empty last segment we filter out.
  const records = stdout.split('\0').filter((r) => r.length > 0);

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length < 3) continue;
    const xy = rec.substring(0, 2);
    // Format: "XY path" — third char is the separator space.
    const p = rec.substring(3);

    // For rename/copy records, the next record is the original-path source.
    // Skip it by advancing the index. (If `-z` weren't passed, git would
    // emit "newpath -> oldpath" inline; with -z they're split.)
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++; // discard source path
    }

    let status;
    if (xy === '??') status = 'unversioned';
    else if (xy === '!!') status = 'ignored';
    else status = mapXY(xy);

    entries.push({ path: p, status });
  }

  const hasChanges = entries.some((e) => severity(e.status) > 0);
  return { entries, hasChanges };
}

/**
 * Recursively status a path. Returns a Map<absPath, VcsStatus> (only
 * non-clean entries) plus a `rollup` worst status for the scope.
 *
 * `repoRoot` is the working-copy root (where `.git` lives). Git only
 * reports relative-to-repo-root paths regardless of cwd, so we always
 * resolve them against repoRoot. When `scopePath` is a strict subdir of
 * repoRoot we post-filter to entries under that subdir — passing
 * scopePath as a pathspec works too but trips on unusual subdir names
 * containing glob characters. Filtering is unambiguous.
 */
// `scopePath` may be a single path or an array of paths. `git status` always
// runs once over the whole repo (it's fast); the result is then post-filtered
// to entries under any of the scope path(s). Passing the data-layer dirs as
// an array keeps the data-scope map narrowed without re-running git per dir.
async function getStatusRecursive(gitExe, scopePath, repoRoot) {
  if (!gitExe || !scopePath || !repoRoot) {
    return { map: new Map(), rollup: 'clean' };
  }
  const args = [
    '-C', repoRoot,
    'status', '--porcelain=v1', '-z',
    '--untracked-files=normal',
  ];
  const { stdout, code } = await runGit(gitExe, args, { timeoutMs: 45000 });
  if (code !== 0) return { map: new Map(), rollup: 'clean' };

  const { entries } = parseStatusPorcelain(stdout);
  const map = new Map();
  let rollup = 'clean';

  const repoAbs = path.resolve(repoRoot);
  const repoNorm = repoAbs.toLowerCase();
  // Build the list of scope prefixes. If any scope equals the repo root,
  // there's nothing to filter — the whole repo is in scope.
  const scopeList = Array.isArray(scopePath) ? scopePath : [scopePath];
  let filterToScope = true;
  const scopes = [];
  for (const sp of scopeList) {
    const norm = path.resolve(sp).toLowerCase();
    if (norm === repoNorm) { filterToScope = false; break; }
    scopes.push({ norm, prefix: norm.endsWith(path.sep) ? norm : norm + path.sep });
  }
  const inScope = (absNorm) => {
    if (!filterToScope) return true;
    for (const s of scopes) {
      if (absNorm === s.norm || absNorm.startsWith(s.prefix)) return true;
    }
    return false;
  };

  for (const e of entries) {
    if (e.status === 'ignored' || e.status === 'clean') continue;
    const abs = path.resolve(repoAbs, e.path);
    if (!inScope(abs.toLowerCase())) continue;
    map.set(abs, e.status);
    rollup = worstOf(rollup, e.status);
  }
  return { map, rollup };
}

/**
 * Status a single file. Returns the VcsStatus for that file ('clean' if
 * unmodified / not reported by git).
 */
async function getStatusFile(gitExe, filePath, repoRoot) {
  if (!gitExe || !filePath || !repoRoot) return 'clean';
  const fileAbs = path.resolve(filePath);
  // Pass the file as a pathspec so git only reports on it. The leading "--"
  // ensures it's parsed as a path rather than a flag.
  const args = [
    '-C', repoRoot,
    'status', '--porcelain=v1', '-z',
    '--untracked-files=normal',
    '--', fileAbs,
  ];
  const { stdout, code } = await runGit(gitExe, args, { timeoutMs: 10000 });
  if (code !== 0) return 'clean';
  const { entries } = parseStatusPorcelain(stdout);
  if (!entries.length) return 'clean';

  const repoAbs = path.resolve(repoRoot);
  const target = fileAbs.toLowerCase();
  for (const e of entries) {
    if (e.status === 'ignored' || e.status === 'clean') continue;
    const abs = path.resolve(repoAbs, e.path).toLowerCase();
    if (abs === target) return e.status;
  }
  // Fall back to worst non-clean entry (covers cases where git reports a
  // related path — e.g. a rename source — instead of the exact target).
  let worst = 'clean';
  for (const e of entries) {
    if (e.status === 'ignored' || e.status === 'clean') continue;
    worst = worstOf(worst, e.status);
  }
  return worst;
}

/**
 * Fetch the HEAD version of a tracked file. Returns the file's content as
 * it exists in HEAD (with whatever line endings the blob stores), or null
 * if git rejects the path — newly-added/untracked files, files outside the
 * repo, or any other error. Callers must handle the null case: it just
 * means "there is no base to diff against."
 */
async function getBaseContent(gitExe, repoRoot, absPath) {
  if (!gitExe || !repoRoot || !absPath) return null;
  let rel = path.relative(repoRoot, absPath);
  if (!rel || rel.startsWith('..')) return null;
  // git show uses forward slashes even on Windows.
  rel = rel.replace(/\\/g, '/');
  const { stdout, code } = await runGit(
    gitExe,
    ['-C', repoRoot, 'show', `HEAD:${rel}`],
    { timeoutMs: 15000 }
  );
  if (code !== 0) return null;
  return stdout;
}

module.exports = {
  runGit,
  parseStatusPorcelain,
  getStatusRecursive,
  getStatusFile,
  getBaseContent,
  severity,
  worstOf,
};
