/**
 * Attaches Visual-Studio-style search history to CodeMirror's built-in
 * search panel inputs. The panel is owned by CodeMirror, not React, so
 * we discover the inputs via DOM and attach via addEventListener — but
 * the dropdown UI is still React, rendered through a portal anchored
 * to whichever input is in play.
 *
 * Find input → 'local-find' cache. Replace input → 'local-replace' cache.
 * History is recorded when the user actually executes the action
 * (Enter in input, or click on the Find/Replace/Replace-All button).
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useHistoryDropdown } from './SearchHistoryDropdown';
import { addEntry as addHistoryEntry } from '../editor/searchHistory';

export default function LocalSearchHistory({ containerRef }) {
  const [findInputEl, setFindInputEl] = useState(null);
  const [replaceInputEl, setReplaceInputEl] = useState(null);
  const [panelEl, setPanelEl] = useState(null);

  // Watch the editor's container DOM for the search panel mounting/unmounting.
  // We use the wrapper div (set as a ref during React commit) instead of
  // CodeMirror's view.dom because viewRef.current is populated in a LATER
  // effect inside EditorPane — it's still null when our mount effect runs,
  // so a viewRef-based observer would never attach.
  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const refresh = () => {
      const panel = container.querySelector('.cm-search');
      if (!panel) {
        setPanelEl(null);
        setFindInputEl(null);
        setReplaceInputEl(null);
        return;
      }
      setPanelEl(panel);
      const inputs = panel.querySelectorAll('input[type="text"], input:not([type])');
      // First text input is find, second (if shown) is replace.
      setFindInputEl(inputs[0] || null);
      setReplaceInputEl(inputs[1] || null);
    };

    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef]);

  // Record history when the user clicks one of the panel's action buttons.
  // CodeMirror labels them by `name=` so we can identify reliably across
  // language packs. "find next/prev" record the current find value;
  // "replace/replace all" record the current replace value.
  useEffect(() => {
    if (!panelEl) return;
    const onClick = (e) => {
      const btn = e.target.closest && e.target.closest('button');
      if (!btn) return;
      const name = btn.getAttribute('name');
      if ((name === 'next' || name === 'prev' || name === 'select') && findInputEl) {
        addHistoryEntry('local-find', findInputEl.value);
      } else if ((name === 'replace' || name === 'replaceAll') && replaceInputEl) {
        addHistoryEntry('local-replace', replaceInputEl.value);
        // A replace implies a find ran — save to find history too so the
        // user who goes straight to Replace All without clicking Next
        // first still gets their search term remembered.
        if (findInputEl) addHistoryEntry('local-find', findInputEl.value);
      }
    };
    panelEl.addEventListener('click', onClick);
    return () => panelEl.removeEventListener('click', onClick);
  }, [panelEl, findInputEl, replaceInputEl]);

  return (
    <>
      {findInputEl && (
        <InputHistoryBinding
          inputEl={findInputEl}
          cacheName="local-find"
        />
      )}
      {replaceInputEl && (
        <InputHistoryBinding
          inputEl={replaceInputEl}
          cacheName="local-replace"
        />
      )}
    </>
  );
}

/**
 * One per panel input. Wires the dropdown hook to a DOM input via a
 * capture-phase keydown listener (must fire before CodeMirror's own
 * handler, since both react to Enter/arrows).
 */
function InputHistoryBinding({ inputEl, cacheName }) {
  const onApply = useCallback((value) => {
    inputEl.value = value;
    // Fire 'input' so CodeMirror's panel updates its internal search state
    // — without this the value sits in the DOM but the search hasn't seen it.
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.focus();
    // Place caret at end so the next keystroke appends rather than replacing.
    try { inputEl.setSelectionRange(value.length, value.length); } catch (_) {}
  }, [inputEl]);

  const { handleKeyDown, dropdown } = useHistoryDropdown({
    cacheName,
    position: 'below',
    onApply,
  });

  useEffect(() => {
    if (!inputEl) return;
    // Capture-phase so we beat CodeMirror's keymap on Enter/arrows.
    const onKey = (e) => {
      const consumed = handleKeyDown(e, inputEl);
      if (consumed) {
        // The hook called preventDefault. Also stop propagation so
        // CodeMirror's panel-keymap doesn't run its Enter→find action
        // when we just used Enter to commit a dropdown selection.
        e.stopPropagation();
      }
    };
    inputEl.addEventListener('keydown', onKey, true);
    return () => inputEl.removeEventListener('keydown', onKey, true);
  }, [inputEl, handleKeyDown]);

  // Record history when user presses Enter without the dropdown intercepting.
  // This runs in bubble phase, so by the time it fires we know the dropdown
  // didn't consume the key (it would have stopPropagation'd above).
  useEffect(() => {
    if (!inputEl) return;
    const onKey = (e) => {
      if (e.key === 'Enter' && !e.defaultPrevented) {
        addHistoryEntry(cacheName, inputEl.value);
      }
    };
    inputEl.addEventListener('keydown', onKey);
    return () => inputEl.removeEventListener('keydown', onKey);
  }, [inputEl, cacheName]);

  return dropdown;
}
