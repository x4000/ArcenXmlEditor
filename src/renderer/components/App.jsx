import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import EditorPane from './EditorPane';
import StatusBar from './StatusBar';
import DiffView from './DiffView';
import GlobalSearch from './GlobalSearch';
import TitleBar from './TitleBar';
import GoToLineDialog from './GoToLineDialog';
import RenameIdDialog from './RenameIdDialog';
import GrammarSettings from './GrammarSettings';
import DataRootPicker from './DataRootPicker';
const vcsStore = require('../editor/vcsStore');
import { parseMetadata, parseSharedMetadata, buildMergedSchema, getCentralIdentifierKey, composeSchemaForFileLayer } from '../editor/schemaParser';
import { buildFKIndex, updateTableIndex, buildLookupSwaps } from '../editor/fkIndex';
import { tokenize, buildAttrMap } from '../editor/xmlTokenizer';
import { navigateToFKRow, navigateToMetadataDef, addUnknownSubNodeStub } from '../editor/navigation';
import { validateAll, validateXMLFile, structuralErrorsToEntries, buildLayerMaps } from '../editor/validation';
import { findMisspelledWords, findMisspelledWordsInMetadata, spellingMessagePrefix, isSpellcheckTarget, isMetadataSpellcheckTarget } from '../editor/spellcheck';
import { extractGrammarTargets } from '../editor/grammarTargets';
import { fileDisplayName } from '../editor/layerDisplay';
import NSpell from 'nspell';

/**
 * Wrap a raw nspell instance so its `correct` method becomes dev-aware.
 *   correct(word)        → regular dictionary only (user-facing fields)
 *   correct(word, true)  → regular dictionary + dev dictionary (dev contexts)
 * `suggest` and `add` pass through to the underlying nspell.
 */
// Replace oldId with newId in a comma-separated FK attribute value,
// preserving any whitespace around each token.
function replaceIdInValue(attrValue, oldId, newId) {
  if (attrValue === oldId) return newId;
  return attrValue.split(',').map(p => {
    const trimmed = p.trim();
    if (trimmed !== oldId) return p;
    const idx = p.indexOf(trimmed);
    return p.slice(0, idx) + newId + p.slice(idx + trimmed.length);
  }).join(',');
}

// Collect the [from, to) value ranges in `content` that spellchecking actually
// targets. A bulk spelling replace must only rewrite text that could legitimately
// hold the misspelling — never id / central-identifier values (the AI War `name`
// key), tag names, FK references, numbers, etc. Mirrors findMisspelledWords'
// target selection (isSpellcheckTarget) for XML and the tooltip-only rule for
// metadata files.
function spellcheckableValueRanges(content, mergedSchema, isMetadata) {
  const ranges = [];
  const tokens = tokenize(content);
  if (isMetadata) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].c !== 'an' || !isMetadataSpellcheckTarget(tokens[i].s)) continue;
      for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
        if (tokens[j].c === 'av') { ranges.push({ from: tokens[j].p, to: tokens[j].p + tokens[j].s.length }); break; }
      }
    }
    return ranges;
  }
  if (!mergedSchema) return ranges;
  for (const attr of buildAttrMap(tokens, mergedSchema)) {
    if (attr.vs == null) continue;
    if (!isSpellcheckTarget(attr)) continue;
    ranges.push({ from: attr.vs, to: attr.ve });
  }
  return ranges;
}

// Replace every occurrence of oldText with newText, but only where it falls
// inside one of `ranges` (non-overlapping, within [0, content.length]).
function replaceWithinRanges(content, oldText, newText, ranges) {
  if (!oldText || !ranges || ranges.length === 0) return content;
  ranges.sort((a, b) => a.from - b.from);
  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    const from = Math.max(r.from, cursor);
    if (from >= r.to) continue;
    out += content.slice(cursor, from);
    out += content.slice(from, r.to).split(oldText).join(newText);
    cursor = r.to;
  }
  out += content.slice(cursor);
  return out;
}

function makeDevAwareChecker(nspell, devWordsRef) {
  return {
    correct: (word, isDev) => {
      if (nspell.correct(word)) return true;
      if (isDev && devWordsRef.current.has(word)) return true;
      return false;
    },
    suggest: (word) => nspell.suggest(word),
    add: (word) => nspell.add(word),
    remove: (word) => nspell.remove(word),
    _nspell: nspell, // escape hatch if raw access is ever needed
  };
}

export default function App() {
  const [theme, setTheme] = useState('light');
  const [folders, setFolders] = useState([]);
  // Layout metadata from discoverData: drives suite-vs-narrow behavior and
  // surfaces expansion info to the UI. The SharedMetaData key sits at this
  // top level because suite mode places it at `GameData/Configuration/
  // SharedMetaData.metadata` instead of the bare filename.
  const [dataLayout, setDataLayout] = useState({
    mode: 'narrow',
    sharedMetadataRelPath: 'SharedMetaData.metadata',
    expansions: [],
    mods: [],
    structuralErrors: [],
  });
  // Layer-info maps for the validator: how dirNames (the form used in
  // ModDetails.xml and row-level required_*_list) translate to internal
  // layer ids, plus the per-mod baseline extras and friendly display names.
  // Recomputed when expansions or mods change; passed to the worker / inline
  // validateXMLFile call on every validate.
  const layerMaps = useMemo(
    () => buildLayerMaps(dataLayout.expansions, dataLayout.mods),
    [dataLayout.expansions, dataLayout.mods],
  );
  const expansionDirNameToLayer = layerMaps.expansionDirNameToLayer;
  const [sharedSchema, setSharedSchema] = useState(null);
  const [schemas, setSchemas] = useState({});
  // "Island" data sources (self-contained schemas + embedded-XML .asset files
  // outside Configuration; see discoverExtraDataSources in main.js). `islands`
  // drives the dedicated sidebar tab. `islandSchemaByRelPath` maps each island
  // data file's relPath → its STANDALONE parsed schema (no SharedMetaData
  // merge, no FK index) — fed straight to the editor. `islandRelPathsRef`
  // mirrors the keys as a Set for stale-closure-free "is this view-only?"
  // checks in saveFile and the bulk-replace guards.
  const [islands, setIslands] = useState([]);
  const [islandSchemaByRelPath, setIslandSchemaByRelPath] = useState(() => new Map());
  const islandRelPathsRef = useRef(new Set());        // data files only → view-only guard
  const islandAllRelPathsRef = useRef(new Set());     // data files + each island's metadata → sidebar-tab stickiness
  // Mod schema extensions, parsed and indexed by (modLayer, folderName).
  // An extension contributes additional attributes / sub_nodes that apply
  // when validating files in that mod (and any mod that requires it). See
  // §32.5 in design.md for the visibility-tree rules.
  const [schemaExtensions, setSchemaExtensions] = useState({});
  // The raw extension records (modLayer, folderName, metadataPath,
  // metadataRelPath, metadataFile) as discovery saw them. Kept separate
  // from the parsed map so the MODS sidebar can surface each extension
  // file as a clickable schema entry. Only changes when discovery runs.
  const [modSchemaExtensionsList, setModSchemaExtensionsList] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [fileContents, setFileContents] = useState({});
  const [savedContents, setSavedContents] = useState({});
  const [sidebarTab, setSidebarTab] = useState('files');
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [validationErrors, setValidationErrors] = useState([]);
  const [fkIndex, setFkIndex] = useState({});
  const [diffTabIndex, setDiffTabIndex] = useState(null);
  const [diskConflicts, setDiskConflicts] = useState([]); // [{relPath}]
  const recentSavesRef = useRef(new Set()); // files we just saved, suppress reload bar
  const [pendingScrollLine, setPendingScrollLine] = useState(null); // {file, line}
  const [globalSearch, setGlobalSearch] = useState(null); // null | { replace: bool }
  const [globalSearchQuery, setGlobalSearchQuery] = useState(''); // persists across close/open
  const [globalSearchHeight, setGlobalSearchHeight] = useState(300);
  // The one global-search filter that persists across sessions (the others
  // — Wildcard, Regex, Case, Whole Word, XML, META — stay per-window-session).
  // Off by default so mods don't pollute results unless the user explicitly
  // asks for them. Stored in _user_editor_session.json alongside other
  // window-level state.
  const [globalSearchIncludeMods, setGlobalSearchIncludeMods] = useState(false);
  const [globalSearchScopeFilter, setGlobalSearchScopeFilter] = useState('all');
  const [editorScale, setEditorScale] = useState(100);
  const [scrollSidebarTo, setScrollSidebarTo] = useState(null); // relativePath to scroll to
  const [activeFiles, setActiveFiles] = useState([]); // active file of EVERY open window (main + detached)
  const [favorites, setFavorites] = useState([]); // [{ name, files: [relPath] }]
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [sidebarSide, setSidebarSide] = useState('left'); // 'left' | 'right'
  const selectionStateRef = useRef({});
  const [refPanelScale, setRefPanelScale] = useState(100);
  const lookupSwapsRef = useRef({}); // oldId → newId chain from LookupSwaps table
  const [spellchecker, setSpellchecker] = useState(null);
  const spellcheckerRef = useRef(null);
  const workerRef = useRef(null);
  const validationBusyRef = useRef(false);
  // Snapshot of what was last shipped to the validator window. Used as the
  // source-of-truth comparison for the worker.onmessage "no-op if unchanged"
  // optimization — comparing against React state (which can be updated by
  // saveFile's synchronous validateXMLFile path WITHOUT notifying the
  // validator) used to leave the validator window stale forever after a
  // save: state matched worker output, so the IPC ship was skipped, and
  // the validator kept its pre-save error list.
  const lastSentValidatorRef = useRef([]);
  // Set true when the user clicks Re-validate All / Spelling Check from the
  // validator window. The next worker.onmessage forces a sendValidationResults
  // (and any waiting button-timer) even when results are byte-identical, so
  // the user gets visible feedback that their click did something.
  const forceSendValidatorRef = useRef(false);
  const [validationTiming, setValidationTiming] = useState(null); // null | { startTime } | { elapsed }
  const validationTimerRef = useRef(null); // animation frame ID
  const validationStartRef = useRef(null); // timestamp when validation started
  const dictDataRef = useRef({ aff: null, dic: null, custom: [] }); // cached for worker
  const spellingWorkerPoolRef = useRef([]); // persistent pool of workers for spelling
  const runSpellingCheckRef = useRef(null); // ref so startup warmup can kick off a scan
  const devWordsRef = useRef(new Set()); // dev-only dictionary words; added-to only from dev contexts

  // Refs for bulk content (used by FK index + validation without re-renders)
  const allFileContentsRef = useRef({});
  const tabHistoryRef = useRef([]); // stack of tab indices for close-tab navigation
  // Back/forward navigation history: { list: [relativePath], pos: index }
  const navHistoryRef = useRef({ list: [], pos: -1 });
  const navSkipRef = useRef(false); // skip history push when navigating back/forward
  const [navState, setNavState] = useState({ canBack: false, canForward: false });
  const globalSearchInputRef = useRef(null);
  const globalSearchReplaceRef = useRef(null);
  const globalSearchMinimizeRef = useRef(null);
  const editorViewRef = useRef(null);
  const localSearchStateRef = useRef(null); // persists CM6 search query across tab switches
  // Stack of global replace operations: [{ files: [{file, oldContent, newContent}] }]
  // Max 5 operations remembered
  const globalReplaceUndoRef = useRef([]);
  const [globalUndoCount, setGlobalUndoCount] = useState(0); // trigger re-renders for button state
  // Data-root picker modal: null when hidden, { currentRoot } when open.
  const [dataRootPicker, setDataRootPicker] = useState(null);

  // Map every file relativePath (xml + metadata) to its logical table folder
  // name. In suite mode a relativePath includes a layer prefix (GameData/
  // Configuration/... or Expansions/<dlc>/...), so the folder name can't be
  // derived by splitting on '/' anymore. This map is the single lookup. A
  // ref keeps it accessible from useEffect/useCallback closures that
  // shouldn't pin themselves to `folders` as a dep.
  const folderNameByRelPath = useMemo(() => {
    const m = new Map();
    for (const folder of folders) {
      for (const xf of folder.xmlFiles) m.set(xf.relativePath, folder.name);
      if (folder.metadataRelPath) m.set(folder.metadataRelPath, folder.name);
    }
    // Mod schema extension files: same folderName as the base table, but the
    // file lives at a different path. Without this entry, folderNameOf would
    // fall back to splitting on '/' — which would yield e.g. "XMLMods" for an
    // extension at "XMLMods/Reclaimers/CustomSystemType/_CustomSystemType.metadata".
    for (const ext of modSchemaExtensionsList) {
      m.set(ext.metadataRelPath, ext.folderName);
    }
    return m;
  }, [folders, modSchemaExtensionsList]);
  // relativePath → { layer, layerNum } for files in expansion layers, so tabs
  // can render the [DLC<N>] tag. Metadata files and base files are omitted —
  // a missing entry simply means "no tag".
  const layerByRelPath = useMemo(() => {
    const m = new Map();
    const modDisplayByLayer = {};
    for (const mod of (dataLayout.mods || [])) modDisplayByLayer[mod.layerId] = mod.displayName;
    for (const folder of folders) {
      for (const xf of folder.xmlFiles) {
        if (xf.layer && xf.layer !== 'base') {
          m.set(xf.relativePath, {
            layer: xf.layer,
            layerNum: xf.layerNum,
            modDisplayName: xf.layer.startsWith('mod_') ? modDisplayByLayer[xf.layer] : null,
          });
        }
      }
      // A folder's schema file belongs to whichever layer ships its .metadata.
      // For mod-owned schemas, surface that here so the tab filter routes the
      // schema file to MODS, the tab label gets [Mod: <Name>], and the FK
      // picker / validator treat it consistently with the mod's data files.
      if (folder.schemaLayer && folder.schemaLayer.startsWith('mod_') && folder.metadataRelPath) {
        m.set(folder.metadataRelPath, {
          layer: folder.schemaLayer,
          layerNum: 1000,
          modDisplayName: modDisplayByLayer[folder.schemaLayer] || null,
        });
      }
    }
    // Mod schema EXTENSION files (e.g. `XMLMods/Reclaimers/CustomSystemType/
    // _CustomSystemType.metadata`) live in a mod folder but the base owns the
    // table — without this entry, opening the file would auto-switch the
    // sidebar to Schema instead of staying on MODS (the routing rule is "if
    // it's a mod-layer path, go to MODS"; without a layer entry, the schema
    // type fell through to the Schema branch).
    for (const ext of modSchemaExtensionsList) {
      m.set(ext.metadataRelPath, {
        layer: ext.modLayer,
        layerNum: 1000,
        modDisplayName: modDisplayByLayer[ext.modLayer] || null,
      });
    }
    // Mod-level files (ModDetails.xml etc.) also get a layer entry so tabs/favorites
    // can tag them with [Mod: <Name>] when they leak outside the MODS sidebar.
    for (const mod of (dataLayout.mods || [])) {
      for (const f of (mod.modLevelFiles || [])) {
        m.set(f.relativePath, { layer: mod.layerId, layerNum: 1000, modDisplayName: mod.displayName });
      }
    }
    return m;
  }, [folders, dataLayout.mods, modSchemaExtensionsList]);
  const folderNameByRelPathRef = useRef(folderNameByRelPath);
  folderNameByRelPathRef.current = folderNameByRelPath;
  const layerByRelPathRef = useRef(layerByRelPath);
  layerByRelPathRef.current = layerByRelPath;
  // Which sidebar tab "owns" a given file's relPath — so every reveal/center
  // action routes to the right tab. Island data/schema files live in the Extra
  // tab, mod files in MODS, everything else in the Explorer. Reads refs so it's
  // safe to call from once-registered IPC handlers and context-menu closures.
  function sidebarTabForPath(relPath) {
    if (islandAllRelPathsRef.current.has(relPath)) return 'islands';
    if (/^mod_/.test(layerByRelPathRef.current.get(relPath)?.layer || '')) return 'mods';
    return 'files';
  }
  // Current tabs, read by once-registered IPC handlers (onFocusTab) without
  // re-subscribing on every tabs change.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Structural (layout) validation entries — orphan expansion folders, stray
  // .metadata in expansions. Static per discovery; shipped to the worker on
  // every validate so they appear in the validation window alongside file
  // content errors.
  const structuralErrorsRef = useRef([]);
  useEffect(() => {
    structuralErrorsRef.current = structuralErrorsToEntries(dataLayout.structuralErrors);
  }, [dataLayout.structuralErrors]);
  // Fallback that still works in narrow mode if a relativePath isn't in the
  // map yet (e.g. discovery hasn't completed). Splits on '/' which is
  // correct for narrow mode where the first segment IS the folder.
  function folderNameOf(relPath) {
    return folderNameByRelPathRef.current.get(relPath) || relPath.split('/')[0];
  }

  // Reusable extension loader. Reads each `_<TableName>.metadata` file in
  // data.schemaExtensions, parses it, and updates BOTH the React state used
  // by validation/composition AND `extensionsMetaRef` — the latter is what
  // the (long-lived) file watcher consults to recognize "this changed file
  // is a mod schema extension, not a base schema" so the per-folder branch
  // doesn't overwrite the real GameEntity schema with the extension's
  // (often tiny) attribute list. Also pokes schemaExtensionsLatest.current
  // directly so a validation that fires before the setState commits still
  // sees the new extensions.
  const loadExtensionsAndIndex = useCallback(async (extList) => {
    const extensionsMap = {}; // { [modLayer]: { [folderName]: parsedExt } }
    const extMeta = new Map(); // metadataRelPath → { modLayer, folderName }
    for (const ext of (extList || [])) {
      try {
        const txt = await window.arcenApi.readFile(ext.metadataRelPath);
        const parsed = parseMetadata(txt, ext.folderName);
        if (!parsed) {
          console.warn(`[extensions] Failed to parse mod schema extension: ${ext.metadataRelPath}`);
          continue;
        }
        if (!extensionsMap[ext.modLayer]) extensionsMap[ext.modLayer] = {};
        extensionsMap[ext.modLayer][ext.folderName] = parsed;
        extMeta.set(ext.metadataRelPath, { modLayer: ext.modLayer, folderName: ext.folderName });
      } catch (e) {
        console.warn(`[extensions] Could not read mod schema extension: ${ext.metadataRelPath}`, e);
      }
    }
    extensionsMetaRef.current = extMeta;
    schemaExtensionsLatest.current = extensionsMap;
    setSchemaExtensions(extensionsMap);
    return extensionsMap;
  }, []);

  // Parse each island's standalone schema and index it by its data files'
  // relPaths. Islands are self-contained: their `_<Name>.metadata` IS the whole
  // schema (parseMetadata output is already merged-shape), with no SharedMetaData
  // merge and no FK index. Also seeds islandRelPathsRef (the view-only set).
  const loadIslands = useCallback(async (islandsData) => {
    const list = islandsData || [];
    setIslands(list);
    const map = new Map();
    const relSet = new Set();
    const allSet = new Set();
    for (const isl of list) {
      let parsed = null;
      try {
        const txt = await window.arcenApi.readFile(isl.metadataRelPath);
        parsed = parseMetadata(txt, isl.name);
      } catch (e) {
        console.warn('[islands] Could not read island metadata:', isl.metadataRelPath, e);
      }
      if (isl.metadataRelPath) allSet.add(isl.metadataRelPath);
      for (const f of (isl.files || [])) {
        relSet.add(f.relativePath);
        allSet.add(f.relativePath);
        if (parsed) map.set(f.relativePath, parsed);
      }
    }
    islandRelPathsRef.current = relSet;
    islandAllRelPathsRef.current = allSet;
    setIslandSchemaByRelPath(map);
    return map;
  }, []);

  // Apply a discoverData() response to both folders state and the layout
  // metadata (mode, expansions, structural errors). Used everywhere we
  // re-discover after a filesystem change. Async because we also reload
  // mod schema extensions — without that, creating a new partial-schema
  // file via "Create partial schema file for this mod…" wouldn't take
  // effect until the next restart.
  const applyDiscovery = useCallback(async (data) => {
    setFolders(data.folders);
    setDataLayout({
      mode: data.mode || 'narrow',
      sharedMetadataRelPath: data.sharedMetadataRelPath || 'SharedMetaData.metadata',
      expansions: data.expansions || [],
      mods: data.mods || [],
      structuralErrors: data.structuralErrors || [],
    });
    setModSchemaExtensionsList(data.schemaExtensions || []);
    await loadExtensionsAndIndex(data.schemaExtensions);
    await loadIslands(data.islands);
  }, [loadExtensionsAndIndex, loadIslands]);

  // ── Startup: discover, parse schemas, load files, build index, validate ──
  useEffect(() => {
    (async () => {
      const data = await window.arcenApi.discoverData();
      setFolders(data.folders);
      const sharedRel = data.sharedMetadataRelPath || 'SharedMetaData.metadata';
      setDataLayout({
        mode: data.mode || 'narrow',
        sharedMetadataRelPath: sharedRel,
        expansions: data.expansions || [],
        mods: data.mods || [],
        structuralErrors: data.structuralErrors || [],
      });

      // Parse shared metadata. parseSharedMetadata returns null on a parse
      // error — at startup that's a corrupt file on disk, not a transient
      // race, so log loudly. Validation will be skipped (sharedSchema stays
      // null) rather than poisoning every file with empty-attribute errors.
      let shared = null;
      if (data.sharedMetadataPath) {
        const sharedContent = await window.arcenApi.readFile(data.sharedMetadataPath);
        shared = parseSharedMetadata(sharedContent);
        if (!shared) console.error('[startup] Failed to parse SharedMetaData.metadata — validation disabled');
        setSharedSchema(shared);
      }

      const schemaMap = {};
      for (const folder of data.folders) {
        // Some folders have data but no metadata anywhere — the editor surfaces
        // those as a "no-schema" structural warning. Skip schema loading for
        // them; their files will still appear in the tree, just without
        // attribute-level validation.
        if (!folder.metadataPath) continue;
        const metaContent = await window.arcenApi.readFile(folder.metadataPath);
        const parsed = parseMetadata(metaContent, folder.name);
        if (parsed) schemaMap[folder.name] = parsed;
        else console.error(`[startup] Failed to parse metadata for folder: ${folder.name}`);
      }
      setSchemas(schemaMap);

      // Load + parse mod schema extensions — `_<TableName>.metadata` files
      // shipped by mods for tables that an earlier layer already owns. These
      // contribute extra attributes and sub_nodes for validation of files in
      // the owning mod (and any mod that requires it). The helper also
      // populates extensionsMetaRef so the file watcher can recognize
      // extension paths and skip the per-folder-overwrite branch.
      setModSchemaExtensionsList(data.schemaExtensions || []);
      const extensionsMap = await loadExtensionsAndIndex(data.schemaExtensions);

      // Parse island standalone schemas (self-contained sources outside
      // Configuration). Deliberately NOT added to the bulk load below, so they
      // stay out of allFileContentsRef / the FK index / the validation worker —
      // their content enters memory only when opened.
      await loadIslands(data.islands);

      // Load ALL XML file contents for FK index + validation
      const bulk = {};
      for (const folder of data.folders) {
        for (const xmlFile of folder.xmlFiles) {
          try {
            bulk[xmlFile.relativePath] = await window.arcenApi.readFile(xmlFile.relativePath);
          } catch (e) {
            console.warn('Could not read:', xmlFile.relativePath);
          }
        }
        // Also load metadata content (if any — schemaless folders skip this).
        if (folder.metadataRelPath) {
          try {
            bulk[folder.metadataRelPath] = await window.arcenApi.readFile(folder.metadataPath);
          } catch (e) { /* skip */ }
        }
      }
      // Also load SharedMetaData.metadata (key matches data.sharedMetadataRelPath
      // — in suite mode this includes the GameData/Configuration/ prefix)
      if (data.sharedMetadataPath) {
        try {
          bulk[sharedRel] = await window.arcenApi.readFile(data.sharedMetadataPath);
        } catch (e) { /* skip */ }
      }
      allFileContentsRef.current = bulk;

      // Build LookupSwaps and FK index. SharedMetaData declares whether this
      // dataset's central identifier is "id" (HotM) or "name" (AIW2); the
      // helper falls back to "id" if shared hasn't loaded yet.
      const centralIdKey = getCentralIdentifierKey(shared);
      lookupSwapsRef.current = buildLookupSwaps(bulk, centralIdKey);
      const index = buildFKIndex(data.folders, bulk, schemaMap, centralIdKey);
      setFkIndex(index);

      // Load dictionary data (fast — just IPC to read files)
      let dictData = { aff: null, dic: null, custom: [], devCustom: [] };
      try {
        dictData = await window.arcenApi.loadSpellingDictionary();
        dictDataRef.current = dictData;
        devWordsRef.current = new Set(dictData.devCustom || []);
      } catch (e) {
        console.error('Failed to load spelling dictionary:', e);
      }

      // Defer spellchecker creation so UI renders first (NSpell parsing is slow)
      setTimeout(() => {
        try {
          if (dictData.aff && dictData.dic) {
            const nspell = new NSpell(dictData.aff, dictData.dic);
            if (dictData.custom?.length) {
              for (const word of dictData.custom) nspell.add(word);
            }
            // Wrap with dev-aware check: dev contexts also consult the dev dictionary.
            // Callers use checker.correct(word, isDev). suggest/add pass through to nspell.
            const checker = makeDevAwareChecker(nspell, devWordsRef);
            spellcheckerRef.current = checker;
            setSpellchecker(checker);
          }
        } catch (e) {
          console.error('Failed to initialize spellchecker:', e);
        }
      }, 100);

      // Create validation worker and run initial validation (non-blocking)
      const worker = new Worker('./validationWorker.bundle.js');
      workerRef.current = worker;
      worker.onmessage = (msg) => {
        if (msg.data.type === 'results') {
          validationBusyRef.current = false;
          const elapsed = validationStartRef.current
            ? ((Date.now() - validationStartRef.current) / 1000).toFixed(1)
            : null;
          validationStartRef.current = null;
          setValidationTiming(elapsed ? { elapsed: elapsed + 's' } : null);
          if (validationTimerRef.current) {
            cancelAnimationFrame(validationTimerRef.current);
            validationTimerRef.current = null;
          }
          // Core validation results — replace only non-spelling/non-grammar entries,
          // preserving any spelling/grammar results from prior dedicated runs.
          //
          // Fast-path no-op: if the worker's new combined results are identical
          // to what we last shipped to the validator window AND identical to
          // current state, skip both the IPC ship and the setState (which
          // would force a new array reference and re-render every consumer).
          // With no real errors in a project, the 30s tick lands here, and
          // what used to be a noticeable stall becomes near-free.
          //
          // The validator-window snapshot is the comparison anchor (not React
          // state): saveFile's synchronous validateXMLFile updates state
          // without telling the validator, so a state-only check used to
          // leave the validator showing pre-save errors forever. Tracking
          // last-sent guarantees the validator catches up the next tick.
          //
          // forceSendValidatorRef short-circuits the no-op for explicit
          // user actions (Re-validate All button) — even byte-identical
          // results need to ship so the button's count-up timer stops.
          const forceSend = forceSendValidatorRef.current;
          forceSendValidatorRef.current = false;
          setValidationErrors((prev) => {
            const newErrors = msg.data.errors || [];
            // Extract prev's core subset in one pass; also keep Spelling AND
            // Grammar entries so periodic core revalidations (and post-save
            // revalidations) don't clobber the LLM grammar results — a
            // Grammar Check run is expensive and the user shouldn't lose
            // those entries every time the worker ticks.
            const prevCore = [];
            const prevKept = [];
            for (const e of prev) {
              // Island-file errors are produced by the live island-validation
              // effect (the worker never sees island files), so preserve them
              // here exactly like Spelling/Grammar — otherwise each core tick
              // would wipe them.
              if (e.message.startsWith('Spelling:') || e.message.startsWith('Grammar (') || islandRelPathsRef.current.has(e.file)) {
                prevKept.push(e);
              } else {
                prevCore.push(e);
              }
            }

            const combined = [...newErrors, ...prevKept];

            // Equality of two error lists by the fields the UI cares about.
            const sameList = (a, b) => {
              if (a.length !== b.length) return false;
              for (let i = 0; i < a.length; i++) {
                const x = a[i], y = b[i];
                if (
                  x.severity !== y.severity ||
                  x.line !== y.line ||
                  x.file !== y.file ||
                  x.message !== y.message
                ) return false;
              }
              return true;
            };

            const stateUnchanged = sameList(prevCore, newErrors);
            const validatorUpToDate = sameList(lastSentValidatorRef.current, combined);

            if (forceSend || !validatorUpToDate) {
              window.arcenApi.sendValidationResults(combined);
              lastSentValidatorRef.current = combined;
            }
            return stateUnchanged ? prev : combined;
          });
        }
      };

      // Post initial validation to worker. Use `fullContents` — this is
      // the first message to the worker and it needs the complete map.
      // We also seed the worker-shadow map so subsequent incremental
      // posts can ship only deltas.
      validationBusyRef.current = true;
      validationStartRef.current = Date.now();
      setValidationTiming({ running: true });
      workerShadowRef.current = new Map(Object.entries(bulk));
      worker.postMessage({
        type: 'validate',
        folders: data.folders,
        fullContents: bulk,
        schemas: schemaMap,
        sharedSchema: shared,
        fkIndex: index,
        lookupSwaps: lookupSwapsRef.current,
        includeSpelling: false,
        structuralErrors: structuralErrorsToEntries(data.structuralErrors || []),
        schemaExtensions: extensionsMap,
        // Build the layer-info maps directly from the just-discovered data —
        // the useMemo hasn't re-derived from React state yet at this exact
        // point (we're still inside the startup useEffect).
        ...(() => {
          const lm = buildLayerMaps(data.expansions, data.mods);
          return {
            expansionDirNameToLayer: lm.expansionDirNameToLayer,
            modFolderNameToLayer: lm.modFolderNameToLayer,
            modDisplayByLayer: lm.modDisplayByLayer,
            modExtrasByLayer: lm.modExtrasByLayer,
          };
        })(),
      });

      // Warm up a persistent pool of spellcheck workers in the background.
      // Each worker pre-parses the dictionary so subsequent spellchecks are much faster.
      // This runs after initial validation is posted so it doesn't block app startup.
      // Once warmed up, automatically kick off a spelling scan so the user sees
      // misspelling counts in the footer without having to click anything.
      setTimeout(() => {
        const POOL_SIZE = 4;
        const dd = dictDataRef.current;
        if (!dd.aff || !dd.dic) return;
        let warmedCount = 0;
        for (let p = 0; p < POOL_SIZE; p++) {
          const sw = new Worker('./validationWorker.bundle.js');
          spellingWorkerPoolRef.current.push(sw);
          sw.onmessage = (msg) => {
            if (msg.data && msg.data.type === 'warmup-done') {
              warmedCount++;
              if (warmedCount >= POOL_SIZE) {
                // All workers ready — run initial spelling scan automatically
                runSpellingCheckRef.current?.();
              }
            }
          };
          sw.postMessage({
            type: 'warmup',
            dictAff: dd.aff,
            dictDic: dd.dic,
            customWords: dd.custom,
            devWords: dd.devCustom,
          });
        }
      }, 500);

      // Restore session
      const savedSession = await window.arcenApi.loadSession();
      if (savedSession.theme) setTheme(savedSession.theme);
      if (savedSession.expandedFolders) {
        setExpandedFolders(new Set(savedSession.expandedFolders));
      }
      if (savedSession.sidebarWidth) {
        setSidebarWidth(savedSession.sidebarWidth);
      }
      if (savedSession.sidebarSide === 'left' || savedSession.sidebarSide === 'right') {
        setSidebarSide(savedSession.sidebarSide);
      }
      if (savedSession.globalSearchHeight) {
        setGlobalSearchHeight(savedSession.globalSearchHeight);
      }
      if (savedSession.editorScale) {
        setEditorScale(savedSession.editorScale);
      }
      if (savedSession.globalSearchIncludeMods != null) {
        setGlobalSearchIncludeMods(!!savedSession.globalSearchIncludeMods);
      }
      if (savedSession.globalSearchScopeFilter) {
        setGlobalSearchScopeFilter(savedSession.globalSearchScopeFilter);
      }
      if (savedSession.refPanelScale) {
        setRefPanelScale(savedSession.refPanelScale);
      }
      // Per-tab data (cursor, scroll, ref panel) is now in the central file state registry
      // — EditorPane loads it directly via getFileState on mount

      // Favorites are now part of the session file. The legacy shared file
      // (if present) was merged into the session by main.js's loadSession
      // migration on startup, so reading from savedSession is enough.
      if (Array.isArray(savedSession.favorites)) {
        setFavorites(savedSession.favorites);
      }

      if (savedSession.tabs?.length) {
        const restoredTabs = [];
        const restoredContents = {};
        const restoredSaved = {};
        const seen = new Set();
        for (const rawPath of savedSession.tabs) {
          // Normalize legacy session entries that were saved with
          // Windows backslashes — dedupe so we don't end up with two
          // tabs for the same file after the normalization collapses them.
          const relPath = typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/') : rawPath;
          if (seen.has(relPath)) continue;
          seen.add(relPath);
          let content = bulk[relPath];
          if (content === undefined) {
            // Not in the bulk load — e.g. an island .asset (or island metadata),
            // which are loaded lazily, not bulk-loaded. Read it on demand so the
            // tab (and the last-active selection) is restored. Skip if gone.
            try {
              content = await window.arcenApi.readFile(relPath);
              allFileContentsRef.current[relPath] = content;
            } catch (_) { content = undefined; }
          }
          if (content !== undefined) {
            restoredTabs.push({
              relativePath: relPath,
              type: relPath.endsWith('.metadata') ? 'schema' : 'xml',
            });
            restoredContents[relPath] = content;
            restoredSaved[relPath] = content;
          }
        }
        setTabs(restoredTabs);
        setFileContents(restoredContents);
        setSavedContents(restoredSaved);
        setActiveTabIndex(savedSession.activeTab ?? 0);
      }
      sessionLoadedRef.current = true;
    })();
  }, []);

  // ── Tab history tracking + auto-switch sidebar ──
  const prevActiveRef = useRef(-1);
  useEffect(() => {
    if (prevActiveRef.current >= 0 && prevActiveRef.current !== activeTabIndex) {
      tabHistoryRef.current.push(prevActiveRef.current);
      if (tabHistoryRef.current.length > 50) tabHistoryRef.current.shift();
    }
    prevActiveRef.current = activeTabIndex;

    // Back/forward navigation history
    const tab = tabs[activeTabIndex];
    if (tab && !navSkipRef.current) {
      const nav = navHistoryRef.current;
      // If we're not at the end, truncate forward history
      if (nav.pos < nav.list.length - 1) {
        nav.list = nav.list.slice(0, nav.pos + 1);
      }
      // Don't push duplicates
      if (nav.list[nav.list.length - 1] !== tab.relativePath) {
        nav.list.push(tab.relativePath);
        if (nav.list.length > 50) nav.list.shift();
      }
      nav.pos = nav.list.length - 1;
    }
    navSkipRef.current = false;
    // Update nav button state
    const nav = navHistoryRef.current;
    setNavState({ canBack: nav.pos > 0, canForward: nav.pos < nav.list.length - 1 });

    // Auto-switch sidebar to match the active tab's layer. Mod files (xml AND
    // schema) always pull the sidebar to MODS, since they're hidden in the
    // Explorer. Everything else (xml AND non-mod schema, which now comingle in
    // the Explorer) bounces off the MODS tab back to Files. Favorites is left
    // alone.
    if (tab) {
      const want = sidebarTabForPath(tab.relativePath);
      // Island/mod files pull the sidebar to their own tab; everything else
      // bounces off mods/islands back to the Explorer. Favorites is left alone.
      if (want !== 'files') {
        if (sidebarTab !== want) setSidebarTab(want);
      } else if (sidebarTab === 'mods' || sidebarTab === 'islands') {
        setSidebarTab('files');
      }
      // Feed the cross-window "center on active" target.
      window.arcenApi.reportActiveFile?.(tab.relativePath);
    }
  }, [activeTabIndex, tabs]);

  // ── Theme ──
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.arcenApi.sendTheme(theme);
  }, [theme]);

  // Broadcast and listen for editor scale changes across windows
  useEffect(() => {
    window.arcenApi.sendEditorScale(editorScale);
  }, [editorScale]);
  useEffect(() => {
    window.arcenApi.sendRefPanelScale(refPanelScale);
  }, [refPanelScale]);
  useEffect(() => {
    window.arcenApi.onEditorScaleChange((scale) => setEditorScale(scale));
    window.arcenApi.onRefPanelScaleChange((scale) => setRefPanelScale(scale));
  }, []);

  // ── VCS / Plugin store ──
  useEffect(() => {
    vcsStore.init();
  }, []);

  // ── Active file of every open window (for sidebar highlight) ──
  useEffect(() => {
    window.arcenApi.getActiveFiles?.()
      .then((f) => { if (Array.isArray(f)) setActiveFiles(f); })
      .catch(() => {});
    window.arcenApi.onActiveFilesChanged?.((f) => setActiveFiles(Array.isArray(f) ? f : []));
  }, []);

  // ── Multi-window: tab removed/added by main process ──
  useEffect(() => {
    // Normalize path separators on every path that crosses an IPC
    // boundary. Main emits forward-slash paths, but hardening here
    // prevents a single mis-routed backslash from creating a duplicate
    // keyed entry in tabs / fileContents / savedContents.
    const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
    window.arcenApi.onTabRemoved((raw) => {
      const relativePath = norm(raw);
      setTabs(prev => {
        const idx = prev.findIndex(t => t.relativePath === relativePath);
        if (idx < 0) return prev;
        const filtered = prev.filter(t => t.relativePath !== relativePath);
        // Adjust activeTabIndex
        setActiveTabIndex(current => {
          if (current >= filtered.length) return Math.max(0, filtered.length - 1);
          if (current > idx) return current - 1;
          return current;
        });
        return filtered;
      });
      setTimeout(() => {
        setTabs(current => {
          window.arcenApi.registerWindowTabs(current.map(t => t.relativePath));
          return current;
        });
      }, 100);
    });

    window.arcenApi.onTabAdded(async (raw) => {
      const relativePath = norm(raw);
      const content = await window.arcenApi.readFile(relativePath);
      const type = relativePath.endsWith('.metadata') ? 'schema' : 'xml';
      setTabs(prev => {
        if (prev.some(t => t.relativePath === relativePath)) return prev;
        setActiveTabIndex(prev.length);
        return [...prev, { relativePath, type }];
      });
      setFileContents(prev => ({ ...prev, [relativePath]: content }));
      setSavedContents(prev => ({ ...prev, [relativePath]: content }));
      allFileContentsRef.current[relativePath] = content;
      setTimeout(() => {
        setTabs(current => {
          window.arcenApi.registerWindowTabs(current.map(t => t.relativePath));
          return current;
        });
      }, 100);
    });

    window.arcenApi.onFocusSidebarOnFile((raw, opts) => {
      const relativePath = norm(raw);
      // Route to the tab that actually contains this file: mod files live in
      // MODS, everything else (xml + non-mod schema) in the Explorer. Then
      // expand its folder and scroll to it. opts.highlight (set by a detached
      // window's deliberate "Center sidebar on this") flashes the row; the
      // passive sync on detached tab-switch / editor click leaves it off.
      setSidebarTab(sidebarTabForPath(relativePath));
      setScrollSidebarTo(opts?.highlight ? relativePath : { path: relativePath, highlight: false });
      const folderName = folderNameOf(relativePath);
      setExpandedFolders(prev => new Set(prev).add(folderName));
    });

    window.arcenApi.onUpdateFavorites?.((newFavorites) => {
      // A detached window toggled a favorite — apply here. saveWindowState's
      // dependence on `favorites` then pushes the change back to main, which
      // writes it into the session file. Single-writer model preserved.
      setFavorites(newFavorites);
    });

    window.arcenApi.onFocusTab((raw) => {
      const relativePath = norm(raw);
      const idx = tabsRef.current.findIndex(t => t.relativePath === relativePath);
      if (idx >= 0) setActiveTabIndex(idx);
    });
    window.arcenApi.onOpenGlobalSearch((query, replace, detachedFile) => {
      // Blur the editor synchronously so any keys the user types between
      // the IPC arrival and the panel mount go to <body> instead of
      // leaking into the document.
      try { editorViewRef.current?.contentDOM.blur(); } catch (_) {}
      if (query) setGlobalSearchQuery(query);
      setGlobalSearch({ replace: !!replace, detachedFile: detachedFile || null });
      const focusInput = () => {
        const el = globalSearchInputRef.current;
        if (!el) return false;
        if (query) el.value = query;
        el.select();
        el.focus();
        return true;
      };
      // Fast path: panel was already open — focus on the same tick so muscle
      // memory works (no 100ms gap where keys hit the editor). If the panel
      // is being mounted fresh, fall back to rAF instead of a fixed timeout.
      if (!focusInput()) requestAnimationFrame(focusInput);
    });
    // Registered once; onFocusTab reads current tabs via tabsRef. Re-running
    // this on every `tabs` change used to stack duplicate IPC listeners.
  }, []);

  // Register main window tabs on startup
  useEffect(() => {
    if (sessionLoadedRef.current) {
      window.arcenApi.registerWindowTabs(tabs.map(t => t.relativePath));
    }
  }, [tabs]);

  // ── Handle replace requests from validation window ──
  useEffect(() => {
    // Apply a spelling replacement to one file's content, constrained to the
    // text spellchecking targets — so a fix never bleeds into id / central-
    // identifier values (the reported AI War `name`-key bug), tag names, FK
    // refs, etc. Returns content unchanged when the file has no spellcheckable
    // ranges (no schema, or nothing to fix), so untargeted files are left alone.
    const replaceSpellingInFile = (file, content, oldText, newText) => {
      // Never rewrite an island embedded-XML file (view-only; writing decoded
      // XML would clobber the YAML). Belt-and-suspenders: islands also have no
      // resolvable schema here, so they'd produce no ranges anyway.
      if (islandRelPathsRef.current.has(file)) return content;
      const isMetadata = file.toLowerCase().endsWith('.metadata');
      let mergedSchema = null;
      if (!isMetadata) {
        const folderName = folderNameByRelPathRef.current?.get(file);
        const fileSchema = (folderName && schemasLatest.current) ? schemasLatest.current[folderName] : null;
        mergedSchema = (fileSchema && sharedSchemaLatest.current)
          ? buildMergedSchema(sharedSchemaLatest.current, fileSchema)
          : null;
      }
      const ranges = spellcheckableValueRanges(content, mergedSchema, isMetadata);
      if (ranges.length === 0) return content;
      return replaceWithinRanges(content, oldText, newText, ranges);
    };

    window.arcenApi.onRequestReplace((file, oldText, newText) => {
      const content = allFileContentsRef.current[file];
      if (!content) return;
      const updated = replaceSpellingInFile(file, content, oldText, newText);
      if (updated !== content) {
        allFileContentsRef.current[file] = updated;
        // Use functional update to check CURRENT state — the effect's [] deps means
        // the closure's `fileContents` is frozen at mount (empty), so a direct check
        // would always skip the update and the editor would show stale content while
        // savedContents advances, incorrectly flagging the tab as modified.
        setFileContents((prev) => {
          if (prev[file] === undefined) return prev;
          return { ...prev, [file]: updated };
        });
        window.arcenApi.writeFile(file, updated);
        setSavedContents((prev) => ({ ...prev, [file]: updated }));

        // Remove matching spelling entries from validation state so they don't
        // pop back when periodic revalidation re-sends the results.
        // Match format: `Spelling: "oldText" ...` in the same file.
        const prefix = `Spelling: "${oldText}"`;
        setValidationErrors((prev) => {
          const filtered = prev.filter((e) =>
            !(e.file === file && e.message.startsWith(prefix))
          );
          if (filtered.length !== prev.length) {
            window.arcenApi.sendValidationResults(filtered);
          }
          return filtered;
        });

        // Mark the live-rescan cache with the post-replace content so an immediate
        // undo (which reverts content back to the pre-replace version) is detected
        // as a change and triggers a rescan — otherwise the cache would still hold
        // the original content and the effect would think nothing changed, leaving
        // the spelling entry missing.
        lastLiveRescanContentRef.current[file] = updated;
      }
    });
    window.arcenApi.onRequestIgnoreNode((file, absPos) => {
      const content = allFileContentsRef.current[file];
      if (!content || typeof absPos !== 'number') return;
      // Find enclosing open tag via a simple scan — we don't need full tokenization
      // since the structure we care about is just `<tagname ... [absPos is inside] ...>`.
      // Walk forward tracking the most recent `<` not yet closed by `>`.
      let insertAt = -1;
      let hasAttr = false;
      let i = 0;
      while (i < content.length) {
        if (content[i] === '<' && i + 1 < content.length && /[A-Za-z_]/.test(content[i + 1])) {
          const ltPos = i;
          // Skip tag name
          let j = i + 1;
          while (j < content.length && /[A-Za-z0-9_:-]/.test(content[j])) j++;
          const tagNameEnd = j;
          // Find closing > or /> — but must ignore '>' inside quoted attr values
          let k = j;
          let inQuote = null;
          while (k < content.length) {
            const ch = content[k];
            if (inQuote) {
              if (ch === inQuote) inQuote = null;
            } else {
              if (ch === '"' || ch === "'") inQuote = ch;
              else if (ch === '>') break;
            }
            k++;
          }
          const gtEnd = k;
          if (absPos >= ltPos && absPos <= gtEnd) {
            // Check for existing no_spellcheck_or_grammar between tagNameEnd and gtEnd
            const tagBody = content.slice(tagNameEnd, gtEnd);
            if (/\bno_spellcheck_or_grammar\s*=/.test(tagBody)) hasAttr = true;
            // Insert before the closing bracket so the new attribute appears at
            // the END of the node. For self-closing `/>`, step back past the `/`.
            else insertAt = (content[gtEnd - 1] === '/') ? gtEnd - 1 : gtEnd;
            break;
          }
          i = k + 1;
        } else {
          i++;
        }
      }
      if (hasAttr || insertAt < 0) return;
      const insertText = ' no_spellcheck_or_grammar="true"';
      // If this file is currently open in the active editor, dispatch the edit
      // through CM6 so the view stays put (no scroll jump, no cursor reset).
      // The editor's updateListener will propagate the change back up through
      // onChange → setFileContents as usual. We detect "is this the right file"
      // by comparing the live view's doc to the cached content for this file
      // — both the initial effect closure and a tabs ref are avoided this way.
      const view = editorViewRef.current;
      const viewMatchesFile = view && view.state.doc.toString() === content;
      if (viewMatchesFile) {
        view.dispatch({ changes: { from: insertAt, insert: insertText } });
        // Persist + keep side caches in sync (updateListener has already updated
        // fileContents state and called writeFile via onChange indirectly? No —
        // onChange only updates fileContents, doesn't write. Write explicitly.)
        const updated = view.state.doc.toString();
        allFileContentsRef.current[file] = updated;
        window.arcenApi.writeFile(file, updated);
        setSavedContents((prev) => ({ ...prev, [file]: updated }));
        lastLiveRescanContentRef.current[file] = updated;
      } else {
        const updated = content.slice(0, insertAt) + insertText + content.slice(insertAt);
        allFileContentsRef.current[file] = updated;
        setFileContents((prev) => {
          if (prev[file] === undefined) return prev;
          return { ...prev, [file]: updated };
        });
        window.arcenApi.writeFile(file, updated);
        setSavedContents((prev) => ({ ...prev, [file]: updated }));
        lastLiveRescanContentRef.current[file] = updated;
      }
      // Drop validation entries for this file whose absPos falls inside this tag
      setValidationErrors((prev) => {
        const gtInserted = insertAt; // entries after this point shift by the inserted length
        // Remove spelling entries for this file whose absPos is inside [ltPos..gtEnd]
        // We don't track ltPos outside; easiest: drop all spelling entries for this file
        // within the affected tag by re-running validation. For immediate feedback, strip
        // spelling entries whose absPos is within a reasonable window near the insert.
        const filtered = prev.filter((e) => {
          if (e.file !== file) return true;
          if (!e.message.startsWith('Spelling:')) return true;
          if (typeof e.absPos !== 'number') return true;
          // Drop entries in the same tag (we don't have exact tag bounds here, but the
          // ignore node attribute causes the worker to skip them on next pass).
          return false;
        });
        if (filtered.length !== prev.length) {
          window.arcenApi.sendValidationResults(filtered);
        }
        return filtered;
      });
      // Trigger revalidation so only truly-affected entries are removed and shifts are correct
      setTimeout(() => revalidateAll(), 50);
    });
    window.arcenApi.onRequestReplaceAll((oldText, newText) => {
      // First pass: mutate the bulk content cache (a ref, not React state) so
      // every consumer that reads from it after this handler returns sees the
      // updated values. Collect the modified files for the React-state pass below.
      const modifiedFiles = [];
      for (const [file, content] of Object.entries(allFileContentsRef.current)) {
        const updated = replaceSpellingInFile(file, content, oldText, newText);
        if (updated !== content) {
          allFileContentsRef.current[file] = updated;
          window.arcenApi.writeFile(file, updated);
          // Keep live-rescan cache in sync so undo (or any later content change
          // back to the pre-replace bytes) is detected as a real change.
          lastLiveRescanContentRef.current[file] = updated;
          modifiedFiles.push(file);
        }
      }
      if (modifiedFiles.length === 0) return;

      // Second pass: a SINGLE atomic update for both fileContents and savedContents.
      // The previous version queued one setFileContents per file inside a loop;
      // when many files were modified at once (which is the typical case here —
      // every file with at least one occurrence), the per-file functional updates
      // weren't reliably propagating to inactive tabs, so switching to those
      // tabs still showed the pre-replace content. One reducer call ensures
      // every key lands in the new state before any consumer reads it.
      setFileContents((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const file of modifiedFiles) {
          if (next[file] === undefined) continue; // file not open as a tab
          const updated = allFileContentsRef.current[file];
          if (next[file] !== updated) {
            next[file] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setSavedContents((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const file of modifiedFiles) {
          const updated = allFileContentsRef.current[file];
          if (next[file] !== updated) {
            next[file] = updated;
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      // Remove matching spelling entries so they don't pop back on next revalidation
      const prefix = `Spelling: "${oldText}"`;
      setValidationErrors((prev) => {
        const filtered = prev.filter((e) => !e.message.startsWith(prefix));
        if (filtered.length !== prev.length) {
          window.arcenApi.sendValidationResults(filtered);
        }
        return filtered;
      });
      // Re-validate after bulk replace
      setTimeout(() => revalidateAll(), 500);
    });
  }, []);

  // Keep refs to latest state for file watcher (avoids stale closures)
  const fileContentsLatest = useRef(fileContents);
  const savedContentsLatest = useRef(savedContents);
  const schemasLatest = useRef(schemas);
  const sharedSchemaLatest = useRef(sharedSchema);
  const fkIndexLatest = useRef(fkIndex);
  const foldersLatest = useRef(folders);
  const expansionDirNameToLayerLatest = useRef(expansionDirNameToLayer);
  const layerMapsLatest = useRef(layerMaps);
  const schemaExtensionsLatest = useRef(schemaExtensions);
  // Lookup map for the file watcher: which on-disk `.metadata` paths are mod
  // schema EXTENSIONS (as opposed to base / per-folder metadata). Without
  // this, an edit to `XMLMods/Reclaimers/GameEntity/_GameEntity.metadata`
  // would fall through the per-folder branch in applyMetadata and overwrite
  // the real base GameEntity schema with the extension's much-shorter
  // attribute list. Rebuilt on every discovery refresh via loadExtensionsAndIndex.
  const extensionsMetaRef = useRef(new Map());
  useEffect(() => { fileContentsLatest.current = fileContents; }, [fileContents]);
  useEffect(() => { savedContentsLatest.current = savedContents; }, [savedContents]);
  useEffect(() => { schemasLatest.current = schemas; }, [schemas]);
  useEffect(() => { sharedSchemaLatest.current = sharedSchema; }, [sharedSchema]);
  useEffect(() => { fkIndexLatest.current = fkIndex; }, [fkIndex]);
  useEffect(() => { foldersLatest.current = folders; }, [folders]);
  useEffect(() => { expansionDirNameToLayerLatest.current = expansionDirNameToLayer; }, [expansionDirNameToLayer]);
  useEffect(() => { layerMapsLatest.current = layerMaps; }, [layerMaps]);
  useEffect(() => { schemaExtensionsLatest.current = schemaExtensions; }, [schemaExtensions]);

  // Per-path retry timers for metadata reads that arrived mid-write. Keyed by
  // relPath so a fresh change event for the same file always supersedes any
  // retry chain still pending for it — we never have two loops racing on the
  // same path. Other paths keep their independent retry state.
  const metadataRetryTimersRef = useRef(new Map());

  // Fold one XML file's *current cached content* into the FK index, in place.
  //
  // Recomputes only that file's table (every layer) from allFileContentsRef and
  // advances BOTH the synchronous source-of-truth ref (fkIndexLatest.current)
  // and React state, then returns the fresh index. Centralizing it here is what
  // lets a brand-new core node become referenceable without a restart, no matter
  // which path introduced it:
  //   - in-app save        → saveFile calls this and validates against the result
  //   - external tool / VCS → the on-disk watcher calls this on reload
  //   - another window      → same on-disk watcher path
  //
  // Two deliberate choices:
  //   1. Base the rebuild on fkIndexLatest.current (the ref), never a render
  //      closure. Within a single save the `fkIndex` closure still predates the
  //      node the user just wrote, which is exactly the bug this fixes.
  //   2. Advance fkIndexLatest.current SYNCHRONOUSLY. The deferred re-validation
  //      in saveFile — and any sibling save in the same tick (Save All) — then
  //      sees the new node immediately instead of waiting for a React commit.
  //
  // Stable identity ([] deps, all inputs via refs) so the once-registered file
  // watcher can call it without capturing a stale version.
  const foldXmlFileIntoFKIndex = useCallback((relPath) => {
    const folderName = folderNameOf(relPath);
    const folder = foldersLatest.current.find((f) => f.name === folderName);
    const schema = schemasLatest.current[folderName];
    if (!folder || !schema || !schema.nodeName) return fkIndexLatest.current;
    const layeredContents = folder.xmlFiles.map((xf) => ({
      layer: xf.layer || 'base',
      content: allFileContentsRef.current[xf.relativePath] || '',
    }));
    const centralIdKey = getCentralIdentifierKey(sharedSchemaLatest.current);
    const next = { ...fkIndexLatest.current };
    updateTableIndex(next, folderName, layeredContents, schema.nodeName, schemasLatest.current, centralIdKey);
    fkIndexLatest.current = next;
    setFkIndex(next);
    return next;
  }, []);

  // ── File watcher (registered once, uses refs for latest state) ──
  useEffect(() => {
    // Normalize Windows-style backslash separators to forward slashes so
    // every key in allFileContentsRef / fileContents / savedContents uses
    // one canonical form. Without this, `0_Language\Lng_Debug.xml` and
    // `0_Language/Lng_Debug.xml` become two distinct entries — global
    // search then reports the same file twice. The main-side broadcasts
    // are already normalized; this is defense-in-depth for any future
    // code path that sneaks a raw `path.relative` result through.
    const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
    window.arcenApi.onFileChangedOnDisk((rawRelPath) => {
      const relPath = norm(rawRelPath);
      if (recentSavesRef.current.has(relPath)) return;

      window.arcenApi.readFile(relPath).then((content) => {
        const currentContent = fileContentsLatest.current[relPath];
        const currentSaved = savedContentsLatest.current[relPath];

        if (currentContent !== undefined && currentContent !== currentSaved) {
          // File has unsaved edits — compare disk to editor
          if (content === currentContent) {
            setSavedContents((prev) => ({ ...prev, [relPath]: content }));
            allFileContentsRef.current[relPath] = content;
            return;
          }
          // Disk matches our last-saved content → this is an echo of our own
          // save (chokidar sometimes fires late, past the recentSaves window)
          // or an external tool rewrote the file with identical bytes (Git
          // checkout to the same commit, SVN keyword expansion that doesn't
          // change content, etc). Not a real conflict — don't yank the user
          // out of editing with a reload bar.
          if (content === currentSaved) {
            allFileContentsRef.current[relPath] = content;
            return;
          }
          setDiskConflicts((prev) => prev.some((c) => c === relPath) ? prev : [...prev, relPath]);
          return;
        }

        // No unsaved edits — check if disk content differs from what we have cached
        if (content === allFileContentsRef.current[relPath]) {
          return; // No actual change, skip
        }
        // Always update the bulk cache
        allFileContentsRef.current[relPath] = content;

        // Keep the FK index current for externally-changed XML — a node added by
        // another window, an external editor, or a VCS update must be
        // referenceable here without a restart, exactly like an in-app save.
        // (.metadata files take the schema-reparse path below instead.)
        if (!relPath.endsWith('.metadata')) {
          foldXmlFileIntoFKIndex(relPath);
        }

        // Force the live-rescan effect to schedule a fresh scan after this disk
        // reload — without this nudge, an externally-modified file could leave
        // the validator window stale even though the editor's inline squiggles
        // already reflect the new content. We use a non-string sentinel so the
        // effect's "cache === content" check is guaranteed to be false (any
        // string content !== sentinel object) AND the "cache === undefined"
        // first-time-observation check is also false (so the timer actually
        // schedules instead of being skipped).
        lastLiveRescanContentRef.current[relPath] = LIVE_RESCAN_FORCE;

        // If it's open in a tab, update the editor state too. This effect is
        // registered with an empty dependency list (uses refs for latest state),
        // so we must use fileContentsLatest.current here — checking `fileContents`
        // directly would see the stale initial `{}` closure and never reload
        // the editor pane, which is how a post-save revert could leave stale
        // content visible even though the cache was updated.
        if (fileContentsLatest.current[relPath] !== undefined) {
          setFileContents((prev) => ({ ...prev, [relPath]: content }));
          setSavedContents((prev) => ({ ...prev, [relPath]: content }));
        }

        // If it's a metadata file, re-parse the schema for that folder.
        // parseMetadata/parseSharedMetadata return null when DOMParser hits a
        // <parsererror> — common when an external tool (SVN/Git) is mid-write
        // and we caught the file in an inconsistent state. Pushing an empty
        // schema into state would flag every attribute in every file as
        // unknown, so we keep the prior schema and retry until the on-disk
        // file settles. Slow drives (network shares, antivirus scans, large
        // SVN updates) can take many seconds, so we poll once a second up to
        // 30 attempts (~30s total) before giving up.
        if (relPath.endsWith('.metadata')) {
          const applyMetadata = (text) => {
            if (relPath === dataLayout.sharedMetadataRelPath) {
              const newShared = parseSharedMetadata(text);
              if (!newShared) return false;
              // DOMParser accepts an XML file that's well-formed but empty
              // (e.g. `<root/>` — which is exactly what a mid-write SVN/Git
              // revert can produce between truncate and real write). Going
              // from N>0 shared attributes to 0 would storm every XML file
              // with "unknown attribute" warnings for id/sort_order/etc.
              // Treat as transient and retry — if the file really is empty
              // now, the retry loop will eventually accept it once it's
              // been stable for 30s.
              const prior = sharedSchemaLatest.current;
              if (newShared.attributes.length === 0 && prior?.attributes?.length > 0) {
                return false;
              }
              setSharedSchema(newShared);
              return true;
            }
            // Schema-extension branch. Has to come BEFORE the per-folder
            // branch — an extension file like
            // `XMLMods/Reclaimers/GameEntity/_GameEntity.metadata` has the
            // same folderName ("GameEntity") as the base table, so falling
            // through would clobber the real GameEntity schema with the
            // extension's much-shorter attribute list and flag valid
            // attributes as unknown across every base file in the table.
            const extInfo = extensionsMetaRef.current.get(relPath);
            if (extInfo) {
              const parsedExt = parseMetadata(text, extInfo.folderName);
              if (!parsedExt) return false;
              // Extensions are allowed to be empty (the "Create partial
              // schema file for this mod…" shell ships as bare
              // `<root></root>`), so we DON'T do the empty-attrs guard
              // here — an extension going from N attrs back to 0 is a
              // legitimate user edit.
              setSchemaExtensions((prev) => {
                const layerMap = { ...(prev[extInfo.modLayer] || {}) };
                layerMap[extInfo.folderName] = parsedExt;
                return { ...prev, [extInfo.modLayer]: layerMap };
              });
              return true;
            }
            const folderName = folderNameOf(relPath);
            const newSchema = parseMetadata(text, folderName);
            if (!newSchema) return false;
            // Same empty-parse guard for per-folder metadata — an empty
            // table schema would drop that folder from the FK index and
            // flag its sub-node attrs as unknown across every file in it.
            const priorFolder = schemasLatest.current[folderName];
            const priorAttrCount = (priorFolder?.attributes?.length || 0)
              + (priorFolder?.subNodes?.reduce((n, sn) => n + (sn.attributes?.length || 0), 0) || 0);
            const newAttrCount = newSchema.attributes.length
              + newSchema.subNodes.reduce((n, sn) => n + (sn.attributes?.length || 0), 0);
            if (newAttrCount === 0 && priorAttrCount > 0) return false;
            setSchemas((prev) => ({ ...prev, [folderName]: newSchema }));
            return true;
          };

          // Cancel any retry chain still pending for this exact path — this
          // event is the most recent ground truth, and any older chain still
          // ticking would just re-read the same file we're about to read,
          // wasting work and risking a stale write landing after a newer one.
          const timers = metadataRetryTimersRef.current;
          const prior = timers.get(relPath);
          if (prior) {
            clearTimeout(prior);
            timers.delete(relPath);
          }

          const scheduleRetry = (attemptsLeft) => {
            const timer = setTimeout(() => {
              // Only proceed if we're still the active chain for this path —
              // a newer event may have replaced us between schedule and fire.
              if (timers.get(relPath) !== timer) return;
              timers.delete(relPath);
              window.arcenApi.readFile(relPath).then((retryContent) => {
                if (applyMetadata(retryContent)) return;
                if (attemptsLeft <= 1) {
                  console.warn(`[file-watcher] metadata parse still failing after 30 retries: ${relPath}`);
                  return;
                }
                scheduleRetry(attemptsLeft - 1);
              }).catch(() => {
                if (attemptsLeft <= 1) {
                  console.warn(`[file-watcher] metadata read keeps failing for: ${relPath}`);
                  return;
                }
                scheduleRetry(attemptsLeft - 1);
              });
            }, 1000);
            timers.set(relPath, timer);
          };

          if (!applyMetadata(content)) scheduleRetry(30);
        }
      });
    });

    // Sidebar refresh on external add/remove. chokidar fires a burst of
    // events for operations like a folder rename (unlink+add for every
    // file inside) or a bulk git update, so we debounce into a single
    // discoverData round-trip. Only the file list shown in the sidebar
    // is rebuilt here — open editor content is already handled by the
    // file-changed-on-disk listener above.
    const refreshTimerRef = { timer: null };
    const scheduleSidebarRefresh = () => {
      if (refreshTimerRef.timer) clearTimeout(refreshTimerRef.timer);
      refreshTimerRef.timer = setTimeout(async () => {
        refreshTimerRef.timer = null;
        try {
          const data = await window.arcenApi.discoverData();
          applyDiscovery(data);
        } catch (e) {
          console.warn('[file-watcher] sidebar refresh failed:', e);
        }
      }, 150);
    };
    window.arcenApi.onFileAddedOnDisk(() => scheduleSidebarRefresh());
    window.arcenApi.onFileRemovedOnDisk((relPath) => {
      // If an open tab's file was deleted on disk, the tab still exists
      // in state but any future read will fail. Don't auto-close — the
      // user may be mid-rename and the file will come back. Just refresh
      // the sidebar so the file disappears from the tree.
      scheduleSidebarRefresh();
    });
  }, []); // registered once; uses refs for latest state

  // Capture the current editor's full selection state (in-memory, for tab switching)
  const captureSelectionNow = useCallback(() => {
    const view = editorViewRef.current;
    const tab = tabs[activeTabIndex];
    if (view && tab) {
      const sel = view.state.selection.main;
      selectionStateRef.current[tab.relativePath] = { anchor: sel.anchor, head: sel.head };
    }
  }, [tabs, activeTabIndex]);

  // ── Back/forward navigation ──
  const navigateBack = useCallback(() => {
    const nav = navHistoryRef.current;
    if (nav.pos <= 0) return;
    captureSelectionNow();
    // Find a valid previous entry (skip closed tabs)
    let newPos = nav.pos - 1;
    while (newPos >= 0) {
      const path = nav.list[newPos];
      const idx = tabs.findIndex(t => t.relativePath === path);
      if (idx >= 0) {
        nav.pos = newPos;
        navSkipRef.current = true;
        setActiveTabIndex(idx);
        setNavState({ canBack: newPos > 0, canForward: newPos < nav.list.length - 1 });
        return;
      }
      // Remove closed tab from history
      nav.list.splice(newPos, 1);
      nav.pos = Math.min(nav.pos, nav.list.length - 1);
      newPos--;
    }
  }, [tabs, captureSelectionNow]);

  const navigateForward = useCallback(() => {
    const nav = navHistoryRef.current;
    if (nav.pos >= nav.list.length - 1) return;
    captureSelectionNow();
    let newPos = nav.pos + 1;
    while (newPos < nav.list.length) {
      const path = nav.list[newPos];
      const idx = tabs.findIndex(t => t.relativePath === path);
      if (idx >= 0) {
        nav.pos = newPos;
        navSkipRef.current = true;
        setActiveTabIndex(idx);
        setNavState({ canBack: newPos > 0, canForward: newPos < nav.list.length - 1 });
        return;
      }
      nav.list.splice(newPos, 1);
    }
  }, [tabs, captureSelectionNow]);

  // Mouse button 4/5 for back/forward
  useEffect(() => {
    const handler = (e) => {
      if (e.button === 3) { e.preventDefault(); navigateBack(); }
      if (e.button === 4) { e.preventDefault(); navigateForward(); }
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [navigateBack, navigateForward]);

  // Wrapped setActiveTabIndex that captures selection before switching
  const switchTab = useCallback((newIndex) => {
    captureSelectionNow();
    setActiveTabIndex(newIndex);
  }, [captureSelectionNow]);

  // ── Session persistence ──
  // Per-tab data (cursor, scroll, ref panel) is handled by EditorPane → central file state registry.
  // Window-level state is pushed to main process via sync IPC on every change.
  const sessionLoadedRef = useRef(false);
  const saveWindowState = useCallback(() => {
    if (!sessionLoadedRef.current) return;
    window.arcenApi.saveWindowState({
      tabs: tabs.map((t) => t.relativePath),
      activeTab: activeTabIndex,
      expandedFolders: [...expandedFolders],
      sidebarTab,
      sidebarWidth,
      sidebarSide,
      globalSearchHeight,
      editorScale,
      refPanelScale,
      theme,
      globalSearchIncludeMods,
      globalSearchScopeFilter,
      favorites,
    });
  }, [tabs, activeTabIndex, expandedFolders, sidebarTab, sidebarWidth, sidebarSide, globalSearchHeight, editorScale, refPanelScale, theme, globalSearchIncludeMods, globalSearchScopeFilter, favorites]);

  // Push window state to main process whenever it changes (debounced)
  useEffect(() => {
    const timer = setTimeout(saveWindowState, 300);
    return () => clearTimeout(timer);
  }, [saveWindowState]);

  // Favorites are persisted as part of saveWindowState above — no separate
  // shared-prefs file anymore.

  // ── Modified files set ──
  const modifiedFiles = useMemo(() => new Set(
    tabs
      .filter((t) => fileContents[t.relativePath] !== savedContents[t.relativePath])
      .map((t) => t.relativePath)
  ), [tabs, fileContents, savedContents]);

  // ── Open file ──
  const openFile = useCallback(async (relativePath, type = 'xml') => {
    // Capture current selection before switching
    captureSelectionNow();
    // Normalize path separators to forward slashes
    const normPath = relativePath.replace(/\\/g, '/');

    const existing = tabs.findIndex((t) => t.relativePath === normPath);
    if (existing >= 0) {
      setActiveTabIndex(existing);
      return;
    }

    // Check if file is open in another window
    const otherWindow = await window.arcenApi.findWindowForTab(normPath);
    if (otherWindow?.found) return; // other window was focused

    // Always read from disk when opening a file — the in-memory cache may be stale
    // if an external process modified the file and the watcher missed it
    const content = await window.arcenApi.readFile(normPath);
    allFileContentsRef.current[normPath] = content;

    setTabs((prev) => {
      // Double-check inside updater to prevent race conditions
      const dup = prev.findIndex((t) => t.relativePath === normPath);
      if (dup >= 0) {
        setActiveTabIndex(dup);
        return prev;
      }
      setActiveTabIndex(prev.length);
      return [...prev, { relativePath: normPath, type }];
    });
    setFileContents((prev) => ({ ...prev, [normPath]: content }));
    setSavedContents((prev) => ({ ...prev, [normPath]: content }));

    // Auto-switch sidebar to match file context. Mod files always pull the
    // sidebar to the MODS tab (since they're hidden everywhere else). Everything
    // else — xml and non-mod schema, which now comingle in the Explorer —
    // bounces off MODS back to Files. Favorites is left alone.
    const opensInMod = /^mod_/.test(layerByRelPathRef.current.get(normPath)?.layer || '');
    const opensInIsland = islandAllRelPathsRef.current.has(normPath);
    if (opensInIsland) {
      if (sidebarTab !== 'islands') setSidebarTab('islands');
    } else if (opensInMod) {
      if (sidebarTab !== 'mods') setSidebarTab('mods');
    } else if (sidebarTab === 'mods' || sidebarTab === 'islands') {
      setSidebarTab('files');
    }

    // Auto-expand folder
    const folderName = folderNameOf(normPath);
    setExpandedFolders((prev) => new Set(prev).add(folderName));
  }, [tabs, sidebarTab]);

  // ── Close tab ──
  const closeTab = useCallback((index) => {
    const tab = tabs[index];
    if (!tab) return;
    const isModified = fileContents[tab.relativePath] !== savedContents[tab.relativePath];
    if (isModified && !confirm(`${tab.relativePath} has unsaved changes. Close anyway?`)) return;

    // Find the best tab to switch to: walk history for a valid previous tab
    // In main window, only consider tabs of the same type (schema vs xml)
    const closedType = tab.type;
    let nextIndex = -1;
    if (activeTabIndex === index) {
      const history = tabHistoryRef.current;
      while (history.length > 0) {
        let prev = history.pop();
        if (prev === index) continue;
        if (prev > index) prev--;
        if (prev >= 0 && prev < tabs.length - 1) {
          // In main window, only jump to same-type tabs
          if (tabs[prev + (prev >= index ? 1 : 0)]?.type === closedType || tabs[prev]?.type === closedType) {
            nextIndex = prev;
            break;
          }
        }
      }
      if (nextIndex < 0) {
        // Fallback: find nearest tab of the same type
        for (let d = 1; d < tabs.length; d++) {
          if (index - d >= 0 && tabs[index - d].type === closedType) { nextIndex = index - d; break; }
          if (index + d < tabs.length && tabs[index + d].type === closedType) { nextIndex = index + d > index ? index + d - 1 : index + d; break; }
        }
        // If no same-type tab, fall back to adjacent
        if (nextIndex < 0) {
          nextIndex = index > 0 ? index - 1 : (tabs.length > 1 ? 0 : -1);
        }
      }
    } else {
      nextIndex = activeTabIndex > index ? activeTabIndex - 1 : activeTabIndex;
    }

    // Clear history entries for the closed tab and adjust indices
    tabHistoryRef.current = tabHistoryRef.current
      .filter(i => i !== index)
      .map(i => i > index ? i - 1 : i);

    setTabs((prev) => prev.filter((_, i) => i !== index));
    setFileContents((prev) => {
      const next = { ...prev };
      delete next[tab.relativePath];
      return next;
    });
    setActiveTabIndex(nextIndex);
  }, [tabs, activeTabIndex, fileContents, savedContents]);

  // ── Save file + re-validate + update FK index ──
  const saveFile = useCallback(async (relativePath) => {
    // Island embedded-XML files: the editor holds the decoded inner XML; the
    // main process re-encodes it back into the YAML's `xml:` field, preserving
    // the rest of the file (and the user's whitespace) exactly. Skip the normal
    // FK-index / worker-validation path — islands aren't in `folders`; the live
    // island-validation effect covers them.
    if (islandRelPathsRef.current.has(relativePath)) {
      const islandContent = fileContents[relativePath];
      if (islandContent === undefined) return;
      try {
        await window.arcenApi.writeFile(relativePath, islandContent);
      } catch (e) {
        alert(`Could not save ${relativePath}: ${e?.message || e}`);
        return;
      }
      allFileContentsRef.current[relativePath] = islandContent;
      setSavedContents((prev) => ({ ...prev, [relativePath]: islandContent }));
      recentSavesRef.current.add(relativePath);
      setTimeout(() => recentSavesRef.current.delete(relativePath), 5000);
      return;
    }
    const content = fileContents[relativePath];
    if (content === undefined) return;
    await window.arcenApi.writeFile(relativePath, content);
    setSavedContents((prev) => ({ ...prev, [relativePath]: content }));
    allFileContentsRef.current[relativePath] = content;
    // Suppress reload bar for this file for a few seconds
    recentSavesRef.current.add(relativePath);
    setTimeout(() => recentSavesRef.current.delete(relativePath), 5000);

    const folderName = folderNameOf(relativePath);
    const folder = folders.find((f) => f.name === folderName);

    // If this is a metadata file, re-parse the schema
    if (relativePath.endsWith('.metadata')) {
      // SharedMetaData.metadata is the shared schema inherited by every table.
      // Re-parse it with the shared parser and update sharedSchema so
      // downstream validation / FK handling picks up newly-defined attributes
      // without needing a restart.
      if (relativePath === dataLayout.sharedMetadataRelPath) {
        const newShared = parseSharedMetadata(content);
        if (!newShared) {
          console.warn('[saveFile] Skipped sharedSchema update — SharedMetaData.metadata failed to parse');
        } else {
          // Same guard as the file-watcher path: don't overwrite a non-empty
          // shared schema with an empty one (see applyMetadata comment).
          const prior = sharedSchemaLatest.current;
          if (newShared.attributes.length === 0 && prior?.attributes?.length > 0) {
            console.warn('[saveFile] Skipped sharedSchema update — parsed to 0 attributes; keeping prior');
          } else {
            setSharedSchema(newShared);
          }
        }
        // A separate useEffect below watches sharedSchema and kicks off
        // revalidation when it changes — this ensures the latest revalidateAll
        // closure is used (with the already-updated sharedSchema).
      } else {
        // Extension branch FIRST — has to come before the per-folder branch
        // for the same reason the file-watcher's applyMetadata does: an
        // extension file like XMLMods/ForgeOfEmpires/GameEntity/_GameEntity.metadata
        // shares folderName="GameEntity" with the base table, so falling
        // through to setSchemas would clobber the real base GameEntity
        // schema with the extension's much-shorter attribute list AND the
        // extension would never propagate to schemaExtensions state.
        // Symptom the user saw: "added a new partial schema, defined the
        // sub_node, nothing on validation until I restarted." Discovery
        // populated extensionsMetaRef correctly after the create, but
        // subsequent saves of that file went through this saveFile branch
        // (not the file-watcher path), and saveFile didn't check.
        const extInfo = extensionsMetaRef.current.get(relativePath);
        if (extInfo) {
          const parsedExt = parseMetadata(content, extInfo.folderName);
          if (parsedExt) {
            // Mutate the ref directly so revalidateAll's 50ms setTimeout call
            // below sees the new extensions even before React commits the
            // setState below (useEffect updates the ref AFTER render — too
            // late for a same-tick worker post). Without this, the user
            // saves their extension, revalidateAll runs against still-stale
            // schemaExtensionsLatest, and validation looks unchanged until
            // the next 30s periodic tick (or full restart).
            const prevExt = schemaExtensionsLatest.current;
            const newExt = {
              ...prevExt,
              [extInfo.modLayer]: {
                ...(prevExt[extInfo.modLayer] || {}),
                [extInfo.folderName]: parsedExt,
              },
            };
            schemaExtensionsLatest.current = newExt;
            setSchemaExtensions(newExt);
            // Revalidate so attributes/sub_nodes the user just added are
            // immediately reflected in the validator list (otherwise the
            // user sees "Unknown attribute" errors until the next manual
            // revalidate or the periodic worker tick).
            setTimeout(() => {
              revalidateAll();
              try { runSpellingCheckRef.current?.(); } catch (_) {}
            }, 50);
          } else {
            console.warn(`[saveFile] Skipped extension update — ${relativePath} failed to parse`);
          }
        } else {
          const newSchema = parseMetadata(content, folderName);
          if (newSchema) {
            setSchemas((prev) => ({ ...prev, [folderName]: newSchema }));
            // Revalidate + respellcheck so the validator list reflects the new attr
            // types (e.g. string → sub_id should remove spelling entries). Squiggles
            // update automatically via the ViewPlugin, but validator state does not.
            setTimeout(() => {
              revalidateAll();
              try { runSpellingCheckRef.current?.(); } catch (_) {}
            }, 50);
          } else {
            console.warn(`[saveFile] Skipped schema update — metadata for ${folderName} failed to parse`);
          }
        }
      }
      return; // schema files don't need FK index or XML validation
    }

    const schema = schemas[folderName];
    // Incrementally fold this file's just-saved content into the FK index and
    // capture the fresh index. The deferred re-validation below MUST validate
    // against this (not the `fkIndex` render closure): when the save introduces
    // a new core node AND a reference to it in the same file, the closure
    // predates the new node, so it would flag the reference as "not found"
    // until a restart rebuilt the index from disk. The helper also rebuilds the
    // compound `Parent:Child` (sub-source) pair set, so `node_sub_source`
    // cross-table references stay current too. No-ops gracefully (returning the
    // latest index) for files whose table has no nodeName.
    const postSaveFkIndex = foldXmlFileIntoFKIndex(relativePath);

    // Re-validate this file (deferred to avoid blocking save)
    if (sharedSchema && schema && !schema.neverValidate) {
      const merged = buildMergedSchema(sharedSchema, schema);
      setTimeout(() => {
        try {
          const savedLayer = folder?.xmlFiles.find((xf) => xf.relativePath === relativePath)?.layer || 'base';
          const lm = layerMapsLatest.current;
          // Compose schema with applicable mod extensions for this file's layer.
          const composed = composeSchemaForFileLayer(
            merged, schemaExtensionsLatest.current, lm.modExtrasByLayer, savedLayer, folderName
          );
          const newErrors = validateXMLFile(content, relativePath, composed, postSaveFkIndex, lookupSwapsRef.current, {
            layer: savedLayer,
            folderName,
            expansionDirNameToLayer: lm.expansionDirNameToLayer,
            modFolderNameToLayer: lm.modFolderNameToLayer,
            modDisplayByLayer: lm.modDisplayByLayer,
            fileModExtras: lm.modExtrasByLayer[savedLayer] || null,
          });
          setValidationErrors((prev) => {
            const without = prev.filter((e) => e.file !== relativePath);
            const combined = [...without, ...newErrors];
            // Push the post-save snapshot to the validator window too. Without
            // this, an open validator (or one the user opens later) keeps
            // displaying pre-save errors for this file: the synchronous
            // setValidationErrors above only updates in-renderer state, and
            // the next worker tick used to no-op because state already
            // matched. The user reported clicking Re-validate All several
            // times after a save with no visible change — this was why.
            window.arcenApi.sendValidationResults(combined);
            lastSentValidatorRef.current = combined;
            return combined;
          });
        } catch (e) {
          console.error('File validation failed:', e);
        }
      }, 50);
    }
  }, [fileContents, folders, schemas, sharedSchema, foldXmlFileIntoFKIndex]);

  // ── Update content ──
  const updateContent = useCallback((relativePath, newContent) => {
    setFileContents((prev) => ({ ...prev, [relativePath]: newContent }));
    allFileContentsRef.current[relativePath] = newContent;
  }, []);

  // Helper: get single-line selected text from the editor
  const getEditorSelectedText = useCallback(() => {
    // Check browser selection first — reflects whichever CM6 instance (main or ref panel) has focus
    const browserSel = window.getSelection()?.toString()?.trim() || '';
    if (browserSel && !browserSel.includes('\n')) return browserSel;
    // Fallback: main editor's CM6 selection (may have selection even when not focused)
    const view = editorViewRef.current;
    if (view) {
      const sel = view.state.selection.main;
      if (sel.from !== sel.to) {
        const text = view.state.sliceDoc(sel.from, sel.to);
        if (!text.includes('\n')) return text;
      }
    }
    return '';
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      // Ctrl+Z undo global replace (when global search panel is open)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && globalSearch && globalReplaceUndoRef.current.length > 0) {
        e.preventDefault();
        const op = globalReplaceUndoRef.current.pop();
        if (op) {
          for (const { file, oldContent, newContent } of op.files) {
            if (allFileContentsRef.current[file] === newContent) {
              setFileContents((prev) => ({ ...prev, [file]: oldContent }));
              allFileContentsRef.current[file] = oldContent;
            }
          }
          setGlobalUndoCount(globalReplaceUndoRef.current.length);
        }
        return;
      }
      // Escape closes diff view
      if (e.key === 'Escape' && diffTabIndex !== null) {
        e.preventDefault();
        setDiffTabIndex(null);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && !e.altKey) {
        e.preventDefault();
        const tab = tabs[activeTabIndex];
        if (tab) {
          if (e.shiftKey) {
            tabs.forEach((t) => saveFile(t.relativePath));
          } else {
            saveFile(tab.relativePath);
          }
        }
      }
      // Ctrl+Shift+F — global search (toggles replace off if already in replace mode)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        // Synchronously blur the editor so keys the user types in the
        // window between this event and the input getting focus go to
        // <body> (and drop) rather than leaking into the document. The
        // unconditional setTimeout that used to live here was a 100ms
        // window where fast typists could land 5+ chars in the editor.
        try { editorViewRef.current?.contentDOM.blur(); } catch (_) {}
        const sel = getEditorSelectedText();
        if (sel) setGlobalSearchQuery(sel);
        setGlobalSearch({ replace: false });
        const focusInput = () => {
          const el = globalSearchInputRef.current;
          if (!el) return false;
          if (sel) el.value = sel;
          el.select();
          el.focus();
          return true;
        };
        // Fast path when the panel is already mounted — no React render
        // needed, focus on the same tick. Fall back to rAF (not a fixed
        // 100ms) when mounting fresh.
        if (!focusInput()) requestAnimationFrame(focusInput);
      }
      // Ctrl+Shift+H — global search+replace, focus replace field
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'H') {
        e.preventDefault();
        try { editorViewRef.current?.contentDOM.blur(); } catch (_) {}
        const sel = getEditorSelectedText();
        if (sel) setGlobalSearchQuery(sel);
        setGlobalSearch({ replace: true });
        const focusReplace = () => {
          if (sel && globalSearchInputRef.current) {
            globalSearchInputRef.current.value = sel;
          }
          const el = globalSearchReplaceRef.current;
          if (!el) return false;
          el.select();
          el.focus();
          return true;
        };
        if (!focusReplace()) requestAnimationFrame(focusReplace);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabIndex, saveFile, diffTabIndex, globalSearch]);

  // ── FK navigation (Ctrl+click) ──
  const handleNavigateToFK = useCallback((tableName, id) => {
    navigateToFKRow(tableName, id, {
      folders,
      getContent: (p) => allFileContentsRef.current[p],
      openFile,
      scrollTo: ({ file, line, highlight }) =>
        setPendingScrollLine({ _t: Date.now(), file, line, highlight }),
    });
  }, [folders, openFile]);

  // Shadow of what the worker currently has. Updated after every successful
  // post so the next call can ship only the delta instead of the full file
  // content map. On a medium-size project, structured-cloning the full map
  // across the postMessage boundary was costing ~300–500 ms of main-thread
  // time per validate, which is most of the visible "validation freeze."
  const workerShadowRef = useRef(new Map());

  // Post a validate message to the worker, shipping only changed file
  // contents vs the shadow. With `full: true`, sends the whole map and
  // resets the shadow — used by manual revalidate + startup so the worker
  // can recover from any drift. Returns true if a message was actually
  // posted (i.e. worker wasn't busy and sharedSchema was ready).
  const postValidateToWorker = useCallback((opts = {}) => {
    const {
      full = false,
      folders: foldersArg,
      schemas: schemasArg,
      sharedSchema: sharedArg,
      fkIndex: fkArg,
      lookupSwaps: swapsArg,
      includeSpelling = false,
    } = opts;
    if (validationBusyRef.current || !workerRef.current) return false;
    const shared = sharedArg ?? sharedSchemaLatest.current;
    if (!shared) return false;

    const contents = allFileContentsRef.current;
    const msg = {
      type: 'validate',
      folders: foldersArg ?? folders,
      schemas: schemasArg ?? schemasLatest.current,
      sharedSchema: shared,
      fkIndex: fkArg ?? fkIndexLatest.current,
      lookupSwaps: swapsArg ?? lookupSwapsRef.current,
      includeSpelling,
      structuralErrors: structuralErrorsRef.current,
      expansionDirNameToLayer: layerMapsLatest.current.expansionDirNameToLayer,
      modFolderNameToLayer: layerMapsLatest.current.modFolderNameToLayer,
      modDisplayByLayer: layerMapsLatest.current.modDisplayByLayer,
      modExtrasByLayer: layerMapsLatest.current.modExtrasByLayer,
      schemaExtensions: schemaExtensionsLatest.current,
    };

    if (full) {
      msg.fullContents = contents;
      // Reset shadow to mirror what the worker now has. Use a fresh Map
      // populated from the current contents object.
      workerShadowRef.current = new Map(Object.entries(contents));
    } else {
      // Diff: only ship paths whose string value has actually changed, plus
      // the set of paths the worker should drop. String `!==` on equal
      // values is O(1) via interning in V8 for most cases; even when not,
      // equal strings short-circuit on length mismatch fast.
      const changes = {};
      const shadow = workerShadowRef.current;
      let anyChange = false;
      for (const [p, c] of Object.entries(contents)) {
        if (shadow.get(p) !== c) {
          changes[p] = c;
          shadow.set(p, c);
          anyChange = true;
        }
      }
      const removed = [];
      for (const p of shadow.keys()) {
        if (!(p in contents)) {
          removed.push(p);
          shadow.delete(p);
          anyChange = true;
        }
      }
      if (anyChange) {
        msg.contentChanges = changes;
        if (removed.length) msg.contentRemoved = removed;
      }
      // No anyChange means contents haven't moved since the last post;
      // worker reuses its cache. We still need to send a validate message
      // (schemas or fkIndex may have changed), just with no content delta.
    }

    validationBusyRef.current = true;
    validationStartRef.current = Date.now();
    setValidationTiming({ running: true });
    workerRef.current.postMessage(msg);
    return true;
  }, [folders]);

  // ── Fast revalidate: hand current in-memory state to the worker ──
  //
  // No disk reads, no metadata re-parse, no FK index rebuild. Used by the
  // periodic 30-second tick after any save happened. All of that heavier
  // work is already done at the point of change:
  //   - XML save: saveFile does an incremental FK index update.
  //   - .metadata save: saveFile calls revalidateAll explicitly.
  //   - external edit: file-watcher updates allFileContentsRef + schemas.
  //
  // So by the time the 30s tick fires, the refs already hold the correct
  // state. Doing the full disk-refresh + re-parse + rebuild path here was
  // costing ~1 s of main-thread time and showing up as a typing freeze.
  const postWorkerValidation = useCallback(() => {
    postValidateToWorker({ full: false });
  }, [postValidateToWorker]);

  // ── Re-validate all (for button/window) — debounced and non-blocking ──
  const validateGenRef = useRef(0);
  const revalidateAll = useCallback(async () => {
    if (!sharedSchema) return;
    // Re-read SharedMetaData from disk. This is the recovery path for the
    // case where in-memory sharedSchema has drifted (empty, or missing
    // attributes) for any reason — a bad transient read that slipped past
    // the guards, a state race, whatever. Without this, the only way to
    // recover was a full restart, because revalidateAll used to only rebuild
    // per-folder schemas. Disk is the source of truth for this file; if it
    // parses cleanly with a non-empty attr list, adopt it. If it doesn't
    // parse or is empty, leave sharedSchema alone.
    let effectiveShared = sharedSchema;
    const sharedRel = dataLayout.sharedMetadataRelPath;
    try {
      const diskContent = await window.arcenApi.readFile(sharedRel);
      allFileContentsRef.current[sharedRel] = diskContent;
      const diskShared = parseSharedMetadata(diskContent);
      if (diskShared && diskShared.attributes.length > 0) {
        // Only flip state if disk differs from current — avoids an extra
        // render / sharedSchema-useEffect fire on the common case.
        const curLen = sharedSchema.attributes?.length || 0;
        const diskLen = diskShared.attributes.length;
        if (curLen !== diskLen) {
          setSharedSchema(diskShared);
        }
        effectiveShared = diskShared;
      }
    } catch (_) {}

    // Refresh ALL file caches from disk (picks up changes from detached windows, external tools)
    for (const folder of folders) {
      for (const xmlFile of folder.xmlFiles) {
        try {
          allFileContentsRef.current[xmlFile.relativePath] = await window.arcenApi.readFile(xmlFile.relativePath);
        } catch (_) {}
      }
      // Also refresh metadata (only for folders that have one — schemaless
      // folders contribute XML data only).
      const metaRelPath = folder.metadataRelPath;
      if (metaRelPath) {
        try {
          const metaContent = await window.arcenApi.readFile(metaRelPath);
          allFileContentsRef.current[metaRelPath] = metaContent;
          // Re-parse schema from refreshed metadata. parseMetadata returns null
          // on parse failure — keep the prior schema so a transient bad read
          // doesn't drop the table from FK index and storm errors across files.
          const newSchema = parseMetadata(metaContent, folder.name);
          if (newSchema) setSchemas((prev) => ({ ...prev, [folder.name]: newSchema }));
        } catch (_) {}
      }
    }
    // Also refresh mod schema extensions from disk — without this, edits
    // made externally (or fixes made via the editor that bypassed the
    // saveFile extension branch for any reason) would only be reflected
    // after a restart. Rebuilds schemaExtensionsLatest.current and pushes
    // setSchemaExtensions so the worker post below picks them up.
    const refreshedExt = {};
    for (const ext of modSchemaExtensionsList) {
      try {
        const txt = await window.arcenApi.readFile(ext.metadataRelPath);
        allFileContentsRef.current[ext.metadataRelPath] = txt;
        const parsed = parseMetadata(txt, ext.folderName);
        if (parsed) {
          if (!refreshedExt[ext.modLayer]) refreshedExt[ext.modLayer] = {};
          refreshedExt[ext.modLayer][ext.folderName] = parsed;
        }
      } catch (_) {}
    }
    // Only flip state if something actually changed shape — avoids an
    // unnecessary render. The size check is a cheap-and-dirty equality
    // proxy; deep-equal would be more correct but extensions are tiny
    // and the worst case here is one extra render.
    schemaExtensionsLatest.current = refreshedExt;
    setSchemaExtensions(refreshedExt);
    // Rebuild FK index and lookup swaps with fresh data. If parseMetadata
    // returns null for any folder, fall back to the schema already in state
    // — pushing null into latestSchemas would drop that table's IDs from
    // the FK index and flag every cross-table reference as invalid.
    const latestSchemas = {};
    const priorSchemas = schemasLatest.current;
    for (const folder of folders) {
      const metaRelPath = folder.metadataRelPath;
      if (!metaRelPath) continue; // schemaless folder — nothing to parse
      try {
        const parsed = parseMetadata(allFileContentsRef.current[metaRelPath], folder.name);
        latestSchemas[folder.name] = parsed || priorSchemas[folder.name];
      } catch (_) {
        latestSchemas[folder.name] = priorSchemas[folder.name];
      }
    }
    const centralIdKey = getCentralIdentifierKey(sharedSchemaLatest.current);
    const freshIndex = buildFKIndex(folders, allFileContentsRef.current, latestSchemas, centralIdKey);
    // Advance the synchronous source-of-truth ref too (not just state), so an
    // incremental fold from a save/watch event in this same tick bases off this
    // full rebuild instead of clobbering it with a stale single-table update.
    fkIndexLatest.current = freshIndex;
    setFkIndex(freshIndex);
    lookupSwapsRef.current = buildLookupSwaps(allFileContentsRef.current, centralIdKey);

    // Post to worker (non-blocking). Manual revalidate re-read everything
    // from disk, so send the full content map — the shadow may contain
    // stale strings for files that were reverted externally to their
    // previous content (which would look unchanged byte-for-byte, but the
    // disk-refresh still blew away the shadow's reference semantics we
    // rely on for `!==` shortcut equality). Seeding the shadow again here
    // keeps the next periodic tick's diff correct.
    postValidateToWorker({
      full: true,
      schemas: latestSchemas,
      // Use effectiveShared — if we just re-read disk and got a better
      // sharedSchema, the state update hasn't committed yet this tick,
      // so passing `sharedSchema` here would still validate against the
      // stale (empty) version and the user's "revalidate" would look
      // useless until they clicked it a second time.
      sharedSchema: effectiveShared,
      fkIndex: freshIndex,
      includeSpelling: false,
    });
  }, [folders, sharedSchema, postValidateToWorker, modSchemaExtensionsList]);

  // When sharedSchema changes (e.g. the user edited SharedMetaData.metadata and
  // defined a new attribute), rerun core validation so previously-unknown
  // attributes no longer complain. Skip the very first render (the initial
  // validation is handled by the startup effect).
  const sharedSchemaFirstRef = useRef(true);
  useEffect(() => {
    if (sharedSchemaFirstRef.current) {
      sharedSchemaFirstRef.current = false;
      return;
    }
    if (!sharedSchema) return;
    const timer = setTimeout(() => revalidateAll(), 50);
    return () => clearTimeout(timer);
  }, [sharedSchema, revalidateAll]);


  // Spelling check — parallelized across multiple workers.
  // 4 is a sweet spot: ~250ms parallel phase vs ~120ms at 10 workers, but
  // saves ~60MB of memory (each worker holds a parsed Hunspell dictionary).
  const SPELLING_WORKER_COUNT = 4;
  const spellingBusyRef = useRef(false);
  const runSpellingCheck = useCallback(async () => {
    if (!sharedSchema || spellingBusyRef.current) {
      // Click happened while another spelling pass is in flight (or before
      // the shared schema finished loading). The validator window started
      // a count-up timer the moment the user clicked; with no follow-up
      // sendValidationResults it would tick forever. Re-ship the current
      // results so the timer cleanup fires and the button reverts to
      // "Spelling Check (0.0s)" — accurate feedback that nothing new ran.
      try {
        window.arcenApi.sendValidationResults(lastSentValidatorRef.current);
      } catch (_) {}
      return;
    }

    // Refresh file caches
    for (const folder of folders) {
      for (const xmlFile of folder.xmlFiles) {
        try {
          allFileContentsRef.current[xmlFile.relativePath] = await window.arcenApi.readFile(xmlFile.relativePath);
        } catch (_) {}
      }
      const metaRelPath = folder.metadataRelPath;
      if (metaRelPath) {
        try {
          allFileContentsRef.current[metaRelPath] = await window.arcenApi.readFile(metaRelPath);
        } catch (_) {}
      }
    }

    const latestSchemas = {};
    for (const folder of folders) {
      const metaRelPath = folder.metadataRelPath;
      if (!metaRelPath) continue;
      try {
        latestSchemas[folder.name] = parseMetadata(allFileContentsRef.current[metaRelPath], folder.name);
      } catch (_) {}
    }

    spellingBusyRef.current = true;

    // Split folders across N workers using greedy bin-packing by total file size.
    // Each chunk is a list of folders; we assign each folder to the chunk with the
    // smallest current total size. This balances the workload since folders vary
    // wildly in size (e.g. 0_Language has much more text than most others).
    const workerCount = Math.min(SPELLING_WORKER_COUNT, folders.length);
    const chunks = Array.from({ length: workerCount }, () => ({ folders: [], totalSize: 0 }));

    // Compute folder size = sum of its file contents lengths
    const folderSizes = folders.map((folder) => {
      let size = 0;
      for (const xmlFile of folder.xmlFiles) {
        const content = allFileContentsRef.current[xmlFile.relativePath];
        if (content) size += content.length;
      }
      const metaRelPath = folder.metadataRelPath;
      if (metaRelPath && allFileContentsRef.current[metaRelPath]) {
        size += allFileContentsRef.current[metaRelPath].length;
      }
      return { folder, size };
    });

    // Sort descending by size, then greedily assign each to the lightest chunk
    folderSizes.sort((a, b) => b.size - a.size);
    for (const { folder, size } of folderSizes) {
      let lightest = chunks[0];
      for (const c of chunks) {
        if (c.totalSize < lightest.totalSize) lightest = c;
      }
      lightest.folders.push(folder);
      lightest.totalSize += size;
    }

    // Use persistent worker pool if available; create on demand otherwise.
    // Workers stay alive with pre-parsed dictionaries so subsequent spellchecks are fast.
    let pool = spellingWorkerPoolRef.current;
    if (pool.length < workerCount) {
      // Pool not fully warmed up yet — create missing workers now
      const dd = dictDataRef.current;
      while (pool.length < workerCount) {
        const sw = new Worker('./validationWorker.bundle.js');
        pool.push(sw);
        sw.postMessage({
          type: 'warmup',
          dictAff: dd.aff,
          dictDic: dd.dic,
          customWords: dd.custom,
          devWords: dd.devCustom,
        });
      }
    }
    let completedWorkers = 0;
    const allSpellingErrors = [];

    for (let i = 0; i < workerCount; i++) {
      const chunkFolders = chunks[i].folders;
      if (chunkFolders.length === 0) {
        completedWorkers++;
        if (completedWorkers >= workerCount) {
          spellingBusyRef.current = false;
          setValidationErrors((prev) => {
            const nonSpelling = prev.filter((e) => !e.message.startsWith('Spelling:'));
            const combined = [...nonSpelling, ...allSpellingErrors];
            window.arcenApi.sendValidationResults(combined);
            lastSentValidatorRef.current = combined;
            return combined;
          });
        }
        continue;
      }

      // Build a subset of allFileContents for this chunk
      const chunkContents = {};
      for (const folder of chunkFolders) {
        for (const xmlFile of folder.xmlFiles) {
          chunkContents[xmlFile.relativePath] = allFileContentsRef.current[xmlFile.relativePath];
        }
        const metaRelPath = folder.metadataRelPath;
        if (allFileContentsRef.current[metaRelPath]) {
          chunkContents[metaRelPath] = allFileContentsRef.current[metaRelPath];
        }
      }

      // Build a subset of schemas for this chunk
      const chunkSchemas = {};
      for (const folder of chunkFolders) {
        if (latestSchemas[folder.name]) {
          chunkSchemas[folder.name] = latestSchemas[folder.name];
        }
      }

      const sw = pool[i];
      sw.onmessage = (msg) => {
        if (msg.data.type === 'results') {
          const spellingErrors = msg.data.errors.filter((e) => e.message.startsWith('Spelling:'));
          allSpellingErrors.push(...spellingErrors);

          completedWorkers++;
          if (completedWorkers >= workerCount) {
            // All workers done — merge results (single state update at end).
            // Safety net: if a word was added to the dictionary DURING the scan,
            // the worker may still have reported it. Drop any results whose word
            // is now in the live custom dictionary (global) or dev dictionary
            // (for dev entries only).
            spellingBusyRef.current = false;
            const customSet = new Set(dictDataRef.current?.custom || []);
            const devSet = devWordsRef.current;
            const filteredResults = allSpellingErrors.filter((e) => {
              const m = e.message.match(/^Spelling: "([^"]+)"/);
              if (!m) return true;
              const word = m[1];
              if (customSet.has(word)) return false;
              if (e.isDev && devSet.has(word)) return false;
              return true;
            });
            setValidationErrors((prev) => {
              const nonSpelling = prev.filter((e) => !e.message.startsWith('Spelling:'));
              const combined = [...nonSpelling, ...filteredResults];
              window.arcenApi.sendValidationResults(combined);
              lastSentValidatorRef.current = combined;
              return combined;
            });
          }
        }
      };

      // No need to resend dict data — the worker already has it from warmup
      sw.postMessage({
        type: 'spellcheck-only',
        folders: chunkFolders,
        allFileContents: chunkContents,
        schemas: chunkSchemas,
        sharedSchema,
      });
    }
  }, [folders, sharedSchema]);

  // Keep ref in sync so startup warmup can kick off a scan once workers are ready
  useEffect(() => { runSpellingCheckRef.current = runSpellingCheck; }, [runSpellingCheck]);

  // Per-folder schema changes revalidate via an explicit trigger in saveFile
  // (see perFolderSchemaChangedRef). We CAN'T use a useEffect on [schemas] here:
  // revalidateAll itself calls setSchemas() with a new object reference every
  // pass (re-parsing metadata from disk), which would create an infinite loop.

  // ── Grammar LLM check (Phase 2) ──
  // Reads the on-disk grammar cache so unchanged text doesn't pay for a
  // fresh API call, dispatches only the uncached items to the Anthropic
  // API (via main-process IPC), persists results back to the cache, and
  // populates the validator with the results minus anything the user has
  // dismissed for that exact text.
  const grammarBusyRef = useRef(false);
  const grammarTimerRef = useRef(null);
  const [grammarTimerDisplay, setGrammarTimerDisplay] = useState(null);
  const [grammarRunning, setGrammarRunning] = useState(false);
  const runGrammarCheck = useCallback(async () => {
    if (grammarBusyRef.current) return;

    // Gate on configuration: if the user hasn't set up the API key + model,
    // surface the settings modal instead of running.
    let settings;
    try {
      settings = await window.arcenApi.grammarLLMLoadSettings();
    } catch (e) {
      console.error('Failed to load grammar LLM settings:', e);
      return;
    }
    if (!settings.enabled || !settings.apiKey) {
      document.dispatchEvent(new CustomEvent('grammarSettingsRequested'));
      // Re-emit current validation results so the validator's "Grammar..." timer
      // cleanup fires and the button rearms — without this, the button stays
      // stuck showing the timer because no results event ever arrives.
      setValidationErrors((prev) => {
        window.arcenApi.sendValidationResults(prev);
        return prev;
      });
      return;
    }

    grammarBusyRef.current = true;
    setGrammarRunning(true);
    const startTime = Date.now();
    grammarTimerRef.current = setInterval(() => {
      setGrammarTimerDisplay(((Date.now() - startTime) / 1000).toFixed(1) + 's');
    }, 200);

    try {
      // Refresh file caches in parallel — same shape as the spellcheck path.
      const readJobs = [];
      for (const folder of folders) {
        for (const xmlFile of folder.xmlFiles) {
          readJobs.push(
            window.arcenApi.readFile(xmlFile.relativePath)
              .then((c) => { allFileContentsRef.current[xmlFile.relativePath] = c; })
              .catch(() => {})
          );
        }
        const metaRelPath = folder.metadataRelPath;
        readJobs.push(
          window.arcenApi.readFile(metaRelPath)
            .then((c) => { allFileContentsRef.current[metaRelPath] = c; })
            .catch(() => {})
        );
      }
      await Promise.all(readJobs);

      // Re-parse metadata so the schema's spell/grammar-target rules are fresh.
      const latestSchemas = {};
      for (const folder of folders) {
        const metaRelPath = folder.metadataRelPath;
        try {
          latestSchemas[folder.name] = parseMetadata(allFileContentsRef.current[metaRelPath], folder.name);
        } catch (_) {}
      }

      // Walk each XML file, collect grammar targets. We skip dev fields
      // (per Phase 1 design — translators don't grammar-check their own
      // notes) and placeholder-bearing strings (intentionally awkward).
      const targets = [];
      for (const folder of folders) {
        const schema = latestSchemas[folder.name];
        if (!schema || schema.neverValidate) continue;
        const merged = buildMergedSchema(sharedSchema, schema);
        if (!merged) continue;
        for (const xmlFile of folder.xmlFiles) {
          const content = allFileContentsRef.current[xmlFile.relativePath];
          if (!content) continue;
          const fileTargets = extractGrammarTargets(content, merged);
          for (const t of fileTargets) {
            if (t.isDev) continue;
            if (t.hasPlaceholder) continue;
            targets.push({ ...t, file: xmlFile.relativePath, content });
          }
        }
      }

      if (targets.length === 0) {
        // Nothing to do — clear out any stale Grammar entries.
        setValidationErrors((prev) => {
          const kept = prev.filter((e) => !e.message.startsWith('Grammar ('));
          if (kept.length !== prev.length) {
            window.arcenApi.sendValidationResults(kept);
            return kept;
          }
          return prev;
        });
        return;
      }

      // Hash every target's cleaned text. The main-process IPC ensures we use
      // the same SHA-256 implementation that wrote the cache file in the
      // first place — no risk of cache misses from algorithm drift.
      const hashes = await Promise.all(
        targets.map((t) => window.arcenApi.grammarLLMHash(t.cleanedText))
      );
      for (let i = 0; i < targets.length; i++) targets[i].hash = hashes[i];
      console.log(`[grammar] ${targets.length} targets after dev/placeholder filter`);

      // Load existing cache. Bucket each target as cache-hit or needs-API.
      // The cache is per-model now: an entry can have results from Haiku
      // AND Sonnet AND Opus, and switching the active model just changes
      // which slice we read from / write to. The dismissed list is shared
      // across models intentionally (same fingerprint = same logical lint).
      const cache = await window.arcenApi.grammarLLMLoadCache();
      const cachedEntries = Object.keys(cache).length;
      const cachedForCurrentModel = Object.values(cache).filter(
        (e) => e?.results?.[settings.model] && Array.isArray(e.results[settings.model].lints)
      ).length;
      const cachedWithLints = Object.values(cache).filter(
        (e) => e?.results?.[settings.model] && (e.results[settings.model].lints || []).length > 0
      ).length;
      console.log(`[grammar] cache loaded: ${cachedEntries} entries total, ${cachedForCurrentModel} have ${settings.model} results (${cachedWithLints} with lints)`);
      const itemsToCheck = [];
      const seenHashes = new Set();
      for (const t of targets) {
        if (seenHashes.has(t.hash)) continue; // dedup identical strings
        seenHashes.add(t.hash);
        const cached = cache[t.hash];
        const modelResult = cached?.results?.[settings.model];
        if (modelResult && Array.isArray(modelResult.lints)) {
          continue; // we'll read from cache below
        }
        itemsToCheck.push({ id: t.hash, text: t.cleanedText });
      }
      console.log(`[grammar] ${itemsToCheck.length} unique strings to send to API (rest are cached)`);

      // Send uncached items to the API.
      let apiError = null;
      if (itemsToCheck.length > 0) {
        const response = await window.arcenApi.grammarLLMCheckBatch(itemsToCheck);
        if (response.error) {
          apiError = response.error;
        }
        const apiResults = response.results || {};
        const now = Date.now();
        for (const id of Object.keys(apiResults)) {
          const errors = apiResults[id] || [];
          // Compute fingerprints on the renderer side so dismissal logic
          // doesn't need a round-trip per lint. Mirrors the main-side hash.
          const lints = await Promise.all(errors.map(async (err) => ({
            fingerprint: await window.arcenApi.grammarLLMHash(
              `${err.kind || ''}|${err.quote || ''}|${err.message || ''}`
            ),
            kind: err.kind || 'Other',
            quote: err.quote || '',
            message: err.message || '',
            fix: err.fix || '',
          })));
          // Preserve any prior entry's other-model results AND the shared
          // dismissed list. We're only writing a fresh result for the model
          // currently selected — switching back later should still find the
          // old model's results intact.
          const prior = cache[id] || {};
          const priorResults = prior.results && typeof prior.results === 'object' ? prior.results : {};
          cache[id] = {
            results: {
              ...priorResults,
              [settings.model]: { scannedAt: now, lints },
            },
            dismissed: Array.isArray(prior.dismissed) ? prior.dismissed : [],
          };
        }
        // Save the cache immediately so a crash mid-review doesn't lose work.
        try {
          await window.arcenApi.grammarLLMSaveCache(cache);
        } catch (e) {
          console.error('Failed to save grammar LLM cache:', e);
        }
      }

      // Build validator entries from cache. Apply dismissed filter.
      const lineAtInContent = (text, pos) => {
        let line = 1, p = 0;
        const lines = text.split('\n');
        for (const l of lines) {
          if (pos >= p && pos < p + l.length + 1) return line;
          p += l.length + 1; line++;
        }
        return Math.max(1, lines.length);
      };
      const newGrammar = [];
      let targetsHit = 0;          // targets that found a cache entry
      let targetsWithLints = 0;    // targets whose cache entry had lints
      let lintsConsidered = 0;     // total lint objects iterated
      let lintsDismissed = 0;      // lints filtered by dismissed set
      try {
        for (const t of targets) {
          const entry = cache[t.hash];
          const modelResult = entry?.results?.[settings.model];
          if (!modelResult || !Array.isArray(modelResult.lints)) continue;
          targetsHit++;
          if (modelResult.lints.length > 0) targetsWithLints++;
          const dismissed = new Set(entry.dismissed || []);
          for (const lint of modelResult.lints) {
            lintsConsidered++;
            if (dismissed.has(lint.fingerprint)) { lintsDismissed++; continue; }
            // Locate the quote inside the original text. Falls back to the
            // attribute's start position if the quote can't be matched (rare —
            // happens when the LLM paraphrases despite the prompt asking it not to).
            const inTextOffset = lint.quote ? t.text.indexOf(lint.quote) : -1;
            const absPos = inTextOffset >= 0 ? t.absPos + inTextOffset : t.absPos;
            const line = lineAtInContent(t.content, absPos);
            let msg = `Grammar (${lint.kind}): "${lint.quote}" — ${lint.message}`;
            if (lint.fix) msg += ` (suggest: "${lint.fix}")`;
            msg += ` in "${t.attrName}"`;
            newGrammar.push({
              severity: 'warning',
              file: t.file,
              line,
              message: msg,
              isDev: false,
              absPos,
              // Carried so the dismissal context-menu can update the cache.
              grammarTextHash: t.hash,
              grammarFingerprint: lint.fingerprint,
              grammarQuote: lint.quote,
              grammarFix: lint.fix,
              grammarKind: lint.kind,
            });
          }
        }
      } catch (buildErr) {
        // Don't let a single bad cache entry kill the entire pass — log and
        // surface what we built up to that point.
        console.error('[grammar] entry-build loop threw:', buildErr);
      }
      console.log(`[grammar] build complete: ${targetsHit} targets hit cache, ${targetsWithLints} had lints, ${lintsConsidered} lints considered (${lintsDismissed} dismissed), ${newGrammar.length} validator entries produced`);

      setValidationErrors((prev) => {
        const kept = prev.filter((e) => !e.message.startsWith('Grammar ('));
        const combined = [...kept, ...newGrammar];
        window.arcenApi.sendValidationResults(combined);
        return combined;
      });

      if (apiError) {
        // Surface the API error in the validator's results list so the user
        // sees what happened without having to hunt in devtools.
        setValidationErrors((prev) => {
          const next = [
            { severity: 'error', file: '(grammar)', line: 1,
              message: `Grammar API error: ${apiError}` },
            ...prev,
          ];
          window.arcenApi.sendValidationResults(next);
          return next;
        });
      }
    } catch (e) {
      console.error('Grammar check failed:', e);
    } finally {
      grammarBusyRef.current = false;
      setGrammarRunning(false);
      if (grammarTimerRef.current) {
        clearInterval(grammarTimerRef.current);
        grammarTimerRef.current = null;
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      setGrammarTimerDisplay(elapsed + 's');
    }
  }, [folders, sharedSchema]);

  // Listen for revalidate / spelling / grammar requests from validation window
  useEffect(() => {
    window.arcenApi.onRequestRevalidate(() => {
      // Explicit user click — guarantee the validator window gets a result
      // ship even when nothing changed, so the count-up timer on the button
      // stops and the user sees that their click did something.
      forceSendValidatorRef.current = true;
      revalidateAll();
    });
    window.arcenApi.onRequestSpellingCheck?.(() => {
      runSpellingCheck();
    });
    window.arcenApi.onRequestGrammarCheck?.(() => {
      runGrammarCheck();
    });
    window.arcenApi.onRequestGrammarSettings?.(() => {
      document.dispatchEvent(new CustomEvent('grammarSettingsRequested'));
    });
    // Mark-as-resolved: same removal-from-view shape as Dismiss, but doesn't
    // touch the cache. The user has fixed the issue manually (or the suggested
    // fix wasn't quite right but the underlying text changed in some other
    // way), so a permanent dismissal isn't appropriate — the next grammar
    // check will compute a new hash for the changed text and treat it fresh.
    window.arcenApi.onRequestGrammarResolve?.((textHash, fingerprint) => {
      setValidationErrors((prev) => {
        const filtered = prev.filter(
          (e) => !(e.grammarTextHash === textHash && e.grammarFingerprint === fingerprint)
        );
        if (filtered.length !== prev.length) {
          window.arcenApi.sendValidationResults(filtered);
        }
        return filtered;
      });
    });
    window.arcenApi.onRequestGrammarDismiss?.(async (textHash, fingerprint) => {
      try {
        const cache = await window.arcenApi.grammarLLMLoadCache();
        const entry = cache[textHash];
        if (!entry) return;
        const dismissed = new Set(entry.dismissed || []);
        dismissed.add(fingerprint);
        cache[textHash] = { ...entry, dismissed: [...dismissed] };
        await window.arcenApi.grammarLLMSaveCache(cache);
        setValidationErrors((prev) => {
          const filtered = prev.filter(
            (e) => !(e.grammarTextHash === textHash && e.grammarFingerprint === fingerprint)
          );
          if (filtered.length !== prev.length) {
            window.arcenApi.sendValidationResults(filtered);
          }
          return filtered;
        });
      } catch (e) {
        console.error('Failed to dismiss grammar lint:', e);
      }
    });
    // Compute suggestions on demand for the validation window
    window.arcenApi.onComputeSuggestions?.((requestId, word) => {
      const checker = spellcheckerRef.current;
      const suggestions = checker ? checker.suggest(word).slice(0, 5) : [];
      window.arcenApi.sendSuggestionsComputed(requestId, suggestions);
    });
  }, [revalidateAll, runSpellingCheck, runGrammarCheck]);

  // Live timer for validation progress
  const [validationTimerDisplay, setValidationTimerDisplay] = useState(null);
  useEffect(() => {
    if (validationTiming?.running) {
      const tick = () => {
        if (!validationStartRef.current) return;
        const elapsed = ((Date.now() - validationStartRef.current) / 1000).toFixed(1);
        setValidationTimerDisplay(elapsed + 's');
        validationTimerRef.current = requestAnimationFrame(tick);
      };
      validationTimerRef.current = requestAnimationFrame(tick);
      return () => {
        if (validationTimerRef.current) cancelAnimationFrame(validationTimerRef.current);
      };
    } else if (validationTiming?.elapsed) {
      setValidationTimerDisplay(validationTiming.elapsed);
    } else {
      setValidationTimerDisplay(null);
    }
  }, [validationTiming]);

  // Listen for dictionary/grammar ignore changes (external edits or "Add to Dictionary")
  useEffect(() => {
    window.arcenApi.onDictionaryChanged(async () => {
      try {
        const dictData = await window.arcenApi.loadSpellingDictionary();
        if (dictData.aff && dictData.dic) {
          const nspell = new NSpell(dictData.aff, dictData.dic);
          if (dictData.custom?.length) {
            for (const word of dictData.custom) nspell.add(word);
          }
          devWordsRef.current = new Set(dictData.devCustom || []);
          const checker = makeDevAwareChecker(nspell, devWordsRef);
          spellcheckerRef.current = checker;
          setSpellchecker(checker);
          dictDataRef.current = dictData;
          // Push updated dev words AND global custom words to all warmed-up workers
          // so their cached spellcheckers match the main-thread one. Without the
          // custom-words update, a later full spellcheck would re-report words the
          // user just added to the dictionary — they'd "come back" in the validator.
          for (const w of spellingWorkerPoolRef.current) {
            w.postMessage({ type: 'update-dev-words', devWords: [...devWordsRef.current] });
            w.postMessage({
              type: 'update-custom-words',
              dictAff: dictData.aff,
              dictDic: dictData.dic,
              customWords: dictData.custom || [],
              devWords: [...devWordsRef.current],
            });
          }
          // Poke the active editor so its spellcheck ViewPlugin rebuilds decorations
          // with the new dictionary. The plugin only re-runs on docChanged, so without
          // this nudge, squiggles would stay stale until the user types. This matters
          // when a word is added via the validator window (no inline doc touch happens).
          const view = editorViewRef.current;
          if (view) {
            try {
              const pos = view.state.doc.length;
              view.dispatch({ changes: { from: pos, insert: ' ' } });
              view.dispatch({ changes: { from: pos, to: pos + 1 } });
            } catch (_) {}
          }
        }
      } catch (e) {
        console.error('Failed to reload dictionary:', e);
      }
      // Don't revalidate — just reload the checker so inline decorations update.
      // Full revalidation with spelling is too expensive to trigger on every dictionary change.
    });
    // When a word is added to the dictionary, filter existing spelling errors for that word
    // so resolved entries don't reappear after any future validation-results broadcast.
    window.arcenApi.onDictionaryWordAdded((word) => {
      if (!word) return;
      const prefix = 'Spelling: "' + word + '"';
      setValidationErrors((prev) => {
        const filtered = prev.filter((e) => !e.message.startsWith(prefix));
        if (filtered.length !== prev.length) {
          window.arcenApi.sendValidationResults(filtered);
        }
        return filtered;
      });
    });
    // Same as above but for dev-dictionary additions: only filters out entries
    // that were flagged in dev contexts (isDev === true). Dev dictionary words
    // don't apply to user-facing fields, so non-dev spelling entries should stay.
    window.arcenApi.onDevDictionaryWordAdded((word) => {
      if (!word) return;
      const prefix = 'Spelling: "' + word + '"';
      setValidationErrors((prev) => {
        const filtered = prev.filter((e) => !(e.message.startsWith(prefix) && e.isDev));
        if (filtered.length !== prev.length) {
          window.arcenApi.sendValidationResults(filtered);
        }
        return filtered;
      });
    });
  }, [revalidateAll]);

  // ── Inline-decoration kick on first spellchecker readiness ──
  // The CM6 ViewPlugin caches a Decoration.none result if it builds before
  // the spellchecker finishes loading (NSpell parsing is deferred 100ms after
  // mount). It only rebuilds on docChanged, so without a nudge here, squiggles
  // — including forbidden-character ones — wouldn't appear until the user
  // types. Dispatching a no-op insert+delete forces a rebuild without leaving
  // a doc change in the undo history.
  const spellcheckerReadyKickRef = useRef(false);
  useEffect(() => {
    if (!spellchecker || spellcheckerReadyKickRef.current) return;
    spellcheckerReadyKickRef.current = true;
    const view = editorViewRef.current;
    if (!view) return;
    try {
      const pos = view.state.doc.length;
      view.dispatch({ changes: { from: pos, insert: ' ' } });
      view.dispatch({ changes: { from: pos, to: pos + 1 } });
    } catch (_) {}
  }, [spellchecker]);

  // ── Live per-file spelling refresh as the user types ──
  // The inline editor decoration updates on every keystroke, but the validation
  // window has a snapshot of errors from the last scan. When the user manually
  // fixes a misspelling by typing, those stale entries should go away. This
  // debounced effect re-runs the spelling scan on the file being edited and
  // replaces its spelling entries in the validation state.
  // We only rescan when the content ACTUALLY changes — not on tab switch or
  // navigation — so that clicking an entry in the validator to go look at it
  // doesn't disturb the validation results.
  const lastLiveRescanContentRef = useRef({});
  // Sentinel for forcing a live-rescan even when no content actually changed in
  // React state — see the file-watcher disk-reload path. Defined once at module
  // load; identity comparison against any string is always false.
  const LIVE_RESCAN_FORCE = useRef({}).current;
  useEffect(() => {
    const checker = spellcheckerRef.current;
    if (!checker || !sharedSchema) return;
    const activeFile = tabs[activeTabIndex]?.relativePath;
    if (!activeFile) return;
    const content = fileContents[activeFile];
    if (content === undefined) return;

    // Content unchanged since last recorded → nothing to do
    if (lastLiveRescanContentRef.current[activeFile] === content) return;
    // First time we're observing this file's content in this session:
    // the full worker scan already covered it, so just record and skip.
    if (lastLiveRescanContentRef.current[activeFile] === undefined) {
      lastLiveRescanContentRef.current[activeFile] = content;
      return;
    }

    const timer = setTimeout(() => {
      try {
        // Local helper: position → 1-based line number
        const lineAtInContent = (text, pos) => {
          let line = 1, p = 0;
          const lines = text.split('\n');
          for (const l of lines) {
            if (pos >= p && pos < p + l.length + 1) return line;
            p += l.length + 1;
            line++;
          }
          return line;
        };

        let spellingErrors = [];
        // checker.correct is already dev-aware: (word, isDev) => bool
        const correct = (w, isDev) => checker.correct(w, isDev);

        const buildEntry = (m) => {
          const line = lineAtInContent(content, m.absPos);
          // Build the message including suggestions when present so the
          // validator's "Did you mean: X?" parser stays happy. Forbidden-char
          // entries always carry a suggestion (the ASCII fix); regular spell
          // entries from the live rescan have no suggestions (suggest() is
          // expensive — fetched lazily on right-click).
          let msg = spellingMessagePrefix(m);
          if (m.suggestions && m.suggestions.length > 0) {
            msg += `. Did you mean: ${m.suggestions.join(', ')}?`;
          }
          return {
            severity: 'warning', file: activeFile, line,
            message: msg,
            isDev: m.isDev, absPos: m.absPos,
            forbiddenChar: !!m.forbiddenChar,
            // Pass the suggestions array through so the context menu can read
            // it directly without re-parsing the message text.
            suggestions: m.suggestions || [],
          };
        };

        if (activeFile.endsWith('.metadata')) {
          // Metadata: spellcheck tooltip values
          const mis = findMisspelledWordsInMetadata(content, correct, null);
          spellingErrors = mis.map(buildEntry);
        } else {
          // XML: find the folder + schema for this file
          const folderName = folderNameOf(activeFile);
          const schema = schemas[folderName];
          if (!schema || schema.neverValidate) return;
          const merged = buildMergedSchema(sharedSchema, schema);
          if (!merged) return;
          const mis = findMisspelledWords(content, merged, correct, null);
          spellingErrors = mis.map(buildEntry);
        }

        // Only touch state if something actually changed to avoid render churn.
        setValidationErrors((prev) => {
          const previousSpellingForFile = prev.filter(
            (e) => e.file === activeFile && e.message.startsWith('Spelling:')
          );
          // Compare by (line + message) set — if identical, no-op.
          const sig = (arr) => arr.map((e) => e.line + '|' + e.message).sort().join('\n');
          if (sig(previousSpellingForFile) === sig(spellingErrors)) return prev;
          const other = prev.filter(
            (e) => !(e.file === activeFile && e.message.startsWith('Spelling:'))
          );
          const combined = [...other, ...spellingErrors];
          window.arcenApi.sendValidationResults(combined);
          return combined;
        });
        // Mark the content we just scanned so a future invocation with the same
        // content is a no-op (prevents rescanning on tab switches/navigation).
        lastLiveRescanContentRef.current[activeFile] = content;
      } catch (e) {
        // Non-fatal — the full spellcheck will catch up later
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [fileContents, activeTabIndex, tabs, schemas, sharedSchema]);

  // ── Live validation for the active ISLAND file ──
  // Islands aren't in `folders`, so the validation worker never sees them.
  // Validate the active island file here against its STANDALONE schema with an
  // EMPTY fkIndex — i.e. only its own custom validator logic (malformed XML,
  // unknown attrs, wrong-name sub-nodes, type mismatches, dropdown options, and
  // record/structurally-scoped local references). No FK / shared / cross-layer.
  // Runs on open and (debounced) on every edit, so it's live even though island
  // files are view-only. worker.onmessage preserves these across core ticks.
  useEffect(() => {
    const activeFile = tabs[activeTabIndex]?.relativePath;
    if (!activeFile) return;
    const schema = islandSchemaByRelPath.get(activeFile);
    if (!schema) return; // not an island file
    const content = fileContents[activeFile];
    if (content === undefined) return;
    const timer = setTimeout(() => {
      let errs = [];
      try {
        errs = validateXMLFile(content, activeFile, schema, {}, lookupSwapsRef.current, { layer: 'base', folderName: '' });
      } catch (_) { /* non-fatal */ }
      setValidationErrors((prev) => {
        const sig = (arr) => arr.map((e) => e.line + '|' + e.severity + '|' + e.message).sort().join('\n');
        const minePrev = prev.filter((e) => e.file === activeFile && !e.message.startsWith('Spelling:'));
        if (sig(minePrev) === sig(errs)) return prev;
        const other = prev.filter((e) => !(e.file === activeFile && !e.message.startsWith('Spelling:')));
        const combined = [...other, ...errs];
        window.arcenApi.sendValidationResults(combined);
        return combined;
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [fileContents, activeTabIndex, tabs, islandSchemaByRelPath]);

  // ── Periodic background revalidation (every 30s after any save) ──
  const lastValidationTime = useRef(Date.now());
  const saveCountSinceValidation = useRef(0);
  // Track saves
  const origSaveFile = saveFile;
  useEffect(() => {
    saveCountSinceValidation.current++;
  }, [savedContents]);
  useEffect(() => {
    const interval = setInterval(() => {
      if (saveCountSinceValidation.current > 0) {
        saveCountSinceValidation.current = 0;
        lastValidationTime.current = Date.now();
        // Use the fast path — post current in-memory state to the worker
        // without re-reading / re-parsing / re-indexing. See the comment
        // on postWorkerValidation for why that's safe here.
        postWorkerValidation();
      }
    }, 30000);
    return () => clearInterval(interval);
  }, [postWorkerValidation]);

  // ── Navigate-to-line from validation window ──
  useEffect(() => {
    window.arcenApi.onNavigateToLine((rawFile, line, highlight, absPos) => {
      // Normalize so the stored pendingScrollLine.file compares equal to
      // the active tab's relativePath (which is already forward-slash).
      const file = typeof rawFile === 'string' ? rawFile.replace(/\\/g, '/') : rawFile;
      if (globalSearchMinimizeRef.current) globalSearchMinimizeRef.current();
      const type = file.endsWith('.metadata') ? 'schema' : 'xml';
      openFile(file, type).then(() => {
        // Unique `_t` forces the effect to re-run even when the user clicks the
        // same entry repeatedly (same file + line + highlight = same object props).
        setPendingScrollLine({
          _t: Date.now(), file, line,
          highlight: highlight || null,
          absPos: absPos != null ? absPos : null,
        });
      });
    });
  }, [openFile]);

  // ── Tab context menu ──
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const handleTabContextMenu = useCallback((index, x, y) => {
    const tab = tabs[index];
    if (!tab) return;
    const isModified = fileContents[tab.relativePath] !== savedContents[tab.relativePath];
    const isXml = tab.type !== 'schema';
    const items = [];
    if (isModified) {
      items.push({ label: 'Show changes since save', action: () => setDiffTabIndex(index) });
      items.push({ label: 'Revert all changes', action: () => {
        const saved = savedContents[tab.relativePath];
        if (saved !== undefined) {
          setFileContents((prev) => ({ ...prev, [tab.relativePath]: saved }));
          allFileContentsRef.current[tab.relativePath] = saved;
        }
      }});
    }
    if (isXml && favorites.length > 0) {
      // Build favorites submenu items inline
      for (const g of favorites) {
        const isIn = g.files.includes(tab.relativePath);
        items.push({
          label: `${isIn ? '✓ ' : '  '}Fav: ${g.name}`,
          action: () => {
            if (isIn) {
              setFavorites(favorites.map(fg => fg.name === g.name ? { ...fg, files: fg.files.filter(f => f !== tab.relativePath) } : fg));
            } else {
              setFavorites(favorites.map(fg => ({
                ...fg,
                files: fg.name === g.name
                  ? [...fg.files.filter(f => f !== tab.relativePath), tab.relativePath]
                  : fg.files.filter(f => f !== tab.relativePath),
              })));
            }
          },
        });
      }
    }
    items.push({ label: 'Center sidebar on this', action: () => {
      const want = sidebarTabForPath(tab.relativePath);
      setSidebarTab(want);
      if (want === 'files') setExpandedFolders((prev) => new Set(prev).add(folderNameOf(tab.relativePath)));
      setScrollSidebarTo(tab.relativePath);
    }});
    items.push({ label: 'Open in Explorer', action: () => {
      if (window.arcenApi?.scAbsPath && window.arcenApi?.showInFolder) {
        window.arcenApi.scAbsPath(tab.relativePath).then((abs) => abs && window.arcenApi.showInFolder(abs));
      }
    }});
    items.push({ label: 'Copy full path', action: () => {
      if (window.arcenApi?.scAbsPath) {
        window.arcenApi.scAbsPath(tab.relativePath).then((abs) => {
          if (abs) navigator.clipboard.writeText(abs).catch(() => {});
        });
      }
    }});
    items.push({ label: 'Close', action: () => closeTab(index) });
    items.push({ label: 'Close others', action: () => {
      // Keep tabs from the OTHER sidebar bucket so switching context doesn't
      // silently lose them: closing from a mod tab keeps non-mod tabs and vice
      // versa (xml + schema are one bucket now). Only same-bucket peers close.
      const clickedIsMod = /^mod_/.test(layerByRelPath.get(tab.relativePath)?.layer || '');
      setTabs(prev => {
        const kept = prev.filter(t => t.relativePath === tab.relativePath
          || (/^mod_/.test(layerByRelPath.get(t.relativePath)?.layer || '') !== clickedIsMod));
        const newIdx = kept.findIndex(t => t.relativePath === tab.relativePath);
        setActiveTabIndex(newIdx >= 0 ? newIdx : 0);
        return kept;
      });
    }});
    if (tab.type === 'schema') {
      items.push({ label: 'Close All Schema Tabs', action: () => {
        setTabs(prev => {
          const schemaTabs = prev.filter(t => t.type === 'schema');
          if (!schemaTabs.length) return prev;
          const anyModified = schemaTabs.some(t => fileContents[t.relativePath] !== savedContents[t.relativePath]);
          if (anyModified && !confirm('Some schema tabs have unsaved changes. Close all anyway?')) return prev;
          const kept = prev.filter(t => t.type !== 'schema');
          setActiveTabIndex(curIdx => {
            const curTab = prev[curIdx];
            if (curTab && curTab.type !== 'schema') {
              const ni = kept.findIndex(t => t.relativePath === curTab.relativePath);
              return ni >= 0 ? ni : 0;
            }
            return kept.length ? 0 : -1;
          });
          return kept;
        });
      }});
    }
    // Append the active VCS provider's commands when connected + cache alive.
    // Labels and IDs come from the provider via scGetCommands so this list
    // automatically reflects whichever provider is active (SVN, Git, …).
    if (vcsStore.getState().statusBackendLive && window.arcenApi?.scRunCommand && window.arcenApi?.scAbsPath && window.arcenApi?.scGetCommands) {
      items.push({ divider: true });
      (async () => {
        const absPath = await window.arcenApi.scAbsPath(tab.relativePath);
        if (!absPath) return;
        const cmds = await window.arcenApi.scGetCommands('file', absPath);
        const scItems = (cmds || [])
          .filter(c => c.enabled !== false)
          .map(c => ({
            label: c.label,
            action: () => window.arcenApi.scRunCommand(c.id, absPath),
          }));
        if (scItems.length) {
          setTabContextMenu((prev) => prev ? { ...prev, items: [...items, ...scItems] } : null);
        }
      })();
    }
    setTabContextMenu({ x, y, items });
  }, [tabs, fileContents, savedContents, favorites, closeTab]);

  const activeTab = tabs[activeTabIndex] ?? null;

  // Filter tabs shown in the tab bar based on sidebar context. Two buckets:
  //   mods sidebar → tabs whose file lives in a mod layer (xml + metadata)
  //   else (files / favorites) → all non-mod tabs (xml AND schema comingle,
  //     mirroring the detached windows and the Explorer's inline schemas)
  // A tab is "a mod tab" if its relativePath maps to a mod layer in layerByRelPath.
  const isModsMode = sidebarTab === 'mods';
  const isModTab = useCallback(
    (relPath) => /^mod_/.test(layerByRelPath.get(relPath)?.layer || ''),
    [layerByRelPath]
  );
  const visibleTabs = useMemo(() => {
    return tabs.map((t, i) => ({ ...t, realIndex: i })).filter((t) => {
      const mod = isModTab(t.relativePath);
      return isModsMode ? mod : !mod;
    });
  }, [tabs, isModsMode, isModTab]);
  const visibleActiveIndex = visibleTabs.findIndex((t) => t.realIndex === activeTabIndex);

  const activeSchema = (() => {
    if (!activeTab) return null;
    const folderName = folderNameOf(activeTab.relativePath);
    return schemas[folderName] ?? null;
  })();

  // Composed schema for the active XML tab — base merged schema plus any
  // applicable mod extensions for the tab's layer. EditorPane uses this for
  // the FK picker, autocomplete, attribute tooltips, etc., so a mod file
  // sees its mod's extra fields/sub-nodes as valid. Null for metadata tabs
  // and when there's no active XML file; EditorPane falls back to building
  // its own merged schema in that case.
  const composedSchemaForActive = useMemo(() => {
    if (!activeTab || activeTab.type === 'schema') return null;
    // Island data file: its standalone schema IS the merged schema — no
    // SharedMetaData merge, no layer composition. Checked first so islands
    // render even when sharedSchema is absent (they don't use it).
    const islandSchema = islandSchemaByRelPath.get(activeTab.relativePath);
    if (islandSchema) return islandSchema;
    if (!sharedSchema || !activeSchema) return null;
    const merged = buildMergedSchema(sharedSchema, activeSchema);
    if (!merged) return null;
    const folderName = activeSchema.folderName || folderNameOf(activeTab.relativePath);
    const layer = layerByRelPath.get(activeTab.relativePath)?.layer || 'base';
    return composeSchemaForFileLayer(
      merged, schemaExtensions, layerMaps.modExtrasByLayer, layer, folderName
    );
  }, [activeTab, activeSchema, sharedSchema, schemaExtensions, layerMaps, layerByRelPath, islandSchemaByRelPath]);

  // ── Ctrl+click attribute name → navigate to metadata file ──
  //
  // Resolution order — pick the FIRST file that actually contains the
  // attribute, NOT the file the user has the most "claim" over:
  //
  //   1. The folder's primary schema (base/owned). If the attribute is
  //      declared here, this is where the user wants to read it — even
  //      if they Ctrl+clicked inside a mod's data file. Routing them to
  //      the mod's extension when the real declaration is in base would
  //      surface the wrong context AND fail the "scroll to the attribute
  //      I clicked" promise (the extension doesn't have it).
  //   2. The mod's schema extension (if active file is in a mod and the
  //      mod ships an extension for this folder). This is where mod-
  //      specific extras live.
  //   3. SharedMetaData — for the standard cross-table attrs like `id`,
  //      `sort_order`, etc.
  //
  // If the attribute is found in NONE of those, insert a FIELD_NEEDED
  // stub. Insertion target: the mod's extension if the active file is
  // in a mod (and the extension exists) — the user usually can't edit
  // base. Otherwise the folder's primary schema.
  const handleNavigateToMetadata = useCallback((attrName, parentTag) => {
    if (!activeTab) return;
    // Island data file → jump into its standalone _<Name>.metadata.
    const island = islands.find((isl) =>
      (isl.files || []).some((f) => f.relativePath === activeTab.relativePath)
    ) || null;
    navigateToMetadataDef(attrName, parentTag, {
      activeRelPath: activeTab.relativePath,
      island,
      folderNameOf,
      folders,
      sharedMetadataRelPath: dataLayout.sharedMetadataRelPath,
      layerByRelPath,
      modSchemaExtensions: modSchemaExtensionsList,
      schemas,
      getContent: (p) => allFileContentsRef.current[p],
      setContent: (p, c) => {
        setFileContents((prev) => ({ ...prev, [p]: c }));
        allFileContentsRef.current[p] = c;
      },
      openFile,
      scrollTo: ({ file, line, highlight }) =>
        setPendingScrollLine({ _t: Date.now(), file, line, highlight }),
    });
  }, [activeTab, folders, openFile, layerByRelPath, modSchemaExtensionsList, schemas, dataLayout.sharedMetadataRelPath, islands]);

  // ── Ctrl+click an unknown sub-node tag → declare it in the schema ──
  //
  // The clickHandler offers this fall-through when the clicked tag matches
  // neither the root nodeName nor any known sub_node. We pick the right
  // metadata file the same way handleNavigateToMetadata does — prefer the
  // mod's own extension/schema over the base when the active file is a mod
  // file — and insert a stub `<sub_node id="<tag>"></sub_node>` block right
  // before </root>. The user can then add `<attribute>` entries inside.
  const handleAddUnknownSubNodeToSchema = useCallback((tagName) => {
    if (!activeTab) return;
    addUnknownSubNodeStub(tagName, {
      activeRelPath: activeTab.relativePath,
      folderNameOf,
      folders,
      layerByRelPath,
      modSchemaExtensions: modSchemaExtensionsList,
      getContent: (p) => allFileContentsRef.current[p],
      setContent: (p, c) => {
        setFileContents((prev) => ({ ...prev, [p]: c }));
        allFileContentsRef.current[p] = c;
      },
      openFile,
      scrollTo: ({ file, line, highlight }) =>
        setPendingScrollLine({ _t: Date.now(), file, line, highlight }),
    });
  }, [activeTab, folders, openFile, layerByRelPath, modSchemaExtensionsList]);

  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  // Batch-rename a central identifier and all FK references to it across all
  // currently loaded files. Called by RenameIdDialog on confirm.
  const handleIdRename = useCallback((oldId, newId, sourceRelPath) => {
    const curSharedSchema = sharedSchemaLatest.current;
    if (!curSharedSchema) return;
    const idKey = getCentralIdentifierKey(curSharedSchema);
    const curSchemas = schemasLatest.current;
    const curFolderNames = folderNameByRelPathRef.current;
    const tableName = curFolderNames.get(sourceRelPath);
    if (!tableName) return;

    // The FK index aliases both the full folder name ("1_BuildingTag") and the
    // base name ("BuildingTag") to the same entry object. Comparing by reference
    // lets us match whichever form a given schema uses in node_source.
    const curFKIndex = fkIndexLatest.current;
    const tableEntry = curFKIndex[tableName] || curFKIndex[tableName.replace(/^\d+_/, '')];

    const updates = {};
    for (const [relPath, content] of Object.entries(allFileContentsRef.current)) {
      if (!content) continue;
      const folderName = curFolderNames.get(relPath);
      const fileSchema = (folderName && curSchemas[folderName]) || null;
      const fileMergedSchema = fileSchema && curSharedSchema
        ? buildMergedSchema(curSharedSchema, fileSchema)
        : fileSchema;
      if (!fileMergedSchema) continue;

      const attrs = buildAttrMap(tokenize(content), fileMergedSchema);
      const toReplace = [];
      for (const attr of attrs) {
        if (attr.vs == null) continue;
        const isCentralId = relPath === sourceRelPath && attr.nm === idKey && attr.v === oldId;
        const isFK = !!attr.src && tableEntry &&
          curFKIndex[attr.src] === tableEntry && (
            attr.v === oldId || attr.v.split(',').some(p => p.trim() === oldId)
          );
        if (isCentralId || isFK) {
          toReplace.push({ from: attr.vs, to: attr.ve, isList: attr.v !== oldId });
        }
      }
      if (toReplace.length === 0) continue;

      toReplace.sort((a, b) => b.from - a.from);
      let updated = content;
      for (const { from, to, isList } of toReplace) {
        const oldVal = updated.slice(from, to);
        const newVal = isList ? replaceIdInValue(oldVal, oldId, newId) : newId;
        updated = updated.slice(0, from) + newVal + updated.slice(to);
      }
      updates[relPath] = updated;
    }

    if (Object.keys(updates).length === 0) return;
    setFileContents(prev => ({ ...prev, ...updates }));
    for (const [relPath, content] of Object.entries(updates)) {
      allFileContentsRef.current[relPath] = content;
    }
  }, []);

  // Sidebar resize drag handler. When the sidebar is on the right, the
  // handle sits on its left edge — so dragging right SHRINKS the sidebar.
  // Flipping the delta sign keeps the visual feel identical (drag the
  // handle outward to grow, inward to shrink) regardless of side.
  const sidebarDragRef = useRef(null);
  const handleSidebarDragStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const dirSign = sidebarSide === 'right' ? -1 : 1;
    const onMove = (ev) => {
      const newWidth = Math.max(150, Math.min(600, startWidth + dirSign * (ev.clientX - startX)));
      setSidebarWidth(newWidth);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth, sidebarSide]);

  return (
    <div className="app-root">
      <TitleBar
        navState={navState}
        onBack={navigateBack}
        onForward={navigateForward}
        activeFileName={activeTab ? fileDisplayName(activeTab.relativePath.split('/').pop()) : null}
      />
      <div className="app-container" style={{ flexDirection: sidebarSide === 'right' ? 'row-reverse' : 'row' }}>
      <Sidebar
        folders={folders}
        theme={theme}
        width={sidebarWidth}
        activeTab={sidebarTab}
        onTabChange={setSidebarTab}
        expandedFolders={expandedFolders}
        onToggleFolder={(name) => {
          setExpandedFolders((prev) => {
            const next = new Set(prev);
            next.has(name) ? next.delete(name) : next.add(name);
            return next;
          });
        }}
        onOpenFile={openFile}
        activeFile={activeTab?.relativePath}
        activeFiles={activeFiles}
        modifiedFiles={modifiedFiles}
        schemas={schemas}
        hasSharedMetadata={!!sharedSchema}
        favorites={favorites}
        onFavoritesChange={setFavorites}
        scrollToFile={scrollSidebarTo}
        onScrollToFileDone={() => setScrollSidebarTo(null)}
        onRequestCenterActive={async () => {
          // Center on the active file of whichever window was focused most
          // recently (main or a detached window); fall back to this window's
          // active tab if the main process can't answer.
          let target = null;
          try { target = await window.arcenApi.getCenterTarget?.(); } catch (_) {}
          if (!target) target = activeTab?.relativePath || null;
          if (!target) return;
          const want = sidebarTabForPath(target);
          setSidebarTab(want);
          if (want === 'files') setExpandedFolders((prev) => new Set(prev).add(folderNameOf(target)));
          setScrollSidebarTo(target);
        }}
        onShowInFolder={(filePath) => window.arcenApi.showInFolder(filePath)}
        sharedMetadataRelPath={dataLayout.sharedMetadataRelPath}
        expansions={dataLayout.expansions}
        mods={dataLayout.mods || []}
        islands={islands}
        modSchemaExtensions={modSchemaExtensionsList}
        onRenameFile={async (oldPath, newPath) => {
          try {
            await window.arcenApi.renameFile(oldPath, newPath);
          } catch (e) {
            // Common Windows case: EPERM/EBUSY when a folder has an open
            // watch handle, or EEXIST if the target already exists.
            // Surface to the user instead of silently doing nothing —
            // historically this just vanished and looked like a stub.
            alert(`Rename failed: ${e?.message || e}`);
            return;
          }

          // Detect folder-vs-file rename by whether oldPath contains a '/'.
          // Folder rename: oldPath is a folder name (no slash). Renaming a
          // folder changes the path of every XML/metadata file inside it,
          // so open tabs, bulk content cache, and expandedFolders all need
          // the old prefix rewritten to the new one.
          const isFolderRename = !oldPath.includes('/');
          if (isFolderRename) {
            const oldPrefix = oldPath + '/';
            const newPrefix = newPath + '/';
            const rewrite = (rel) => rel.startsWith(oldPrefix)
              ? newPrefix + rel.slice(oldPrefix.length)
              : rel;
            setTabs((prev) => prev.map((t) => ({
              ...t,
              relativePath: rewrite(t.relativePath),
            })));
            setExpandedFolders((prev) => {
              if (!prev.has(oldPath)) return prev;
              const next = new Set(prev);
              next.delete(oldPath);
              next.add(newPath);
              return next;
            });
            // Rewrite the bulk content cache and per-tab editor state in place
            const bulk = allFileContentsRef.current;
            for (const key of Object.keys(bulk)) {
              if (key.startsWith(oldPrefix)) {
                bulk[rewrite(key)] = bulk[key];
                delete bulk[key];
              }
            }
            setFileContents((prev) => {
              const next = {};
              for (const k of Object.keys(prev)) next[rewrite(k)] = prev[k];
              return next;
            });
            setSavedContents((prev) => {
              const next = {};
              for (const k of Object.keys(prev)) next[rewrite(k)] = prev[k];
              return next;
            });
            // schemas is keyed by folder name — move the entry under the new key.
            // folderName on the parsed schema is also used by parseMetadata output,
            // so rewrite that too.
            setSchemas((prev) => {
              if (!prev[oldPath]) return prev;
              const next = { ...prev };
              next[newPath] = { ...next[oldPath], folderName: newPath };
              delete next[oldPath];
              return next;
            });
          } else {
            // Single-file rename inside the same folder — just rewrite the
            // relativePath on any open tab so it doesn't go stale.
            setTabs((prev) => prev.map((t) =>
              t.relativePath === oldPath ? { ...t, relativePath: newPath } : t
            ));
            const bulk = allFileContentsRef.current;
            if (bulk[oldPath] !== undefined) {
              bulk[newPath] = bulk[oldPath];
              delete bulk[oldPath];
            }
            setFileContents((prev) => {
              if (prev[oldPath] === undefined) return prev;
              const next = { ...prev, [newPath]: prev[oldPath] };
              delete next[oldPath];
              return next;
            });
            setSavedContents((prev) => {
              if (prev[oldPath] === undefined) return prev;
              const next = { ...prev, [newPath]: prev[oldPath] };
              delete next[oldPath];
              return next;
            });
          }

          // Reload folders so the sidebar reflects the rename.
          const data = await window.arcenApi.discoverData();
          applyDiscovery(data);
        }}
        onCreateFolder={async (name, opts) => {
          await window.arcenApi.createFolder(name, opts);
          const data = await window.arcenApi.discoverData();
          applyDiscovery(data);
        }}
        onCreateXmlFile={async (folderName, fileName, layerId) => {
          try {
            const result = await window.arcenApi.createXmlFile(folderName, fileName, layerId);
            const data = await window.arcenApi.discoverData();
            applyDiscovery(data);
            if (result?.relativePath) openFile(result.relativePath, 'xml');
          } catch (e) {
            alert(e.message || 'Failed to create file.');
          }
        }}
      />
      <div className="sidebar-resize-handle" onMouseDown={handleSidebarDragStart} />
      <div className="main-area">
        <TabBar
          tabs={visibleTabs}
          activeIndex={visibleActiveIndex}
          layerByRelPath={layerByRelPath}
          onSelect={(vi) => {
            const realIdx = visibleTabs[vi]?.realIndex ?? -1;
            if (realIdx === activeTabIndex) {
              // Clicking the tab you're already on re-centers the sidebar on
              // that file (same as the tab right-click "Center … sidebar on
              // this"). The diff view is still available via that right-click
              // menu → "Show changes since save".
              const tab = tabs[realIdx];
              if (tab) {
                // Route to the tab that owns this file (Extra / MODS / Explorer).
                const want = sidebarTabForPath(tab.relativePath);
                setSidebarTab(want);
                if (want === 'files') {
                  setExpandedFolders((prev) => new Set(prev).add(folderNameOf(tab.relativePath)));
                }
                setScrollSidebarTo(tab.relativePath);
              }
            } else {
              captureSelectionNow();
              setActiveTabIndex(realIdx);
            }
          }}
          onClose={(vi) => closeTab(visibleTabs[vi]?.realIndex)}
          modifiedFiles={modifiedFiles}
          onContextMenu={(vi, x, y) => handleTabContextMenu(visibleTabs[vi]?.realIndex, x, y)}
          onReorder={(fromVi, toVi) => {
            const fromReal = visibleTabs[fromVi]?.realIndex;
            const toReal = visibleTabs[toVi]?.realIndex;
            if (fromReal == null || toReal == null) return;
            setTabs((prev) => {
              const next = [...prev];
              const [moved] = next.splice(fromReal, 1);
              const adjustedTo = toReal > fromReal ? toReal - 1 : toReal;
              next.splice(adjustedTo, 0, moved);
              return next;
            });
            // Adjust active tab index
            if (activeTabIndex === fromReal) {
              const adjustedTo = toReal > fromReal ? toReal - 1 : toReal;
              setActiveTabIndex(adjustedTo);
            } else if (fromReal < activeTabIndex && toReal >= activeTabIndex) {
              setActiveTabIndex(activeTabIndex - 1);
            } else if (fromReal > activeTabIndex && toReal <= activeTabIndex) {
              setActiveTabIndex(activeTabIndex + 1);
            }
          }}
        />
        {/* Disk conflict notification bar */}
        {activeTab && diskConflicts.includes(activeTab.relativePath) && (
          <div style={{
            padding: '6px 12px', background: '#f59e0b', color: '#000',
            display: 'flex', alignItems: 'center', gap: 12, fontSize: 13,
          }}>
            <span style={{ flex: 1 }}>
              File changed on disk. Reload? (Unsaved changes will be lost.)
            </span>
            <button
              style={{ padding: '2px 10px', border: '1px solid #000', borderRadius: 3, background: '#fff', cursor: 'pointer', fontSize: 12 }}
              onClick={async () => {
                const relPath = activeTab.relativePath;
                const content = await window.arcenApi.readFile(relPath);
                setFileContents((prev) => ({ ...prev, [relPath]: content }));
                setSavedContents((prev) => ({ ...prev, [relPath]: content }));
                allFileContentsRef.current[relPath] = content;
                setDiskConflicts((prev) => prev.filter((c) => c !== relPath));
              }}
            >
              Reload
            </button>
            <button
              style={{ padding: '2px 10px', border: '1px solid #000', borderRadius: 3, background: 'transparent', cursor: 'pointer', fontSize: 12 }}
              onClick={() => setDiskConflicts((prev) => prev.filter((c) => c !== activeTab.relativePath))}
            >
              Dismiss
            </button>
          </div>
        )}
        <div className="editor-container">
          {activeTab ? (
            <EditorPane
              key={activeTab.relativePath}
              relativePath={activeTab.relativePath}
              content={fileContents[activeTab.relativePath] ?? ''}
              savedContent={savedContents[activeTab.relativePath] ?? ''}
              schema={activeSchema}
              sharedSchema={sharedSchema}
              composedMergedSchema={composedSchemaForActive}
              isSchema={activeTab.type === 'schema'}
              onChange={updateContent}
              theme={theme}
              fkIndex={fkIndex}
              onNavigateToFK={handleNavigateToFK}
              onNavigateToMetadata={handleNavigateToMetadata}
              onAddUnknownSubNodeToSchema={handleAddUnknownSubNodeToSchema}
              onCursorFocusFile={(rp) => {
                // Left-click in the editor focuses the sidebar on this file,
                // like clicking its tab header — but without the 3s flash,
                // since clicks are frequent.
                const want = sidebarTabForPath(rp);
                setSidebarTab(want);
                if (want === 'files') setExpandedFolders((prev) => new Set(prev).add(folderNameOf(rp)));
                setScrollSidebarTo({ path: rp, highlight: false });
              }}
              scrollToLine={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.line : null}
              scrollHighlight={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.highlight : null}
              scrollToken={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine._t : null}
              scrollAbsPos={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.absPos : null}
              onScrolled={() => setPendingScrollLine(null)}
              editorViewRef={editorViewRef}
              localSearchStateRef={localSearchStateRef}
              editorScale={editorScale}
              onEditorScaleChange={setEditorScale}
              refPanelScale={refPanelScale}
              onRefPanelScaleChange={setRefPanelScale}
              selectionStateRef={selectionStateRef}
              spellchecker={spellchecker}
              fileLayer={layerByRelPath.get(activeTab.relativePath)?.layer || 'base'}
              fileExtraLayers={(() => {
                const l = layerByRelPath.get(activeTab.relativePath)?.layer;
                return l ? (layerMaps.modExtrasByLayer[l] || null) : null;
              })()}
            />
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: 'var(--text-dim)',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>Arcen XML Editor</div>
                <div>Open a file from the sidebar to begin editing</div>
                <button
                  onClick={async (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const anchor = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                    const currentRoot = await window.arcenApi.getDataRoot();
                    setDataRootPicker({ currentRoot, anchor });
                  }}
                  style={{
                    marginTop: 16, padding: '6px 16px', cursor: 'pointer',
                    background: 'var(--tab-bg)', color: '#fff', border: 'none',
                    borderRadius: 4, fontSize: 13,
                  }}
                >
                  Change Data Folder
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Global search resize handle — separate from the panel for reliable interaction */}
        {globalSearch && globalSearchHeight > 0 && (
          <div
            style={{
              height: 0, position: 'relative', flexShrink: 0,
            }}
          >
            <div
              style={{
                // Sit entirely below the editor/search boundary, over the panel's
                // 2px accent border + 8px top padding (no controls until 10px down),
                // so the editor's 10px horizontal scrollbar above stays fully grabbable.
                position: 'absolute', bottom: -10, left: 0, right: 0, height: 10,
                cursor: 'row-resize', zIndex: 20,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const startY = e.clientY;
                const startH = globalSearchHeight;
                const onMove = (ev) => {
                  const newH = Math.max(100, Math.min(window.innerHeight * 0.8, startH - (ev.clientY - startY)));
                  setGlobalSearchHeight(newH);
                };
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';
                  document.body.style.userSelect = '';
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                document.body.style.cursor = 'row-resize';
                document.body.style.userSelect = 'none';
              }}
            />
          </div>
        )}
        {/* Global Search — docked above status bar, inside main-area */}
        {globalSearch && (
          <GlobalSearch
            allFileContents={allFileContentsRef.current}
            searchScope={activeTab ? (activeTab.type === 'schema' ? 'schema' : 'xml') : 'xml'}
            panelHeight={globalSearchHeight}
            folders={folders}
            layerByRelPath={layerByRelPath}
            folderNameByRelPath={folderNameByRelPath}
            currentFile={globalSearch?.detachedFile || tabs[activeTabIndex]?.relativePath || null}
            scopeFilter={globalSearchScopeFilter}
            onScopeFilterChange={setGlobalSearchScopeFilter}
            includeMods={globalSearchIncludeMods}
            onIncludeModsChange={setGlobalSearchIncludeMods}
            initialReplace={globalSearch.replace}
            inputRef={globalSearchInputRef}
            replaceInputRef={globalSearchReplaceRef}
            minimizeRef={globalSearchMinimizeRef}
            persistedQuery={globalSearchQuery}
            onQueryChange={setGlobalSearchQuery}
            onOpenFile={(filePath, line, highlightText) => {
              const type = filePath.endsWith('.metadata') ? 'schema' : 'xml';
              openFile(filePath, type).then(() => {
                setPendingScrollLine({ _t: Date.now(), file: filePath, line, highlight: highlightText || globalSearchQuery });
              });
            }}
            onReplaceInFile={(filePath, newContent) => {
              allFileContentsRef.current[filePath] = newContent;
              // If file is open in a tab, update editor state
              if (fileContents[filePath] !== undefined) {
                setFileContents((prev) => ({ ...prev, [filePath]: newContent }));
              }
              // Always write to disk
              window.arcenApi.writeFile(filePath, newContent);
              setSavedContents((prev) => ({ ...prev, [filePath]: newContent }));
            }}
            onReplaceBatch={(changes) => {
              // changes: [{file, oldContent, newContent}]
              globalReplaceUndoRef.current.push({ files: changes });
              if (globalReplaceUndoRef.current.length > 5) globalReplaceUndoRef.current.shift();
              setGlobalUndoCount(globalReplaceUndoRef.current.length);
            }}
            undoAvailable={globalUndoCount > 0}
            onUndo={() => {
              const op = globalReplaceUndoRef.current.pop();
              if (!op) return;
              for (const { file, oldContent, newContent } of op.files) {
                if (allFileContentsRef.current[file] === newContent) {
                  allFileContentsRef.current[file] = oldContent;
                  if (fileContents[file] !== undefined) {
                    setFileContents((prev) => ({ ...prev, [file]: oldContent }));
                  }
                  window.arcenApi.writeFile(file, oldContent);
                  setSavedContents((prev) => ({ ...prev, [file]: oldContent }));
                }
              }
              setGlobalUndoCount(globalReplaceUndoRef.current.length);
            }}
            onClose={() => setGlobalSearch(null)}
          />
        )}
        <StatusBar
          theme={theme}
          onToggleTheme={toggleTheme}
          sidebarSide={sidebarSide}
          onToggleSidebarSide={() => setSidebarSide(s => s === 'left' ? 'right' : 'left')}
          validationErrors={validationErrors}
          activeFile={activeTab?.relativePath}
          onRevalidate={revalidateAll}
          onChangeDataRoot={async (e) => {
            const rect = e?.currentTarget?.getBoundingClientRect?.();
            const anchor = rect
              ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
              : undefined;
            const currentRoot = await window.arcenApi.getDataRoot();
            setDataRootPicker({ currentRoot, anchor });
          }}
          validationTimerDisplay={validationTimerDisplay}
          validationRunning={!!validationTiming?.running}
        />
      </div>

      {/* Go-To-Line Dialog — mounts once, opens via global custom event */}
      <GoToLineDialog />

      {/* Rename-ID Dialog — F2 on central-identifier opens this; performs batch FK update */}
      <RenameIdDialog onConfirm={handleIdRename} />

      {/* Grammar LLM settings — opens via grammarSettingsRequested event */}
      <GrammarSettings />

      {/* Data-root picker modal — opens from the "Change Data Folder" buttons */}
      {dataRootPicker && (
        <DataRootPicker
          currentRoot={dataRootPicker.currentRoot}
          anchor={dataRootPicker.anchor}
          onClose={() => setDataRootPicker(null)}
          onPicked={() => {
            setDataRootPicker(null);
            window.location.reload();
          }}
        />
      )}

      {/* Diff View Modal */}
      {diffTabIndex !== null && tabs[diffTabIndex] && (
        <DiffView
          oldText={savedContents[tabs[diffTabIndex].relativePath] || ''}
          newText={fileContents[tabs[diffTabIndex].relativePath] || ''}
          onClose={() => setDiffTabIndex(null)}
          onRevert={() => {
            const relPath = tabs[diffTabIndex].relativePath;
            const saved = savedContents[relPath];
            if (saved !== undefined) {
              setFileContents((prev) => ({ ...prev, [relPath]: saved }));
              allFileContentsRef.current[relPath] = saved;
            }
          }}
        />
      )}

      {/* (Global Search is now inside main-area, above StatusBar) */}

      {/* Tab context menu */}
      {tabContextMenu && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }}
          onClick={() => setTabContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setTabContextMenu(null); }}
        >
          <div
            style={{
              position: 'fixed', top: tabContextMenu.y, left: tabContextMenu.x, zIndex: 999,
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)', minWidth: 180, padding: '4px 0',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {tabContextMenu.items.map((item, i) => (
              item.divider ? (
                <div key={i} style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              ) : (
                <div
                  key={i}
                  style={{
                    padding: '6px 14px',
                    fontSize: 12,
                    cursor: item.enabled === false ? 'default' : 'pointer',
                    opacity: item.enabled === false ? 0.45 : 1,
                    color: 'var(--text)',
                  }}
                  onMouseEnter={(e) => { if (item.enabled !== false) e.currentTarget.style.background = 'var(--accent)'; }}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  onClick={() => { if (item.enabled !== false && item.action) item.action(); setTabContextMenu(null); }}
                >
                  {item.label}
                </div>
              )
            ))}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
