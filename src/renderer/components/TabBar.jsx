import React, { useState, useRef, useEffect } from 'react';
import StatusPip from './StatusPip';
import { fileDisplayName } from '../editor/layerDisplay';
const vcsStore = require('../editor/vcsStore');

// `layerByRelPath` maps relativePath → { layer, layerNum } so tab labels can
// carry the [DLC<N>] tag. Absent (narrow mode / detached fallback) → no tags.
export default function TabBar({ tabs, activeIndex, onSelect, onClose, modifiedFiles, onDetachTab, onContextMenu, onReorder, layerByRelPath }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);
  const [vcsState, setVcsState] = useState({ statusBackendLive: false, dataByRel: new Map() });
  const dragStartPos = useRef(null);

  useEffect(() => {
    return vcsStore.subscribe((s) => {
      setVcsState({ statusBackendLive: s.statusBackendLive, dataByRel: s.dataByRel });
    });
  }, []);

  const getStatus = (relPath) => {
    if (!vcsState.statusBackendLive) return 'clean';
    return vcsState.dataByRel.get(relPath) || 'clean';
  };

  if (!tabs.length) return <div className="tab-bar" />;

  return (
    <div className="tab-bar">
      {tabs.map((tab, i) => {
        const fileName = tab.relativePath.split('/').pop();
        // Display name without extension — easier to scan at a glance, since
        // every tab in this editor is either .xml or .metadata. Metadata
        // tabs are distinguished by color (via the `schema` class), not a
        // textual suffix. DLC-layer tabs additionally get a [DLC<N>] tag.
        const layerInfo = layerByRelPath?.get(tab.relativePath);
        const label = fileDisplayName(fileName, layerInfo?.layer, layerInfo?.layerNum, layerInfo?.modDisplayName);
        const isSchema = tab.type === 'schema';
        const isModified = modifiedFiles.has(tab.relativePath);
        const isDragOver = dropIdx === i && dragIdx !== i;

        return (
          <div
            key={tab.relativePath}
            className={`tab ${i === activeIndex ? 'active' : ''}${isSchema ? ' schema' : ''}`}
            draggable
            onClick={() => onSelect(i)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (onContextMenu) onContextMenu(i, e.clientX, e.clientY);
            }}
            onDragStart={(e) => {
              setDragIdx(i);
              dragStartPos.current = { x: e.screenX, y: e.screenY };
              // Store the relativePath for cross-window detection
              e.dataTransfer.setData('text/plain', tab.relativePath);
            }}
            onDragOver={(e) => { e.preventDefault(); setDropIdx(i); }}
            onDragLeave={() => { if (dropIdx === i) setDropIdx(null); }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx !== null && dragIdx !== i && onReorder) {
                onReorder(dragIdx, i);
              }
              setDragIdx(null);
              setDropIdx(null);
            }}
            onDragEnd={(e) => {
              // Check if the drag ended outside the window — tear off
              if (dragIdx !== null) {
                const winX = window.screenX || window.screenLeft || 0;
                const winY = window.screenY || window.screenTop || 0;
                const winW = window.outerWidth;
                const winH = window.outerHeight;
                const sx = e.screenX;
                const sy = e.screenY;

                if (sx < winX || sx > winX + winW || sy < winY || sy > winY + winH) {
                  // Dropped outside the window — detach this tab. The parent
                  // supplies the in-memory buffer so any unsaved edits move with
                  // it (lossless tear-off); fall back to the bare IPC if no
                  // handler was wired up.
                  const relPath = tabs[dragIdx]?.relativePath;
                  if (relPath) {
                    if (onDetachTab) onDetachTab(relPath, sx, sy);
                    else if (window.arcenApi?.detachTabAtPosition) window.arcenApi.detachTabAtPosition(relPath, sx, sy);
                  }
                }
              }
              setDragIdx(null);
              setDropIdx(null);
            }}
            style={{
              opacity: dragIdx === i ? 0.5 : 1,
              borderLeft: isDragOver ? '2px solid var(--accent)' : undefined,
            }}
          >
            {vcsState.statusBackendLive && (
              <StatusPip
                status={getStatus(tab.relativePath)}
                reserveSpace
                style={{ marginRight: 3, marginTop: 2 }}
                title={`VCS: ${getStatus(tab.relativePath)}`}
              />
            )}
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={label}
            >
              {label}
            </span>
            {isModified && <div className="modified-dot" />}
            <span
              className="close-btn"
              onClick={(e) => { e.stopPropagation(); onClose(i); }}
            >
              ×
            </span>
          </div>
        );
      })}
    </div>
  );
}
