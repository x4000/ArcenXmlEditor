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
import GoToLineDialog from './GoToLineDialog';
import GrammarSettings from './GrammarSettings';
const vcsStore = require('../editor/vcsStore');
import { parseMetadata, parseSharedMetadata, buildMergedSchema, getCentralIdentifierKey } from '../editor/schemaParser';
import { buildFKIndex, buildLookupSwaps } from '../editor/fkIndex';
import { buildLayerMaps } from '../editor/validation';
import { validateXMLFile } from '../editor/validation';
import NSpell from 'nspell';

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

  const allFileContentsRef = useRef({});
  const schemasRef = useRef({});
  const sharedSchemaRef = useRef(null);
  const fkIndexRef = useRef({});
  const lookupSwapsRef = useRef({});
  const foldersRef = useRef([]);
  // relativePath → logical folder name. Suite-mode paths carry a layer prefix
  // so the folder can't be derived by splitting on '/'.
  const folderNameByRelPathRef = useRef(new Map());
  function folderNameOf(relPath) {
    return folderNameByRelPathRef.current.get(relPath) || relPath.split('/')[0];
  }
  // relativePath → { layer, layerNum } for non-base files (tab tags).
  const [layerByRelPath, setLayerByRelPath] = useState(new Map());
  // Layer info maps — needed by the FK picker's mod-deps widening. The full
  // map gets stashed in a ref because EditorPane reads through getters.
  const layerMapsRef = useRef({ expansionDirNameToLayer: {}, modFolderNameToLayer: {}, modDisplayByLayer: {}, modExtrasByLayer: {} });
  const editorViewRef = useRef(null);
  const selectionStateRef = useRef({});
  const localSearchStateRef = useRef(null);
  const recentSavesRef = useRef(new Set());
  const sessionLoadedRef = useRef(false);
  const [spellchecker, setSpellchecker] = useState(null);
  const spellcheckerRef = useRef(null);

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
      for (const relPath of tabPaths) {
        const content = await window.arcenApi.readFile(relPath);
        restoredTabs.push({
          relativePath: relPath,
          type: relPath.endsWith('.metadata') ? 'schema' : 'xml',
        });
        restoredContents[relPath] = content;
        restoredSaved[relPath] = content;
      }
      setTabs(restoredTabs);
      setFileContents(restoredContents);
      setSavedContents(restoredSaved);
      setActiveTabIndex(detachedSession?.activeTab ?? 0);
      sessionLoadedRef.current = true;

      // Initialize spellchecker
      try {
        const dictData = await window.arcenApi.loadSpellingDictionary();
        if (dictData.aff && dictData.dic) {
          // NSpell imported at top level
          const checker = new NSpell(dictData.aff, dictData.dic);
          if (dictData.custom?.length) {
            for (const word of dictData.custom) checker.add(word);
          }
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
    window.arcenApi.onDictionaryChanged(async () => {
      try {
        const dictData = await window.arcenApi.loadSpellingDictionary();
        if (dictData.aff && dictData.dic) {
          // NSpell imported at top level
          const checker = new NSpell(dictData.aff, dictData.dic);
          if (dictData.custom?.length) {
            for (const word of dictData.custom) checker.add(word);
          }
          spellcheckerRef.current = checker;
          setSpellchecker(checker);
          // Poke the active editor so its ViewPlugin rebuilds decorations with
          // the new dictionary — otherwise squiggles stay stale until typing.
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
    });
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
  useEffect(() => {
    const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
    window.arcenApi.onTabAdded(async (raw) => {
      const relativePath = norm(raw);
      const content = await window.arcenApi.readFile(relativePath);
      const type = relativePath.endsWith('.metadata') ? 'schema' : 'xml';
      setTabs(prev => {
        if (prev.some(t => t.relativePath === relativePath)) return prev;
        return [...prev, { relativePath, type }];
      });
      setFileContents(prev => ({ ...prev, [relativePath]: content }));
      setSavedContents(prev => ({ ...prev, [relativePath]: content }));
      setActiveTabIndex(prev => tabs.length); // will be the new last tab
      syncTabs();
    });

    window.arcenApi.onTabRemoved((raw) => {
      const relativePath = norm(raw);
      setTabs(prev => {
        const filtered = prev.filter(t => t.relativePath !== relativePath);
        return filtered;
      });
      setActiveTabIndex(prev => Math.min(prev, tabs.length - 2));
      syncTabs();
    });

    window.arcenApi.onFocusTab((raw) => {
      const relativePath = norm(raw);
      setTabs(prev => {
        const idx = prev.findIndex(t => t.relativePath === relativePath);
        if (idx >= 0) setActiveTabIndex(idx);
        return prev;
      });
    });

    window.arcenApi.onNavigateToLine((rawFile, line) => {
      const file = norm(rawFile);
      const idx = tabs.findIndex(t => t.relativePath === file);
      if (idx >= 0) {
        setActiveTabIndex(idx);
        setPendingScrollLine({ file, line });
      }
    });
  }, [tabs]);

  // ── File watcher ──
  // Registered once; uses latest-state refs instead of re-running the effect
  // on every state change (which would accumulate IPC listeners indefinitely).
  const fileContentsLatest = useRef(fileContents);
  const savedContentsLatest = useRef(savedContents);
  useEffect(() => { fileContentsLatest.current = fileContents; }, [fileContents]);
  useEffect(() => { savedContentsLatest.current = savedContents; }, [savedContents]);

  useEffect(() => {
    // Normalize any backslash separators on incoming paths so content
    // state never accumulates two entries for the same file — see the
    // long comment on the matching effect in App.jsx.
    const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p);
    window.arcenApi.onFileChangedOnDisk((rawRelPath) => {
      const relPath = norm(rawRelPath);
      if (recentSavesRef.current.has(relPath)) return;
      window.arcenApi.readFile(relPath).then((content) => {
        const cur = fileContentsLatest.current[relPath];
        const sav = savedContentsLatest.current[relPath];
        if (cur !== undefined && cur !== sav) {
          if (content === cur) {
            setSavedContents(prev => ({ ...prev, [relPath]: content }));
            return;
          }
          setDiskConflicts(prev => prev.includes(relPath) ? prev : [...prev, relPath]);
          return;
        }
        allFileContentsRef.current[relPath] = content;
        if (fileContentsLatest.current[relPath] !== undefined) {
          setFileContents(prev => ({ ...prev, [relPath]: content }));
          setSavedContents(prev => ({ ...prev, [relPath]: content }));
        }
      });
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

  // ── Close tab ──
  const closeTab = useCallback((index) => {
    const tab = tabs[index];
    if (!tab) return;
    if (fileContents[tab.relativePath] !== savedContents[tab.relativePath]) {
      if (!confirm(`${tab.relativePath} has unsaved changes. Close anyway?`)) return;
    }
    setTabs(prev => prev.filter((_, i) => i !== index));
    if (activeTabIndex >= index && activeTabIndex > 0) setActiveTabIndex(prev => prev - 1);
    syncTabs();
  }, [tabs, activeTabIndex, fileContents, savedContents]);

  // ── Save ──
  const saveFile = useCallback(async (relativePath) => {
    const content = fileContents[relativePath];
    if (content === undefined) return;
    await window.arcenApi.writeFile(relativePath, content);
    setSavedContents(prev => ({ ...prev, [relativePath]: content }));
    allFileContentsRef.current[relativePath] = content;
    recentSavesRef.current.add(relativePath);
    setTimeout(() => recentSavesRef.current.delete(relativePath), 5000);
  }, [fileContents]);

  const updateContent = useCallback((relativePath, newContent) => {
    setFileContents(prev => ({ ...prev, [relativePath]: newContent }));
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const tab = tabs[activeTabIndex];
        if (tab) {
          if (e.shiftKey) tabs.forEach(t => saveFile(t.relativePath));
          else saveFile(tab.relativePath);
        }
      }
      if (e.key === 'Escape' && diffTabIndex !== null) {
        setDiffTabIndex(null);
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
        window.arcenApi.openGlobalSearch(sel, isReplace);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabIndex, saveFile, diffTabIndex]);

  // ── On tab select, tell main window to scroll sidebar + update registry ──
  useEffect(() => {
    const tab = tabs[activeTabIndex];
    if (tab) {
      window.arcenApi.focusSidebarOnFile(tab.relativePath);
    }
    if (activeTabIndex >= 0) {
      window.arcenApi.setDetachedActiveTab(activeTabIndex);
    }
  }, [activeTabIndex, tabs]);

  // No beforeunload needed — EditorPane's scroll tracking keeps the central
  // registry current, and main process saves everything on close.

  const activeTab = tabs[activeTabIndex] ?? null;
  const activeSchema = (() => {
    if (!activeTab) return null;
    const folderName = folderNameOf(activeTab.relativePath);
    return schemasRef.current[folderName] ?? null;
  })();

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

    // Sidebar centering — drives the main window's sidebar via the existing
    // focus-sidebar-on-file IPC, now extended with a mode parameter.
    if (isXml) {
      items.push({ label: 'Center explorer sidebar on this', action: () => {
        window.arcenApi.focusSidebarOnFile?.(tab.relativePath, 'files');
      }});
    } else {
      items.push({ label: 'Center schema sidebar on this', action: () => {
        window.arcenApi.focusSidebarOnFile?.(tab.relativePath, 'schema');
      }});
    }

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
      <TitleBar mode="detached" windowId={windowId} />
      <GoToLineDialog />
      <GrammarSettings />
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
                isSchema={activeTab.type === 'schema'}
                onChange={updateContent}
                theme={theme}
                fkIndex={fkIndexRef.current}
                onNavigateToFK={() => {}}
                onNavigateToMetadata={() => {}}
                scrollToLine={pendingScrollLine?.file === activeTab.relativePath ? pendingScrollLine.line : null}
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
