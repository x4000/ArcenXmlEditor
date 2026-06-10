/**
 * Scrollbar overview markers — draws ticks on the editor's vertical scrollbar
 * so the whole document is legible at a glance, not just the viewport.
 *
 * Three independent lanes, each its own colour:
 *   - Search matches      (gold)   — right lane, over the scrollbar thumb.
 *   - Changed-since-disk  (yellow) — left lane; mirrors the gutter's unsaved
 *                                    edits layer.
 *   - Changed-since-commit(orange) — left lane; mirrors the gutter's VCS layer.
 *     When a line is in both change sets, yellow wins (same priority the
 *     gutter uses) so "you have unsaved work here" stays visible.
 *
 * Positions come straight from CodeMirror's own block geometry
 * (view.lineBlockAt(pos).top / view.contentHeight), and the strip is sized
 * and offset to the real .cm-scroller box every render. That's the fix for
 * the old mis-alignment: the previous version mapped line *numbers* onto the
 * full .cm-editor height, but search({top:true}) puts the search panel ABOVE
 * the scroller — so while you were actually searching, the scroller was
 * shorter than the editor and every tick floated too high (worst near the
 * top). Anchoring to scroller.offsetTop / scroller.clientHeight removes both
 * the offset and the scale error.
 *
 * The change lanes are optional. Callers that have the change-gutter
 * extension installed pass its two line-set fields in (changedField / vcsField);
 * the reference-panel editor has no gutter and calls this with no options,
 * getting a search-only ruler.
 */

import { ViewPlugin } from '@codemirror/view';
import { getSearchQuery } from '@codemirror/search';

export function createSearchScrollMarkers(opts = {}) {
  const changedField = opts.changedField || null; // changed-since-disk (yellow)
  const vcsField = opts.vcsField || null;         // changed-since-commit (orange)

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.container = null;
        this.lastQuery = '';
        this.timer = null;
        this.createContainer();
        this.scheduleUpdate();
      }

      createContainer() {
        this.container = document.createElement('div');
        this.container.className = 'cm-scroll-markers';
        // top/height are set per-render to track the live scroller box.
        this.container.style.cssText =
          'position:absolute; right:0; width:15px;' +
          'pointer-events:none; z-index:50; overflow:hidden;';
        // Insert into the cm-editor wrapper (outside the scroller so it does
        // not scroll with the content).
        const editor = this.view.dom;
        editor.style.position = 'relative';
        editor.appendChild(this.container);
      }

      update(update) {
        let dirty = update.docChanged || update.viewportChanged || update.geometryChanged;
        // Search query changed?
        if (!dirty) {
          try {
            const q = getSearchQuery(update.state);
            const key = q.search + '|' + q.caseSensitive + '|' + q.regexp;
            if (key !== this.lastQuery) { this.lastQuery = key; dirty = true; }
          } catch (_) {}
        }
        // Either change line-set recomputed? (the diff scheduler swaps in a
        // fresh RangeSet, so identity comparison detects it.)
        if (!dirty && changedField &&
            update.startState.field(changedField, false) !== update.state.field(changedField, false)) dirty = true;
        if (!dirty && vcsField &&
            update.startState.field(vcsField, false) !== update.state.field(vcsField, false)) dirty = true;
        if (dirty) this.scheduleUpdate();
      }

      scheduleUpdate() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.timer = null; this.render(); }, 200);
      }

      render() {
        const view = this.view;
        const container = this.container;
        if (!container) return;

        const scroller = view.scrollDOM;
        // Anchor the strip to the real scroller box. When the search panel is
        // open it sits above the scroller, so scroller.offsetTop is non-zero —
        // this is what keeps the ticks aligned with the native scrollbar.
        const trackHeight = scroller.clientHeight;
        container.style.top = scroller.offsetTop + 'px';
        container.style.height = trackHeight + 'px';

        container.innerHTML = '';
        if (trackHeight <= 0) return;

        const contentHeight = view.contentHeight || trackHeight;
        const docLen = view.state.doc.length;
        const frag = document.createDocumentFragment();

        // Map a document position to a y within the track using CM's measured
        // block geometry. Uniform line heights (no wrapping here) make this
        // exact even for off-screen lines, which CM estimates from the average.
        const topForPos = (pos) => {
          if (pos > docLen) pos = docLen;
          if (pos < 0) pos = 0;
          let t;
          try {
            t = (view.lineBlockAt(pos).top / contentHeight) * trackHeight;
          } catch (_) { return -1; }
          if (t > trackHeight - 3) t = trackHeight - 3;
          if (t < 0) t = 0;
          return t;
        };

        // ── Change lanes (left): disk-changed yellow over commit-changed orange ──
        // Resolve per pixel row so a line in both sets shows yellow (unsaved)
        // on top, matching the gutter's priority and bounding the node count.
        if (changedField || vcsField) {
          const rowKind = new Map(); // roundedTop -> 'disk' | 'vcs'
          const collect = (field, kind) => {
            const rs = field && view.state.field(field, false);
            if (!rs) return;
            const iter = rs.iter();
            while (iter.value) {
              const t = topForPos(iter.from);
              if (t >= 0) rowKind.set(Math.round(t), kind); // later call wins
              iter.next();
            }
          };
          collect(vcsField, 'vcs');       // orange first…
          collect(changedField, 'disk');  // …yellow overwrites where both
          for (const [top, kind] of rowKind) {
            const m = document.createElement('div');
            const color = kind === 'disk'
              ? 'var(--gutter-changed,#e2c000)'
              : 'var(--gutter-vcs-changed,#e27b00)';
            m.style.cssText =
              'position:absolute; left:1px; width:4px; height:3px;' +
              'border-radius:1px; background:' + color + '; top:' + top + 'px;';
            frag.appendChild(m);
          }
        }

        // ── Search lane (right): gold ──
        let query;
        try { query = getSearchQuery(view.state); } catch (_) { query = null; }
        if (query && query.search) {
          let re = null;
          try {
            const escaped = query.regexp
              ? query.search
              : query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            re = new RegExp(escaped, query.caseSensitive ? 'g' : 'gi');
          } catch (_) { re = null; }
          if (re) {
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            const markerColor = isDark ? '#c8a820' : '#d49a00';
            const text = view.state.doc.toString();
            const seenRows = new Set();
            let m, count = 0;
            while ((m = re.exec(text)) !== null) {
              if (m[0].length === 0) { re.lastIndex++; continue; }
              const t = topForPos(m.index);
              if (t >= 0) {
                const key = Math.round(t);
                if (!seenRows.has(key)) {
                  seenRows.add(key);
                  const el = document.createElement('div');
                  el.style.cssText =
                    'position:absolute; right:1px; width:8px; height:3px;' +
                    'border-radius:1px; background:' + markerColor + '; top:' + key + 'px;';
                  frag.appendChild(el);
                }
              }
              // Can't show more than one tick per pixel row; stop once full.
              if (seenRows.size >= trackHeight || ++count > 50000) break;
            }
          }
        }

        container.appendChild(frag);
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
        if (this.container && this.container.parentNode) {
          this.container.remove();
        }
      }
    }
  );
}
