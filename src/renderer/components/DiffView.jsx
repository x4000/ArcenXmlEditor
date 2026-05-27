/**
 * Diff view modal showing changes since last save.
 * Green for added lines, red for deleted, bold for changed.
 * Always uses light-mode syntax coloring.
 */

import React, { useMemo } from 'react';

const LIGHT = {
  tag: '#800000', bracket: '#0000ff', attrName: '#ff0000',
  attrValue: '#0000ff', comment: '#008000', text: '#000',
  quote: '#0000ff', xmlDecl: '#aaa',
};

/**
 * Compute which character ranges in a line are different from its paired line.
 * Returns a Set of character indices that are "changed".
 */
function computeInlineDiff(lineA, lineB) {
  const changed = new Set();
  // Find common prefix
  let pre = 0;
  while (pre < lineA.length && pre < lineB.length && lineA[pre] === lineB[pre]) pre++;
  // Find common suffix
  let sufA = lineA.length - 1, sufB = lineB.length - 1;
  while (sufA > pre && sufB > pre && lineA[sufA] === lineB[sufB]) { sufA--; sufB--; }
  // Mark the differing range
  for (let i = pre; i <= sufA; i++) changed.add(i);
  // If line is entirely the same length and nothing changed, return empty
  return changed;
}

function colorLine(line) {
  const spans = [];
  let idx = 0;

  while (idx < line.length) {
    if (line.startsWith('</', idx) || line[idx] === '<') {
      const isCl = line[idx + 1] === '/';
      const bl = isCl ? 2 : 1;
      spans.push({ c: LIGHT.bracket, t: line.substr(idx, bl) });
      idx += bl;
      const tm = line.slice(idx).match(/^[\w.-]+/);
      if (tm) { spans.push({ c: LIGHT.tag, t: tm[0] }); idx += tm[0].length; }
      continue;
    }
    if (line[idx] === '>' || line.startsWith('/>', idx)) {
      const b = line[idx] === '/' ? '/>' : '>';
      spans.push({ c: LIGHT.bracket, t: b });
      idx += b.length;
      continue;
    }
    if (line[idx] === '"') {
      spans.push({ c: LIGHT.quote, t: '"' });
      idx++;
      const qe = line.indexOf('"', idx);
      if (qe >= 0) {
        spans.push({ c: LIGHT.attrValue, t: line.slice(idx, qe) });
        spans.push({ c: LIGHT.quote, t: '"' });
        idx = qe + 1;
      }
      continue;
    }
    if (line[idx] === '=') {
      spans.push({ c: LIGHT.bracket, t: '=' });
      idx++;
      continue;
    }
    const atm = line.slice(idx).match(/^([\w.-]+)(?=\s*=)/);
    if (atm) {
      spans.push({ c: LIGHT.attrName, t: atm[1] });
      idx += atm[1].length;
      continue;
    }
    let nx = idx + 1;
    while (nx < line.length && '<>"='.indexOf(line[nx]) < 0) {
      if (line.slice(nx).match(/^[\w.-]+(?=\s*=)/)) break;
      nx++;
    }
    spans.push({ c: LIGHT.text, t: line.slice(idx, nx) });
    idx = nx;
  }

  return spans;
}

export default function DiffView({ oldText, newText, onClose, onRevert }) {
  const rows = useMemo(() => {
    const oL = oldText.split('\n');
    const nL = newText.split('\n');
    const result = [];
    let oi = 0, ni = 0;

    while (oi < oL.length || ni < nL.length) {
      if (oi < oL.length && ni < nL.length && oL[oi] === nL[ni]) {
        result.push({ t: 's', x: oL[oi] });
        oi++; ni++;
        continue;
      }

      let fO = -1, fN = -1;
      for (let k = 1; k <= 30; k++) {
        if (fN < 0 && ni + k < nL.length && oi < oL.length && nL[ni + k] === oL[oi]) fN = ni + k;
        if (fO < 0 && oi + k < oL.length && ni < nL.length && oL[oi + k] === nL[ni]) fO = oi + k;
        if (fO >= 0 || fN >= 0) break;
      }

      const nxM = oi + 1 < oL.length && ni + 1 < nL.length && oL[oi + 1] === nL[ni + 1];

      if (nxM) {
        if (oi < oL.length) result.push({ t: 'd', x: oL[oi] });
        if (ni < nL.length) result.push({ t: 'a', x: nL[ni] });
        oi++; ni++;
      } else if (fO >= 0 && (fN < 0 || (fO - oi) <= (fN - ni))) {
        while (oi < fO) { result.push({ t: 'd', x: oL[oi] }); oi++; }
      } else if (fN >= 0) {
        while (ni < fN) { result.push({ t: 'a', x: nL[ni] }); ni++; }
      } else {
        if (oi < oL.length) { result.push({ t: 'd', x: oL[oi] }); oi++; }
        if (ni < nL.length) { result.push({ t: 'a', x: nL[ni] }); ni++; }
      }
    }

    // Post-process: mark paired d/a lines for inline diffing
    for (let r = 0; r < result.length - 1; r++) {
      if (result[r].t === 'd' && result[r + 1].t === 'a') {
        result[r].pair = r + 1;
        result[r + 1].pair = r;
      }
    }

    return result;
  }, [oldText, newText]);

  // Filter to only show changed lines + 10 lines of context
  const filteredRows = useMemo(() => {
    const CONTEXT = 10;
    // Find indices of changed lines
    const changedIndices = new Set();
    rows.forEach((r, i) => { if (r.t !== 's') changedIndices.add(i); });
    if (changedIndices.size === 0) return [];

    // Expand context around each changed line
    const visible = new Set();
    for (const idx of changedIndices) {
      for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(rows.length - 1, idx + CONTEXT); k++) {
        visible.add(k);
      }
    }

    // Build output with separators for gaps
    const result = [];
    let lastIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (!visible.has(i)) continue;
      if (lastIdx >= 0 && i > lastIdx + 1) {
        result.push({ t: 'sep', x: `··· ${i - lastIdx - 1} unchanged lines ···` });
      }
      result.push(rows[i]);
      lastIdx = i;
    }
    return result;
  }, [rows]);

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.4)',
      }} />
      <div
        style={{
          position: 'relative', zIndex: 1, background: '#fff', borderRadius: 8,
          width: '85%', maxWidth: 950, maxHeight: '85vh', display: 'flex',
          flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace", fontSize: 12,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid #d4d4d4',
          display: 'flex', justifyContent: 'space-between', color: '#24292f', flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Changes since last save</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {onRevert && (
              <button
                onClick={() => { onRevert(); onClose(); }}
                style={{
                  padding: '3px 12px', fontSize: 12, cursor: 'pointer',
                  background: '#c5384c', color: '#fff', border: 'none',
                  borderRadius: 3, fontWeight: 600,
                }}
              >
                Revert All
              </button>
            )}
            <span
              style={{ cursor: 'pointer', color: '#888', padding: '2px 8px', fontSize: 16 }}
              onClick={onClose}
            >
              ✕
            </span>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', lineHeight: 1.7 }}>
          {filteredRows.map((line, i) => {
            if (line.t === 'sep') {
              return (
                <div key={i} style={{ padding: '4px 12px', background: '#f0f0f0', color: '#888', fontSize: 11, textAlign: 'center', fontStyle: 'italic' }}>
                  {line.x}
                </div>
              );
            }
            const bg = line.t === 'a' ? '#e6ffec' : line.t === 'd' ? '#ffebe9' : '#fff';
            const prefix = line.t === 'a' ? '+' : line.t === 'd' ? '-' : ' ';
            const spans = colorLine(line.x);

            // Compute inline diff for paired modification lines
            let inlineDiff = null;
            if (line.pair != null && line.t !== 's') {
              const pairedLine = rows[line.pair];
              if (pairedLine) {
                if (line.t === 'd') {
                  inlineDiff = computeInlineDiff(line.x, pairedLine.x);
                } else {
                  inlineDiff = computeInlineDiff(line.x, pairedLine.x);
                }
              }
            }

            // Render spans with inline diff bolding
            let charIdx = 0;
            const boldBg = line.t === 'a' ? '#acf2bd' : line.t === 'd' ? '#fdb8c0' : 'transparent';

            return (
              <div key={i} style={{ background: bg, padding: '0 12px', whiteSpace: 'pre', minHeight: 20 }}>
                <span style={{
                  display: 'inline-block', width: 20, color: '#888',
                  userSelect: 'none', fontWeight: 'normal',
                }}>
                  {prefix}
                </span>
                {spans.map((s, j) => {
                  const spanStart = charIdx;
                  charIdx += s.t.length;
                  if (!inlineDiff || inlineDiff.size === 0) {
                    return <span key={j} style={{ color: s.c }}>{s.t}</span>;
                  }
                  // Split span into bold/non-bold segments
                  const segments = [];
                  let segStart = 0;
                  for (let ci = 0; ci <= s.t.length; ci++) {
                    const isBold = inlineDiff.has(spanStart + ci);
                    const wasBold = ci > 0 && inlineDiff.has(spanStart + ci - 1);
                    if (ci === s.t.length || isBold !== wasBold) {
                      if (ci > segStart) {
                        segments.push({ text: s.t.slice(segStart, ci), bold: wasBold });
                      }
                      segStart = ci;
                    }
                  }
                  return segments.map((seg, si) => (
                    <span key={`${j}-${si}`} style={{
                      color: s.c,
                      fontWeight: seg.bold ? 'bold' : 'normal',
                      background: seg.bold ? boldBg : 'transparent',
                    }}>{seg.text}</span>
                  ));
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
