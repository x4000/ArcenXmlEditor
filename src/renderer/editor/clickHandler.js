/**
 * Click handler extension for interactive value editing.
 * - Click node-dropdown values: open filterable picker
 * - Click node-list values: open multi-select picker
 * - Click icon_color attribute NAME: open native color picker
 * - Ctrl+click FK values: navigate to referenced row
 * - Ctrl+click tag name: open reference panel at that node
 *
 * Returns a CM6 extension. Callbacks are used to trigger React overlays
 * (dropdowns, color pickers) from the parent component.
 */

import { EditorView } from '@codemirror/view';
import { tokenize, buildAttrMap } from './xmlTokenizer';
import { naturalCompare } from './naturalSort';
import { getFKOptionsForLayer, getFKSubOptionsForLayer } from './fkIndex';

/**
 * Create the click handler extension.
 *
 * callbacks: {
 *   openDropdown(view, attr, options, x, y) — open FK dropdown
 *   openMultiSelect(view, attr, options, currentValues, x, y)
 *   openColorPicker(view, attr, x, y)
 *   navigateToFK(tableName, id) — Ctrl+click FK navigation
 *   showTooltip(text, x, y) — hover tooltip on attr name
 *   dismissTooltip()
 * }
 *
 * getFileLayer() returns the editing file's layer ('base' | 'dlc<N>' |
 * 'mod_<src>_<dir>'). FK dropdown options are filtered to the layers that
 * file is allowed to reference (base → base only, dlc<N> → base + dlc<N>,
 * mod → base + self + declared deps).
 *
 * getFileExtraLayers() returns the baseline EXTRA layer ids permitted from
 * this file beyond what allowedTargetLayers gives by default. For a mod
 * file, that's the layer ids of its required_expansions + required_mods
 * (resolved). Null for base/DLC files. Optional — defaults to null when
 * the caller doesn't supply it.
 */
export function createClickHandler(getSchema, getFKIndex, callbacks, getFileLayer, getFileExtraLayers) {
  let hoverTimer = null;
  let lastHoverPos = -1;
  let fkClickTimer = null;

  return EditorView.domEventHandlers({
    keydown() {
      // Typing or navigating invalidates pending dropdown-open positions.
      if (fkClickTimer) { clearTimeout(fkClickTimer); fkClickTimer = null; }
      return false;
    },
    click(event, view) {
      // Any click cancels a pending delayed-dropdown-open. If this click turns
      // out to be on another FK value, the code below will restart the timer.
      // Without this, a stale click 250ms ago would still open a dropdown at
      // the old position even if the user has clicked elsewhere since.
      if (fkClickTimer) { clearTimeout(fkClickTimer); fkClickTimer = null; }
      const schema = getSchema();
      if (!schema) return false;

      // Check if a color swatch widget was clicked
      const target = event.target;
      if (target && target.getAttribute?.('data-color-swatch')) {
        event.preventDefault();
        if (callbacks.openColorPicker) {
          const swatchPos = parseInt(target.getAttribute('data-swatch-pos'), 10);
          if (!isNaN(swatchPos)) {
            const doc = view.state.doc.toString();
            const tokens = tokenize(doc);
            const attrMap = buildAttrMap(tokens, schema);
            for (const attr of attrMap) {
              if (attr.vs === swatchPos) {
                callbacks.openColorPicker(view, attr, event.clientX, event.clientY);
                return true;
              }
            }
          }
        }
        return true;
      }

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      const doc = view.state.doc.toString();
      const tokens = tokenize(doc);
      const attrMap = buildAttrMap(tokens, schema);

      // Find which attribute was clicked
      for (const attr of attrMap) {
        // Click on VALUE
        if (pos >= attr.vs && pos <= attr.ve) {
          // Ctrl+click FK navigation. Require a clean SINGLE click
          // (event.detail === 1): a double-click whose second click lands with
          // Ctrl already held would otherwise navigate away instead of letting
          // the user select-a-word-then-Ctrl+V. Same guard on every ctrl+click
          // branch below.
          if ((event.ctrlKey || event.metaKey) && event.detail === 1 && attr.src && callbacks.navigateToFK) {
            event.preventDefault();
            callbacks.navigateToFK(attr.src, attr.v);
            return true;
          }

          // Ctrl+click lang-string — navigate to Language table entry
          if ((event.ctrlKey || event.metaKey) && event.detail === 1 && attr.tp === 'lang-string' && attr.v && callbacks.navigateToFK) {
            event.preventDefault();
            callbacks.navigateToFK('0_Language', attr.v);
            return true;
          }

          // FK dropdown — delayed to allow double-click word selection
          if (attr.tp === 'node-dropdown' && callbacks.openDropdown) {
            if (event.detail >= 2) return false; // double-click = word select
            // Delay to detect if a drag-select or double-click follows
            if (fkClickTimer) clearTimeout(fkClickTimer);
            const cx = event.clientX, cy = event.clientY;
            const attrCopy = { ...attr };
            fkClickTimer = setTimeout(() => {
              fkClickTimer = null;
              // Check if user has made a selection (drag)
              const sel = view.state.selection.main;
              if (sel.from !== sel.to) return;
              const fkIndex = getFKIndex();
              const layer = getFileLayer ? getFileLayer() : 'base';
              const extras = getFileExtraLayers ? getFileExtraLayers() : null;
              // `can_make_invalid_cross_links="true"` on the schema attr
              // opens the picker to EVERY layer's IDs (not just the
              // allowed-target set). Matches the same opt-out the
              // validator honors for that flag.
              const unrestricted = attrCopy.d?.can_make_invalid_cross_links === 'true';
              let options = getFKOptionsForLayer(fkIndex, attrCopy.src, layer, extras, unrestricted);
              if (attrCopy.d?.node_sub_source) {
                const subOpts = getFKSubOptionsForLayer(fkIndex, attrCopy.src, layer, extras, unrestricted);
                if (subOpts.length) options = [...options, ...subOpts].sort(naturalCompare);
              }
              // Prepend extra allowed values (e.g., "None", "All") at the top
              const extra = attrCopy.d?.node_extra_allowed;
              if (extra) {
                const extraList = extra.split(',').map(s => s.trim()).filter(Boolean);
                options = [...extraList, ...options.filter(o => !extraList.includes(o))];
              }
              callbacks.openDropdown(view, attrCopy, options, cx, cy);
            }, 250);
            return false;
          }

          // FK multi-select — same delayed approach
          if (attr.tp === 'node-list' && callbacks.openMultiSelect) {
            if (event.detail >= 2) return false;
            if (fkClickTimer) clearTimeout(fkClickTimer);
            const cx = event.clientX, cy = event.clientY;
            const attrCopy = { ...attr };
            fkClickTimer = setTimeout(() => {
              fkClickTimer = null;
              const sel = view.state.selection.main;
              if (sel.from !== sel.to) return;
              const fkIndex = getFKIndex();
              const layer = getFileLayer ? getFileLayer() : 'base';
              const extras = getFileExtraLayers ? getFileExtraLayers() : null;
              // Same per-field cross-layer opt-out as the single-select
              // dropdown above — shows IDs from every layer when the
              // schema says `can_make_invalid_cross_links="true"`.
              const unrestricted = attrCopy.d?.can_make_invalid_cross_links === 'true';
              let options = getFKOptionsForLayer(fkIndex, attrCopy.src, layer, extras, unrestricted);
              if (attrCopy.d?.node_sub_source) {
                const subOpts = getFKSubOptionsForLayer(fkIndex, attrCopy.src, layer, extras, unrestricted);
                if (subOpts.length) options = [...options, ...subOpts].sort(naturalCompare);
              }
              const extra = attrCopy.d?.node_extra_allowed;
              if (extra) {
                const extraList = extra.split(',').map(s => s.trim()).filter(Boolean);
                options = [...extraList, ...options.filter(o => !extraList.includes(o))];
              }
              const currentValues = attrCopy.v ? attrCopy.v.split(',').filter(Boolean) : [];
              callbacks.openMultiSelect(view, attrCopy, options, currentValues, cx, cy);
            }, 250);
            return false;
          }

          // string-dropdown — open a filterable picker of the schema-defined
          // options, in definition order (NOT sorted). Same delayed-open as the
          // FK dropdown so a double-click word-select still works, and the
          // FKDropdown UI gives the type-to-filter behavior.
          if (attr.tp === 'string-dropdown' && callbacks.openDropdown) {
            if (event.detail >= 2) return false;
            const options = Array.isArray(attr.d?.options) ? attr.d.options.slice() : [];
            if (!options.length) return false;
            if (fkClickTimer) clearTimeout(fkClickTimer);
            const cx = event.clientX, cy = event.clientY;
            const attrCopy = { ...attr };
            fkClickTimer = setTimeout(() => {
              fkClickTimer = null;
              const sel = view.state.selection.main;
              if (sel.from !== sel.to) return;
              callbacks.openDropdown(view, attrCopy, options, cx, cy);
            }, 250);
            return false;
          }

          return false;
        }

        // Click on NAME
        if (pos >= attr.ns2 && pos < attr.ne) {
          // Ctrl+click attribute name → navigate to metadata definition
          if ((event.ctrlKey || event.metaKey) && event.detail === 1 && callbacks.navigateToMetadata) {
            event.preventDefault();
            callbacks.navigateToMetadata(attr.nm, attr.parentTag || null);
            return true;
          }

          // icon_color name click → open color picker
          if (attr.nm === 'icon_color' && /^[0-9A-Fa-f]{6}$/.test(attr.v) && callbacks.openColorPicker) {
            event.preventDefault();
            callbacks.openColorPicker(view, attr, event.clientX, event.clientY);
            return true;
          }
          // Any attr with #hex value — name click opens color picker
          if (/^#[0-9A-Fa-f]{6}$/.test(attr.v) && callbacks.openColorPicker) {
            event.preventDefault();
            callbacks.openColorPicker(view, attr, event.clientX, event.clientY);
            return true;
          }
          return false;
        }
      }

      // Ctrl+click on tag name. Two paths:
      //   - tag is known to the schema (matches root nodeName or a sub_node id)
      //     → open the reference panel for that node, as before.
      //   - tag is NOT known to the schema → offer to ADD it as a sub_node
      //     entry in the appropriate schema/extension file (so the mod author
      //     can declare the sub-node their DLL reads without leaving the
      //     editor). Split view for an unknown node would just be empty.
      if ((event.ctrlKey || event.metaKey) && event.detail === 1) {
        for (const tk of tokens) {
          if (tk.c === 'tg' && pos >= tk.p && pos < tk.p + tk.s.length) {
            // Known if it matches the root node, any sub_node id in the
            // merged schema, or an existing override. We check against the
            // merged schema — for mod files the EditorPane composes that
            // with applicable extensions, so a sub_node defined in the mod's
            // extension counts as "known" here too.
            const isKnownSubNode = (schema.subNodes || []).some((sn) => sn.id === tk.s);
            const isRootNode = schema.nodeName === tk.s;
            const isKnown = isRootNode || isKnownSubNode;
            if (!isKnown && callbacks.addUnknownSubNodeToSchema) {
              event.preventDefault();
              callbacks.addUnknownSubNodeToSchema(tk.s);
              return true;
            }
            if (callbacks.openReferencePanel) {
              event.preventDefault();
              const linesBefore = doc.slice(0, tk.p).split('\n');
              callbacks.openReferencePanel(tk.s, linesBefore.length);
              return true;
            }
          }
        }
      }

      // Dismiss tooltip on click elsewhere
      if (callbacks.dismissTooltip) callbacks.dismissTooltip();
      return false;
    },

    // Hover tooltips on attribute names (1 second delay)
    mousemove(event, view) {
      const schema = getSchema();
      if (!schema) return false;

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        lastHoverPos = -1;
        if (callbacks.dismissTooltip) callbacks.dismissTooltip();
        return false;
      }

      // If still on the same position, don't restart the timer
      if (pos === lastHoverPos) return false;
      lastHoverPos = pos;

      // Clear any pending tooltip
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (callbacks.dismissTooltip) callbacks.dismissTooltip();

      // Start a 0.5-second delay; suppress if window is not focused
      const cx = event.clientX, cy = event.clientY;
      hoverTimer = setTimeout(() => {
        if (!document.hasFocus()) return;
        hoverTimer = null;
        const doc = view.state.doc.toString();
        const tokens = tokenize(doc);
        const attrMap = buildAttrMap(tokens, schema);

        for (const attr of attrMap) {
          if (pos >= attr.ns2 && pos < attr.ne && attr.d) {
            const parts = [];
            if (attr.d.tooltip || attr.d.description) {
              parts.push(attr.d.tooltip || attr.d.description);
            }
            const meta = ['Type: ' + attr.tp];
            if (attr.src) meta.push('Source: ' + attr.src);
            parts.push(meta.join(' · '));
            if (callbacks.showTooltip) callbacks.showTooltip(parts.join('\n'), cx, cy);
            return;
          }
        }
      }, 500);

      return false;
    },
  });
}
