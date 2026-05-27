import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { getEntries } from '../editor/searchHistory';

/**
 * Hook that adds Visual-Studio-style history dropdown behavior to a text input.
 *
 * Keyboard contract (matches the user spec, not stock OS combobox):
 *   - ↓ when closed:    open the dropdown with most-recent entry highlighted.
 *                       Does nothing if cache is empty.
 *   - ↑ when closed:    nothing — by design.
 *   - ↓ when open:      move highlight toward less-recent (down the list).
 *                       Stops at the bottom.
 *   - ↑ when open:      move highlight toward more-recent. If already on the
 *                       top entry, close the dropdown (no Esc needed).
 *   - Enter / Space:    apply the highlighted entry, close.
 *   - Esc:              close without applying.
 *   - Any other key:    close the dropdown but let the key flow through to
 *                       the input so typing resumes naturally.
 *   - Click outside:    close.
 *   - Click on entry:   apply, close.
 *
 * Returns { handleKeyDown, dropdown, isOpen }.
 *  - handleKeyDown(e, inputEl) — call from the input's onKeyDown FIRST. Returns
 *    true if the event was consumed; in that case the caller should not run
 *    its own Enter/Escape/etc. logic for that event.
 *  - dropdown — JSX (a portal) to render somewhere in the tree. It's anchored
 *    to the input via getBoundingClientRect and re-anchors on open, so where
 *    you put the JSX doesn't matter visually.
 *  - isOpen — useful if the caller wants to grey out other UI while open.
 */
export function useHistoryDropdown({ cacheName, position = 'above', onApply }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [anchorRect, setAnchorRect] = useState(null);
  const inputElRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    setSelectedIndex(-1);
    setEntries([]);
    setAnchorRect(null);
  }, []);

  // Close on click outside the input or the dropdown itself.
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (inputElRef.current && inputElRef.current.contains(e.target)) return;
      const inDropdown = e.target.closest && e.target.closest('[data-search-history-dropdown]');
      if (inDropdown) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  // Re-anchor dropdown when window resizes or scrolls — without this it
  // stays at the original spot while the input moves out from under it.
  useEffect(() => {
    if (!open || !inputElRef.current) return;
    const reanchor = () => {
      if (inputElRef.current) setAnchorRect(inputElRef.current.getBoundingClientRect());
    };
    window.addEventListener('resize', reanchor);
    window.addEventListener('scroll', reanchor, true);
    return () => {
      window.removeEventListener('resize', reanchor);
      window.removeEventListener('scroll', reanchor, true);
    };
  }, [open]);

  const handleKeyDown = useCallback((e, inputEl) => {
    inputElRef.current = inputEl;

    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Always preventDefault on the arrows in a single-line <input> —
        // Chrome's default behavior is to jump the caret to end (Down) or
        // start (Up), which is unhelpful here even when there's no
        // history to show.
        e.preventDefault();
        const list = getEntries(cacheName);
        if (list.length === 0) return true;
        setEntries(list);
        // Both arrows open at the top (most recent) — matches VS, and the
        // user's most-likely target is always the most-recent entry.
        // Up-at-top-closes still applies once open, so a stray Up after
        // opening dismisses; that's intentional and quick.
        setSelectedIndex(0);
        setAnchorRect(inputEl.getBoundingClientRect());
        setOpen(true);
        return true;
      }
      return false;
    }

    // Dropdown is open.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, entries.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex <= 0) {
        // At top + Up = close (no Esc needed, per spec).
        close();
      } else {
        setSelectedIndex(i => i - 1);
      }
      return true;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      if (selectedIndex >= 0 && entries[selectedIndex] !== undefined) {
        e.preventDefault();
        onApply(entries[selectedIndex]);
        close();
        return true;
      }
      return false;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return true;
    }
    // Any other key: close dropdown so the user can resume typing, but DO
    // NOT consume the event — let the character land in the input.
    close();
    return false;
  }, [open, entries, selectedIndex, cacheName, onApply, close]);

  const dropdown = open && anchorRect ? (
    <DropdownPortal
      entries={entries}
      selectedIndex={selectedIndex}
      anchorRect={anchorRect}
      position={position}
      onSelect={(i) => { onApply(entries[i]); close(); }}
      onHover={setSelectedIndex}
    />
  ) : null;

  return { handleKeyDown, dropdown, isOpen: open };
}

function DropdownPortal({ entries, selectedIndex, anchorRect, position, onSelect, onHover }) {
  // Position via fixed coords from getBoundingClientRect so we don't care
  // about the input's containing block. zIndex is high enough to clear the
  // search panel and any tab bar.
  const style = {
    position: 'fixed',
    left: anchorRect.left,
    width: Math.max(anchorRect.width, 200),
    maxHeight: 240,
    overflowY: 'auto',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 3,
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    zIndex: 10000,
    fontSize: 12,
    fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace",
    padding: '2px 0',
  };
  if (position === 'above') {
    style.bottom = window.innerHeight - anchorRect.top + 2;
  } else {
    style.top = anchorRect.bottom + 2;
  }

  return ReactDOM.createPortal(
    <div data-search-history-dropdown style={style}>
      {entries.map((entry, i) => (
        <div
          key={i}
          // mouseDown (not click) so the input doesn't lose focus before
          // we apply — focus loss would also close the dropdown via the
          // outside-click handler, racing with our select.
          onMouseDown={(e) => { e.preventDefault(); onSelect(i); }}
          onMouseEnter={() => onHover(i)}
          style={{
            padding: '4px 10px',
            cursor: 'pointer',
            background: i === selectedIndex ? 'var(--accent, #2e6cb6)' : 'transparent',
            color: i === selectedIndex ? '#fff' : 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry}
        </div>
      ))}
    </div>,
    document.body
  );
}
