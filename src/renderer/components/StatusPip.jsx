import React from 'react';

// Small status icon used in the title bar (as a "pip") and in the
// sidebar/tab left-side indicator. Status is the generic VcsStatus enum:
//   'clean' | 'modified' | 'added' | 'deleted' | 'conflicted'
// | 'unversioned' | 'missing' | 'ignored'
//
// Renders an icon from icons/sc-<status>-<mode>.png where <mode> is 'light'
// or 'dark'. Callers typically set `reserveSpace` so the row layout stays
// stable even when no icon is appropriate (e.g. 'ignored').
//
// NOTE: This is for source-control status only. The existing unsaved-edit
// dot (modified-dot / inline gutter-changed span) is unrelated and must
// not be migrated to this component — they represent different information.

// Maps the generic VcsStatus enum to the icon basename under /icons/.
// 'ignored' intentionally has no icon — we don't want visual noise for
// files SVN has told us not to care about.
const STATUS_ICON = {
  clean: 'sc-normal',
  modified: 'sc-modified',
  added: 'sc-added',
  deleted: 'sc-deleted',
  conflicted: 'sc-conflicted',
  unversioned: 'sc-unversioned',
  missing: 'sc-missing',
};

function currentTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export default function StatusPip({ status, size = 6, title, reserveSpace = false, style, onClick, onContextMenu }) {
  const basename = STATUS_ICON[status];
  const theme = currentTheme();
  const src = basename ? `../../icons/${basename}-${theme}.png` : null;

  if (!src && !reserveSpace) return null;

  const containerStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    verticalAlign: 'middle',
    flexShrink: 0,
    cursor: onClick ? 'pointer' : 'default',
    ...style,
  };

  return (
    <span
      style={containerStyle}
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ width: size, height: size, display: 'block', pointerEvents: 'none' }}
        />
      )}
    </span>
  );
}
