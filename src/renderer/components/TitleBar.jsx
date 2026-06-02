import React, { useEffect, useState, useRef } from 'react';
import StatusPip from './StatusPip';
const vcsStore = require('../editor/vcsStore');

// Capitalize a status word for the tooltip body. The VcsStatus enum is
// lower-case ('modified', 'clean', …) which reads oddly mid-sentence.
function titleCaseStatus(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Menu shown when clicking a title-bar pip or right-clicking the title text.
// Uses a full-screen backdrop to intercept clicks, since the title bar has
// `-webkit-app-region: drag` which swallows mousedown events at the DOM
// level (they go to the window manager for window-drag behavior). A
// document-level listener can't dismiss in that case.
function PipMenu({ x, y, items, onClose }) {
  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998,
        WebkitAppRegion: 'no-drag',
      }}
      onMouseDown={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
    <div
      style={{
        position: 'fixed', top: y, left: x, zIndex: 10000,
        background: 'var(--bg, #252526)',
        color: 'var(--text, #e0e0e0)',
        border: '1px solid var(--border, #444)',
        borderRadius: 3,
        padding: 4,
        minWidth: 220,
        boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
        fontSize: 12,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        it.divider ? (
          <div key={i} style={{ borderTop: '1px solid var(--border, #444)', margin: '3px 0' }} />
        ) : (
          <div
            key={i}
            onClick={() => { if (it.enabled !== false && it.action) it.action(); onClose(); }}
            style={{
              padding: '5px 10px',
              cursor: it.enabled === false ? 'default' : 'pointer',
              opacity: it.enabled === false ? 0.45 : 1,
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
            onMouseEnter={(e) => { if (it.enabled !== false) e.currentTarget.style.background = 'var(--selection, #37373d)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {it.label}
          </div>
        )
      ))}
    </div>
    </div>
  );
}

// Tooltip shown on pip hover. Styled to match the Plugins chip tooltip.
function PipTooltip({ heading, body }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: '100%',
        left: '50%',
        transform: 'translateX(-50%)',
        marginTop: 6,
        background: 'var(--bg, #2a2a2a)',
        color: 'var(--text, #e0e0e0)',
        border: '1px solid var(--border, #444)',
        borderRadius: 4,
        padding: '8px 12px',
        fontSize: 11,
        lineHeight: 1.5,
        minWidth: 260,
        maxWidth: 400,
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: 1000,
        whiteSpace: 'normal',
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{heading}</div>
      <div style={{ opacity: 0.9 }}>{body}</div>
    </div>
  );
}

// Wraps a StatusPip so its hover area is larger than the visual icon (for easier
// targeting), and shows a custom immediate tooltip rather than the native
// delayed one. Used in the title bar only.
function HoverPip({ status, size, hitWidth, hitHeight, tooltipHeading, tooltipBody, onClick, onContextMenu }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: hitWidth,
        height: hitHeight,
        cursor: 'pointer',
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <StatusPip status={status} size={size} reserveSpace />
      {hover && <PipTooltip heading={tooltipHeading} body={tooltipBody} />}
    </span>
  );
}

export default function TitleBar({ navState, onBack, onForward, mode, windowId, activeFileName }) {
  const [state, setState] = useState({ statusBackendLive: false, repoRollup: 'clean', dataRollup: 'clean', active: null });
  const [menu, setMenu] = useState(null);
  // Display number for detached windows. It's derived from current
  // rank (1..N) among open detached windows, re-indexed when any of
  // them opens or closes — see renumberDetachedWindows() in main.js.
  // Not based on windowId, which is a stable internal ID that can
  // carry forward arbitrarily large numbers across root switches.
  const [displayNum, setDisplayNum] = useState(null);
  // Short project name for the current data root (folder name with underscores
  // stripped, or the user's per-root nickname). Pushed by main on nickname edits.
  const [projectName, setProjectName] = useState('Arcen XML Editor');

  useEffect(() => {
    let mounted = true;
    window.arcenApi.getProjectName?.().then((n) => { if (mounted && n) setProjectName(n); });
    window.arcenApi.onProjectNameChanged?.((n) => { if (mounted && n) setProjectName(n); });
    return () => { mounted = false; };
  }, []);

  // The full window title. With a file open: "<Project> - <File>". Empty: just
  // "<Project>" for the main window, or "<Project>-<N>" for detached windows so
  // each empty detached window is distinguishable (first detached → "-2").
  const windowTitle = activeFileName
    ? `${projectName} - ${activeFileName}`
    : (mode === 'detached'
        ? (displayNum ? `${projectName}-${displayNum + 1}` : projectName)
        : projectName);

  // Drive the OS window title / taskbar entry. main.js no longer overrides this
  // (it lets document.title through), so this is the single source of truth.
  useEffect(() => { document.title = windowTitle; }, [windowTitle]);

  useEffect(() => {
    return vcsStore.subscribe((s) => {
      setState({
        statusBackendLive: s.statusBackendLive,
        repoRollup: s.repoRollup,
        dataRollup: s.dataRollup,
        active: s.active,
      });
    });
  }, []);

  useEffect(() => {
    if (mode !== 'detached') return;
    let mounted = true;
    window.arcenApi.getDetachedDisplayNum?.().then((n) => {
      if (mounted && typeof n === 'number') setDisplayNum(n);
    });
    window.arcenApi.onDetachedDisplayNumChanged?.((n) => {
      if (mounted && typeof n === 'number') setDisplayNum(n);
    });
    return () => { mounted = false; };
  }, [mode]);

  const navBtnStyle = (enabled) => ({
    background: 'transparent',
    border: 'none',
    color: enabled ? '#fff' : 'rgba(255,255,255,0.3)',
    cursor: enabled ? 'pointer' : 'default',
    width: 28,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    WebkitAppRegion: 'no-drag',
  });

  const showPips = state.statusBackendLive && mode !== 'detached';
  const providerName = state.active?.displayName || 'VCS';

  // Pull command list (labels + IDs + enabled flags) from the active
  // provider via IPC. The provider supplies its own labels — "SVN Commit…",
  // "Git Commit…", etc. — so this menu auto-updates when a different
  // provider becomes active. Disabled items are filtered out (provider
  // already grays them via `enabled: false`, but the title-bar menu has
  // no disabled-item styling; just dropping them is cleaner here).
  const buildCommandItems = async (scope, absPath) => {
    const cmds = await window.arcenApi.scGetCommands(scope, absPath);
    const items = (cmds || [])
      .filter(c => c.enabled !== false)
      .map(c => ({
        label: c.label,
        action: () => window.arcenApi.scRunCommand(c.id, absPath),
      }));
    items.push({ divider: true });
    items.push({ label: 'Refresh status', action: () => window.arcenApi.scRefresh() });
    return items;
  };

  const openRepoPipMenu = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const absPath = state.active?.repoRoot;
    if (!absPath) return;
    const x = e.clientX, y = e.clientY;
    const items = await buildCommandItems('repo', absPath);
    setMenu({ x, y, items });
  };

  const openDataPipMenu = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const absPath = state.active?.dataScopeRoot;
    if (!absPath) return;
    const x = e.clientX, y = e.clientY;
    const items = await buildCommandItems('data', absPath);
    setMenu({ x, y, items });
  };

  const openTitleContextMenu = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!state.statusBackendLive) return;
    const repoPath = state.active?.repoRoot;
    const dataPath = state.active?.dataScopeRoot;
    const x = e.clientX, y = e.clientY;
    const items = [];
    if (repoPath) {
      items.push({ label: `Repo (${repoPath})`, enabled: false });
      items.push(...(await buildCommandItems('repo', repoPath)));
    }
    if (dataPath && dataPath !== repoPath) {
      if (items.length) items.push({ divider: true });
      items.push({ label: `Data (${dataPath})`, enabled: false });
      items.push(...(await buildCommandItems('data', dataPath)));
    }
    if (items.length) setMenu({ x, y, items });
  };

  return (
    <div className="title-bar">
      <img src="../../icons/icon.png" alt="" />
      {mode !== 'detached' && (
        <>
          <span
            style={navBtnStyle(navState?.canBack)}
            onClick={() => navState?.canBack && onBack?.()}
            title="Back"
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><polyline points="8,1 3,6 8,11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
          <span
            style={navBtnStyle(navState?.canForward)}
            onClick={() => navState?.canForward && onForward?.()}
            title="Forward"
          >
            <svg width="12" height="12" viewBox="0 0 12 12"><polyline points="4,1 9,6 4,11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </span>
        </>
      )}
      <div className="title-middle">
        <span
          className="title-text"
          onContextMenu={openTitleContextMenu}
          title={windowTitle}
        >
          {windowTitle}
        </span>
        {showPips && (
          <span style={{ display: 'inline-flex', gap: 0, marginLeft: 16, WebkitAppRegion: 'no-drag' }}>
            <HoverPip
              status={state.repoRollup}
              size={8}
              hitWidth={16}
              hitHeight={22}
              tooltipHeading={`Entire repo: ${state.active?.repoRoot || '(unknown)'}`}
              tooltipBody={`Status: ${titleCaseStatus(state.repoRollup)}. Click for ${providerName} commands scoped to the whole working copy.`}
              onClick={openRepoPipMenu}
              onContextMenu={openRepoPipMenu}
            />
            <HoverPip
              status={state.dataRollup}
              size={8}
              hitWidth={16}
              hitHeight={22}
              tooltipHeading={`Data folder: ${state.active?.dataScopeRoot || '(unknown)'}`}
              tooltipBody={`Status: ${titleCaseStatus(state.dataRollup)}. Click for ${providerName} commands scoped to this editor's data folder.`}
              onClick={openDataPipMenu}
              onContextMenu={openDataPipMenu}
            />
          </span>
        )}
      </div>
      <div className="window-controls">
        <button onClick={() => window.arcenApi.windowMinimize()} title="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button onClick={() => window.arcenApi.windowMaximize()} title="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button className="close-window" onClick={() => window.arcenApi.windowClose()} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
      {menu && <PipMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
