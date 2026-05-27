/**
 * Schema-aware syntax highlighting for the Arcen XML Editor.
 *
 * Two layers:
 * 1. Base XML highlighting via HighlightStyle (tags, attrs, comments)
 * 2. Schema-aware decorations via ViewPlugin (FK teal/purple, bools, numbers,
 *    dimmed internal_notes/translation_notes, color swatches on icon_color)
 */

import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { ViewPlugin, Decoration, WidgetType } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { tokenize, buildAttrMap, DIMMED_ATTRS } from './xmlTokenizer';

// ─── Base XML Highlighting ──────────────────────────────────────────

const LIGHT_COLORS = {
  tag: '#800000', bracket: '#0000ff', attrName: '#ff0000', attrValue: '#0000ff',
  comment: '#008000', xmlDecl: '#aaaaaa', number: '#098658',
};
const DARK_COLORS = {
  tag: '#569cd6', bracket: '#808080', attrName: '#9cdcfe', attrValue: '#ce9178',
  comment: '#6a9955', xmlDecl: '#555555', number: '#b5cea8',
};

export function createArcenHighlighter(theme) {
  const c = theme === 'dark' ? DARK_COLORS : LIGHT_COLORS;
  return HighlightStyle.define([
    { tag: tags.tagName, color: c.tag },
    { tag: tags.attributeName, color: c.attrName },
    { tag: tags.attributeValue, color: c.attrValue },
    { tag: tags.string, color: c.attrValue },
    { tag: tags.comment, color: c.comment },
    { tag: tags.angleBracket, color: c.bracket },
    { tag: tags.processingInstruction, color: c.xmlDecl },
    { tag: tags.number, color: c.number },
  ]);
}

// ─── Schema-Aware Decorations ───────────────────────────────────────

const SEMANTIC_COLORS = {
  light: {
    fkDropdown: '#0891b2', fkList: '#AF00DB', bool: '#0000ff',
    number: '#098658', dimmed: '#c0c0c0',
    headerAttrName: '#ff2dcb', headerAttrValue: '#b749fe',
    subNodeTag: '#923aff',
  },
  dark: {
    fkDropdown: '#4dd0e1', fkList: '#c586c0', bool: '#569cd6',
    number: '#b5cea8', dimmed: '#555555',
    headerAttrName: '#ff5c8a', headerAttrValue: '#f0b0ff',
    subNodeTag: '#b57cff',
  },
};

// Header attributes in XML files
const XML_HEADER_ATTRS = new Set(['id', 'display_name']);
// Header attributes in metadata files (key on <attribute>, id on <sub_node>)
const META_HEADER_ATTRS = new Set(['key', 'id']);

/**
 * Color swatch widget for icon_color values.
 */
class ColorSwatchWidget extends WidgetType {
  constructor(color, pos) {
    super();
    this.color = color;
    this.pos = pos; // position in document where the value starts
  }
  toDOM() {
    const span = document.createElement('span');
    span.setAttribute('data-color-swatch', 'true');
    span.setAttribute('data-swatch-pos', String(this.pos));
    span.style.cssText = `
      display: inline-block; width: 10px; height: 10px;
      background: #${this.color}; border: 1px solid #888;
      border-radius: 2px; margin-right: 2px; vertical-align: middle;
      cursor: pointer;
    `;
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Dispatch a custom event that EditorPane listens for
      span.dispatchEvent(new CustomEvent('swatch-click', {
        bubbles: true,
        detail: { pos: this.pos, x: e.clientX, y: e.clientY },
      }));
    });
    return span;
  }
  eq(other) { return this.color === other.color && this.pos === other.pos; }
}

/**
 * Create a ViewPlugin that applies schema-aware decorations.
 * `getSchema` is a function that returns the current merged schema.
 * `theme` is 'light' or 'dark'.
 */
export function createSchemaDecorations(getSchema, theme) {
  const colors = SEMANTIC_COLORS[theme] || SEMANTIC_COLORS.light;

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = this.buildDecorations(view);
        this.rebuildTimer = null;
      }

      // Debounce the rebuild off the keystroke path. Rebuilding on every
      // docChanged re-tokenizes and re-scans the entire document, which
      // for files more than a few hundred lines eats the 16 ms frame
      // budget and shows up as typing jank / dropped key repeats. 150 ms
      // is short enough to feel live and long enough to coalesce a burst
      // of keystrokes into a single rebuild.
      //
      // During the debounce window we still need decorations to stay
      // anchored to the text they describe — CodeMirror does not auto-map
      // ViewPlugin decorations through changes. Without the .map() call,
      // inserting a character mid-file shifts the subsequent text but
      // leaves decorations at their old offsets, producing a visible
      // "swirl" of colors on lines the user isn't even editing. Mapping
      // the RangeSet forward is essentially free and preserves the
      // visual anchoring until the next full rebuild replaces it.
      //
      // viewportChanged is intentionally not a trigger: these decorations
      // are positional (RangeSetBuilder spans) and CodeMirror clips them
      // to the viewport itself, so scrolling doesn't need new data.
      update(update) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
          this.scheduleRebuild();
        }
      }

      scheduleRebuild() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => {
          this.rebuildTimer = null;
          this.decorations = this.buildDecorations(this.view);
          // Empty transaction prompts CodeMirror to re-read decorations
          // from all plugins. Our update() sees no docChanged, so we
          // don't re-enter this path.
          this.view.dispatch({});
        }, 150);
      }

      destroy() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      }

      buildDecorations(view) {
        const schema = getSchema();
        if (!schema) return Decoration.none;

        const doc = view.state.doc.toString();
        const tokens = tokenize(doc);
        const attrMap = buildAttrMap(tokens, schema);
        const builder = new RangeSetBuilder();

        // Collect all decorations with positions, then sort
        const decos = [];

        for (const attr of attrMap) {
          const isDimmed = DIMMED_ATTRS.has(attr.nm);

          // Dim the entire attr name="value" span
          if (isDimmed) {
            decos.push({
              from: attr.ns2,
              to: attr.ve + 1, // +1 for closing quote
              deco: Decoration.mark({ class: 'cm-dimmed-attr' }),
            });
            continue;
          }

          // Bool false / int-bool 0 → softer color across the whole
          // name="value" span. Sits between full-strength bools and the
          // very-faint dimmed notes: still visibly a bool, just quieter.
          if ((attr.tp === 'bool' && attr.v === 'false')
            || (attr.tp === 'int-bool' && attr.v === '0')) {
            decos.push({
              from: attr.ns2,
              to: attr.ve + 1,
              deco: Decoration.mark({ class: 'cm-bool-false' }),
            });
            continue;
          }

          // Header attributes (id, display_name) get special coloring
          if (XML_HEADER_ATTRS.has(attr.nm)) {
            decos.push({
              from: attr.ns2,
              to: attr.ne,
              deco: Decoration.mark({ class: 'cm-header-attr-name' }),
            });
            if (attr.vs <= attr.ve) {
              decos.push({
                from: attr.vs,
                to: attr.ve,
                deco: Decoration.mark({ class: 'cm-header-attr-value' }),
              });
            }
            continue;
          }

          // Semantic value coloring
          let valueColor = null;
          let underline = false;

          switch (attr.tp) {
            case 'bool':
            case 'int-bool':
              valueColor = colors.bool;
              break;
            case 'node-dropdown':
              valueColor = colors.fkDropdown;
              underline = true;
              break;
            case 'node-list':
              valueColor = colors.fkList;
              break;
            case 'int-textbox':
            case 'float-textbox':
            case 'range-int':
            case 'range-float':
              valueColor = colors.number;
              break;
          }

          if (valueColor && attr.vs <= attr.ve) {
            let style = `color: ${valueColor}`;
            if (underline) style += '; text-decoration: underline dotted; text-underline-offset: 3px';
            decos.push({
              from: attr.vs,
              to: attr.ve,
              deco: Decoration.mark({ attributes: { style } }),
            });
          }

          // Color swatch for any value starting with # followed by hex color
          const hexMatch = attr.v.match(/^#([0-9A-Fa-f]{6})$/);
          if (hexMatch) {
            decos.push({
              from: attr.vs,
              to: attr.vs,
              deco: Decoration.widget({
                widget: new ColorSwatchWidget(hexMatch[1], attr.vs),
                side: -1,
              }),
            });
          }
          // Also support bare 6-digit hex on icon_color specifically
          if (attr.nm === 'icon_color' && /^[0-9A-Fa-f]{6}$/.test(attr.v)) {
            decos.push({
              from: attr.vs,
              to: attr.vs,
              deco: Decoration.widget({
                widget: new ColorSwatchWidget(attr.v, attr.vs),
                side: -1,
              }),
            });
          }
        }

        // Sort by position (required by RangeSetBuilder)
        decos.sort((a, b) => a.from - b.from || a.to - b.to);

        for (const d of decos) {
          builder.add(d.from, d.to, d.deco);
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/**
 * Create metadata-specific decorations for schema files.
 * - `key` on <attribute> and `id` on <sub_node> → header colors (bold)
 * - <sub_node> tag names → special purple color
 */
export function createMetadataDecorations(theme) {
  const colors = SEMANTIC_COLORS[theme] || SEMANTIC_COLORS.light;

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = this.buildDecorations(view);
        this.rebuildTimer = null;
      }
      // Debounced rebuild — see the longer comment on createSchemaDecorations
      // for why we map + debounce instead of rebuilding per keystroke. The
      // metadata decoration walk is the heavier of the two token walks
      // (scans every token looking for <sub_node> and header attrs), so
      // debouncing here is especially important on schema files.
      update(update) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
          this.scheduleRebuild();
        }
      }
      scheduleRebuild() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => {
          this.rebuildTimer = null;
          this.decorations = this.buildDecorations(this.view);
          this.view.dispatch({});
        }, 150);
      }
      destroy() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      }

      buildDecorations(view) {
        const doc = view.state.doc.toString();
        const tokens = tokenize(doc);
        const builder = new RangeSetBuilder();
        const decos = [];

        // Walk tokens to find:
        // 1. <sub_node> tag names → purple
        // 2. header attrs (key, id) when inside <attribute> or <sub_node> → header colors
        let currentTag = null; // the tag name of the current opening tag being parsed
        for (let i = 0; i < tokens.length; i++) {
          const tk = tokens[i];

          // Track current tag context for attributes
          if (tk.c === 'br' && tk.s === '<' && i + 1 < tokens.length && tokens[i + 1].c === 'tg') {
            currentTag = tokens[i + 1].s;

            // Color sub_node tag names
            if (currentTag === 'sub_node') {
              decos.push({
                from: tokens[i + 1].p,
                to: tokens[i + 1].p + tokens[i + 1].s.length,
                deco: Decoration.mark({ class: 'cm-subnode-tag' }),
              });
            }
          }
          // Closing tags for sub_node
          if (tk.c === 'br' && tk.s === '</' && i + 1 < tokens.length && tokens[i + 1].c === 'tg') {
            if (tokens[i + 1].s === 'sub_node') {
              decos.push({
                from: tokens[i + 1].p,
                to: tokens[i + 1].p + tokens[i + 1].s.length,
                deco: Decoration.mark({ class: 'cm-subnode-tag' }),
              });
            }
          }
          // End of tag resets context
          if (tk.c === 'br' && (tk.s === '>' || tk.s === '/>')) {
            currentTag = null;
          }

          // Header attributes in metadata
          if (tk.c === 'an' && META_HEADER_ATTRS.has(tk.s)) {
            // Find the value token
            let vt = null;
            for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
              if (tokens[j].c === 'av') { vt = tokens[j]; break; }
            }
            decos.push({
              from: tk.p,
              to: tk.p + tk.s.length,
              deco: Decoration.mark({ class: 'cm-header-attr-name' }),
            });
            if (vt) {
              decos.push({
                from: vt.p,
                to: vt.p + vt.s.length,
                deco: Decoration.mark({ class: 'cm-header-attr-value' }),
              });
            }
          }
        }

        decos.sort((a, b) => a.from - b.from || a.to - b.to);
        for (const d of decos) { builder.add(d.from, d.to, d.deco); }
        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}
