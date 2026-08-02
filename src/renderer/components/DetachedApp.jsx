/**
 * DetachedApp — simplified editor window for torn-off tabs.
 * No sidebar, no global search. Own tab bar, editor, status bar.
 * Communicates with main window via IPC for shared state.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import TabBar from './TabBar';
import EditorPane from './EditorPane';
import StatusBar from './StatusBar';
import DiffView from './DiffView';
import TitleBar from './TitleBar';
import { fileDisplayName } from '../editor/layerDisplay';
import GoToLineDialog from './GoToLineDialog';
import GrammarSettings from './GrammarSettings';
import RenameIdDialog from './RenameIdDialog';
import { tokenize, buildAttrMap } from '../editor/xmlTokenizer';
const vcsStore = require('../editor/vcsStore');
import { parseMetadata, parseSharedMetadata, buildMergedSchema, getCentralIdentifierKey, composeSchemaForFileLayer } from '../editor/schemaParser';
import { buildFKIndex, updateTableIndex, buildLookupSwaps } from '../editor/fkIndex';
import { navigateToFKRow, navigateToMetadataDef, addUnknownSubNodeStub } from '../editor/navigation';
import { makeDevAwareChecker } from '../editor/spellcheck';
import { buildLayerMaps } from '../editor/validation';
import { validateXMLFile } from '../editor/validation';
import NSpell from 'nspell';

function replaceIdInValue(attrValue, oldId, newId) {
  if (attrValue === oldId) return newId;
  return attrValue.split(',').map(p => {
    const trimmed = p.trim();
    if (trimmed !== oldId) return p;
    const idx = p.indexOf(trimmed);
    return p.slice(0, idx) + newId + p.slice(idx + trimmed.length);
  }).join(',');
}

export default function DetachedApp({ windowId }) {
  const [theme, setTheme] = useState('light');
  const [tabs, setTabs] = useState([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [fileContents, setFileContents] = useState({});
  const [savedContents, setSavedContents] = useState({});
  const [validationErrors, setValidationErrors] = useState([]);
  const [diffTabIndex, setDiffTabIndex] = useState(null);
  const [diskConflicts, setDiskConflicts] = useState([]);
  const [editorScale, setEditorScale] = useState(100);
  const [refPanelScale, setRefPanelScale] = useState(100);
  const [pendingScrollLine, setPendingScrollLine] = useState(null);
  // Bumped by "Re-validate All" so the live-validation effect re-runs even when
  // no content/schema input changed.
  const [revalidateNonce, setRevalidateNonce] = useState(0);

  const allFileContentsRef = useRef({});
  const schemasRef = useRef({});
  // Bumped whenever schemasRef / sharedSchemaRef are replaced from disk. Those
  // are refs (mutating them can't trigger a render), but activeSchema and
  // composedMergedSchema are derived from them during render — so a schema that
  // changed on disk would sit in the ref, unused, until some unrelated state
  // change happened to re-render. This is the render trigger.
  const [schemaVersion, setSchemaVersion] = useState(0);
  // metadataRelPath → { modLayer, folderName } for mod schema EXTENSIONS, so the
  // file watcher can tell an extension apart from a table's primary schema.
  // Without it, a change to `XMLMods/<Mod>/GameEntity/_GameEntity.metadata`
  // would overwrite the real GameEntity schema with the extension's much
  // shorter attribute list. Mirrors App.jsx's extensionsMetaRef.
  const extensionsMetaRef = useRef(new Map());
  // "Island" data files (self-contained extra data sources, decoded from YAML
  // by the main process). relPath → standalone schema. State, not a ref, so the
  // composedMergedSchema memo recomputes when islands finish loading. Mirrors
  // App.jsx — see [[detached-window-parity]].
  const [islandSchemaByRelPath, setIslandSchemaByRelPath] = useState(() => new Map());
  const islandRelPathsRef = useRef(new Set()); // island data files → view-only save guard
  // Resolved external-YAML FK values (cross-file refs via GUID links), keyed by
  // island data-file relPath then yaml_source id. Feeds the yaml-list/-dropdown
  // pickers so detached island tabs behave identically to the main window.
  // Re-pushed by main via onIslandYamlSourcesChanged when a referenced file
  // changes. Mirrors App.jsx — see [[detached-window-parity]].
  const [islandYamlSources, setIslandYamlSources] = useState({});
  const islandYamlSourcesRef = useRef({});
  const sharedSchemaRef = useRef(null);
  const fkIndexRef = useRef({});
  const lookupSwapsRef = useRef({});
  const foldersRef = useRef([]);
  // SharedMetaData path — needed by Ctrl+click-to-metadata navigation so it can
  // search the shared schema for an attribute's declaration.
  const sharedMetadataRelPathRef = useRef('SharedMetaData.metadata');
  // relativePath → logical folder name. Suite-mode paths carry a layer prefix
  // so the folder can't be derived by splitting on '/'.
  const folderNameByRelPathRef = useRef(new Map());
  function folderNameOf(relPath) {
    return folderNameByRelPathRef.current.get(relPath) || relPath.split('/')[0];
  }
  // relativePath → { layer, layerNum } for non-base files (tab tags).
  const [layerByRelPath, setLayerByRelPath] = useState(new Map());
  // Parsed mod schema extensions: { [modLayer]: { [folderName]: parsedExt } }.
  // Loaded at startup so files inside a mod see the extra attributes/sub-nodes
  // that mod's _<Table>.metadata contributes (otherwise the editor flags them
  // as unknown). Base/DLC files never have extensions, so this stays inert for
  // them. State (not a ref) so the composed-schema memo recomputes once the
  // async load commits.
  const [schemaExtensions, setSchemaExtensions] = useState({});
  // Layer info maps — needed by the FK picker's mod-deps widening. The full
  // map gets stashed in a ref because EditorPane reads through getters.
  const layerMapsRef = useRef({ expansionDirNameToLayer: {}, modFolderNameToLayer: {}, modDisplayByLayer: {}, modExtrasByLayer: {} });
  const editorViewRef = useRef(null);
  const selectionStateRef = useRef({});
  const localSearchStateRef = useRef(null);
  const recentSavesRef = useRef(new Set());
  const sessionLoadedRef = useRef(false);
  // Current tabs, read by once-registered IPC handlers without re-subscribing.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIndexRef = useRef(activeTabIndex);
  activeTabIndexRef.current = activeTabIndex;
  // Activation history (relativePaths, most-recent LAST) so tearing out the
  // active tab can fall back to the tab the user was on before it.
  const activationHistoryRef = useRef([]);
  const [spellchecker, setSpellchecker] = useState(null);
  const spellcheckerRef = useRef(null);
  // Dev-only dictionary words, consulted by the dev-aware checker wrapper.
  const devWordsRef = useRef(new Set());
  const navHistoryRef = useRef({ list: [], pos: -1 });
  const navSkipRef = useRef(false);
  const [navState, setNavState] = useState({ canBack: false, canForward: false });

  // ── Startup: load shared state and restore tabs ──
  useEffect(() => {
    (async () => {
      // Get theme
      const info = await window.arcenApi.getWindowInfo();

      // Load all data (same as main window startup)
      const data = await window.arcenApi.discoverData();
      foldersRef.current = data.folders;
      {
        const m = new Map();
        const layerM = new Map();
        for (const folder of data.folders) {
          for (const xf of folder.xmlFiles) {
            m.set(xf.relativePath, folder.name);
            if (xf.layer && xf.layer !== 'base') {
              layerM.set(xf.relativePath, { layer: xf.layer, layerNum: xf.layerNum });
            }
          }
          if (folder.metadataRelPath) m.set(folder.metadataRelPath, folder.name);
        }
        folderNameByRelPathRef.current = m;
        setLayerByRelPath(layerM);
        layerMapsRef.current = buildLayerMaps(data.expansions, data.mods);
      }

      let shared = null;
      if (data.sharedMetadataPath) {
        const sharedContent = await window.arcenApi.readFile(data.sharedMetadataPath);
        shared = parseSharedMetadata(sharedContent);
        sharedSchemaRef.current = shared;
      }

      const schemaMap = {};
      for (const folder of data.folders) {
        // Schemaless folders (data with no .metadata in any layer) skip schema
        // loading. They still appear in the tree and their files open in the
        // editor; they just don't get attribute-level validation.
        if (!folder.metadataPath) continue;
        const metaContent = await window.arcenApi.readFile(folder.metadataPath);
        schemaMap[folder.name] = parseMetadata(metaContent, folder.name);
      }
      schemasRef.current = schemaMap;

      // Parse mod schema extensions (the _<Table>.metadata files a mod ships to
      // add fields/sub-nodes to a table whose primary schema lives in base/DLC).
      // Mirrors the main window's loadExtensionsAndIndex; without this, mod data
      // files opened here flag every mod-added attribute as unknown.
      const extensionsMap = {};
      const extMeta = new Map();
      for (const ext of (data.schemaExtensions || [])) {
        try {
          const txt = await window.arcenApi.readFile(ext.metadataRelPath);
          const parsed = parseMetadata(txt, ext.folderName);
          if (!parsed) continue;
          if (!extensionsMap[ext.modLayer]) extensionsMap[ext.modLayer] = {};
          extensionsMap[ext.modLayer][ext.folderName] = parsed;
          extMeta.set(ext.metadataRelPath, { modLayer: ext.modLayer, folderName: ext.folderName });
        } catch (_) {}
      }
      extensionsMetaRef.current = extMeta;
      setSchemaExtensions(extensionsMap);

      // Parse island standalone schemas, indexed by each island data file's
      // relPath. The decode itself happens in the main process (read-file), so
      // a detached island tab shows decoded XML regardless; this just feeds the
      // schema for highlighting/autocomplete. Mirrors App.jsx loadIslands.
      {
        const islandMap = new Map();
        for (const isl of (data.islands || [])) {
          let parsed = null;
          try {
            const txt = await window.arcenApi.readFile(isl.metadataRelPath);
            parsed = parseMetadata(txt, isl.name);
          } catch (_) {}
          if (!parsed) continue;
          for (const f of (isl.files || [])) islandMap.set(f.relativePath, parsed);
        }
        // Data-file relPaths (even from islands whose metadata failed to parse)
        // for the view-only save guard.
        const relSet = new Set();
        for (const isl of (data.islands || [])) {
          for (const f of (isl.files || [])) relSet.add(f.relativePath);
        }
        islandRelPathsRef.current = relSet;
        setIslandSchemaByRelPath(islandMap);
      }

      // Resolved cross-YAML FK values for the island pickers (same payload the
      // main window gets from discover-data).
      islandYamlSourcesRef.current = data.islandYamlSources || {};
      setIslandYamlSources(data.islandYamlSources || {});

      const bulk = {};
      for (const folder of data.folders) {
        for (const xmlFile of folder.xmlFiles) {
          try { bulk[xmlFile.relativePath] = await window.arcenApi.readFile(xmlFile.relativePath); } catch (_) {}
        }
        if (folder.metadataRelPath) {
          try { bulk[folder.metadataRelPath] = await window.arcenApi.readFile(folder.metadataPath); } catch (_) {}
        }
      }
      const sharedRel = data.sharedMetadataRelPath || 'SharedMetaData.metadata';
      sharedMetadataRelPathRef.current = sharedRel;
      if (data.sharedMetadataPath) {
        try { bulk[sharedRel] = await window.arcenApi.readFile(data.sharedMetadataPath); } catch (_) {}
      }
      allFileContentsRef.current = bulk;

      const centralIdKey = getCentralIdentifierKey(shared);
      lookupSwapsRef.current = buildLookupSwaps(bulk, centralIdKey);
      fkIndexRef.current = buildFKIndex(data.folders, bulk, schemaMap, centralIdKey);

      // Restore session for this detached window. Normalize any legacy
      // backslash-separated paths from older session writes + dedupe so
      // collapsed duplicates don't produce two tabs for the same file.
      const detachedSession = await window.arcenApi.getDetachedSession();
      const rawTabPaths = detachedSession?.tabs || [];
      const tabPaths = [];
      const seen = new Set();
      for (const raw of rawTabPaths) {
        const p = typeof raw === 'string' ? raw.replace(/\\/g, '/') : raw;
        if (seen.has(p)) continue;
        seen.add(p);
        tabPaths.push(p);
      }
      // Per-tab data (cursor, scroll, ref panel) is in the central file state registry
      // — EditorPane loads it directly via getFileState on mount
      const restoredTabs = [];
      const restoredContents = {};
      const restoredSaved = {};
      // A tear-off into THIS newly-created window hands over the source's
      // in-memory buffer (one-shot, in the session payload); seed from it so
      // unsaved edits aren't lost to a disk re-read.
      const seedBuffers = detachedSession?.seedBuffers || {};
      for (const relPath of tabPaths) {
        const seed = seedBuffers[relPath];
        let content, saved;
        if (seed && typeof seed.content === 'string') {
          content = seed.content;
          saved = typeof seed.saved === 'string' ? seed.saved : seed.content;
        } else {
          content = await window.arcenApi.readFile(relPath);
          saved = content;
        }
        restoredTabs.push({
          relativePath: relPath,
          type: relPath.endsWith('.metadata') ? 'schema' : 'xml',
        });
        restoredContents[relPath] = content;
        restoredSaved[relPath] = saved;
      }
      setTabs(restoredTabs);
      setFileContents(restoredContents);
      setSavedContents(restoredSaved);
      setActiveTabIndex(detachedSession?.activeTab ?? 0);
      sessionLoadedRef.current = true;

      // Initialize spellchecker. Wrapped with the same dev-aware checker the
      // main window uses: without it the DEV dictionary was ignored here
      // entirely, so words the main window accepted in a dev context were
      // flagged as misspelled in every detached window.
      try {
        const dictData = await window.arcenApi.loadSpellingDictionary();
        devWordsRef.current = new Set(dictData.devCustom || []);
        if (dictData.aff && dictData.dic) {
          // NSpell imported at top level
          const nspell = new NSpell(dictData.aff, dictData.dic);
          if (dictData.custom?.length) {
            for (const word of dictData.custom) nspell.add(word);
          }
          const checker = makeDevAwareChecker(nspell, devWordsRef);
          spellcheckerRef.current = checker;
          setSpellchecker(checker);
        }
      } catch (e) {
        console.error('Failed to initialize spellchecker:', e);
      }

      // Register tabs with main process
      window.arcenApi.registerWindowTabs(tabPaths);
    })();
  }, []);

  // Listen for dictionary changes
  useEffect(() => {
    const pokeActiveEditor = () => {
      const view = editorViewRef.current;
      if (!view) return;
      try {
        const pos = view.state.doc.length;
        view.dispatch({ changes: { from: pos, insert: ' ' } });
        view.dispatch({ changes: { from: pos, to: pos + 1 } });
      } catch (_) {}
    };

    const unsubscribeDictionaryChanged = window.arcenApi.onDictionaryChanged(async () => {
      try {
        const dictData = await window.arcenApi.loadSpellingDictionary();
        devWordsRef.current = new Set(dictData.devCustom || []);
        if (dictData.aff && dictData.dic) {
          // NSpell imported at top level
          const nspell = new NSpell(dictData.aff, dictData.dic);
          if (dictData.custom?.length) {
            for (const word of dictData.custom) nspell.add(word);
          }
          const checker = makeDevAwareChecker(nspell, devWordsRef);
          spellcheckerRef.current = checker;
          setSpellchecker(checker);
          // Poke the active editor so its ViewPlugin rebuilds decorations with
          // the new dictionary — otherwise squiggles stay stale until typing.
          pokeActiveEditor();
        }
      } catch (e) {
        console.error('Failed to reload dictionary:', e);
      }
    });
    const unsubscribeDictionaryWordAdded = window.arcenApi.onDictionaryWordAdded((word) => {
      if (!word) return;
      spellcheckerRef.current?.add?.(word);
      pokeActiveEditor();
    });
    const unsubscribeDictionaryWordsAdded = window.arcenApi.onDictionaryWordsAdded?.((words) => {
      for (const word of new Set(Array.isArray(words) ? words : [])) {
        if (typeof word === 'string' && word) spellcheckerRef.current?.add?.(word);
      }
      pokeActiveEditor();
    });
    // Dev-dictionary additions go into devWordsRef, not the NSpell instance —
    // they're only accepted in dev contexts. This window used to ignore the
    // event entirely, so a word added from the main window kept its squiggle
    // here until restart.
    const unsubscribeDevDictionaryWordAdded = window.arcenApi.onDevDictionaryWordAdded?.((word) => {
      if (typeof word !== 'string' || !word) return;
      devWordsRef.current.add(word);
      pokeActiveEditor();
    });
    return () => {
      unsubscribeDictionaryChanged?.();
      unsubscribeDictionaryWordAdded?.();
      unsubscribeDictionaryWordsAdded?.();
      unsubscribeDevDictionaryWordAdded?.();
    };
  }, []);

  // ── Theme sync ──
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    window.arcenApi.onThemeChange((t) => setTheme(t));
    window.arcenApi.onEditorScaleChange((s) => setEditorScale(s));
    window.arcenApi.onRefPanelScaleChange((s) => setRefPanelScale(s));
  }, []);

  // ── VCS / Plugin store ──
  useEffect(() => {
    vcsStore.init();
  }, []);

  // ── Tab added/removed by main process (drag between windows) ──
  // Registered ONCE (empty deps) and reads current tabs/active index through
  // refs. Re-registering on every `tabs` change used to stack duplicate
  // listeners (preload's on* now also clears prior handlers), and each stale
  // copy fired its own activeTabIndex update — which is what left the window
  // blank after dragging a tab out.
  useEffect(() => {
    const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
    window.arcenApi.onTabAdded(async (raw, buffer) => {
      const relativePath = norm(raw);
      // A lossless tear-off carries the source window's { content, saved }; seed
      // from it so unsaved edits move with the tab instead of re-reading disk.
      let content, saved;
      if (buffer && typeof buffer.content === 'string') {
        content = buffer.content;
        saved = typeof buffer.saved === 'string' ? buffer.saved : buffer.content;
      } else {
        content = await window.arcenApi.readFile(relativePath);
        saved = content;
      }
      const type = relativePath.endsWith('.metadata') ? 'schema' : 'xml';
      setTabs(prev => {
        const dup = prev.findIndex(t => t.relativePath === relativePath);
        if (dup >= 0) { setActiveTabIndex(dup); return prev; }
        const next = [...prev, { relativePath, type }];
        setActiveTabIndex(next.length - 1); // focus the newly added tab
        return next;
      });
      setFileContents(prev => ({ ...prev, [relativePath]: content }));
      setSavedContents(prev => ({ ...prev, [relativePath]: saved }));
      syncTabs();
    });

    window.arcenApi.onTabRemoved((raw) => {
      const relativePath = norm(raw);
      setTabs(prev => {
        const removedIdx = prev.findIndex(t => t.relativePath === relativePath);
        if (removedIdx < 0) return prev;
        const filtered = prev.filter(t => t.relativePath !== relativePath);
        if (filtered.length === 0) { setActiveTabIndex(-1); return filtered; }
        setActiveTabIndex(curIdx => {
          const curPath = prev[curIdx]?.relativePath;
          // A non-active tab was removed → keep the current tab selected.
          if (curPath && curPath !== relativePath) {
            const ni = filtered.findIndex(t => t.relativePath === curPath);
            if (ni >= 0) return ni;
          }
          // The active tab was torn out → fall back to the most recently
          // active surviving tab (activation history, newest last), then to
          // the last tab in the list.
          const hist = activationHistoryRef.current;
          for (let i = hist.length - 1; i >= 0; i--) {
            if (hist[i] === relativePath) continue;
            const ni = filtered.findIndex(t => t.relativePath === hist[i]);
            if (ni >= 0) return ni;
          }
          return filtered.length - 1;
        });
        return filtered;
      });
      activationHistoryRef.current = activationHistoryRef.current.filter(p => p !== relativePath);
      // Drop the buffers for a tab that moved to another window — same reasoning
      // as App.jsx's onTabRemoved: a leftover copy reads as "unsaved edits here"
      // and makes the save notification for that file take the conflict branch
      // instead of refreshing this window's cache and FK index.
      setFileContents(prev => {
        if (prev[relativePath] === undefined) return prev;
        const next = { ...prev };
        delete next[relativePath];
        return next;
      });
      setSavedContents(prev => {
        if (prev[relativePath] === undefined) return prev;
        const next = { ...prev };
        delete next[relativePath];
        return next;
      });
      syncTabs();
    });

    window.arcenApi.onFocusTab((raw) => {
      const relativePath = norm(raw);
      const idx = tabsRef.current.findIndex(t => t.relativePath === relativePath);
      if (idx >= 0) setActiveTabIndex(idx);
    });

    // Jump requests routed here by the main process: from the validation window,
    // or from another window's Ctrl+click navigation into a file THIS window
    // owns. `highlight` / `absPos` were previously dropped, so a relayed jump
    // landed on the line without selecting the id/attribute the user clicked
    // through to; `_t` makes a repeat of the same jump re-fire (EditorPane keys
    // its scroll effect on the token). See [[detached-window-parity]].
    window.arcenApi.onNavigateToLine((rawFile, line, highlight, absPos) => {
      const file = norm(rawFile);
      const idx = tabsRef.current.findIndex(t => t.relativePath === file);
      if (idx >= 0) {
        setActiveTabIndex(idx);
        setPendingScrollLine({
          _t: Date.now(), file, line,
          highlight: highlight || null,
          absPos: absPos != null ? absPos : null,
        });
      }
    });
  }, []);

  // ── File watcher ──
  // Registered once; uses latest-state refs instead of re-running the effect
  // on every state change (which would accumulate IPC listeners indefinitely).
  const fileContentsLatest = useRef(fileContents);
  const savedContentsLatest = useRef(savedContents);
  useEffect(() => { fileContentsLatest.current = fileContents; }, [fileContents]);
  useEffect(() => { savedContentsLatest.current = savedContents; }, [savedContents]);

  // Tear a tab off this window, carrying its in-memory buffer (current + saved
  // baseline) so unsaved edits move with it losslessly.
  const handleDetachTab = useCallback((relativePath, screenX, screenY) => {
    const content = fileContentsLatest.current[relativePath];
    const saved = savedContentsLatest.current[relativePath];
    const buffer = typeof content === 'string'
      ? { content, saved: typeof saved === 'string' ? saved : content }
      : null;
    window.arcenApi.detachTabAtPosition(relativePath, screenX, screenY, buffer);
  }, []);

  // Re-run discovery and refresh everything derived from it: folder/layer
  // lookups, mod schema extensions, islands, plus any schema or file content
  // that appeared on disk after startup. Shared by the mod-set-changed and
  // file-added paths. Mirrors the main window's applyDiscovery +
  // syncNewlyDiscovered — see [[detached-window-parity]].
  const refreshDiscoveredData = useCallback(async () => {
    let data;
    try {
      data = await window.arcenApi.discoverData();
    } catch (e) {
      console.warn('[detached] discovery refresh failed:', e);
      return;
    }
    foldersRef.current = data.folders;

    const m = new Map();
    const layerM = new Map();
    for (const folder of data.folders) {
      for (const xf of folder.xmlFiles) {
        m.set(xf.relativePath, folder.name);
        if (xf.layer && xf.layer !== 'base') {
          layerM.set(xf.relativePath, { layer: xf.layer, layerNum: xf.layerNum });
        }
      }
      if (folder.metadataRelPath) m.set(folder.metadataRelPath, folder.name);
    }
    folderNameByRelPathRef.current = m;
    setLayerByRelPath(layerM);
    layerMapsRef.current = buildLayerMaps(data.expansions, data.mods);
    sharedMetadataRelPathRef.current = data.sharedMetadataRelPath || 'SharedMetaData.metadata';

    // Mod schema extensions (a mod may have just gained a partial schema file).
    const extensionsMap = {};
    const extMeta = new Map();
    for (const ext of (data.schemaExtensions || [])) {
      try {
        const txt = await window.arcenApi.readFile(ext.metadataRelPath);
        const parsed = parseMetadata(txt, ext.folderName);
        if (!parsed) continue;
        if (!extensionsMap[ext.modLayer]) extensionsMap[ext.modLayer] = {};
        extensionsMap[ext.modLayer][ext.folderName] = parsed;
        extMeta.set(ext.metadataRelPath, { modLayer: ext.modLayer, folderName: ext.folderName });
      } catch (_) {}
    }
    extensionsMetaRef.current = extMeta;
    setSchemaExtensions(extensionsMap);

    // Islands (a new .asset data file may have appeared).
    {
      const islandMap = new Map();
      const relSet = new Set();
      for (const isl of (data.islands || [])) {
        let parsed = null;
        try {
          const txt = await window.arcenApi.readFile(isl.metadataRelPath);
          parsed = parseMetadata(txt, isl.name);
        } catch (_) {}
        for (const f of (isl.files || [])) {
          relSet.add(f.relativePath);
          if (parsed) islandMap.set(f.relativePath, parsed);
        }
      }
      islandRelPathsRef.current = relSet;
      setIslandSchemaByRelPath(islandMap);
    }

    // Schemas and file contents this session has never seen. Only the missing
    // ones are read — edits to known files come through the change watcher.
    const contents = allFileContentsRef.current;
    const touchedTables = new Set();
    let schemaAdded = false;
    for (const folder of data.folders) {
      if (folder.metadataPath && !schemasRef.current[folder.name]) {
        try {
          const txt = await window.arcenApi.readFile(folder.metadataPath);
          const parsed = parseMetadata(txt, folder.name);
          if (parsed) {
            schemasRef.current = { ...schemasRef.current, [folder.name]: parsed };
            schemaAdded = true;
            touchedTables.add(folder.name);
          }
          if (folder.metadataRelPath && contents[folder.metadataRelPath] === undefined) {
            contents[folder.metadataRelPath] = txt;
          }
        } catch (_) {}
      }
      for (const xf of folder.xmlFiles) {
        if (contents[xf.relativePath] !== undefined) continue;
        try {
          contents[xf.relativePath] = await window.arcenApi.readFile(xf.relativePath);
          touchedTables.add(folder.name);
        } catch (_) {}
      }
    }
    for (const name of touchedTables) foldTableIntoFKIndex(name, data.folders);
    if (schemaAdded) setSchemaVersion((v) => v + 1);
  }, []);
  // Read by the once-registered IPC handlers below instead of re-subscribing.
  const refreshDiscoveredDataRef = useRef(null);
  refreshDiscoveredDataRef.current = refreshDiscoveredData;
  // Latest applyBufferUpdatesLocally, for the once-registered IPC effect below.
  const applyBufferUpdatesLocallyRef = useRef(null);

  useEffect(() => {
    // Normalize any backslash separators on incoming paths so content
    // state never accumulates two entries for the same file — see the
    // long comment on the matching effect in App.jsx.
    const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
    // Mods/expansions changed on disk (main re-scanned the mod sources). Detached
    // windows have no sidebar/MODS tab, but their cross-layer validation relies on
    // the layer maps + folder lookups built from discoverData — refresh those so a
    // newly-added mod's layer is recognized without a restart. See
    // detached-window-parity.
    window.arcenApi.onLayersChanged(() => { refreshDiscoveredDataRef.current?.(); });

    // A file appeared on disk (new XML data file, new `.metadata`, a mod's new
    // partial schema). The main window refreshes its sidebar here; this window
    // has no sidebar but does need the new schema/content, or it treats what's
    // on disk as absent — flagging every attribute a brand-new metadata file
    // declares as unknown — until a restart. Debounced because chokidar fires a
    // burst for bulk operations (folder rename, VCS update).
    let addRefreshTimer = null;
    window.arcenApi.onFileAddedOnDisk?.(() => {
      if (addRefreshTimer) clearTimeout(addRefreshTimer);
      addRefreshTimer = setTimeout(() => {
        addRefreshTimer = null;
        refreshDiscoveredDataRef.current?.();
      }, 200);
    });

    // An F2 rename performed in another window. Rewrites this window's tabs for
    // the affected files, so its editor stops showing the old id — and, more to
    // the point, so saving here doesn't write the old id back over the rename.
    window.arcenApi.onBufferUpdatesApplied?.((updates) => {
      const skipped = applyBufferUpdatesLocallyRef.current?.(updates) || [];
      if (skipped.length > 0) {
        console.warn('[rename] skipped files whose content had moved on:', skipped);
        try {
          globalThis.alert?.(
            'Some files could not be renamed here because they had unsaved changes '
            + 'that the renaming window had not seen yet:\n\n'
            + skipped.join('\n')
            + '\n\nSave those files and run the rename again.'
          );
        } catch (_) {}
      }
    });

    // "Re-validate All" from the validator window. This window owns the live
    // results for its active tab, so without re-running here that file's entries
    // stayed frozen at whatever the last edit produced — the button looked like
    // it skipped one file. Bumping the nonce re-runs the live-validation effect.
    window.arcenApi.onRequestRevalidate?.(() => setRevalidateNonce((n) => n + 1));

    // A file (or folder) renamed in another window. Re-key our tabs and caches,
    // or this window keeps a tab pointing at a path that no longer exists —
    // reads fail, and saving it writes the old filename back to disk.
    window.arcenApi.onFileRenamed?.((rawOld, rawNew, isFolder) => {
      const oldPath = norm(rawOld);
      const newPath = norm(rawNew);
      const oldPrefix = oldPath + '/';
      const newPrefix = newPath + '/';
      const rekey = (rel) => {
        if (rel === oldPath) return newPath;
        if (isFolder && rel.startsWith(oldPrefix)) return newPrefix + rel.slice(oldPrefix.length);
        return rel;
      };
      const rekeyMap = (obj) => {
        let changed = false;
        const next = {};
        for (const [k, v] of Object.entries(obj)) {
          const nk = rekey(k);
          if (nk !== k) changed = true;
          next[nk] = v;
        }
        return changed ? next : obj;
      };
      allFileContentsRef.current = rekeyMap(allFileContentsRef.current);
      folderNameByRelPathRef.current = new Map(
        [...folderNameByRelPathRef.current].map(([k, v]) => [rekey(k), v])
      );
      const nextIslands = new Set();
      for (const p of islandRelPathsRef.current) nextIslands.add(rekey(p));
      islandRelPathsRef.current = nextIslands;
      setFileContents(prev => rekeyMap(prev));
      setSavedContents(prev => rekeyMap(prev));
      setTabs(prev => {
        let changed = false;
        const next = prev.map(t => {
          const np = rekey(t.relativePath);
          if (np === t.relativePath) return t;
          changed = true;
          return { ...t, relativePath: np };
        });
        return changed ? next : prev;
      });
      syncTabs();
    });

    // An unsaved buffer mirrored from another window — cache only, same as the
    // main window's handler (we have no tab for it; if we did, we'd own it).
    window.arcenApi.onLiveBufferChanged?.((rawRelPath, content) => {
      const relPath = norm(rawRelPath);
      if (typeof content !== 'string') return;
      if (tabsRef.current.some(t => t.relativePath === relPath)) return;
      allFileContentsRef.current[relPath] = content;
    });

    window.arcenApi.onFileChangedOnDisk((rawRelPath) => {
      const relPath = norm(rawRelPath);
      if (recentSavesRef.current.has(relPath)) return;
      window.arcenApi.readFile(relPath).then((content) => {
        const cur = fileContentsLatest.current[relPath];
        const sav = savedContentsLatest.current[relPath];
        // Same guard as App.jsx: only a tab we still hold can have unsaved edits
        // to protect. A leftover buffer would otherwise divert a save made in
        // another window into the conflict path.
        const haveTab = tabsRef.current.some(t => t.relativePath === relPath);
        if (haveTab && cur !== undefined && cur !== sav) {
          if (content === cur) {
            setSavedContents(prev => ({ ...prev, [relPath]: content }));
            return;
          }
          setDiskConflicts(prev => prev.includes(relPath) ? prev : [...prev, relPath]);
          return;
        }
        allFileContentsRef.current[relPath] = content;
        // Keep FK pickers current for externally-changed XML (main window,
        // external tools, VCS) — no-ops for .metadata internally.
        foldXmlFileIntoFKIndex(relPath);
        // A changed `.metadata` has to be re-parsed into this window's schemas,
        // or the editor keeps validating/highlighting against the schema as it
        // was when this window opened. That was the gap behind "metadata written
        // on disk looked absent until I restarted": the main window re-parsed,
        // detached windows never did.
        if (relPath.endsWith('.metadata')) applyMetadataFromDisk(relPath, content);
        if (fileContentsLatest.current[relPath] !== undefined) {
          setFileContents(prev => ({ ...prev, [relPath]: content }));
          setSavedContents(prev => ({ ...prev, [relPath]: content }));
        }
      });
    });

    // Live cross-YAML FK values: a referenced source file (e.g. an archetype
    // YAML) changed on disk and main re-resolved. Keep the detached pickers in
    // sync exactly like the main window.
    window.arcenApi.onIslandYamlSourcesChanged?.((map) => {
      islandYamlSourcesRef.current = map || {};
      setIslandYamlSources(map || {});
    });

    // Merged project-wide validation results (main process broadcasts these to
    // every detached window). Drives this window's StatusBar error count so it
    // matches the main window exactly. This window also CONTRIBUTES results for
    // its active tab via sendValidationResults (see the live-validation effect).
    window.arcenApi.onValidationResults?.((results) => {
      setValidationErrors(Array.isArray(results) ? results : []);
    });
  }, []);

  function syncTabs() {
    setTimeout(() => {
      setTabs(current => {
        window.arcenApi.registerWindowTabs(current.map(t => t.relativePath));
        return current;
      });
    }, 100);
  }

  // ── Modified files ──
  const modifiedFiles = useMemo(() => new Set(
    tabs.filter(t => fileContents[t.relativePath] !== savedContents[t.relativePath]).map(t => t.relativePath)
  ), [tabs, fileContents, savedContents]);

  // ── Open file ──
  const openFile = useCallback(async (relativePath, type = 'xml') => {
    const normPath = relativePath.replace(/\\/g, '/');
    const existing = tabs.findIndex(t => t.relativePath === normPath);
    if (existing >= 0) { setActiveTabIndex(existing); return; }

    const content = await window.arcenApi.readFile(normPath);
    allFileContentsRef.current[normPath] = content;
    setTabs(prev => [...prev, { relativePath: normPath, type }]);
    setFileContents(prev => ({ ...prev, [normPath]: content }));
    setSavedContents(prev => ({ ...prev, [normPath]: content }));
    setActiveTabIndex(tabs.length);
    syncTabs();
  }, [tabs]);

  // ── Open a file AND scroll to a line, wherever that file lives ──
  //
  // Mirrors App.jsx's jumpToFile. A tab belongs to exactly one window, so a
  // Ctrl+click target may be open in the main window or a sibling detached
  // window; opening a second copy here would fork the buffer. Ask the main
  // process who owns it (which also raises that window) and relay the jump via
  // `navigate-to-line` instead. Resolves { local: false } on a hand-off so
  // navigation.js knows not to edit a buffer this window doesn't own.
  //
  // The local-tabs check comes first because find-window-for-tab would report
  // THIS window as the owner for a tab we already have. See
  // [[detached-window-parity]].
  const jumpToFile = useCallback(async ({ file, type = 'xml', line = null, highlight = null }) => {
    if (!tabsRef.current.some((t) => t.relativePath === file)) {
      const owner = await window.arcenApi.findWindowForTab(file);
      if (owner?.found) {
        if (line != null) window.arcenApi.navigateToLine(file, line, highlight, null);
        return { local: false };
      }
    }
    await openFile(file, type);
    if (line != null) setPendingScrollLine({ _t: Date.now(), file, line, highlight });
    return { local: true };
  }, [openFile]);

  // ── Close tab ──
  const closeTab = useCallback((index) => {
    const tab = tabs[index];
    if (!tab) return;
    const relPath = tab.relativePath;
    const saved = savedContents[relPath];
    const discarding = fileContents[relPath] !== saved;
    if (discarding) {
      if (!confirm(`${relPath} has unsaved changes. Close anyway?`)) return;
      // Those unsaved edits were mirrored into the other windows' content
      // caches; the user just threw them away, so put the on-disk text back or
      // global search would keep reporting text that no longer exists anywhere.
      if (typeof saved === 'string') {
        allFileContentsRef.current[relPath] = saved;
        pushedBuffersRef.current.set(relPath, saved);
        window.arcenApi.pushLiveBuffer?.(relPath, saved);
      }
    }
    // Either way this window no longer owns the buffer — drop the mirror
    // baseline so a later re-open starts clean.
    if (!discarding) pushedBuffersRef.current.delete(relPath);
    setTabs(prev => prev.filter((_, i) => i !== index));
    if (activeTabIndex >= index && activeTabIndex > 0) setActiveTabIndex(prev => prev - 1);
    syncTabs();
  }, [tabs, activeTabIndex, fileContents, savedContents]);

  // Rebuild one table's slice of this window's FK index from cached content,
  // across every layer, so a brand-new core node is immediately pickable in the
  // FK dropdowns/lists without a restart — matching the main window. The
  // detached window keeps its index in a ref (no validator of its own), so this
  // only mutates the ref; the re-render from the triggering save/reload/refresh
  // hands the fresh index to EditorPane.
  //
  // `folderList` defaults to the current discovery; a refresh in flight passes
  // its own list, since foldersRef may not yet be the one being folded.
  const foldTableIntoFKIndex = useCallback((folderName, folderList = null) => {
    const folder = (folderList || foldersRef.current).find((f) => f.name === folderName);
    const schema = schemasRef.current[folderName];
    if (!folder || !schema || !schema.nodeName) return;
    const layeredContents = folder.xmlFiles.map((xf) => ({
      layer: xf.layer || 'base',
      content: allFileContentsRef.current[xf.relativePath] || '',
    }));
    const centralIdKey = getCentralIdentifierKey(sharedSchemaRef.current);
    const next = { ...fkIndexRef.current };
    updateTableIndex(next, folderName, layeredContents, schema.nodeName, schemasRef.current, centralIdKey);
    fkIndexRef.current = next;
  }, []);

  // Same thing, addressed by a file rather than a table. No-ops for `.metadata`.
  const foldXmlFileIntoFKIndex = useCallback((relPath) => {
    if (relPath.endsWith('.metadata')) return;
    foldTableIntoFKIndex(folderNameOf(relPath));
  }, [foldTableIntoFKIndex]);

  // Re-parse a `.metadata` file that changed on disk into this window's schema
  // state. Routes to the same three destinations the main window's applyMetadata
  // does — shared schema, mod schema extension, or a table's primary schema —
  // and applies the same "keep the prior schema" guards, because an external
  // tool caught mid-write can hand us a file that parses to nothing. Adopting
  // that would flag every attribute in the table as unknown.
  //
  // No retry chain here (unlike App.jsx): the main window owns that recovery and
  // its eventual reload broadcast reaches us as another change event. Returns
  // whether the schema was adopted.
  const applyMetadataFromDisk = useCallback((relPath, text) => {
    if (relPath === sharedMetadataRelPathRef.current) {
      const newShared = parseSharedMetadata(text);
      if (!newShared) return false;
      const prior = sharedSchemaRef.current;
      if (newShared.attributes.length === 0 && prior?.attributes?.length > 0) return false;
      sharedSchemaRef.current = newShared;
      setSchemaVersion((v) => v + 1);
      return true;
    }

    // Extension branch first — an extension file shares its folderName with the
    // base table it extends, so falling through would clobber the real schema.
    const extInfo = extensionsMetaRef.current.get(relPath);
    if (extInfo) {
      const parsedExt = parseMetadata(text, extInfo.folderName);
      if (!parsedExt) return false;
      // Extensions are allowed to be empty (a freshly created partial-schema
      // shell is a bare <root></root>), so no empty-attrs guard here.
      setSchemaExtensions((prev) => ({
        ...prev,
        [extInfo.modLayer]: { ...(prev[extInfo.modLayer] || {}), [extInfo.folderName]: parsedExt },
      }));
      return true;
    }

    const folderName = folderNameOf(relPath);
    const newSchema = parseMetadata(text, folderName);
    if (!newSchema) return false;
    const priorFolder = schemasRef.current[folderName];
    const priorAttrCount = (priorFolder?.attributes?.length || 0)
      + (priorFolder?.subNodes?.reduce((n, sn) => n + (sn.attributes?.length || 0), 0) || 0);
    const newAttrCount = newSchema.attributes.length
      + newSchema.subNodes.reduce((n, sn) => n + (sn.attributes?.length || 0), 0);
    if (newAttrCount === 0 && priorAttrCount > 0) return false;
    schemasRef.current = { ...schemasRef.current, [folderName]: newSchema };
    // Sub-node id collections (node_sub_source) come from the schema, so the FK
    // index slice for this table has to be rebuilt too.
    foldTableIntoFKIndex(folderName);
    setSchemaVersion((v) => v + 1);
    return true;
  }, [foldTableIntoFKIndex]);

  // ── Save ──
  const saveFile = useCallback(async (relativePath) => {
    // Island embedded-XML files: main re-encodes the edited XML into the YAML.
    // Skip the FK-index fold (islands aren't in the index). Mirrors App.jsx.
    if (islandRelPathsRef.current.has(relativePath)) {
      const islandContent = fileContents[relativePath];
      if (islandContent === undefined) return;
      try {
        await window.arcenApi.writeFile(relativePath, islandContent);
      } catch (e) {
        try { globalThis.alert?.(`Could not save ${relativePath}: ${e?.message || e}`); } catch (_) {}
        return;
      }
      setSavedContents(prev => ({ ...prev, [relativePath]: islandContent }));
      allFileContentsRef.current[relativePath] = islandContent;
      recentSavesRef.current.add(relativePath);
      setTimeout(() => recentSavesRef.current.delete(relativePath), 5000);
      return;
    }
    const content = fileContents[relativePath];
    if (content === undefined) return;
    await window.arcenApi.writeFile(relativePath, content);
    setSavedContents(prev => ({ ...prev, [relativePath]: content }));
    allFileContentsRef.current[relativePath] = content;
    foldXmlFileIntoFKIndex(relativePath);
    recentSavesRef.current.add(relativePath);
    setTimeout(() => recentSavesRef.current.delete(relativePath), 5000);
  }, [fileContents, foldXmlFileIntoFKIndex]);

  // Write through to the bulk cache as well as tab state, exactly as the main
  // window's updateContent does. Every other path here already keeps the cache
  // current (open, save, reload, revert, schema-stub insert); plain typing was
  // the one hole, and the cache is what FK navigation searches for `id="…"`. So
  // Ctrl+click on an FK pointing into a file being edited in THIS window read
  // the last-saved copy: line numbers shifted by the unsaved edits, or — when
  // the target id was itself unsaved — no exact match at all, dropping into the
  // fuzzy most-similar-id fallback and landing somewhere unrelated. The FK index
  // fold and cross-YAML pickers read the same cache, so they were equally stale.
  // See [[detached-window-parity]].
  const updateContent = useCallback((relativePath, newContent) => {
    setFileContents(prev => ({ ...prev, [relativePath]: newContent }));
    allFileContentsRef.current[relativePath] = newContent;
  }, []);

  // Mirror this window's unsaved buffers into the other windows' bulk content
  // caches. The main window's copy of that cache is what GLOBAL SEARCH reads,
  // and it only ever advanced on save — so a global find kept reporting the
  // last-saved text (old line numbers, edits missing, deleted matches still
  // listed) for anything being edited here. Main-window tabs never had the
  // problem because their updateContent writes the same cache in-process.
  //
  // Covers every tab in this window, not just the active one, and dedupes
  // against the last value pushed for each path. Debounced so a burst of typing
  // costs one message; a tab whose content still matches disk is recorded as a
  // baseline WITHOUT sending anything (the other windows already read that from
  // disk), while a later revert back to the saved text still differs from the
  // dirty value we last pushed and so gets sent.
  const pushedBuffersRef = useRef(new Map());
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const t of tabsRef.current) {
        const p = t.relativePath;
        const cur = fileContents[p];
        if (typeof cur !== 'string') continue;
        const pushed = pushedBuffersRef.current;
        if (pushed.get(p) === cur) continue;
        if (!pushed.has(p) && cur === savedContents[p]) { pushed.set(p, cur); continue; }
        pushed.set(p, cur);
        window.arcenApi.pushLiveBuffer?.(p, cur);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [fileContents, savedContents]);

  const captureSelectionNow = useCallback(() => {
    const view = editorViewRef.current;
    const tab = tabs[activeTabIndex];
    if (view && tab) {
      const sel = view.state.selection.main;
      selectionStateRef.current[tab.relativePath] = { anchor: sel.anchor, head: sel.head };
    }
  }, [tabs, activeTabIndex]);

  const navigateBack = useCallback(() => {
    const nav = navHistoryRef.current;
    if (nav.pos <= 0) return;
    captureSelectionNow();
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
    // No live forward target remained (entries were spliced out) — resync so the
    // forward button doesn't stay stale-enabled.
    setNavState({ canBack: nav.pos > 0, canForward: nav.pos < nav.list.length - 1 });
  }, [tabs, captureSelectionNow]);

  // Mirrors App.jsx's applyBufferUpdatesLocally — bulk cache always, editor
  // buffer only for tabs this window holds, and a `before` interlock so a
  // transform computed against text we no longer have can't silently overwrite
  // live edits. See §11.4c.
  const applyBufferUpdatesLocally = useCallback((updates) => {
    const editorUpdates = {};
    const skipped = [];
    const saved = [];
    for (const [relPath, u] of Object.entries(updates || {})) {
      if (!u || typeof u.after !== 'string') continue;
      const hasTab = tabsRef.current.some((t) => t.relativePath === relPath);
      const mine = hasTab ? fileContentsLatest.current[relPath] : allFileContentsRef.current[relPath];
      if (typeof u.before === 'string' && typeof mine === 'string' && mine !== u.before) {
        skipped.push(relPath);
        continue;
      }
      allFileContentsRef.current[relPath] = u.after;
      if (hasTab) editorUpdates[relPath] = u.after;
      // See App.jsx: `save` means the sender left the disk write to whoever owns
      // the tab. Suppress the echo so our own watcher doesn't treat it as an
      // external change and raise a conflict bar against us.
      if (u.save) {
        recentSavesRef.current.add(relPath);
        setTimeout(() => recentSavesRef.current.delete(relPath), 5000);
        window.arcenApi.writeFile(relPath, u.after);
        saved.push(relPath);
      }
    }
    if (Object.keys(editorUpdates).length > 0) {
      setFileContents((prev) => ({ ...prev, ...editorUpdates }));
    }
    if (saved.length > 0) {
      setSavedContents((prev) => {
        const next = { ...prev };
        for (const p of saved) next[p] = updates[p].after;
        return next;
      });
    }
    return skipped;
  }, []);
  applyBufferUpdatesLocallyRef.current = applyBufferUpdatesLocally;

  const handleIdRename = useCallback((oldId, newId, sourceRelPath) => {
    const curSharedSchema = sharedSchemaRef.current;
    if (!curSharedSchema) return;
    const idKey = getCentralIdentifierKey(curSharedSchema);
    const curSchemas = schemasRef.current;
    const curFolderNames = folderNameByRelPathRef.current;
    const tableName = curFolderNames.get(sourceRelPath);
    if (!tableName) return;

    const curFKIndex = fkIndexRef.current;
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
      updates[relPath] = { before: content, after: updated };
    }

    if (Object.keys(updates).length === 0) return;
    applyBufferUpdatesLocally(updates);
    // Relay to the windows that own the other affected tabs — see App.jsx.
    window.arcenApi.pushBufferUpdates?.(updates);
  }, [applyBufferUpdatesLocally]);

  // Same contract as App.jsx's saveAllLocal — dirty tabs in THIS window only.
  const saveAllLocal = useCallback(() => {
    for (const t of tabsRef.current) {
      const p = t.relativePath;
      if (fileContentsLatest.current[p] === savedContentsLatest.current[p]) continue;
      saveFile(p);
    }
  }, [saveFile]);
  const saveAllLocalRef = useRef(null);
  saveAllLocalRef.current = saveAllLocal;
  useEffect(() => {
    window.arcenApi.onSaveAllRequested?.(() => saveAllLocalRef.current?.());
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      // Kept deliberately in lockstep with App.jsx's handler — including the
      // altKey guard, which this window used to omit (Ctrl+Alt+S saved here but
      // not there).
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S') && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) {
          saveAllLocalRef.current?.();
          window.arcenApi.requestSaveAll?.();
        } else {
          const tab = tabs[activeTabIndex];
          if (tab) saveFile(tab.relativePath);
        }
      }
      if (e.key === 'Escape' && diffTabIndex !== null) {
        e.preventDefault();
        setDiffTabIndex(null);
        return;
      }
      // Ctrl+Shift+F/H — open global search in main window
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f' || e.key === 'H' || e.key === 'h')) {
        e.preventDefault();
        // Try main editor selection first, then browser selection (covers ref panel)
        let sel = '';
        const view = editorViewRef.current;
        if (view) {
          const s = view.state.selection.main;
          if (s.from !== s.to) sel = view.state.sliceDoc(s.from, s.to);
        }
        if (!sel) sel = window.getSelection()?.toString()?.trim() || '';
        if (sel && sel.includes('\n')) sel = '';
        const isReplace = e.key === 'H' || e.key === 'h';
        window.arcenApi.openGlobalSearch(sel, isReplace, tabs[activeTabIndex]?.relativePath || null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabIndex, saveFile, diffTabIndex]);

  // ── Back/forward navigation history tracking ──
  useEffect(() => {
    const tab = tabs[activeTabIndex];
    if (tab && !navSkipRef.current) {
      const nav = navHistoryRef.current;
      if (nav.pos < nav.list.length - 1) {
        nav.list = nav.list.slice(0, nav.pos + 1);
      }
      if (nav.list[nav.list.length - 1] !== tab.relativePath) {
        nav.list.push(tab.relativePath);
        if (nav.list.length > 50) nav.list.shift();
      }
      nav.pos = nav.list.length - 1;
    }
    navSkipRef.current = false;
    const nav = navHistoryRef.current;
    setNavState({ canBack: nav.pos > 0, canForward: nav.pos < nav.list.length - 1 });
  }, [activeTabIndex, tabs]);

  // ── Mouse button 4/5 for back/forward ──
  useEffect(() => {
    const handler = (e) => {
      if (e.button === 3) { e.preventDefault(); navigateBack(); }
      if (e.button === 4) { e.preventDefault(); navigateForward(); }
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [navigateBack, navigateForward]);

  // ── On tab select, tell main window to scroll sidebar + update registry ──
  useEffect(() => {
    const tab = tabs[activeTabIndex];
    if (tab) {
      window.arcenApi.focusSidebarOnFile(tab.relativePath);
      // Feed the cross-window "center on active" target (main window's
      // filter-cleared behavior reads this).
      window.arcenApi.reportActiveFile?.(tab.relativePath);
      // Record in MRU history (newest last, no duplicates) so a torn-out
      // active tab can fall back to the previously focused one.
      const h = activationHistoryRef.current.filter(p => p !== tab.relativePath);
      h.push(tab.relativePath);
      activationHistoryRef.current = h;
    }
    if (activeTabIndex >= 0) {
      window.arcenApi.setDetachedActiveTab(activeTabIndex);
    }
  }, [activeTabIndex, tabs]);

  // Report this window's active file whenever it regains focus, so the
  // "center on active" target reflects the window the user last worked in
  // even if they didn't switch tabs while here.
  useEffect(() => {
    const onFocus = () => {
      const tab = tabsRef.current[activeTabIndexRef.current];
      if (tab) window.arcenApi.reportActiveFile?.(tab.relativePath);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // No beforeunload needed — EditorPane's scroll tracking keeps the central
  // registry current, and main process saves everything on close.

  const activeTab = tabs[activeTabIndex] ?? null;
  const activeSchema = (() => {
    if (!activeTab) return null;
    const folderName = folderNameOf(activeTab.relativePath);
    return schemasRef.current[folderName] ?? null;
  })();

  // Base merged schema composed with any mod schema extensions that apply to
  // the active file's layer — same derivation the main window feeds EditorPane.
  // For base/DLC files composeSchemaForFileLayer is a no-op and returns the
  // plain merged schema; only mod-layer files actually gain the extension
  // attributes/sub-nodes. EditorPane falls back to building the plain merged
  // schema itself when this is null (metadata tabs, pre-load).
  const composedMergedSchema = useMemo(() => {
    if (!activeTab || activeTab.type === 'schema') return null;
    // Island data file: its standalone schema IS the merged schema (no shared
    // merge, no layer compose). Checked first so islands render without shared.
    const islandSchema = islandSchemaByRelPath.get(activeTab.relativePath);
    if (islandSchema) return islandSchema;
    const shared = sharedSchemaRef.current;
    if (!shared || !activeSchema) return null;
    const merged = buildMergedSchema(shared, activeSchema);
    if (!merged) return null;
    const folderName = activeSchema.folderName || folderNameOf(activeTab.relativePath);
    const layer = layerByRelPath.get(activeTab.relativePath)?.layer || 'base';
    return composeSchemaForFileLayer(merged, schemaExtensions, layerMapsRef.current.modExtrasByLayer, layer, folderName);
    // schemaVersion is a deliberate dependency: activeSchema and sharedSchemaRef
    // are read out of refs, so a schema re-parsed from disk needs the version
    // bump to invalidate this memo.
  }, [activeTab, activeSchema, schemaExtensions, layerByRelPath, islandSchemaByRelPath, schemaVersion]);

  // ── Live validation for the active tab (full parity with the main window) ──
  // A detached window is a real editor, so the file the user is editing here
  // must validate live just like in the main window — core + regular FK for
  // normal data files, core + cross-YAML FK + local refs for island files.
  // Results are sent (with the file declared explicitly) to the main process,
  // which merges them OVER its own now-stale entries for this file and relays
  // to the validation window. We cover ONLY the active file; the main window's
  // worker still covers every other file (including this window's other tabs)
  // plus spelling/grammar. A non-validatable active tab (none / schema / no
  // content / no schema) sends file=null to clear this window's contribution so
  // it never suppresses the main window's results for that file.
  useEffect(() => {
    const activeFile = activeTab?.relativePath;
    const content = activeFile ? fileContents[activeFile] : undefined;
    const schema = composedMergedSchema;
    if (!activeFile || activeTab.type === 'schema' || content === undefined || !schema) {
      window.arcenApi.sendDetachedValidation?.(null, []);
      return;
    }
    const islandSchema = islandSchemaByRelPath.get(activeFile);
    const timer = setTimeout(() => {
      let errs = [];
      try {
        if (islandSchema) {
          // Island: standalone schema, empty FK index, cross-YAML FK values.
          const yamlSources = islandYamlSources[activeFile] || null;
          errs = validateXMLFile(content, activeFile, islandSchema, {}, lookupSwapsRef.current, { layer: 'base', folderName: '', yamlSources });
        } else if (!schema.neverValidate) {
          // Normal data file: project FK index + this file's mod layer context.
          const layer = layerByRelPath.get(activeFile)?.layer || 'base';
          const lm = layerMapsRef.current;
          errs = validateXMLFile(content, activeFile, schema, fkIndexRef.current, lookupSwapsRef.current, {
            layer,
            folderName: folderNameOf(activeFile),
            expansionDirNameToLayer: lm.expansionDirNameToLayer,
            modFolderNameToLayer: lm.modFolderNameToLayer,
            modDisplayByLayer: lm.modDisplayByLayer,
            fileModExtras: lm.modExtrasByLayer[layer] || null,
          });
        }
      } catch (_) { /* non-fatal — never let validation crash the editor */ }
      window.arcenApi.sendDetachedValidation?.(activeFile, errs);
    }, 300);
    return () => clearTimeout(timer);
  }, [fileContents, activeTab, composedMergedSchema, islandSchemaByRelPath, islandYamlSources, revalidateNonce]);

  // Ctrl+click navigation — same shared implementation the main window uses, so
  // detached windows are no longer dead-ended on these (they previously wired
  // these props to empty no-ops, so Ctrl+click on an FK value or attribute name
  // did nothing). The detached window doesn't track mod schema extensions, so
  // metadata navigation passes an empty list — base/DLC files are unaffected;
  // only mod-extension targeting degrades to the folder's primary schema.
  const handleNavigateToFK = useCallback((tableName, id) => {
    navigateToFKRow(tableName, id, {
      folders: foldersRef.current,
      getContent: (p) => allFileContentsRef.current[p],
      jumpTo: jumpToFile,
    });
  }, [jumpToFile]);

  const handleNavigateToMetadata = useCallback((attrName, parentTag) => {
    if (!activeTab) return;
    navigateToMetadataDef(attrName, parentTag, {
      activeRelPath: activeTab.relativePath,
      folderNameOf,
      folders: foldersRef.current,
      sharedMetadataRelPath: sharedMetadataRelPathRef.current,
      layerByRelPath,
      modSchemaExtensions: [],
      schemas: schemasRef.current,
      getContent: (p) => allFileContentsRef.current[p],
      setContent: (p, c) => {
        setFileContents((prev) => ({ ...prev, [p]: c }));
        allFileContentsRef.current[p] = c;
      },
      jumpTo: jumpToFile,
      scrollTo: ({ file, line, highlight }) => setPendingScrollLine({ _t: Date.now(), file, line, highlight }),
    });
  }, [activeTab, layerByRelPath, jumpToFile]);

  const handleAddUnknownSubNodeToSchema = useCallback((tagName) => {
    if (!activeTab) return;
    addUnknownSubNodeStub(tagName, {
      activeRelPath: activeTab.relativePath,
      folderNameOf,
      folders: foldersRef.current,
      layerByRelPath,
      modSchemaExtensions: [],
      getContent: (p) => allFileContentsRef.current[p],
      setContent: (p, c) => {
        setFileContents((prev) => ({ ...prev, [p]: c }));
        allFileContentsRef.current[p] = c;
      },
      jumpTo: jumpToFile,
      scrollTo: ({ file, line, highlight }) => setPendingScrollLine({ _t: Date.now(), file, line, highlight }),
    });
  }, [activeTab, layerByRelPath, jumpToFile]);

  const toggleTheme = () => {
    setTheme(t => {
      const next = t === 'light' ? 'dark' : 'light';
      window.arcenApi.sendTheme(next);
      return next;
    });
  };

  // Tab context menu — kept in sync with the main window's menu in App.jsx.
  // Favorites and sidebar centering both still apply here: they target the
  // main window's sidebar via IPC. Favorites are loaded lazily on right-click
  // (via getFavorites) so the list always reflects the latest groups even if
  // they were edited from another window in the meantime.
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const handleTabContextMenu = useCallback(async (index, x, y) => {
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
          setFileContents(prev => ({ ...prev, [tab.relativePath]: saved }));
          allFileContentsRef.current[tab.relativePath] = saved;
        }
      }});
    }

    // Favorites — main window owns the state, we just submit the new array.
    let favorites = [];
    if (isXml) {
      try {
        favorites = await window.arcenApi.getFavorites();
        if (!Array.isArray(favorites)) favorites = [];
      } catch (_) {}
      for (const g of favorites) {
        const isIn = g.files.includes(tab.relativePath);
        items.push({
          label: `${isIn ? '✓ ' : '  '}Fav: ${g.name}`,
          action: () => {
            const next = isIn
              ? favorites.map(fg => fg.name === g.name ? { ...fg, files: fg.files.filter(f => f !== tab.relativePath) } : fg)
              : favorites.map(fg => ({
                  ...fg,
                  files: fg.name === g.name
                    ? [...fg.files.filter(f => f !== tab.relativePath), tab.relativePath]
                    : fg.files.filter(f => f !== tab.relativePath),
                }));
            window.arcenApi.updateFavorites?.(next);
          },
        });
      }
    }

    // Sidebar centering — drives the main window's sidebar via the
    // focus-sidebar-on-file IPC. The main window picks the right tab (MODS vs
    // Explorer) from the file's layer, so xml and schema share one action.
    items.push({ label: 'Center sidebar on this', action: () => {
      window.arcenApi.focusSidebarOnFile?.(tab.relativePath, { highlight: true });
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
      setTabs(prev => {
        const kept = prev.filter(t => t.relativePath === tab.relativePath);
        setActiveTabIndex(0);
        return kept;
      });
      syncTabs();
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
        syncTabs();
      }});
    }

    // VCS commands, mirroring App.jsx — appended async after the menu opens.
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
  }, [tabs, fileContents, savedContents, closeTab]);

  // Handle files dropped from sidebar of main window
  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    const filePath = e.dataTransfer.getData('text/arcen-file');
    const fileType = e.dataTransfer.getData('text/arcen-type') || 'xml';
    if (filePath) {
      // Tell main process to move this tab to us
      const info = await window.arcenApi.getWindowInfo();
      // Open directly in this window
      openFile(filePath, fileType);
    }
  }, [openFile]);

  return (
    <div className="app-root"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={handleDrop}
    >
      <TitleBar
        navState={navState}
        onBack={navigateBack}
        onForward={navigateForward}
        mode="detached"
        windowId={windowId}
        activeFileName={activeTab ? fileDisplayName(activeTab.relativePath.split('/').pop()) : null}
      />
      <GoToLineDialog />
      <GrammarSettings />
      <RenameIdDialog onConfirm={handleIdRename} />
      <div className="app-container">
        <div className="main-area">
          <TabBar
            tabs={tabs}
            activeIndex={activeTabIndex}
            layerByRelPath={layerByRelPath}
            onSelect={(i) => {
              if (i === activeTabIndex) {
                const tab = tabs[i];
                if (tab && fileContents[tab.relativePath] !== savedContents[tab.relativePath]) {
                  setDiffTabIndex(i);
                }
              } else {
                setActiveTabIndex(i);
              }
            }}
            onClose={closeTab}
            modifiedFiles={modifiedFiles}
            onDetachTab={handleDetachTab}
            onContextMenu={(i, x, y) => handleTabContextMenu(i, x, y)}
            onReorder={(from, to) => {
              setTabs(prev => {
                const next = [...prev];
                const [moved] = next.splice(from, 1);
                next.splice(to > from ? to - 1 : to, 0, moved);
                return next;
              });
              if (activeTabIndex === from) setActiveTabIndex(to > from ? to - 1 : to);
              syncTabs();
            }}
          />
          {activeTab && diskConflicts.includes(activeTab.relativePath) && (
            <div style={{
              padding: '6px 12px', background: '#f59e0b', color: '#000',
              display: 'flex', alignItems: 'center', gap: 12, fontSize: 13,
            }}>
              <span style={{ flex: 1 }}>File changed on disk. Reload?</span>
              <button
                style={{ padding: '2px 10px', border: '1px solid #000', borderRadius: 3, background: '#fff', cursor: 'pointer', fontSize: 12 }}
                onClick={async () => {
                  const relPath = activeTab.relativePath;
                  const content = await window.arcenApi.readFile(relPath);
                  setFileContents(prev => ({ ...prev, [relPath]: content }));
                  setSavedContents(prev => ({ ...prev, [relPath]: content }));
                  setDiskConflicts(prev => prev.filter(c => c !== relPath));
                }}
              >Reload</button>
              <button
                style={{ padding: '2px 10px', border: '1px solid #000', borderRadius: 3, background: 'transparent', cursor: 'pointer', fontSize: 12 }}
                onClick={() => setDiskConflicts(prev => prev.filter(c => c !== activeTab.relativePath))}
              >Dismiss</button>
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
                sharedSchema={sharedSchemaRef.current}
                composedMergedSchema={composedMergedSchema}
                yamlSources={islandYamlSources[activeTab.relativePath] || null}
                isSchema={activeTab.type === 'schema'}
                onChange={updateContent}
                theme={theme}
                fkIndex={fkIndexRef.current}
                onNavigateToFK={handleNavigateToFK}
                onNavigateToMetadata={handleNavigateToMetadata}
                onAddUnknownSubNodeToSchema={handleAddUnknownSubNodeToSchema}
                onCursorFocusFile={(rp) => window.arcenApi.focusSidebarOnFile?.(rp)}
                scrollToLine={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.line : null}
                scrollHighlight={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.highlight : null}
                scrollToken={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine._t : null}
                scrollAbsPos={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.absPos : null}
                onScrolled={() => setPendingScrollLine(null)}
                editorViewRef={editorViewRef}
                localSearchStateRef={localSearchStateRef}
                selectionStateRef={selectionStateRef}
                editorScale={editorScale}
                onEditorScaleChange={(s) => { setEditorScale(s); window.arcenApi.sendEditorScale(s); }}
                refPanelScale={refPanelScale}
                onRefPanelScaleChange={(s) => { setRefPanelScale(s); window.arcenApi.sendRefPanelScale(s); }}
                spellchecker={spellchecker}
                fileLayer={layerByRelPath.get(activeTab.relativePath)?.layer || 'base'}
                fileExtraLayers={(() => {
                  const l = layerByRelPath.get(activeTab.relativePath)?.layer;
                  return l ? (layerMapsRef.current.modExtrasByLayer[l] || null) : null;
                })()}
              />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)' }}>
                <div style={{ textAlign: 'center', fontSize: 16 }}>Detached Window — Drag tabs here</div>
              </div>
            )}
          </div>
          <StatusBar
            theme={theme}
            onToggleTheme={toggleTheme}
            validationErrors={validationErrors}
            activeFile={activeTab?.relativePath}
            onRevalidate={() => {}}
            onChangeDataRoot={() => {}}
          />
        </div>
      </div>

      {diffTabIndex !== null && tabs[diffTabIndex] && (
        <DiffView
          oldText={savedContents[tabs[diffTabIndex].relativePath] || ''}
          newText={fileContents[tabs[diffTabIndex].relativePath] || ''}
          onClose={() => setDiffTabIndex(null)}
          onRevert={() => {
            const relPath = tabs[diffTabIndex].relativePath;
            const saved = savedContents[relPath];
            if (saved !== undefined) {
              setFileContents(prev => ({ ...prev, [relPath]: saved }));
            }
          }}
        />
      )}

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
              <div
                key={i}
                style={{ padding: '6px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--accent)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                onClick={() => { item.action(); setTabContextMenu(null); }}
              >{item.label}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
