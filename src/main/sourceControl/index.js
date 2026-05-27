// Source-control provider registry and active-provider resolver.
//
// The renderer never talks to a specific provider — it calls the generic
// API exposed here. Only one provider is "active" for a given DATA_ROOT.
// Resolution rule: first provider in `providerOrder` whose `detect()` says
// it is connected. If none is connected, the active provider is null and
// all status UI hides.

const { EventEmitter } = require('events');

const { SvnProvider } = require('./svnProvider');
const { GitProvider } = require('./gitProvider');

// Stub provider for Unity Version Control, so the Plugins chip can list
// it as "not installed" without needing real detection code. Replace
// when that integration is wired.
class StubProvider {
  constructor({ id, displayName, installTargetName }) {
    this.id = id;
    this.displayName = displayName;
    this.installTargetName = installTargetName;
  }
  async detect() {
    return {
      id: this.id,
      displayName: this.displayName,
      installTargetName: this.installTargetName,
      installed: false,
      connected: false,
      detail: null,
      warnings: [],
      repoRoot: null,
      dataScopeRoot: null,
      cacheAlive: false,
      statusBackendLive: false,
    };
  }
  getCommands() { return []; }
  async runCommand() { return -1; }
  getStatusSnapshot() { return null; }
  getFolderRollup() { return 'clean'; }
  async refreshDataStatus() {}
  async refreshRepoStatus() {}
  async refreshFile() {}
  async getBaseContent() { return null; }
  reset() {}
  on() { return this; } // no-op
  emit() {}
}

class SourceControlManager extends EventEmitter {
  constructor() {
    super();
    this._providers = [
      new SvnProvider(),
      new GitProvider(),
      new StubProvider({ id: 'uvc',  displayName: 'Unity Version Control', installTargetName: 'Unity Version Control' }),
    ];
    // Resolution order — first connected wins.
    this._providerOrder = ['svn', 'git', 'uvc'];
    this._snapshots = new Map();   // id → latest detect() snapshot
    this._activeId = null;
    this._dataRoot = null;
    // Directories the "data scope" status query should cover. In narrow mode
    // this is just [DATA_ROOT]; in suite mode it's the data-layer dirs
    // (GameData/Configuration + each expansion) — NOT the whole install,
    // which on a game-sized SVN working copy would make the data-scope scan
    // (main-thread) take seconds. The data-scope ROOT for relativizing stays
    // DATA_ROOT; only the scanned set is narrowed.
    this._dataScopeDirs = null;

    // Re-emit provider status changes upward.
    for (const p of this._providers) {
      if (typeof p.on === 'function') {
        p.on('statusChanged', (info) => {
          if (p.id === this._activeId) this.emit('statusChanged', info);
        });
      }
    }
  }

  setDataRoot(dataRoot, dataScopeDirs) {
    const changed = this._dataRoot !== dataRoot;
    this._dataRoot = dataRoot;
    this._dataScopeDirs = (dataScopeDirs && dataScopeDirs.length)
      ? dataScopeDirs.slice()
      : (dataRoot ? [dataRoot] : null);
    // Wipe per-provider status caches on root change so stale maps from
    // the previous repo don't leak into the new context. detect() + the
    // subsequent refresh passes repopulate them. This runs for every
    // provider — the generic contract is that `reset()` clears any
    // scope-bound state; providers that don't need it can no-op.
    if (changed) {
      for (const p of this._providers) {
        if (typeof p.reset === 'function') p.reset();
      }
      this._snapshots.clear();
      this._activeId = null;
    }
  }

  _findProvider(id) {
    return this._providers.find(p => p.id === id);
  }

  /**
   * Run detection across all providers. Picks the first connected one as
   * active (per providerOrder). Emits 'pluginsChanged' always, and
   * 'activeProviderChanged' if the active provider id changed.
   */
  async detectAll() {
    const prevActive = this._activeId;
    for (const p of this._providers) {
      const snap = await p.detect(this._dataRoot, this._dataScopeDirs);
      this._snapshots.set(p.id, snap);
    }
    let newActive = null;
    for (const id of this._providerOrder) {
      const snap = this._snapshots.get(id);
      if (snap && snap.connected) { newActive = id; break; }
    }
    this._activeId = newActive;
    this.emit('pluginsChanged', this.getPluginsSnapshot());
    if (prevActive !== newActive) {
      this.emit('activeProviderChanged', newActive);
    }
    return newActive;
  }

  getPluginsSnapshot() {
    const arr = [];
    for (const p of this._providers) {
      const s = this._snapshots.get(p.id);
      if (s) arr.push(s);
    }
    return arr;
  }

  getActiveProvider() {
    if (!this._activeId) return null;
    return this._findProvider(this._activeId);
  }

  getActiveSnapshot() {
    if (!this._activeId) return null;
    return this._snapshots.get(this._activeId) || null;
  }

  // ─── Status helpers delegated to active provider ──────────────────

  getStatusSnapshot(scope, absPath) {
    const p = this.getActiveProvider();
    if (!p) return null;
    return p.getStatusSnapshot(scope, absPath);
  }

  getFolderRollup(absFolderPath) {
    const p = this.getActiveProvider();
    if (!p) return 'clean';
    return p.getFolderRollup(absFolderPath);
  }

  async refreshDataStatus() {
    const p = this.getActiveProvider();
    if (!p) return;
    await p.refreshDataStatus();
  }

  async refreshRepoStatus() {
    const p = this.getActiveProvider();
    if (!p) return;
    await p.refreshRepoStatus();
  }

  async refreshFile(absPath) {
    const p = this.getActiveProvider();
    if (!p) return;
    await p.refreshFile(absPath);
  }

  async getBaseContent(absPath) {
    const p = this.getActiveProvider();
    if (!p || typeof p.getBaseContent !== 'function') return null;
    return p.getBaseContent(absPath);
  }

  // ─── Commands ─────────────────────────────────────────────────────

  getCommands(scope, absPath) {
    const p = this.getActiveProvider();
    if (!p) return [];
    return p.getCommands(scope, absPath);
  }

  async runCommand(commandId, absPath) {
    const p = this.getActiveProvider();
    if (!p) return -1;
    return p.runCommand(commandId, absPath);
  }
}

// Singleton — there is only one source-control manager per Electron main
// process.
const manager = new SourceControlManager();

module.exports = {
  manager,
  SourceControlManager,
};
