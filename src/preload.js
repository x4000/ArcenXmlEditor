const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcenApi', {
  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // File discovery
  discoverData: () => ipcRenderer.invoke('discover-data'),
  getDataRoot: () => ipcRenderer.invoke('get-data-root'),
  selectDataRoot: () => ipcRenderer.invoke('select-data-root'),
  getRecentDataRoots: () => ipcRenderer.invoke('get-recent-data-roots'),
  removeRecentDataRoot: (absPath) => ipcRenderer.invoke('remove-recent-data-root', absPath),
  setDataRoot: (absPath) => ipcRenderer.invoke('set-data-root', absPath),
  // Window-title project name + per-root display nicknames.
  getProjectName: () => ipcRenderer.invoke('get-project-name'),
  onProjectNameChanged: (callback) => {
    ipcRenderer.on('project-name-changed', (_event, name) => callback(name));
  },
  getRootNicknames: () => ipcRenderer.invoke('get-root-nicknames'),
  setRootNickname: (absPath, nickname) => ipcRenderer.invoke('set-root-nickname', absPath, nickname),

  // File I/O
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  writeFile: (path, content) => ipcRenderer.invoke('write-file', path, content),

  // Session
  loadSession: () => ipcRenderer.invoke('load-session'),
  saveSession: (data) => ipcRenderer.invoke('save-session', data),
  // Favorites are part of the session now (no separate _editor_shared.json).
  // Detached windows read the current list via getFavorites; everyone pushes
  // mutations through updateFavorites which main.js mirrors + broadcasts.
  getFavorites: () => ipcRenderer.invoke('get-favorites'),

  // File management
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),
  renameFile: (oldPath, newPath) =>
    ipcRenderer.invoke('rename-file', oldPath, newPath),
  createFolder: (name, opts) => ipcRenderer.invoke('create-folder', name, opts),
  createXmlFile: (folderName, fileName, layerId) => ipcRenderer.invoke('create-xml-file', folderName, fileName, layerId),

  // Validation window
  openValidationWindow: () => ipcRenderer.invoke('open-validation-window'),
  openHelpWindow: () => ipcRenderer.invoke('open-help-window'),

  // File watcher events (main → renderer)
  onFileChangedOnDisk: (callback) => {
    ipcRenderer.on('file-changed-on-disk', (_event, path) => callback(path));
  },
  onFileAddedOnDisk: (callback) => {
    ipcRenderer.on('file-added-on-disk', (_event, path) => callback(path));
  },
  onFileRemovedOnDisk: (callback) => {
    ipcRenderer.on('file-removed-on-disk', (_event, path) => callback(path));
  },
  // Mods/expansions added or removed on disk during the session — the renderer
  // should re-pull discoverData() so the MODS tab + layer maps reflect them.
  onLayersChanged: (callback) => {
    ipcRenderer.on('layers-changed', () => callback());
  },
  // Island cross-YAML FK values re-resolved (a referenced source file changed).
  onIslandYamlSourcesChanged: (callback) => {
    ipcRenderer.on('island-yaml-sources-changed', (_event, map) => callback(map));
  },

  // Validation window communication
  sendValidationResults: (results) => {
    ipcRenderer.send('validation-results', results);
  },
  // A detached window's live validation for the single file it is editing.
  // file=null clears this window's contribution.
  sendDetachedValidation: (file, results) => {
    ipcRenderer.send('detached-validation', file, results);
  },
  getValidationResults: () => ipcRenderer.invoke('get-validation-results'),
  exportValidationResults: () => ipcRenderer.invoke('export-validation-results'),
  onValidationResults: (callback) => {
    ipcRenderer.on('validation-results', (_event, results) =>
      callback(results)
    );
  },
  onNavigateToLine: (callback) => {
    ipcRenderer.removeAllListeners('navigate-to-line');
    ipcRenderer.on('navigate-to-line', (_event, file, line, highlight, absPos) =>
      callback(file, line, highlight, absPos)
    );
  },
  navigateToLine: (file, line, highlight, absPos) => {
    ipcRenderer.send('navigate-to-line', file, line, highlight, absPos);
  },
  requestRevalidate: () => {
    ipcRenderer.send('request-revalidate');
  },
  requestSpellingCheck: () => {
    ipcRenderer.send('request-spelling-check');
  },
  onRequestSpellingCheck: (callback) => {
    ipcRenderer.on('request-spelling-check', () => callback());
  },
  requestGrammarCheck: () => {
    ipcRenderer.send('request-grammar-check');
  },
  onRequestGrammarCheck: (callback) => {
    ipcRenderer.on('request-grammar-check', () => callback());
  },
  requestGrammarSettings: () => {
    ipcRenderer.send('request-grammar-settings');
  },
  onRequestGrammarSettings: (callback) => {
    ipcRenderer.on('request-grammar-settings', () => callback());
  },
  requestGrammarDismiss: (textHash, fingerprint) => {
    ipcRenderer.send('request-grammar-dismiss', textHash, fingerprint);
  },
  onRequestGrammarDismiss: (callback) => {
    ipcRenderer.on('request-grammar-dismiss', (_event, textHash, fingerprint) => callback(textHash, fingerprint));
  },
  requestGrammarResolve: (textHash, fingerprint) => {
    ipcRenderer.send('request-grammar-resolve', textHash, fingerprint);
  },
  onRequestGrammarResolve: (callback) => {
    ipcRenderer.on('request-grammar-resolve', (_event, textHash, fingerprint) => callback(textHash, fingerprint));
  },
  sendTheme: (theme) => {
    ipcRenderer.send('theme-change', theme);
  },
  sendEditorScale: (scale) => {
    ipcRenderer.send('editor-scale-change', scale);
  },
  onEditorScaleChange: (callback) => {
    ipcRenderer.on('editor-scale-change', (_event, scale) => callback(scale));
  },
  sendRefPanelScale: (scale) => {
    ipcRenderer.send('ref-panel-scale-change', scale);
  },
  // Central file state registry
  getFileState: (relativePath) => ipcRenderer.sendSync('get-file-state', relativePath),
  setFileState: (relativePath, data) => ipcRenderer.send('set-file-state', relativePath, data),
  // Window-level state (tabs, sidebar, theme, etc.) — sync save to main process
  saveWindowState: (data) => ipcRenderer.sendSync('save-window-state', data),
  // Open global search in main window (from detached windows)
  openGlobalSearch: (query, replace, currentFile) => ipcRenderer.send('open-global-search', query, replace, currentFile),
  onOpenGlobalSearch: (callback) => {
    ipcRenderer.on('open-global-search', (_event, query, replace, currentFile) => callback(query, replace, currentFile));
  },
  // Update detached window's active tab in registry
  setDetachedActiveTab: (index) => ipcRenderer.send('set-detached-active-tab', index),

  onRefPanelScaleChange: (callback) => {
    ipcRenderer.on('ref-panel-scale-change', (_event, scale) => callback(scale));
  },
  requestReplace: (file, oldText, newText) => {
    ipcRenderer.send('request-replace', file, oldText, newText);
  },
  requestReplaceAll: (oldText, newText) => {
    ipcRenderer.send('request-replace-all', oldText, newText);
  },
  requestIgnoreNode: (file, absPos) => {
    ipcRenderer.send('request-ignore-node', file, absPos);
  },
  onRequestReplace: (callback) => {
    ipcRenderer.on('request-replace', (_event, file, oldText, newText) => callback(file, oldText, newText));
  },
  onRequestReplaceAll: (callback) => {
    ipcRenderer.on('request-replace-all', (_event, oldText, newText) => callback(oldText, newText));
  },
  onRequestIgnoreNode: (callback) => {
    ipcRenderer.on('request-ignore-node', (_event, file, absPos) => callback(file, absPos));
  },
  onThemeChange: (callback) => {
    ipcRenderer.on('theme-change', (_event, theme) => callback(theme));
  },
  onRequestRevalidate: (callback) => {
    ipcRenderer.on('request-revalidate', () => callback());
  },

  // Multi-window support
  getWindowInfo: () => ipcRenderer.invoke('get-window-info'),
  detachTabAtPosition: (relativePath, screenX, screenY, buffer) =>
    ipcRenderer.invoke('detach-tab-at-position', relativePath, screenX, screenY, buffer),
  registerWindowTabs: (tabs) => ipcRenderer.invoke('register-window-tabs', tabs),
  focusSidebarOnFile: (relativePath, opts) => ipcRenderer.invoke('focus-sidebar-on-file', relativePath, opts),
  // Report this window's currently-active file so the main window can later
  // "center on the active tab" using whichever window was focused most recently.
  reportActiveFile: (relativePath) => ipcRenderer.send('report-active-file', relativePath),
  getCenterTarget: () => ipcRenderer.invoke('get-center-target'),
  // Union of every live window's active file, for the main sidebar's highlight.
  getActiveFiles: () => ipcRenderer.invoke('get-active-files'),
  onActiveFilesChanged: (callback) => {
    ipcRenderer.removeAllListeners('active-files-changed');
    ipcRenderer.on('active-files-changed', (_event, files) => callback(files));
  },
  updateFavorites: (favorites) => ipcRenderer.invoke('update-favorites', favorites),
  findWindowForTab: (relativePath) => ipcRenderer.invoke('find-window-for-tab', relativePath),
  getDetachedSession: () => ipcRenderer.invoke('get-detached-session'),
  getDetachedDisplayNum: () => ipcRenderer.invoke('get-detached-display-num'),
  onDetachedDisplayNumChanged: (callback) => {
    ipcRenderer.on('detached-display-num', (_event, n) => callback(n));
  },
  // These five channels are (re)subscribed from React effects. Clear any prior
  // handler first so a re-registration replaces rather than stacks listeners —
  // duplicate handlers firing with stale closures is what blanked a detached
  // window after dragging a tab out.
  onTabRemoved: (callback) => {
    ipcRenderer.removeAllListeners('tab-removed');
    ipcRenderer.on('tab-removed', (_event, relativePath) => callback(relativePath));
  },
  onTabAdded: (callback) => {
    ipcRenderer.removeAllListeners('tab-added');
    ipcRenderer.on('tab-added', (_event, relativePath, buffer) => callback(relativePath, buffer));
  },
  onFocusSidebarOnFile: (callback) => {
    ipcRenderer.removeAllListeners('focus-sidebar-on-file');
    ipcRenderer.on('focus-sidebar-on-file', (_event, relativePath, opts) => callback(relativePath, opts));
  },
  onUpdateFavorites: (callback) => {
    ipcRenderer.removeAllListeners('update-favorites');
    ipcRenderer.on('update-favorites', (_event, favorites) => callback(favorites));
  },
  onFocusTab: (callback) => {
    ipcRenderer.removeAllListeners('focus-tab');
    ipcRenderer.on('focus-tab', (_event, relativePath) => callback(relativePath));
  },

  // Spelling & Grammar
  loadSpellingDictionary: () => ipcRenderer.invoke('load-spelling-dictionary'),
  addToDictionary: (word) => ipcRenderer.invoke('add-to-dictionary', word),
  removeFromDictionary: (word) => ipcRenderer.invoke('remove-from-dictionary', word),
  addToDevDictionary: (word) => ipcRenderer.invoke('add-to-dev-dictionary', word),
  removeFromDevDictionary: (word) => ipcRenderer.invoke('remove-from-dev-dictionary', word),
  onDevDictionaryWordAdded: (callback) => {
    const listener = (_event, word) => callback(word);
    ipcRenderer.on('dev-dictionary-word-added', listener);
    return () => ipcRenderer.removeListener('dev-dictionary-word-added', listener);
  },
  // Grammar LLM (Phase 2 — Anthropic API)
  grammarLLMLoadSettings: () => ipcRenderer.invoke('grammar-llm-load-settings'),
  grammarLLMSaveSettings: (settings) => ipcRenderer.invoke('grammar-llm-save-settings', settings),
  grammarLLMSupportedModels: () => ipcRenderer.invoke('grammar-llm-supported-models'),
  grammarLLMTestApi: (settings) => ipcRenderer.invoke('grammar-llm-test-api', settings),
  grammarLLMLoadCache: () => ipcRenderer.invoke('grammar-llm-load-cache'),
  grammarLLMSaveCache: (cache) => ipcRenderer.invoke('grammar-llm-save-cache', cache),
  grammarLLMHash: (text) => ipcRenderer.invoke('grammar-llm-hash', text),
  grammarLLMCheckBatch: (items) => ipcRenderer.invoke('grammar-llm-check-batch', items),

  logToTerminal: (message) => ipcRenderer.send('log-to-terminal', message),
  getSuggestions: (word) => ipcRenderer.invoke('get-suggestions', word),
  onComputeSuggestions: (callback) => {
    ipcRenderer.on('compute-suggestions', (_event, requestId, word) => callback(requestId, word));
  },
  sendSuggestionsComputed: (requestId, suggestions) => {
    ipcRenderer.send('suggestions-computed', requestId, suggestions);
  },
  onDictionaryChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('dictionary-changed', listener);
    return () => ipcRenderer.removeListener('dictionary-changed', listener);
  },
  onDictionaryWordAdded: (callback) => {
    const listener = (_event, word) => callback(word);
    ipcRenderer.on('dictionary-word-added', listener);
    return () => ipcRenderer.removeListener('dictionary-word-added', listener);
  },

  // Plugins / Source Control
  pluginsGetAll: () => ipcRenderer.invoke('plugins-get-all'),
  onPluginsChanged: (callback) => {
    ipcRenderer.on('plugins-changed', (_event, snap) => callback(snap));
  },
  scGetActive: () => ipcRenderer.invoke('sc-get-active'),
  scGetStatus: (scope, absPath) => ipcRenderer.invoke('sc-get-status', scope, absPath),
  scGetFolderRollup: (absFolderPath) => ipcRenderer.invoke('sc-get-folder-rollup', absFolderPath),
  scGetCommands: (scope, absPath) => ipcRenderer.invoke('sc-get-commands', scope, absPath),
  scRunCommand: (commandId, absPath) => ipcRenderer.invoke('sc-run-command', commandId, absPath),
  scRefresh: (scope) => ipcRenderer.invoke('sc-refresh', scope),
  scRedetect: () => ipcRenderer.invoke('sc-redetect'),
  scAbsPath: (relPath) => ipcRenderer.invoke('sc-abs-path', relPath),
  scGetBaseContent: (pathArg) => ipcRenderer.invoke('sc-get-base-content', pathArg),
  onVcsStatusChanged: (callback) => {
    ipcRenderer.on('vcs-status-changed', (_event, info) => callback(info));
  },
});
