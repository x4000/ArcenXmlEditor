/**
 * EditorPane — CodeMirror 6 wrapper with all Arcen extensions.
 *
 * Integrates: syntax highlighting, schema decorations, autocomplete,
 * click handling, context menus, change gutter, keybindings.
 *
 * Renders overlay components: FK pickers, color picker, node delete dialog, tooltips.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { xml } from '@codemirror/lang-xml';
import { syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, getSearchQuery, setSearchQuery, SearchQuery } from '@codemirror/search';
import { createInSelectionExtension, inSelectionKeymap } from '../editor/searchInSelection';
import { createSearchScrollMarkers } from '../editor/searchScrollMarkers';
import { createArcenHighlighter, createSchemaDecorations, createMetadataDecorations } from '../editor/highlighting';
import ReferencePanel from './ReferencePanel';
import LocalSearchHistory from './LocalSearchHistory';
import { tokenize, buildAttrMap } from '../editor/xmlTokenizer';
import { naturalCompare } from '../editor/naturalSort';
import { createArcenKeymap, createArcenInputHandlers } from '../editor/keybindings';
import { createArcenAutocomplete } from '../editor/autocomplete';
import { createClickHandler } from '../editor/clickHandler';
import { createContextMenu, findSpellingErrorAtPos } from '../editor/contextMenu';
import { classifyWordScript, asciifyHomoglyphs, getForbiddenCharFix } from '../editor/spellcheck';
import { clampToViewport } from '../editor/menuUtils';
import { createChangeGutter, setSavedContent, setVcsBaseContent } from '../editor/changeGutter';
import { buildMergedSchema, getCentralIdentifierKey } from '../editor/schemaParser';
import { getFKOptionsForLayer } from '../editor/fkIndex';
import { createSpellcheckDecorations, isSpellcheckTarget, isInferredDevContext, isDevNotesAttr, buildNodeFlagRanges, isInRange } from '../editor/spellcheck';
import { FKDropdown, FKMultiSelect } from './FKPickers';
import NodeDeleteDialog from './NodeDeleteDialog';

// Valid type values for schema attribute definitions, shown in the dropdown
// that appears when clicking a `type="..."` value inside a .metadata file.
// Keep sorted alphabetically for easy scanning.
const SCHEMA_TYPE_OPTIONS = [
  'bool',
  'ClassName',
  'color',
  'DllName',
  'existing-override',
  'float-textbox',
  'folder-list',
  'FQN',
  'int-bool',
  'int-textbox',
  'lang-string',
  'MethodName',
  'node-dropdown',
  'node-list',
  'path',
  'point-textbox',
  'range-float',
  'range-int',
  'string',
  'string-dropdown',
  'sub_id',
  'vector2-textbox',
  'vector3-textbox',
  'vector4-textbox',
];

// Per-type boilerplate used by the "insert template" menu (the right-click
// action on the "todo add field here" placeholder). Every type in
// SCHEMA_TYPE_OPTIONS must have an entry so the menu stays in lockstep
// with the type dropdown. `label` is the visible menu text; `attrs` is
// the tail of the <attribute ...> tag after `key="..."`; `body` is the
// optional inner XML for types that need sub-elements (string-dropdown
// gets an empty <option/> starter).
//
// If you add a new type to SCHEMA_TYPE_OPTIONS, add an entry here too —
// otherwise the fallback produces a plain `type="..."` with no default
// or width hint, which is usable but less polished.
const SCHEMA_TYPE_TEMPLATES = {
  'bool':              { label: 'Bool',             attrs: 'type="bool" default="false"' },
  'int-bool':          { label: 'Int Bool',         attrs: 'type="int-bool" default="0"' },
  'int-textbox':       { label: 'Int',              attrs: 'type="int-textbox" default="0"' },
  'float-textbox':     { label: 'Float',            attrs: 'type="float-textbox" default="0"' },
  'range-int':         { label: 'Range Int',        attrs: 'type="range-int" default="0,0"' },
  'range-float':       { label: 'Range Float',      attrs: 'type="range-float" default="0,0"' },
  'point-textbox':     { label: 'Point',            attrs: 'type="point-textbox" default="0,0"' },
  'vector2-textbox':   { label: 'Vector2',          attrs: 'type="vector2-textbox" default="0,0"' },
  'vector3-textbox':   { label: 'Vector3',          attrs: 'type="vector3-textbox" default="0,0,0"' },
  'vector4-textbox':   { label: 'Vector4',          attrs: 'type="vector4-textbox" default="0,0,0,0"' },
  'color':             { label: 'Color',            attrs: 'type="color" default="#808080"' },
  'string':            { label: 'String',           attrs: 'type="string"' },
  'string-dropdown':   { label: 'String Dropdown',  attrs: 'type="string-dropdown"', body: '\n\t\t<option value=""/>\n\t' },
  'node-dropdown':     { label: 'FK Dropdown',      attrs: 'type="node-dropdown" node_source=""' },
  'node-list':         { label: 'FK List',          attrs: 'type="node-list" node_source=""' },
  'lang-string':       { label: 'Lang String',      attrs: 'type="lang-string"' },
  'path':              { label: 'Path',             attrs: 'type="path"' },
  'folder-list':       { label: 'Folder List',      attrs: 'type="folder-list"' },
  'FQN':               { label: 'FQN',              attrs: 'type="FQN"' },
  'ClassName':         { label: 'ClassName',        attrs: 'type="ClassName"' },
  'DllName':           { label: 'DllName',          attrs: 'type="DllName"' },
  'MethodName':        { label: 'MethodName',       attrs: 'type="MethodName"' },
  'sub_id':            { label: 'Sub ID',           attrs: 'type="sub_id"' },
  'existing-override': { label: 'Existing Override', attrs: 'type="existing-override"' },
};

// Menu ordering — groups types by concept so the list reads naturally
// rather than strictly alphabetical. Any type listed in SCHEMA_TYPE_OPTIONS
// but missing from this order falls through to the tail.
const SCHEMA_TYPE_MENU_ORDER = [
  'bool', 'int-bool',
  'int-textbox', 'float-textbox',
  'range-int', 'range-float',
  'point-textbox', 'vector2-textbox', 'vector3-textbox', 'vector4-textbox',
  'color',
  'string', 'string-dropdown',
  'node-dropdown', 'node-list',
  'lang-string',
  'path', 'folder-list',
  'FQN', 'ClassName', 'DllName', 'MethodName',
  'sub_id',
  'existing-override',
];

function buildSchemaTemplate(type, fieldName) {
  const t = SCHEMA_TYPE_TEMPLATES[type];
  const attrs = t?.attrs ?? `type="${type}"`;
  const body = t?.body ?? '';
  if (body) {
    return `<attribute key="${fieldName}" ${attrs}\n\t\ttooltip="">${body}</attribute>`;
  }
  return `<attribute key="${fieldName}" ${attrs}\n\t\ttooltip=""/>`;
}

function getOrderedTemplateItems(fieldName) {
  const seen = new Set();
  const items = [];
  for (const type of SCHEMA_TYPE_MENU_ORDER) {
    if (!SCHEMA_TYPE_OPTIONS.includes(type)) continue;
    seen.add(type);
    items.push({
      label: SCHEMA_TYPE_TEMPLATES[type]?.label ?? type,
      template: buildSchemaTemplate(type, fieldName),
    });
  }
  // Fallback: any type in SCHEMA_TYPE_OPTIONS missing from the ordering
  // (e.g. newly added without updating SCHEMA_TYPE_MENU_ORDER) lands at
  // the end rather than silently disappearing.
  for (const type of SCHEMA_TYPE_OPTIONS) {
    if (seen.has(type)) continue;
    items.push({
      label: SCHEMA_TYPE_TEMPLATES[type]?.label ?? type,
      template: buildSchemaTemplate(type, fieldName),
    });
  }
  return items;
}

export default function EditorPane({
  relativePath,
  content,
  savedContent,
  schema,
  sharedSchema,
  isSchema,
  onChange,
  theme,
  fkIndex,
  onNavigateToFK,
  onNavigateToMetadata,
  onAddUnknownSubNodeToSchema,
  scrollToLine,
  scrollHighlight,
  scrollToken,
  scrollAbsPos,
  onScrolled,
  editorViewRef,
  localSearchStateRef,
  selectionStateRef,
  editorScale,
  onEditorScaleChange,
  refPanelScale,
  onRefPanelScaleChange,
  spellchecker,
  fileLayer,
  fileExtraLayers,
  composedMergedSchema,
}) {
  const containerRef = useRef(null);
  const wrapperRef = useRef(null);
  const viewRef = useRef(null);
  const schemaRef = useRef(null);
  const restoreScrollTimersRef = useRef([]); // timers from cursor/scroll restore — cleared on navigation
  const navOverrideRef = useRef(false); // set when a scroll-to-line nav takes over, so the mount-time restore's uncancellable rAF doScroll bails instead of clobbering the navigation target
  const fkIndexRef = useRef(null);

  // Overlay state
  const [dropdown, setDropdown] = useState(null);
  const [schemaTemplateMenu, setSchemaTemplateMenu] = useState(null);
  const [refPanel, setRefPanel] = useState(null); // { scrollLine, height }
  const [refSearchQuery, setRefSearchQuery] = useState(null);
  const refPanelContainerRef = useRef(null);
  const [multiSelect, setMultiSelect] = useState(null);
  const [colorPicker, setColorPicker] = useState(null);
  const [nodeDelete, setNodeDelete] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [spellingMenu, setSpellingMenu] = useState(null);
  const spellcheckerRef = useRef(null);
  const lastDictAddRef = useRef(null); // { word, timeout } for undo support

  // Keep refs current
  // If App passed an explicit composed schema (base + mod extensions for the
  // active file's layer), use it. Otherwise fall back to building locally.
  // The local build is used for metadata-file edits and for the detached
  // window (which doesn't compute composed schemas).
  const mergedSchema = composedMergedSchema
    || (schema && sharedSchema ? buildMergedSchema(sharedSchema, schema) : schema);
  schemaRef.current = isSchema ? null : mergedSchema;
  fkIndexRef.current = fkIndex || {};
  spellcheckerRef.current = spellchecker || null;
  const sharedSchemaRef = useRef(null);
  sharedSchemaRef.current = sharedSchema;
  const relativePathRef = useRef(relativePath);
  relativePathRef.current = relativePath;
  const isSchemaRef = useRef(isSchema);
  isSchemaRef.current = isSchema;

  const fileLayerRef = useRef('base');
  fileLayerRef.current = fileLayer || 'base';
  const fileExtraLayersRef = useRef(null);
  fileExtraLayersRef.current = fileExtraLayers || null;

  const getSchema = useCallback(() => schemaRef.current, []);
  const getFKIndex = useCallback(() => fkIndexRef.current, []);
  const getFileLayer = useCallback(() => fileLayerRef.current, []);
  const getFileExtraLayers = useCallback(() => fileExtraLayersRef.current, []);
  const getSpellchecker = useCallback(() => spellcheckerRef.current, []);

  // Load file state from central registry (sync — always available immediately)
  const fileStateRef = useRef(null);
  const refPanelInitRef = useRef(false);
  useEffect(() => {
    refPanelInitRef.current = false;
    const state = window.arcenApi.getFileState(relativePath);
    fileStateRef.current = state;
    if (state?.refPanel?.open) {
      setRefPanel({ scrollLine: state.refPanel.scrollLine || 1, height: state.refPanel.height || 200 });
    }
    requestAnimationFrame(() => { refPanelInitRef.current = true; });
  }, [relativePath]);

  // Save reference panel state to central registry when it changes
  useEffect(() => {
    if (!refPanelInitRef.current) return;
    // Only send open + height (scrollLine is tracked by the ref panel's own scroll handler via nested merge)
    window.arcenApi.setFileState(relativePath, {
      refPanel: refPanel ? { open: true, height: refPanel.height } : null,
    });
  }, [refPanel, relativePath]);

  // Initialize CodeMirror
  useEffect(() => {
    if (!containerRef.current) return;
    // Fresh mount: clear any nav-override left from a prior mount of this
    // component instance, so the cursor/scroll restore below is allowed to run.
    navOverrideRef.current = false;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const newDoc = update.state.doc.toString();
        lastContentRef.current = newDoc;
        onChange(relativePath, newDoc);
      }
    });

    const callbacks = {
      openDropdown: (view, attr, options, x, y) => {
        setDropdown({ view, attr, options, x, y });
      },
      openMultiSelect: (view, attr, options, currentValues, x, y) => {
        setMultiSelect({ view, attr, options, currentValues, x, y });
      },
      openColorPicker: (view, attr, x, y) => {
        setColorPicker({ view, attr, x, y });
      },
      navigateToFK: (tableName, id) => {
        if (onNavigateToFK) onNavigateToFK(tableName, id);
      },
      navigateToMetadata: (attrName, parentTag) => {
        if (onNavigateToMetadata) onNavigateToMetadata(attrName, parentTag);
      },
      // Ctrl+click on a tag that ISN'T in the schema yet — let the host add
      // a sub_node declaration in the right schema/extension file (the host
      // knows about layers and extensions; clickHandler.js doesn't).
      addUnknownSubNodeToSchema: (tagName) => {
        if (onAddUnknownSubNodeToSchema) onAddUnknownSubNodeToSchema(tagName);
      },
      showTooltip: (text, x, y) => {
        setTooltip({ text, x, y });
      },
      dismissTooltip: () => setTooltip(null),
      openReferencePanel: (tagName, lineNumber) => {
        // Seed the scroll position in the registry immediately
        window.arcenApi.setFileState(relativePath, {
          refPanel: { scrollLine: lineNumber },
        });
        setRefPanel((prev) => {
          if (prev) {
            return { ...prev, scrollLine: lineNumber };
          }
          const containerHeight = containerRef.current?.parentElement?.offsetHeight || 500;
          return { scrollLine: lineNumber, height: Math.round(containerHeight * 0.4) };
        });
      },
    };

    const contextCallbacks = {
      showNodeDeleteDialog: (view, tagName, result, pos, x, y) => {
        setNodeDelete({ view, tagName, result, pos, x, y });
      },
      showSpellingMenu: (view, word, wordFrom, wordTo, x, y) => {
        // Mixed-script words get the ASCII homoglyph fix as their suggestion.
        // Forbidden chars (smart quotes, em-dashes, ellipsis…) get their ASCII
        // replacement. Normal misspellings get nspell suggestions.
        let suggestions = [];
        let isMixedScript = false;
        let isForbiddenChar = false;
        const forbiddenFix = word.length === 1 ? getForbiddenCharFix(word) : null;
        if (forbiddenFix) {
          isForbiddenChar = true;
          suggestions = [forbiddenFix];
        } else if (classifyWordScript(word) === 'mixed') {
          isMixedScript = true;
          const ascii = asciifyHomoglyphs(word);
          if (ascii && ascii !== word) suggestions = [ascii];
        } else {
          const checker = spellcheckerRef.current;
          suggestions = checker ? checker.suggest(word).slice(0, 5) : [];
        }

        // Determine whether this word is in a developer-facing context so the menu
        // can offer "Add to Dev Dictionary" instead of / in addition to the regular one.
        let isDevContext = false;
        try {
          if (isSchema) {
            // Metadata tooltips are always dev-facing
            isDevContext = true;
          } else {
            const schema = schemaRef.current;
            if (schema) {
              const doc = view.state.doc.toString();
              const tokens = tokenize(doc);
              const attrMap = buildAttrMap(tokens, schema);
              const devRanges = buildNodeFlagRanges(tokens, doc, 'skip_all_localization_on_node');
              for (const attr of attrMap) {
                if (wordFrom >= attr.vs && wordFrom <= attr.ve) {
                  isDevContext = isDevNotesAttr(attr.nm)
                    || isInferredDevContext(attr)
                    || isInRange(devRanges, attr.vs);
                  break;
                }
              }
            }
          }
        } catch (_) {}

        setSpellingMenu({ view, word, wordFrom, wordTo, suggestions, x, y, isMixedScript, isDevContext, isForbiddenChar });
      },
    };

    // Sync search query to reference panel whenever it changes in the main editor
    const searchSyncListener = EditorView.updateListener.of((update) => {
      try {
        const sq = getSearchQuery(update.state);
        setRefSearchQuery(sq ? {
          search: sq.search || '',
          caseSensitive: sq.caseSensitive,
          regexp: sq.regexp,
          replace: sq.replace || '',
        } : null);
      } catch (_) {}

      // Restyle main next/prev buttons and inject Ref ▼ / Ref ▲ buttons
      requestAnimationFrame(() => {
        const editor = update.view.dom.closest('.cm-editor');
        const panel = editor?.querySelector('.cm-search');
        if (!panel || panel.querySelector('.ref-panel-nav')) return;
        // Restyle main prev/next to arrows and find insertion point
        const allBtns = panel.querySelectorAll('button');
        let lastNavBtn = null;
        for (const b of allBtns) {
          const t = b.textContent.trim().toLowerCase();
          if (t === 'next') { b.textContent = '▼'; b.title = 'Next match'; lastNavBtn = b; }
          if (t === 'previous') { b.textContent = '▲'; b.title = 'Previous match'; lastNavBtn = b; }
        }
        // Insert Ref buttons after the last of the prev/next pair
        const anchor = lastNavBtn?.nextSibling;
        const parent = lastNavBtn?.parentNode;
        if (!parent) return;
        const makeBtn = (label, dir) => {
          const btn = document.createElement('button');
          btn.className = 'ref-panel-nav';
          btn.textContent = label;
          btn.title = dir === 'prev'
            ? 'Previous match in reference panel'
            : 'Next match in reference panel';
          btn.style.cssText = 'margin-left: 2px; font-size: 11px; padding: 3px 6px; border-radius: 3px; cursor: pointer;';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            const nav = refPanelContainerRef.current?._refPanelNav;
            if (nav) dir === 'prev' ? nav.prev() : nav.next();
          });
          return btn;
        };
        parent.insertBefore(makeBtn('Ref ▼', 'next'), anchor);
        parent.insertBefore(makeBtn('Ref ▲', 'prev'), anchor);
      });
    });

    const extensions = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      xml(),
      syntaxHighlighting(createArcenHighlighter(theme)),
      search({ top: true }),
      createSearchScrollMarkers(),
      ...createInSelectionExtension(),
      keymap.of([
        { key: 'Mod-h', run: (view) => {
          openSearchPanel(view);
          // Move focus to the replace (2nd) input. CodeMirror's
          // openSearchPanel applies its state effect synchronously, so the
          // panel DOM is usually present by the time we look for it on the
          // same tick — try sync first to avoid the fixed-timeout gap that
          // let user keystrokes leak into the editor. Fall back to rAF if
          // the panel hasn't materialized yet (rare).
          const focusReplace = () => {
            const panel = view.dom.closest('.cm-editor')?.querySelector('.cm-search');
            if (!panel) return false;
            const inputs = panel.querySelectorAll('input[type="text"], input:not([type])');
            if (inputs.length < 2) return false;
            inputs[1].select();
            inputs[1].focus();
            return true;
          };
          if (!focusReplace()) requestAnimationFrame(focusReplace);
          return true;
        }, scope: 'editor search-panel' },
        ...createArcenKeymap(),
        { key: 'F2', run: (view) => {
          if (isSchemaRef.current) return false;
          const curSchema = schemaRef.current;
          const curSharedSchema = sharedSchemaRef.current;
          if (!curSchema || !curSharedSchema) return false;
          const idKey = getCentralIdentifierKey(curSharedSchema);
          const pos = view.state.selection.main.head;
          const docText = view.state.doc.toString();
          const attrs = buildAttrMap(tokenize(docText), curSchema);
          const attr = attrs.find(a => a.nm === idKey && a.vs != null && pos >= a.vs && pos <= a.ve);
          if (!attr) return false;
          document.dispatchEvent(new CustomEvent('idRenameRequested', {
            detail: { oldId: attr.v, relativePath: relativePathRef.current },
          }));
          return true;
        }},
        ...inSelectionKeymap,
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      createArcenInputHandlers(),
      searchSyncListener,
      updateListener,
      ...createChangeGutter(),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': {
          overflow: 'auto',
          fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace",
          fontSize: (13 * (editorScale || 100) / 100) + 'px',
        },
        '.cm-content': { padding: '4px 0' },
        '.cm-line': { padding: '0 8px' },
        '.cm-changeGutter': { width: '4px' },
        // position: relative lets the two-layer markers (yellow unsaved,
        // orange VCS-modified) stack via position: absolute inside.
        '.cm-changeGutter .cm-gutterElement': { padding: '0', position: 'relative' },
        '.cm-dimmed-attr, .cm-dimmed-attr *': { color: '#999999 !important' },
        '.cm-bool-false, .cm-bool-false *': { color: (theme === 'dark' ? '#487ca8' : '#5757d6') + ' !important' },
        '.cm-header-attr-name, .cm-header-attr-name *': { color: (theme === 'dark' ? '#ff5c8a' : '#ff0054') + ' !important', fontWeight: 'bold !important' },
        '.cm-header-attr-value, .cm-header-attr-value *': { color: (theme === 'dark' ? '#f0b0ff' : '#5e00ff') + ' !important', fontWeight: 'bold !important' },
        '.cm-subnode-tag, .cm-subnode-tag *': { color: (theme === 'dark' ? '#b57cff' : '#923aff') + ' !important', fontWeight: 'bold !important' },
        // Local search panel styling
        '.cm-panel.cm-search': { fontSize: '12px', padding: '4px 6px' },
        '.cm-panel.cm-search input': { fontSize: '12px !important', padding: '4px 8px !important', minHeight: '24px', boxSizing: 'border-box' },
        '.cm-panel.cm-search button': { fontSize: '11px', padding: '3px 8px', borderRadius: '3px' },
        '.cm-panel.cm-search label': { fontSize: '11px' },
        // Close button — same dark button style, larger
        '.cm-panel.cm-search button[name="close"]': { fontSize: '16px', width: '28px', height: '28px', lineHeight: '26px', padding: '0', cursor: 'pointer', fontWeight: 'bold', background: 'var(--tab-bg)', color: '#fff', borderRadius: '3px' },
      }),
    ];

    // Schema-aware features only for XML files
    if (!isSchema) {
      extensions.push(
        createSchemaDecorations(getSchema, theme),
        createArcenAutocomplete(getSchema, (view, def, valuePos) => {
          // FK attr completed — open dropdown (filtered to layers this file
          // is allowed to reference, including mod-deps for mod files).
          // Honor the per-field opt-out: `can_make_invalid_cross_links="true"`
          // surfaces every layer's IDs to the completion popup, matching
          // the click-handler's dropdown and the validator's leniency.
          if (def.node_source) {
            const unrestricted = def.can_make_invalid_cross_links === 'true';
            const options = getFKOptionsForLayer(
              fkIndexRef.current, def.node_source, fileLayerRef.current, fileExtraLayersRef.current, unrestricted
            );
            if (options.length > 0) {
              const coords = view.coordsAtPos(valuePos);
              if (coords) {
                if (def.type === 'node-list') {
                  setMultiSelect({
                    view, attr: { vs: valuePos, ve: valuePos, v: '', src: def.node_source },
                    options, currentValues: [], x: coords.left, y: coords.bottom,
                  });
                } else {
                  setDropdown({
                    view, attr: { vs: valuePos, ve: valuePos, v: '', src: def.node_source },
                    options, x: coords.left, y: coords.bottom,
                  });
                }
              }
            }
          }
        }),
        createClickHandler(getSchema, getFKIndex, callbacks, getFileLayer, getFileExtraLayers),
        createContextMenu(getSchema, contextCallbacks),
        createSpellcheckDecorations(getSchema, getSpellchecker, false),
      );
    } else {
      // Schema files: metadata-specific decorations + node_source click handling
      let schemaClickTimer = null;
      extensions.push(
        createMetadataDecorations(theme),
        EditorView.domEventHandlers({
          keydown() {
            if (schemaClickTimer) { clearTimeout(schemaClickTimer); schemaClickTimer = null; }
            return false;
          },
          contextmenu(event, view) {
            event.preventDefault();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return true;

            // Check for spelling error at click position
            const spellingHit = findSpellingErrorAtPos(view, pos, event);
            if (spellingHit) {
              const checker = spellcheckerRef.current;
              const suggestions = checker ? checker.suggest(spellingHit.word).slice(0, 5) : [];
              // Metadata/schema files are always dev context
              setSpellingMenu({
                view, word: spellingHit.word,
                wordFrom: spellingHit.from, wordTo: spellingHit.to,
                suggestions, x: event.clientX, y: event.clientY,
                isDevContext: true,
              });
              return true;
            }

            const doc = view.state.doc.toString();
            const line = view.state.doc.lineAt(pos);
            const lineText = line.text;
            // Check if this line contains a FIELD_NEEDED comment
            const fnMatch = lineText.match(/<!--FIELD_NEEDED:\s*(\S+)\s*-->/);
            if (fnMatch) {
              const fieldName = fnMatch[1];
              setSchemaTemplateMenu({
                x: event.clientX, y: event.clientY,
                fieldName, lineFrom: line.from, lineTo: line.to, doc,
              });
            }
            return true;
          },
          click(event, view) {
            // Any click cancels a pending delayed-dropdown-open (see clickHandler.js).
            if (schemaClickTimer) { clearTimeout(schemaClickTimer); schemaClickTimer = null; }
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const doc = view.state.doc.toString();
            const tokens = tokenize(doc);

            // Check for click on a `type` attribute value → show dropdown of valid types
            for (let i = 0; i < tokens.length; i++) {
              if (tokens[i].c !== 'an' || tokens[i].s !== 'type') continue;
              let vt = null;
              for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
                if (tokens[j].c === 'av') { vt = tokens[j]; break; }
              }
              if (!vt || pos < vt.p || pos > vt.p + vt.s.length) continue;
              // Double-click → let CM6 handle word selection
              if (event.detail >= 2) return false;
              if (schemaClickTimer) clearTimeout(schemaClickTimer);
              const cx = event.clientX, cy = event.clientY;
              const vp = vt.p, vs = vt.s;
              schemaClickTimer = setTimeout(() => {
                schemaClickTimer = null;
                const sel = view.state.selection.main;
                if (sel.from !== sel.to) return; // user is selecting text
                setDropdown({
                  view,
                  attr: { vs: vp, ve: vp + vs.length, v: vs, src: null, nm: 'type' },
                  options: SCHEMA_TYPE_OPTIONS,
                  x: cx,
                  y: cy,
                });
              }, 250);
              return false;
            }

            // Find if we clicked on a node_source value
            for (let i = 0; i < tokens.length; i++) {
              if (tokens[i].c !== 'an' || tokens[i].s !== 'node_source') continue;
              // Find the value token
              let vt = null;
              for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
                if (tokens[j].c === 'av') { vt = tokens[j]; break; }
              }
              if (!vt || pos < vt.p || pos > vt.p + vt.s.length) continue;

              // Ctrl+click navigates to the target table's metadata
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                if (onNavigateToFK) onNavigateToFK(vt.s, '');
                return true;
              }

              // Double-click → let CM6 handle word selection
              if (event.detail >= 2) return false;
              if (schemaClickTimer) clearTimeout(schemaClickTimer);
              const cx = event.clientX, cy = event.clientY;
              const vp = vt.p, vs = vt.s;
              schemaClickTimer = setTimeout(() => {
                schemaClickTimer = null;
                const sel = view.state.selection.main;
                if (sel.from !== sel.to) return; // user is selecting text
                const fkIdx = getFKIndex();
                const tableNames = Object.keys(fkIdx).filter(k => !k.match(/^\d+_/)).sort(naturalCompare);
                setDropdown({
                  view,
                  attr: { vs: vp, ve: vp + vs.length, v: vs, src: null, nm: 'node_source' },
                  options: tableNames,
                  x: cx,
                  y: cy,
                });
              }, 250);
              return false;
            }
            // Ctrl+click on tag name — open reference panel
            if (event.ctrlKey || event.metaKey) {
              for (const tk of tokens) {
                if (tk.c === 'tg' && pos >= tk.p && pos < tk.p + tk.s.length) {
                  event.preventDefault();
                  const linesBefore = doc.slice(0, tk.p).split('\n');
                  setRefPanel((prev) => {
                    if (prev) return { ...prev, scrollLine: linesBefore.length };
                    const containerHeight = containerRef.current?.parentElement?.offsetHeight || 500;
                    return { scrollLine: linesBefore.length, height: Math.round(containerHeight * 0.4) };
                  });
                  return true;
                }
              }
              // Ctrl+click on key or id value — open reference panel
              for (let i = 0; i < tokens.length; i++) {
                if (tokens[i].c !== 'an' || (tokens[i].s !== 'key' && tokens[i].s !== 'id')) continue;
                let vt = null;
                for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
                  if (tokens[j].c === 'av') { vt = tokens[j]; break; }
                }
                if (!vt || pos < vt.p || pos > vt.p + vt.s.length) continue;
                event.preventDefault();
                const linesBefore = doc.slice(0, vt.p).split('\n');
                setRefPanel((prev) => {
                  if (prev) return { ...prev, scrollLine: linesBefore.length };
                  const containerHeight = containerRef.current?.parentElement?.offsetHeight || 500;
                  return { scrollLine: linesBefore.length, height: Math.round(containerHeight * 0.4) };
                });
                return true;
              }
            }
            return false;
          },
        }),
        createSpellcheckDecorations(getSchema, getSpellchecker, true),
      );
    }

    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: containerRef.current });

    // Set initial saved content for gutter
    view.dispatch({ effects: setSavedContent.of(savedContent) });

    viewRef.current = view;
    if (editorViewRef) editorViewRef.current = view;

    // Force CM6 to remeasure after layout settles (fixes blank editor on startup)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        view.requestMeasure();
      });
    });

    // Track scroll position continuously via DOM scroll events
    // so we always have a valid line number even when the view is being destroyed
    const lastScrollLineRef = { current: 1 };
    let scrollSaveTimer = null;
    const scrollHandler = () => {
      try {
        // Add small offset to avoid boundary rounding (gets the line actually visible at top)
        const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 1).from;
        lastScrollLineRef.current = view.state.doc.lineAt(topPos).number;
      } catch (_) {}
      // Debounced update to central registry (keeps it current for on-close save)
      if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        window.arcenApi.setFileState(relativePath, {
          cursor: view.state.selection.main.head,
          scrollLine: lastScrollLineRef.current,
        });
      }, 500);
    };
    view.scrollDOM.addEventListener('scroll', scrollHandler, { passive: true });

    // Restore cursor/scroll from in-memory selection state or central file state registry.
    // We use deferred scrolls at t=rAF, t=100ms, t=300ms because CM6 measurement can
    // take a bit to settle. If a scroll-to-line navigation happens in the meantime
    // (e.g. user clicked a validation entry that switched tabs), those deferred
    // restore-scrolls would OVERRIDE the navigation. Track the timer IDs so the
    // scroll useEffect can cancel them when navigation takes over.
    const selState = selectionStateRef?.current?.[relativePath];
    const restoreCursorAndScroll = (curState) => {
      try {
        if (selState && selState.anchor != null && selState.head != null
            && selState.anchor <= view.state.doc.length && selState.head <= view.state.doc.length) {
          view.dispatch({ selection: EditorSelection.single(selState.anchor, selState.head) });
        } else if (curState?.cursor != null && curState.cursor <= view.state.doc.length) {
          view.dispatch({ selection: { anchor: curState.cursor } });
        }
        const scrollLine = curState?.scrollLine;
        if (scrollLine != null) {
          lastScrollLineRef.current = scrollLine;
          const doScroll = () => {
            // A scroll-to-line navigation (validation / search / FK / metadata
            // jump) may have taken over after this restore was scheduled. The
            // 100/300ms timers are cancelled by the scrollToLine effect, but the
            // rAF chain above is not — so guard here to avoid scrolling back to
            // the saved position and clobbering the navigation target.
            if (navOverrideRef.current) return;
            try {
              const ln = Math.min(scrollLine, view.state.doc.lines);
              const line = view.state.doc.line(ln);
              const block = view.lineBlockAt(line.from);
              view.scrollDOM.scrollTop = block.top;
            } catch (_) {}
          };
          requestAnimationFrame(() => { view.requestMeasure(); requestAnimationFrame(doScroll); });
          restoreScrollTimersRef.current.push(setTimeout(doScroll, 100));
          restoreScrollTimersRef.current.push(setTimeout(doScroll, 300));
        }
      } catch (_) {}
    };
    // fileStateRef.current is always populated (sync load in mount effect)
    restoreCursorAndScroll(fileStateRef.current);

    // Focus the editor so the cursor is visible and keyboard works immediately
    requestAnimationFrame(() => view.focus());

    // Restore search state from previous tab if available
    if (localSearchStateRef?.current) {
      const sq = localSearchStateRef.current;
      try {
        view.dispatch({ effects: setSearchQuery.of(new SearchQuery(sq)) });
        if (sq.wasOpen) {
          openSearchPanel(view);
        }
      } catch (_) {}
    }

    // Listen for swatch-click custom events from color swatch widgets
    const swatchHandler = (e) => {
      const { pos, x, y } = e.detail;
      const doc = view.state.doc.toString();
      const tokens = tokenize(doc);
      const schema = getSchema();
      if (!schema) return;
      const attrMap = buildAttrMap(tokens, schema);
      for (const attr of attrMap) {
        if (attr.vs === pos) {
          setColorPicker({ view, attr, x, y });
          return;
        }
      }
    };
    containerRef.current.addEventListener('swatch-click', swatchHandler);

    return () => {
      // Save cursor and scroll position to central registry before destroying.
      // lastScrollLineRef is kept continuously current — updated synchronously
      // by the scroll handler and seeded to the restored line on mount — so it
      // is the authoritative value here. We only attempt a fresh read from the
      // live DOM when scrollDOM is STILL CONNECTED.
      //
      // On a key-change unmount (switching tabs), this useEffect cleanup runs
      // in React's passive phase, AFTER the mutation phase has already detached
      // the editor's DOM. A detached element reports scrollTop === 0, so the
      // fresh read would resolve to line 1 and clobber the real position —
      // losing scroll on every tab switch, back/forward nav, and session
      // reopen. The isConnected guard skips the fresh read in that case and
      // falls back to lastScrollLineRef. For a same-instance re-run (theme /
      // editorScale toggle) the container stays connected and the fresh read
      // is accurate.
      if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
      const cursor = view.state.selection.main.head;
      let scrollLine = lastScrollLineRef.current;
      if (view.scrollDOM.isConnected) {
        try {
          const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 1).from;
          scrollLine = view.state.doc.lineAt(topPos).number;
        } catch (_) {}
      }
      window.arcenApi.setFileState(relativePath, { cursor, scrollLine });
      // Mirror into fileStateRef so a remount that keeps the same
      // relativePath (theme / editorScale toggles) restores from the
      // latest position. The fileStateRef load effect only re-runs on
      // relativePath change, so without this the restore would use a
      // snapshot from when the file was first opened.
      fileStateRef.current = { ...(fileStateRef.current || {}), cursor, scrollLine };
      view.scrollDOM.removeEventListener('scroll', scrollHandler);
      // Save search state before destroying
      if (localSearchStateRef) {
        try {
          const sq = getSearchQuery(view.state);
          const panelOpen = !!view.dom.closest('.cm-editor')?.querySelector('.cm-search');
          localSearchStateRef.current = {
            search: sq.search || '',
            replace: sq.replace || '',
            caseSensitive: sq.caseSensitive,
            regexp: sq.regexp,
            wholeWord: sq.wholeWord,
            wasOpen: panelOpen,
          };
        } catch (_) {}
      }
      containerRef.current?.removeEventListener('swatch-click', swatchHandler);
      view.destroy();
      viewRef.current = null;
      if (editorViewRef) editorViewRef.current = null;
    };
  }, [relativePath, isSchema, theme, editorScale]);

  // Update saved content in gutter when it changes externally
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.dispatch({ effects: setSavedContent.of(savedContent) });
    }
  }, [savedContent]);

  // Fetch and keep the VCS base (HEAD/BASE) content for this file in sync
  // with the source-control gutter layer. We refetch on:
  //   - file mount (initial load)
  //   - vcs-status-changed broadcast (commit/revert/pull changed what's
  //     considered the base)
  //   - saves of this file (status just flipped — triggered via
  //     vcs-status-changed from refreshFile on the main side).
  //
  // A per-mount generation counter guards against stale responses: if
  // the file changes or the effect re-runs before the IPC resolves, the
  // old response is discarded.
  useEffect(() => {
    if (!window.arcenApi?.scGetBaseContent) return;
    let cancelled = false;
    let gen = 0;
    const fetch = async () => {
      const myGen = ++gen;
      try {
        const content = await window.arcenApi.scGetBaseContent(relativePath);
        if (cancelled || myGen !== gen) return;
        if (viewRef.current) {
          viewRef.current.dispatch({ effects: setVcsBaseContent.of(content) });
        }
      } catch (_) { /* null already dispatched below on error */ }
    };
    fetch();
    if (window.arcenApi.onVcsStatusChanged) {
      // No unsub API on the preload surface. The listener registration
      // accumulates across mounts (each tab switch adds one), so guard
      // the handler itself to short-circuit when this mount is cancelled
      // — otherwise every VCS status event would fan out into a fresh
      // sc-get-base-content IPC per stale instance.
      window.arcenApi.onVcsStatusChanged(() => {
        if (cancelled) return;
        fetch();
      });
    }
    return () => { cancelled = true; };
  }, [relativePath]);

  // Sync CodeMirror doc when content changes externally (e.g., revert, file reload,
  // bulk replace). Without explicit selection + scroll preservation, a from=0/to=docLen
  // dispatch maps the cursor to the end of the inserted text and the viewport jumps
  // to the top of the file — that's what bulk "Replace all X with Y across all files"
  // used to do, even though a single-instance replace happened to feel right.
  const lastContentRef = useRef(content);
  useEffect(() => {
    if (viewRef.current && content !== lastContentRef.current) {
      const view = viewRef.current;
      const currentDoc = view.state.doc.toString();
      if (content !== currentDoc) {
        const cursor = view.state.selection.main.head;
        const scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: content },
          selection: { anchor: Math.min(cursor, content.length) },
          scrollIntoView: false,
        });
        // Re-pin scrollTop on the next frame: CM6 may have already adjusted
        // it in response to the change. Setting it directly after the
        // measure-and-paint cycle restores the original viewport.
        requestAnimationFrame(() => {
          if (viewRef.current === view) view.scrollDOM.scrollTop = scrollTop;
        });
      }
      lastContentRef.current = content;
    }
  }, [content]);


  // Scroll to line when requested (FK navigation, validation click)
  useEffect(() => {
    if (scrollToLine != null && viewRef.current) {
      const view = viewRef.current;
      // Cancel any pending cursor/scroll restore timers so they don't override
      // this navigation at t=100ms / t=300ms after the mount, and set the
      // override flag so the restore's uncancellable rAF doScroll bails too.
      navOverrideRef.current = true;
      for (const t of restoreScrollTimersRef.current) clearTimeout(t);
      restoreScrollTimersRef.current = [];

      const lineNum = Math.min(scrollToLine, view.state.doc.lines);
      const line = view.state.doc.line(lineNum);

      let targetPos = line.from;
      // Prefer an exact absolute position if the caller provided one (e.g. the
      // validation entry knows the precise column). This avoids the common bug
      // where a word appears in multiple places on a line (id=, display_name=)
      // and indexOf would find the first match instead of the flagged one.
      if (scrollAbsPos != null && scrollAbsPos >= 0 && scrollAbsPos <= view.state.doc.length) {
        targetPos = scrollAbsPos;
      } else if (scrollHighlight) {
        const lineText = line.text;
        const hlIdx = lineText.indexOf(scrollHighlight);
        if (hlIdx >= 0) {
          targetPos = line.from + hlIdx;
        }
      }

      // Ensure CM6 has measured, then scroll and highlight
      view.requestMeasure();
      requestAnimationFrame(() => {
        view.dispatch({
          selection: { anchor: targetPos },
          effects: EditorView.scrollIntoView(targetPos, { y: 'center', x: 'center' }),
        });
        view.focus();

      // Flash highlight after scroll completes
      requestAnimationFrame(() => {
        const lineEl = view.domAtPos(line.from)?.node;
        const cmLine = lineEl?.closest?.('.cm-line') || lineEl?.parentElement?.closest?.('.cm-line');

        if (scrollHighlight && targetPos !== line.from) {
          // Two-tier highlight: light line background + heavy text overlay
          if (cmLine) {
            cmLine.style.transition = 'none';
            cmLine.style.background = '#fff3cd';
          }

          // Create an overlay div positioned over the text range using CM6 coords
          const hlFrom = targetPos;
          const hlTo = targetPos + scrollHighlight.length;
          const startCoords = view.coordsAtPos(hlFrom);
          const endCoords = view.coordsAtPos(hlTo);

          if (startCoords && endCoords) {
            // Place the overlay INSIDE scrollDOM so it scrolls with content.
            // Coordinate math: overlay is positioned in scrollDOM's content coordinate
            // system (which includes scroll offset). Given viewport coords from
            // coordsAtPos, the content-space position is:
            //   (viewport - scrollRect.viewport) + scroll offset
            // This stays correct as the user scrolls afterward, and is correct
            // regardless of how far the editor was scrolled to bring the text into view.
            const scrollRect = view.scrollDOM.getBoundingClientRect();
            const overlay = document.createElement('div');
            overlay.style.cssText = `
              position: absolute;
              top: ${startCoords.top - scrollRect.top + view.scrollDOM.scrollTop}px;
              left: ${startCoords.left - scrollRect.left + view.scrollDOM.scrollLeft}px;
              width: ${endCoords.right - startCoords.left}px;
              height: ${startCoords.bottom - startCoords.top}px;
              background: rgba(255, 224, 102, 0.3);
              outline: 2px solid rgba(212, 160, 23, 0.5);
              outline-offset: -1px;
              border-radius: 2px;
              pointer-events: none;
              z-index: 10;
              transition: opacity 0.8s;
            `;
            view.scrollDOM.style.position = 'relative';
            view.scrollDOM.appendChild(overlay);

            setTimeout(() => {
              overlay.style.opacity = '0';
              if (cmLine) {
                cmLine.style.transition = 'background 0.8s';
                cmLine.style.background = '';
              }
              setTimeout(() => {
                overlay.remove();
                if (cmLine) cmLine.style.transition = '';
              }, 1000);
            }, 3000);
          } else if (cmLine) {
            // Coords not available — fall back to full line highlight
            cmLine.style.background = '#ffe066';
            cmLine.style.outline = '2px solid #d4a017';
            setTimeout(() => {
              cmLine.style.transition = 'background 0.8s, outline 0.8s';
              cmLine.style.background = '';
              cmLine.style.outline = '';
              setTimeout(() => { cmLine.style.transition = ''; }, 1000);
            }, 3000);
          }
        } else if (cmLine) {
          // No specific text — full line highlight
          cmLine.style.transition = 'none';
          cmLine.style.background = '#ffe066';
          cmLine.style.outline = '2px solid #d4a017';
          cmLine.style.outlineOffset = '-1px';
          cmLine.style.borderRadius = '2px';
          setTimeout(() => {
            cmLine.style.transition = 'background 0.8s, outline 0.8s';
            cmLine.style.background = '';
            cmLine.style.outline = '';
            cmLine.style.outlineOffset = '';
            cmLine.style.borderRadius = '';
            setTimeout(() => { cmLine.style.transition = ''; }, 1000);
          }, 3000);
        }
      }); }); // end highlight rAF, scroll rAF

      if (onScrolled) onScrolled();
    }
  }, [scrollToLine, scrollHighlight, scrollToken, scrollAbsPos]);

  // ── Dropdown select handler ──
  const handleDropdownSelect = useCallback((value) => {
    if (!dropdown) return;
    const { view, attr } = dropdown;
    view.dispatch({
      changes: { from: attr.vs, to: attr.ve, insert: value },
      selection: { anchor: attr.vs + value.length },
    });
    view.focus();
    setDropdown(null);
    // Trigger onChange
    onChange(relativePath, view.state.doc.toString());
  }, [dropdown, relativePath, onChange]);

  // ── Multi-select toggle handler ──
  const handleMultiToggle = useCallback((value) => {
    if (!multiSelect) return;
    const { view, attr } = multiSelect;
    const current = attr.v ? attr.v.split(',').filter(Boolean) : [];
    const set = new Set(current);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    const newVal = [...set].join(',');

    view.dispatch({
      changes: { from: attr.vs, to: attr.ve, insert: newVal },
    });

    // Update multiSelect state with new value/positions
    setMultiSelect((prev) => ({
      ...prev,
      attr: { ...attr, v: newVal, ve: attr.vs + newVal.length },
      currentValues: [...set],
    }));

    onChange(relativePath, view.state.doc.toString());
  }, [multiSelect, relativePath, onChange]);

  // ── Color picker handler ──
  const handleColorInput = useCallback((e) => {
    if (!colorPicker) return;
    const rawHex = e.target.value.slice(1).toUpperCase();
    const { view, attr } = colorPicker;
    // Preserve # prefix if the original value had one
    const newVal = attr.v.startsWith('#') ? '#' + rawHex : rawHex;
    view.dispatch({
      changes: { from: attr.vs, to: attr.ve, insert: newVal },
    });
    onChange(relativePath, view.state.doc.toString());
  }, [colorPicker, relativePath, onChange]);

  // ── Node delete confirm ──
  const handleNodeDelete = useCallback(() => {
    if (!nodeDelete) return;
    const { view, result, pos } = nodeDelete;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result },
      selection: { anchor: Math.min(pos, result.length) },
    });
    setNodeDelete(null);
    onChange(relativePath, view.state.doc.toString());
  }, [nodeDelete, relativePath, onChange]);

  const [scaleInput, setScaleInput] = useState(null); // null = not editing, string = editing value

  return (
    <>
      {/* Visual-Studio-style ↑/↓ history dropdown for the local search panel.
          Renders nothing visible until CodeMirror's panel mounts and the user
          presses ↑/↓ in one of its inputs. We pass wrapperRef (not viewRef)
          because viewRef is populated in a later effect — wrapperRef is set
          during React's commit, so it's available when our child effect runs. */}
      <LocalSearchHistory containerRef={wrapperRef} />
      <div ref={wrapperRef} style={{ height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}
        onKeyDown={async (e) => {
          // Ctrl+Z with a pending dictionary addition → undo it
          if ((e.ctrlKey || e.metaKey) && e.key === 'z' && lastDictAddRef.current) {
            e.preventDefault();
            e.stopPropagation();
            const { word, timeout } = lastDictAddRef.current;
            clearTimeout(timeout);
            lastDictAddRef.current = null;

            // Remove from live spellchecker
            const checker = spellcheckerRef.current;
            if (checker) checker.remove(word);

            // Remove from disk
            await window.arcenApi.removeFromDictionary(word);

            // Force decoration rebuild
            const view = viewRef.current;
            if (view) {
              const pos = view.state.doc.length;
              view.dispatch({ changes: { from: pos, insert: ' ' } });
              view.dispatch({ changes: { from: pos, to: pos + 1 } });
            }
          }
        }}
      >
        {/* Reference Panel — above main editor */}
        {refPanel && (
          <>
            <ReferencePanel
              ref={refPanelContainerRef}
              relativePath={relativePath}
              content={content}
              theme={theme}
              schema={schema}
              sharedSchema={sharedSchema}
              isSchema={isSchema}
              fkIndex={fkIndex}
              scrollToLine={refPanel.scrollLine}
              height={refPanel.height}
              refPanelScale={refPanelScale}
              onRefPanelScaleChange={onRefPanelScaleChange}
              searchQuery={refSearchQuery}
              editorViewRef={viewRef}
              onClose={() => setRefPanel(null)}
            />
            {/* Resize handle between reference panel and main editor */}
            <div
              style={{ height: 0, position: 'relative', flexShrink: 0 }}
            >
              <div
                style={{
                  // Sit entirely below the reference-panel/editor boundary so the
                  // reference panel's 10px horizontal scrollbar above stays fully
                  // grabbable (mirror of the global-search handle fix in App.jsx).
                  position: 'absolute', top: 0, left: 0, right: 0, height: 10,
                  cursor: 'row-resize', zIndex: 20,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = refPanel.height;
                  const onMove = (ev) => {
                    const newH = Math.max(60, Math.min(window.innerHeight * 0.7, startH + (ev.clientY - startY)));
                    setRefPanel((prev) => prev ? { ...prev, height: newH } : null);
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
          </>
        )}
        <div ref={containerRef} style={{ flex: 1, overflow: 'hidden' }} onClick={() => setTooltip(null)} />
        {/* Scale indicator — bottom-left corner over the gutter */}
        <div
          style={{
            position: 'absolute', bottom: 14, left: 2, zIndex: 15,
            fontSize: 10, color: '#fff', background: 'var(--tab-bg)',
            border: '1px solid var(--tab-bar-bg)', borderRadius: 3,
            padding: '2px 5px', cursor: 'pointer', userSelect: 'none',
            minWidth: 34, textAlign: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
          onClick={() => setScaleInput(String(editorScale || 100))}
          title="Click to change editor text scale"
        >
          {scaleInput !== null ? (
            <input
              type="text"
              value={scaleInput}
              onChange={(e) => setScaleInput(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = Math.max(70, Math.min(200, parseInt(scaleInput, 10) || 100));
                  if (onEditorScaleChange) onEditorScaleChange(val);
                  setScaleInput(null);
                }
                if (e.key === 'Escape') setScaleInput(null);
              }}
              onBlur={() => {
                const val = Math.max(70, Math.min(200, parseInt(scaleInput, 10) || 100));
                if (onEditorScaleChange) onEditorScaleChange(val);
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
            <span>{editorScale || 100}%</span>
          )}
        </div>
      </div>

      {/* FK Dropdown */}
      {dropdown && (
        <FKDropdown
          options={dropdown.options}
          value={dropdown.attr.v}
          x={dropdown.x}
          y={dropdown.y}
          onSelect={handleDropdownSelect}
          onNavigate={(id) => { if (onNavigateToFK && dropdown.attr.src) onNavigateToFK(dropdown.attr.src, id); }}
          onClose={() => { setDropdown(null); viewRef.current?.focus(); }}
        />
      )}

      {/* FK Multi-select */}
      {multiSelect && (
        <FKMultiSelect
          options={multiSelect.options}
          currentValues={multiSelect.currentValues}
          x={multiSelect.x}
          y={multiSelect.y}
          onToggle={handleMultiToggle}
          onNavigate={(id) => { if (onNavigateToFK && multiSelect.attr.src) onNavigateToFK(multiSelect.attr.src, id); }}
          onClose={() => { setMultiSelect(null); viewRef.current?.focus(); }}
        />
      )}

      {/* Color picker */}
      {colorPicker && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }}
          onClick={() => setColorPicker(null)}
        >
          <div
            style={{
              position: 'fixed', top: colorPicker.y, left: colorPicker.x, zIndex: 999,
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 4, padding: 4, boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="color"
              value={colorPicker.attr.v.startsWith('#') ? colorPicker.attr.v : '#' + (colorPicker.attr.v || '888888')}
              onInput={(e) => {
                handleColorInput(e);
                // Update the picker state so the swatch reflects the new color
                setColorPicker(prev => prev ? {
                  ...prev,
                  attr: { ...prev.attr, v: prev.attr.v.startsWith('#') ? e.target.value : e.target.value.slice(1).toUpperCase() }
                } : null);
              }}
              ref={(el) => { if (el) setTimeout(() => el.click(), 50); }}
              style={{ width: 44, height: 28, border: 'none', padding: 0, cursor: 'pointer' }}
            />
          </div>
        </div>
      )}

      {/* Node delete dialog */}
      {nodeDelete && (
        <NodeDeleteDialog
          tagName={nodeDelete.tagName}
          x={nodeDelete.x}
          y={nodeDelete.y}
          onConfirm={handleNodeDelete}
          onCancel={() => setNodeDelete(null)}
        />
      )}

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position: 'fixed',
          top: tooltip.y + 16,
          left: Math.min(tooltip.x, window.innerWidth - 320),
          zIndex: 500,
          background: 'var(--tooltip-bg)',
          border: '1px solid var(--tooltip-border)',
          borderRadius: 4,
          padding: '8px 12px',
          maxWidth: 300,
          fontSize: 12,
          color: 'var(--tooltip-text)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          whiteSpace: 'pre-wrap',
          pointerEvents: 'none',
          lineHeight: 1.4,
        }}>
          {tooltip.text}
        </div>
      )}

      {/* Spelling suggestions menu */}
      {spellingMenu && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }}
          onClick={() => { setSpellingMenu(null); viewRef.current?.focus(); }}
          onContextMenu={(e) => { e.preventDefault(); setSpellingMenu(null); }}
        >
          <div
            ref={clampToViewport}
            style={{
              position: 'fixed', top: spellingMenu.y, left: spellingMenu.x, zIndex: 999,
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)', minWidth: 160, padding: '4px 0',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>
              "{spellingMenu.word}"
            </div>
            {spellingMenu.isMixedScript && (
              <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                Mixed script (contains non-ASCII characters)
              </div>
            )}
            {/* Dictionary-management actions come FIRST. Hidden for forbidden-char
                hits — adding a non-letter character to the dictionary is meaningless,
                and the forbidden-char rule is a hard "always replace" rule. */}
            {!spellingMenu.isForbiddenChar && (
              <>
                <div
                  style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--tab-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = ''}
                  onClick={async () => {
                    const word = spellingMenu.word;
                    const view = spellingMenu.view;
                    setSpellingMenu(null);

                    // Add to the live spellchecker immediately so decorations update
                    const checker = spellcheckerRef.current;
                    if (checker) checker.add(word);

                    // Persist to disk (async, file watcher will sync other windows)
                    await window.arcenApi.addToDictionary(word);

                    // Track for undo — expires after 30 seconds
                    if (lastDictAddRef.current?.timeout) clearTimeout(lastDictAddRef.current.timeout);
                    lastDictAddRef.current = {
                      word,
                      timeout: setTimeout(() => { lastDictAddRef.current = null; }, 30000),
                    };

                    // Force decoration rebuild by inserting+removing a space (triggers docChanged)
                    const pos = view.state.doc.length;
                    view.dispatch({ changes: { from: pos, insert: ' ' } });
                    view.dispatch({ changes: { from: pos, to: pos + 1 } });

                    viewRef.current?.focus();
                  }}
                >
                  {spellingMenu.isMixedScript
                    ? 'Add to Dictionary (global — legitimate Unicode word)'
                    : 'Add to Dictionary (global)'}
                </div>
                {spellingMenu.isDevContext && (
                  <div
                    style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--tab-bg)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = ''}
                    onClick={async () => {
                      const word = spellingMenu.word;
                      const view = spellingMenu.view;
                      setSpellingMenu(null);

                      // Dev dictionary only — doesn't affect user-facing fields anywhere
                      await window.arcenApi.addToDevDictionary(word);

                      // Force a decoration rebuild so the inline squiggle updates immediately.
                      // The checker itself will see the new dev word after the file-watcher
                      // reload fires (shortly after the IPC write above).
                      const pos = view.state.doc.length;
                      view.dispatch({ changes: { from: pos, insert: ' ' } });
                      view.dispatch({ changes: { from: pos, to: pos + 1 } });

                      viewRef.current?.focus();
                    }}
                  >
                    Add to Dev Dictionary (dev fields only)
                  </div>
                )}
                <div
                  style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--tab-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = ''}
                  onClick={() => {
                    const view = spellingMenu.view;
                    const wordFrom = spellingMenu.wordFrom;
                    setSpellingMenu(null);
                    try {
                      const doc = view.state.doc.toString();
                      const tokens = tokenize(doc);
                      let inTag = false, curTagNameEnd = -1, curTagStart = -1, hasAttr = false;
                      let insertAt = -1;
                      for (let i = 0; i < tokens.length; i++) {
                        const tk = tokens[i];
                        if (tk.c === 'br' && tk.s === '<' && i + 1 < tokens.length && tokens[i + 1].c === 'tg') {
                          inTag = true;
                          curTagStart = tk.p;
                          curTagNameEnd = tokens[i + 1].p + tokens[i + 1].s.length;
                          hasAttr = false;
                        } else if (inTag && tk.c === 'an' && tk.s === 'no_spellcheck_or_grammar') {
                          hasAttr = true;
                        } else if (inTag && tk.c === 'br' && (tk.s === '>' || tk.s === '/>')) {
                          const gtEnd = tk.p + tk.s.length;
                          if (wordFrom >= curTagStart && wordFrom <= gtEnd) {
                            // Insert just before the closing bracket (`>` or `/>`)
                            // so the new attribute appears at the END of the node.
                            if (!hasAttr) insertAt = tk.p;
                            break;
                          }
                          inTag = false;
                        }
                      }
                      if (insertAt >= 0) {
                        view.dispatch({
                          changes: { from: insertAt, insert: ' no_spellcheck_or_grammar="true"' },
                        });
                      }
                    } catch (_) {}
                    viewRef.current?.focus();
                  }}
                >
                  Ignore All Spelling in Entire Node
                </div>
                <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
              </>
            )}
            {spellingMenu.suggestions.length > 0 ? (
              spellingMenu.suggestions.map((s, i) => (
                <div
                  key={i}
                  style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--tab-bg)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = ''}
                  onClick={() => {
                    const view = spellingMenu.view;
                    view.dispatch({
                      changes: { from: spellingMenu.wordFrom, to: spellingMenu.wordTo, insert: s },
                    });
                    setSpellingMenu(null);
                    view.focus();
                  }}
                >
                  {spellingMenu.isForbiddenChar
                    ? `Replace with "${s}"`
                    : spellingMenu.isMixedScript
                      ? `Fix homoglyphs → "${s}"`
                      : s}
                </div>
              ))
            ) : (
              <div style={{ padding: '5px 14px', fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                No suggestions
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schema template picker for FIELD_NEEDED comments */}
      {schemaTemplateMenu && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 998 }}
          onClick={() => setSchemaTemplateMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setSchemaTemplateMenu(null); }}
        >
          <div
            ref={clampToViewport}
            style={{
              position: 'fixed', top: schemaTemplateMenu.y, left: schemaTemplateMenu.x, zIndex: 999,
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)', minWidth: 250, padding: '4px 0',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>
              Insert template for "{schemaTemplateMenu.fieldName}"
            </div>
            {getOrderedTemplateItems(schemaTemplateMenu.fieldName).map((item, i) => (
              <div
                key={i}
                style={{ padding: '5px 14px', fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--tab-bg)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                onClick={() => {
                  const view = viewRef.current;
                  if (view) {
                    const replacement = '\t' + item.template;
                    view.dispatch({
                      changes: { from: schemaTemplateMenu.lineFrom, to: schemaTemplateMenu.lineTo, insert: replacement },
                    });
                    onChange(relativePath, view.state.doc.toString());
                  }
                  setSchemaTemplateMenu(null);
                }}
              >
                {item.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
