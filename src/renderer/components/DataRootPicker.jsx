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
  const [confirmDelete, setConfirmDelete] = useState(null); // path pending removal from the recent list
  const [nicknames, setNicknames] = useState({}); // { [normalizedPath]: displayName }
  const [rowMenu, setRowMenu] = useState(null);    // { path, x, y } right-click menu
  const [renameTarget, setRenameTarget] = useState(null); // path being given a display nickname
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, nicks] = await Promise.all([
          window.arcenApi.getRecentDataRoots(),
          window.arcenApi.getRootNicknames?.() ?? {},
        ]);
        if (!cancelled) {
          setRecent(Array.isArray(list) ? list : []);
          setNicknames(nicks && typeof nicks === 'object' ? nicks : {});
        }
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
        // Esc backs out of the topmost overlay first, then the picker.
        if (renameTarget) setRenameTarget(null);
        else if (rowMenu) setRowMenu(null);
        else if (confirmDelete) setConfirmDelete(null);
        else onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, busy, confirmDelete, rowMenu, renameTarget]);

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

  // Remove an entry from the recent list (the folder on disk is untouched).
  const doDelete = useCallback(async (absPath) => {
    try {
      const updated = await window.arcenApi.removeRecentDataRoot(absPath);
      setRecent(Array.isArray(updated) ? updated : (prev) => (prev || []).filter((r) => r !== absPath));
    } catch (e) {
      setError(e?.message || 'Failed to remove that folder from the list.');
    } finally {
      setConfirmDelete(null);
    }
  }, []);

  // Final path segment, for the confirmation prompt ("delete <folder> …").
  const folderLabel = (p) => (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  // The default window-title name for a root: folder segment, underscores
  // stripped (mirrors main.js defaultProjectName so the rename field prefills
  // with what the title would otherwise show).
  const defaultName = (p) => folderLabel(p).replace(/_/g, '');
  const nameFor = (p) => (nicknames[normalize(p)] || defaultName(p));

  const openRename = (p) => {
    setRowMenu(null);
    setRenameValue(nameFor(p));
    setRenameTarget(p);
  };

  const saveRename = useCallback(async (absPath, value) => {
    try {
      const updated = await window.arcenApi.setRootNickname(absPath, value);
      if (updated && typeof updated === 'object') setNicknames(updated);
    } catch (e) {
      setError(e?.message || 'Failed to set the display name.');
    } finally {
      setRenameTarget(null);
    }
  }, []);

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
    <>
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
                onContextMenu={(e) => { e.preventDefault(); if (!busy) setRowMenu({ path: p, x: e.clientX, y: e.clientY }); }}
                style={{
                  padding: '8px 14px',
                  cursor: isCurrent || busy ? 'default' : 'pointer',
                  borderBottom: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: isCurrent ? currentBg : 'transparent',
                }}
                onMouseEnter={(e) => { if (!isCurrent && !busy) e.currentTarget.style.background = 'var(--selection)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = isCurrent ? currentBg : 'transparent'; }}
                title={`${p}\n(right-click to rename the window title or remove from this list)`}
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
                {nicknames[normalize(p)] && (
                  <div
                    style={{ fontSize: 11, color: 'var(--text-dim)', fontStyle: 'italic', flexShrink: 0 }}
                    title="Window-title name for this folder"
                  >
                    “{nicknames[normalize(p)]}”
                  </div>
                )}
                {isCurrent && (
                  <div style={{ fontSize: 11, color: 'var(--text)', fontStyle: 'italic', flexShrink: 0 }}>
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

    {/* Confirm removal of a recent entry (right-click → delete). */}
    {confirmDelete && (
      <div
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2100,
          background: 'rgba(0, 0, 0, 0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseDown={() => setConfirmDelete(null)}
      >
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: 440, maxWidth: 'calc(100vw - 40px)',
            background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.4)',
            padding: '16px 18px',
          }}
        >
          <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
            Do you wish to delete "{folderLabel(confirmDelete)}" from the recent data folders list? This will not affect the actual folder itself.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              onClick={() => setConfirmDelete(null)}
              style={{
                padding: '4px 14px', cursor: 'pointer',
                background: 'transparent', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => doDelete(confirmDelete)}
              style={{
                padding: '4px 14px', cursor: 'pointer',
                background: 'var(--status-bar-error, #c62828)', color: '#fff',
                border: '1px solid var(--status-bar-error, #c62828)', borderRadius: 3, fontSize: 12,
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Right-click row menu: rename the window-title name, or remove the entry. */}
    {rowMenu && (
      <div
        style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2100 }}
        onMouseDown={() => setRowMenu(null)}
        onContextMenu={(e) => { e.preventDefault(); setRowMenu(null); }}
      >
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', top: rowMenu.y, left: rowMenu.x,
            background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 4,
            boxShadow: '0 6px 16px rgba(0,0,0,0.35)', padding: 4, minWidth: 200, fontSize: 12,
          }}
        >
          {[
            { label: 'Rename window title…', action: () => openRename(rowMenu.path) },
            { label: 'Remove from recent list', action: () => { const p = rowMenu.path; setRowMenu(null); setConfirmDelete(p); } },
          ].map((it, i) => (
            <div
              key={i}
              onClick={it.action}
              style={{ padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap', borderRadius: 3 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--selection)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {it.label}
            </div>
          ))}
        </div>
      </div>
    )}

    {/* Rename a root's window-title display name (per-folder nickname). */}
    {renameTarget && (
      <div
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 2100,
          background: 'rgba(0, 0, 0, 0.45)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onMouseDown={() => setRenameTarget(null)}
      >
        <form
          onMouseDown={(e) => e.stopPropagation()}
          onSubmit={(e) => { e.preventDefault(); saveRename(renameTarget, renameValue); }}
          style={{
            width: 440, maxWidth: 'calc(100vw - 40px)',
            background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 6,
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.4)', padding: '16px 18px',
          }}
      >
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            Window-title name for "{folderLabel(renameTarget)}"
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 10 }}>
            Shown in the title bar and taskbar for this folder. Clear it to use the default ({defaultName(renameTarget)}).
          </div>
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={defaultName(renameTarget)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13,
              background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 3, marginBottom: 14,
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              onClick={() => setRenameTarget(null)}
              style={{
                padding: '4px 14px', cursor: 'pointer',
                background: 'transparent', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                padding: '4px 14px', cursor: 'pointer',
                background: 'var(--tab-bg)', color: '#fff',
                border: '1px solid var(--border)', borderRadius: 3, fontSize: 12,
              }}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    )}
    </>
  );
}
