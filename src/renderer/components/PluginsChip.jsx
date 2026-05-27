import React, { useEffect, useState, useRef } from 'react';
import StatusPip from './StatusPip';
const vcsStore = require('../editor/vcsStore');

// The Plugins indicator in the status bar. Lists all known plugins (even
// when not installed) with a colored dot per status:
//   connected → green
//   installed, not connected → amber
//   not installed → muted gray
//
// Hover / click shows a pinned tooltip with per-plugin status lines + any
// warnings (e.g. TSVNCache disabled).

function pluginColor(p) {
  if (!p) return '#909399';
  if (p.connected) return 'var(--vcs-added, #67c23a)';
  if (p.installed) return 'var(--vcs-modified, #e6a23c)';
  return '#909399';
}

function pluginLine(p) {
  if (!p) return '';
  if (p.connected) return `${p.displayName} — installed, connected${p.detail ? ` (${p.detail})` : ''}`;
  if (p.installed) return `${p.displayName} — installed, no repo`;
  return `${p.displayName} — not installed`;
}

export default function PluginsChip() {
  const [plugins, setPlugins] = useState([]);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const chipRef = useRef(null);

  useEffect(() => {
    return vcsStore.subscribe((s) => {
      setPlugins(s.plugins.slice());
    });
  }, []);

  useEffect(() => {
    if (!pinned) return;
    const close = (e) => {
      if (chipRef.current && !chipRef.current.contains(e.target)) {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pinned]);

  const hasWarnings = plugins.some(p => p.warnings?.length);

  return (
    <span
      ref={chipRef}
      style={{ position: 'relative', marginRight: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      onMouseEnter={() => { if (!pinned) setOpen(true); }}
      onMouseLeave={() => { if (!pinned) setOpen(false); }}
      onClick={(e) => { e.stopPropagation(); setPinned(v => !v); setOpen(v => !v || !pinned); }}
      title="Plugins"
    >
      <span style={{ opacity: 0.85 }}>Plugins</span>
      {plugins.map(p => (
        <span
          key={p.id}
          style={{
            display: 'inline-block',
            width: 7, height: 7, borderRadius: '50%',
            background: pluginColor(p),
            border: (!p.installed) ? '1px solid rgba(255,255,255,0.4)' : undefined,
            boxSizing: 'border-box',
          }}
        />
      ))}
      {hasWarnings && (
        <span style={{ color: 'var(--vcs-conflict, #f56c6c)', fontSize: 11, marginLeft: 2 }}>⚠</span>
      )}
      {open && plugins.length > 0 && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 6,
            background: 'var(--bg, #2a2a2a)',
            color: 'var(--text, #e0e0e0)',
            border: '1px solid var(--border, #444)',
            borderRadius: 4,
            padding: '8px 12px',
            minWidth: 320,
            maxWidth: 440,
            fontSize: 11,
            lineHeight: 1.5,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 1000,
            whiteSpace: 'normal',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Plugins</div>
          {plugins.map(p => (
            <div key={p.id} style={{ marginTop: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
                  background: pluginColor(p),
                  border: (!p.installed) ? '1px solid rgba(255,255,255,0.4)' : undefined,
                  boxSizing: 'border-box',
                }} />
                <span>{pluginLine(p)}</span>
              </div>
              {p.warnings?.map((w, i) => (
                <div key={i} style={{ marginLeft: 14, color: 'var(--vcs-conflict, #f56c6c)', fontSize: 11 }}>
                  ⚠ {w.message}
                </div>
              ))}
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 10, opacity: 0.7 }}>
            Click to pin this panel. Click again to dismiss.
          </div>
        </div>
      )}
    </span>
  );
}
