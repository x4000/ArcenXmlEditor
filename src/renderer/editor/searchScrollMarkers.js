/**
 * Search scroll markers — shows yellow ticks on the scrollbar
 * at positions where search matches occur in the document.
 */

import { ViewPlugin } from '@codemirror/view';
import { getSearchQuery } from '@codemirror/search';

export function createSearchScrollMarkers() {
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
        this.container.className = 'cm-search-scroll-markers';
        this.container.style.cssText = `
          position: absolute; top: 0; right: 0; bottom: 0; width: 12px;
          pointer-events: none; z-index: 50; overflow: hidden;
        `;
        // Insert into the cm-editor wrapper (outside the scroller to avoid clipping)
        const editor = this.view.dom;
        editor.style.position = 'relative';
        editor.appendChild(this.container);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged) {
          this.scheduleUpdate();
          return;
        }
        // Check if search query changed
        try {
          const q = getSearchQuery(update.state);
          const key = q.search + '|' + q.caseSensitive + '|' + q.regexp;
          if (key !== this.lastQuery) {
            this.lastQuery = key;
            this.scheduleUpdate();
          }
        } catch (_) {}
      }

      scheduleUpdate() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.render();
        }, 200);
      }

      render() {
        if (!this.container) return;
        this.container.innerHTML = '';

        let query;
        try {
          query = getSearchQuery(this.view.state);
        } catch (_) { return; }

        if (!query.search) return;

        // Build regex from the search query
        let re;
        try {
          const escaped = query.regexp
            ? query.search
            : query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          re = new RegExp(escaped, query.caseSensitive ? 'g' : 'gi');
        } catch (_) { return; }

        const doc = this.view.state.doc;
        const text = doc.toString();
        const totalLines = doc.lines;
        const containerHeight = this.container.offsetHeight || this.view.dom.offsetHeight;

        // Find all matches and their line positions
        const matchLines = new Set();
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue; }
          const line = doc.lineAt(m.index).number;
          matchLines.add(line);
          if (matchLines.size > 2000) break; // cap for performance
        }

        if (matchLines.size === 0) return;

        // Determine marker color based on theme
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const markerColor = isDark ? '#c8a820' : '#d49a00';

        // Render markers
        const frag = document.createDocumentFragment();
        for (const lineNum of matchLines) {
          const ratio = (lineNum - 1) / Math.max(1, totalLines - 1);
          const top = ratio * (containerHeight - 4);
          const marker = document.createElement('div');
          marker.style.cssText = `
            position: absolute; right: 1px; width: 8px; height: 3px;
            background: ${markerColor}; border-radius: 1px;
            top: ${top}px;
          `;
          frag.appendChild(marker);
        }
        this.container.appendChild(frag);
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
