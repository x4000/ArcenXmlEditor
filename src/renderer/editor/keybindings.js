/**
 * Custom input handlers for the Arcen XML Editor (CodeMirror 6).
 * - Auto-close tags on ">"
 * - Auto-escape " < > inside attribute quotes
 * - Auto-add ="" after typing = inside a tag
 * - Auto-indent on Enter
 * - Tab/Shift+Tab
 */

import { EditorView } from '@codemirror/view';
import { isInQuotes } from './xmlTokenizer';

function arcenInputHandler() {
  return EditorView.inputHandler.of((view, from, to, text) => {
    const doc = view.state.doc.toString();
    if (text.length !== 1 || from !== to) return false;

    const pos = from;
    const ch = text;

    // Auto-escape inside quotes
    if (isInQuotes(doc, pos)) {
      const escapes = { '"': '&quot;', '<': '&lt;', '>': '&gt;' };
      if (escapes[ch]) {
        if (ch === '"') {
          // If the attribute is unterminated, let the '"' through as a closing quote.
          // A '"' that opens a new attribute is always preceded by '=' (with optional space).
          // If the next '"' ahead is preceded by '=', it's an opener for another attribute,
          // meaning our current attribute has no closing quote yet.
          const nextQuote = doc.indexOf('"', pos);
          if (nextQuote === -1 || doc.slice(0, nextQuote).trimEnd().endsWith('=')) {
            return false;
          }
        }
        const esc = escapes[ch];
        view.dispatch({
          changes: { from: pos, to: pos, insert: esc },
          selection: { anchor: pos + esc.length },
        });
        return true;
      }
      return false;
    }

    // Auto-add ="" after = inside a tag
    if (ch === '=') {
      const before = doc.slice(0, pos);
      const lastOpen = before.lastIndexOf('<');
      const lastClose = before.lastIndexOf('>');
      if (lastOpen > lastClose) {
        view.dispatch({
          changes: { from: pos, to: pos, insert: '=""' },
          selection: { anchor: pos + 2 },
        });
        return true;
      }
    }

    // Auto-expand `<!` to `<!---->` with the cursor between the dashes.
    // Triggers when the user types `!` immediately after a `<` AND that `<`
    // is in a free position (between elements, in text content, or at the
    // top level) — not in the middle of writing a tag like `<foo |!bar>`.
    // We detect "free position" the same way the `=` handler detects its
    // opposite: count `<` vs `>` in the doc before the just-typed `<`. If
    // there's no unclosed tag preceding it, it's free; if there is, we
    // bail and let the `!` insert as a literal character.
    if (ch === '!' && pos > 0 && doc[pos - 1] === '<') {
      const before = doc.slice(0, pos - 1);
      const lastOpen = before.lastIndexOf('<');
      const lastClose = before.lastIndexOf('>');
      if (lastOpen <= lastClose) {
        // The '<' is already in the doc; we insert the rest of the comment.
        // Final shape: `<` + `!---->` = `<!---->`. Cursor goes between the
        // 2nd and 3rd dash so the user lands inside `<!--|-->`.
        view.dispatch({
          changes: { from: pos, to: pos, insert: '!---->' },
          selection: { anchor: pos + 3 },
        });
        return true;
      }
    }

    // Auto-close tag on ">"
    if (ch === '>') {
      if (pos > 0 && doc[pos - 1] === '/') return false;
      if (isInQuotes(doc, pos)) return false;

      const before = doc.slice(0, pos);
      const lastOpen = before.lastIndexOf('<');
      const segment = before.slice(lastOpen);
      if (segment.startsWith('</')) return false;

      const tagMatch = segment.match(/^<([\w.-]+)/);
      if (!tagMatch) return false;

      const tagName = tagMatch[1];
      const lineStart = before.lastIndexOf('\n', lastOpen);
      const lineText = before.slice(lineStart + 1);
      const indent = lineText.match(/^[\t ]*/)[0];

      const insertion = '>\n' + indent + '</' + tagName + '>';
      view.dispatch({
        changes: { from: pos, to: pos, insert: insertion },
        selection: { anchor: pos + 1 },
      });
      return true;
    }

    return false;
  });
}

function enterHandler(view) {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc.toString();

  // If inside a quoted attribute value, don't add indentation —
  // whitespace is meaningful content in string attributes
  if (isInQuotes(doc, pos)) {
    view.dispatch({
      changes: { from: pos, to: pos, insert: '\n' },
      selection: { anchor: pos + 1 },
      scrollIntoView: true,
    });
    return true;
  }

  const line = view.state.doc.lineAt(pos);
  const indent = line.text.match(/^[\t ]*/)[0];

  view.dispatch({
    changes: { from: pos, to: pos, insert: '\n' + indent },
    selection: { anchor: pos + 1 + indent.length },
    scrollIntoView: true,
  });
  return true;
}

// Resolve the inclusive range of line numbers covered by the current
// selection. If the selection ends exactly at the start of a line
// (column 0), that trailing line isn't really "selected" and is excluded
// — matches how VS Code, Sublime, etc. treat range-end-at-line-start.
function selectedLineRange(view) {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  let endLine = view.state.doc.lineAt(sel.to);
  if (sel.to > sel.from && sel.to === endLine.from && endLine.number > startLine.number) {
    endLine = view.state.doc.line(endLine.number - 1);
  }
  return { startLine, endLine, sel };
}

function tabHandler(view) {
  const { startLine, endLine, sel } = selectedLineRange(view);

  if (endLine.number > startLine.number) {
    const changes = [];
    for (let n = startLine.number; n <= endLine.number; n++) {
      const line = view.state.doc.line(n);
      changes.push({ from: line.from, to: line.from, insert: '\t' });
    }
    view.dispatch({ changes });
    return true;
  }

  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: '\t' },
    selection: { anchor: sel.from + 1 },
  });
  return true;
}

function shiftTabHandler(view) {
  const { startLine, endLine, sel } = selectedLineRange(view);

  if (endLine.number > startLine.number) {
    const changes = [];
    for (let n = startLine.number; n <= endLine.number; n++) {
      const line = view.state.doc.line(n);
      if (line.text.startsWith('\t')) {
        changes.push({ from: line.from, to: line.from + 1 });
      }
    }
    if (changes.length > 0) view.dispatch({ changes });
    return true;
  }

  const pos = sel.head;
  const doc = view.state.doc.toString();
  if (pos > 0 && doc[pos - 1] === '\t') {
    view.dispatch({
      changes: { from: pos - 1, to: pos },
      selection: { anchor: pos - 1 },
    });
  }
  return true;
}

function goToLineHandler(view) {
  // Dispatch a custom DOM event carrying the EditorView reference; the
  // window host (App.jsx / DetachedApp.jsx) listens and opens the modal.
  const ev = new CustomEvent('goToLineRequested', { detail: { view } });
  document.dispatchEvent(ev);
  return true;
}

export function createArcenKeymap() {
  return [
    { key: 'Enter', run: enterHandler },
    { key: 'Tab', run: tabHandler },
    { key: 'Shift-Tab', run: shiftTabHandler },
    { key: 'Mod-g', run: goToLineHandler, preventDefault: true },
  ];
}

export function createArcenInputHandlers() {
  return arcenInputHandler();
}
