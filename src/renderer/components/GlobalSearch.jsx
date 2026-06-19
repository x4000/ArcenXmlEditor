import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import VirtualList from './VirtualList';
import { useHistoryDropdown } from './SearchHistoryDropdown';
import { addEntry as addHistoryEntry } from '../editor/searchHistory';
import { displayRelPath } from '../editor/layerDisplay';

function HighlightedText({ text, query, buildRegex }) {
  if (!query || !text) return text || '';
  const re = buildRegex(query);
  if (!re) return text;
  const parts = [];
  let last = 0;
  let match;
  const localRe = new RegExp(re.source, re.flags);
  while ((match = localRe.exec(text)) !== null) {
    if (match[0].length === 0) { localRe.lastIndex++; continue; }
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<b key={match.index} style={{ background: 'rgba(255, 213, 0, 0.3)', borderRadius: 2, padding: '0 1px' }}>{match[0]}</b>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? <>{parts}</> : text;
}

export default function GlobalSearch({
  allFileContents,
  searchScope,
  folders,
  layerByRelPath,
  folderNameByRelPath,
  currentFile,
  scopeFilter = 'all',
  onScopeFilterChange,
  includeMods = false,
  onIncludeModsChange,
  onOpenFile,
  onClose,
  onReplaceInFile,
  onReplaceBatch,
  undoAvailable,
  onUndo,
  initialReplace,
  inputRef: externalInputRef,
  replaceInputRef: externalReplaceRef,
  minimizeRef,
  panelHeight,
  persistedQuery,
  onQueryChange,
}) {
  const [query, setQueryLocal] = useState(persistedQuery || '');
  const selfChangeRef = useRef(false);
  const setQuery = (v) => {
    const val = typeof v === 'function' ? v(query) : v;
    setQueryLocal(val);
    selfChangeRef.current = true;
    if (onQueryChange) onQueryChange(val);
  };
  const [activeQuery, setActiveQuery] = useState(persistedQuery || '');

  // Sync query only from EXTERNAL changes (Ctrl+Shift+F with selection), not from typing
  const prevPersistedRef = useRef(persistedQuery);
  useEffect(() => {
    if (persistedQuery !== prevPersistedRef.current && persistedQuery) {
      if (selfChangeRef.current) {
        selfChangeRef.current = false;
      } else {
        setQueryLocal(persistedQuery);
        setActiveQuery(persistedQuery);
      }
      prevPersistedRef.current = persistedQuery;
    }
  }, [persistedQuery]);
  const [replaceText, setReplaceText] = useState('');
  const [useWildcard, setUseWildcard] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(initialReplace || false);
  // XML/META scope toggles. Both default to true so a global search hits
  // every file regardless of which kind of file the user is currently in.
  // Intentionally NOT persisted — these reset to true on each mount.
  const [includeXml, setIncludeXml] = useState(true);
  const [includeMeta, setIncludeMeta] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [selectedResult, setSelectedResult] = useState(null);
  const [flashCount, setFlashCount] = useState(0); // bumps each time a search runs, triggers the flash
  const localInputRef = useRef(null);

  // Expose minimize function externally
  useEffect(() => {
    if (minimizeRef) minimizeRef.current = () => setMinimized(true);
    return () => { if (minimizeRef) minimizeRef.current = null; };
  }, [minimizeRef]);

  // Expose input ref externally for focus/select from keyboard shortcuts
  const inputRef = externalInputRef || localInputRef;

  useEffect(() => {
    if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, []);

  // Sync replace mode when initialReplace prop changes
  useEffect(() => {
    setShowReplace(!!initialReplace);
  }, [initialReplace]);

  function matchesScope(path) {
    const pathLayer = layerByRelPath?.get(path)?.layer ?? null;
    switch (scopeFilter) {
      case 'current-file':
        return !!currentFile && path === currentFile;
      case 'current-folder': {
        if (!currentFile || !folderNameByRelPath) return false;
        const cf = folderNameByRelPath.get(currentFile);
        return !!cf && folderNameByRelPath.get(path) === cf;
      }
      case 'current-package-folder': {
        if (!currentFile || !folderNameByRelPath) return false;
        const cf = folderNameByRelPath.get(currentFile);
        if (!cf || folderNameByRelPath.get(path) !== cf) return false;
        const cl = layerByRelPath?.get(currentFile)?.layer ?? null;
        return pathLayer === cl;
      }
      case 'current-package': {
        if (!currentFile) return false;
        const cl = layerByRelPath?.get(currentFile)?.layer ?? null;
        return pathLayer === cl;
      }
      case 'base-game':
        return !pathLayer;
      case 'dlcs':
        return /^dlc/.test(pathLayer ?? '');
      case 'mods':
        return /^mod_/.test(pathLayer ?? '');
      default: // 'all'
        if (!includeMods && layerByRelPath && /^mod_/.test(pathLayer ?? '')) return false;
        return true;
    }
  }

  function getFileList() {
    const contents = allFileContents || {};
    return Object.entries(contents).filter(([path]) => {
      if (!matchesScope(path)) return false;
      if (path.endsWith('.metadata')) return includeMeta;
      if (path.endsWith('.xml')) return includeXml;
      return false;
    });
  }

  function buildRegex(q) {
    if (!q || q.length < 1) return null;
    try {
      let escaped;
      if (useRegex) {
        escaped = q;
      } else if (useWildcard) {
        // Escape everything except *, then convert * to .*
        escaped = q.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      } else {
        escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
      return new RegExp(pattern, matchCase ? 'g' : 'gi');
    } catch (e) {
      return null;
    }
  }

  const doSearch = useCallback(() => {
    // Record the query in find history. Empty values are ignored by addEntry.
    addHistoryEntry('global-find', query);
    setActiveQuery(''); // force re-search even for same string
    setTimeout(() => {
      setActiveQuery(query);
      setMinimized(false);
      setSelectedResult(null);
      setFlashCount((c) => c + 1); // trigger visual flash on every search
    }, 10);
  }, [query]);

  // Search results — recompute when activeQuery or any filter toggle changes
  const results = useMemo(() => {
    if (!activeQuery || activeQuery.length < 1) return [];
    const regex = buildRegex(activeQuery);
    if (!regex) return [];

    const fileList = getFileList();
    const grouped = [];
    for (const [filePath, content] of fileList) {
      const lines = content.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
      if (matches.length > 0) {
        grouped.push({ file: filePath, matches });
      }
    }
    return grouped;
  }, [activeQuery, allFileContents, useWildcard, useRegex, matchCase, wholeWord, includeXml, includeMeta, includeMods, layerByRelPath, scopeFilter, currentFile, folderNameByRelPath]);

  const totalMatches = results.reduce((sum, g) => sum + g.matches.length, 0);

  // Transient status line under the search bar. Shows "Replaced X in Y files"
  // after a Replace All so the user gets real feedback that something
  // happened — the results list reshuffling isn't obvious on its own.
  const [replaceStatus, setReplaceStatus] = useState(null);
  useEffect(() => {
    if (!replaceStatus) return;
    const t = setTimeout(() => setReplaceStatus(null), 6000);
    return () => clearTimeout(t);
  }, [replaceStatus]);

  const handleReplaceAll = useCallback(() => {
    if (!onReplaceInFile) return;
    // Use the current find-input value rather than activeQuery. If the user
    // clicks Replace All without first clicking Search, activeQuery is
    // either empty (previously early-returned) or stale from a prior
    // session (silently replaced the wrong term). Treat the Replace All
    // click as an implicit "search and replace" against what's typed now.
    const effectiveQuery = query;
    if (!effectiveQuery) return;
    const regex = buildRegex(effectiveQuery);
    if (!regex) return;

    // A pattern that can match the empty string (e.g. `a*`, `x?`, `(foo)?`)
    // would splice the replacement between every character and corrupt the
    // file, while still reporting matches — refuse it rather than relying on
    // the match/diff checks below, which empty matches slip past.
    let canMatchEmpty = false;
    try { canMatchEmpty = new RegExp(regex.source, regex.flags.replace('g', '')).test(''); } catch (_) { /* ignore */ }
    if (canMatchEmpty) {
      setReplaceStatus({ text: `Pattern can match an empty string — replace refused (it would corrupt files).`, kind: 'none' });
      return;
    }

    // Save both histories — the user's mental model is "I searched for X
    // and replaced with Y", even if they didn't click Search explicitly.
    addHistoryEntry('global-find', effectiveQuery);
    addHistoryEntry('global-replace', replaceText);

    // Build the result set fresh from the effective query so we aren't
    // relying on the stale `results` memo (which was keyed on activeQuery).
    const fileList = getFileList();
    const batch = [];
    let totalReplacements = 0;
    for (const [filePath, content] of fileList) {
      if (!content) continue;
      // Count occurrences before replacing so we can report a total.
      // new RegExp with the same source/flags keeps `g` behavior independent
      // of `regex.lastIndex` advancing during replace below.
      const counter = new RegExp(regex.source, regex.flags);
      const matches = content.match(counter);
      if (!matches || matches.length === 0) continue;
      const newContent = content.replace(regex, replaceText);
      if (newContent !== content) {
        batch.push({ file: filePath, oldContent: content, newContent });
        totalReplacements += matches.length;
        onReplaceInFile(filePath, newContent);
      }
    }
    if (batch.length > 0 && onReplaceBatch) onReplaceBatch(batch);

    // Make the results list reflect the new state of the files.
    setActiveQuery('');
    setTimeout(() => setActiveQuery(effectiveQuery), 50);

    const n = totalReplacements;
    const m = batch.length;
    if (n === 0) {
      setReplaceStatus({ text: `No matches for "${effectiveQuery}".`, kind: 'none' });
    } else {
      setReplaceStatus({
        text: `Replaced ${n} occurrence${n === 1 ? '' : 's'} in ${m} file${m === 1 ? '' : 's'}.`,
        kind: 'ok',
      });
    }
  }, [query, replaceText, useWildcard, useRegex, matchCase, wholeWord, includeXml, includeMeta, includeMods, layerByRelPath, scopeFilter, currentFile, folderNameByRelPath, allFileContents, onReplaceInFile, onReplaceBatch]);

  const handleReplaceInFile = useCallback((filePath) => {
    if (!activeQuery || !onReplaceInFile) return;
    const regex = buildRegex(activeQuery);
    if (!regex) return;
    const content = allFileContents[filePath];
    if (!content) return;
    const counter = new RegExp(regex.source, regex.flags);
    const matches = content.match(counter);
    const newContent = content.replace(regex, replaceText);
    if (newContent !== content) {
      addHistoryEntry('global-find', activeQuery);
      addHistoryEntry('global-replace', replaceText);
      const batch = [{ file: filePath, oldContent: content, newContent }];
      onReplaceInFile(filePath, newContent);
      if (onReplaceBatch) onReplaceBatch(batch);
      setActiveQuery('');
      setTimeout(() => setActiveQuery(activeQuery), 50);
      const n = matches ? matches.length : 1;
      setReplaceStatus({
        text: `Replaced ${n} occurrence${n === 1 ? '' : 's'} in ${filePath}.`,
        kind: 'ok',
      });
    }
  }, [activeQuery, replaceText, useWildcard, useRegex, matchCase, wholeWord, allFileContents, onReplaceInFile]);

  // History dropdowns for the find and replace inputs. Position is "above"
  // because GlobalSearch sits at the bottom of the editor area; opening
  // below would render off-screen.
  const findHistory = useHistoryDropdown({
    cacheName: 'global-find',
    position: 'above',
    onApply: (v) => setQuery(v),
  });
  const replaceHistory = useHistoryDropdown({
    cacheName: 'global-replace',
    position: 'above',
    onApply: (v) => setReplaceText(v),
  });

  return (
    <div style={{
      background: 'var(--search-bg)', borderTop: '2px solid var(--accent)',
      height: minimized ? 'auto' : (panelHeight || 300), display: 'flex', flexDirection: 'column',
      fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace", fontSize: 12,
      flexShrink: 0, overflow: 'hidden', color: 'var(--search-text)',
    }}>
      {/* Search bar */}
      <div style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderBottom: minimized ? 'none' : '1px solid var(--border)' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Search across files... (Enter to search)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1, minWidth: 200, padding: '4px 8px', fontSize: 12,
            border: '1px solid var(--border)', borderRadius: 3,
            background: 'var(--bg)', color: 'var(--text)',
            fontFamily: 'inherit',
          }}
          onKeyDown={(e) => {
            // History first — it claims arrow keys + Enter/Space when open.
            if (findHistory.handleKeyDown(e, e.currentTarget)) return;
            if (e.key === 'Enter') doSearch();
            if (e.key === 'Escape') {
              if (!minimized) { setMinimized(true); } else { onClose(); }
            }
          }}
        />
        {findHistory.dropdown}
        <button
          onClick={doSearch}
          style={{
            padding: '3px 10px', fontSize: 11, cursor: 'pointer',
            border: '1px solid rgba(0,0,0,0.2)', borderRadius: 3,
            background: 'var(--tab-bg)', color: '#fff',
          }}
        >
          Search
        </button>
        <select
          value={scopeFilter}
          onChange={(e) => onScopeFilterChange?.(e.target.value)}
          title="Search scope"
          style={{
            minWidth: 160, padding: '3px 4px', fontSize: 11, cursor: 'pointer',
            border: '1px solid var(--border)', borderRadius: 3,
            background: 'var(--bg)', color: 'var(--text)',
            fontFamily: 'inherit',
          }}
        >
          <option value="all">All</option>
          <option value="current-file">Current File</option>
          <option value="current-folder">Current Folder</option>
          <option value="current-package-folder">Current Package Folder</option>
          <option value="current-package">Current Package</option>
          <option value="base-game">Only Base Game</option>
          <option value="dlcs">Only DLCs</option>
          <option value="mods">Only Mods</option>
        </select>
        <ToggleBtn active={useWildcard} onClick={() => { setUseWildcard(v => !v); if (!useWildcard) setUseRegex(false); }} title="Wildcard">*?</ToggleBtn>
        <ToggleBtn active={useRegex} onClick={() => { setUseRegex(v => !v); if (!useRegex) setUseWildcard(false); }} title="Regex">.*</ToggleBtn>
        <ToggleBtn active={matchCase} onClick={() => setMatchCase(v => !v)} title="Match Case">Aa</ToggleBtn>
        <ToggleBtn active={wholeWord} onClick={() => setWholeWord(v => !v)} title="Whole Word">ab</ToggleBtn>
        <ToggleBtn active={showReplace} onClick={() => setShowReplace(v => !v)} title="Toggle Replace">R</ToggleBtn>
        <ToggleBtn active={includeXml} onClick={() => setIncludeXml(v => !v)} title="Search XML files">XML</ToggleBtn>
        <ToggleBtn active={includeMeta} onClick={() => setIncludeMeta(v => !v)} title="Search metadata files">META</ToggleBtn>
        <ToggleBtn
          active={includeMods}
          onClick={() => onIncludeModsChange?.(!includeMods)}
          title="Include mod files in search results (off by default — preference is remembered)"
        >MODS</ToggleBtn>
        <span style={{ color: 'var(--search-text)', fontSize: 11, minWidth: 80 }}>
          {totalMatches} match{totalMatches !== 1 ? 'es' : ''} in {results.length} file{results.length !== 1 ? 's' : ''}
        </span>
        <span
          style={{ cursor: 'pointer', padding: '2px 6px', fontSize: 12, background: minimized ? '#c5384c' : 'var(--tab-bg)', color: '#fff', borderRadius: 3, lineHeight: '18px', display: 'inline-block', textAlign: 'center', minWidth: 22 }}
          onClick={() => setMinimized(v => !v)}
          title={minimized ? 'Show results' : 'Hide results'}
        >
          {minimized ? '▲' : '▼'}
        </span>
        <span style={{ cursor: 'pointer', padding: '2px 6px', fontSize: 12, background: 'var(--tab-bg)', color: '#fff', borderRadius: 3, lineHeight: '18px', display: 'inline-block', textAlign: 'center', minWidth: 22 }} onClick={onClose}>✕</span>
      </div>

      {/* Replace bar — always visible when in replace mode, even when minimized */}
      {showReplace && (
        <div style={{ padding: '4px 12px 8px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
          <input
            ref={externalReplaceRef}
            type="text"
            placeholder="Replace with..."
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            style={{
              flex: 1, minWidth: 200, padding: '4px 8px', fontSize: 12,
              border: '1px solid var(--border)', borderRadius: 3,
              background: 'var(--bg)', color: 'var(--text)',
              fontFamily: 'inherit',
            }}
            onKeyDown={(e) => {
              if (replaceHistory.handleKeyDown(e, e.currentTarget)) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.target.selectionStart !== e.target.selectionEnd) {
                  e.target.setSelectionRange(e.target.selectionEnd, e.target.selectionEnd);
                }
                handleReplaceAll();
              }
              if (e.key === 'Escape') {
                if (!minimized) { setMinimized(true); } else { onClose(); }
              }
            }}
          />
          {replaceHistory.dropdown}
              <button
                onClick={handleReplaceAll}
                style={{
                  padding: '3px 10px', fontSize: 11, cursor: 'pointer',
                  border: '1px solid rgba(0,0,0,0.2)', borderRadius: 3,
                  background: 'var(--tab-bg)', color: '#fff',
                }}
              >
                Replace All
              </button>
              <button
                onClick={onUndo}
                disabled={!undoAvailable}
                style={{
                  padding: '3px 10px', fontSize: 11, cursor: undoAvailable ? 'pointer' : 'default',
                  border: '1px solid rgba(0,0,0,0.2)', borderRadius: 3,
                  background: undoAvailable ? 'var(--tab-bg)' : 'rgba(0,0,0,0.08)',
                  color: undoAvailable ? '#fff' : 'var(--text-dim)',
                }}
                title="Undo last replace operation"
              >
                Undo
              </button>
            </div>
          )}

      {replaceStatus && (
        <div
          style={{
            padding: '4px 12px',
            fontSize: 11,
            background: replaceStatus.kind === 'none' ? 'rgba(200,120,0,0.15)' : 'rgba(40,140,60,0.15)',
            borderBottom: '1px solid var(--border)',
            color: 'var(--search-text)',
          }}
        >
          {replaceStatus.text}
        </div>
      )}

      {!minimized && (() => {
        // Flatten grouped results into a single row list for virtualization.
        // If the user has searched and there are zero matches, show an explicit
        // "no results" row so it's obvious the search ran.
        const flatRows = [];
        const hasSearched = !!activeQuery;
        if (hasSearched && results.length === 0) {
          flatRows.push({ kind: 'empty' });
        }
        for (const group of results) {
          flatRows.push({ kind: 'header', file: group.file, count: group.matches.length });
          for (const m of group.matches) {
            flatRows.push({ kind: 'match', file: group.file, line: m.line, text: m.text });
          }
        }
        const HEADER_H = 26;
        const MATCH_H = 20;
        const EMPTY_H = 36;
        return (
          <div
            key={flashCount}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0, animation: flashCount > 0 ? 'search-flash 0.4s ease-out' : 'none' }}
          >
          <VirtualList
            rows={flatRows}
            getRowHeight={(i) => {
              const r = flatRows[i];
              if (r.kind === 'header') return HEADER_H;
              if (r.kind === 'empty') return EMPTY_H;
              return MATCH_H;
            }}
            overscan={200}
            style={{ flex: 1, minHeight: 0, padding: '4px 0', background: 'var(--search-results-bg)' }}
            getRowKey={(r, i) => {
              if (r.kind === 'header') return `h:${r.file}`;
              if (r.kind === 'empty') return `e:${flashCount}`;
              return `m:${r.file}:${r.line}:${i}`;
            }}
            renderRow={(row) => {
              if (row.kind === 'empty') {
                const scopeLabel = (!includeXml && !includeMeta)
                  ? 'no files (XML and META are both disabled)'
                  : (includeXml && includeMeta)
                    ? 'XML or metadata files'
                    : includeXml ? 'XML files' : 'metadata files';
                return (
                  <div style={{
                    padding: '8px 12px', fontSize: 11, fontStyle: 'italic',
                    color: 'var(--text-dim)', textAlign: 'center',
                    boxSizing: 'border-box', height: EMPTY_H,
                  }}>
                    No results found for "{activeQuery}" in {scopeLabel}
                  </div>
                );
              }
              if (row.kind === 'header') {
                return (
                  <div style={{
                    padding: '4px 12px', fontWeight: 700, fontSize: 11,
                    color: 'var(--search-text)', background: 'var(--search-results-header)',
                    display: 'flex', alignItems: 'center', gap: 8,
                    boxSizing: 'border-box', height: HEADER_H,
                  }}>
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.file}>
                      {displayRelPath(row.file)} ({row.count})
                    </span>
                    {showReplace && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleReplaceInFile(row.file); }}
                        style={{
                          padding: '1px 8px', fontSize: 10, cursor: 'pointer',
                          border: '1px solid var(--border)', borderRadius: 3,
                          background: 'transparent', color: 'var(--search-text)',
                        }}
                      >
                        Replace in file
                      </button>
                    )}
                  </div>
                );
              }
              // match row
              const isSelected = selectedResult === `${row.file}:${row.line}`;
              return (
                <div
                  style={{
                    padding: '2px 12px 2px 24px', cursor: 'pointer',
                    fontSize: 11,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    background: isSelected ? 'var(--accent)' : 'transparent',
                    color: isSelected ? '#fff' : 'var(--search-text)',
                    boxSizing: 'border-box', height: MATCH_H,
                  }}
                  onClick={() => { setSelectedResult(`${row.file}:${row.line}`); onOpenFile(row.file, row.line); }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(0,0,0,0.06)'; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ color: 'var(--text-dim)', marginRight: 8, minWidth: 30, display: 'inline-block' }}>:{row.line}</span>
                  <HighlightedText text={row.text} query={activeQuery} buildRegex={buildRegex} />
                </div>
              );
            }}
          />
          </div>
        );
      })()}
    </div>
  );
}

function ToggleBtn({ active, onClick, title, children }) {
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        padding: '2px 6px', cursor: 'pointer', fontSize: 11, fontWeight: 700,
        border: '1px solid rgba(0,0,0,0.2)', borderRadius: 3,
        background: active ? 'var(--tab-bg)' : 'rgba(0,0,0,0.06)',
        color: active ? '#fff' : 'var(--text-dim)',
        userSelect: 'none',
      }}
    >
      {children}
    </span>
  );
}
