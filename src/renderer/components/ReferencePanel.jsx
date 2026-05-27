/**
 * ReferencePanel — read-only CM6 editor for viewing a different
 * part of the same file alongside the main editor.
 *
 * Features: syntax highlighting, schema decorations, tooltips, color swatches,
 * line numbers, search highlighting. NO editing, NO gutter diff, NO click handlers.
 */

import React, { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { EditorState, EditorSelection, StateField, StateEffect } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, Decoration, ViewPlugin } from '@codemirror/view';
import { xml } from '@codemirror/lang-xml';
import { syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap, getSearchQuery, setSearchQuery, SearchQuery, openSearchPanel } from '@codemirror/search';
import { createArcenHighlighter, createSchemaDecorations, createMetadataDecorations } from '../editor/highlighting';
import { createSearchScrollMarkers } from '../editor/searchScrollMarkers';
import { buildMergedSchema } from '../editor/schemaParser';

// Custom search highlight effect and field — works independently of CM6's search panel open/close state
const setRefHighlightQuery = StateEffect.define();
const refHighlightField = StateField.define({
  create() { return { search: '', caseSensitive: false, regexp: false }; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setRefHighlightQuery)) return e.value;
    }
    return value;
  },
});

function createRefSearchHighlight() {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = this.buildDecos(view);
    }
    update(update) {
      if (update.docChanged || update.transactions.some(t => t.effects.some(e => e.is(setRefHighlightQuery)))) {
        this.decorations = this.buildDecos(update.view);
      }
    }
    buildDecos(view) {
      const q = view.state.field(refHighlightField);
      if (!q.search) return Decoration.none;
      let re;
      try {
        const escaped = q.regexp ? q.search : q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(escaped, q.caseSensitive ? 'g' : 'gi');
      } catch (_) { return Decoration.none; }
      const builder = [];
      const text = view.state.doc.toString();
      let m;
      let count = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        builder.push(Decoration.mark({ class: 'cm-searchMatch' }).range(m.index, m.index + m[0].length));
        if (++count > 5000) break;
      }
      return Decoration.set(builder);
    }
  }, { decorations: (v) => v.decorations });
}

export default forwardRef(function ReferencePanel({
  relativePath,
  content,
  theme,
  schema,
  sharedSchema,
  isSchema,
  fkIndex,
  scrollToLine,
  height,
  refPanelScale,
  onRefPanelScaleChange,
  onClose,
  onHeightChange,
  searchQuery, // { search, replace, caseSensitive, regexp, wholeWord } from main editor
  editorViewRef, // ref to main editor's CM6 view for delegating shortcuts
}, ref) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);
  const lastContentRef = useRef(content);
  const navRef = useRef({ next: () => {}, prev: () => {} });
  const [scaleInput, setScaleInput] = useState(null);
  const scrollToLineRef = useRef(scrollToLine);
  scrollToLineRef.current = scrollToLine;

  const mergedSchema = schema && sharedSchema ? buildMergedSchema(sharedSchema, schema) : schema;
  const schemaRef = useRef(mergedSchema);
  schemaRef.current = isSchema ? null : mergedSchema;
  const getSchema = useCallback(() => schemaRef.current, []);

  // Create read-only CM6 editor
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      EditorState.readOnly.of(true),
      lineNumbers(),
      drawSelection(),
      xml(),
      syntaxHighlighting(createArcenHighlighter(theme)),
      // Delegate search shortcuts to main editor; F3/Shift+F3 navigate within ref panel
      keymap.of([
        { key: 'F3', run: () => { navRef.current?.next(); return true; } },
        { key: 'Shift-F3', run: () => { navRef.current?.prev(); return true; } },
        { key: 'Mod-f', run: (refView) => {
          const mv = editorViewRef?.current;
          if (mv) {
            // Get selection from ref panel
            const sel = refView.state.selection.main;
            const selText = sel.from !== sel.to ? refView.state.sliceDoc(sel.from, sel.to) : '';
            openSearchPanel(mv);
            setTimeout(() => {
              const panel = mv.dom.closest('.cm-editor')?.querySelector('.cm-search');
              if (panel) {
                const input = panel.querySelector('input[type="text"], input:not([type])');
                if (input) {
                  if (selText && !selText.includes('\n')) {
                    // Use native setter to trigger CM6's input handling
                    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    nativeSetter.call(input, selText);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                  input.select();
                  input.focus();
                }
              }
            }, 50);
          }
          return true;
        }},
        { key: 'Mod-h', run: (refView) => {
          const mv = editorViewRef?.current;
          if (mv) {
            const sel = refView.state.selection.main;
            const selText = sel.from !== sel.to ? refView.state.sliceDoc(sel.from, sel.to) : '';
            openSearchPanel(mv);
            setTimeout(() => {
              const panel = mv.dom.closest('.cm-editor')?.querySelector('.cm-search');
              if (panel) {
                const inputs = panel.querySelectorAll('input[type="text"], input:not([type])');
                if (selText && !selText.includes('\n') && inputs.length >= 1) {
                  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                  nativeSetter.call(inputs[0], selText);
                  inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (inputs.length >= 2) { inputs[1].select(); inputs[1].focus(); }
              }
            }, 50);
          }
          return true;
        }},
      ]),
      search({ top: false }), // search state for scrollbar markers + navigation
      refHighlightField, // custom highlight state
      createRefSearchHighlight(), // custom inline highlight decorations
      createSearchScrollMarkers(),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace",
          fontSize: (13 * (refPanelScale || 100) / 100) + 'px',
        },
        '.cm-content': { padding: '4px 0' },
        '.cm-line': { padding: '0 8px' },
        '.cm-gutters': {
          background: 'var(--gutter-bg)', color: 'var(--gutter-text)',
          borderRight: '1px solid var(--border)',
        },
        // Reuse the same highlighting classes
        '.cm-dimmed-attr, .cm-dimmed-attr *': { color: '#999999 !important' },
        '.cm-bool-false, .cm-bool-false *': { color: (theme === 'dark' ? '#487ca8' : '#5757d6') + ' !important' },
        '.cm-header-attr-name, .cm-header-attr-name *': { color: (theme === 'dark' ? '#ff5c8a' : '#ff0054') + ' !important', fontWeight: 'bold !important' },
        '.cm-header-attr-value, .cm-header-attr-value *': { color: (theme === 'dark' ? '#f0b0ff' : '#5e00ff') + ' !important', fontWeight: 'bold !important' },
        '.cm-subnode-tag, .cm-subnode-tag *': { color: (theme === 'dark' ? '#b57cff' : '#923aff') + ' !important', fontWeight: 'bold !important' },
        '.cm-searchMatch': { background: 'rgba(255, 213, 0, 0.35) !important' },
        '.cm-searchMatch-selected': { background: 'rgba(255, 150, 0, 0.55) !important' },
      }),
    ];

    // Schema-aware decorations
    if (!isSchema && mergedSchema) {
      extensions.push(createSchemaDecorations(getSchema, theme));
    } else if (isSchema) {
      extensions.push(createMetadataDecorations(theme));
    }

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    lastContentRef.current = content;

    // Apply any existing search query to the new view
    if (searchQuery?.search) {
      try {
        view.dispatch({
          effects: [
            setSearchQuery.of(new SearchQuery(searchQuery)),
            setRefHighlightQuery.of({
              search: searchQuery.search,
              caseSensitive: !!searchQuery.caseSensitive,
              regexp: !!searchQuery.regexp,
            }),
          ],
        });
      } catch (_) {}
    }

    // Track scroll position and save to central registry (debounced)
    let refScrollTimer = null;
    const refScrollHandler = () => {
      if (refScrollTimer) clearTimeout(refScrollTimer);
      refScrollTimer = setTimeout(() => {
        try {
          const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 1).from;
          const scrollLine = view.state.doc.lineAt(topPos).number;
          window.arcenApi.setFileState(relativePath, {
            refPanel: { open: true, height, scrollLine },
          });
        } catch (_) {}
      }, 500);
    };
    view.scrollDOM.addEventListener('scroll', refScrollHandler, { passive: true });

    // Scroll to saved line after layout is ready
    const doScroll = () => {
      const ln = scrollToLineRef.current;
      if (ln == null) return;
      try {
        const lineNum = Math.min(ln, view.state.doc.lines);
        const line = view.state.doc.line(lineNum);
        const block = view.lineBlockAt(line.from);
        view.scrollDOM.scrollTop = block.top;
      } catch (_) {}
    };
    requestAnimationFrame(() => {
      view.requestMeasure();
      requestAnimationFrame(doScroll);
    });
    setTimeout(doScroll, 150);

    return () => {
      if (refScrollTimer) clearTimeout(refScrollTimer);
      view.scrollDOM.removeEventListener('scroll', refScrollHandler);
      view.destroy();
      viewRef.current = null;
    };
  }, [theme, isSchema, refPanelScale]);

  // Sync content into existing view (no view recreation, preserves scroll)
  useEffect(() => {
    if (viewRef.current && content !== lastContentRef.current) {
      const view = viewRef.current;
      const currentDoc = view.state.doc.toString();
      if (content !== currentDoc) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
        });
      }
      lastContentRef.current = content;
    }
  }, [content]);

  // Scroll to line when requested
  useEffect(() => {
    if (scrollToLine != null && viewRef.current) {
      const view = viewRef.current;
      const doScroll = () => {
        try {
          const lineNum = Math.min(scrollToLine, view.state.doc.lines);
          const line = view.state.doc.line(lineNum);
          view.dispatch({
            selection: { anchor: line.from },
            effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
          });
        } catch (_) {}
      };
      view.requestMeasure();
      requestAnimationFrame(() => requestAnimationFrame(doScroll));
      setTimeout(doScroll, 150);
    }
  }, [scrollToLine]);

  // Sync search query from main editor
  const searchKey = searchQuery ? `${searchQuery.search}|${searchQuery.caseSensitive}|${searchQuery.regexp}` : '';
  useEffect(() => {
    if (!viewRef.current) return;
    try {
      const sq = searchQuery?.search ? searchQuery : { search: '' };
      viewRef.current.dispatch({
        effects: [
          setSearchQuery.of(new SearchQuery(sq)),
          setRefHighlightQuery.of({
            search: sq.search || '',
            caseSensitive: !!sq.caseSensitive,
            regexp: !!sq.regexp,
          }),
        ],
      });
    } catch (_) {}
  }, [searchKey]);

  // Expose view for external search navigation — uses custom refHighlightField
  const findMatches = useCallback((view) => {
    const q = view.state.field(refHighlightField);
    if (!q.search) return [];
    let re;
    try {
      const escaped = q.regexp ? q.search : q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(escaped, q.caseSensitive ? 'g' : 'gi');
    } catch (_) { return []; }
    const text = view.state.doc.toString();
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      matches.push({ from: m.index, to: m.index + m[0].length });
      if (matches.length > 10000) break;
    }
    return matches;
  }, []);

  const navigateNext = useCallback(() => {
    if (!viewRef.current) return;
    const view = viewRef.current;
    const matches = findMatches(view);
    if (matches.length === 0) return;
    const { to } = view.state.selection.main;
    const next = matches.find(m => m.from >= to) || matches[0]; // wrap around
    view.dispatch({
      selection: EditorSelection.single(next.from, next.to),
      effects: EditorView.scrollIntoView(next.from, { y: 'center' }),
    });
  }, [findMatches]);

  const navigatePrev = useCallback(() => {
    if (!viewRef.current) return;
    const view = viewRef.current;
    const matches = findMatches(view);
    if (matches.length === 0) return;
    const { from } = view.state.selection.main;
    let prev = null;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].to <= from) { prev = matches[i]; break; }
    }
    if (!prev) prev = matches[matches.length - 1]; // wrap around
    view.dispatch({
      selection: EditorSelection.single(prev.from, prev.to),
      effects: EditorView.scrollIntoView(prev.from, { y: 'center' }),
    });
  }, [findMatches]);

  // Expose navigation methods via forwarded ref
  // Keep navRef current for keymap access
  navRef.current = { next: navigateNext, prev: navigatePrev };

  useImperativeHandle(ref, () => ({
    _refPanelNav: { next: navigateNext, prev: navigatePrev },
  }), [navigateNext, navigatePrev]);

  return (
    <div style={{
      height: height || 200, display: 'flex', flexDirection: 'column',
      borderBottom: '3px solid var(--tab-bar-bg)', flexShrink: 0, position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Close button */}
      <div
        style={{
          position: 'absolute', top: 4, right: 14, zIndex: 20,
          cursor: 'pointer', fontSize: 14, width: 20, height: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--tab-bg)', color: '#fff', borderRadius: 3,
          opacity: 0.6,
        }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
        onClick={onClose}
        title="Close reference panel"
      >
        ✕
      </div>

      {/* Editor container */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />

      {/* Scale indicator */}
      <div
        style={{
          position: 'absolute', bottom: 14, left: 2, zIndex: 15,
          fontSize: 10, color: '#fff', background: 'var(--tab-bg)',
          border: '1px solid var(--tab-bar-bg)', borderRadius: 3,
          padding: '2px 5px', cursor: 'pointer', userSelect: 'none',
          minWidth: 34, textAlign: 'center',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }}
        onClick={() => setScaleInput(String(refPanelScale || 100))}
        title="Click to change reference panel text scale"
      >
        {scaleInput !== null ? (
          <input
            type="text"
            value={scaleInput}
            onChange={(e) => setScaleInput(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const val = Math.max(70, Math.min(200, parseInt(scaleInput, 10) || 100));
                if (onRefPanelScaleChange) onRefPanelScaleChange(val);
                setScaleInput(null);
              }
              if (e.key === 'Escape') setScaleInput(null);
            }}
            onBlur={() => {
              const val = Math.max(70, Math.min(200, parseInt(scaleInput, 10) || 100));
              if (onRefPanelScaleChange) onRefPanelScaleChange(val);
              setScaleInput(null);
            }}
            autoFocus
            style={{
              width: 28, border: 'none', background: 'transparent',
              color: '#fff', fontSize: 10, textAlign: 'center',
              outline: 'none', padding: 0,
            }}
          />
        ) : (
          <span>{refPanelScale || 100}%</span>
        )}
      </div>
    </div>
  );
});
