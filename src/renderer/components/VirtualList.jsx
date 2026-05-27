/**
 * Virtualized scrollable list — renders only the rows visible in the viewport.
 *
 * Usage: pass a flat array of rows + a renderRow function. All rows must have
 * a fixed height (uniform or per-row). For uniform heights, pass `rowHeight`.
 * For variable heights per row, pass `getRowHeight(index)` instead.
 *
 * Props:
 *   rows         — array of any — one entry per logical row
 *   rowHeight    — number — fixed px height per row (used if getRowHeight omitted)
 *   getRowHeight — optional (index) => number — for variable-height rows
 *   renderRow    — (row, index) => React node — content for a visible row
 *   overscan     — optional number of extra pixels to render above/below viewport (default 200)
 *   className    — optional class on the scroll container
 *   style        — optional style on the scroll container
 *   getRowKey    — optional (row, index) => key — React key for each row
 */

import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';

export default function VirtualList({
  rows,
  rowHeight,
  getRowHeight,
  renderRow,
  overscan = 200,
  className,
  style,
  getRowKey,
}) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // Precompute cumulative offsets for variable-height rows
  const offsetsRef = useRef({ offsets: [0], total: 0, rowsRef: null });
  if (offsetsRef.current.rowsRef !== rows) {
    const offsets = new Array(rows.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < rows.length; i++) {
      const h = getRowHeight ? getRowHeight(i) : rowHeight;
      offsets[i + 1] = offsets[i] + h;
    }
    offsetsRef.current = { offsets, total: offsets[rows.length] || 0, rowsRef: rows };
  }
  const { offsets, total } = offsetsRef.current;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const onScroll = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    el.addEventListener('scroll', onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
    };
  }, []);

  // Binary search for first row intersecting viewport top
  const viewTop = Math.max(0, viewport.top - overscan);
  const viewBottom = viewport.top + viewport.height + overscan;

  let startIdx = 0;
  {
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < viewTop) {
        lo = mid + 1;
        startIdx = lo;
      } else {
        hi = mid - 1;
      }
    }
  }

  // Walk forward while rows are in view
  const visible = [];
  for (let i = startIdx; i < rows.length; i++) {
    if (offsets[i] > viewBottom) break;
    visible.push({ row: rows[i], index: i, top: offsets[i], height: offsets[i + 1] - offsets[i] });
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ ...style, overflowY: 'auto', position: 'relative' }}
    >
      <div style={{ position: 'relative', height: total, width: '100%' }}>
        {visible.map(({ row, index, top, height }) => (
          <div
            key={getRowKey ? getRowKey(row, index) : index}
            style={{ position: 'absolute', top, left: 0, right: 0, height }}
          >
            {renderRow(row, index)}
          </div>
        ))}
      </div>
    </div>
  );
}
