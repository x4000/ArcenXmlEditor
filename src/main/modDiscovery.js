// Mod discovery for suite mode.
//
// Mods live in three source directories, each contributing its own LAYER tier:
//   XMLMods/                         → layer prefix 'x'
//   XMLMods_NonDistributed/          → layer prefix 'n'
//   <steam>/steamapps/workshop/content/<appId>/  → layer prefix 'w'
//
// A mod is recognized by `ModDetails.xml` inside its directory. Anything else
// at the source-dir top level (loose files, documentation, ModTemplate.zip)
// is ignored. Within a mod, `is_disabled="true"` on the <mod_data> element
// removes the mod from discovery entirely; total conversions (mods that ship
// their own GameData/Configuration/) are also skipped — those are loaded as
// their own data root via the data-folder picker, not as a layer here.
//
// The same mod folder name can appear in all three sources at once, so layer
// ids include the source prefix:
//     mod_x_<modFolderName>     (local XMLMods)
//     mod_n_<modFolderName>     (local non-distributed)
//     mod_w_<publishedFileId>   (Steam workshop — the dir name IS the file id)
//
// HotM-style mods carry their table folders directly under <modDir>/. AIW2-
// style mods may nest them at <modDir>/GameData/Configuration/ (same shape
// as AIW2-style expansions). Detection picks the nested path if present,
// matching listActiveExpansions() in main.js.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MODS_DIRECT_REL = 'XMLMods';
const MODS_NONDIST_REL = 'XMLMods_NonDistributed';
const MOD_DETAILS_XML = 'ModDetails.xml';   // HotM-style
const MOD_DETAILS_TXT = 'ModDetails.txt';   // AIW2-style
const STEAM_APPID_FILE = 'steam_appid.txt';
const NESTED_TABLE_REL = path.join('GameData', 'Configuration');

// Files that live at a mod's TOP level (alongside ModDetails) and should be
// surfaced as mod-level entries in the MODS sidebar tab. The two games have
// different sets: HotM keeps everything XML-based with translation support;
// AIW2 is older and uses several plain-text files plus simple flag-file
// presence to mark framework/disabled.
const HOTM_MOD_LEVEL_FILES = ['ModDetails.xml', 'ModTranslation.xml', 'ModSortOrder.txt'];
const AIW2_MOD_LEVEL_FILES = [
  'ModDetails.txt', 'ModDescription.txt', 'ModAlternateNames.txt',
  'ModIsConsideredFramework.txt', 'ModIsNotDisabled.txt',
  'RequiredExpansions.txt', 'RequiredMods.txt',
];

function getModLevelFilesForFormat(format) {
  return format === 'aiw2' ? AIW2_MOD_LEVEL_FILES : HOTM_MOD_LEVEL_FILES;
}

// Source prefix → human label, used in tooltips / error messages.
const SOURCE_LABELS = { x: 'XMLMods', n: 'XMLMods_NonDistributed', w: 'Steam Workshop' };

// ─── Steam workshop folder resolution ────────────────────────────────

// Pull Steam's install path from the Windows registry. Two known locations,
// in order of reliability: per-user HKCU first (matches whichever Steam the
// current user signed into last), system-wide HKLM as a fallback. Returns
// null on non-Windows or if neither key is present.
function getSteamPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  const queries = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [hive, name] of queries) {
    try {
      const out = execFileSync('reg', ['query', hive, '/v', name], { encoding: 'utf-8', windowsHide: true });
      const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\r?\n/);
      if (m) return m[1].trim();
    } catch (e) { /* key absent — try next */ }
  }
  return null;
}

// Tiny VDF (Valve KeyValues) parser — just enough to extract every "path"
// leaf, which is all libraryfolders.vdf needs from us. Stores backslash-
// escape each separator, so we collapse \\ → \ once captured.
function extractVdfPaths(vdfText) {
  const out = [];
  const re = /"path"\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(vdfText)) !== null) {
    out.push(m[1].replace(/\\\\/g, '\\'));
  }
  return out;
}

// All Steam library roots the current Steam install knows about. Each entry
// is a directory whose `steamapps/workshop/content/<appId>/` subtree (if it
// exists) holds workshop downloads for that game. Falls back to just the
// primary Steam path if libraryfolders.vdf can't be read.
function getSteamLibraryRoots() {
  const steamPath = getSteamPathFromRegistry();
  if (!steamPath) return [];
  const libVdf = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  if (fs.existsSync(libVdf)) {
    try {
      const libs = extractVdfPaths(fs.readFileSync(libVdf, 'utf-8'));
      if (libs.length) return libs;
    } catch (e) { /* corrupt vdf — fall through */ }
  }
  return [steamPath];
}

// Workshop content roots for one Steam appId. Multiple libraries can each
// have a workshop dir for the same app — Steam doesn't consolidate them.
function getWorkshopRootsForAppId(appId) {
  if (!appId) return [];
  const out = [];
  for (const lib of getSteamLibraryRoots()) {
    const wsDir = path.join(lib, 'steamapps', 'workshop', 'content', String(appId));
    try {
      if (fs.statSync(wsDir).isDirectory()) out.push(wsDir);
    } catch (e) { /* not present in this library */ }
  }
  return out;
}

// The per-game appId is shipped as steam_appid.txt at DATA_ROOT (Steam-SDK
// convention). HotM = 2001070; AIW2 has its own. Missing or unreadable →
// no workshop mods for this root.
function readSteamAppId(dataRoot) {
  if (!dataRoot) return null;
  try {
    const raw = fs.readFileSync(path.join(dataRoot, STEAM_APPID_FILE), 'utf-8');
    const trimmed = raw.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  } catch (e) { return null; }
}

// Strip Unity-style rich-text tags from a display string. Some mod authors
// include color/bold/italic markup in their display names — e.g. RadiantMaps
// shows up as `<color=#ffc000>Radiant</color> Maps`. The editor doesn't
// render those markers; left in, they'd show literally and break truncation.
// Applies to both HotM and AIW2 display names for safety.
function stripRichText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/<[^>]+>/g, '').trim();
}

// Read a one-name-per-line text file (RequiredExpansions.txt / RequiredMods.txt
// in the AIW2 mod format). Empty file → []. Missing file → []. Strips each
// line and skips blanks; ignores comment-style `#` lines defensively.
function readNamesPerLine(filePath) {
  if (!fs.existsSync(filePath)) return [];
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); }
  catch (e) { return []; }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    out.push(s);
  }
  return out;
}

// ─── ModDetails parsing ─────────────────────────────────────────────
//
// Two formats are recognized:
//   - HotM (ModDetails.xml): <mod_data ...>, <lang ...> blocks. Translation,
//     required_mods, required_expansions, color, framework flag — all live
//     as attributes on <mod_data>.
//   - AIW2 (ModDetails.txt): 4-5 plain text lines:
//       1: display name
//       2: author
//       3: short code
//       4: hex color (no leading #)
//       5: optional — "disabled" (case-insensitive) marks the mod off
//     Companion files (presence-as-flag): ModIsConsideredFramework.txt.
//     No translation, no declared mod/expansion deps in this format.
//
// Both parsers return the same shape so the rest of the pipeline doesn't
// need to know which format produced it. `format` is set so the discovery
// output can pick the right mod-level file list.

// Pull the attributes we care about off the <mod_data ... /> element plus
// the localized display name from the first matching <lang> block. Regex-
// based — we deliberately don't pull in a DOM in the main process for this
// tiny extraction. Returns null if the file is unreadable or has no
// <mod_data>.
function parseModDetailsXml(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); }
  catch (e) { return null; }
  const tagMatch = text.match(/<mod_data\b([^>]*?)\/?>/);
  if (!tagMatch) return null;
  const attrs = tagMatch[1];
  const get = (name) => {
    const r = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
    return r ? r[1] : null;
  };
  const splitCsv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

  // Display name: prefer English, otherwise the first <lang> block we see.
  let displayName = null;
  const langEn = text.match(/<lang\s+id\s*=\s*"English"\b[^>]*?\bname\s*=\s*"([^"]*)"/);
  if (langEn) displayName = langEn[1];
  else {
    const langAny = text.match(/<lang\s+[^>]*?\bname\s*=\s*"([^"]*)"/);
    if (langAny) displayName = langAny[1];
  }

  return {
    format: 'hotm',
    isDisabled: get('is_disabled') === 'true',
    isFrameworkMod: get('is_framework_mod') === 'true',
    color: get('color_for_display'),
    author: get('author'),
    requiredMods: splitCsv(get('required_mods')),
    requiredExpansions: splitCsv(get('required_expansions')),
    displayName: stripRichText(displayName),
  };
}

// Parse the AIW2 plain-text ModDetails.txt. 4-5 lines: name, author, short
// code, hex-color-without-leading-#, optional "disabled" marker. Returns the
// same shape as parseModDetailsXml so the rest of the pipeline is format-
// agnostic. Returns null if the file is missing or empty (no display name).
function parseModDetailsTxt(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf-8'); }
  catch (e) { return null; }
  const lines = text.split(/\r?\n/);
  const get = (i) => (lines[i] || '').trim();
  const name = get(0);
  if (!name) return null;
  const author = get(1);
  // Line 3 is the mod's short code (e.g. "AISh"). Not surfaced through the
  // mod entry today — we keep it parsed for future use rather than dropping.
  const _shortCode = get(2);
  const colorHex = get(3);
  const disabledLine = get(4).toLowerCase();
  const modDir = path.dirname(filePath);
  // Presence-as-flag sidecar: ModIsConsideredFramework.txt. Engine convention
  // analogous to HotM's is_framework_mod attribute. Contents don't matter.
  const isFrameworkMod = fs.existsSync(path.join(modDir, 'ModIsConsideredFramework.txt'));
  // Optional one-name-per-line dep files. The AIW2 ModDetails.txt format has
  // no fields for these — separate sidecars carry them. Both are absent for
  // most mods.
  const requiredExpansions = readNamesPerLine(path.join(modDir, 'RequiredExpansions.txt'));
  const requiredMods = readNamesPerLine(path.join(modDir, 'RequiredMods.txt'));
  return {
    format: 'aiw2',
    isDisabled: disabledLine === 'disabled',
    isFrameworkMod,
    // Normalize to "#RRGGBB" so the renderer can use it as a CSS color
    // without any source-format awareness.
    color: colorHex ? (colorHex.startsWith('#') ? colorHex : '#' + colorHex) : null,
    author: author || null,
    requiredMods,
    requiredExpansions,
    // Strip rich-text tags some mod authors embed in the display name
    // (e.g. <color=#ffc000>Radiant</color> Maps).
    displayName: stripRichText(name),
  };
}

// Try the HotM (.xml) format first, fall back to the AIW2 (.txt) format.
// Returns the parsed entry or null if neither file exists / both fail to
// parse.
function parseModDetailsForDir(modDir) {
  const xmlPath = path.join(modDir, MOD_DETAILS_XML);
  if (fs.existsSync(xmlPath)) {
    const r = parseModDetailsXml(xmlPath);
    if (r) return { details: r, detailsPath: xmlPath };
  }
  const txtPath = path.join(modDir, MOD_DETAILS_TXT);
  if (fs.existsSync(txtPath)) {
    const r = parseModDetailsTxt(txtPath);
    if (r) return { details: r, detailsPath: txtPath };
  }
  return null;
}

// ─── Per-mod-source enumeration ─────────────────────────────────────

// A mod that ships its own GameData/Configuration/ subtree is a *total
// conversion* — a whole alternate game root, not a layer. The user loads it
// by pointing AXE at it via the data-root picker. We don't process it as a
// layer here. Matches the engine's LooksLikeTotalConversion heuristic.
function looksLikeTotalConversion(modDir) {
  try { return fs.statSync(path.join(modDir, NESTED_TABLE_REL)).isDirectory(); }
  catch (e) { return false; }
}

// Scan one mod-source directory (a local XMLMods*/ or a workshop content
// dir for one appId) and return one entry per discovered, enabled mod.
// `sourcePrefix` becomes part of the layer id so the same mod folder name
// in two different sources doesn't collide.
function scanModSource(sourceDir, sourcePrefix) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(sourceDir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(sourceDir, e.name);
    const parsed = parseModDetailsForDir(dirPath);
    if (!parsed) continue;                             // not a mod folder
    if (looksLikeTotalConversion(dirPath)) continue;   // handled as a data root
    const { details, detailsPath } = parsed;
    if (details.isDisabled) continue;                  // explicitly off
    const nested = path.join(dirPath, NESTED_TABLE_REL);
    const tableRoot = fs.existsSync(nested) ? nested : dirPath;
    out.push({
      layerId: `mod_${sourcePrefix}_${e.name}`,
      source: sourcePrefix,
      sourceLabel: SOURCE_LABELS[sourcePrefix] || sourcePrefix,
      format: details.format,
      dirName: e.name,
      dirPath,
      tableRoot,
      modDetailsPath: detailsPath,
      isFrameworkMod: details.isFrameworkMod,
      color: details.color,
      author: details.author,
      requiredMods: details.requiredMods,
      requiredExpansions: details.requiredExpansions,
      displayName: details.displayName || e.name,
      // For workshop entries the folder name IS the publishedFileId — we
      // surface it explicitly so UI can show it.
      publishedFileId: sourcePrefix === 'w' ? e.name : null,
    });
  }
  return out;
}

// All active mods across all three sources, suite-mode only. Stable order:
// local-first by source tier (x → n → w), alphabetical within each tier.
function listActiveMods(dataRoot) {
  if (!dataRoot) return [];
  const all = [];
  all.push(...scanModSource(path.join(dataRoot, MODS_DIRECT_REL), 'x'));
  all.push(...scanModSource(path.join(dataRoot, MODS_NONDIST_REL), 'n'));
  const appId = readSteamAppId(dataRoot);
  if (appId) {
    for (const wsRoot of getWorkshopRootsForAppId(appId)) {
      all.push(...scanModSource(wsRoot, 'w'));
    }
  }
  const tier = (s) => (s === 'x' ? 0 : s === 'n' ? 1 : 2);
  all.sort((a, b) => {
    const ta = tier(a.source), tb = tier(b.source);
    if (ta !== tb) return ta - tb;
    return a.dirName.localeCompare(b.dirName, 'en');
  });
  return all;
}

module.exports = { listActiveMods, getModLevelFilesForFormat };
