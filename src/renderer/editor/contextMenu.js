/**
 * Right-click context menu extension for the Arcen XML Editor.
 *
 * Priority order:
 * 1. Spelling error → show suggestions + "Add to Dictionary"
 * 2. Attribute name/value → immediate deletion (no confirmation)
 * 3. Tag name → React confirmation dialog via callback
 * 4. Non-functional areas → suppress browser context menu
 */

import { EditorView } from '@codemirror/view';
import { tokenize, buildAttrMap, findNodeEnd } from './xmlTokenizer';
import { getForbiddenCharFix } from './spellcheck';

/**
 * Create the context menu extension.
 *
 * callbacks: {
 *   showNodeDeleteDialog(view, tagName, precomputedResult, deletePos, x, y)
 *   showSpellingMenu(view, word, wordFrom, wordTo, x, y) — optional, for spellcheck
 * }
 */
export function createContextMenu(getSchema, callbacks) {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      event.preventDefault();

      const schema = getSchema();
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return true;

      // ── Check for spelling error decoration at click position ──
      if (callbacks.showSpellingMenu) {
        const spellingHit = findSpellingErrorAtPos(view, pos, event);
        if (spellingHit) {
          callbacks.showSpellingMenu(
            view,
            spellingHit.word,
            spellingHit.from,
            spellingHit.to,
            event.clientX,
            event.clientY
          );
          return true;
        }
      }

      const doc = view.state.doc.toString();
      const tokens = tokenize(doc);
      const attrMap = buildAttrMap(tokens, schema);

      // ── Check attribute name hit (only name, not value) ──
      for (const attr of attrMap) {
        if (pos >= attr.ns2 && pos <= attr.ne) {
          // Immediate deletion — no confirmation
          let fs = attr.ns2;
          let fe = attr.ve + 1; // +1 for closing quote

          // Eat one trailing space (preserves indentation)
          if (fe < doc.length && doc[fe] === ' ') {
            fe++;
          } else if (fs > 0 && doc[fs - 1] === ' ') {
            fs--; // fallback: eat space before
          }

          view.dispatch({
            changes: { from: fs, to: fe },
            selection: { anchor: fs },
          });
          return true;
        }
      }

      // ── Check tag name hit ──
      for (let j = 0; j < tokens.length; j++) {
        if (tokens[j].c !== 'tg') continue;
        if (pos < tokens[j].p || pos >= tokens[j].p + tokens[j].s.length) continue;

        const tagName = tokens[j].s;

        // Find the opening bracket
        const ob = doc.lastIndexOf('<', tokens[j].p);
        if (ob >= 0 && ob + 1 < doc.length && doc[ob + 1] === '/') continue; // skip closing tags

        const nodeEnd = findNodeEnd(doc, ob);

        // Expand to include leading whitespace up to previous newline
        let ns = ob;
        while (ns > 0 && (doc[ns - 1] === '\t' || doc[ns - 1] === ' ')) ns--;
        if (ns > 0 && doc[ns - 1] === '\n') ns--;

        // Expand to eat trailing newline
        let ne = nodeEnd;
        if (ne < doc.length && doc[ne] === '\n') ne++;

        const result = doc.slice(0, ns) + doc.slice(ne);

        if (callbacks.showNodeDeleteDialog) {
          callbacks.showNodeDeleteDialog(view, tagName, result, ns, event.clientX, event.clientY);
        }
        return true;
      }

      return true; // suppress browser menu on all areas
    },
  });
}

/**
 * Find a spelling error decoration at the given document position.
 * Uses DOM lookup — checks if the element at the click coordinates has the
 * cm-spelling-error class, then resolves the word boundaries from the document.
 *
 * Returns { word, from, to } if found, null otherwise.
 */
export function findSpellingErrorAtPos(view, pos, event) {
  // If we have the event, check if the click target is a spelling error span
  if (event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (el && el.closest('.cm-spelling-error')) {
      // Found a spelling error span — now figure out the word boundaries
      // by scanning the document text around the click position
      const doc = view.state.doc;
      const line = doc.lineAt(pos);
      const lineText = line.text;
      const col = pos - line.from;

      // Find word boundaries at the cursor position
      let start = col, end = col;
      while (start > 0 && /[a-zA-Z'\u2019]/.test(lineText[start - 1])) start--;
      while (end < lineText.length && /[a-zA-Z'\u2019]/.test(lineText[end])) end++;

      // Strip leading/trailing quotes
      while (start < end && (lineText[start] === "'" || lineText[start] === '\u2019')) start++;
      while (end > start && (lineText[end - 1] === "'" || lineText[end - 1] === '\u2019')) end--;

      if (end > start) {
        const from = line.from + start;
        const to = line.from + end;
        const word = doc.sliceString(from, to);
        return { word, from, to };
      }

      // Word-boundary search came up empty — the squiggle is most likely on
      // a single forbidden character (smart quote, em-dash, ellipsis…) which
      // isn't a letter and so has no "word." Treat the char itself as the
      // hit so the menu can offer a Replace action.
      const ch = col < lineText.length ? lineText[col] : '';
      if (ch && getForbiddenCharFix(ch)) {
        const from = line.from + col;
        return { word: ch, from, to: from + 1 };
      }
    }
  }
  return null;
}
