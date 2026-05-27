// SVN implementation of the SourceControlProvider interface.
//
// Responsibilities:
//  - Detect TortoiseSVN + svn.exe + TSVNCache liveness (via toolDiscovery,
//    tsvnCache).
//  - Locate the working-copy root by walking up from DATA_ROOT.
//  - Maintain two cached status maps (repo scope + data scope) refreshed
//    on demand and via explicit triggers (file save, TortoiseProc exit).
//  - Expose runCommand() that dispatches to TortoiseProc dialogs.
//  - Expose getCommands(path) returning SVN-labelled menu entries.

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const toolDiscovery = require('../toolDiscovery');
const tsvnCache = require('./tsvnCache');
const svnCli = require('./svnCli');
const tortoiseProc = require('./tortoiseProc');

const STATUS_WORKER_PATH = path.join(__dirname, 'statusWorker.js');

/**
 * Run a recursive status query in a Node worker_thread. Keeps the main
 * process's event loop responsive even when the status XML is big and the
 * post-call regex parse would otherwise block for hundreds of ms.
 *
 * Never rejects; on any error returns an empty result.
 */
function runStatusInWorker(svnExe, scopePath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let worker;
    try {
      worker = new Worker(STATUS_WORKER_PATH, {
        workerData: { svnExe, scopePath },
      });
    } catch (e) {
      return finish({ map: new Map(), rollup: 'clean' });
    }
    worker.once('message', (msg) => {
      worker.terminate().catch(() => {});
      if (msg && msg.ok) {
        finish({ map: msg.map || new Map(), rollup: msg.rollup || 'clean' });
      } else {
        finish({ map: new Map(), rollup: 'clean' });
      }
    });
    worker.once('error', () => {
      worker.terminate().catch(() => {});
      finish({ map: new Map(), rollup: 'clean' });
    });
    worker.once('exit', () => finish({ map: new Map(), rollup: 'clean' }));
  });
}

const COMMAND_IDS = [
  'commit', 'update', 'revert', 'log', 'diff', 'blame',
  'resolveConflict', 'checkModifications',
];

class SvnProvider extends EventEmitter {
  constructor() {
    super();
    this.id = 'svn';
    this.displayName = 'TortoiseSVN';
    this.installTargetName = 'TortoiseSVN';

    this._svnExe = null;
    this._tortoiseProcExe = null;
    this._repoRoot = null;       // highest .svn ancestor of DATA_ROOT
    this._dataScopeRoot = null;  // === DATA_ROOT when connected (relativizing base)
    this._dataScopeDirs = [];    // dirs the data-scope scan actually covers
    this._cacheAlive = false;

    // Status caches. Keyed by absolute path. Only non-clean entries stored.
    this._dataStatus = new Map();
    this._repoStatus = new Map();
    this._dataRollup = 'clean';
    this._repoRollup = 'clean';

    this._refreshingData = false;
    this._refreshingRepo = false;
    this._pendingDataRefresh = false;
    this._pendingRepoRefresh = false;
  }

  /**
   * Drop any state tied to a specific repo/data root so a subsequent
   * detect() starts clean. Called by the manager when the DATA_ROOT
   * changes mid-session (e.g. user picks a different folder).
   */
  reset() {
    this._repoRoot = null;
    this._dataScopeRoot = null;
    this._dataScopeDirs = [];
    this._cacheAlive = false;
    this._dataStatus = new Map();
    this._repoStatus = new Map();
    this._dataRollup = 'clean';
    this._repoRollup = 'clean';
    this._refreshingData = false;
    this._refreshingRepo = false;
    this._pendingDataRefresh = false;
    this._pendingRepoRefresh = false;
  }

  // ─── Detection ─────────────────────────────────────────────────────

  /**
   * Run full detection. Resolves to a snapshot:
   *   {
   *     installed, connected, detail, warnings, repoRoot, dataScopeRoot,
   *     cacheAlive, statusBackendLive
   *   }
   *
   * `installed` — TortoiseProc.exe + svn.exe both located
   * `connected` — installed AND DATA_ROOT has a .svn ancestor
   * `cacheAlive` — TSVNCache.exe pipe is reachable
   * `statusBackendLive` — connected AND cacheAlive (drives pip/dot visibility)
   */
  async detect(dataRoot, dataScopeDirs) {
    this._tortoiseProcExe = toolDiscovery.findTortoiseProcExe();
    this._svnExe = toolDiscovery.findSvnExe();

    const installed = !!(this._tortoiseProcExe && this._svnExe);
    if (!installed) {
      this._repoRoot = null;
      this._dataScopeRoot = null;
      this._dataScopeDirs = [];
      this._cacheAlive = false;
      return this._snapshot(false, false, null, []);
    }

    const repoRoot = dataRoot ? findRepoRoot(dataRoot) : null;
    this._repoRoot = repoRoot;
    this._dataScopeRoot = repoRoot ? dataRoot : null;
    // The set of dirs the data-scope scan covers — narrowed to the data
    // layers in suite mode, falling back to [dataRoot] otherwise.
    this._dataScopeDirs = repoRoot
      ? ((dataScopeDirs && dataScopeDirs.length) ? dataScopeDirs.slice() : [dataRoot])
      : [];
    const connected = !!repoRoot;

    const cacheAlive = await tsvnCache.isCacheAlive();
    this._cacheAlive = cacheAlive;

    const warnings = [];
    if (connected && !cacheAlive) {
      warnings.push({
        kind: 'cacheDisabled',
        message: 'TSVNCache disabled — status indicators hidden. Re-enable in TortoiseSVN settings (Icon Overlays → Status Cache: Default).',
      });
    }

    const detail = connected ? repoRoot : (installed ? 'installed, no repo' : null);
    return this._snapshot(installed, connected, detail, warnings);
  }

  _snapshot(installed, connected, detail, warnings) {
    const statusBackendLive = connected && this._cacheAlive;
    return {
      id: this.id,
      displayName: this.displayName,
      installTargetName: this.installTargetName,
      installed,
      connected,
      detail,
      warnings,
      repoRoot: this._repoRoot,
      dataScopeRoot: this._dataScopeRoot,
      cacheAlive: this._cacheAlive,
      statusBackendLive,
    };
  }

  // ─── Status ────────────────────────────────────────────────────────

  /**
   * Refresh the data-scope status map. Scans each data-scope dir recursively
   * (one scoped `svn status` per dir — in suite mode that's the data layers,
   * not the whole install) and merges the results. Coalesces concurrent
   * calls. Emits 'statusChanged' when the new map lands.
   */
  async refreshDataStatus() {
    if (!this._dataScopeRoot || !this._cacheAlive) return;
    if (this._refreshingData) { this._pendingDataRefresh = true; return; }
    this._refreshingData = true;
    try {
      const merged = new Map();
      for (const dir of this._dataScopeDirs) {
        const { map } = await svnCli.getStatusRecursive(this._svnExe, dir);
        for (const [k, v] of map) merged.set(k, v);
      }
      this._dataStatus = merged;
      this._dataRollup = this._computeRollup(merged);
      this.emit('statusChanged', { scope: 'data' });
    } finally {
      this._refreshingData = false;
      if (this._pendingDataRefresh) {
        this._pendingDataRefresh = false;
        this.refreshDataStatus();
      }
    }
  }

  /**
   * Refresh the repo-scope status map (repoRoot recursive). On a large
   * working copy this can take 2–3 s (svn subprocess + XML parse), so the
   * whole operation runs in a worker_thread to keep the main event loop
   * responsive. Coalesces concurrent calls.
   */
  async refreshRepoStatus() {
    if (!this._repoRoot || !this._cacheAlive) return;
    if (this._refreshingRepo) { this._pendingRepoRefresh = true; return; }
    this._refreshingRepo = true;
    try {
      const { map, rollup } = await runStatusInWorker(this._svnExe, this._repoRoot);
      this._repoStatus = map;
      this._repoRollup = rollup;
      this.emit('statusChanged', { scope: 'repo' });
    } finally {
      this._refreshingRepo = false;
      if (this._pendingRepoRefresh) {
        this._pendingRepoRefresh = false;
        this.refreshRepoStatus();
      }
    }
  }

  /**
   * Refresh just a single file's status (fast; used after AXE saves a file).
   */
  async refreshFile(absPath) {
    if (!absPath || !this._cacheAlive || !this._svnExe) return;
    const status = await svnCli.getStatusFile(this._svnExe, absPath);
    const prevData = this._dataStatus.get(absPath);
    if (status === 'clean') {
      this._dataStatus.delete(absPath);
      this._repoStatus.delete(absPath);
    } else {
      this._dataStatus.set(absPath, status);
      this._repoStatus.set(absPath, status);
    }
    if (prevData !== status) {
      // Recompute rollups — expensive in the worst case but the map is
      // typically a handful of entries.
      this._dataRollup = this._computeRollup(this._dataStatus);
      this._repoRollup = this._computeRollup(this._repoStatus);
      this.emit('statusChanged', { scope: 'file', path: absPath });
    }
  }

  /**
   * Fetch the BASE (pre-local-modification) content for a file. Null if
   * SVN has no base for it.
   */
  async getBaseContent(absPath) {
    if (!absPath || !this._svnExe) return null;
    return svnCli.getBaseContent(this._svnExe, absPath);
  }

  _computeRollup(map) {
    let r = 'clean';
    for (const s of map.values()) r = svnCli.worstOf(r, s);
    return r;
  }

  /**
   * Public snapshot of the current status state for the renderer.
   *   scope: 'data' | 'repo' | 'file'
   *   path: absolute path (file scope only)
   */
  getStatusSnapshot(scope, absPath) {
    if (!this._cacheAlive) return null;
    if (scope === 'file') {
      const s = this._dataStatus.get(absPath) || this._repoStatus.get(absPath) || 'clean';
      return { status: s };
    }
    const map = scope === 'repo' ? this._repoStatus : this._dataStatus;
    const rollup = scope === 'repo' ? this._repoRollup : this._dataRollup;
    // Serialize as a plain object: { absPath: status, ... } — Maps don't
    // survive structured-clone well across IPC.
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    return { rollup, entries: obj };
  }

  /**
   * Rollup status for a folder (worst child status). Uses the cached
   * data-scope map.
   */
  getFolderRollup(absFolderPath) {
    if (!this._cacheAlive || !absFolderPath) return 'clean';
    const prefix = absFolderPath.endsWith(path.sep) ? absFolderPath : absFolderPath + path.sep;
    const prefixLower = prefix.toLowerCase();
    let worst = 'clean';
    for (const [p, s] of this._dataStatus) {
      if (p.toLowerCase().startsWith(prefixLower)) {
        worst = svnCli.worstOf(worst, s);
      }
    }
    return worst;
  }

  // ─── Commands ──────────────────────────────────────────────────────

  getCommands(scope, absPath) {
    if (!this._tortoiseProcExe) return [];
    const fileStatus = (scope === 'file' && absPath)
      ? (this._dataStatus.get(absPath) || this._repoStatus.get(absPath) || 'clean')
      : null;
    const isModified = fileStatus === 'modified' || fileStatus === 'added' || fileStatus === 'deleted';
    const isConflicted = fileStatus === 'conflicted';

    return [
      { id: 'commit',             label: tortoiseProc.getCommandLabel('commit'),             enabled: true },
      { id: 'update',             label: tortoiseProc.getCommandLabel('update'),             enabled: true },
      { id: 'revert',             label: tortoiseProc.getCommandLabel('revert'),             enabled: scope !== 'file' || isModified || isConflicted },
      { id: 'log',                label: tortoiseProc.getCommandLabel('log'),                enabled: true },
      { id: 'diff',               label: tortoiseProc.getCommandLabel('diff'),               enabled: scope !== 'file' || isModified },
      { id: 'blame',              label: tortoiseProc.getCommandLabel('blame'),              enabled: scope === 'file' },
      { id: 'resolveConflict',    label: tortoiseProc.getCommandLabel('resolveConflict'),    enabled: isConflicted },
      { id: 'checkModifications', label: tortoiseProc.getCommandLabel('checkModifications'), enabled: true },
    ];
  }

  async runCommand(commandId, absPath) {
    if (!COMMAND_IDS.includes(commandId)) return -2;
    if (!this._tortoiseProcExe) return -1;
    const code = await tortoiseProc.runTortoise(this._tortoiseProcExe, commandId, { path: absPath });
    // Post-dialog refresh; the op may have changed status.
    if (absPath) {
      try {
        const stat = fs.existsSync(absPath) && fs.statSync(absPath);
        if (stat && stat.isDirectory()) {
          await this.refreshDataStatus();
          await this.refreshRepoStatus();
        } else {
          await this.refreshFile(absPath);
        }
      } catch (e) { /* ignore */ }
    }
    return code;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Walk up from `startDir` looking for `.svn`. Returns the outermost ancestor
 * containing `.svn` (handles legacy pre-1.7 nested layouts where every
 * folder had one). Returns null if none found.
 */
function findRepoRoot(startDir) {
  if (!startDir) return null;
  let cur = path.resolve(startDir);
  let outermost = null;
  // Stop at drive root on Windows, / on *nix.
  let lastCur = null;
  while (cur && cur !== lastCur) {
    try {
      if (fs.existsSync(path.join(cur, '.svn'))) outermost = cur;
    } catch (e) { /* ignore */ }
    lastCur = cur;
    cur = path.dirname(cur);
  }
  return outermost;
}

module.exports = {
  SvnProvider,
  findRepoRoot,
};
