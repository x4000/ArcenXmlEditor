import React from 'react';

export default function NodeDeleteDialog({ tagName, x, y, onConfirm, onCancel }) {
  const posX = Math.min(x || 200, window.innerWidth - 220);
  const posY = Math.min(y || 200, window.innerHeight - 60);

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          position: 'fixed', top: posY, left: posX,
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '8px 4px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={{ padding: '0 8px', fontSize: 12, color: 'var(--text)' }}>
          Delete <strong>{tagName}</strong>?
        </span>
        <div
          style={{
            padding: '4px 14px', background: '#e53935', color: '#fff',
            borderRadius: 3, cursor: 'pointer', fontSize: 12, userSelect: 'none',
          }}
          onClick={onConfirm}
        >
          Yes
        </div>
        <div
          style={{
            padding: '4px 10px', background: 'var(--border)', color: 'var(--text)',
            borderRadius: 3, cursor: 'pointer', fontSize: 12, userSelect: 'none',
          }}
          onClick={onCancel}
        >
          No
        </div>
      </div>
    </div>
  );
}
