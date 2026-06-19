import React, { useState, useEffect, useRef, useMemo } from 'react';
import VirtualList from './VirtualList';
import StatusPip from './StatusPip';
import { clampToViewport } from '../editor/menuUtils';
import { stripDataExt, fileDisplayName } from '../editor/layerDisplay';
const vcsStore = require('../editor/vcsStore');

// Catches render-time exceptions in the sidebar's tab content (FileTree /
// ModsList / FavoritesList) and shows the error + component stack
// IN PLACE, instead of letting it unmount the whole React tree to a white
// screen (which is what a HotM mods-tab render throw would otherwise do — and
// renderer throws never reach the terminal, only DevTools). Keyed on the active
// tab so switching tabs resets it.
class SidebarErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[Sidebar crash]', error, info && info.componentStack);
  }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div style={{ padding: 10, fontSize: 11, color: 'var(--text)', overflow: 'auto', height: '100%' }}>
          <div style={{ fontWeight: 700, color: '#c5384c', marginBottom: 6 }}>
            Sidebar render error{this.props.label ? ` (${this.props.label} tab)` : ''} — caught
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', userSelect: 'text', margin: 0 }}>
            {String((e && (e.stack || e.message)) || e)}
          </pre>
          {this.state.info && this.state.info.componentStack && (
            <pre style={{ whiteSpace: 'pre-wrap', userSelect: 'text', margin: '8px 0 0', color: 'var(--text-dim)' }}>
              {this.state.info.componentStack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

// Find which mod (and which folder under it) "owns" a given relativePath for
// MODS-tab navigation. A path can land in one of three positions inside the
// MODS tree:
//   1. A mod-level file (ModDetails.xml etc.) — mod row, no folder.
//   2. A mod-contributed xmlFile in a folder — mod + folder.
//   3. The folder's .metadata when the mod owns the schema — mod + folder.
// Returns { modLayer, folderName? } or null.
function findModOwnerOfPath(mods, folders, targetPath, modSchemaExtensions = []) {
  for (const mod of mods) {
    if (mod.modLevelFiles && mod.modLevelFiles.some((f) => f.relativePath === targetPath)) {
      return { modLayer: mod.layerId };
    }
  }
  for (const folder of folders) {
    // Mod-owned schema file.
    if (folder.metadataRelPath === targetPath
        && folder.schemaLayer && folder.schemaLayer.startsWith('mod_')) {
      return { modLayer: folder.schemaLayer, folderName: folder.name };
    }
    // Mod-contributed xmlFile inside a folder.
    const xf = folder.xmlFiles.find((x) => x.relativePath === targetPath && x.layer && x.layer.startsWith('mod_'));
    if (xf) return { modLayer: xf.layer, folderName: folder.name };
  }
  // Mod schema EXTENSION file (additive overlay, lives in the mod's own dir).
  for (const ext of modSchemaExtensions) {
    if (ext.metadataRelPath === targetPath) {
      return { modLayer: ext.modLayer, folderName: ext.folderName };
    }
  }
  return null;
}

export default function Sidebar({
  folders,
  theme,
  width,
  activeTab,
  onTabChange,
  expandedFolders,
  onToggleFolder,
  onOpenFile,
  activeFile,
  activeFiles = [],
  modifiedFiles,
  schemas,
  hasSharedMetadata,
  favorites,
  onFavoritesChange,
  scrollToFile,
  onScrollToFileDone,
  onShowInFolder,
  onRenameFile,
  onCreateFolder,
  onCreateXmlFile,
  sharedMetadataRelPath = 'SharedMetaData.metadata',
  expansions = [],
  mods = [],
  islands = [],
  modSchemaExtensions = [],
  onRequestCenterActive,
}) {
  const [searchByTab, setSearchByTab] = useState({ files: '', favorites: '', schema: '' });
  const [searchFilesByTab, setSearchFilesByTab] = useState({ files: true, mods: true });
  const [searchFoldersByTab, setSearchFoldersByTab] = useState({ files: true, mods: true });
  const [searchModsByTab, setSearchModsByTab] = useState({ mods: true });
  const searchFiles = searchFilesByTab[activeTab] ?? true;
  const searchFolders = searchFoldersByTab[activeTab] ?? true;
  const searchMods = searchModsByTab[activeTab] ?? true;
  const setSearchFiles = (val) => setSearchFilesByTab(prev => ({ ...prev, [activeTab]: typeof val === 'function' ? val(prev[activeTab] ?? true) : val }));
  const setSearchFolders = (val) => setSearchFoldersByTab(prev => ({ ...prev, [activeTab]: typeof val === 'function' ? val(prev[activeTab] ?? true) : val }));
  const setSearchMods = (val) => setSearchModsByTab(prev => ({ ...prev, [activeTab]: typeof val === 'function' ? val(prev[activeTab] ?? true) : val }));
  const [contextMenu, setContextMenu] = useState(null);
  // Native window.prompt() is disabled in Electron's renderer (silently
  // returns null), so every Rename / New Folder / New XML File entry
  // would early-return before doing anything. This drives an in-app
  // modal instead. Shape: { title, defaultValue, validate?, onSubmit }
  const [promptDialog, setPromptDialog] = useState(null);
  const openPrompt = (cfg) => setPromptDialog(cfg);
  const contentRef = useRef(null);
  const search = searchByTab[activeTab] || '';
  const setSearch = (val) => setSearchByTab((prev) => ({ ...prev, [activeTab]: typeof val === 'function' ? val(prev[activeTab] || '') : val }));
  const lowerSearch = search.toLowerCase();

  // Every open window (main + each detached) has one tab "facing the user";
  // all of them get the .active highlight in the sidebar. activeFile is this
  // window's own active tab; activeFiles is the union across all windows.
  const activeFileSet = useMemo(
    () => new Set([...(activeFiles || []), activeFile].filter(Boolean)),
    [activeFiles, activeFile]
  );

  // When the Explorer filter goes from non-empty back to empty — whether by
  // backspacing it out or hitting the ✕ clear button — re-center the sidebar on
  // the active tab. Gated to the Explorer tab and to the SAME tab staying
  // selected, so merely switching sidebar tabs (each keeps its own query)
  // doesn't trigger a center.
  const prevSearchRef = useRef(search);
  const prevTabRef = useRef(activeTab);
  useEffect(() => {
    const prev = prevSearchRef.current;
    const prevTab = prevTabRef.current;
    prevSearchRef.current = search;
    prevTabRef.current = activeTab;
    if (activeTab === 'files' && prevTab === activeTab && prev && !search) {
      onRequestCenterActive?.();
    }
  }, [search, activeTab]);

  // Drag a file row past the window edges to spawn / move it into a detached
  // window. Returns an onDragEnd handler so every draggable row across ALL
  // sidebar tabs gets the identical gesture — the MODS tab used to omit this,
  // so files there couldn't be dragged out. Matches the explorer/schema/
  // favorites rows' inline version.
  const detachOnDragEnd = (relPath, type) => (e) => {
    const winX = window.screenX || 0, winY = window.screenY || 0;
    const winW = window.outerWidth, winH = window.outerHeight;
    if (e.screenX < winX || e.screenX > winX + winW || e.screenY < winY || e.screenY > winY + winH) {
      if (window.arcenApi?.detachTabAtPosition) {
        onOpenFile(relPath, type);
        setTimeout(() => {
          window.arcenApi.detachTabAtPosition(relPath, e.screenX, e.screenY);
        }, 200);
      }
    }
  };

  // Scroll the active file into view. Strategy depends on which tab is
  // active: the explorer tab uses a virtualized list, so we compute the
  // target row index and set scrollTop directly (the row DOM may not exist
  // yet). Favorites renders every row in the DOM, so a direct scrollIntoView
  // works there — and is what the tab-right-click "Center sidebar on this"
  // action relies on.
  const scrollFileIntoView = (targetPath, highlight = false) => {
    if (!targetPath || !contentRef.current) return;

    // Non-virtualized tabs: just find the DOM element and scroll it.
    if (activeTab !== 'files') {
      // MODS tab: the row we're trying to scroll to may not be rendered yet
      // because its enclosing mod and/or table folder is collapsed. Expand
      // whatever's needed first, then scroll on the next frame.
      let needsExpandWait = false;
      if (activeTab === 'mods') {
        const owner = findModOwnerOfPath(mods, folders, targetPath, modSchemaExtensions);
        if (owner) {
          const keys = [`mods:${owner.modLayer}`];
          if (owner.folderName) keys.push(`mods:${owner.modLayer}/${owner.folderName}`);
          for (const k of keys) {
            if (!expandedFolders.has(k)) {
              onToggleFolder(k);
              needsExpandWait = true;
            }
          }
        }
      }
      const doScroll = () => {
        const el = contentRef.current?.querySelector(`[data-filepath="${targetPath.replace(/"/g, '\\"')}"]`);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'center', behavior: 'auto' });
          if (highlight) {
            el.style.outline = '2px solid var(--accent)';
            el.style.background = 'var(--accent-bg)';
            setTimeout(() => { if (el) { el.style.outline = ''; el.style.background = ''; } }, 3000);
          }
        }
      };
      if (needsExpandWait) setTimeout(doScroll, 50); else doScroll();
      return;
    }

    // Explorer tab (virtualized): find the virtualized scroll container
    // and set scrollTop to the computed row index.
    const scrollEl = contentRef.current.querySelector('[style*="overflow"]') ||
                     contentRef.current.querySelector('.sidebar-content');
    if (!scrollEl) return;

    // Compute the target row index from the SAME row list FileTree renders,
    // so schema rows and the trailing SharedMetaData row are counted too.
    const rows = buildExplorerRows(folders, {
      search: lowerSearch, searchFiles, searchFolders, expandedFolders,
      modifiedFiles, hasSharedMetadata, sharedMetadataRelPath,
    });
    const rowPath = (row) =>
      row.kind === 'file' ? row.file.relativePath
      : row.kind === 'schema' ? row.folder.metadataRelPath
      : row.kind === 'shared' ? row.relativePath
      : null;
    const index = rows.findIndex((row) => rowPath(row) === targetPath);
    if (index < 0) return;
    const ROW_H = 24;
    const targetY = index * ROW_H;
    const viewH = scrollEl.clientHeight;
    scrollEl.scrollTop = Math.max(0, targetY - viewH / 2 + ROW_H / 2);
    if (highlight) {
      // Try to find the DOM element (it should be rendered after scroll)
      setTimeout(() => {
        const el = contentRef.current?.querySelector(`[data-filepath="${targetPath.replace(/"/g, '\\"')}"]`);
        if (el) {
          el.style.outline = '2px solid var(--accent)';
          el.style.background = 'var(--accent-bg)';
          setTimeout(() => { if (el) { el.style.outline = ''; el.style.background = ''; } }, 3000);
        }
      }, 100);
    }
  };

  useEffect(() => {
    if (!activeFile) return;
    const timer = setTimeout(() => scrollFileIntoView(activeFile, false), 50);
    return () => clearTimeout(timer);
  }, [activeFile, activeTab]);

  useEffect(() => {
    if (!scrollToFile) return;
    // scrollToFile is either a plain relativePath (deliberate "center" → flash
    // the row) or { path, highlight:false } for passive focuses (editor click,
    // tab-switch sync) that should scroll without the attention-grabbing flash.
    const path = typeof scrollToFile === 'string' ? scrollToFile : scrollToFile.path;
    const highlight = typeof scrollToFile === 'string' ? true : scrollToFile.highlight !== false;
    const timer = setTimeout(() => {
      scrollFileIntoView(path, highlight);
      if (onScrollToFileDone) onScrollToFileDone();
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToFile]);

  // Dismiss context menu on click anywhere
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener('click', dismiss);
    return () => window.removeEventListener('click', dismiss);
  }, [contextMenu]);

  return (
    <div className="sidebar" style={{ width: width || 260 }}>
      <div className="sidebar-tabs">
        <div
          className={`sidebar-tab ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => onTabChange('files')}
        >
          Explorer
        </div>
        <div
          className={`sidebar-tab ${activeTab === 'favorites' ? 'active' : ''}`}
          onClick={() => onTabChange('favorites')}
        >
          Favorites
        </div>
        {mods.length > 0 && (
          <div
            className={`sidebar-tab ${activeTab === 'mods' ? 'active' : ''}`}
            onClick={() => onTabChange('mods')}
            title={`${mods.length} active mod${mods.length === 1 ? '' : 's'}`}
          >
            Mods
          </div>
        )}
        {islands.length > 0 && (
          <div
            className={`sidebar-tab ${activeTab === 'islands' ? 'active' : ''}`}
            onClick={() => onTabChange('islands')}
            title={`${islands.length} island data source${islands.length === 1 ? '' : 's'}`}
          >
            Islands
          </div>
        )}
      </div>

      <div className="sidebar-search">
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          <input
            type="text"
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 0, paddingRight: search ? 22 : undefined }}
          />
          {search && (
            <span
              onClick={() => setSearch('')}
              title="Clear search"
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                width: 16, height: 16, borderRadius: '50%', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, lineHeight: 1, color: 'var(--text-dim)',
                background: 'var(--selection)', userSelect: 'none',
              }}
            >
              ✕
            </span>
          )}
        </div>
        {(activeTab === 'files' || activeTab === 'mods') && (
          <>
            <SidebarFilterBtn active={searchFiles} onClick={() => setSearchFiles(v => !v)} title="Match file names">≡</SidebarFilterBtn>
            <SidebarFilterBtn active={searchFolders} onClick={() => setSearchFolders(v => !v)} title="Match folder names">
              <img src={theme === 'dark' ? '../../icons/folder-yellow.png' : '../../icons/folder-purple.png'} alt="" style={{ width: 13, height: 11, display: 'block', opacity: searchFolders ? 1 : 0.4 }} />
            </SidebarFilterBtn>
            {activeTab === 'mods' && (
              <SidebarFilterBtn active={searchMods} onClick={() => setSearchMods(v => !v)} title="Match mod names">⚙</SidebarFilterBtn>
            )}
          </>
        )}
      </div>

      <div className="sidebar-content" ref={contentRef}>
        <SidebarErrorBoundary key={activeTab} label={activeTab}>
        {activeTab === 'files' && (
          <FileTree
            folders={folders}
            theme={theme}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onOpenFile={onOpenFile}
            activeFiles={activeFileSet}
            modifiedFiles={modifiedFiles}
            search={lowerSearch}
            searchFiles={searchFiles}
            searchFolders={searchFolders}
            onContextMenu={setContextMenu}
            onPrompt={openPrompt}
            onShowInFolder={onShowInFolder}
            onRenameFile={onRenameFile}
            onCreateFolder={onCreateFolder}
            onCreateXmlFile={onCreateXmlFile}
            expansions={expansions}
            favorites={favorites || []}
            onFavoritesChange={onFavoritesChange}
            hasSharedMetadata={hasSharedMetadata}
            sharedMetadataRelPath={sharedMetadataRelPath}
          />
        )}
        {activeTab === 'favorites' && (
          <FavoritesList
            favorites={favorites || []}
            onFavoritesChange={onFavoritesChange}
            onOpenFile={onOpenFile}
            activeFiles={activeFileSet}
            modifiedFiles={modifiedFiles}
            search={lowerSearch}
            folders={folders}
            mods={mods}
            onContextMenu={setContextMenu}
            onPrompt={openPrompt}
            onShowInFolder={onShowInFolder}
            onRenameFile={onRenameFile}
          />
        )}
        {activeTab === 'mods' && (
          <ModsList
            mods={mods}
            folders={folders}
            onOpenFile={onOpenFile}
            activeFiles={activeFileSet}
            modifiedFiles={modifiedFiles}
            search={lowerSearch}
            searchFiles={searchFiles}
            searchFolders={searchFolders}
            searchMods={searchMods}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onContextMenu={setContextMenu}
            onPrompt={openPrompt}
            onShowInFolder={onShowInFolder}
            onRenameFile={onRenameFile}
            onCreateXmlFile={onCreateXmlFile}
            onCreateFolder={onCreateFolder}
            detachOnDragEnd={detachOnDragEnd}
            modSchemaExtensions={modSchemaExtensions}
          />
        )}
        {activeTab === 'islands' && (
          <IslandsList
            islands={islands}
            onOpenFile={onOpenFile}
            activeFiles={activeFileSet}
            modifiedFiles={modifiedFiles}
            search={lowerSearch}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onContextMenu={setContextMenu}
            onShowInFolder={onShowInFolder}
            detachOnDragEnd={detachOnDragEnd}
          />
        )}
        </SidebarErrorBoundary>
      </div>

      {/* Sidebar context menu */}
      {contextMenu && (
        <SidebarContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* In-app text-prompt modal (replaces window.prompt) */}
      {promptDialog && (
        <TextPromptDialog
          {...promptDialog}
          onClose={() => setPromptDialog(null)}
        />
      )}
    </div>
  );
}

// Strip .xml / .metadata extensions for display. The source-of-truth
// relativePath still carries the extension. (Layer-tagged display names use
// fileDisplayName from layerDisplay.js.)
const displayName = stripDataExt;

// Fetch the active provider's command-menu entries for a path. Labels and
// IDs come from whichever provider is active (SVN, Git, …); the renderer
// stays provider-agnostic. Returns a Promise<Array<{label, action}>>.
// Resolves to [] when no provider is connected or status backend is down,
// or when the active provider returns no commands. Disabled items are
// dropped — the menu renderer treats every item as actionable.
async function buildScItemsAsync(absPath, scope) {
  if (!absPath || !window.arcenApi?.scRunCommand || !window.arcenApi?.scGetCommands) return [];
  const cmds = await window.arcenApi.scGetCommands(scope, absPath);
  return (cmds || [])
    .filter(c => c.enabled !== false)
    .map(c => ({
      label: c.label,
      action: () => window.arcenApi.scRunCommand(c.id, absPath),
    }));
}

// Same thing, but given a relative path (resolves abs via IPC first).
// Used in Favorites + Schema tabs where the renderer doesn't already hold
// the absolute path on its file objects.
async function buildScItemsRelAsync(relPath, scope) {
  if (!relPath || !window.arcenApi?.scRunCommand || !window.arcenApi?.scAbsPath || !window.arcenApi?.scGetCommands) return [];
  const abs = await window.arcenApi.scAbsPath(relPath);
  if (!abs) return [];
  return buildScItemsAsync(abs, scope);
}

// Subscribes to vcsStore for the `statusBackendLive` flag + per-path status maps.
function useVcsStatus() {
  const [v, setV] = useState({ statusBackendLive: false, dataByRel: new Map(), folderRollupByRel: new Map() });
  useEffect(() => vcsStore.subscribe((s) => setV({
    statusBackendLive: s.statusBackendLive,
    dataByRel: s.dataByRel,
    folderRollupByRel: s.folderRollupByRel,
  })), []);
  return v;
}

// Build the Explorer (files tab) row list: the global SharedMetaData schema
// pinned at the very TOP, then each folder header followed by that folder's
// schema (.metadata) as its FIRST child and then the folder's data files.
// Shared by FileTree (which renders these rows) and Sidebar.scrollFileIntoView
// (which needs the row index to scroll) so the two can never drift apart.
//
// `search` is the already-lowercased query. Mod-owned tables and mod-layer
// files are excluded here — they live exclusively in the MODS sidebar.
function buildExplorerRows(folders, {
  search, searchFiles = true, searchFolders = true, expandedFolders,
  modifiedFiles, hasSharedMetadata, sharedMetadataRelPath,
}) {
  const rows = [];
  // Global shared schema, pinned above every folder.
  if (hasSharedMetadata) {
    const rel = sharedMetadataRelPath || 'SharedMetaData.metadata';
    const sharedMatch = !search || 'sharedmetadata'.includes(search) || rel.toLowerCase().includes(search);
    if (sharedMatch) rows.push({ kind: 'shared', relativePath: rel });
  }
  for (const folder of folders) {
    if (folder.schemaLayer && folder.schemaLayer.startsWith('mod_')) continue;
    const nonModFiles = folder.xmlFiles.filter((f) => !f.layer || !f.layer.startsWith('mod_'));
    const hasSchema = !!folder.metadataFile;
    // Skip a folder with no non-mod files and no schema — nothing to show.
    if (nonModFiles.length === 0 && !hasSchema) continue;
    const folderNameMatch = !!search && searchFolders && folder.name.toLowerCase().includes(search);
    const schemaNameMatch = !!search && searchFiles && hasSchema && folder.metadataFile.toLowerCase().includes(search);
    const filteredFiles = search
      ? (folderNameMatch
          ? nonModFiles
          : searchFiles
            ? nonModFiles.filter((f) => f.name.toLowerCase().includes(search))
            : [])
      : nonModFiles;
    // The schema row shows when not searching, or the folder name matches, or
    // the schema file name itself matches.
    const showSchema = hasSchema && (!search || folderNameMatch || schemaNameMatch);
    // When searching, drop a folder that contributes nothing.
    if (search && !folderNameMatch && filteredFiles.length === 0 && !showSchema) continue;
    const isExpanded = search ? true : expandedFolders.has(folder.name);
    const hasModified = nonModFiles.some((f) => modifiedFiles.has(f.relativePath))
      || (hasSchema && modifiedFiles.has(folder.metadataRelPath));
    rows.push({ kind: 'folder', folder, isExpanded, hasModified });
    if (isExpanded) {
      if (showSchema) rows.push({ kind: 'schema', folder });
      for (const file of filteredFiles) rows.push({ kind: 'file', file, folder });
    }
  }
  return rows;
}

function FileTree({ folders, theme, expandedFolders, onToggleFolder, onOpenFile, activeFiles, modifiedFiles, search, searchFiles = true, searchFolders = true, onContextMenu, onPrompt, onShowInFolder, onRenameFile, onCreateFolder, onCreateXmlFile, expansions = [], favorites, onFavoritesChange, hasSharedMetadata, sharedMetadataRelPath }) {
  const vcs = useVcsStatus();
  const folderIcon = theme === 'dark' ? '../../icons/folder-yellow.png' : '../../icons/folder-purple.png';

  // Flatten folders, their schema + data files into a row list for virtualization.
  const rows = useMemo(() => buildExplorerRows(folders, {
    search, searchFiles, searchFolders, expandedFolders,
    modifiedFiles, hasSharedMetadata, sharedMetadataRelPath,
  }), [folders, expandedFolders, modifiedFiles, search, searchFiles, searchFolders, hasSharedMetadata, sharedMetadataRelPath]);

  const ROW_H = 24;

  return (
    <VirtualList
      rows={rows}
      rowHeight={ROW_H}
      overscan={200}
      style={{ flex: 1, height: '100%' }}
      getRowKey={(r) =>
        r.kind === 'folder' ? `F:${r.folder.name}`
        : r.kind === 'schema' ? `S:${r.folder.name}`
        : r.kind === 'shared' ? 'SHARED'
        : `f:${r.file.relativePath}`}
      renderRow={(row) => {
        if (row.kind === 'folder') {
          const folder = row.folder;
          return (
            <div
              className="file-tree-folder-header"
              style={{ height: ROW_H, boxSizing: 'border-box' }}
              onClick={() => onToggleFolder(folder.name)}
              onContextMenu={async (e) => {
                e.preventDefault();
                const x = e.clientX, y = e.clientY;
                const baseItems = [
                  { label: 'Show in Explorer', action: () => onShowInFolder(folder.path) },
                  { label: 'Copy full path', action: () => {
                    navigator.clipboard.writeText(folder.path).catch(() => {});
                  }},
                  { label: 'Rename Folder', action: () => {
                    onPrompt({
                      title: 'Rename folder',
                      label: folder.name,
                      defaultValue: folder.name,
                      onSubmit: (newName) => {
                        if (newName && newName !== folder.name) onRenameFile(folder.name, newName);
                      },
                    });
                  }},
                  { label: 'New Folder', action: () => {
                    onPrompt({
                      title: 'New folder',
                      label: 'Folder name',
                      defaultValue: '',
                      onSubmit: (name) => { if (name) onCreateFolder(name); },
                    });
                  }},
                  { label: 'New XML File\u2026', action: () => {
                    // In suite mode with active expansions, let the user pick
                    // which layer the file lands in (base or a specific DLC).
                    // The target subfolder need not exist in that layer yet.
                    const layerOpts = expansions.length > 0
                      ? [
                          { id: 'base', label: 'Base Game' },
                          ...expansions.map((e) => ({ id: e.id, label: `DLC${e.num} (${e.dirName})` })),
                        ]
                      : null;
                    onPrompt({
                      title: `New XML file in ${folder.name}`,
                      label: 'File name',
                      defaultValue: '',
                      layers: layerOpts,
                      onSubmit: (name, layerId) => {
                        if (name && onCreateXmlFile) onCreateXmlFile(folder.name, name, layerId || 'base');
                      },
                    });
                  }},
                ];
                // Show base items immediately, then append VCS items when
                // they arrive (one IPC round-trip). Avoids a perceptible
                // open-delay on the menu while still giving the active
                // provider its own labels.
                onContextMenu({ x, y, items: baseItems });
                if (vcs.statusBackendLive) {
                  const scItems = await buildScItemsAsync(folder.path, 'data');
                  if (scItems.length) {
                    onContextMenu({ x, y, items: [...baseItems, { divider: true }, ...scItems] });
                  }
                }
              }}
            >
              <span style={{ fontSize: 10, width: 12 }}>{row.isExpanded ? '▼' : '▶'}</span>
              {vcs.statusBackendLive && (
                <StatusPip
                  // A logical table folder can span base + multiple expansion
                  // directories, so it has no single path key — roll up from
                  // its actual member files (xml across all layers + schema).
                  status={vcsStore.getRollupForPaths([
                    ...folder.xmlFiles.map((x) => x.relativePath),
                    folder.metadataRelPath,
                  ])}
                  reserveSpace
                  style={{ marginLeft: -4, marginRight: -2 }}
                />
              )}
              <img src={folderIcon} style={{ width: 14, height: 14, marginRight: 0, opacity: 0.85 }} />
              <span style={{ flex: 1, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{folder.name}</span>
              {row.hasModified && <span className="modified-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />}
            </div>
          );
        }
        // Schema (.metadata) row — the folder's schema, shown as its first
        // child in a lighter italic font with a trailing [SCHEMA] tag.
        if (row.kind === 'schema' || row.kind === 'shared') {
          const isShared = row.kind === 'shared';
          const relPath = isShared ? row.relativePath : row.folder.metadataRelPath;
          const absPath = isShared ? null : row.folder.metadataPath;
          const labelText = isShared ? 'SharedMetaData' : displayName(row.folder.metadataFile);
          const isActive = activeFiles.has(relPath);
          return (
            <div
              className={`file-tree-file ${isActive ? 'active' : ''}`}
              data-filepath={relPath}
              style={{
                height: ROW_H, boxSizing: 'border-box',
                // The global schema is a root-level entry pinned at the very
                // top, so it sits at the folder indent with a divider below.
                ...(isShared ? { paddingLeft: 12, borderBottom: '1px solid var(--border)' } : null),
              }}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/arcen-file', relPath);
                e.dataTransfer.setData('text/arcen-type', 'schema');
              }}
              onDragEnd={(e) => {
                const winX = window.screenX || 0, winY = window.screenY || 0;
                const winW = window.outerWidth, winH = window.outerHeight;
                if (e.screenX < winX || e.screenX > winX + winW || e.screenY < winY || e.screenY > winY + winH) {
                  if (window.arcenApi?.detachTabAtPosition) {
                    onOpenFile(relPath, 'schema');
                    setTimeout(() => {
                      window.arcenApi.detachTabAtPosition(relPath, e.screenX, e.screenY);
                    }, 200);
                  }
                }
              }}
              onClick={() => onOpenFile(relPath, 'schema')}
              onContextMenu={(e) => {
                e.preventDefault();
                const x = e.clientX, y = e.clientY;
                const items = [
                  { label: 'Open', action: () => onOpenFile(relPath, 'schema') },
                  { label: 'Show in Explorer', action: () => {
                    if (absPath) { onShowInFolder(absPath); return; }
                    if (window.arcenApi?.scAbsPath && window.arcenApi?.showInFolder) {
                      window.arcenApi.scAbsPath(relPath).then((abs) => abs && window.arcenApi.showInFolder(abs));
                    }
                  }},
                  { label: 'Copy full path', action: () => {
                    if (absPath) { navigator.clipboard.writeText(absPath).catch(() => {}); return; }
                    if (window.arcenApi?.scAbsPath) {
                      window.arcenApi.scAbsPath(relPath).then((abs) => { if (abs) navigator.clipboard.writeText(abs).catch(() => {}); });
                    }
                  }},
                ];
                onContextMenu({ x, y, items });
              }}
            >
              {vcs.statusBackendLive && (
                <StatusPip status={vcs.dataByRel.get(relPath) || 'clean'} reserveSpace style={{ marginRight: -2 }} />
              )}
              <span style={{
                flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                fontStyle: 'italic', color: isActive ? undefined : 'var(--text-dim)',
              }}>
                {labelText} <span style={{ fontSize: 10, opacity: 0.7 }}>[SCHEMA]</span>
              </span>
              {modifiedFiles.has(relPath) && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
              )}
            </div>
          );
        }
        // file row
        const file = row.file;
        const folder = row.folder;
        return (
          <div
            className={`file-tree-file ${activeFiles.has(file.relativePath) ? 'active' : ''}`}
            data-filepath={file.relativePath}
            style={{ height: ROW_H, boxSizing: 'border-box' }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/arcen-file', file.relativePath);
              e.dataTransfer.setData('text/arcen-type', 'xml');
            }}
            onDragEnd={(e) => {
              const winX = window.screenX || 0, winY = window.screenY || 0;
              const winW = window.outerWidth, winH = window.outerHeight;
              if (e.screenX < winX || e.screenX > winX + winW || e.screenY < winY || e.screenY > winY + winH) {
                if (window.arcenApi?.detachTabAtPosition) {
                  onOpenFile(file.relativePath, 'xml');
                  setTimeout(() => {
                    window.arcenApi.detachTabAtPosition(file.relativePath, e.screenX, e.screenY);
                  }, 200);
                }
              }
            }}
            onClick={() => onOpenFile(file.relativePath, 'xml')}
            onContextMenu={async (e) => {
              e.preventDefault();
              const x = e.clientX, y = e.clientY;
              const baseItems = [
                { label: 'Show in Explorer', action: () => onShowInFolder(file.path) },
                { label: 'Copy full path', action: () => {
                  navigator.clipboard.writeText(file.path).catch(() => {});
                }},
                { label: 'Rename', action: () => {
                  onPrompt({
                    title: 'Rename file',
                    label: file.name,
                    defaultValue: file.name,
                    onSubmit: (newName) => {
                      if (newName && newName !== file.name) {
                        // Keep the file in its own directory/layer — only the
                        // basename changes. The relativePath already encodes
                        // the layer prefix in suite mode.
                        onRenameFile(file.relativePath, file.relativePath.replace(/[^/]+$/, newName));
                      }
                    },
                  });
                }},
                ...(favorites.length === 0
                  ? [{ label: 'Add to new Favorites group', action: () => {
                      onFavoritesChange([{ name: 'Favorites', files: [file.relativePath] }]);
                    }}]
                  : favorites.map(g => ({
                      label: `Add to "${g.name}"`,
                      action: () => {
                        if (!g.files.includes(file.relativePath)) {
                          onFavoritesChange(favorites.map(fg =>
                            fg.name === g.name ? { ...fg, files: [...fg.files, file.relativePath] } : fg
                          ));
                        }
                      },
                    }))
                ),
              ];
              onContextMenu({ x, y, items: baseItems });
              if (vcs.statusBackendLive) {
                const scItems = await buildScItemsAsync(file.path, 'file');
                if (scItems.length) {
                  onContextMenu({ x, y, items: [...baseItems, { divider: true }, ...scItems] });
                }
              }
            }}
          >
            {vcs.statusBackendLive && (
              <StatusPip
                status={vcs.dataByRel.get(file.relativePath) || 'clean'}
                reserveSpace
                style={{ marginRight: -2 }}
              />
            )}
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fileDisplayName(file.name, file.layer, file.layerNum)}</span>
            {modifiedFiles.has(file.relativePath) && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
            )}
          </div>
        );
      }}
    />
  );
}

// Style helper: absolute-positioned pip that floats inside the existing left
// padding area of a row, so adding it does not push filenames further right.
// Call sites must set `position: relative` on the row's outer element.
//
// `left` is tuned per-tab so the pip ends up 2–3 px before the text:
//   favorites rows use the default paddingLeft: 28 → pip at 19
const overlayPipStyle = (left) => ({ position: 'absolute', left, top: '50%', transform: 'translateY(-50%)' });
const OVERLAY_PIP_FAVORITES = overlayPipStyle(19);

// (The standalone Schema sidebar tab was removed — schemas now appear inline in
// the Explorer tab as the first child of each folder, with the global
// SharedMetaData pinned after all folders. See buildExplorerRows + FileTree.)

// MODS sidebar tab. Three levels:
//   mod (top, with color swatch + display name)
//     mod-level files (ModDetails.xml, ModTranslation.xml, ModSortOrder.txt)
//     ───────────────
//     table folder
//       xml files for that folder belonging to this mod
//
// `folders` is the unified folder list — we filter each folder's xmlFiles
// down to those whose layer matches this mod's layerId.
//
// Mods and their inner folders share the parent's `expandedFolders` Set, but
// using a prefixed key (`mods:<layerId>` / `mods:<layerId>/<folderName>`)
// to avoid collisions with regular table-folder names.
function ModsList({ mods, folders, onOpenFile, activeFiles, modifiedFiles, search, searchFiles = true, searchFolders = true, searchMods = true, expandedFolders, onToggleFolder, onContextMenu, onPrompt, onShowInFolder, onRenameFile, onCreateXmlFile, onCreateFolder, detachOnDragEnd, modSchemaExtensions = [] }) {
  const vcs = useVcsStatus();

  // Lookup: (layerId, folderName) → extension record. Lets us surface a mod's
  // schema-extension file as a leaf row (and suppress the "Create partial
  // schema for this mod…" action when one already exists, so it doesn't
  // appear to re-offer something the mod already has).
  const extensionByModFolder = useMemo(() => {
    const m = new Map();
    for (const ext of modSchemaExtensions) {
      m.set(`${ext.modLayer}/${ext.folderName}`, ext);
    }
    return m;
  }, [modSchemaExtensions]);

  // For each mod, the table folders it contributes to (via XML data,
  // schema ownership, or a schema extension), and the xmlFiles within
  // each that belong to this mod. Memoized so toggling expansion doesn't
  // rebuild.
  const modFolderViews = useMemo(() => {
    const out = new Map(); // layerId → [{ folder, modFiles, ownsSchema, extension }]
    for (const mod of mods) {
      const list = [];
      for (const folder of folders) {
        const modFiles = folder.xmlFiles.filter((f) => f.layer === mod.layerId);
        const ownsSchema = folder.schemaLayer === mod.layerId;
        const extension = extensionByModFolder.get(`${mod.layerId}/${folder.name}`) || null;
        if (modFiles.length === 0 && !ownsSchema && !extension) continue;
        list.push({ folder, modFiles, ownsSchema, extension });
      }
      out.set(mod.layerId, list);
    }
    return out;
  }, [mods, folders, extensionByModFolder]);

  const strMatch = (s) => s.toLowerCase().includes(search);

  const fileType = (relPath) => (relPath.endsWith('.metadata') ? 'schema' : 'xml');

  return (
    <div style={{ paddingTop: 4 }}>
      {mods.map((mod) => {
        const modKey = `mods:${mod.layerId}`;
        const isExpanded = search ? true : (expandedFolders.has(modKey) || false);
        const folderViews = modFolderViews.get(mod.layerId) || [];

        // When the mod name itself matches (and searchMods is on), show everything in it.
        const modNameMatches = search && searchMods && (strMatch(mod.displayName) || strMatch(mod.dirName));

        const filteredModLevel = mod.modLevelFiles.filter((f) => {
          if (!search) return true;
          if (modNameMatches) return true;
          return searchFiles && strMatch(f.name);
        });

        const filteredFolders = folderViews
          .map(({ folder, modFiles, ownsSchema, extension }) => {
            // When folder name matches (and searchFolders is on), show all content in it.
            const folderNameMatches = search && !modNameMatches && searchFolders && strMatch(folder.name);
            const showAll = !search || modNameMatches || folderNameMatches;

            let schemaEntry = null;
            if (ownsSchema && folder.metadataFile && (showAll || (searchFiles && strMatch(folder.metadataFile)))) {
              schemaEntry = {
                name: folder.metadataFile,
                path: folder.metadataPath,
                relativePath: folder.metadataRelPath,
                isExtension: false,
              };
            } else if (extension && (showAll || (searchFiles && strMatch(extension.metadataFile)))) {
              schemaEntry = {
                name: extension.metadataFile,
                path: extension.metadataPath,
                relativePath: extension.metadataRelPath,
                isExtension: true,
              };
            }
            return {
              folder,
              ownsSchema,
              hasExtension: !!extension,
              modFiles: showAll ? modFiles : searchFiles ? modFiles.filter((f) => strMatch(f.name)) : [],
              schemaEntry,
            };
          })
          .filter(({ modFiles, schemaEntry }) => modFiles.length > 0 || schemaEntry);

        // Hide a mod entirely when it has no matching content and its own name doesn't match.
        if (search && !modNameMatches && filteredModLevel.length === 0 && filteredFolders.length === 0) return null;

        const sourceTag = mod.source === 'x' ? ''
          : mod.source === 'n' ? ' [non-distributed]'
          : ' [workshop]';

        return (
          <div key={mod.layerId}>
            <div
              className="file-tree-folder-header"
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', cursor: 'pointer', userSelect: 'none' }}
              onClick={() => onToggleFolder(modKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                const items = [
                  { label: 'Show in Explorer', action: () => onShowInFolder(mod.dirPath) },
                  { label: 'Copy mod folder path', action: () => navigator.clipboard.writeText(mod.dirPath).catch(() => {}) },
                  { divider: true },
                  { label: 'New Folder in this mod…', action: () => {
                    onPrompt({
                      title: `New folder in mod "${mod.displayName}"`,
                      label: 'Folder name (must match a base table, or introduce a new mod-owned table)',
                      defaultValue: '',
                      onSubmit: (name) => { if (name && onCreateFolder) onCreateFolder(name, { layerId: mod.layerId }); },
                    });
                  }},
                ];
                onContextMenu({ x: e.clientX, y: e.clientY, items });
              }}
            >
              <span style={{ fontSize: 10, width: 12 }}>{isExpanded ? '▼' : '▶'}</span>
              {mod.color && (
                <span style={{
                  width: 10, height: 10, borderRadius: 2, background: mod.color,
                  border: '1px solid rgba(0,0,0,0.2)', display: 'inline-block',
                }} title={mod.color} />
              )}
              <span style={{ flex: 1, fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {mod.displayName}<span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{sourceTag}</span>
              </span>
            </div>
            {isExpanded && (
              <>
                {filteredModLevel.map((f) => (
                  <div
                    key={f.relativePath}
                    className={`file-tree-file ${activeFiles.has(f.relativePath) ? 'active' : ''}`}
                    data-filepath={f.relativePath}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/arcen-file', f.relativePath);
                      e.dataTransfer.setData('text/arcen-type', fileType(f.relativePath));
                    }}
                    onDragEnd={detachOnDragEnd(f.relativePath, fileType(f.relativePath))}
                    onClick={() => onOpenFile(f.relativePath, fileType(f.relativePath))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onContextMenu({ x: e.clientX, y: e.clientY, items: [
                        { label: 'Open', action: () => onOpenFile(f.relativePath, fileType(f.relativePath)) },
                        { label: 'Show in Explorer', action: () => onShowInFolder(f.path) },
                      ]});
                    }}
                    style={{ paddingLeft: 30, position: 'relative' }}
                  >
                    {vcs.statusBackendLive && (
                      <StatusPip status={vcs.dataByRel.get(f.relativePath) || 'clean'} style={OVERLAY_PIP_FAVORITES} />
                    )}
                    <span style={{ flex: 1, fontSize: 12, fontStyle: 'italic', color: 'var(--text-dim)' }}>{stripDataExt(f.name) || f.name}</span>
                    {modifiedFiles.has(f.relativePath) && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
                    )}
                  </div>
                ))}
                {filteredModLevel.length > 0 && filteredFolders.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--border)', margin: '4px 22px' }} />
                )}
                {filteredFolders.map(({ folder, modFiles, ownsSchema, hasExtension, schemaEntry }) => {
                  const folderKey = `mods:${mod.layerId}/${folder.name}`;
                  const folderExpanded = search ? true : (expandedFolders.has(folderKey) || false);
                  // "This mod already has a schema file for this folder" —
                  // either it OWNS the schema (first registration for this
                  // table) or it ships a schema EXTENSION. In either case,
                  // suppress the "create partial schema" action below — it
                  // would just no-op (the file already exists) or, worse,
                  // make the user think they're creating something new.
                  const modHasOwnSchema = ownsSchema || hasExtension;
                  return (
                    <div key={folderKey}>
                      <div
                        className="file-tree-folder-header"
                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px 2px 22px', cursor: 'pointer' }}
                        onClick={() => onToggleFolder(folderKey)}
                        title={ownsSchema ? 'Mod-owned table — schema defined by this mod' : undefined}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          const items = [
                            { label: 'New XML File…', action: () => {
                              if (!onCreateXmlFile) return;
                              onPrompt({
                                title: `New XML file in ${folder.name} (mod: ${mod.displayName})`,
                                label: 'File name',
                                defaultValue: '',
                                onSubmit: (name) => { if (name) onCreateXmlFile(folder.name, name, mod.layerId); },
                              });
                            }},
                          ];
                          if (!modHasOwnSchema && onCreateFolder) {
                            // The mod doesn't yet have a schema file for this
                            // folder (extension or owned). Offer to start one —
                            // creates an empty _<Folder>.metadata in the mod
                            // so the user can declare mod-specific attributes
                            // / sub-nodes their DLL reads at runtime.
                            items.push({ divider: true });
                            items.push({
                              label: 'Create partial schema file for this mod…',
                              action: () => {
                                onCreateFolder(folder.name, { layerId: mod.layerId, extensionOnly: true });
                              },
                            });
                          }
                          items.push({ divider: true });
                          items.push({ label: 'Show in Explorer', action: () => {
                            const layerPath = folder.layerFolderPaths && folder.layerFolderPaths[mod.layerId];
                            if (layerPath) onShowInFolder(layerPath);
                          }});
                          onContextMenu({ x: e.clientX, y: e.clientY, items });
                        }}
                      >
                        <span style={{ fontSize: 10, width: 12 }}>{folderExpanded ? '▼' : '▶'}</span>
                        <span style={{ flex: 1, fontSize: 12 }}>{folder.name}</span>
                        {ownsSchema && <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>(mod-owned)</span>}
                        {!ownsSchema && hasExtension && <span style={{ fontSize: 10, color: 'var(--text-dim)' }} title="This mod ships a schema extension (additional attributes / sub-nodes) for this table">(ext)</span>}
                      </div>
                      {folderExpanded && schemaEntry && (
                        <div
                          key={schemaEntry.relativePath}
                          className={`file-tree-file ${activeFiles.has(schemaEntry.relativePath) ? 'active' : ''}`}
                          data-filepath={schemaEntry.relativePath}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/arcen-file', schemaEntry.relativePath);
                            e.dataTransfer.setData('text/arcen-type', 'schema');
                          }}
                          onDragEnd={detachOnDragEnd(schemaEntry.relativePath, 'schema')}
                          onClick={() => onOpenFile(schemaEntry.relativePath, 'schema')}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            onContextMenu({ x: e.clientX, y: e.clientY, items: [
                              { label: 'Open', action: () => onOpenFile(schemaEntry.relativePath, 'schema') },
                              { label: 'Show in Explorer', action: () => onShowInFolder(schemaEntry.path) },
                            ]});
                          }}
                          style={{ paddingLeft: 44, position: 'relative' }}
                        >
                          {vcs.statusBackendLive && (
                            <StatusPip status={vcs.dataByRel.get(schemaEntry.relativePath) || 'clean'} style={OVERLAY_PIP_FAVORITES} />
                          )}
                          <span style={{
                            flex: 1, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            // Bold only when this is the active tab — matches every other file row in
                            // the sidebar. Schema files are flagged via the leading [SCHEMA] prefix
                            // instead, so the user can tell a schema from a data file at a glance
                            // without making every schema row visually prominent.
                            fontWeight: activeFiles.has(schemaEntry.relativePath) ? 600 : 'inherit',
                          }}>
                            <span style={{ color: 'var(--text-dim)', marginRight: 4 }} title={schemaEntry.isExtension ? 'Schema extension: additive overlay (no node_name)' : undefined}>[{schemaEntry.isExtension ? 'EXT' : 'SCHEMA'}]</span>{stripDataExt(schemaEntry.name)}
                          </span>
                          {modifiedFiles.has(schemaEntry.relativePath) && (
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
                          )}
                        </div>
                      )}
                      {folderExpanded && modFiles.map((file) => (
                        <div
                          key={file.relativePath}
                          className={`file-tree-file ${activeFiles.has(file.relativePath) ? 'active' : ''}`}
                          data-filepath={file.relativePath}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/arcen-file', file.relativePath);
                            e.dataTransfer.setData('text/arcen-type', 'xml');
                          }}
                          onDragEnd={detachOnDragEnd(file.relativePath, 'xml')}
                          onClick={() => onOpenFile(file.relativePath, 'xml')}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            onContextMenu({ x: e.clientX, y: e.clientY, items: [
                              { label: 'Open', action: () => onOpenFile(file.relativePath, 'xml') },
                              { label: 'Show in Explorer', action: () => onShowInFolder(file.path) },
                              { divider: true },
                              { label: 'Rename', action: () => onPrompt({
                                title: 'Rename file', label: file.name, defaultValue: file.name,
                                onSubmit: (newName) => {
                                  if (newName && newName !== file.name) {
                                    onRenameFile(file.relativePath, file.relativePath.replace(/[^/]+$/, newName));
                                  }
                                },
                              })},
                            ]});
                          }}
                          style={{ paddingLeft: 44, position: 'relative' }}
                        >
                          {vcs.statusBackendLive && (
                            <StatusPip status={vcs.dataByRel.get(file.relativePath) || 'clean'} style={OVERLAY_PIP_FAVORITES} />
                          )}
                          <span style={{ flex: 1, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stripDataExt(file.name)}</span>
                          {modifiedFiles.has(file.relativePath) && (
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
                          )}
                        </div>
                      ))}
                      {folderExpanded && (
                        <div
                          style={{ paddingLeft: 44, padding: '2px 8px 2px 44px', fontSize: 11, color: 'var(--text-dim)', cursor: 'pointer' }}
                          onClick={() => {
                            if (!onCreateXmlFile) return;
                            onPrompt({
                              title: `New XML file in ${folder.name} (mod: ${mod.displayName})`,
                              label: 'File name',
                              defaultValue: '',
                              onSubmit: (name) => { if (name) onCreateXmlFile(folder.name, name, mod.layerId); },
                            });
                          }}
                        >
                          + New XML file…
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredFolders.length === 0 && filteredModLevel.length === 0 && (
                  <div style={{ paddingLeft: 30, padding: '4px 8px 4px 30px', fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                    No matching files
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
      {mods.length === 0 && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
          No active mods.
        </div>
      )}
    </div>
  );
}

// Dedicated tab for self-contained "island" data sources (declared in
// _extraDataSources.txt). Each island lists its standalone schema
// (_<Name>.metadata, openable like any schema) and its embedded-XML data files
// (e.g. Unity .asset; opened as decoded XML — VIEW-ONLY this milestone).
function IslandsList({ islands, onOpenFile, activeFiles, modifiedFiles, search, expandedFolders, onToggleFolder, onContextMenu, onShowInFolder, detachOnDragEnd }) {
  const strMatch = (s) => !!s && s.toLowerCase().includes(search);

  const fileRow = (relPath, name, type, absPath, indent) => (
    <div
      key={relPath}
      className={`file-tree-file ${activeFiles.has(relPath) ? 'active' : ''}`}
      data-filepath={relPath}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/arcen-file', relPath);
        e.dataTransfer.setData('text/arcen-type', type);
      }}
      onDragEnd={detachOnDragEnd(relPath, type)}
      onClick={() => onOpenFile(relPath, type)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu({ x: e.clientX, y: e.clientY, items: [
          { label: 'Open', action: () => onOpenFile(relPath, type) },
          ...(absPath ? [{ label: 'Show in Explorer', action: () => onShowInFolder(absPath) }] : []),
        ] });
      }}
      style={{ paddingLeft: indent, position: 'relative' }}
    >
      <span style={{ flex: 1, fontSize: 12, ...(type === 'schema' ? { fontStyle: 'italic', color: 'var(--text-dim)' } : {}) }}>
        {type === 'schema' ? `[schema] ${name}` : name}
      </span>
      {modifiedFiles.has(relPath) && (
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
      )}
    </div>
  );

  return (
    <div style={{ paddingTop: 4 }}>
      {islands.map((isl) => {
        const islandKey = `islands:${isl.folderRelPath}`;
        const islandNameMatches = search && strMatch(isl.name);
        const files = (isl.files || []).filter((f) => !search || islandNameMatches || strMatch(f.name));
        const schemaShown = !!isl.metadataRelPath && (!search || islandNameMatches || strMatch(isl.metadataFile));
        if (search && !islandNameMatches && files.length === 0 && !schemaShown) return null;
        // Islands are few, so default to EXPANDED; a PRESENT key means collapsed
        // (local inversion of the usual convention — toggling still just flips
        // the key's presence).
        const isExpanded = search ? true : !expandedFolders.has(islandKey);
        return (
          <div key={islandKey}>
            <div
              className="file-tree-folder-header"
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', cursor: 'pointer', userSelect: 'none' }}
              onClick={() => onToggleFolder(islandKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu({ x: e.clientX, y: e.clientY, items: isl.metadataPath
                  ? [{ label: 'Show in Explorer', action: () => onShowInFolder(isl.metadataPath) }]
                  : [] });
              }}
            >
              <span style={{ fontSize: 10, width: 12 }}>{isExpanded ? '▼' : '▶'}</span>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {isl.name}
                {isl.embedExtension && (
                  <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>{` .${isl.embedExtension}`}</span>
                )}
              </span>
            </div>
            {isExpanded && (
              <>
                {schemaShown && fileRow(isl.metadataRelPath, isl.metadataFile, 'schema', isl.metadataPath, 30)}
                {files.map((f) => fileRow(f.relativePath, f.name, 'xml', f.path, 30))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FavoritesList({ favorites, onFavoritesChange, onOpenFile, activeFiles, modifiedFiles, search, folders, mods = [], onContextMenu, onPrompt, onShowInFolder, onRenameFile }) {
  const vcs = useVcsStatus();

  // relativePath → xmlFile (carries layer/layerNum) so favorite rows can show
  // the appropriate layer tag. Mod display names come via FavoritesList's
  // separate `mods` prop (threaded via the Sidebar component below).
  const xmlFileByRelPath = useMemo(() => {
    const m = new Map();
    for (const folder of folders || []) {
      for (const xf of folder.xmlFiles) m.set(xf.relativePath, xf);
    }
    return m;
  }, [folders]);
  const favDisplayName = (filePath) => {
    const xf = xmlFileByRelPath.get(filePath);
    const name = filePath.split('/').pop();
    if (!xf) return displayName(name);
    const modName = xf.layer && xf.layer.startsWith('mod_')
      ? (mods.find((m) => m.layerId === xf.layer)?.displayName || null)
      : null;
    return fileDisplayName(name, xf.layer, xf.layerNum, modName);
  };

  // Build the right-click menu for a file in Favorites. Keeps open/remove,
  // adds "Show in Explorer", rename, a "Remove from <group>" option, and
  // VCS commands from the active provider when live.
  const fileBaseItems = (filePath, groupName) => [
    { label: 'Open', action: () => onOpenFile(filePath, filePath.endsWith('.metadata') ? 'schema' : 'xml') },
    { label: 'Show in Explorer', action: () => {
      // Resolve absolute path via IPC (we only have relative here).
      if (window.arcenApi?.scAbsPath && window.arcenApi?.showInFolder) {
        window.arcenApi.scAbsPath(filePath).then((abs) => abs && window.arcenApi.showInFolder(abs));
      }
    }},
    { label: 'Copy full path', action: () => {
      if (window.arcenApi?.scAbsPath) {
        window.arcenApi.scAbsPath(filePath).then((abs) => {
          if (abs) navigator.clipboard.writeText(abs).catch(() => {});
        });
      }
    }},
    { label: 'Rename', action: () => {
      const currentName = filePath.split('/').pop();
      onPrompt({
        title: 'Rename file',
        label: currentName,
        defaultValue: currentName,
        onSubmit: (newName) => {
          if (newName && newName !== currentName && onRenameFile) {
            const folder = filePath.split('/').slice(0, -1).join('/');
            onRenameFile(filePath, `${folder}/${newName}`);
          }
        },
      });
    }},
    { label: `Remove from "${groupName}"`, action: () => {
      onFavoritesChange(favorites.map(g =>
        g.name === groupName ? { ...g, files: g.files.filter(f => f !== filePath) } : g
      ));
    }},
  ];

  // Open the menu immediately with base items, then append the active
  // provider's VCS items asynchronously when they arrive.
  const openFileContextMenu = async (e, filePath, groupName) => {
    e.preventDefault();
    if (!onContextMenu) return;
    const x = e.clientX, y = e.clientY;
    const baseItems = fileBaseItems(filePath, groupName);
    onContextMenu({ x, y, items: baseItems });
    if (vcs.statusBackendLive) {
      const scItems = await buildScItemsRelAsync(filePath, 'file');
      if (scItems.length) {
        onContextMenu({ x, y, items: [...baseItems, { divider: true }, ...scItems] });
      }
    }
  };
  const [expanded, setExpanded] = useState(new Set(favorites.map(g => g.name)));
  // A group created externally (e.g. a tab-bar "Add to Favorites") should
  // default to open rather than collapsed — the mount-only seed misses it.
  useEffect(() => {
    setExpanded(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const g of favorites) if (!next.has(g.name)) { next.add(g.name); changed = true; }
      return changed ? next : prev;
    });
  }, [favorites]);
  const [newGroupInput, setNewGroupInput] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const newGroupRef = useRef(null);
  const [renameIdx, setRenameIdx] = useState(-1);
  const [renameName, setRenameName] = useState('');
  const renameRef = useRef(null);
  const [dragGroup, setDragGroup] = useState(-1);
  const [dragFile, setDragFile] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);

  // Auto-managed groups: Beta + DLC1..N.
  //
  // Suite mode: the DLC groups are driven by actual expansion-layer
  // membership (xmlFile.layer), not the _DLC<N> filename convention — so a
  // DLC file shows up regardless of its filename, and a base file that
  // happens to be named _DLC1.xml does not. Beta has no layer, so it stays
  // a filename-convention group.
  //
  // Narrow mode (no expansion layers present): unchanged — pure filename
  // suffix matching, which is still useful for non-Arcen titles that ship
  // _DLC<N>.xml files in a flat data folder.
  const autoGroups = useMemo(() => {
    if (!folders) return [];
    const allFiles = folders.flatMap(f => f.xmlFiles);
    const hasLayers = allFiles.some(x => x.layer && x.layer !== 'base');

    if (hasLayers) {
      const groups = [];
      const beta = allFiles
        .filter(x => x.relativePath.endsWith('_Beta.xml'))
        .map(x => x.relativePath);
      if (beta.length) groups.push({ name: 'Beta', files: beta, auto: true });
      // Auto-managed DLC groups only — mods are deliberately excluded since
      // a user with N mods would otherwise get N auto-groups they didn't ask
      // for. Mod files can still be favorited individually into user-curated
      // groups.
      const byLayer = new Map(); // layerNum → relativePath[]
      for (const x of allFiles) {
        if (!x.layer || !/^dlc\d+$/.test(x.layer)) continue;
        if (!byLayer.has(x.layerNum)) byLayer.set(x.layerNum, []);
        byLayer.get(x.layerNum).push(x.relativePath);
      }
      for (const num of [...byLayer.keys()].sort((a, b) => a - b)) {
        groups.push({ name: `DLC${num}`, files: byLayer.get(num), auto: true });
      }
      return groups;
    }

    const allXml = allFiles.map(x => x.relativePath);
    const suffixes = [
      { suffix: '_Beta.xml', name: 'Beta' },
      { suffix: '_DLC1.xml', name: 'DLC1' },
      { suffix: '_DLC2.xml', name: 'DLC2' },
      { suffix: '_DLC3.xml', name: 'DLC3' },
      { suffix: '_DLC4.xml', name: 'DLC4' },
      { suffix: '_DLC5.xml', name: 'DLC5' },
      { suffix: '_DLC6.xml', name: 'DLC6' },
    ];
    return suffixes
      .map(({ suffix, name }) => ({ name, files: allXml.filter(f => f.endsWith(suffix)), auto: true }))
      .filter(g => g.files.length > 0);
  }, [folders]);

  useEffect(() => { if (newGroupInput && newGroupRef.current) newGroupRef.current.focus(); }, [newGroupInput]);
  useEffect(() => { if (renameIdx >= 0 && renameRef.current) { renameRef.current.focus(); renameRef.current.select(); } }, [renameIdx]);

  const createGroup = () => {
    if (newGroupName.trim()) {
      onFavoritesChange([...favorites, { name: newGroupName.trim(), files: [] }]);
      setExpanded(prev => new Set(prev).add(newGroupName.trim()));
    }
    setNewGroupInput(false);
    setNewGroupName('');
  };

  const newGroupUI = (
    <div style={{ padding: '8px 12px' }}>
      {newGroupInput ? (
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            ref={newGroupRef}
            type="text"
            placeholder="Group name"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createGroup(); if (e.key === 'Escape') { setNewGroupInput(false); setNewGroupName(''); } }}
            style={{
              flex: 1, padding: '3px 6px', fontSize: 11,
              border: '1px solid var(--border)', borderRadius: 3,
              background: 'var(--bg)', color: 'var(--text)',
            }}
          />
          <button onClick={createGroup} style={{ padding: '3px 8px', fontSize: 10, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, background: 'var(--accent)', color: '#fff' }}>Add</button>
        </div>
      ) : (
        <button
          style={{ padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 3, background: 'transparent', color: 'var(--text)' }}
          onClick={() => setNewGroupInput(true)}
        >
          New Group
        </button>
      )}
    </div>
  );

  return (
    <div>
      {!favorites.length && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
          No custom favorites yet.
        </div>
      )}
      {favorites.map((group, gi) => {
        const isExp = expanded.has(group.name);
        const filteredFiles = search
          ? group.files.filter(f => f.toLowerCase().includes(search))
          : group.files;

        return (
          <div key={group.name}>
            {renameIdx === gi ? (
              <div style={{ padding: '4px 8px', display: 'flex', gap: 4 }}>
                <input
                  ref={renameRef}
                  type="text"
                  value={renameName}
                  onChange={(e) => setRenameName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (renameName.trim() && renameName.trim() !== group.name) {
                        onFavoritesChange(favorites.map((g, i) => i === gi ? { ...g, name: renameName.trim() } : g));
                      }
                      setRenameIdx(-1);
                    }
                    if (e.key === 'Escape') setRenameIdx(-1);
                  }}
                  onBlur={() => setRenameIdx(-1)}
                  style={{
                    flex: 1, padding: '2px 6px', fontSize: 11,
                    border: '1px solid var(--border)', borderRadius: 3,
                    background: 'var(--bg)', color: 'var(--text)',
                  }}
                />
              </div>
            ) : (
            <div
              style={{
                padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4,
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}
              onClick={() => setExpanded(prev => {
                const next = new Set(prev);
                next.has(group.name) ? next.delete(group.name) : next.add(group.name);
                return next;
              })}
              onContextMenu={(e) => {
                e.preventDefault();
                setRenameIdx(gi);
                setRenameName(group.name);
              }}
            >
              <span style={{ fontSize: 10, width: 12 }}>{isExp ? '▼' : '▶'}</span>
              <span style={{ flex: 1 }}>{group.name}</span>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{group.files.length}</span>
              <span
                style={{ fontSize: 11, cursor: 'pointer', color: 'var(--text-dim)', padding: '0 4px' }}
                onClick={(e) => { e.stopPropagation(); onFavoritesChange(favorites.filter((_, i) => i !== gi)); }}
                title="Delete group"
              >
                ✕
              </span>
            </div>
            )}
            {isExp && filteredFiles.map((filePath, fi) => {
              const fileName = filePath.split('/').pop();
              const isDragOver = dragGroup === gi && dropTarget === filePath && dragFile !== filePath;
              return (
                <div
                  key={filePath}
                  className={`file-tree-file ${activeFiles.has(filePath) ? 'active' : ''}`}
                  data-filepath={filePath}
                  draggable
                  onDragStart={(e) => {
                    setDragGroup(gi); setDragFile(filePath);
                    e.dataTransfer.setData('text/arcen-file', filePath);
                    e.dataTransfer.setData('text/arcen-type', filePath.endsWith('.metadata') ? 'schema' : 'xml');
                  }}
                  onDragOver={(e) => { e.preventDefault(); setDropTarget(filePath); }}
                  onDragLeave={() => { if (dropTarget === filePath) setDropTarget(null); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragGroup === gi && dragFile && dragFile !== filePath) {
                      const files = [...group.files];
                      const fromIdx = files.indexOf(dragFile);
                      const toIdx = files.indexOf(filePath);
                      if (fromIdx >= 0 && toIdx >= 0) {
                        files.splice(fromIdx, 1);
                        files.splice(toIdx, 0, dragFile);
                        onFavoritesChange(favorites.map((g, i) => i === gi ? { ...g, files } : g));
                      }
                    }
                    setDragGroup(-1); setDragFile(null); setDropTarget(null);
                  }}
                  onDragEnd={(e) => {
                    // Check if dropped outside this window — create detached window
                    const winX = window.screenX || 0, winY = window.screenY || 0;
                    const winW = window.outerWidth, winH = window.outerHeight;
                    if (e.screenX < winX || e.screenX > winX + winW || e.screenY < winY || e.screenY > winY + winH) {
                      if (window.arcenApi?.detachTabAtPosition) {
                        const fileType = filePath.endsWith('.metadata') ? 'schema' : 'xml';
                        onOpenFile(filePath, fileType);
                        setTimeout(() => {
                          window.arcenApi.detachTabAtPosition(filePath, e.screenX, e.screenY);
                        }, 200);
                      }
                    }
                    setDragGroup(-1); setDragFile(null); setDropTarget(null);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center',
                    opacity: dragFile === filePath ? 0.5 : 1,
                    borderTop: isDragOver ? '2px solid var(--accent)' : undefined,
                    position: 'relative',
                  }}
                  onClick={() => onOpenFile(filePath, filePath.endsWith('.metadata') ? 'schema' : 'xml')}
                  onContextMenu={(e) => openFileContextMenu(e, filePath, group.name)}
                >
                  {vcs.statusBackendLive && (
                    <StatusPip status={vcs.dataByRel.get(filePath) || 'clean'} style={OVERLAY_PIP_FAVORITES} />
                  )}
                  <span style={{ flex: 1 }}>{favDisplayName(filePath)}</span>
                  {modifiedFiles.has(filePath) && (
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
                  )}
                  <span
                    style={{ fontSize: 10, cursor: 'pointer', color: 'var(--text-dim)', padding: '0 4px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onFavoritesChange(favorites.map((g, i) =>
                        i === gi ? { ...g, files: g.files.filter(f => f !== filePath) } : g
                      ));
                    }}
                    title="Remove from favorites"
                  >
                    ✕
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {newGroupUI}

      {/* Auto-managed groups */}
      {autoGroups.length > 0 && (
        <>
          <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
          <div style={{ padding: '2px 8px', fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>Auto-managed</div>
          {autoGroups.map((group) => {
            const isExp = expanded.has('auto:' + group.name);
            const filteredFiles = search
              ? group.files.filter(f => f.toLowerCase().includes(search))
              : group.files;
            if (search && !filteredFiles.length) return null;

            return (
              <div key={'auto:' + group.name}>
                <div
                  style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                  onClick={() => setExpanded(prev => {
                    const next = new Set(prev);
                    const key = 'auto:' + group.name;
                    next.has(key) ? next.delete(key) : next.add(key);
                    return next;
                  })}
                >
                  <span style={{ fontSize: 10, width: 12 }}>{isExp ? '▼' : '▶'}</span>
                  <span style={{ flex: 1 }}>{group.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{group.files.length}</span>
                </div>
                {isExp && filteredFiles.map((filePath) => (
                  <div
                    key={filePath}
                    className={`file-tree-file ${activeFiles.has(filePath) ? 'active' : ''}`}
                    data-filepath={filePath}
                    style={{ position: 'relative' }}
                    onClick={() => onOpenFile(filePath, 'xml')}
                    onContextMenu={(e) => openFileContextMenu(e, filePath, group.name)}
                  >
                    {vcs.statusBackendLive && (
                      <StatusPip status={vcs.dataByRel.get(filePath) || 'clean'} style={OVERLAY_PIP_FAVORITES} />
                    )}
                    <span style={{ flex: 1 }}>{favDisplayName(filePath)}</span>
                    {modifiedFiles.has(filePath) && (
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gutter-changed)' }} />
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * In-app text input modal. Replaces window.prompt(), which is silently
 * disabled in Electron's renderer (the call returns null without ever
 * showing a dialog) and was the reason the sidebar's New XML File /
 * New Folder / Rename entries appeared to do nothing.
 *
 * Behavior:
 *   - Auto-focuses + selects the default value on open.
 *   - Enter submits, Escape cancels, click outside cancels.
 *   - onSubmit receives the trimmed string; cancellation calls only onClose.
 */
// `layers`, when supplied, is [{ id, label }, ...] and renders a dropdown
// above the text input. The chosen layer id is passed as the 2nd argument to
// onSubmit. Used by the suite-mode "New XML File" flow to pick base vs a DLC.
function TextPromptDialog({ title, label, defaultValue, onSubmit, onClose, layers }) {
  const [value, setValue] = useState(defaultValue ?? '');
  const [layer, setLayer] = useState(layers?.[0]?.id ?? 'base');
  const inputRef = useRef(null);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);
  const submit = () => {
    const trimmed = (value ?? '').trim();
    onClose();
    if (trimmed && onSubmit) onSubmit(trimmed, layer);
  };
  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
          minWidth: 360, padding: '14px 16px',
          color: 'var(--text)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{title}</div>
        {label && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8 }}>{label}</div>
        )}
        {layers && layers.length > 1 && (
          <select
            value={layer}
            onChange={(e) => setLayer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            style={{
              width: '100%', boxSizing: 'border-box', marginBottom: 8,
              padding: '6px 8px', fontSize: 13,
              background: 'var(--bg)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 3, outline: 'none',
            }}
          >
            {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '6px 8px', fontSize: 13,
            background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 3,
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button
            onClick={onClose}
            style={{
              padding: '4px 12px', fontSize: 12, cursor: 'pointer',
              background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 3,
            }}
          >Cancel</button>
          <button
            onClick={submit}
            style={{
              padding: '4px 12px', fontSize: 12, cursor: 'pointer',
              background: 'var(--accent)', color: '#fff',
              border: '1px solid var(--accent)', borderRadius: 3,
            }}
          >OK</button>
        </div>
      </div>
    </div>
  );
}

function SidebarFilterBtn({ active, onClick, title, children }) {
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, cursor: 'pointer', borderRadius: 3, flexShrink: 0,
        border: '1px solid rgba(0,0,0,0.15)', userSelect: 'none',
        background: active ? 'var(--tab-bg)' : 'rgba(0,0,0,0.06)',
        color: active ? '#fff' : 'var(--text-dim)',
        fontSize: 12,
      }}
    >
      {children}
    </span>
  );
}

function SidebarContextMenu({ x, y, items, onClose }) {
  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }}
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        ref={clampToViewport}
        style={{
          position: 'fixed',
          top: y,
          left: x,
          zIndex: 999,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          minWidth: 160,
          padding: '4px 0',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
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
              onClick={() => { if (item.enabled !== false && item.action) item.action(); onClose(); }}
            >
              {item.label}
            </div>
          )
        ))}
      </div>
    </div>
  );
}
