import React, { useEffect, useRef, useState } from 'react';

// Rename-ID modal. Mounted once in App.jsx. Opens when an editor pane
// dispatches `idRenameRequested` (fired by F2 while the cursor is on a
// central-identifier attribute value). Calls `onConfirm(oldId, newId,
// sourceRelPath)` when the user submits; App.jsx performs the batch rename.
export default function RenameIdDialog({ onConfirm }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null); // { oldId, relativePath }
  const [newId, setNewId] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (!e.detail?.oldId || !e.detail?.relativePath) return;
      setState({ oldId: e.detail.oldId, relativePath: e.detail.relativePath });
      setNewId(e.detail.oldId);
      setOpen(true);
    };
    document.addEventListener('idRenameRequested', handler);
    return () => document.removeEventListener('idRenameRequested', handler);
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
      if (!e.target.closest('.rename-id-dialog')) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!open || !state) return null;

  const trimmed = newId.trim();
  const canConfirm = !!trimmed && trimmed !== state.oldId;

  const handleConfirm = () => {
    if (!canConfirm) { setOpen(false); return; }
    onConfirm(state.oldId, trimmed, state.relativePath);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  const inputStyle = {
    padding: '4px 6px',
    fontSize: 13,
    background: 'var(--sidebar-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 2,
    outline: 'none',
    fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace",
  };

  return (
    <div
      className="rename-id-dialog"
      style={{
        position: 'fixed',
        top: 80,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--bg)',
        color: 'var(--text)',
        border: '1px solid var(--accent)',
        borderRadius: 4,
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 320,
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
        zIndex: 9999,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600 }}>Rename ID</div>
      <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>Current ID:</label>
      <div style={{ ...inputStyle, cursor: 'default', color: 'var(--text-dim)' }}>
        {state.oldId}
      </div>
      <label style={{ fontSize: 11, color: 'var(--text-dim)' }}>New ID:</label>
      <input
        ref={inputRef}
        type="text"
        value={newId}
        onChange={(e) => setNewId(e.target.value)}
        onKeyDown={onKeyDown}
        style={inputStyle}
      />
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -2 }}>
        Also updates FK references across all open files.
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 2 }}>
        <button
          onClick={() => setOpen(false)}
          style={{
            padding: '3px 10px', fontSize: 12,
            background: 'var(--sidebar-bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          style={{
            padding: '3px 10px', fontSize: 12,
            background: 'var(--accent)', color: '#fff',
            border: 'none', borderRadius: 3,
            cursor: canConfirm ? 'pointer' : 'default',
            opacity: canConfirm ? 1 : 0.45,
          }}
        >
          Rename
        </button>
      </div>
    </div>
  );
}
