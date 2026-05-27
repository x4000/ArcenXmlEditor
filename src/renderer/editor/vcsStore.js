// Renderer-side cache of plugin + VCS status data. A thin subscribable store
// that fetches snapshots from main on startup / when notified, and exposes
// lookups used by Sidebar, TabBar, TitleBar, StatusBar.
//
// The store is deliberately VCS-agnostic — callers ask for a file's status
// or a folder's rollup, not "svn status". The active provider on the main
// side decides what that means.

const listeners = new Set();

const state = {
  plugins: [],              // [{id, displayName, installed, connected, ...}]
  active: null,             // active snapshot (or null)
  statusBackendLive: false, // convenience flag — pips/dots visible?

  // Status caches. Keys are absolute paths for repoEntries; relative-to-DATA_ROOT
  // for dataByRel. Both are rebuilt from the main-side map after refresh.
  dataRollup: 'clean',
  repoRollup: 'clean',
  dataByRel: new Map(),     // relPath → status (for file dots, sidebar, tabs)
  folderRollupByRel: new Map(), // relFolderPath → rollup status

  dataScopeRoot: null,      // absolute path of DATA_ROOT per provider
  dataScopeRootLower: null,
};

function notify() {
  for (const l of listeners) {
    try { l(state); } catch (e) { /* ignore subscriber errors */ }
  }
}

/**
 * Normalize a path for case-insensitive prefix comparison (Windows paths are
 * mixed-case; filesystem lookup is case-insensitive).
 */
function normKey(p) {
  return (p || '').replace(/\\/g, '/').toLowerCase();
}

function absToRel(abs) {
  if (!abs || !state.dataScopeRoot) return null;
  const normAbs = abs.replace(/\\/g, '/').toLowerCase();
  const root = state.dataScopeRootLower;
  if (!normAbs.startsWith(root + '/') && normAbs !== root) return null;
  let rel = abs.substring(state.dataScopeRoot.length);
  if (rel.startsWith('\\') || rel.startsWith('/')) rel = rel.substring(1);
  return rel.replace(/\\/g, '/');
}

const SEVERITY = { clean:0, ignored:0, unversioned:1, missing:2, added:3, deleted:3, modified:4, conflicted:5 };
const severity = (s) => SEVERITY[s] || 0;
const worst = (a, b) => severity(a) >= severity(b) ? a : b;

function rebuildFolderRollups() {
  state.folderRollupByRel = new Map();
  for (const [relPath, status] of state.dataByRel) {
    // Every ancestor folder inherits the file's status as a candidate for its rollup.
    const parts = relPath.split('/');
    parts.pop(); // drop filename
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      const prev = state.folderRollupByRel.get(acc) || 'clean';
      state.folderRollupByRel.set(acc, worst(prev, status));
    }
  }
}

async function refreshPlugins() {
  if (!window.arcenApi || !window.arcenApi.pluginsGetAll) return;
  const plugins = await window.arcenApi.pluginsGetAll();
  state.plugins = plugins || [];
  state.active = (plugins || []).find(p => p.connected) || null;
  state.statusBackendLive = !!(state.active && state.active.statusBackendLive);
  state.dataScopeRoot = state.active?.dataScopeRoot || null;
  state.dataScopeRootLower = state.dataScopeRoot ? normKey(state.dataScopeRoot) : null;
  notify();
}

async function refreshStatus() {
  if (!window.arcenApi || !window.arcenApi.scGetStatus) return;
  if (!state.statusBackendLive) {
    state.dataByRel = new Map();
    state.folderRollupByRel = new Map();
    state.dataRollup = 'clean';
    state.repoRollup = 'clean';
    notify();
    return;
  }
  const data = await window.arcenApi.scGetStatus('data');
  const repo = await window.arcenApi.scGetStatus('repo');
  state.dataRollup = data?.rollup || 'clean';
  state.repoRollup = repo?.rollup || 'clean';

  const m = new Map();
  if (data?.entries) {
    for (const [absPath, status] of Object.entries(data.entries)) {
      const rel = absToRel(absPath);
      if (rel) m.set(rel, status);
    }
  }
  state.dataByRel = m;
  rebuildFolderRollups();
  notify();
}

function subscribe(listener) {
  listeners.add(listener);
  // Push current state immediately so subscribers don't need a two-step dance.
  try { listener(state); } catch (e) { /* ignore */ }
  return () => listeners.delete(listener);
}

function getFileStatus(relPath) {
  if (!state.statusBackendLive || !relPath) return 'clean';
  return state.dataByRel.get(relPath) || 'clean';
}

function getFolderRollup(relFolderPath) {
  if (!state.statusBackendLive || !relFolderPath) return 'clean';
  return state.folderRollupByRel.get(relFolderPath) || 'clean';
}

/**
 * Worst VCS status over an explicit list of file relativePaths. Used for
 * the sidebar's logical-table folder rows: in suite mode a table folder
 * spans multiple on-disk directories (base + each expansion), so it has no
 * single path key in folderRollupByRel — the rollup must be computed from
 * the actual member files instead.
 */
function getRollupForPaths(relPaths) {
  if (!state.statusBackendLive || !relPaths || !relPaths.length) return 'clean';
  let acc = 'clean';
  for (const rp of relPaths) {
    const s = state.dataByRel.get(rp);
    if (s) acc = worst(acc, s);
  }
  return acc;
}

function getState() { return state; }

function init() {
  if (!window.arcenApi) return;
  refreshPlugins().then(() => refreshStatus());

  if (window.arcenApi.onPluginsChanged) {
    window.arcenApi.onPluginsChanged(async (_snap) => {
      await refreshPlugins();
      await refreshStatus();
    });
  }
  if (window.arcenApi.onVcsStatusChanged) {
    window.arcenApi.onVcsStatusChanged(() => refreshStatus());
  }
}

module.exports = {
  init,
  subscribe,
  refreshPlugins,
  refreshStatus,
  getFileStatus,
  getFolderRollup,
  getRollupForPaths,
  getState,
};
