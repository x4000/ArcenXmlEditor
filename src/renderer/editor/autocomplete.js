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
import { isInQuotes, getNodeContext, findAttrDefInContext } from './xmlTokenizer';
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

      // The valid attribute set depends on the node's POSITION, not just its
      // tag name. Find the parent of the node we're typing into (the innermost
      // open tag BEFORE this one started):
      const parentContext = getNodeContext(doc, lastOpen);
      const isOuterNode = !parentContext || parentContext === 'root';

      // Build the attribute list:
      //   - Record node (the schema's node_name), or an unknown node sitting
      //     directly under <root>: the full merged top-level set. (An unknown
      //     OUTER node still gets the full set — the intentionally lenient
      //     "you're probably still naming this record" behavior.)
      //   - A KNOWN sub-node, wherever it nests: its own attrs + only the
      //     top-level attrs flagged cascades_to_child_nodes="true".
      //   - An UNKNOWN CHILD node (nested, not a declared sub-node): only the
      //     cascading top-level attrs. We must NOT dump the record node's whole
      //     attribute set into a nonsense child — that was the bug where typing
      //     in a junk child still offered id / display_name / etc.
      const attrNames = new Set();
      const subNode = (schema.subNodes || []).find((sn) => sn.id === contextName);
      const isRecordNode = contextName === schema.nodeName || contextName === 'root';

      const addCascadingTopLevel = () => {
        if (!schema.attributes) return;
        for (const a of schema.attributes) {
          if (a.cascades_to_child_nodes === 'true') attrNames.add(a.key);
        }
      };

      if (subNode) {
        for (const a of subNode.attributes) attrNames.add(a.key);
        addCascadingTopLevel();
      } else if (isRecordNode || isOuterNode) {
        if (schema.attributes) for (const a of schema.attributes) attrNames.add(a.key);
      } else {
        addCascadingTopLevel();
      }

      const matches = [...attrNames]
        .filter((n) => n.toLowerCase().includes(partial))
        .sort(naturalCompare);

      if (matches.length === 0) return null;

      return {
        from,
        options: matches.map((label) => {
          // Resolve the definition IN THIS NODE'S CONTEXT, not globally: an
          // attribute name can mean different things on different nodes (e.g.
          // `type` is a sub_id on the root but a node-dropdown on <slot>), and
          // the apply-behavior below — FK/string-dropdown auto-open, bool
          // default — must follow the definition that actually applies here.
          const def = findAttrDefInContext(schema, label, contextName);
          const isBool = def && (def.type === 'bool' || def.type === 'int-bool');
          const isFK = def && (def.type === 'node-dropdown' || def.type === 'node-list');
          // string-dropdown and local-dropdown open the same picker as FK after
          // completion (the host resolves their options).
          const isStringDropdown = def && def.type === 'string-dropdown';
          const isLocalDropdown = def && def.type === 'local-dropdown';
          const isYamlFK = def && (def.type === 'yaml-dropdown' || def.type === 'yaml-list');
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
                // If FK / string-dropdown / local-dropdown / yaml-FK, trigger the picker.
                if ((isFK || isStringDropdown || isLocalDropdown || isYamlFK) && onFKComplete) {
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
