/**
 * "Search in Selection" extension for CodeMirror 6.
 *
 * Adds an "In selection" checkbox to CM6's search panel.
 * When active, find-next/prev and replace-all are restricted
 * to the current selection range at the time each operation runs.
 */

import { EditorView, ViewPlugin } from '@codemirror/view';
import { EditorSelection, StateField, StateEffect } from '@codemirror/state';
import {
  SearchCursor, getSearchQuery, setSearchQuery,
  findNext, findPrevious, replaceNext, replaceAll,
  openSearchPanel, closeSearchPanel, searchPanelOpen,
} from '@codemirror/search';

// ─── State: "in selection" toggle ────────────────────────────────────

const setInSelection = StateEffect.define();
const setWildcard = StateEffect.define();

const inSelectionField = StateField.define({
  create() { return false; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setInSelection)) return e.value;
    }
    return value;
  },
});

const wildcardField = StateField.define({
  create() { return false; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setWildcard)) return e.value;
    }
    return value;
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────

/** Get the current search query spec from CM6's search state */
function getQuery(view) {
  return getSearchQuery(view.state);
}

/** Build a regex or string matcher from the search query */
function buildMatcher(query, from, to, state) {
  const search = query.search;
  if (!search) return null;

  if (query.regexp) {
    try {
      const flags = query.caseSensitive ? 'g' : 'gi';
      const re = new RegExp(search, flags);
      return { re, from, to };
    } catch (e) { return null; }
  }

  return { search, caseSensitive: query.caseSensitive, from, to };
}

/**
 * Find all matches within [from, to] range.
 */
function findMatchesInRange(state, query, from, to, isWildcard) {
  const doc = state.doc.toString();
  const matches = [];

  let search = query.search;
  if (!search) return matches;

  let flags = 'g';
  if (!query.caseSensitive) flags += 'i';

  let re;
  if (isWildcard) {
    // Wildcard: escape everything except *, then convert * to .*
    const escaped = search.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try { re = new RegExp(escaped, flags); } catch (e) { return matches; }
  } else if (query.regexp) {
    try { re = new RegExp(search, flags); } catch (e) { return matches; }
  } else {
    re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }

  // Only search within the range
  const slice = doc.slice(from, to);
  let m;
  while ((m = re.exec(slice)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    matches.push({ from: from + m.index, to: from + m.index + m[0].length });
  }
  return matches;
}

// ─── Custom commands that respect "in selection" ─────────────────────

function needsScoped(view) {
  return view.state.field(inSelectionField) || view.state.field(wildcardField);
}

function getScopedRange(view) {
  const isInSel = view.state.field(inSelectionField);
  const sel = view.state.selection.main;
  return {
    from: isInSel && sel.from !== sel.to ? sel.from : 0,
    to: isInSel && sel.from !== sel.to ? sel.to : view.state.doc.length,
    isWild: view.state.field(wildcardField),
  };
}

function scopedFindNext(view) {
  if (!needsScoped(view)) return findNext(view);
  const query = getQuery(view);
  if (!query.search) return false;
  const { from, to, isWild } = getScopedRange(view);
  const matches = findMatchesInRange(view.state, query, from, to, isWild);
  if (!matches.length) return false;
  const cursor = view.state.selection.main.to;
  let next = matches.find(m => m.from >= cursor) || matches[0];
  view.dispatch({ selection: EditorSelection.single(next.from, next.to), scrollIntoView: true, userEvent: 'select.search' });
  return true;
}

function scopedFindPrevious(view) {
  if (!needsScoped(view)) return findPrevious(view);
  const query = getQuery(view);
  if (!query.search) return false;
  const { from, to, isWild } = getScopedRange(view);
  const matches = findMatchesInRange(view.state, query, from, to, isWild);
  if (!matches.length) return false;
  const cursor = view.state.selection.main.from;
  let prev = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].to <= cursor) { prev = matches[i]; break; }
  }
  if (!prev) prev = matches[matches.length - 1];
  view.dispatch({ selection: EditorSelection.single(prev.from, prev.to), scrollIntoView: true, userEvent: 'select.search' });
  return true;
}

function scopedReplaceNext(view) {
  if (!needsScoped(view)) return replaceNext(view);
  const query = getQuery(view);
  if (!query.search) return false;
  const { from, to, isWild } = getScopedRange(view);
  const matches = findMatchesInRange(view.state, query, from, to, isWild);
  if (!matches.length) return false;
  const cursor = view.state.selection.main.from;
  const match = matches.find(m => m.from >= cursor) || matches[0];
  const replaceValue = query.replace || '';
  view.dispatch({ changes: { from: match.from, to: match.to, insert: replaceValue }, userEvent: 'input.replace' });
  return true;
}

function scopedReplaceAll(view) {
  if (!needsScoped(view)) return replaceAll(view);
  const query = getQuery(view);
  if (!query.search) return false;
  const { from, to, isWild } = getScopedRange(view);
  const matches = findMatchesInRange(view.state, query, from, to, isWild);
  if (!matches.length) return false;
  const replaceValue = query.replace || '';

  // Build changes from last to first to preserve positions
  const changes = matches.map(m => ({
    from: m.from, to: m.to, insert: replaceValue,
  }));

  view.dispatch({
    changes,
    userEvent: 'input.replace.all',
  });
  return true;
}

// ─── Checkbox injection via DOM observer ─────────────────────────────

const inSelectionPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.checkbox = null;
      this.observer = new MutationObserver(() => this.injectCheckbox());
      this.observer.observe(view.dom.closest('.cm-editor') || view.dom, {
        childList: true, subtree: true,
      });
    }

    update(update) {
      // Keep toggle button states in sync
      if (this._toggleBtns) {
        for (const btn of Object.values(this._toggleBtns)) {
          if (btn && btn._update) btn._update();
        }
      }
      this.injectCheckbox();
    }

    injectCheckbox() {
      const editor = this.view.dom.closest('.cm-editor');
      if (!editor) return;
      const panel = editor.querySelector('.cm-search');
      if (!panel) { this.checkbox = null; this.injected = false; return; }
      if (this.injected && panel.querySelector('.cm-custom-toggles')) return;

      // Intercept next/prev/replace buttons for wildcard and in-selection
      this.interceptButtons(panel);

      // Restyle existing CM6 labels as toggle buttons and add our custom ones
      // CM6 labels: regexp (re), case (case), word (word) — hide originals
      const origLabels = panel.querySelectorAll('label');
      const labelMap = {};
      for (const lbl of origLabels) {
        const text = lbl.textContent.trim().toLowerCase();
        if (text.includes('regexp') || text.includes('re')) labelMap.re = lbl;
        else if (text.includes('case')) labelMap.case = lbl;
        else if (text.includes('word')) labelMap.word = lbl;
        lbl.style.display = 'none';
      }

      // Create toggle button container
      const container = document.createElement('span');
      container.className = 'cm-custom-toggles';
      container.style.cssText = 'display: inline-flex; gap: 4px; margin-left: 4px;';

      const makeToggle = (abbr, title, getChecked, toggle) => {
        const btn = document.createElement('span');
        const update = () => {
          const active = getChecked();
          btn.style.cssText = `
            padding: 2px 6px; cursor: pointer; font-size: 11px; font-weight: 700;
            border: 1px solid rgba(0,0,0,0.2); border-radius: 3px; user-select: none;
            display: inline-block; text-align: center; min-width: 22px;
            background: ${active ? 'var(--tab-bg)' : 'rgba(0,0,0,0.06)'};
            color: ${active ? '#fff' : 'var(--text-dim)'};
          `;
        };
        btn.textContent = abbr;
        btn.title = title;
        update();
        btn.addEventListener('click', () => { toggle(); update(); });
        btn._update = update;
        return btn;
      };

      // Wildcard toggle — uses state field, our scoped commands handle the regex conversion
      const wcBtn = makeToggle('*?', 'Wildcard',
        () => this.view.state.field(wildcardField),
        () => {
          const newVal = !this.view.state.field(wildcardField);
          this.view.dispatch({ effects: setWildcard.of(newVal) });
          // Wildcard and regex are mutually exclusive
          if (newVal && labelMap.re) {
            const reInput = labelMap.re.querySelector('input');
            if (reInput && reInput.checked) reInput.click();
          }
        }
      );

      // Regex
      const reBtn = labelMap.re ? makeToggle('.*', 'Regex',
        () => labelMap.re.querySelector('input')?.checked,
        () => {
          labelMap.re.querySelector('input')?.click();
          this.view.dispatch({ effects: setWildcard.of(false) });
        }
      ) : null;

      // Match case
      const caseBtn = labelMap.case ? makeToggle('Aa', 'Match Case',
        () => labelMap.case.querySelector('input')?.checked,
        () => labelMap.case.querySelector('input')?.click()
      ) : null;

      // By word
      const wordBtn = labelMap.word ? makeToggle('ab', 'Whole Word',
        () => labelMap.word.querySelector('input')?.checked,
        () => labelMap.word.querySelector('input')?.click()
      ) : null;

      // In selection
      const selBtn = makeToggle('sel', 'In Selection',
        () => this.view.state.field(inSelectionField),
        () => this.view.dispatch({ effects: setInSelection.of(!this.view.state.field(inSelectionField)) })
      );

      // Order: wildcard, regex, match case, by word, in selection
      if (wcBtn) container.appendChild(wcBtn);
      if (reBtn) container.appendChild(reBtn);
      if (caseBtn) container.appendChild(caseBtn);
      if (wordBtn) container.appendChild(wordBtn);
      container.appendChild(selBtn);

      // Insert before the first <br>
      const firstBr = panel.querySelector('br');
      if (firstBr) {
        firstBr.parentElement.insertBefore(container, firstBr);
      } else {
        panel.appendChild(container);
      }

      this.checkbox = container;
      this.injected = true;
      this._toggleBtns = { wcBtn, reBtn, caseBtn, wordBtn, selBtn };
    }

    interceptButtons(panel) {
      // Add Enter-to-replace-all on the replace input field
      const inputs = panel.querySelectorAll('input[type="text"], input:not([type])');
      if (inputs.length >= 2 && !inputs[1]._enterReplace) {
        inputs[1]._enterReplace = true;
        inputs[1].addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            // If text is selected, just deselect
            if (inputs[1].selectionStart !== inputs[1].selectionEnd) {
              inputs[1].setSelectionRange(inputs[1].selectionEnd, inputs[1].selectionEnd);
            }
            scopedReplaceAll(this.view);
          }
        }, true);
      }

      const buttons = panel.querySelectorAll('button');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        // Intercept next/prev buttons for wildcard support
        if (text === 'next' && !btn._scopedNext) {
          btn._scopedNext = true;
          btn.addEventListener('click', (e) => {
            if (needsScoped(this.view)) {
              e.stopImmediatePropagation();
              e.preventDefault();
              scopedFindNext(this.view);
            }
          }, true);
        }
        if ((text === 'previous' || text === 'prev') && !btn._scopedPrev) {
          btn._scopedPrev = true;
          btn.addEventListener('click', (e) => {
            if (needsScoped(this.view)) {
              e.stopImmediatePropagation();
              e.preventDefault();
              scopedFindPrevious(this.view);
            }
          }, true);
        }
        if (text === 'replace' && !btn._scopedReplace) {
          btn._scopedReplace = true;
          btn.addEventListener('click', (e) => {
            if (needsScoped(this.view)) {
              e.stopImmediatePropagation();
              e.preventDefault();
              scopedReplaceNext(this.view);
            }
          }, true);
        }
        if (text === 'replace all' && !btn._scopedReplaceAll) {
          btn._scopedReplaceAll = true;
          btn.addEventListener('click', (e) => {
            if (needsScoped(this.view)) {
              e.stopImmediatePropagation();
              e.preventDefault();
              scopedReplaceAll(this.view);
            }
          }, true);
        }
      }
    }

    destroy() {
      this.observer.disconnect();
    }
  }
);

// ─── Export ──────────────────────────────────────────────────────────

/**
 * Create the full "in selection" extension.
 * Include in your extensions array. The keybindings must come BEFORE
 * the default searchKeymap to intercept the commands.
 */
export function createInSelectionExtension() {
  return [inSelectionField, wildcardField, inSelectionPlugin];
}

/**
 * Keybindings that override CM6's search commands with scoped versions.
 * Must be placed BEFORE searchKeymap in the keymap array.
 */
export const inSelectionKeymap = [
  { key: 'F3', run: scopedFindNext, shift: scopedFindPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-g', run: scopedFindNext, shift: scopedFindPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Enter', run: scopedFindNext, scope: 'search-panel', preventDefault: true },
];

export { inSelectionField, setInSelection, scopedReplaceAll, scopedReplaceNext };
