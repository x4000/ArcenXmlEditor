const { app, BrowserWindow, ipcMain, dialog, shell, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const { manager: sourceControl } = require('./sourceControl');
const tsvnCache = require('./sourceControl/tsvnCache');
const tgitCache = require('./sourceControl/tgitCache');
const grammarLLM = require('./grammarLLM');
const { listActiveMods, getModLevelFilesForFormat } = require('./modDiscovery');

// Suppress crashpad "not connected" error on exit
crashReporter.start({ uploadToServer: false });

// Suppress transient GPU compositing warnings (harmless on some drivers)
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// ─── Data Root Resolution ────────────────────────────────────────────
// Priority: env var → xmlEdLast.json → exe directory → prompt user
//
// Settings live in %APPDATA%/ArcenSettings/XmlEditor/ (or the platform
// equivalent — app.getPath('appData') returns ~/Library/Application Support
// on macOS and ~/.config on Linux). Two files:
//   xmlEdLast.json    { dataRoot: "..." }   — most recent root (autoload target)
//   xmlEdRecent.json  { roots: ["...", ...] } — up to 30 recent roots, MRU order
//
// Storing config next to the exe was the previous approach, but when the
// user switches roots often, carrying a portable config alongside the exe
// is just noise. Using the platform's per-user settings directory keeps
// one authoritative location regardless of where the exe lives or how it
// was built.
const RECENT_ROOTS_CAP = 30;

// appData is only available after app.whenReady(); resolve lazily.
function getSettingsDir() {
  try {
    return path.join(app.getPath('appData'), 'ArcenSettings', 'XmlEditor');
  } catch (e) {
    return null;
  }
}
function getLastRootFile() {
  const d = getSettingsDir();
  return d ? path.join(d, 'xmlEdLast.json') : null;
}
function getRecentRootsFile() {
  const d = getSettingsDir();
  return d ? path.join(d, 'xmlEdRecent.json') : null;
}

function ensureSettingsDir() {
  const d = getSettingsDir();
  if (!d) return;
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
}

function loadLastDataRoot() {
  const f = getLastRootFile();
  if (!f) return null;
  try {
    if (fs.existsSync(f)) {
      const json = JSON.parse(fs.readFileSync(f, 'utf-8'));
      return typeof json?.dataRoot === 'string' ? json.dataRoot : null;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveLastDataRoot(root) {
  const f = getLastRootFile();
  if (!f) return;
  ensureSettingsDir();
  try {
    fs.writeFileSync(f, JSON.stringify({ dataRoot: root }, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save last data root:', e.message);
  }
}

function loadRecentDataRoots() {
  const f = getRecentRootsFile();
  if (!f) return [];
  try {
    if (fs.existsSync(f)) {
      const json = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (Array.isArray(json?.roots)) {
        return json.roots.filter((r) => typeof r === 'string');
      }
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveRecentDataRoots(roots) {
  const f = getRecentRootsFile();
  if (!f) return;
  ensureSettingsDir();
  try {
    fs.writeFileSync(f, JSON.stringify({ roots }, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save recent data roots:', e.message);
  }
  // Keep the taskbar jump list in sync with the recent list (no-op off Windows
  // / in dev). updateJumpList is hoisted; it only runs once app is ready.
  updateJumpList();
}

// De-duplicate by normalized path (case-insensitive on Windows), move the
// newly-chosen root to the front, cap the list.
function normalizeRootForCompare(p) {
  if (!p) return '';
  let s = path.normalize(p);
  if (s.length > 1 && s.endsWith(path.sep)) s = s.slice(0, -1);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// Compute a DATA_ROOT-relative path with forward slashes, matching the
// form `discoverData` and `snapshotMtimes` use. Every path that flows back
// to the renderer (as a map key, a broadcast payload, an mtime key) must
// go through this so `allFileContentsRef` never ends up with two entries
// for the same file — one with "/" and one with "\" — which global search
// would then report as duplicate files.
function relFwd(absPath) {
  const r = path.relative(DATA_ROOT, absPath);
  return r.replace(/\\/g, '/');
}

function addToRecentDataRoots(root) {
  if (!root) return;
  const current = loadRecentDataRoots();
  const key = normalizeRootForCompare(root);
  const filtered = current.filter((r) => normalizeRootForCompare(r) !== key);
  filtered.unshift(root);
  if (filtered.length > RECENT_ROOTS_CAP) filtered.length = RECENT_ROOTS_CAP;
  saveRecentDataRoots(filtered);
}

// Drop a single entry from the recent list (user-initiated, from the Change
// Data Folder picker's right-click). Does NOT touch the folder on disk — just
// forgets it. Returns the updated list so the renderer can refresh in place.
function removeFromRecentDataRoots(root) {
  const key = normalizeRootForCompare(root);
  const filtered = loadRecentDataRoots().filter((r) => normalizeRootForCompare(r) !== key);
  saveRecentDataRoots(filtered);
  return filtered;
}

// ── Window-title project name ────────────────────────────────────────────
// The window title shows a short "project name" derived from the data root's
// final folder segment. Default: that segment with underscores stripped
// ("HotMRoot" stays "HotMRoot"; "AI_War2_Ultra" → "AIWar2Ultra"). The user can
// override any root with a custom nickname (e.g. "AIW2Ultra"), stored per
// normalized path in xmlEdNicknames.json and editable from the Change Data
// Folder picker.
function getNicknamesFile() {
  const d = getSettingsDir();
  return d ? path.join(d, 'xmlEdNicknames.json') : null;
}
function loadNicknames() {
  const f = getNicknamesFile();
  if (!f) return {};
  try {
    if (fs.existsSync(f)) {
      const json = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (json && typeof json.nicknames === 'object' && json.nicknames) return json.nicknames;
    }
  } catch (e) { /* ignore */ }
  return {};
}
function saveNicknames(map) {
  const f = getNicknamesFile();
  if (!f) return;
  ensureSettingsDir();
  try {
    fs.writeFileSync(f, JSON.stringify({ nicknames: map }, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save root nicknames:', e.message);
  }
}
function getRootNickname(root) {
  if (!root) return '';
  const v = loadNicknames()[normalizeRootForCompare(root)];
  return typeof v === 'string' ? v : '';
}
function setRootNickname(root, nickname) {
  if (!root) return;
  const map = loadNicknames();
  const key = normalizeRootForCompare(root);
  const trimmed = (nickname || '').trim();
  if (trimmed) map[key] = trimmed;
  else delete map[key]; // clearing the nickname reverts to the default name
  saveNicknames(map);
  // The jump list shows each root's display name, so refresh it too.
  updateJumpList();
}
function defaultProjectName(root) {
  if (!root) return 'Arcen XML Editor';
  const base = path.basename(String(root).replace(/[\\/]+$/, ''));
  return base.replace(/_/g, '') || base || 'Arcen XML Editor';
}
function computeProjectName(root) {
  return getRootNickname(root) || defaultProjectName(root);
}
// Push the current root's project name to every window — used after a nickname
// edit so open windows refresh their titles without a reload.
function broadcastProjectName() {
  broadcastToAll('project-name-changed', computeProjectName(DATA_ROOT));
}

// ── Windows taskbar jump list ────────────────────────────────────────────
// Right-click the taskbar icon → a "Recent Folders" list; clicking one launches
// a NEW instance of AXE on that folder (resolveDataRoot's --data-root branch).
// There's no single-instance lock, so each launch is its own process — like VS
// opening multiple solutions. Windows-only. Refreshed whenever the recent list
// or a nickname changes. Safe to call before app-ready (guarded + try/catch).
//
// Requires app.setAppUserModelId (done at startup) — without an explicit AppID
// Windows won't host the custom jump list. A side effect on a directly-pinned
// portable exe is that the running window may not group under that exact pin;
// pin the build's shortcut (same AppID) to keep them grouped.
function updateJumpList() {
  if (process.platform !== 'win32') return;
  if (typeof app.setJumpList !== 'function') return;
  try {
    const roots = loadRecentDataRoots().filter(isValidDataRoot).slice(0, 12);
    if (roots.length === 0) {
      app.setJumpList(null); // clears any previously-set list
      return;
    }
    // Packaged: process.execPath is ArcenXmlEd.exe — relaunching it with
    // --data-root is enough. Dev: it's electron.exe, which also needs the app
    // directory as its leading arg (so the jump list is testable via npm start).
    const appPrefix = app.isPackaged ? '' : `"${app.getAppPath()}" `;
    const items = roots.map((root) => {
      // Strip any trailing separator: a path ending in "\" would turn the
      // closing quote into an escaped quote (\") and break arg parsing.
      const arg = String(root).replace(/[\\/]+$/, '');
      return {
        type: 'task',
        title: computeProjectName(root),  // honors per-root nicknames
        description: root,                // full path on hover
        program: process.execPath,
        args: `${appPrefix}--data-root "${arg}"`,
        iconPath: process.execPath,       // the app's own icon
        iconIndex: 0,
      };
    });
    // setJumpList returns a status string — 'ok' on success, otherwise an error
    // code (e.g. 'customCategoryAccessDeniedError' when the user has turned off
    // "recently opened items" in Windows settings). Only surface failures.
    const result = app.setJumpList([{ type: 'custom', name: 'Recent Folders', items }]);
    if (result !== 'ok') console.warn(`[jumplist] setJumpList returned "${result}"`);
  } catch (e) {
    console.warn('Failed to set taskbar jump list:', e.message);
  }
}

// One-time migration from the old dual-location `_editor_config.json`
// scheme (next-to-exe + %APPDATA%/ArcenXmlEd/). If we find a dataRoot there
// and don't already have xmlEdLast.json, import it. Leaves the old files
// in place — reversible.
function migrateOldConfigIfNeeded() {
  const lastFile = getLastRootFile();
  if (lastFile && fs.existsSync(lastFile)) return;
  const candidates = [];
  const nextToExeDir = process.env.PORTABLE_EXECUTABLE_DIR
    || (app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..'));
  candidates.push(path.join(nextToExeDir, '_editor_config.json'));
  try {
    candidates.push(path.join(app.getPath('userData'), '_editor_config.json'));
  } catch (e) { /* ignore */ }
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      const json = JSON.parse(fs.readFileSync(c, 'utf-8'));
      if (typeof json?.dataRoot === 'string' && json.dataRoot) {
        saveLastDataRoot(json.dataRoot);
        addToRecentDataRoots(json.dataRoot);
        return;
      }
    } catch (e) { /* ignore */ }
  }
}

// ─── Suite-mode layout ──────────────────────────────────────────────
// AXE has two top-level layouts for a data root:
//
//   "narrow" mode — DATA_ROOT *is* the folder containing SharedMetaData.metadata
//   and the numbered table subfolders (e.g. 1_BuildingType/). Original behavior;
//   appropriate for non-Arcen titles that just want a single editable data set.
//
//   "suite" mode — DATA_ROOT points one level above the Arcen game install. The
//   base data lives under DATA_ROOT/GameData/Configuration/ and additional
//   layers (expansions/DLCs) live under DATA_ROOT/Expansions/<dir>/, with
//   each active expansion announcing itself via an ExpansionInstallation.txt
//   marker file. Future modder layers (XMLMods, XMLMods_NonDistributed) will
//   plug in here too.
//
// Detection runs in this order:
//   1. If DATA_ROOT/GameData/Configuration/SharedMetaData.metadata exists,
//      we are in suite mode (regardless of what else is at DATA_ROOT).
//   2. Otherwise if DATA_ROOT itself has SharedMetaData.metadata or a
//      subfolder with a *.metadata file, narrow mode.
//   3. Otherwise the root is invalid.
//
// `detectLayout(root)` returns:
//   { mode: 'suite', baseDir, expansions: [{ id, num, dirName, dirPath }, ...] }
//   { mode: 'narrow', baseDir: root }
//   null — not a valid root
//
// All discovery, watching, and path translation in main.js consults a cached
// `currentLayout` derived from this. Renderer-side, suite-mode `relativePath`
// keys are full DATA_ROOT-relative paths (e.g. "GameData/Configuration/
// 1_NPCUnitType/NPC.xml" or "Expansions/DLC1_Kinship/1_NPCUnitType/NPC_DLC1.xml")
// so the same `path.join(DATA_ROOT, relPath)` round-trip works uniformly across
// layers and the keys uniquely identify the on-disk file.

const SUITE_BASE_REL = 'GameData/Configuration';
const SUITE_EXPANSIONS_REL = 'Expansions';
const EXPANSION_MARKER = 'ExpansionInstallation.txt';

function looksLikeSuiteBase(absDir) {
  try {
    return fs.existsSync(path.join(absDir, 'SharedMetaData.metadata'));
  } catch (e) { return false; }
}

function looksLikeNarrowRoot(absDir) {
  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === 'SharedMetaData.metadata')) return true;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const subFiles = fs.readdirSync(path.join(absDir, entry.name));
        if (subFiles.some((f) => f.endsWith('.metadata'))) return true;
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* not a valid dir */ }
  return false;
}

function listActiveExpansions(absRoot) {
  const out = [];
  const expansionsRoot = path.join(absRoot, SUITE_EXPANSIONS_REL);
  let entries;
  try { entries = fs.readdirSync(expansionsRoot, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(expansionsRoot, e.name);
    if (!fs.existsSync(path.join(dirPath, EXPANSION_MARKER))) continue;
    // Where the expansion's table folders actually live. HotM-style expansions
    // put them right under `<dirPath>/`; AIW2-style expansions nest them at
    // `<dirPath>/GameData/Configuration/` (mirroring the base-game layout).
    // Detect by checking which path exists — if both are valid, the nested
    // one wins because that's the explicit AIW2 convention.
    const nestedTableRoot = path.join(dirPath, SUITE_BASE_REL);
    const tableRoot = fs.existsSync(nestedTableRoot) ? nestedTableRoot : dirPath;
    out.push({ dirName: e.name, dirPath, tableRoot });
  }
  // Stable natural-order sort. The position in this list (1-based) becomes the
  // DLC number; the folder name itself is just a label.
  out.sort((a, b) => _naturalCollator.compare(a.dirName, b.dirName));
  return out.map((e, i) => ({
    id: `dlc${i + 1}`,
    num: i + 1,
    dirName: e.dirName,
    dirPath: e.dirPath,
    // `tableRoot` is what every scanner / watcher / path-resolver should use
    // to locate this expansion's table folders. `dirPath` stays the
    // expansion's logical identity (its top-level directory under Expansions/).
    tableRoot: e.tableRoot,
  }));
}

function detectLayout(absRoot) {
  if (!absRoot) return null;
  const suiteBaseDir = path.join(absRoot, SUITE_BASE_REL);
  if (looksLikeSuiteBase(suiteBaseDir)) {
    return {
      mode: 'suite',
      baseDir: suiteBaseDir,
      baseRel: SUITE_BASE_REL,
      expansions: listActiveExpansions(absRoot),
      // Mods are suite-mode only. Narrow mode = single standalone data folder
      // with no concept of an install root or modding hierarchy.
      mods: listActiveMods(absRoot),
    };
  }
  if (looksLikeNarrowRoot(absRoot)) {
    return { mode: 'narrow', baseDir: absRoot, baseRel: '', expansions: [], mods: [] };
  }
  return null;
}

let currentLayout = null;

function isValidDataRoot(dir) {
  return detectLayout(dir) !== null;
}

// A data root passed on the command line. The taskbar jump list (see
// updateJumpList) launches `ArcenXmlEd.exe --data-root "<folder>"` to open a
// NEW instance on that folder — there's no single-instance lock, so every
// launch is its own process, like Visual Studio opening multiple solutions.
function getCliDataRoot() {
  const argv = process.argv;
  const i = argv.indexOf('--data-root');
  if (i >= 0 && i + 1 < argv.length) {
    const candidate = argv[i + 1];
    if (candidate && isValidDataRoot(candidate)) return candidate;
  }
  return null;
}

async function resolveDataRoot() {
  // Pull in anything from the old `_editor_config.json` scheme before
  // consulting xmlEdLast.json, so a user upgrading from a previous build
  // doesn't lose their data root.
  migrateOldConfigIfNeeded();

  // 0. Explicit command-line root (a taskbar jump-list launch). The user picked
  //    this exact folder, so it wins over the saved last root, and we record it
  //    as the new last/recent so a later plain launch reopens it.
  const cliRoot = getCliDataRoot();
  if (cliRoot) {
    saveLastDataRoot(cliRoot);
    addToRecentDataRoots(cliRoot);
    return cliRoot;
  }

  // 1. Environment variable
  if (process.env.ARCEN_DATA_ROOT && isValidDataRoot(process.env.ARCEN_DATA_ROOT)) {
    return process.env.ARCEN_DATA_ROOT;
  }

  // 2. Saved last root
  const last = loadLastDataRoot();
  if (last && isValidDataRoot(last)) {
    return last;
  }

  // 3. Exe directory (only in packaged builds — in dev, process.execPath is
  //    Electron itself, which sits in node_modules and can't be a data root)
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    if (isValidDataRoot(exeDir)) {
      saveLastDataRoot(exeDir);
      addToRecentDataRoots(exeDir);
      return exeDir;
    }
  }

  // 4. No valid folder found — return null, let the UI show the "Choose Folder" button
  return null;
}

async function promptForDataRoot(quitOnCancel = true) {
  const result = await dialog.showOpenDialog({
    title: 'Select Game Data Root Folder',
    message: 'Select either an Arcen game install folder (containing GameData/Configuration) or a standalone data folder (containing SharedMetaData.metadata)',
    properties: ['openDirectory'],
  });

  if (result.canceled || !result.filePaths.length) {
    if (quitOnCancel) app.quit();
    return null;
  }

  const chosen = result.filePaths[0];
  if (!isValidDataRoot(chosen)) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Invalid Data Folder',
      message: 'The selected folder is not a valid data root.\nExpected either:\n  • A suite root with GameData/Configuration/SharedMetaData.metadata, or\n  • A narrow root with SharedMetaData.metadata directly inside.',
    });
    return await promptForDataRoot(quitOnCancel); // retry
  }

  saveLastDataRoot(chosen);
  addToRecentDataRoots(chosen);
  return chosen;
}

let DATA_ROOT = null; // set during app.whenReady()
// DATA_HOME is the directory that holds per-user / per-data-set files —
// the editor session, shared prefs, spelling dictionaries, and grammar
// cache. In narrow mode it equals DATA_ROOT. In suite mode it is the base
// layer directory (DATA_ROOT/GameData/Configuration), so these files stay
// next to the actual game data and a narrow-mode root opened directly at
// GameData/Configuration shares the same session/dictionaries as the
// suite-mode root one level up. Always derived from currentLayout.baseDir.
let DATA_HOME = null;
let SESSION_FILE = null;
// Path to the legacy _editor_shared.json. Kept solely to migrate its
// contents into the session file on startup once; the file is then deleted.
let LEGACY_SHARED_FILE = null;

// Recompute DATA_HOME + the session file path from the current layout. Call
// immediately after DATA_ROOT / currentLayout change.
function refreshDataHomePaths() {
  DATA_HOME = currentLayout ? currentLayout.baseDir : DATA_ROOT;
  SESSION_FILE = DATA_HOME ? path.join(DATA_HOME, '_user_editor_session.json') : null;
  LEGACY_SHARED_FILE = DATA_HOME ? path.join(DATA_HOME, '_editor_shared.json') : null;
}

let mainWindow = null;
let validationWindow = null;
let helpWindow = null;
let watcher = null;
let recentSaves = new Set();
let fileMtimes = new Map();
let lastSaveTime = 0;
// Absolute paths of "island" embedded-XML data files (e.g. Unity .asset YAML
// whose editable XML lives in the `xml:` field). Rebuilt every discovery.
// `read-file` consults this to decode the embedded XML transparently. See
// discoverExtraDataSources() and the island branch in the read-file handler.
let islandEmbeddedAbsPaths = new Set();
// Island folder directories (for the file watcher to cover) and the full set of
// island file abs paths — data files + each island's `.metadata` — for change
// detection (mtime snapshot / focus-recheck). Islands live OUTSIDE the normal
// layer dirs, so they need to be added explicitly.
let islandFolderDirs = [];
let islandTrackedAbsPaths = new Set();
let lastValidatorBounds = null;
let lastHelpBounds = null;

/**
 * Return the bounds to persist for a window, or null if capturing bounds right now
 * would give bogus values. Specifically:
 *   - minimized: skip (returns last-known via caller's cache)
 *   - maximized: use getNormalBounds() — i.e. what the window would be if restored
 *   - otherwise: use getContentBounds() (matches what setContentBounds will restore)
 * Without this guard, a maximized window on Windows saves as { x: 0, y: 0, width:
 * screenW, height: screenH } because getContentBounds returns the maximized bounds.
 * On next startup, the window would open un-maximized at (0, 0) with full-screen
 * dimensions — matching a user report of "window at top of screen, sizing looks right".
 */
function safeBoundsForSave(win) {
  if (!win || win.isDestroyed()) return null;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) return null;
  if (typeof win.isMaximized === 'function' && win.isMaximized() && typeof win.getNormalBounds === 'function') {
    const b = win.getNormalBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  const b = win.getContentBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

// ─── Multi-Window Registry ──────────────────────────────────────────
// windowId → { browserWindow, tabs: [relativePath], activeFile? }
const windowRegistry = new Map();
let detachedCounter = 0;

// The file the user most recently worked with across ALL windows, used by the
// main window's "center sidebar on the active tab when the filter clears"
// behavior. Updated when any window reports a tab activation, and when a
// detached window regains focus (so merely returning to a detached window the
// user was last in points the target there). Focusing the MAIN window does NOT
// overwrite it — otherwise reaching over to the main window's filter box would
// always clobber the detached file the user was actually editing.
let lastActiveFileGlobal = null;

// ─── Central File State Registry ────────────────────────────────────
// relativePath → { cursor, scrollLine, refPanel: { open, height, scrollLine } | null }
const fileStateRegistry = new Map();
let sessionDirty = false;
const windowLevelState = {}; // tabs, activeTab, sidebar, theme, etc. — set by renderer

function broadcastToAll(channel, ...args) {
  for (const entry of windowRegistry.values()) {
    if (entry.browserWindow && !entry.browserWindow.isDestroyed()) {
      entry.browserWindow.webContents.send(channel, ...args);
    }
  }
  // Also send to validation window
  if (validationWindow && !validationWindow.isDestroyed()) {
    validationWindow.webContents.send(channel, ...args);
  }
}

function getWindowIdForWebContents(wc) {
  for (const [id, entry] of windowRegistry) {
    if (entry.browserWindow && !entry.browserWindow.isDestroyed() && entry.browserWindow.webContents === wc) {
      return id;
    }
  }
  return null;
}

function findWindowForTab(relativePath) {
  for (const [id, entry] of windowRegistry) {
    if (entry.tabs && entry.tabs.includes(relativePath)) return id;
  }
  return null;
}

// Recompute the displayNum for every live detached window and push each
// new title to its BrowserWindow. Ordering is by the numeric suffix of
// the stable `det_N` windowId, which matches creation order.
function renumberDetachedWindows() {
  const ids = [];
  for (const [id, entry] of windowRegistry) {
    if (id === 'main') continue;
    if (!entry.browserWindow || entry.browserWindow.isDestroyed()) continue;
    ids.push(id);
  }
  ids.sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0;
    return na - nb;
  });
  ids.forEach((id, idx) => {
    const entry = windowRegistry.get(id);
    if (!entry?.browserWindow || entry.browserWindow.isDestroyed()) return;
    entry.displayNum = idx + 1;
    // Push the number to the renderer — the custom frameless title bar
    // (TitleBar.jsx) computes "<Project>-<N>" and sets document.title, which
    // drives the OS title/taskbar. Refreshes when a peer window opens/closes.
    try { entry.browserWindow.webContents.send('detached-display-num', idx + 1); } catch (e) { /* webContents gone */ }
  });
}

function createDetachedWindow(windowId, tabPaths, x, y, width, height) {
  const db = ensureBoundsOnScreen({ x, y, width: width || 900, height: height || 700 });
  const win = new BrowserWindow({
    width: db.width,
    height: db.height,
    title: 'AXE Detached',
    icon: path.join(__dirname, '..', '..', 'icons', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Use setContentBounds to avoid frameless window border growth on Windows
  if (db.x != null && db.y != null) {
    win.setContentBounds({ x: db.x, y: db.y, width: db.width, height: db.height });
  }

  const htmlPath = path.join(__dirname, '..', 'renderer', 'index.html');
  win.loadFile(htmlPath, { query: { mode: 'detached', windowId } });

  // The renderer drives the window/taskbar title via document.title now
  // (project name + current filename, or "<Project>-<N>" when empty — see
  // TitleBar.jsx). We deliberately DON'T intercept page-title-updated here, so
  // that document.title propagates to the OS title/taskbar. The display number
  // the renderer needs still flows via 'detached-display-num' below.

  windowRegistry.set(windowId, {
    browserWindow: win,
    tabs: tabPaths || [],
  });
  // Assign display numbers now — this also sets the title on any other
  // open detached windows whose rank may have shifted.
  renumberDetachedWindows();

  win.on('close', (e) => {
    // Save bounds before closing — use safeBoundsForSave so a maximized window
    // captures its un-maximized size/position, not (0,0,screenW,screenH).
    const bounds = safeBoundsForSave(win);
    const entry = windowRegistry.get(windowId);
    if (entry && bounds) entry.bounds = bounds;

    // Confirm close if not being force-closed by main window
    if (!win._forceClose) {
      e.preventDefault();
      const tabCount = entry?.tabs?.length || 0;
      dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Close', 'Cancel'],
        defaultId: 1,
        title: 'Close Detached Window',
        message: `This will close ${tabCount} tab${tabCount !== 1 ? 's' : ''} and the detached window that holds them. Are you sure?`,
      }).then(({ response }) => {
        if (response === 0) {
          win._forceClose = true;
          win.close();
        }
      });
      return;
    }
    // About to actually close — persist the session NOW so this window's
    // tabs and bounds survive even if it closes before the main window.
    // Without this, saveFullSession only ran on main close and would see
    // an empty windowRegistry entry by then (the 'closed' handler clears
    // it), losing the tabs.
    try { saveFullSession(); } catch (err) { console.error('saveFullSession on detached close failed:', err.message); }
  });

  win.on('closed', () => {
    // Only drop the registry entry if it still points at THIS window.
    // The root-switch path (applyNewDataRoot) destroys all detached
    // windows and then immediately creates new ones from the new
    // session, which can re-use the same windowId (e.g. 'det_1'). The
    // old window's 'closed' fires asynchronously after destroy(), so
    // without this guard it would wipe the newly-created entry.
    const entry = windowRegistry.get(windowId);
    if (!entry || entry.browserWindow === win) {
      windowRegistry.delete(windowId);
      // Re-rank the remaining detached windows so their titles count
      // 1..N with no gaps.
      renumberDetachedWindows();
      // The closed window's active file should no longer be highlighted.
      broadcastActiveFiles();
    }
  });

  win.on('focus', () => {
    // Returning to a detached window makes its active file the "center" target.
    const entry = windowRegistry.get(windowId);
    if (entry && entry.activeFile) lastActiveFileGlobal = entry.activeFile;
    if (Date.now() - lastSaveTime < 3000) return;
    checkForChangedFiles();
  });

  return win;
}

// ─── Window Visibility Helper ────────────────────────────────────────
const { screen } = require('electron');

function ensureBoundsOnScreen(bounds) {
  if (!bounds || bounds.x == null || bounds.y == null) return bounds;
  const displays = screen.getAllDisplays();
  const isVisible = displays.some(d => {
    const b = d.bounds;
    return bounds.x >= b.x - 100 && bounds.x < b.x + b.width &&
           bounds.y >= b.y - 50 && bounds.y < b.y + b.height;
  });
  if (!isVisible) {
    const primary = screen.getPrimaryDisplay().bounds;
    return { ...bounds, x: primary.x + 100, y: primary.y + 100 };
  }
  return bounds;
}

// ─── Window Management ───────────────────────────────────────────────

function createMainWindow() {
  const session = loadSession();
  const wb = ensureBoundsOnScreen(session.window || {});

  mainWindow = new BrowserWindow({
    width: wb.width || 1400,
    height: wb.height || 900,
    title: 'Arcen XML Editor',
    icon: path.join(__dirname, '..', '..', 'icons', 'icon.png'),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In dev, load from esbuild dev server or file
  // Use setContentBounds to avoid frameless window border growth on Windows
  if (wb.x != null && wb.y != null) {
    mainWindow.setContentBounds({ x: wb.x, y: wb.y, width: wb.width || 1400, height: wb.height || 900 });
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('focus', () => {
    // Don't check immediately after a save to avoid false positives
    if (Date.now() - lastSaveTime < 3000) return;
    checkForChangedFiles();
  });

  mainWindow.on('close', () => {
    saveSessionWindowBounds();
    // Close validator and help windows
    if (validationWindow && !validationWindow.isDestroyed()) validationWindow.destroy();
    if (helpWindow && !helpWindow.isDestroyed()) helpWindow.destroy();
    // Close all detached windows when main closes (skip confirmation)
    for (const [id, entry] of windowRegistry) {
      if (id !== 'main' && entry.browserWindow && !entry.browserWindow.isDestroyed()) {
        entry.browserWindow._forceClose = true;
        entry.browserWindow.close();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    windowRegistry.delete('main');
  });

  // Register in window registry
  windowRegistry.set('main', { browserWindow: mainWindow, tabs: [] });
}

function createValidationWindow() {
  if (validationWindow) {
    validationWindow.focus();
    return;
  }

  const session = loadSession();
  const vb = ensureBoundsOnScreen(lastValidatorBounds || session.validationWindow || {});

  validationWindow = new BrowserWindow({
    width: vb.width || 700,
    height: vb.height || 500,
    title: 'Arcen XML Validator',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Use setContentBounds to avoid frameless window border growth on Windows
  if (vb.x != null && vb.y != null) {
    validationWindow.setContentBounds({ x: vb.x, y: vb.y, width: vb.width || 700, height: vb.height || 500 });
  }

  validationWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'validation.html'),
    { query: { _t: Date.now().toString() } }
  );

  // Keep the taskbar title correct, and send cached results + theme after load
  validationWindow.webContents.on('did-finish-load', () => {
    validationWindow.setTitle('Arcen XML Validator');
    // Send current theme
    if (windowLevelState.theme) {
      validationWindow.webContents.send('theme-change', windowLevelState.theme);
    }
    // Send cached validation results
    if (lastValidationResults.length > 0) {
      validationWindow.webContents.send('validation-results', lastValidationResults);
    }
  });
  validationWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    validationWindow.setTitle('Arcen XML Validator');
  });

  // Track bounds on every move/resize so we always have the latest.
  // safeBoundsForSave returns null if the window is minimized or undefined values
  // would result — in those cases, keep the previous lastValidatorBounds.
  validationWindow.on('move', () => {
    const b = safeBoundsForSave(validationWindow);
    if (b) lastValidatorBounds = b;
  });
  validationWindow.on('resize', () => {
    const b = safeBoundsForSave(validationWindow);
    if (b) lastValidatorBounds = b;
  });

  validationWindow.on('close', () => {
    // Save to disk on close
    try {
      const b = safeBoundsForSave(validationWindow);
      if (b) lastValidatorBounds = b;
    } catch (_) {}
    if (lastValidatorBounds) {
      const s = loadSession();
      s.validationWindow = lastValidatorBounds;
      saveSession(s);
    }
  });

  validationWindow.on('closed', () => {
    validationWindow = null;
    if (mainWindow) mainWindow.focus();
  });
}

function createHelpWindow() {
  if (helpWindow) {
    helpWindow.focus();
    return;
  }

  const session = loadSession();
  const hb = ensureBoundsOnScreen(session.helpWindow || {});

  helpWindow = new BrowserWindow({
    width: hb.width || 850,
    height: hb.height || 650,
    title: 'AXE Help Reference',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Use setContentBounds to avoid frameless window border growth on Windows
  if (hb.x != null && hb.y != null) {
    helpWindow.setContentBounds({ x: hb.x, y: hb.y, width: hb.width || 850, height: hb.height || 650 });
  }

  helpWindow.loadFile(path.join(__dirname, '..', 'renderer', 'help.html'));

  helpWindow.webContents.on('did-finish-load', () => {
    helpWindow.setTitle('AXE Help Reference');
  });
  helpWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    helpWindow.setTitle('AXE Help Reference');
  });

  helpWindow.on('move', () => {
    const b = safeBoundsForSave(helpWindow);
    if (b) lastHelpBounds = b;
  });
  helpWindow.on('resize', () => {
    const b = safeBoundsForSave(helpWindow);
    if (b) lastHelpBounds = b;
  });
  helpWindow.on('close', () => {
    try {
      const b = safeBoundsForSave(helpWindow);
      if (b) lastHelpBounds = b;
    } catch (_) {}
    if (lastHelpBounds) {
      const s = loadSession();
      s.helpWindow = lastHelpBounds;
      saveSession(s);
    }
  });
  helpWindow.on('closed', () => { helpWindow = null; });
}

// ─── Session Persistence ─────────────────────────────────────────────

// Re-base a stored DATA_ROOT-relative path onto the current layout. A path
// written by one layout (narrow vs suite) must resolve under the other,
// because the narrow-at-GameData/Configuration root and the suite-at-the-
// parent root resolve DATA_HOME to the SAME folder and therefore share the
// session and shared-prefs files (§5.2 / §31). Suite base-layer paths carry
// the GameData/Configuration/ prefix; narrow paths don't.
//
// Paths that already sit at DATA_ROOT level in a layout-independent way pass
// through unchanged:
//   - Expansions/...               (DLCs / expansions)
//   - XMLMods/...                  (local distributed mods)
//   - XMLMods_NonDistributed/...   (local private mods)
//   - ../...                       (path leaving DATA_ROOT — workshop mods,
//                                   whose Steam install dir is outside it)
// Only the base layer needs the suite↔narrow prefix shuffle.
// Directory prefixes (DATA_ROOT-relative, trailing-slash) declared in
// _extraDataSources.txt — the roots under which "island" data sources live.
// Island paths sit at DATA_ROOT level (layout-independent), so the session
// path-rebaser must NOT glue the base-layer prefix onto them. Cached per
// baseDir (read at session-load time, when currentLayout is set but discovery
// may not have run yet, so we read the file directly rather than rely on the
// discovered island list).
let _extraSourcePrefixes = null;
let _extraSourcePrefixesKey = null;
function getExtraDataSourceRelPrefixes() {
  const key = currentLayout ? currentLayout.baseDir : null;
  if (!key) return [];
  if (_extraSourcePrefixesKey === key && _extraSourcePrefixes) return _extraSourcePrefixes;
  const out = [];
  try {
    const txt = fs.readFileSync(path.join(currentLayout.baseDir, '_extraDataSources.txt'), 'utf-8');
    for (const line of txt.split(/\r\n?|\n/)) {
      const rel = line.trim().replace(/^\.\//, '').replace(/[/\\]+$/, '');
      if (rel) out.push(rel + '/');
    }
  } catch (_) { /* no extra sources */ }
  _extraSourcePrefixes = out;
  _extraSourcePrefixesKey = key;
  return out;
}

function rebaseToCurrentLayout(p) {
  if (typeof p !== 'string' || !p || !currentLayout) return p;
  const SUITE_PREFIX = SUITE_BASE_REL + '/';
  // Strip an existing suite base prefix → bare base-layer path. We strip
  // FIRST so an older session that incorrectly saved a mod path with the
  // base prefix glued on (e.g. "GameData/Configuration/XMLMods/...") still
  // recovers to its layout-independent form below.
  const bare = p.startsWith(SUITE_PREFIX) ? p.slice(SUITE_PREFIX.length) : p;
  // Paths that sit at DATA_ROOT level in a layout-independent way (or
  // leave DATA_ROOT entirely) pass through — don't re-prefix with the
  // base layer.
  if (bare.startsWith('Expansions/')
      || bare.startsWith('XMLMods/')
      || bare.startsWith('XMLMods_NonDistributed/')
      || bare.startsWith('../')) {
    return bare;
  }
  // Island (extra-data-source) paths are layout-independent too. (The strip
  // above also recovers an island path a buggy earlier build saved with the
  // base prefix glued on.)
  for (const pre of getExtraDataSourceRelPrefixes()) {
    if (bare.startsWith(pre)) return bare;
  }
  const prefix = currentLayout.baseRel ? currentLayout.baseRel + '/' : '';
  return prefix + bare;
}

// Re-base every tab/file path in a loaded session onto the current layout.
function normalizeSessionPaths(session) {
  if (!session || !currentLayout) return session;
  const remapKeys = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const next = {};
    for (const [k, v] of Object.entries(obj)) next[rebaseToCurrentLayout(k)] = v;
    return next;
  };

  if (Array.isArray(session.tabs)) session.tabs = session.tabs.map(rebaseToCurrentLayout);
  if (session.fileStates) session.fileStates = remapKeys(session.fileStates);
  if (session.cursorPositions) session.cursorPositions = remapKeys(session.cursorPositions);
  if (session.referencePanels) session.referencePanels = remapKeys(session.referencePanels);
  if (Array.isArray(session.favorites)) {
    for (const g of session.favorites) {
      if (g && Array.isArray(g.files)) g.files = g.files.map(rebaseToCurrentLayout);
    }
  }
  if (Array.isArray(session.detachedWindows)) {
    for (const dw of session.detachedWindows) {
      if (Array.isArray(dw.tabs)) dw.tabs = dw.tabs.map(rebaseToCurrentLayout);
    }
  }
  return session;
}

// One-time migration of the legacy `_editor_shared.json` (favorites +
// globalSearchIncludeMods, briefly) into the session file. Originally
// favorites lived in a separate "shared" file intended for cross-staff
// sharing; in practice that's not how anyone uses them — they're per-user
// editor state — and the model breaks down entirely for modders. The
// session file is now the single source of truth.
//
// If the legacy file exists, copy fields that aren't already in the session
// (so an in-flight session that already received them via the prior round
// of code wins), then delete the legacy file. Idempotent: subsequent
// startups find no legacy file and do nothing.
function mergeLegacySharedIntoSession(session) {
  if (!LEGACY_SHARED_FILE) return session;
  if (!fs.existsSync(LEGACY_SHARED_FILE)) return session;
  let shared;
  try {
    shared = JSON.parse(fs.readFileSync(LEGACY_SHARED_FILE, 'utf-8'));
  } catch (e) {
    console.warn('Legacy shared file corrupted, skipping migration:', e.message);
    return session;
  }
  let merged = false;
  // Treat an empty favorites array as "not yet migrated" — earlier builds
  // could leave `favorites: []` in the session file if the renderer pushed
  // an empty initial state before the user had any in the new scheme. We
  // never want to lose actually-curated legacy favorites just because of
  // that artifact.
  const sessionHasFavorites = Array.isArray(session.favorites) && session.favorites.length > 0;
  if (Array.isArray(shared?.favorites) && shared.favorites.length > 0 && !sessionHasFavorites) {
    session.favorites = shared.favorites;
    merged = true;
  }
  if (shared && shared.globalSearchIncludeMods != null && session.globalSearchIncludeMods == null) {
    session.globalSearchIncludeMods = !!shared.globalSearchIncludeMods;
    merged = true;
  }
  // Persist the merged session FIRST so the favorites can't be lost if the
  // app is force-killed before the next graceful close / periodic save. Then
  // delete the legacy file. Doing it in the other order would create a
  // window where both files exist (post-write, pre-delete) and a crash
  // there'd leave the legacy file behind, but the data is at least safe.
  if (merged) {
    try { saveSession(session); }
    catch (e) { console.warn('[migration] Failed to persist merged session:', e.message); }
  }
  try {
    fs.unlinkSync(LEGACY_SHARED_FILE);
    console.log('[migration] Merged _editor_shared.json into session and removed the legacy file.');
  } catch (e) {
    console.warn('[migration] Merged contents but failed to delete legacy shared file:', e.message);
  }
  return session;
}

function loadSession() {
  if (!SESSION_FILE) return {};
  let session = {};
  try {
    if (fs.existsSync(SESSION_FILE)) {
      session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Session file corrupted, using defaults:', e.message);
  }
  session = mergeLegacySharedIntoSession(session);
  return normalizeSessionPaths(session);
}

function saveSession(data) {
  if (!SESSION_FILE) return;
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save session:', e.message);
  }
}

function saveFullSession() {
  const session = {};

  // Window-level state from renderer (tabs, sidebar, theme, etc.)
  Object.assign(session, windowLevelState);

  // Main window bounds. safeBoundsForSave avoids saving maximized bounds as
  // the persisted size/position — otherwise the next launch opens an un-maximized
  // window at (0,0) filling the screen. Also skips if the window is minimized.
  // If bounds aren't capturable right now, leave the previously-saved value alone.
  const mainBounds = safeBoundsForSave(mainWindow);
  if (mainBounds) {
    session.window = mainBounds;
  } else {
    const prev = loadSession();
    if (prev.window) session.window = prev.window;
  }

  // Detached window layout + bounds
  const detachedWindows = [];
  for (const [id, entry] of windowRegistry) {
    if (id === 'main') continue;
    if (!entry.browserWindow || entry.browserWindow.isDestroyed()) continue;
    const dwBounds = safeBoundsForSave(entry.browserWindow) || entry.bounds;
    if (!dwBounds) continue;
    detachedWindows.push({
      windowId: id,
      tabs: entry.tabs || [],
      activeTab: entry.activeTab ?? 0,
      bounds: dwBounds,
    });
  }
  session.detachedWindows = detachedWindows;

  // Central file state registry. Persist only the scroll/cursor state of files
  // still open in some window — otherwise fileStates accumulates an entry for
  // every file ever opened and grows without bound across restarts. (Pruning
  // here, at save time, is safe: every window has long since registered its
  // tabs, so the open-set is complete.)
  const openFiles = new Set();
  for (const entry of windowRegistry.values()) {
    for (const t of (entry.tabs || [])) openFiles.add(typeof t === 'string' ? t.replace(/\\/g, '/') : t);
  }
  const fileStates = {};
  for (const [p, state] of fileStateRegistry) {
    // Safety: an empty open-set almost always means windows haven't registered
    // their tabs yet (not that everything is genuinely closed), so skip pruning
    // entirely in that case — keeping a few stale entries is far better than
    // wiping every file's scroll/cursor state.
    if (openFiles.size === 0 || openFiles.has(typeof p === 'string' ? p.replace(/\\/g, '/') : p)) fileStates[p] = state;
  }
  session.fileStates = fileStates;

  // Validator/help window bounds — prefer live safe bounds, fall back to cached
  // "last known good" bounds from move/resize handlers (which themselves already
  // guard against minimized/maximized via safeBoundsForSave).
  // Validator/help window bounds. If we can't capture fresh bounds AND we have
  // no in-memory cached bounds (window never opened this session), preserve the
  // previously-saved value instead of dropping it to undefined — otherwise the
  // validator window "forgets" its position across app restarts unless it was
  // open at shutdown.
  const prevSession = loadSession();
  const vBounds = safeBoundsForSave(validationWindow) || lastValidatorBounds || prevSession.validationWindow;
  if (vBounds) session.validationWindow = vBounds;
  const hBounds = safeBoundsForSave(helpWindow) || lastHelpBounds || prevSession.helpWindow;
  if (hBounds) session.helpWindow = hBounds;

  saveSession(session);
  sessionDirty = false;
}

// Alias for backward compatibility with close handler
function saveSessionWindowBounds() { saveFullSession(); }

// ─── Focus-based file change detection ──────────────────────────────
// Snapshot all .xml and .metadata file mtimes, then on window focus,
// compare and emit change events for anything that changed.

// Return the list of absolute layer directories we walk for mtime tracking and
// the file watcher. In suite mode this is base + each active expansion. In
// narrow mode it's DATA_ROOT itself. Used by both snapshotMtimes and the file
// watcher startup.
function getLayerScanDirs() {
  if (!currentLayout) return [];
  if (currentLayout.mode === 'suite') {
    // Per-expansion table root, NOT the expansion's top-level dirPath — the
    // latter may contain non-data noise (AssetBundles, QuickStarts2, etc.)
    // when an expansion uses the AIW2 nested layout where data sits under
    // `<dirPath>/GameData/Configuration/`.
    return [
      currentLayout.baseDir,
      ...(currentLayout.expansions || []).map((e) => e.tableRoot || e.dirPath),
      // Mods are scanned the same way as DLCs. tableRoot handles AIW2-style
      // mods that nest their tables under <modDir>/GameData/Configuration/;
      // HotM-style mods just use the mod's own dirPath.
      ...(currentLayout.mods || []).map((m) => m.tableRoot || m.dirPath),
    ];
  }
  return [currentLayout.baseDir];
}

// Mod directories at the *top* level (where ModDetails.xml / ModTranslation.xml /
// ModSortOrder.txt live), not their tableRoot. Used to expose mod-level files
// to the renderer and to keep the watcher aware of edits to them.
function getModTopLevelDirs() {
  if (!currentLayout || currentLayout.mode !== 'suite') return [];
  return (currentLayout.mods || []).map((m) => m.dirPath);
}

// Yield every (relPath, absPath) for an .xml or .metadata file under any layer
// dir, plus the top-level SharedMetaData.metadata in the base dir. Generator
// makes the calling code shorter without holding a multi-thousand-entry array.
function* iterateAllDataFiles() {
  if (!DATA_ROOT || !currentLayout) return;
  // SharedMetaData.metadata lives at the base dir's root.
  const sharedAbs = path.join(currentLayout.baseDir, 'SharedMetaData.metadata');
  if (fs.existsSync(sharedAbs)) {
    yield { rel: relFromRoot(sharedAbs), abs: sharedAbs };
  }
  for (const layerDir of getLayerScanDirs()) {
    let entries;
    try { entries = fs.readdirSync(layerDir, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const folderPath = path.join(layerDir, e.name);
      let files;
      try { files = fs.readdirSync(folderPath); }
      catch (err) { continue; }
      for (const f of files) {
        if (!f.endsWith('.xml') && !f.endsWith('.metadata')) continue;
        const abs = path.join(folderPath, f);
        yield { rel: relFromRoot(abs), abs };
      }
    }
  }
  // Island files (data + metadata) live outside the layer dirs — include them so
  // the focus-recheck detects external (e.g. Unity) edits to them.
  for (const abs of islandTrackedAbsPaths) {
    yield { rel: relFromRoot(abs), abs };
  }
}

function snapshotMtimes() {
  fileMtimes.clear();
  for (const { rel, abs } of iterateAllDataFiles()) {
    try { fileMtimes.set(rel, fs.statSync(abs).mtimeMs); } catch (_) {}
  }
}

function checkForChangedFiles() {
  if (!mainWindow || !DATA_ROOT) return;
  const changed = [];
  for (const { rel, abs } of iterateAllDataFiles()) {
    try {
      const mtime = fs.statSync(abs).mtimeMs;
      if (fileMtimes.get(rel) !== mtime) {
        changed.push(rel);
        fileMtimes.set(rel, mtime);
      }
    } catch (_) {}
  }

  // Emit change events for each changed file
  for (const relPath of changed) {
    const full = path.join(DATA_ROOT, relPath);
    if (recentSaves.has(full)) {
      recentSaves.delete(full);
      continue;
    }
    broadcastToAll('file-changed-on-disk', relPath);
    sourceControl.refreshFile(full);
  }
}

// ─── File Discovery ──────────────────────────────────────────────────

// Natural-order collator that mirrors Windows Explorer's filename sort —
// numbers compare as numbers (file2 < file10), and punctuation has a
// lower primary weight than letters (Contemplation_Ch2 < ContemplationZ_Beta,
// because the underscore is treated as a separator that comes before any
// letter, not as the high-ASCII codepoint that raw .sort() would compare).
// Locked to the 'en' locale so the result is platform-independent.
const _naturalCollator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'variant',
});

function relFromRoot(absPath) {
  if (!DATA_ROOT) return absPath;
  return path.relative(DATA_ROOT, absPath).replace(/\\/g, '/');
}

// Scan a single layer's "base directory" (Configuration or an expansion's
// folder) for table subfolders containing .xml files. Returns:
//   {
//     tables: [{ folderName, folderPath, metadataFile?, xmlFiles: [{name, path}] }],
//     stray: { metadataFiles: [{ folderName, file, path }] }
//   }
// In a base layer, .metadata files are expected and recorded on the table. In
// an expansion layer they are stray — recorded for structural-error reporting.
function scanLayerDirectory(layerDir) {
  const tables = [];
  const stray = { metadataFiles: [] };
  let entries;
  try { entries = fs.readdirSync(layerDir, { withFileTypes: true }); }
  catch (e) { return { tables, stray }; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

    const folderPath = path.join(layerDir, entry.name);
    let files;
    try { files = fs.readdirSync(folderPath); }
    catch (e) { continue; }

    const xmlFiles = files
      .filter((f) => f.endsWith('.xml'))
      .sort(_naturalCollator.compare)
      .map((f) => ({ name: f, path: path.join(folderPath, f) }));

    const metaFile = files.find((f) => f.endsWith('.metadata'));

    // Folders without any .xml AND no .metadata are typically asset bundles or
    // similar — skip silently (per spec: "non-XML folders are ignored").
    if (xmlFiles.length === 0 && !metaFile) continue;

    tables.push({
      folderName: entry.name,
      folderPath,
      metadataFile: metaFile || null,
      xmlFiles,
    });
    if (metaFile) {
      stray.metadataFiles.push({ folderName: entry.name, file: metaFile, path: path.join(folderPath, metaFile) });
    }
  }
  return { tables, stray };
}

// ─── Extra data sources ("islands") ──────────────────────────────────
//
// Self-contained data sources OUTSIDE GameData/Configuration. A file
// `_extraDataSources.txt` in the base (Configuration) dir lists directories,
// one per line, DATA_ROOT-relative. Each immediate subfolder of a listed dir
// that contains a `_<Name>.metadata` is an island: a standalone schema that
// does NOT merge with SharedMetaData and does NOT join the FK index. The
// island's metadata root may carry `is_from_yaml_extension="<ext>"`, meaning
// its data files are `<ext>` files (e.g. Unity .asset YAML) whose editable XML
// is embedded (escaped + YAML line-folded) in a top-level `xml:` field. Unity
// `.meta` sidecars are always ignored.

// Cheap read of a .metadata file's <root> attributes — discovery only needs
// node_name + is_from_yaml_extension, so we don't do a full parse here.
function readMetadataRootAttrs(absPath) {
  let text;
  try { text = fs.readFileSync(absPath, 'utf-8'); }
  catch (e) { return null; }
  // Strip comments first — the metadata's doc comment can contain a literal
  // `<root><motion_set>…` example that would otherwise match before the real
  // root element (which carries node_name / is_from_yaml_extension).
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  const m = text.match(/<root\b([^>]*)>/);
  if (!m) return { nodeName: '', embedExtension: null };
  const nn = m[1].match(/\bnode_name\s*=\s*"([^"]*)"/);
  const ye = m[1].match(/\bis_from_yaml_extension\s*=\s*"([^"]*)"/);
  return { nodeName: nn ? nn[1] : '', embedExtension: (ye && ye[1]) ? ye[1] : null };
}

// Discover island data sources. Returns { islands, errors }; errors are raw
// structural-error records for missing/unreadable listed directories.
function discoverExtraDataSources() {
  const islands = [];
  const errors = [];
  if (!DATA_ROOT || !currentLayout) return { islands, errors };

  const listFile = path.join(currentLayout.baseDir, '_extraDataSources.txt');
  let listText;
  try { listText = fs.readFileSync(listFile, 'utf-8'); }
  catch (e) { return { islands, errors }; } // no extra sources declared — fine

  const lines = listText.split(/\r\n?|\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // DATA_ROOT-relative; tolerate a leading "./" and a trailing slash.
    const rel = line.replace(/^\.\//, '').replace(/[/\\]+$/, '');
    const absDir = path.join(DATA_ROOT, rel);
    let stat = null;
    try { stat = fs.statSync(absDir); } catch (e) { /* missing */ }
    if (!stat || !stat.isDirectory()) {
      errors.push({ kind: 'extra-source-missing', dir: line, relPath: rel });
      continue;
    }

    let subEntries;
    try { subEntries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (e) { continue; }

    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const folderPath = path.join(absDir, sub.name);
      let files;
      try { files = fs.readdirSync(folderPath); }
      catch (e) { continue; }

      // Island iff a `_*.metadata` (NOT a Unity `*.metadata.meta`) is present.
      const metaFile = files.find((f) => f.endsWith('.metadata'));
      if (!metaFile) continue; // subfolder without a schema → ignored, per spec

      const metadataPath = path.join(folderPath, metaFile);
      const rootAttrs = readMetadataRootAttrs(metadataPath) || {};
      const embedExtension = rootAttrs.embedExtension; // e.g. "asset" or null

      // Data files: with an embed extension, match that extension; otherwise
      // plain `.xml`. Always exclude Unity `.meta` sidecars and the metadata.
      const dataFiles = [];
      for (const f of files) {
        if (f.endsWith('.meta') || f.endsWith('.metadata')) continue;
        const matches = embedExtension ? f.endsWith('.' + embedExtension) : f.endsWith('.xml');
        if (!matches) continue;
        const abs = path.join(folderPath, f);
        dataFiles.push({ name: f, path: abs, relativePath: relFromRoot(abs) });
      }
      dataFiles.sort((a, b) => _naturalCollator.compare(a.name, b.name));

      islands.push({
        name: sub.name,
        nodeName: rootAttrs.nodeName || '',
        folderPath,
        folderRelPath: relFromRoot(folderPath),
        metadataFile: metaFile,
        metadataPath,
        metadataRelPath: relFromRoot(metadataPath),
        embedExtension: embedExtension || null,
        files: dataFiles,
      });
    }
  }

  islands.sort((a, b) => _naturalCollator.compare(a.name, b.name));
  return { islands, errors };
}

// ─── Embedded-XML (Unity .asset YAML) decode ─────────────────────────
//
// The editable XML lives in a top-level double-quoted YAML scalar `xml: "..."`,
// heavily escaped (\" \n \\ ...) and line-folded across physical lines for
// width. We decode it for display; the outer YAML is left untouched (write-back
// / re-encode is a later milestone).

// Locate the `xml:` double-quoted scalar. Returns { start, end, raw } for the
// content BETWEEN the quotes (offsets into `text`, kept for future write-back),
// or null.
function findYamlXmlScalar(text) {
  const km = /(^|\n)[ \t]*xml:[ \t]*"/.exec(text);
  if (!km) return null;
  const open = km.index + km[0].length - 1; // the opening quote
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') break;
    i++;
  }
  if (i >= text.length) return null;
  return { start: open + 1, end: i, raw: text.slice(open + 1, i) };
}

// Un-wrap a YAML double-quoted scalar that was physically line-folded for width.
//
// Unity wraps such a scalar AT a content whitespace: it leaves the content
// indentation as TRAILING spaces (right after a \n escape), CONSUMES exactly one
// space as the physical break, and indents the continuation line with a fixed
// "wrap indent". To recover the original string value we, for each continuation
// physical line: strip its leading wrap-indent, keep the previous line's trailing
// content indent, and add back the single break space. This reconstructs the
// user's indentation faithfully (verified to restore clean, even indentation),
// rather than the spec's lossy "strip both sides + one space" which collapsed
// indentation to a single space at every wrap point.
//
// Content NEWLINES are `\n` escapes (literal backslash-n) — they are NOT physical
// breaks, so they survive untouched here and are decoded later by unescape. A
// single-line scalar (what AXE writes) has no physical breaks, so this returns it
// verbatim — making the AXE save→load round-trip exact.
function unfoldYamlFlowScalar(s) {
  const lines = s.split('\n');
  let out = lines[0];
  for (let k = 1; k < lines.length; k++) {
    const stripped = lines[k].replace(/^[ \t]+/, '');
    if (stripped === '') continue; // a truly blank physical line (shouldn't occur)
    out += ' ' + stripped;
  }
  return out;
}

// Process YAML double-quoted escape sequences.
function unescapeYamlDoubleQuoted(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (mm, g) => {
    if (g[0] === 'u' || g[0] === 'x') return String.fromCharCode(parseInt(g.slice(1), 16));
    switch (g) {
      case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
      case '"': return '"'; case '\\': return '\\'; case '/': return '/';
      case '0': return '\0'; case 'b': return '\b'; case 'f': return '\f';
      default: return g;
    }
  });
}

// Pretty-print element-only XML (no significant text nodes) with 2-space indent.
// The island XML is entirely tags + attributes, so collapsing inter-tag
// whitespace and re-indenting by depth is lossless for content — and it undoes
// the YAML folding's condensed indentation. Tag text (names + attributes) is
// preserved verbatim; any non-whitespace text node is kept attached so we never
// silently drop data.
function prettyPrintElementXml(xml) {
  const pieces = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[^>]+>/g;
  let m, lastIndex = 0;
  while ((m = re.exec(xml)) !== null) {
    const between = xml.slice(lastIndex, m.index);
    if (between.trim().length > 0) pieces.push({ type: 'text', s: between.trim() });
    pieces.push({ type: 'markup', s: m[0] });
    lastIndex = re.lastIndex;
  }
  const tail = xml.slice(lastIndex);
  if (tail.trim().length > 0) pieces.push({ type: 'text', s: tail.trim() });

  const out = [];
  let depth = 0;
  const indent = () => '  '.repeat(Math.max(0, depth));
  for (const p of pieces) {
    if (p.type === 'text') { out.push(indent() + p.s); continue; }
    const s = p.s;
    const isDeclOrComment = s.startsWith('<?') || s.startsWith('<!');
    const isClose = /^<\//.test(s);
    const isSelfClose = isDeclOrComment || /\/>$/.test(s);
    if (isClose) depth = Math.max(0, depth - 1);
    out.push(indent() + s);
    if (!isClose && !isSelfClose) depth++;
  }
  return out.join('\n') + '\n';
}

// Decode the embedded XML from a Unity-YAML island data file's raw text, or null
// if no `xml:` field is found. We faithfully reconstruct the stored string value
// — un-wrapping Unity's physical line folding and decoding escapes — WITHOUT any
// pretty-printing, so the user's own whitespace (newlines, indentation, condensed
// nodes) is what they see and edit. AXE-written single-line scalars decode
// exactly; Unity-folded scalars are un-wrapped to clean indentation.
function decodeEmbeddedXml(rawYaml) {
  const scalar = findYamlXmlScalar(rawYaml);
  if (!scalar) return null;
  return unescapeYamlDoubleQuoted(unfoldYamlFlowScalar(scalar.raw));
}

// Escape inner XML for embedding in a YAML double-quoted scalar as a SINGLE line
// (every newline becomes \n — no physical line folding, so the user's whitespace
// is preserved exactly with no condensing). Order matters: backslash first.
function escapeXmlForYamlScalar(xml) {
  return xml
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

// Re-encode edited inner XML back into a YAML island file's `xml:` scalar,
// preserving the rest of the file byte-for-byte. Returns the new file text, or
// null if the `xml:` field can't be located (caller must NOT write then).
function reencodeEmbeddedXml(rawYaml, innerXml) {
  const scalar = findYamlXmlScalar(rawYaml);
  if (!scalar) return null;
  return rawYaml.slice(0, scalar.start) + escapeXmlForYamlScalar(innerXml) + rawYaml.slice(scalar.end);
}

function discoverDataFolders() {
  // If no data root is resolved yet (e.g. config missing on first run or the
  // saved folder is unreachable), return an empty structure so the renderer
  // can still boot and present the "choose folder" UI via the status bar.
  if (!DATA_ROOT || !currentLayout) {
    islandEmbeddedAbsPaths = new Set();
    islandFolderDirs = [];
    islandTrackedAbsPaths = new Set();
    return { mode: 'narrow', folders: [], sharedMetadataPath: null, expansions: [], structuralErrors: [], islands: [] };
  }

  // SharedMetaData.metadata is always at the base directory's root.
  const sharedAbs = path.join(currentLayout.baseDir, 'SharedMetaData.metadata');
  const sharedExists = fs.existsSync(sharedAbs);

  // ── Schema ownership model ──
  //
  // Any layer can declare a table's schema by placing a `_<Folder>.metadata`
  // file inside the folder. The FIRST layer (in scan order: base, then DLCs
  // in DLC number order) that declares a given folder OWNS its schema. Other
  // layers that also have data for that folder just contribute XML files.
  //
  // HotM doesn't use this — every schema lives in base. AIW2 does: e.g.
  // ScourgeDifficulty exists only in 1_The_Spire_Rises and its metadata lives
  // there. Mods will follow the same pattern (mod-owned tables ship their
  // metadata in the mod folder).
  const folders = [];
  const folderByName = new Map();
  const structuralErrors = [];
  // Mod schema extensions: a mod's `_<TableName>.metadata` shipped for a
  // folder that an EARLIER layer (base / DLC / earlier mod) already owns.
  // Each entry contributes extra attributes / sub_nodes that apply when
  // validating files belonging to that mod (and any mod that requires it).
  // Recorded here as a flat list so the renderer can load + parse each
  // file's contents; composition happens at validation time.
  // Shape: { modLayer, folderName, metadataPath, metadataRelPath, metadataFile }
  const schemaExtensions = [];

  function registerLayerScan(layerScan, layerId, layerNum, expansionDirName) {
    for (const t of layerScan.tables) {
      let folder = folderByName.get(t.folderName);
      if (!folder) {
        folder = {
          name: t.folderName,
          path: t.folderPath,
          schemaLayer: t.metadataFile ? layerId : null,
          metadataFile: t.metadataFile || null,
          metadataPath: t.metadataFile ? path.join(t.folderPath, t.metadataFile) : null,
          metadataRelPath: t.metadataFile ? relFromRoot(path.join(t.folderPath, t.metadataFile)) : null,
          xmlFiles: [],
          layerFolderPaths: {},
        };
        folders.push(folder);
        folderByName.set(t.folderName, folder);
      } else if (t.metadataFile && !folder.metadataFile) {
        // Earlier layer registered the folder via XML only (no schema). This
        // layer brings the schema — adopt it.
        folder.schemaLayer = layerId;
        folder.metadataFile = t.metadataFile;
        folder.metadataPath = path.join(t.folderPath, t.metadataFile);
        folder.metadataRelPath = relFromRoot(folder.metadataPath);
      } else if (t.metadataFile && folder.metadataFile) {
        // Two layers ship a `.metadata` for the same folder. Three cases:
        //
        //   (a) Mod adding metadata on top of an existing base/DLC/earlier-
        //       mod schema → this is a schema EXTENSION (the mod adds extra
        //       attributes / sub_nodes that apply to its own files and to
        //       files in mods that require it). Record it as an extension;
        //       no warning.
        //
        //   (b) Two NON-mod layers (base + DLC, or DLC + DLC) both define
        //       the same table → that's an actual conflict the user should
        //       resolve. Surface a duplicate-schema warning.
        //
        // KNOWN LIMITATION: extensions can additively contribute attributes
        // / sub_nodes; they don't override existing ones if the keys collide.
        // For the purpose §32.5 cares about (mods declaring fields/sub-nodes
        // their DLL reads at runtime), additive is exactly right.
        const laterIsMod = String(layerId || '').startsWith('mod_');
        const earlierIsMod = String(folder.schemaLayer || '').startsWith('mod_');
        if (laterIsMod) {
          schemaExtensions.push({
            modLayer: layerId,
            folderName: t.folderName,
            metadataFile: t.metadataFile,
            metadataPath: path.join(t.folderPath, t.metadataFile),
            metadataRelPath: relFromRoot(path.join(t.folderPath, t.metadataFile)),
          });
        } else if (!earlierIsMod) {
          // Both non-mod and non-extension → real conflict.
          structuralErrors.push({
            kind: 'duplicate-schema',
            layer: layerId,
            layerNum,
            expansion: expansionDirName,
            folderName: t.folderName,
            ownedBy: folder.schemaLayer,
            duplicatePath: path.join(t.folderPath, t.metadataFile),
            relPath: relFromRoot(path.join(t.folderPath, t.metadataFile)),
            folderPath: t.folderPath,
          });
        }
      }
      folder.layerFolderPaths[layerId] = t.folderPath;
      for (const f of t.xmlFiles) {
        folder.xmlFiles.push({
          name: f.name,
          path: f.path,
          relativePath: relFromRoot(f.path),
          layer: layerId,
          layerNum,
        });
      }
    }
  }

  // ── Base layer (always present) ──
  const base = scanLayerDirectory(currentLayout.baseDir);
  registerLayerScan(base, 'base', 0, null);

  // ── Expansion layers ──
  for (const exp of (currentLayout.expansions || [])) {
    // Use the per-expansion tableRoot so AIW2-style nested layouts
    // (`<expansion>/GameData/Configuration/<TableName>/`) work alongside
    // HotM-style flat layouts (`<expansion>/<TableName>/`).
    const layerScan = scanLayerDirectory(exp.tableRoot || exp.dirPath);
    registerLayerScan(layerScan, exp.id, exp.num, exp.dirName);
  }

  // ── Mod layers ──
  //
  // Each active mod is a layer in the FK / validation pipeline, but the user-
  // facing tree treats mods as a separate axis (the MODS sidebar tab). The
  // file-content layering and cross-layer rules still flow through this
  // unified `folders` array — the renderer's Explorer/Schema tabs filter
  // mod-layer xmlFiles out of view, and the MODS tab regroups them by mod.
  //
  // Mods are deliberately given a layerNum well above any plausible DLC count
  // (1000+) so they sort AFTER all DLC files within a folder. Their exact
  // numeric value doesn't matter — Explorer never shows them, and the MODS
  // tab regroups by mod (using each xmlFile.layer == mod's layerId).
  const MOD_LAYER_NUM_BASE = 1000;
  (currentLayout.mods || []).forEach((mod, i) => {
    const layerScan = scanLayerDirectory(mod.tableRoot || mod.dirPath);
    registerLayerScan(layerScan, mod.layerId, MOD_LAYER_NUM_BASE + i, mod.dirName);
  });

  // ── Surface folders that have data but no schema in ANY layer ──
  // One notice per folder (not per XML file) so the validation pane doesn't
  // explode. This replaces the old "orphan-folder" error which assumed only
  // base could own schemas.
  for (const folder of folders) {
    if (folder.metadataFile) continue;
    if (folder.xmlFiles.length === 0) continue;
    // Find a representative folderPath — prefer the layer with the most files.
    const layerCounts = new Map();
    for (const f of folder.xmlFiles) {
      layerCounts.set(f.layer, (layerCounts.get(f.layer) || 0) + 1);
    }
    const layers = [...layerCounts.keys()];
    structuralErrors.push({
      kind: 'no-schema',
      folderName: folder.name,
      folderPath: folder.layerFolderPaths.base || folder.layerFolderPaths[layers[0]],
      xmlFileCount: folder.xmlFiles.length,
      contributingLayers: layers,
    });
  }

  // Sort xmlFiles within each folder: base alphabetical, then each DLC
  // alphabetical by layer number. Stable secondary sort by name within
  // each layer band.
  for (const folder of folders) {
    folder.xmlFiles.sort((a, b) => {
      if (a.layerNum !== b.layerNum) return a.layerNum - b.layerNum;
      return _naturalCollator.compare(a.name, b.name);
    });
  }

  // Sort folders by logical name (matches narrow-mode behavior).
  folders.sort((a, b) => _naturalCollator.compare(a.name, b.name));

  // ── Per-mod metadata for the MODS sidebar tab ──
  //
  // Files inside mod table folders are already in `folders` above, tagged
  // with the mod's layerId — the renderer's MODS tab regroups them by mod.
  // What lives here is the per-mod metadata (display name, color, deps) plus
  // the three mod-level files that don't belong to any table folder.
  const modsOut = [];
  for (const mod of (currentLayout.mods || [])) {
    const modLevelFiles = [];
    for (const f of getModLevelFilesForFormat(mod.format)) {
      const abs = path.join(mod.dirPath, f);
      if (fs.existsSync(abs)) {
        modLevelFiles.push({ name: f, path: abs, relativePath: relFromRoot(abs) });
      }
    }
    modsOut.push({
      layerId: mod.layerId,
      source: mod.source,
      sourceLabel: mod.sourceLabel,
      format: mod.format,
      dirName: mod.dirName,
      dirPath: mod.dirPath,
      relPath: relFromRoot(mod.dirPath),
      tableRootRelPath: relFromRoot(mod.tableRoot || mod.dirPath),
      displayName: mod.displayName,
      color: mod.color || null,
      author: mod.author || null,
      isFrameworkMod: !!mod.isFrameworkMod,
      requiredMods: mod.requiredMods || [],
      requiredExpansions: mod.requiredExpansions || [],
      publishedFileId: mod.publishedFileId || null,
      modLevelFiles,
    });
  }

  // ── Extra data sources ("islands") ──
  // Self-contained schemas + embedded-XML data files outside Configuration.
  // Their missing-dir problems ride the normal structuralErrors channel; their
  // embedded data-file absolute paths are cached so read-file can decode them.
  const { islands, errors: islandErrors } = discoverExtraDataSources();
  for (const e of islandErrors) structuralErrors.push(e);
  islandEmbeddedAbsPaths = new Set();
  islandFolderDirs = [];
  islandTrackedAbsPaths = new Set();
  for (const isl of islands) {
    if (isl.folderPath) islandFolderDirs.push(isl.folderPath);
    if (isl.metadataPath) islandTrackedAbsPaths.add(path.resolve(isl.metadataPath));
    for (const f of isl.files) {
      islandEmbeddedAbsPaths.add(path.resolve(f.path));
      islandTrackedAbsPaths.add(path.resolve(f.path));
    }
  }

  return {
    mode: currentLayout.mode,
    folders,
    sharedMetadataPath: sharedExists ? sharedAbs : null,
    sharedMetadataRelPath: sharedExists ? relFromRoot(sharedAbs) : null,
    expansions: (currentLayout.expansions || []).map((e) => ({
      id: e.id, num: e.num, dirName: e.dirName, dirPath: e.dirPath,
      relPath: relFromRoot(e.dirPath),
    })),
    mods: modsOut,
    schemaExtensions,
    structuralErrors,
    islands,
  };
}

// ─── File Operations (IPC Handlers) ──────────────────────────────────

ipcMain.handle('discover-data', () => {
  const result = discoverDataFolders();
  // Islands live outside the watched layer dirs. Make the watcher cover their
  // folders (so external/Unity edits to a `.asset` fire a change event), and
  // seed their mtimes so the focus-recheck has a baseline (no spurious reload
  // on first focus). Safe to call repeatedly — chokidar de-dupes added paths.
  try {
    if (watcher && islandFolderDirs.length) watcher.add(islandFolderDirs);
  } catch (_) {}
  for (const abs of islandTrackedAbsPaths) {
    try { fileMtimes.set(relFwd(abs), fs.statSync(abs).mtimeMs); } catch (_) {}
  }
  return result;
});

ipcMain.handle('read-file', async (_event, filePath) => {
  if (!path.isAbsolute(filePath) && !DATA_ROOT) {
    throw new Error('No data root configured');
  }
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(DATA_ROOT, filePath);

  // ── Island embedded-XML files (e.g. Unity .asset YAML) ──
  // Return the DECODED inner XML transparently so the renderer edits/displays it
  // as ordinary XML. The outer YAML is never rewritten here (no CRLF
  // canonicalization, no mtime write) — these are view-only this milestone and
  // the write-back round-trip is a later step.
  if (islandEmbeddedAbsPaths.has(path.resolve(fullPath))) {
    const rawYaml = fs.readFileSync(fullPath, 'utf-8');
    const decoded = decodeEmbeddedXml(rawYaml);
    // Fall back to the raw file if the `xml:` field can't be located, so the
    // user at least sees something rather than an error.
    return (decoded != null ? decoded : rawYaml).replace(/\r\n?|\n/g, '\n');
  }

  const raw = fs.readFileSync(fullPath, 'utf-8');

  // Canonicalize line endings on disk to CRLF when a data file has any
  // stray LF / CR / mixed endings — handles the "external tool wrote
  // with Unix line endings" case the user flagged. Limited to .xml and
  // .metadata so we don't accidentally rewrite user-managed text files
  // like the spelling dictionaries. The save path always emits CRLF
  // anyway, so this just gets non-AXE-touched files into the same shape
  // without requiring the user to save them.
  //
  // The /\r\n?|\n/ regex matches any line ending shape:
  //   \r\n → keep as \r\n (idempotent)
  //   \r alone → becomes \r\n (old-Mac style)
  //   \n alone → becomes \r\n (Unix style)
  // Tested against CRLF, LF, CR, and mixed-line-ending inputs.
  const isDataFile = fullPath.endsWith('.xml') || fullPath.endsWith('.metadata');
  if (isDataFile) {
    const canonical = raw.replace(/\r\n?|\n/g, '\r\n');
    if (canonical !== raw) {
      try {
        // Mark as self-save so the watcher's change event is silently
        // consumed (no broadcast → no reload bar) and the focus-check's
        // mtime diff doesn't re-fire afterwards.
        recentSaves.add(fullPath);
        lastSaveTime = Date.now();
        setTimeout(() => recentSaves.delete(fullPath), 3000);
        fs.writeFileSync(fullPath, canonical, 'utf-8');
        if (DATA_ROOT) {
          const relPath = path.relative(DATA_ROOT, fullPath).replace(/\\/g, '/');
          try { fileMtimes.set(relPath, fs.statSync(fullPath).mtimeMs); } catch (_) {}
        }
      } catch (e) {
        console.warn(`[read-file] failed to canonicalize line endings on disk: ${fullPath}`, e);
      }
    }
  }

  // Return LF-normalized content for in-memory use — CodeMirror uses LF
  // internally, and any stray CR would show up as a literal character
  // and produce false diffs in the change gutter.
  return raw.replace(/\r\n?|\n/g, '\n');
});

ipcMain.handle('write-file', async (_event, filePath, content) => {
  if (!path.isAbsolute(filePath) && !DATA_ROOT) {
    throw new Error('No data root configured');
  }
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(DATA_ROOT, filePath);

  // ── Island embedded-XML files (e.g. Unity .asset YAML) ──
  // `content` is the edited DECODED inner XML. Re-encode it into the existing
  // on-disk YAML's `xml:` scalar, preserving the rest of the file byte-for-byte.
  // No CRLF canonicalization (we keep the YAML's own line endings) and no
  // folding (newlines are escaped as \n), so the user's whitespace round-trips
  // exactly.
  if (islandEmbeddedAbsPaths.has(path.resolve(fullPath))) {
    let rawYaml;
    try { rawYaml = fs.readFileSync(fullPath, 'utf-8'); }
    catch (e) { throw new Error(`Island file could not be read for write: ${fullPath}`); }
    const newYaml = reencodeEmbeddedXml(rawYaml, content);
    if (newYaml == null) {
      // Don't clobber a file whose xml: field we can't locate.
      throw new Error(`Could not locate the xml: field to write into: ${fullPath}`);
    }
    recentSaves.add(fullPath);
    lastSaveTime = Date.now();
    setTimeout(() => recentSaves.delete(fullPath), 3000);
    fs.writeFileSync(fullPath, newYaml, 'utf-8');
    const relPathI = relFwd(fullPath);
    try { fileMtimes.set(relPathI, fs.statSync(fullPath).mtimeMs); } catch (_) {}
    sourceControl.refreshFile(fullPath);
    return true;
  }

  // Mark as self-save so watcher and focus-check ignore
  recentSaves.add(fullPath);
  lastSaveTime = Date.now();
  setTimeout(() => recentSaves.delete(fullPath), 3000);

  // Canonicalize to CRLF, robust to whatever combination of CR/LF is
  // in the in-memory content. CodeMirror normally emits LF, but a stray
  // CR or already-CRLF segment (e.g. from a paste buffer with mixed
  // endings) used to be mishandled by the previous /\n/g → '\r\n'
  // regex, which would turn an existing \r\n into \r\r\n. The current
  // pattern matches any line-ending shape and rewrites it idempotently.
  const output = content.replace(/\r\n?|\n/g, '\r\n');
  fs.writeFileSync(fullPath, output, 'utf-8');

  // Update mtime snapshot so focus-check doesn't re-detect our own save.
  // Forward-slash form to match snapshotMtimes (which keys by "name/file").
  const relPath = relFwd(fullPath);
  try { fileMtimes.set(relPath, fs.statSync(fullPath).mtimeMs); } catch (_) {}

  // Refresh the file's VCS status (if an active source-control provider
  // is connected). Fire-and-forget — callers don't block on it.
  sourceControl.refreshFile(fullPath);

  return true;
});

ipcMain.handle('load-session', () => {
  return loadSession();
});

ipcMain.handle('save-session', (_event, data) => {
  saveSession(data);
});

// Return the current favorites list. Used by detached windows when they need
// to read favorites for a context menu — they don't own the state, the main
// window pushes mutations through `update-favorites` and main rebroadcasts.
ipcMain.handle('get-favorites', () => {
  return Array.isArray(windowLevelState.favorites) ? windowLevelState.favorites : [];
});

// ─── Central file state registry IPC ─────────────────────────────────
// Sync read — renderer blocks until value is returned
ipcMain.on('get-file-state', (event, relativePath) => {
  event.returnValue = fileStateRegistry.get(relativePath) || null;
});

// Fire-and-forget update — merges into in-memory registry, no disk write
ipcMain.on('set-file-state', (_event, relativePath, data) => {
  const existing = fileStateRegistry.get(relativePath) || {};
  const merged = { ...existing, ...data };
  // Nested merge for refPanel so partial updates don't wipe scroll position
  if (data.refPanel && existing.refPanel && data.refPanel !== null) {
    merged.refPanel = { ...existing.refPanel, ...data.refPanel };
  }
  fileStateRegistry.set(relativePath, merged);
  sessionDirty = true;
});

// Update detached window's active tab in registry
ipcMain.on('set-detached-active-tab', (event, index) => {
  const id = getWindowIdForWebContents(event.sender);
  if (!id || id === 'main') return;
  const entry = windowRegistry.get(id);
  if (entry) {
    entry.activeTab = index;
    sessionDirty = true;
  }
});

// Sync save of window-level state (tabs, sidebar, theme, etc.)
ipcMain.on('save-window-state', (event, data) => {
  Object.assign(windowLevelState, data);
  sessionDirty = true;
  event.returnValue = true;
});

ipcMain.handle('show-in-folder', (_event, filePath) => {
  const fullPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(DATA_ROOT, filePath);
  shell.showItemInFolder(fullPath);
});

ipcMain.handle('rename-file', async (_event, oldPath, newPath) => {
  const fullOld = path.isAbsolute(oldPath)
    ? oldPath
    : path.join(DATA_ROOT, oldPath);
  const fullNew = path.isAbsolute(newPath)
    ? newPath
    : path.join(DATA_ROOT, newPath);
  fs.renameSync(fullOld, fullNew);
  return true;
});

// Resolve a logical (folder, layer) pair to the on-disk directory for that
// layer. base → the layer's base dir; dlcN → the expansion's directory;
// mod_<src>_<dir> → the mod's tableRoot. Used by create-folder and
// create-xml-file when the renderer wants to create a file in a specific
// layer. The folder may not yet exist on disk inside the chosen layer
// (typical for "first file added to <table> in DLC1" or "first file in a
// new mod-owned table").
function resolveLayerFolderPath(folderName, layerId) {
  if (!currentLayout) throw new Error('No data layout');
  if (!layerId || layerId === 'base') {
    return path.join(currentLayout.baseDir, folderName);
  }
  if (/^dlc\d+$/.test(layerId)) {
    const exp = (currentLayout.expansions || []).find((e) => e.id === layerId);
    if (!exp) throw new Error(`Unknown expansion layer: ${layerId}`);
    // Use tableRoot, not dirPath — AIW2-style nested layouts put table folders
    // under `<dirPath>/GameData/Configuration/`, not directly under dirPath.
    return path.join(exp.tableRoot || exp.dirPath, folderName);
  }
  if (layerId.startsWith('mod_')) {
    const mod = (currentLayout.mods || []).find((m) => m.layerId === layerId);
    if (!mod) throw new Error(`Unknown mod layer: ${layerId}`);
    return path.join(mod.tableRoot || mod.dirPath, folderName);
  }
  throw new Error(`Unrecognized layer id: ${layerId}`);
}

ipcMain.handle('create-folder', async (_event, folderName, opts) => {
  // Schema-owning folder. By default this lives at the base layer; an
  // explicit layerId in opts (e.g. { layerId: 'mod_x_HackBeGone' }) targets
  // that layer instead — used by the MODS sidebar when a mod introduces a
  // new mod-owned table.
  //
  // `extensionOnly: true` — for the "create partial schema for this mod"
  // action on a folder that already exists (because the mod ships data
  // there). Creates only the metadata file, no node_name attribute, so the
  // discovery pass treats it as a schema EXTENSION (§32.9) rather than a
  // new table definition. The folder already exists in this case; mkdir
  // is still safe (recursive). The metadata is intentionally minimal so
  // the user can append their mod-specific <attribute> / <sub_node>
  // declarations.
  if (!currentLayout) throw new Error('No data layout');
  const layerId = opts && opts.layerId ? opts.layerId : 'base';
  const extensionOnly = !!(opts && opts.extensionOnly);
  const folderPath = resolveLayerFolderPath(folderName, layerId);
  fs.mkdirSync(folderPath, { recursive: true });

  // Create empty metadata file following naming convention
  // Strip numeric prefix: "1_ActorStatus" → "ActorStatus" → "_ActorStatus.metadata"
  const baseName = folderName.replace(/^\d+_/, '');
  const metaName = `_${baseName}.metadata`;
  const metaPath = path.join(folderPath, metaName);
  if (!fs.existsSync(metaPath)) {
    const metaContent = extensionOnly
      // Extension shell: no node_name (the owning layer already declared
      // it). The leading comment explains what this file is for so a
      // future reader doesn't mistake it for a half-written normal schema.
      ? `<?xml version="1.0" encoding="utf-8"?>
<!-- Schema EXTENSION for the ${folderName} table, scoped to this mod.
     Add <attribute key="..." type="..."/> and <sub_node id="...">...</sub_node>
     entries for the extra fields / sub-nodes this mod's DLL reads at
     runtime. They'll merge into the base schema only for files in this mod
     (and in mods that require it). See design.md §32.9. -->
<root>
</root>
`
      : '<?xml version="1.0" encoding="utf-8"?>\n<root node_name="">\n</root>\n';
    fs.writeFileSync(metaPath, metaContent, 'utf-8');
  }

  return { folderPath, metadataFile: metaName, metadataPath: metaPath };
});

// Create a new XML file in the given logical folder under the chosen layer.
// `layerId` is 'base' (default) or 'dlc<N>'. The target subfolder is created
// inside the layer dir if it doesn't exist yet — common for "first file added
// to <table> inside DLC1". Refuses if the file already exists. Populates with
// a minimal XML declaration + <root> element so the file is valid from start.
ipcMain.handle('create-xml-file', async (_event, folderName, fileName, layerId) => {
  if (!DATA_ROOT) throw new Error('No data root configured');
  if (!folderName || !fileName) throw new Error('Folder and file name required');
  const safeFileName = fileName.endsWith('.xml') ? fileName : `${fileName}.xml`;
  const folderPath = resolveLayerFolderPath(folderName, layerId);
  const fullPath = path.join(folderPath, safeFileName);
  fs.mkdirSync(folderPath, { recursive: true });
  if (fs.existsSync(fullPath)) throw new Error('A file with that name already exists.');
  const template = '<?xml version="1.0" encoding="utf-8"?>\r\n<root>\r\n</root>\r\n';
  fs.writeFileSync(fullPath, template, 'utf-8');
  return { path: fullPath, relativePath: relFromRoot(fullPath) };
});

// Window controls for frameless window
// Window controls — work for any window (main or detached)
ipcMain.handle('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});
ipcMain.handle('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
});
ipcMain.handle('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// Multi-window IPC handlers
ipcMain.handle('get-window-info', (event) => {
  const id = getWindowIdForWebContents(event.sender);
  return { windowId: id, mode: id === 'main' ? 'main' : 'detached' };
});

// First (registry-order) non-minimized window whose bounds contain the point.
// Electron doesn't expose true OS z-order, so overlapping windows fall back to
// registry order rather than guessing — but half-open bounds and skipping
// minimized/destroyed windows fix the concrete mis-routes (shared edges
// double-claiming, minimized windows stealing the drop). We deliberately do NOT
// prefer the focused window: during a tear-off drag the SOURCE window is the
// focused one, so preferring it would mis-route a drop back onto the source.
function findWindowEntryAt(screenX, screenY) {
  for (const [id, entry] of windowRegistry) {
    const win = entry.browserWindow;
    if (!win || win.isDestroyed() || win.isMinimized()) continue;
    const b = win.getBounds();
    if (screenX >= b.x && screenX < b.x + b.width && screenY >= b.y && screenY < b.y + b.height) {
      return { id, entry };
    }
  }
  return null;
}

ipcMain.handle('detach-tab-at-position', async (_event, relativePath, screenX, screenY, buffer) => {
  // `buffer` (optional) carries the source window's in-memory { content, saved }
  // for this tab, so an unsaved edit moves with it instead of the target
  // re-reading stale content from disk (lossless tear-off).
  const seed = buffer && typeof buffer.content === 'string' ? buffer : null;
  // Drop onto the topmost window under the cursor, if any.
  const hit = findWindowEntryAt(screenX, screenY);
  if (hit) {
    const { id, entry } = hit;
    // Move tab to it
    if (!entry.tabs.includes(relativePath)) {
      entry.tabs.push(relativePath);
      entry.browserWindow.webContents.send('tab-added', relativePath, seed);
    }
    // Remove from source window(s)
    for (const [srcId, srcEntry] of windowRegistry) {
      if (srcId === id) continue;
      const idx = srcEntry.tabs.indexOf(relativePath);
      if (idx >= 0) {
        srcEntry.tabs.splice(idx, 1);
        if (srcEntry.browserWindow && !srcEntry.browserWindow.isDestroyed()) {
          srcEntry.browserWindow.webContents.send('tab-removed', relativePath);
        }
      }
    }
    entry.browserWindow.focus();
    return { action: 'moved', targetWindowId: id };
  }

  // Not on any window — create a new detached window
  const windowId = 'det_' + (++detachedCounter);
  // Remove from source window
  for (const [srcId, srcEntry] of windowRegistry) {
    const idx = srcEntry.tabs.indexOf(relativePath);
    if (idx >= 0) {
      srcEntry.tabs.splice(idx, 1);
      if (srcEntry.browserWindow && !srcEntry.browserWindow.isDestroyed()) {
        srcEntry.browserWindow.webContents.send('tab-removed', relativePath);
      }
    }
  }
  createDetachedWindow(windowId, [relativePath], screenX - 100, screenY - 30);
  // Stash the in-memory buffer so the new window seeds from it (via
  // get-detached-session) instead of re-reading disk — one-shot, never persisted.
  if (seed) {
    const newEntry = windowRegistry.get(windowId);
    if (newEntry) newEntry.seedBuffers = { [relativePath]: seed };
  }
  return { action: 'created', windowId };
});

ipcMain.handle('register-window-tabs', (event, tabs) => {
  const id = getWindowIdForWebContents(event.sender);
  if (id) {
    const entry = windowRegistry.get(id);
    if (entry) {
      entry.tabs = tabs;
      // Mark dirty so the periodic save (every 30s) catches detached tab
      // changes. Without this, a detached window's tab edits are only
      // persisted when something ELSE marks dirty (e.g. main window state
      // change) — and if the user closes the detached window before that,
      // its tabs are lost on the next launch.
      sessionDirty = true;
    }
  }
});

// Push the union of every live window's active file to the main window, so its
// sidebar can highlight the tab that's "facing the user" in EACH open window
// (main + every detached), not just its own.
function broadcastActiveFiles() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const files = [];
  for (const entry of windowRegistry.values()) {
    if (entry.activeFile) files.push(entry.activeFile);
  }
  mainWindow.webContents.send('active-files-changed', [...new Set(files)]);
}

// A window reports its currently-active file. Stored per-window (so a detached
// window's focus can re-select it) and as the global most-recent target.
ipcMain.on('report-active-file', (event, relativePath) => {
  const id = getWindowIdForWebContents(event.sender);
  if (id) {
    const entry = windowRegistry.get(id);
    if (entry) entry.activeFile = relativePath;
  }
  if (relativePath) lastActiveFileGlobal = relativePath;
  broadcastActiveFiles();
});

// The set of all live windows' active files (for the main sidebar's highlight).
ipcMain.handle('get-active-files', () => {
  const files = [];
  for (const entry of windowRegistry.values()) {
    if (entry.activeFile) files.push(entry.activeFile);
  }
  return [...new Set(files)];
});

// The file the main window's sidebar should center on when its filter clears.
ipcMain.handle('get-center-target', () => {
  return lastActiveFileGlobal || windowRegistry.get('main')?.activeFile || null;
});

ipcMain.handle('focus-sidebar-on-file', (_event, relativePath, opts) => {
  // opts is optional: { highlight } — a detached window's deliberate "Center
  // sidebar on this" passes highlight:true to flash the row; the passive sync
  // on detached tab-switch / editor click passes nothing (no flash). The main
  // window picks the right sidebar tab from the file's layer either way.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('focus-sidebar-on-file', relativePath, opts);
  }
});

// Sent from any window to mutate the main window's favorites state. The
// main window is the single owner — it persists via its existing
// saveWindowState push. Also mirror the new value into windowLevelState
// directly so `get-favorites` from a detached window between the main
// window's state update and its next saveWindowState debounce returns
// the up-to-date list.
ipcMain.handle('update-favorites', (_event, favorites) => {
  if (Array.isArray(favorites)) windowLevelState.favorites = favorites;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-favorites', favorites);
  }
});

ipcMain.handle('find-window-for-tab', (_event, relativePath) => {
  const windowId = findWindowForTab(relativePath);
  if (windowId) {
    const entry = windowRegistry.get(windowId);
    if (entry?.browserWindow && !entry.browserWindow.isDestroyed()) {
      entry.browserWindow.webContents.send('focus-tab', relativePath);
      entry.browserWindow.focus();
      return { found: true, windowId };
    }
  }
  return { found: false };
});

// Returns the current display number (1..N) for the calling detached
// window. Used by TitleBar.jsx on mount; subsequent changes arrive via
// the `detached-display-num` broadcast.
ipcMain.handle('get-detached-display-num', (event) => {
  const id = getWindowIdForWebContents(event.sender);
  if (!id) return null;
  const entry = windowRegistry.get(id);
  return entry?.displayNum ?? null;
});

ipcMain.handle('get-detached-session', (event) => {
  const id = getWindowIdForWebContents(event.sender);
  if (!id) return null;
  // First check the live registry (for newly created windows)
  const entry = windowRegistry.get(id);
  // Then check saved session (for restored windows)
  const session = loadSession();
  const saved = session.detachedWindows?.find(d => d.windowId === id);
  // One-shot seed buffers from a lossless tear-off into a NEW window: hand them
  // to the renderer once, then drop them so they never persist or re-seed.
  const seedBuffers = entry?.seedBuffers || null;
  if (entry && entry.seedBuffers) delete entry.seedBuffers;
  // Per-tab data is in the central file state registry, not here
  return {
    windowId: id,
    tabs: entry?.tabs || saved?.tabs || [],
    activeTab: saved?.activeTab ?? 0,
    seedBuffers,
  };
});

ipcMain.handle('open-validation-window', () => {
  createValidationWindow();
});

ipcMain.handle('open-help-window', () => {
  createHelpWindow();
});

// Relay validation-results from main window to validation window
let lastValidationResults = [];
ipcMain.on('validation-results', (_event, results) => {
  lastValidationResults = results || [];
  if (validationWindow && !validationWindow.isDestroyed()) {
    validationWindow.webContents.send('validation-results', lastValidationResults);
  }
});

// Validation window requests current results on load
ipcMain.handle('get-validation-results', () => {
  return lastValidationResults;
});

// Suggestion bridge: validation window asks main, main asks main renderer,
// main renderer replies via IPC, main returns the result.
const pendingSuggestRequests = new Map(); // requestId → { resolve, timeout }
let nextSuggestRequestId = 1;

ipcMain.handle('get-suggestions', async (_event, word) => {
  if (!word || !mainWindow || mainWindow.isDestroyed()) return [];
  const requestId = nextSuggestRequestId++;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingSuggestRequests.delete(requestId);
      resolve([]);
    }, 5000);
    pendingSuggestRequests.set(requestId, { resolve, timeout });
    mainWindow.webContents.send('compute-suggestions', requestId, word);
  });
});

ipcMain.on('suggestions-computed', (_event, requestId, suggestions) => {
  const pending = pendingSuggestRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingSuggestRequests.delete(requestId);
  pending.resolve(suggestions || []);
});

// Relay navigate-to-line — find which window has the file, or send to main
ipcMain.on('navigate-to-line', (_event, file, line, highlight, absPos) => {
  const windowId = findWindowForTab(file);
  if (windowId) {
    const entry = windowRegistry.get(windowId);
    if (entry?.browserWindow && !entry.browserWindow.isDestroyed()) {
      entry.browserWindow.webContents.send('navigate-to-line', file, line, highlight, absPos);
      entry.browserWindow.focus();
      return;
    }
  }
  // Default to main window (it will open the file)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('navigate-to-line', file, line, highlight, absPos);
    mainWindow.focus();
  }
});

// Relay revalidate request from validation window to main window
ipcMain.on('request-revalidate', () => {
  if (mainWindow) {
    mainWindow.webContents.send('request-revalidate');
  }
});

ipcMain.on('request-grammar-check', () => {
  if (mainWindow) {
    mainWindow.webContents.send('request-grammar-check');
  }
});

ipcMain.on('request-spelling-check', () => {
  if (mainWindow) {
    mainWindow.webContents.send('request-spelling-check');
  }
});

ipcMain.on('request-grammar-settings', () => {
  if (mainWindow) {
    mainWindow.webContents.send('request-grammar-settings');
  }
});

ipcMain.on('request-grammar-dismiss', (_event, textHash, fingerprint) => {
  if (mainWindow) {
    mainWindow.webContents.send('request-grammar-dismiss', textHash, fingerprint);
  }
});

ipcMain.on('request-grammar-resolve', (_event, textHash, fingerprint) => {
  if (mainWindow) {
    mainWindow.webContents.send('request-grammar-resolve', textHash, fingerprint);
  }
});

// Forward a buffered log message from renderer to main-process stdout (terminal)
ipcMain.on('log-to-terminal', (_event, message) => {
  process.stdout.write(message + '\n');
});

// Open global search in main window (from detached windows)
ipcMain.on('open-global-search', (_event, query, replace, currentFile) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-global-search', query, replace, currentFile);
    mainWindow.focus();
  }
});

// Relay replace requests from validation window to main window
ipcMain.on('request-replace', (_event, file, oldText, newText) => {
  broadcastToAll('request-replace', file, oldText, newText);
});
ipcMain.on('request-replace-all', (_event, oldText, newText) => {
  broadcastToAll('request-replace-all', oldText, newText);
});
ipcMain.on('request-ignore-node', (_event, file, absPos) => {
  broadcastToAll('request-ignore-node', file, absPos);
});

// Relay theme changes to validation window
// ─── Source-Control / Plugins IPC ───────────────────────────────────

ipcMain.handle('plugins-get-all', () => {
  return sourceControl.getPluginsSnapshot();
});

ipcMain.handle('sc-get-active', () => {
  return sourceControl.getActiveSnapshot();
});

ipcMain.handle('sc-get-status', (_event, scope, absPath) => {
  return sourceControl.getStatusSnapshot(scope, absPath);
});

ipcMain.handle('sc-get-folder-rollup', (_event, absFolderPath) => {
  return sourceControl.getFolderRollup(absFolderPath);
});

ipcMain.handle('sc-get-commands', (_event, scope, absPath) => {
  return sourceControl.getCommands(scope, absPath);
});

ipcMain.handle('sc-run-command', async (_event, commandId, absPath) => {
  return sourceControl.runCommand(commandId, absPath);
});

ipcMain.handle('sc-refresh', async (_event, scope) => {
  if (scope === 'repo') await sourceControl.refreshRepoStatus();
  else if (scope === 'data') await sourceControl.refreshDataStatus();
  else {
    await sourceControl.refreshDataStatus();
    await sourceControl.refreshRepoStatus();
  }
  return true;
});

ipcMain.handle('sc-redetect', async () => {
  tsvnCache.invalidate();
  tgitCache.invalidate();
  // Explicit user-driven re-detect should also blow away the tool-path
  // cache in case the user just installed TortoiseGit/SVN/Git and wants
  // AXE to notice without a full restart.
  try { require('./toolDiscovery').clearCaches(); } catch (_) {}
  await sourceControl.detectAll();
  return sourceControl.getPluginsSnapshot();
});

/**
 * Map a path the renderer holds (relative to DATA_ROOT, or already absolute)
 * to an absolute filesystem path the provider can use. Kept internal to
 * simplify the renderer-side surface.
 */
function toAbsPath(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  if (!DATA_ROOT) return null;
  return path.join(DATA_ROOT, p);
}

ipcMain.handle('sc-abs-path', (_event, relPath) => {
  return toAbsPath(relPath);
});

// Fetch the VCS base (HEAD for git, BASE for svn) content of a file.
// Returns null when the active provider has no base version for it — the
// renderer treats null as "no VCS gutter layer for this file."
ipcMain.handle('sc-get-base-content', async (_event, pathArg) => {
  const abs = toAbsPath(pathArg);
  if (!abs) return null;
  try {
    const content = await sourceControl.getBaseContent(abs);
    if (content == null) return null;
    // Normalize line endings to match what the renderer sees for the
    // live file (read-file handler strips CRLF → LF). Without this,
    // every CRLF-only file would diff as "every line changed."
    return content.replace(/\r\n/g, '\n');
  } catch (_) {
    return null;
  }
});

ipcMain.on('theme-change', (_event, theme) => {
  if (validationWindow) {
    validationWindow.webContents.send('theme-change', theme);
  }
});

// Relay editor scale changes to all windows
ipcMain.on('editor-scale-change', (_event, scale) => {
  broadcastToAll('editor-scale-change', scale);
});

ipcMain.on('ref-panel-scale-change', (_event, scale) => {
  broadcastToAll('ref-panel-scale-change', scale);
});



// ─── Spelling Dictionary IPC ────────────────────────────────────────

ipcMain.handle('load-spelling-dictionary', () => {
  if (!DATA_ROOT) return { aff: null, dic: null, custom: [], devCustom: [] };
  try {
    const affPath = path.resolve(path.join(__dirname, '..', '..', 'node_modules', 'dictionary-en', 'index.aff'));
    const dicPath = path.resolve(path.join(__dirname, '..', '..', 'node_modules', 'dictionary-en', 'index.dic'));
    const aff = fs.readFileSync(affPath);
    const dic = fs.readFileSync(dicPath);

    const readList = (filename) => {
      const p = path.join(DATA_HOME, filename);
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf-8')
        .split(/\r?\n/)
        .filter((w) => w.trim().length > 0);
    };
    const custom = readList('_spellingDictionary.txt');       // user-facing dictionary
    const devCustom = readList('_spellingDevDictionary.txt'); // dev-only dictionary (applies only in dev contexts)

    // Return as UTF-8 strings — nspell accepts string or Buffer
    return { aff: aff.toString('utf-8'), dic: dic.toString('utf-8'), custom, devCustom };
  } catch (e) {
    console.error('Failed to load spelling dictionary:', e.message);
    return { aff: null, dic: null, custom: [], devCustom: [] };
  }
});

ipcMain.handle('add-to-dictionary', (_event, word) => {
  if (!DATA_ROOT || !word) return false;
  try {
    const customPath = path.join(DATA_HOME, '_spellingDictionary.txt');
    // Read existing to avoid duplicates
    let existing = [];
    if (fs.existsSync(customPath)) {
      existing = fs.readFileSync(customPath, 'utf-8')
        .split(/\r?\n/)
        .filter((w) => w.trim().length > 0);
    }
    if (!existing.includes(word)) {
      // Insert alphabetically (case-insensitive sort)
      existing.push(word);
      existing.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      fs.writeFileSync(customPath, existing.join('\n') + '\n', 'utf-8');
    }
    // Notify the main window so it can filter its validationErrors state
    broadcastToAll('dictionary-word-added', word);
    // Also trigger a full dictionary reload — the file watcher's 'change' event
    // would normally do this, but if the file was just created (no prior file)
    // chokidar fires 'add' not 'change', and on 'change' there's a 300ms
    // stability threshold. Broadcast directly so the renderer + workers update
    // immediately.
    broadcastToAll('dictionary-changed');
    return true;
  } catch (e) {
    console.error('Failed to add word to dictionary:', e.message);
    return false;
  }
});

ipcMain.handle('remove-from-dictionary', (_event, word) => {
  if (!DATA_ROOT || !word) return false;
  try {
    const customPath = path.join(DATA_HOME, '_spellingDictionary.txt');
    if (!fs.existsSync(customPath)) return false;
    let existing = fs.readFileSync(customPath, 'utf-8')
      .split(/\r?\n/)
      .filter((w) => w.trim().length > 0);
    const idx = existing.indexOf(word);
    if (idx < 0) return false;
    existing.splice(idx, 1);
    fs.writeFileSync(customPath, existing.join('\n') + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to remove word from dictionary:', e.message);
    return false;
  }
});

// Dev-only dictionary — same shape as the main dictionary, but the words only
// apply in developer contexts (internal_notes, tooltips, *translation_notes*,
// is_localized="false" overrides, and nodes with skip_all_localization_on_node).
ipcMain.handle('add-to-dev-dictionary', (_event, word) => {
  if (!DATA_ROOT || !word) return false;
  try {
    const customPath = path.join(DATA_HOME, '_spellingDevDictionary.txt');
    let existing = [];
    if (fs.existsSync(customPath)) {
      existing = fs.readFileSync(customPath, 'utf-8')
        .split(/\r?\n/)
        .filter((w) => w.trim().length > 0);
    }
    if (!existing.includes(word)) {
      existing.push(word);
      existing.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      fs.writeFileSync(customPath, existing.join('\n') + '\n', 'utf-8');
    }
    broadcastToAll('dev-dictionary-word-added', word);
    // See comment in add-to-dictionary — direct broadcast covers the case where
    // the dev dictionary file didn't exist yet (chokidar 'add' vs 'change').
    broadcastToAll('dictionary-changed');
    return true;
  } catch (e) {
    console.error('Failed to add word to dev dictionary:', e.message);
    return false;
  }
});

ipcMain.handle('remove-from-dev-dictionary', (_event, word) => {
  if (!DATA_ROOT || !word) return false;
  try {
    const customPath = path.join(DATA_HOME, '_spellingDevDictionary.txt');
    if (!fs.existsSync(customPath)) return false;
    let existing = fs.readFileSync(customPath, 'utf-8')
      .split(/\r?\n/)
      .filter((w) => w.trim().length > 0);
    const idx = existing.indexOf(word);
    if (idx < 0) return false;
    existing.splice(idx, 1);
    fs.writeFileSync(customPath, existing.join('\n') + '\n', 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to remove word from dev dictionary:', e.message);
    return false;
  }
});

// ─── Grammar LLM IPC ───────────────────────────────────────────────
//
// Settings + cache + API calls all live in main so the API key never crosses
// into the renderer's web context. The renderer sees only opaque results.

ipcMain.handle('grammar-llm-load-settings', () => {
  return grammarLLM.loadSettings(getSettingsDir());
});

ipcMain.handle('grammar-llm-save-settings', (_event, settings) => {
  return grammarLLM.saveSettings(getSettingsDir(), settings || {});
});

ipcMain.handle('grammar-llm-supported-models', () => {
  return {
    models: grammarLLM.SUPPORTED_MODELS,
    defaultModel: grammarLLM.DEFAULT_MODEL,
  };
});

ipcMain.handle('grammar-llm-test-api', async (_event, settings) => {
  const s = settings || grammarLLM.loadSettings(getSettingsDir());
  return grammarLLM.testApi({ apiKey: s.apiKey, model: s.model });
});

ipcMain.handle('grammar-llm-load-cache', () => {
  if (!DATA_HOME) return {};
  return grammarLLM.loadCache(DATA_HOME);
});

// Save the WHOLE cache (renderer manages merge logic so this is just a write).
ipcMain.handle('grammar-llm-save-cache', (_event, cache) => {
  if (!DATA_HOME) return false;
  return grammarLLM.saveCache(DATA_HOME, cache || {});
});

// Hash helper for the renderer — keeps the same SHA-256 implementation
// as the cache uses, so cache keys match across both sides without each
// side needing its own crypto dependency.
ipcMain.handle('grammar-llm-hash', (_event, text) => {
  return grammarLLM.sha256(typeof text === 'string' ? text : '');
});

// Run a grammar check on a list of items. Items are { id, text }; the renderer
// is expected to have already deduped against the cache, so this is purely an
// API-call entry point. Returns { results: { [id]: errors[] }, error?: string }.
ipcMain.handle('grammar-llm-check-batch', async (_event, items) => {
  const settings = grammarLLM.loadSettings(getSettingsDir());
  if (!settings.enabled) return { results: {}, error: 'Grammar LLM is not enabled.' };
  if (!settings.apiKey) return { results: {}, error: 'No API key configured.' };
  if (!Array.isArray(items) || items.length === 0) return { results: {} };
  try {
    const map = await grammarLLM.checkBatch({
      apiKey: settings.apiKey,
      model: settings.model,
      items,
    });
    const results = {};
    for (const [id, errors] of map.entries()) results[id] = errors;
    return { results };
  } catch (e) {
    return { results: {}, error: e.message || String(e) };
  }
});

ipcMain.handle('get-data-root', () => {
  return DATA_ROOT;
});

ipcMain.handle('get-recent-data-roots', () => {
  return loadRecentDataRoots();
});

// Remove one entry from the recent-roots list (does not delete the folder).
// Returns the updated list.
ipcMain.handle('remove-recent-data-root', (e, root) => {
  return removeFromRecentDataRoots(root);
});

// Window-title project name for the CURRENT root, and per-root nickname editing.
ipcMain.handle('get-project-name', () => computeProjectName(DATA_ROOT));
ipcMain.handle('get-root-nicknames', () => loadNicknames());
ipcMain.handle('set-root-nickname', (e, root, nickname) => {
  setRootNickname(root, nickname);
  // If the renamed root is the one currently open, refresh every window's title.
  if (normalizeRootForCompare(root) === normalizeRootForCompare(DATA_ROOT)) {
    broadcastProjectName();
  }
  return loadNicknames();
});

// Switch the active data root to `newRoot`. Shared by `select-data-root`
// (after the folder picker) and `set-data-root` (when picking from recents).
// Handles everything needed for a clean switch:
//   1. Persist the old root's session intact (so going back to it later
//      restores the same tabs, layout, and detached windows).
//   2. Close any detached windows from the old root. destroy() skips the
//      on-close confirmation dialog and does not overwrite the just-saved
//      session — this is cleanup, not a user-initiated close.
//   3. Update DATA_ROOT / SESSION_FILE and the last/recent
//      files in settings.
//   4. Restart the file watcher and re-point source control.
//   5. Restore window bounds, fileStateRegistry, and detached windows from
//      the new root's session file.
async function applyNewDataRoot(newRoot) {
  // (1) Write out everything for the old root before we touch anything.
  //     Skip if we don't yet have a root (first-run case).
  if (DATA_ROOT && SESSION_FILE) {
    try { saveFullSession(); } catch (e) { console.error('saveFullSession (old root) failed:', e.message); }
  }

  // (2) Close all detached windows from the old root. Use destroy() so the
  //     'close' handler (which shows a confirm-to-close prompt and saves
  //     bounds into the registry) is bypassed entirely — the user didn't
  //     close these windows, the root switch did. 'closed' still fires and
  //     cleans the registry entry.
  for (const [id, entry] of Array.from(windowRegistry.entries())) {
    if (id === 'main') continue;
    const win = entry.browserWindow;
    if (win && !win.isDestroyed()) {
      win._forceClose = true;
      win.destroy();
    }
    windowRegistry.delete(id);
  }

  // (3) Swap the root in and update the settings files.
  DATA_ROOT = newRoot;
  currentLayout = detectLayout(DATA_ROOT);
  refreshDataHomePaths();
  saveLastDataRoot(newRoot);
  addToRecentDataRoots(newRoot);

  // Reset the fileStateRegistry — it's keyed by relative path, and the
  // same relative path under the new root refers to a different file.
  fileStateRegistry.clear();

  snapshotMtimes();
  // (4) Restart file watcher on new root
  if (watcher) watcher.close();
  startFileWatcher();
  // Re-point source control at the new data root and re-detect. Without
  // this, the SC provider keeps its old repoRoot / status maps and
  // reports the previous working copy as still active — a real failure
  // mode when the user moves from an SVN repo to a Git repo, or a
  // folder outside any VCS. detectAll will pick the new provider (or
  // none) and emit pluginsChanged / statusChanged so the UI resyncs.
  tsvnCache.invalidate();
  tgitCache.invalidate();
  sourceControl.setDataRoot(DATA_ROOT, getLayerScanDirs());
  sourceControl.detectAll().then(() => {
    const active = sourceControl.getActiveSnapshot();
    if (active && active.statusBackendLive) {
      sourceControl.refreshDataStatus();
      sourceControl.refreshRepoStatus();
    }
  });

  // (5) Restore window bounds and file state registry from the new session.
  const session = loadSession();
  // Migrate old format → new fileStates format
  if (!session.fileStates && (session.cursorPositions || session.referencePanels)) {
    const cursors = session.cursorPositions || {};
    const refs = session.referencePanels || {};
    const allPaths = new Set([...Object.keys(cursors), ...Object.keys(refs)]);
    session.fileStates = {};
    for (const p of allPaths) {
      session.fileStates[p] = {
        cursor: cursors[p]?.cursor ?? 0,
        scrollLine: cursors[p]?.scrollLine ?? 1,
        refPanel: refs[p]?.open ? { open: true, height: refs[p].height, scrollLine: refs[p].scrollLine } : null,
      };
    }
    delete session.cursorPositions;
    delete session.referencePanels;
    saveSession(session);
  }
  if (session.fileStates) {
    for (const [p, state] of Object.entries(session.fileStates)) {
      fileStateRegistry.set(p, state);
    }
  }
  if (session.window && mainWindow && !mainWindow.isDestroyed()) {
    const wb = ensureBoundsOnScreen(session.window);
    if (wb.x != null && wb.y != null) mainWindow.setContentBounds({ x: wb.x, y: wb.y, width: wb.width || 1400, height: wb.height || 900 });
  }
  // Restore detached windows from the new root's session.
  if (session.detachedWindows?.length) {
    for (const dw of session.detachedWindows) {
      if (dw.tabs?.length) {
        detachedCounter++;
        createDetachedWindow(
          dw.windowId || ('det_' + detachedCounter),
          dw.tabs,
          dw.bounds?.x, dw.bounds?.y,
          dw.bounds?.width, dw.bounds?.height
        );
      }
    }
  }
}

ipcMain.handle('select-data-root', async () => {
  const newRoot = await promptForDataRoot(false);
  if (newRoot) {
    await applyNewDataRoot(newRoot);
    return newRoot;
  }
  return null;
});

// Switch to a specific root (typically picked from the recent-roots list).
// Returns the resolved path on success, or { error: '...' } on failure.
ipcMain.handle('set-data-root', async (_event, chosenPath) => {
  if (!chosenPath || typeof chosenPath !== 'string') {
    return { error: 'No path provided.' };
  }
  if (!fs.existsSync(chosenPath)) {
    // Drop the dead entry from recents so the picker stops showing it.
    const filtered = loadRecentDataRoots().filter(
      (r) => normalizeRootForCompare(r) !== normalizeRootForCompare(chosenPath)
    );
    saveRecentDataRoots(filtered);
    return { error: 'That folder no longer exists. It has been removed from the recent list.' };
  }
  if (!isValidDataRoot(chosenPath)) {
    return { error: 'That folder does not contain valid game data.' };
  }
  await applyNewDataRoot(chosenPath);
  return chosenPath;
});

// ─── File Watching ───────────────────────────────────────────────────

function startFileWatcher() {
  // Watch each layer's base directory at depth 1 (one folder level deep).
  // In suite mode that's GameData/Configuration plus each active expansion;
  // we don't watch DATA_ROOT itself because that'd pull in unrelated content
  // (Audio, builds, etc.) and slow chokidar without benefit.
  //
  // The spelling-dictionary files live in DATA_HOME (== the base layer dir),
  // which is already one of the watched layer dirs — so external edits to
  // them are picked up without an extra explicit watch.
  const watchPaths = getLayerScanDirs();
  if (!watchPaths.length) return;
  watcher = chokidar.watch(watchPaths, {
    ignored: [
      /(^|[\/\\])\../, // hidden files
      '**/node_modules/**',
      SESSION_FILE,
    ],
    persistent: true,
    depth: 1, // only one level deep (folders with xml/metadata)
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('change', (filePath) => {
    // Consume a single expected event from our own write. recentSaves was
    // historically a 3-second TTL set, but that also ate any external
    // modification that happened within the window — e.g. SVN revert soon
    // after a save. Deleting on first hit means we ignore exactly the one
    // event chokidar fires for our own write, and any subsequent change
    // (from any source) is treated as external.
    if (recentSaves.has(filePath)) {
      recentSaves.delete(filePath);
      return;
    }

    // Spelling dictionary changed externally
    const basename = path.basename(filePath);
    if (basename === '_spellingDictionary.txt' || basename === '_spellingDevDictionary.txt') {
      broadcastToAll('dictionary-changed');
      return;
    }

    // Island files (e.g. Unity .asset) live outside the data root and use
    // non-.xml extensions, but must still trigger a reload (e.g. when Unity
    // rewrites the file). Allow them through alongside .xml / .metadata.
    const isIsland = islandTrackedAbsPaths.has(path.resolve(filePath));
    if (!isIsland && !filePath.endsWith('.xml') && !filePath.endsWith('.metadata')) return;

    const relativePath = relFwd(filePath);
    broadcastToAll('file-changed-on-disk', relativePath);
    // VCS status may have changed (modified, reverted, etc.). Islands are in a
    // separate repo (outside the data root), so skip the source-control refresh.
    if (!isIsland) sourceControl.refreshFile(filePath);
  });

  watcher.on('add', (filePath) => {
    // If the dictionary files are first created externally, treat as a change
    // so the renderer reloads them.
    const basename = path.basename(filePath);
    if (basename === '_spellingDictionary.txt' || basename === '_spellingDevDictionary.txt') {
      broadcastToAll('dictionary-changed');
      return;
    }
    const relativePath = relFwd(filePath);
    broadcastToAll('file-added-on-disk', relativePath);

    // If this `add` is really a content replacement (TortoiseSVN revert
    // can land as unlink+add on Windows when chokidar's atomic coalescing
    // misses), notify the renderer to reload open editor tabs too. We
    // detect this by checking whether we had an mtime recorded for the
    // path before — if so, it's not a genuinely-new file, it's a
    // re-created one.
    if ((filePath.endsWith('.xml') || filePath.endsWith('.metadata')) && fileMtimes.has(relativePath)) {
      broadcastToAll('file-changed-on-disk', relativePath);
    }
    try { fileMtimes.set(relativePath, fs.statSync(filePath).mtimeMs); } catch (_) {}

    sourceControl.refreshFile(filePath);
  });

  watcher.on('unlink', (filePath) => {
    const relativePath = relFwd(filePath);
    broadcastToAll('file-removed-on-disk', relativePath);
    sourceControl.refreshFile(filePath);
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Windows needs an explicit Application User Model ID for the taskbar to host
  // a custom jump list (and for notifications). Must be set before any window
  // is created. Matches the electron-builder `appId` so a build-created
  // shortcut with the same ID groups with the running window.
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    app.setAppUserModelId('com.arcen.xmleditor');
  }

  DATA_ROOT = await resolveDataRoot();
  currentLayout = detectLayout(DATA_ROOT);
  refreshDataHomePaths();

  if (DATA_ROOT) {
    snapshotMtimes();
  }

  createMainWindow();

  // Seed the taskbar jump list from the recent list on startup. (Root switches
  // and nickname edits refresh it later via saveRecentDataRoots/setRootNickname.)
  updateJumpList();

  if (DATA_ROOT) {
    startFileWatcher();

    // Source-control detection + initial status refresh. Detection runs on
    // startup and every 30s; status refreshes run via explicit triggers
    // (file save, TortoiseProc exit, manual refresh).
    sourceControl.setDataRoot(DATA_ROOT, getLayerScanDirs());
    sourceControl.on('pluginsChanged', (snap) => {
      broadcastToAll('plugins-changed', snap);
    });
    sourceControl.on('statusChanged', (info) => {
      broadcastToAll('vcs-status-changed', info);
    });
    sourceControl.on('activeProviderChanged', () => {
      const active = sourceControl.getActiveSnapshot();
      if (active && active.statusBackendLive) {
        sourceControl.refreshDataStatus();
        sourceControl.refreshRepoStatus();
      }
    });
    sourceControl.detectAll().then(() => {
      const active = sourceControl.getActiveSnapshot();
      if (active && active.statusBackendLive) {
        sourceControl.refreshDataStatus();
        sourceControl.refreshRepoStatus();
      }
    });
    // Periodic re-detection while the app is focused. Handles TSVNCache
    // being started/stopped mid-session and re-runs status so the
    // overall-repo pip stays accurate over time — even when external edits
    // happen outside DATA_ROOT, which our file watcher doesn't see. The
    // repo-scope call runs in a worker thread, so the main event loop is
    // not blocked even on large repos.
    //
    // We skip the tick entirely when the app has no focused window — no
    // need to burn CPU running `svn status` on a repo the user isn't
    // actively looking at. A focus-gain event triggers an immediate full
    // refresh (see below), so accuracy resumes the moment the user comes
    // back to AXE.
    function runFullVcsRefresh() {
      tsvnCache.invalidate();
      tgitCache.invalidate();
      sourceControl.detectAll().then(() => {
        const active = sourceControl.getActiveSnapshot();
        if (active && active.statusBackendLive) {
          sourceControl.refreshDataStatus();
          sourceControl.refreshRepoStatus();
        }
      });
    }
    setInterval(() => {
      if (!BrowserWindow.getFocusedWindow()) return;
      runFullVcsRefresh();
    }, 30000);

    // On focus gain, run the full refresh immediately. `browser-window-focus`
    // fires for any window in the app (main or detached) when it receives
    // focus. We only need to act when the whole app transitions from
    // unfocused → focused, not when focus moves between AXE windows.
    let appFocused = !!BrowserWindow.getFocusedWindow();
    app.on('browser-window-focus', () => {
      if (appFocused) return;
      appFocused = true;
      runFullVcsRefresh();
    });
    app.on('browser-window-blur', () => {
      // Defer the "unfocused" transition by a tick — when focus moves
      // between AXE windows, blur fires before the new focus, and we
      // don't want to flip appFocused to false only to immediately flip
      // it back.
      setTimeout(() => {
        appFocused = !!BrowserWindow.getFocusedWindow();
      }, 0);
    });

    // Load session and file state registry
    const session = loadSession();
    // Migrate old format → new fileStates format
    if (!session.fileStates && (session.cursorPositions || session.referencePanels)) {
      const cursors = session.cursorPositions || {};
      const refs = session.referencePanels || {};
      const allPaths = new Set([...Object.keys(cursors), ...Object.keys(refs)]);
      session.fileStates = {};
      for (const p of allPaths) {
        session.fileStates[p] = {
          cursor: cursors[p]?.cursor ?? 0,
          scrollLine: cursors[p]?.scrollLine ?? 1,
          refPanel: refs[p]?.open ? { open: true, height: refs[p].height, scrollLine: refs[p].scrollLine } : null,
        };
      }
      delete session.cursorPositions;
      delete session.referencePanels;
      saveSession(session);
    }
    if (session.fileStates) {
      for (const [p, state] of Object.entries(session.fileStates)) {
        fileStateRegistry.set(p, state);
      }
    }
    // Seed windowLevelState from saved session (renderer will overwrite on first save)
    for (const key of ['tabs', 'activeTab', 'expandedFolders', 'sidebarTab', 'sidebarWidth',
                        'sidebarSide', 'globalSearchHeight', 'editorScale', 'refPanelScale', 'theme',
                        'globalSearchIncludeMods', 'favorites']) {
      if (session[key] !== undefined) windowLevelState[key] = session[key];
    }

    // Restore detached windows from session
    if (session.detachedWindows?.length) {
      for (const dw of session.detachedWindows) {
        if (dw.tabs?.length) {
          detachedCounter++;
          createDetachedWindow(
            dw.windowId || ('det_' + detachedCounter),
            dw.tabs,
            dw.bounds?.x, dw.bounds?.y,
            dw.bounds?.width, dw.bounds?.height
          );
        }
      }
    }
    // Periodic background save for crash protection (every 30s if dirty)
    setInterval(() => {
      if (sessionDirty && SESSION_FILE) {
        saveFullSession();
      }
    }, 30000);

    // Safety-net mtime poll: catches external mutations (e.g. SVN revert)
    // that chokidar misses because of atomic-write coalescing or because
    // mtime rolled backward. checkForChangedFiles compares current mtime
    // against the last-seen snapshot and fires `file-changed-on-disk` for
    // any drift. Runs unconditionally — it's cheap, and window-focus alone
    // isn't sufficient for users who leave AXE in the background while
    // reverting via TortoiseSVN in Explorer.
    setInterval(() => {
      checkForChangedFiles();
    }, 10000);
  } // end if (DATA_ROOT)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  app.quit();
});
