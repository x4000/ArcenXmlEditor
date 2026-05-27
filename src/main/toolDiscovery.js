// Tool discovery for external executables (svn.exe, TortoiseProc.exe,
// git.exe, TortoiseGitProc.exe, etc.).
//
// Search order for each tool:
//   1. PATH via `where.exe <name>` (Windows) / `which` (other).
//   2. Registry: HKLM\SOFTWARE\TortoiseSVN ProcPath, HKLM\SOFTWARE\TortoiseGit
//      ProcPath. (Both Tortoise installers leave the same key shape.)
//   3. %ProgramFiles%\TortoiseSVN\bin\, %ProgramFiles(x86)%\TortoiseSVN\bin\
//      and the same for TortoiseGit. For standalone Git for Windows we also
//      probe %ProgramFiles%\Git\cmd\git.exe.
//   4. Same subpaths on every local fixed drive other than C:.
//
// Drive filtering uses `wmic logicaldisk` (falling back to PowerShell
// Get-CimInstance on newer Windows where wmic is absent). We keep only
// DriveType = 3 (local fixed). Removable (2), network (4), optical (5),
// and RAM (6) drives are skipped.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Module-level caches. Populated on first call, reused thereafter.
let _driveCache = null;
let _driveCacheTime = 0;
const DRIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min; drives don't change often

// Executable-path cache for the four top-level "find" entry points. These
// paths don't change at runtime (installing / uninstalling TortoiseGit
// mid-session isn't a supported scenario). Each find* call used to do
// several spawnSync calls (where.exe, reg, fs probes) on every
// detectAll — which fires every 30 s — adding up to hundreds of ms of
// main-process blocking per tick. Cache once, reuse forever. Explicit
// invalidation is available via clearCaches() for the re-detect menu
// command.
//
// Null is a legitimate cached value ("tool not installed"). We use a
// separate "has entry" map so we can distinguish "never looked" from
// "looked and didn't find anything."
const _exeCache = new Map(); // key → resolved path (may be null)

function isWindows() {
  return process.platform === 'win32';
}

/**
 * Enumerate local fixed drives (Windows only). Returns an array of drive root
 * paths like ["C:\\", "D:\\"]. On non-Windows returns empty. Cached for 5 min.
 */
function getLocalFixedDrives() {
  if (!isWindows()) return [];
  if (_driveCache && (Date.now() - _driveCacheTime) < DRIVE_CACHE_TTL_MS) {
    return _driveCache;
  }

  let drives = [];

  // Primary: wmic
  try {
    const r = spawnSync('wmic', ['logicaldisk', 'get', 'DeviceID,DriveType', '/format:csv'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
      const lines = r.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        // CSV format: Node,DeviceID,DriveType
        const parts = line.split(',');
        if (parts.length < 3) continue;
        const deviceId = parts[1];
        const driveType = parseInt(parts[2], 10);
        if (!deviceId || !/^[A-Za-z]:$/.test(deviceId)) continue;
        if (driveType === 3) drives.push(deviceId + '\\');
      }
    }
  } catch (e) { /* wmic missing; try PS */ }

  // Fallback: PowerShell Get-CimInstance
  if (drives.length === 0) {
    try {
      const r = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive',
        '-Command', "Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID"
      ], {
        encoding: 'utf-8',
        timeout: 8000,
        windowsHide: true,
      });
      if (r.status === 0 && r.stdout) {
        for (const line of r.stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (/^[A-Za-z]:$/.test(t)) drives.push(t + '\\');
        }
      }
    } catch (e) { /* nothing — leave drives empty */ }
  }

  // Sanity fallback: at least probe C: (every Windows box has one)
  if (drives.length === 0) drives = ['C:\\'];

  _driveCache = drives;
  _driveCacheTime = Date.now();
  return drives;
}

/**
 * Look up an executable on PATH. Returns an absolute path or null.
 */
function findOnPath(exeName) {
  if (!exeName) return null;
  try {
    if (isWindows()) {
      const r = spawnSync('where.exe', [exeName], { encoding: 'utf-8', timeout: 3000, windowsHide: true });
      if (r.status === 0 && r.stdout) {
        const first = r.stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean);
        if (first && fs.existsSync(first)) return first;
      }
    } else {
      const r = spawnSync('which', [exeName], { encoding: 'utf-8', timeout: 3000 });
      if (r.status === 0 && r.stdout) {
        const t = r.stdout.trim();
        if (t && fs.existsSync(t)) return t;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Read a Windows registry value via `reg query`. Returns the string value or null.
 * Not imported as a module dependency (keeping deps light), so we shell out.
 */
function readRegistry(keyPath, valueName) {
  if (!isWindows()) return null;
  try {
    const args = ['query', keyPath];
    if (valueName != null) args.push('/v', valueName);
    const r = spawnSync('reg', args, { encoding: 'utf-8', timeout: 3000, windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    // Expected line form: "    ValueName    REG_SZ    C:\\Path\\To\\Thing"
    const lines = r.stdout.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*\S+\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+(.+?)\s*$/i);
      if (m) return m[1];
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Return the best-known TortoiseSVN install directory, or null. This is the
 * directory that contains `bin\TortoiseProc.exe` and `bin\svn.exe`.
 */
function findTortoiseSvnInstallDir() {
  // 1. Registry ProcPath gives us the full path to TortoiseProc.exe — the install
  //    dir is two levels up (…\TortoiseSVN\bin\TortoiseProc.exe).
  const procPath = readRegistry('HKLM\\SOFTWARE\\TortoiseSVN', 'ProcPath');
  if (procPath && fs.existsSync(procPath)) {
    // install dir = dirname(dirname(procPath))
    return path.dirname(path.dirname(procPath));
  }

  // 2. %ProgramFiles% / %ProgramFiles(x86)%
  const envPaths = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
  ].filter(Boolean).map(p => path.join(p, 'TortoiseSVN'));

  for (const p of envPaths) {
    if (fs.existsSync(path.join(p, 'bin', 'TortoiseProc.exe'))) return p;
  }

  // 3. Scan other local fixed drives. We try both "Program Files" and
  //    "Program Files (x86)" on each.
  const drives = getLocalFixedDrives();
  for (const drive of drives) {
    if (drive.toUpperCase() === 'C:\\') continue; // already covered by env vars
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      const candidate = path.join(drive, pf, 'TortoiseSVN');
      if (fs.existsSync(path.join(candidate, 'bin', 'TortoiseProc.exe'))) return candidate;
    }
  }

  return null;
}

/**
 * Locate svn.exe. Preference: PATH, then registry-located TSVN bin, then the
 * TSVN install dir we find via the usual scan.
 */
function findSvnExe() {
  if (_exeCache.has('svn')) return _exeCache.get('svn');
  const onPath = findOnPath(isWindows() ? 'svn.exe' : 'svn');
  if (onPath) { _exeCache.set('svn', onPath); return onPath; }

  const tsvnDir = findTortoiseSvnInstallDir();
  if (tsvnDir) {
    const candidate = path.join(tsvnDir, 'bin', isWindows() ? 'svn.exe' : 'svn');
    if (fs.existsSync(candidate)) { _exeCache.set('svn', candidate); return candidate; }
  }
  _exeCache.set('svn', null);
  return null;
}

/**
 * Locate TortoiseProc.exe. Windows-only (there is no TortoiseSVN on
 * macOS/Linux). Returns null on non-Windows or if not installed.
 */
function findTortoiseProcExe() {
  if (_exeCache.has('tortoiseProc')) return _exeCache.get('tortoiseProc');
  if (!isWindows()) { _exeCache.set('tortoiseProc', null); return null; }

  const procPath = readRegistry('HKLM\\SOFTWARE\\TortoiseSVN', 'ProcPath');
  if (procPath && fs.existsSync(procPath)) { _exeCache.set('tortoiseProc', procPath); return procPath; }

  const tsvnDir = findTortoiseSvnInstallDir();
  if (tsvnDir) {
    const candidate = path.join(tsvnDir, 'bin', 'TortoiseProc.exe');
    if (fs.existsSync(candidate)) { _exeCache.set('tortoiseProc', candidate); return candidate; }
  }
  _exeCache.set('tortoiseProc', null);
  return null;
}

/**
 * Whether `TSVNCache.exe` is running. Cheap tasklist probe.
 * Kept small and Windows-only; callers on other platforms should not call this.
 */
function isTsvnCacheRunning() {
  if (!isWindows()) return false;
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq TSVNCache.exe', '/NH'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return false;
    return /TSVNCache\.exe/i.test(r.stdout);
  } catch (e) {
    return false;
  }
}

// ─── TortoiseGit / Git ───────────────────────────────────────────────

/**
 * Best-known TortoiseGit install directory (the dir containing `bin\TortoiseGitProc.exe`),
 * or null. TortoiseGit's installer mirrors TortoiseSVN's: HKLM\SOFTWARE\TortoiseGit
 * has a `ProcPath` value pointing at the full path to TortoiseGitProc.exe, and a
 * `Directory` value with the install dir.
 */
function findTortoiseGitInstallDir() {
  // 1. Registry ProcPath → install dir is two levels up
  //    (…\TortoiseGit\bin\TortoiseGitProc.exe).
  const procPath = readRegistry('HKLM\\SOFTWARE\\TortoiseGit', 'ProcPath');
  if (procPath && fs.existsSync(procPath)) {
    return path.dirname(path.dirname(procPath));
  }

  // 1b. Registry Directory value (set by some installers as a sibling of ProcPath).
  const directReg = readRegistry('HKLM\\SOFTWARE\\TortoiseGit', 'Directory');
  if (directReg && fs.existsSync(path.join(directReg, 'bin', 'TortoiseGitProc.exe'))) {
    return directReg;
  }

  // 2. %ProgramFiles% / %ProgramFiles(x86)%
  const envPaths = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
  ].filter(Boolean).map(p => path.join(p, 'TortoiseGit'));
  for (const p of envPaths) {
    if (fs.existsSync(path.join(p, 'bin', 'TortoiseGitProc.exe'))) return p;
  }

  // 3. Scan other local fixed drives.
  const drives = getLocalFixedDrives();
  for (const drive of drives) {
    if (drive.toUpperCase() === 'C:\\') continue;
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      const candidate = path.join(drive, pf, 'TortoiseGit');
      if (fs.existsSync(path.join(candidate, 'bin', 'TortoiseGitProc.exe'))) return candidate;
    }
  }

  return null;
}

/**
 * Locate git.exe. Preference: PATH (Git for Windows usually drops itself
 * there), then TortoiseGit's bundled bin dir, then standalone Git for
 * Windows install paths.
 */
function findGitExe() {
  if (_exeCache.has('git')) return _exeCache.get('git');
  const cache = (v) => { _exeCache.set('git', v); return v; };

  const onPath = findOnPath(isWindows() ? 'git.exe' : 'git');
  if (onPath) return cache(onPath);

  // TortoiseGit bundles git.exe under bin\.
  const tgitDir = findTortoiseGitInstallDir();
  if (tgitDir) {
    const candidate = path.join(tgitDir, 'bin', isWindows() ? 'git.exe' : 'git');
    if (fs.existsSync(candidate)) return cache(candidate);
  }

  // Standalone Git for Windows install layouts (cmd\git.exe is the wrapper
  // shim; bin\git.exe also exists in some installs).
  const envBases = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
  ].filter(Boolean);
  for (const base of envBases) {
    for (const sub of [['Git', 'cmd', 'git.exe'], ['Git', 'bin', 'git.exe']]) {
      const candidate = path.join(base, ...sub);
      if (fs.existsSync(candidate)) return cache(candidate);
    }
  }
  // Drive scan for standalone Git too.
  if (isWindows()) {
    for (const drive of getLocalFixedDrives()) {
      if (drive.toUpperCase() === 'C:\\') continue;
      for (const pf of ['Program Files', 'Program Files (x86)']) {
        for (const sub of [['Git', 'cmd', 'git.exe'], ['Git', 'bin', 'git.exe']]) {
          const candidate = path.join(drive, pf, ...sub);
          if (fs.existsSync(candidate)) return cache(candidate);
        }
      }
    }
  }

  return cache(null);
}

/**
 * Locate TortoiseGitProc.exe. Windows-only; returns null on non-Windows
 * or if not installed.
 */
function findTortoiseGitProcExe() {
  if (_exeCache.has('tortoiseGitProc')) return _exeCache.get('tortoiseGitProc');
  const cache = (v) => { _exeCache.set('tortoiseGitProc', v); return v; };
  if (!isWindows()) return cache(null);

  const procPath = readRegistry('HKLM\\SOFTWARE\\TortoiseGit', 'ProcPath');
  if (procPath && fs.existsSync(procPath)) return cache(procPath);

  const tgitDir = findTortoiseGitInstallDir();
  if (tgitDir) {
    const candidate = path.join(tgitDir, 'bin', 'TortoiseGitProc.exe');
    if (fs.existsSync(candidate)) return cache(candidate);
  }
  return cache(null);
}

/**
 * Whether `TGitCache.exe` is running. Cheap tasklist probe; mirrors
 * isTsvnCacheRunning.
 */
function isTGitCacheRunning() {
  if (!isWindows()) return false;
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq TGitCache.exe', '/NH'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return false;
    return /TGitCache\.exe/i.test(r.stdout);
  } catch (e) {
    return false;
  }
}

function clearCaches() {
  _driveCache = null;
  _driveCacheTime = 0;
  _exeCache.clear();
}

module.exports = {
  isWindows,
  getLocalFixedDrives,
  findOnPath,
  readRegistry,
  findTortoiseSvnInstallDir,
  findSvnExe,
  findTortoiseProcExe,
  isTsvnCacheRunning,
  findTortoiseGitInstallDir,
  findGitExe,
  findTortoiseGitProcExe,
  isTGitCacheRunning,
  clearCaches,
};
