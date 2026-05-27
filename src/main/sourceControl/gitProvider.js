// Git implementation of the SourceControlProvider interface. Mirrors
// SvnProvider — see Design.MD §27 for the generic contract and §28 for the
// SVN equivalent that this is patterned after.
//
// Responsibilities:
//  - Detect TortoiseGit + git.exe + TGitCache liveness (via toolDiscovery
//    and tgitCache).
//  - Locate the working-tree root by walking up from DATA_ROOT looking for
//    `.git` (innermost wins, unlike SVN's outermost-wins rule).
//  - Maintain two cached status maps (repo scope + data scope) refreshed
//    on demand and via explicit triggers (file save, TortoiseGitProc exit).
//  - Expose runCommand() that dispatches to TortoiseGitProc dialogs.
//  - Expose getCommands(path) returning Git-labelled menu entries.

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const toolDiscovery = require('../toolDiscovery');
const tgitCache = require('./tgitCache');
const gitCli = require('./gitCli');
const tortoiseGitProc = require('./tortoiseGitProc');

const STATUS_WORKER_PATH = path.join(__dirname, 'gitStatusWorker.js');

/**
 * Run a recursive status query in a Node worker_thread. Same rationale as
 * SvnProvider's runStatusInWorker — keeps the main event loop responsive
 * during a potentially-multi-hundred-ms parse.
 *
 * Never rejects; on any error returns an empty result.
 */
function runStatusInWorker(gitExe, scopePath, repoRoot) {
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
        workerData: { gitExe, scopePath, repoRoot },
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
  'commit', 'pull', 'push', 'fetch', 'sync',
  'log', 'diff', 'blame', 'revert',
  'rebase', 'switch', 'merge',
  'resolveConflict', 'checkModifications',
];

class GitProvider extends EventEmitter {
  constructor() {
    super();
    this.id = 'git';
    this.displayName = 'TortoiseGit';
    this.installTargetName = 'TortoiseGit';

    this._gitExe = null;
    this._tortoiseGitProcExe = null;
    this._repoRoot = null;       // innermost .git ancestor of DATA_ROOT
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
   * detect() starts clean. Called by the manager when DATA_ROOT changes
   * mid-session.
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
   * Run full detection. Returns a snapshot:
   *   {
   *     installed, connected, detail, warnings, repoRoot, dataScopeRoot,
   *     cacheAlive, statusBackendLive
   *   }
   *
   * `installed` — TortoiseGitProc.exe + git.exe both located
   * `connected` — installed AND DATA_ROOT has a `.git` ancestor
   * `cacheAlive` — TGitCache.exe is running
   * `statusBackendLive` — connected AND cacheAlive (drives pip/dot visibility)
   */
  async detect(dataRoot, dataScopeDirs) {
    this._tortoiseGitProcExe = toolDiscovery.findTortoiseGitProcExe();
    this._gitExe = toolDiscovery.findGitExe();

    const installed = !!(this._tortoiseGitProcExe && this._gitExe);
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
    // Dirs the data-scope scan covers — the data layers in suite mode, else
    // [dataRoot]. `git status` still runs once over the whole repo; this just
    // post-filters the result (see gitCli.getStatusRecursive).
    this._dataScopeDirs = repoRoot
      ? ((dataScopeDirs && dataScopeDirs.length) ? dataScopeDirs.slice() : [dataRoot])
      : [];
    const connected = !!repoRoot;

    const cacheAlive = await tgitCache.isCacheAlive();
    this._cacheAlive = cacheAlive;

    const warnings = [];
    if (connected && !cacheAlive) {
      warnings.push({
        kind: 'cacheDisabled',
        message: 'TGitCache disabled — status indicators hidden. Re-enable in TortoiseGit settings (Icon Overlays → Status Cache: Default).',
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

  async refreshDataStatus() {
    if (!this._dataScopeRoot || !this._repoRoot || !this._cacheAlive) return;
    if (this._refreshingData) { this._pendingDataRefresh = true; return; }
    this._refreshingData = true;
    try {
      // Pass the data-layer dirs as the scope — git runs once over the repo
      // and the result is post-filtered to those dirs.
      const { map, rollup } = await gitCli.getStatusRecursive(this._gitExe, this._dataScopeDirs, this._repoRoot);
      this._dataStatus = map;
      this._dataRollup = rollup;
      this.emit('statusChanged', { scope: 'data' });
    } finally {
      this._refreshingData = false;
      if (this._pendingDataRefresh) {
        this._pendingDataRefresh = false;
        this.refreshDataStatus();
      }
    }
  }

  async refreshRepoStatus() {
    if (!this._repoRoot || !this._cacheAlive) return;
    if (this._refreshingRepo) { this._pendingRepoRefresh = true; return; }
    this._refreshingRepo = true;
    try {
      const { map, rollup } = await runStatusInWorker(this._gitExe, this._repoRoot, this._repoRoot);
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

  async refreshFile(absPath) {
    if (!absPath || !this._cacheAlive || !this._gitExe || !this._repoRoot) return;
    const status = await gitCli.getStatusFile(this._gitExe, absPath, this._repoRoot);
    const prevData = this._dataStatus.get(absPath);
    if (status === 'clean') {
      this._dataStatus.delete(absPath);
      this._repoStatus.delete(absPath);
    } else {
      this._dataStatus.set(absPath, status);
      this._repoStatus.set(absPath, status);
    }
    if (prevData !== status) {
      this._dataRollup = this._computeRollup(this._dataStatus);
      this._repoRollup = this._computeRollup(this._repoStatus);
      this.emit('statusChanged', { scope: 'file', path: absPath });
    }
  }

  /**
   * Fetch the HEAD content for a file. Null if git has no base for it
   * (newly added, untracked, or not in repo). No fallback — the
   * renderer's VCS gutter simply shows nothing in that case.
   */
  async getBaseContent(absPath) {
    if (!absPath || !this._gitExe || !this._repoRoot) return null;
    return gitCli.getBaseContent(this._gitExe, this._repoRoot, absPath);
  }

  _computeRollup(map) {
    let r = 'clean';
    for (const s of map.values()) r = gitCli.worstOf(r, s);
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
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    return { rollup, entries: obj };
  }

  getFolderRollup(absFolderPath) {
    if (!this._cacheAlive || !absFolderPath) return 'clean';
    const prefix = absFolderPath.endsWith(path.sep) ? absFolderPath : absFolderPath + path.sep;
    const prefixLower = prefix.toLowerCase();
    let worst = 'clean';
    for (const [p, s] of this._dataStatus) {
      if (p.toLowerCase().startsWith(prefixLower)) {
        worst = gitCli.worstOf(worst, s);
      }
    }
    return worst;
  }

  // ─── Commands ──────────────────────────────────────────────────────

  /**
   * Build the context-menu entries for the given scope/path. Labels and
   * IDs come from tortoiseGitProc.COMMAND_LABELS — the renderer is
   * provider-agnostic and just renders what we return.
   *
   * `enabled` flags follow the same logic as the SVN provider: actions
   * that don't make sense for a clean file get greyed out, and
   * branch/working-tree-wide ops (rebase/switch/merge) are disabled at
   * file scope.
   */
  getCommands(scope, absPath) {
    if (!this._tortoiseGitProcExe) return [];
    const fileStatus = (scope === 'file' && absPath)
      ? (this._dataStatus.get(absPath) || this._repoStatus.get(absPath) || 'clean')
      : null;
    const isModified = fileStatus === 'modified' || fileStatus === 'added' || fileStatus === 'deleted';
    const isConflicted = fileStatus === 'conflicted';
    const repoWide = scope !== 'file';

    const L = (id) => tortoiseGitProc.getCommandLabel(id);
    return [
      { id: 'commit',             label: L('commit'),             enabled: true },
      { id: 'pull',               label: L('pull'),               enabled: true },
      { id: 'push',               label: L('push'),               enabled: true },
      { id: 'fetch',              label: L('fetch'),              enabled: true },
      { id: 'sync',               label: L('sync'),               enabled: true },
      { id: 'log',                label: L('log'),                enabled: true },
      { id: 'diff',               label: L('diff'),               enabled: scope !== 'file' || isModified },
      { id: 'blame',              label: L('blame'),              enabled: scope === 'file' },
      { id: 'revert',             label: L('revert'),             enabled: scope !== 'file' || isModified || isConflicted },
      { id: 'rebase',             label: L('rebase'),             enabled: repoWide },
      { id: 'switch',             label: L('switch'),             enabled: repoWide },
      { id: 'merge',              label: L('merge'),              enabled: repoWide },
      { id: 'resolveConflict',    label: L('resolveConflict'),    enabled: isConflicted },
      { id: 'checkModifications', label: L('checkModifications'), enabled: true },
    ];
  }

  async runCommand(commandId, absPath) {
    if (!COMMAND_IDS.includes(commandId)) return -2;
    if (!this._tortoiseGitProcExe) return -1;
    const code = await tortoiseGitProc.runTortoiseGit(this._tortoiseGitProcExe, commandId, { path: absPath });
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
 * Walk up from `startDir` looking for `.git`. Returns the **innermost**
 * ancestor containing it (whether directory or file — `.git` is a file
 * in linked worktrees and submodules). Returns null if none found.
 *
 * Innermost-wins is the right rule for Git: modern working trees only
 * have one `.git`, but submodules nest, and for someone editing inside a
 * submodule's data root the inner repo is what they actually want.
 */
function findRepoRoot(startDir) {
  if (!startDir) return null;
  let cur = path.resolve(startDir);
  let lastCur = null;
  while (cur && cur !== lastCur) {
    try {
      if (fs.existsSync(path.join(cur, '.git'))) return cur;
    } catch (e) { /* ignore */ }
    lastCur = cur;
    cur = path.dirname(cur);
  }
  return null;
}

module.exports = {
  GitProvider,
  findRepoRoot,
};
