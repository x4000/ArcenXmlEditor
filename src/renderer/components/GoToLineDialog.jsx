import React, { useEffect, useRef, useState } from 'react';

// Tiny Visual-Studio-style "Go To Line" modal. Single numeric input.
// Mounted once per window host (App.jsx, DetachedApp.jsx). Opens in
// response to a `goToLineRequested` custom event carrying a CodeMirror
// EditorView reference as event.detail.view.

export default function GoToLineDialog() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(null);
  const [text, setText] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (!e.detail?.view) return;
      setView(e.detail.view);
      setText('');
      setOpen(true);
    };
    document.addEventListener('goToLineRequested', handler);
    return () => document.removeEventListener('goToLineRequested', handler);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      // Close on any click outside the dialog.
      if (!e.target.closest('.goto-line-dialog')) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!open || !view) return null;

  const totalLines = view.state.doc.lines;

  const jump = () => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1) { setOpen(false); return; }
    const line = Math.min(Math.max(1, n), totalLines);
    const pos = view.state.doc.line(line).from;
    view.dispatch({
      selection: { anchor: pos, head: pos },
      effects: [],
      scrollIntoView: true,
    });
    view.focus();
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jump(); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); view?.focus(); }
  };

  return (
    <div
      className="goto-line-dialog"
      style={{
        position: 'fixed',
        top: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--bg, #252526)',
        color: 'var(--text, #e0e0e0)',
        border: '1px solid var(--accent, #0e639c)',
        borderRadius: 4,
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 220,
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        zIndex: 9999,
      }}
    >
      <label style={{ fontSize: 11, opacity: 0.8 }}>
        Line number (1–{totalLines}):
      </label>
      <input
        ref={inputRef}
        type="number"
        min={1}
        max={totalLines}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        style={{
          padding: '4px 6px',
          fontSize: 13,
          background: 'var(--sidebar-bg, #1e1e1e)',
          color: 'var(--text, #e0e0e0)',
          border: '1px solid var(--border, #444)',
          borderRadius: 2,
          outline: 'none',
        }}
      />
    </div>
  );
}
