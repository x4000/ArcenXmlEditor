/**
 * FK Dropdown (single-select) and MultiSelect picker components.
 * Filterable, arrow-key navigable, scroll-to-selection.
 * Tab key captured to prevent editor tab insertion.
 */

import React, { useState, useEffect, useRef, useMemo, useLayoutEffect } from 'react';

export function FKDropdown({ options, value, x, y, onSelect, onClose, onNavigate }) {
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  const filtered = options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSel(0); }, [filter]);
  useEffect(() => {
    if (scrollRef.current?.children[sel]) {
      scrollRef.current.children[sel].scrollIntoView({ block: 'nearest' });
    }
  }, [sel]);

  // Click-outside to close (capture phase so CodeMirror can't swallow it)
  // + document-level Escape so it works regardless of where focus is.
  useEffect(() => {
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        // Swallow the event so clicking in the editor to dismiss the dropdown
        // doesn't also move the cursor / start another delayed-dropdown-open.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const tid = setTimeout(() => {
      document.addEventListener('mousedown', down, true);
      document.addEventListener('keydown', key, true);
    }, 10);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  function handleKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (filtered.length > 0) { onSelect(filtered[Math.min(sel, filtered.length - 1)]); onClose(); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); }
  }

  // Initial position: assume the dropdown fits below the click. After mount we
  // measure the actual height and flip above if it would overflow the viewport.
  // Using the real height (not a hardcoded 310) keeps short dropdowns anchored
  // near the click instead of floating far above it.
  const [pos, setPos] = useState({
    left: Math.min(x || 100, window.innerWidth - 260),
    top: y,
  });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let top = y;
    if (y + rect.height > window.innerHeight - 4) {
      top = Math.max(4, y - rect.height);
    }
    const left = Math.min(Math.max(4, x || 100), Math.max(4, window.innerWidth - rect.width - 4));
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  return (
    <div ref={ref} style={{
      position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000,
      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
      maxHeight: 300, display: 'flex', flexDirection: 'column', minWidth: 230,
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    }}>
      <input
        ref={inputRef}
        placeholder="Filter... (arrows to navigate)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={handleKey}
        style={{
          width: '100%', background: 'var(--sidebar-bg)', border: 'none',
          borderBottom: '1px solid var(--border)', padding: '7px 10px',
          color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box',
          fontFamily: 'inherit', flexShrink: 0,
        }}
      />
      <div ref={scrollRef} style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.slice(0, 200).map((o, idx) => (
          <div
            key={o}
            style={{
              padding: '4px 12px', cursor: 'pointer', fontSize: 12,
              background: idx === sel ? 'var(--selection)' : o === value ? 'var(--accent-bg)' : 'transparent',
              color: 'var(--text)',
            }}
            onClick={(e) => {
              e.stopPropagation();
              if ((e.ctrlKey || e.metaKey) && onNavigate) { onNavigate(o); onClose(); return; }
              onSelect(o); onClose();
            }}
            onMouseEnter={() => setSel(idx)}
          >
            {o}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>No matches</div>}
      </div>
    </div>
  );
}

export function FKMultiSelect({ options, currentValues, x, y, onToggle, onClose, onNavigate }) {
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  const filtered = options.filter((o) => o.toLowerCase().includes(filter.toLowerCase()));
  const activeSet = useMemo(() => new Set(currentValues), [currentValues]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSel(0); }, [filter]);
  useEffect(() => {
    if (scrollRef.current?.children[sel]) {
      scrollRef.current.children[sel].scrollIntoView({ block: 'nearest' });
    }
  }, [sel]);

  useEffect(() => {
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        // Swallow the event so clicking in the editor to dismiss the dropdown
        // doesn't also move the cursor / start another delayed-dropdown-open.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const tid = setTimeout(() => {
      document.addEventListener('mousedown', down, true);
      document.addEventListener('keydown', key, true);
    }, 10);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose]);

  function handleKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (filtered.length > 0) { onToggle(filtered[Math.min(sel, filtered.length - 1)]); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); }
  }

  // Initial position: assume the dropdown fits below the click. After mount we
  // measure the actual height and flip above if it would overflow the viewport.
  // Using the real height (not a hardcoded 310) keeps short dropdowns anchored
  // near the click instead of floating far above it.
  const [pos, setPos] = useState({
    left: Math.min(x || 100, window.innerWidth - 260),
    top: y,
  });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    let top = y;
    if (y + rect.height > window.innerHeight - 4) {
      top = Math.max(4, y - rect.height);
    }
    const left = Math.min(Math.max(4, x || 100), Math.max(4, window.innerWidth - rect.width - 4));
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y]);

  return (
    <div ref={ref} style={{
      position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000,
      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
      maxHeight: 300, display: 'flex', flexDirection: 'column', minWidth: 230,
      boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    }}>
      <input
        ref={inputRef}
        placeholder="Filter... (arrows to navigate)"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={handleKey}
        style={{
          width: '100%', background: 'var(--sidebar-bg)', border: 'none',
          borderBottom: '1px solid var(--border)', padding: '7px 10px',
          color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box',
          fontFamily: 'inherit', flexShrink: 0,
        }}
      />
      <div style={{
        padding: '3px 10px', fontSize: 11, color: 'var(--text-dim)',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        Click to toggle · Enter to select
      </div>
      <div ref={scrollRef} style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.slice(0, 200).map((o, idx) => (
          <div
            key={o}
            style={{
              padding: '4px 12px', cursor: 'pointer', fontSize: 12,
              background: idx === sel ? 'var(--selection)' : 'transparent',
              color: 'var(--text)',
            }}
            onClick={(e) => {
              e.stopPropagation();
              if ((e.ctrlKey || e.metaKey) && onNavigate) { onNavigate(o); onClose(); return; }
              onToggle(o);
            }}
            onMouseEnter={() => setSel(idx)}
          >
            {activeSet.has(o) ? '☑ ' : '☐ '}{o}
          </div>
        ))}
        {filtered.length === 0 && <div style={{ padding: '8px 12px', color: 'var(--text-dim)' }}>No matches</div>}
      </div>
    </div>
  );
}
