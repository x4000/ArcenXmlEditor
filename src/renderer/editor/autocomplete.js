/**
 * Autocomplete extension for the Arcen XML Editor.
 * - Node names after "<": substring matching against schema node names
 * - Attribute names after whitespace inside a tag: scoped to node context
 * - No intellisense inside quotes
 * - Attribute completion: inserts name="" with cursor between quotes
 * - Bool attrs: default to ="true" / ="1"
 * - FK attrs: auto-open dropdown after completion (via callback)
 */

import { autocompletion, startCompletion } from '@codemirror/autocomplete';
import { isInQuotes, getNodeContext, findAttrDef } from './xmlTokenizer';
import { naturalCompare } from './naturalSort';

/**
 * Create the autocomplete extension.
 * `getSchema` returns the current merged schema or null.
 * `onFKComplete` is called when an FK attribute is completed, with (view, attrDef, valuePos).
 */
export function createArcenAutocomplete(getSchema, onFKComplete) {
  return autocompletion({
    override: [arcenCompletionSource(getSchema, onFKComplete)],
    activateOnTyping: true,
    defaultKeymap: true,
  });
}

// True if `pos` is inside an XML comment (i.e. after the last <!-- with no
// matching --> before it). Comments span lines and contain arbitrary text;
// users editing comments should not see node/attribute suggestions.
function isInComment(doc, pos) {
  const before = doc.slice(0, pos);
  const lastOpen = before.lastIndexOf('<!--');
  if (lastOpen < 0) return false;
  const closeAfterOpen = before.indexOf('-->', lastOpen);
  return closeAfterOpen < 0 || closeAfterOpen >= pos;
}

function arcenCompletionSource(getSchema, onFKComplete) {
  return (context) => {
    const schema = getSchema();
    if (!schema) return null;

    const doc = context.state.doc.toString();
    const pos = context.pos;

    // No autocomplete inside quotes or inside XML comments
    if (isInQuotes(doc, pos)) return null;
    if (isInComment(doc, pos)) return null;

    const before = doc.slice(0, pos);

    // ── Node name completion after "<" ──
    const tagMatch = before.match(/<([\w.-]*)$/);
    if (tagMatch) {
      const partial = tagMatch[1].toLowerCase();
      const from = pos - tagMatch[1].length;

      // Collect valid node names
      const nodeNames = [schema.nodeName, 'root'];
      for (const sn of schema.subNodes || []) {
        nodeNames.push(sn.id);
      }

      const matches = nodeNames
        .filter((n) => n.toLowerCase().includes(partial))
        .sort(naturalCompare);

      if (matches.length === 0 || (matches.length === nodeNames.length && partial === '')) return null;

      return {
        from,
        options: matches.map((label) => ({
          label,
          type: 'keyword',
        })),
      };
    }

    // ── Attribute name completion after whitespace inside a tag ──
    const attrMatch = before.match(/\s([\w.-]*)$/);
    if (attrMatch) {
      const lastOpen = before.lastIndexOf('<');
      const lastClose = before.lastIndexOf('>');
      if (lastOpen <= lastClose) return null; // not inside a tag

      const partial = attrMatch[1].toLowerCase();
      const from = pos - attrMatch[1].length;

      // Determine node context for scoped attrs
      const tagSegment = before.slice(lastOpen);
      const contextTag = tagSegment.match(/^<([\w.-]+)/);
      const contextName = contextTag ? contextTag[1] : null;

      // Build attribute list scoped to context. Mirrors the validator's
      // per-context "unknown attribute" check (validation.js):
      //   - Top-level node: only merged top-level attrs (shared + table).
      //     Sub-node-only attrs (e.g. debug_log_contemplation_details on
      //     <contemplation_data>) used to leak into this list and the user
      //     would happily accept the suggestion, only for the validator to
      //     immediately flag it as wrong-context.
      //   - Sub-node: that sub-node's own attrs, plus the shared/top-level
      //     attrs (the validator allows those inside sub-nodes too).
      const attrNames = new Set();

      const isSubNodeContext =
        contextName && contextName !== schema.nodeName && contextName !== 'root';

      if (isSubNodeContext) {
        const subNode = (schema.subNodes || []).find((sn) => sn.id === contextName);
        if (subNode) {
          for (const a of subNode.attributes) attrNames.add(a.key);
        }
        if (schema.attributes) {
          for (const a of schema.attributes) attrNames.add(a.key);
        }
      } else if (schema.attributes) {
        for (const a of schema.attributes) attrNames.add(a.key);
      }

      const matches = [...attrNames]
        .filter((n) => n.toLowerCase().includes(partial))
        .sort(naturalCompare);

      if (matches.length === 0) return null;

      return {
        from,
        options: matches.map((label) => {
          const def = findAttrDef(schema, label);
          const isBool = def && (def.type === 'bool' || def.type === 'int-bool');
          const isFK = def && (def.type === 'node-dropdown' || def.type === 'node-list');
          const defaultVal = isBool ? (def.type === 'bool' ? 'true' : '1') : '';

          return {
            label,
            type: 'property',
            detail: def ? def.type : undefined,
            info: def?.tooltip || def?.description || undefined,
            apply: (view, completion, from, to) => {
              if (isBool) {
                const insert = `${label}="${defaultVal}"`;
                view.dispatch({
                  changes: { from, to, insert },
                  selection: { anchor: from + insert.length },
                });
              } else {
                const insert = `${label}=""`;
                const cursorPos = from + label.length + 2; // between quotes
                view.dispatch({
                  changes: { from, to, insert },
                  selection: { anchor: cursorPos },
                });
                // If FK, trigger dropdown
                if (isFK && onFKComplete) {
                  setTimeout(() => onFKComplete(view, def, cursorPos), 20);
                }
              }
            },
          };
        }),
      };
    }

    return null;
  };
}
