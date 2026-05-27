import React, { useEffect, useState, useCallback, useLayoutEffect, useRef } from 'react';

// Modal shown whenever the user clicks any button that changes the data
// root. Lists recent roots first, then "Other location…" at the bottom.
// Scrolls the recent-list when there are more than ~10 entries.
//
// Props:
//   currentRoot — absolute path of the currently-loaded root (highlighted
//                 in the list, click is a no-op).
//   anchor      — optional { x, y } of the click that opened the picker
//                 (in viewport pixels). The modal centers itself on that
//                 point and clamps to the viewport, so it opens near the
//                 user's cursor — a status-bar click pulls it toward the
//                 bottom-right, a centered empty-state click keeps it
//                 centered. Without an anchor the modal appears
//                 top-center.
//   onClose     — close the modal without switching.
//   onPicked(newRoot) — called after the root is successfully switched;
//                 the host reloads the window.
export default function DataRootPicker({ currentRoot, anchor, onClose, onPicked }) {
  const [recent, setRecent] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.arcenApi.getRecentDataRoots();
        if (!cancelled) setRecent(Array.isArray(list) ? list : []);
      } catch (e) {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);

  const pickRecent = useCallback(async (absPath) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.arcenApi.setDataRoot(absPath);
      if (result && typeof result === 'object' && result.error) {
        setError(result.error);
        // Refresh the list in case the server dropped a dead entry.
        const list = await window.arcenApi.getRecentDataRoots();
        setRecent(Array.isArray(list) ? list : []);
      } else if (typeof result === 'string') {
        onPicked(result);
      } else {
        setError('Failed to switch to that folder.');
      }
    } catch (e) {
      setError(e?.message || 'Failed to switch to that folder.');
    } finally {
      setBusy(false);
    }
  }, [busy, onPicked]);

  const pickOther = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const newRoot = await window.arcenApi.selectDataRoot();
      if (newRoot) onPicked(newRoot);
    } catch (e) {
      setError(e?.message || 'Failed to pick a folder.');
    } finally {
      setBusy(false);
    }
  }, [busy, onPicked]);

  const normalize = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();
  const currentKey = normalize(currentRoot);

  const ROW_HEIGHT = 38;
  const MAX_VISIBLE_ROWS = 10;
  const MARGIN = 12; // keep the modal this far from the viewport edges

  // Measure the modal after render and position it centered on the anchor
  // click (clamped to the viewport). Runs again if `recent` flips from
  // null → array, since the modal's height grows once the list renders.
  const modalRef = useRef(null);
  const [pos, setPos] = useState(null); // null = default top-center
  useLayoutEffect(() => {
    if (!anchor || !modalRef.current) return;
    const rect = modalRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.x - rect.width / 2;
    let top = anchor.y - rect.height / 2;
    left = Math.max(MARGIN, Math.min(left, vw - rect.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - rect.height - MARGIN));
    setPos({ left, top });
  }, [anchor, recent]);

  // Before the measurement runs (or when no anchor is given), fall back
  // to the original top-center layout so the modal never pops in at
  // (0, 0) for a frame.
  const hasAnchor = !!anchor;
  const outerStyle = hasAnchor
    ? {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000,
        background: 'rgba(0, 0, 0, 0.35)',
      }
    : {
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2000,
        background: 'rgba(0, 0, 0, 0.35)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: 80,
      };
  const modalPositionStyle = hasAnchor
    ? {
        position: 'absolute',
        left: pos ? pos.left : -9999,  // off-screen until measured
        top: pos ? pos.top : -9999,
      }
    : {};

  return (
    <div
      style={outerStyle}
      onMouseDown={(e) => { if (!busy) onClose(); }}
    >
      <div
        ref={modalRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: 'calc(100vw - 40px)',
          background: 'var(--bg)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
          display: 'flex', flexDirection: 'column',
          maxHeight: 'calc(100vh - 160px)',
          ...modalPositionStyle,
        }}
      >
        <div
          style={{
            padding: '10px 14px', borderBottom: '1px solid var(--border)',
            fontSize: 13, fontWeight: 600,
          }}
        >
          Change Data Folder
        </div>

        {/* Recent list (scrolls if over MAX_VISIBLE_ROWS) */}
        <div
          style={{
            overflowY: 'auto',
            maxHeight: ROW_HEIGHT * MAX_VISIBLE_ROWS,
          }}
        >
          {recent === null && (
            <div style={{ padding: '10px 14px', color: 'var(--text-dim)', fontSize: 12 }}>
              Loading recent folders…
            </div>
          )}
          {recent && recent.length === 0 && (
            <div style={{ padding: '10px 14px', color: 'var(--text-dim)', fontSize: 12 }}>
              No recent folders yet.
            </div>
          )}
          {recent && recent.map((p) => {
            const isCurrent = normalize(p) === currentKey;
            // --selection reads as a subtle tint in both themes — safe
            // contrast for the normal text color. --tab-bg was a dark
            // purple in light mode, which made the row's grey text
            // unreadable.
            const currentBg = 'var(--selection)';
            return (
              <div
                key={p}
                onClick={() => !isCurrent && !busy && pickRecent(p)}
                style={{
                  padding: '8px 14px',
                  cursor: isCurrent || busy ? 'default' : 'pointer',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: isCurrent ? currentBg : 'transparent',
                }}
                onMouseEnter={(e) => { if (!isCurrent && !busy) e.currentTarget.style.background = 'var(--selection)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = isCurrent ? currentBg : 'transparent'; }}
                title={p}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 13,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    direction: 'rtl', textAlign: 'left',
                  }}>
                    {p}
                  </div>
                </div>
                {isCurrent && (
                  <div style={{ fontSize: 11, color: 'var(--text)', fontStyle: 'italic' }}>
                    (current)
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* "Other location..." sticky at the bottom */}
        <div
          onClick={() => !busy && pickOther()}
          style={{
            padding: '10px 14px', cursor: busy ? 'default' : 'pointer',
            borderTop: '1px solid var(--border)',
            fontSize: 13, fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 8,
          }}
          onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = 'var(--selection)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span>Other location…</span>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 14px',
              background: 'var(--status-bar-error, #c62828)',
              color: '#fff', fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            padding: '8px 14px', borderTop: '1px solid var(--border)',
            display: 'flex', justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '4px 14px', cursor: busy ? 'default' : 'pointer',
              // Transparent + border reads correctly in both themes —
              // --tab-bg is deep purple in light mode and would put
              // black text on it.
              background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
