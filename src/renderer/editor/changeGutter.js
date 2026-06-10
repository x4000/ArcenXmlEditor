/**
 * Gutter change markers for the Arcen XML Editor.
 *
 * Two stacked layers share the same gutter column:
 *   - Yellow bar: lines that differ from the file's last-saved content
 *     (unsaved edits).
 *   - Orange bar: lines that differ from the file's VCS base content
 *     (uncommitted changes on disk relative to HEAD/BASE).
 *
 * When a line belongs to both, yellow is rendered in front so the user
 * still knows they have unsaved work there; the orange is obscured but
 * is still correct in the underlying state — it re-emerges once the line
 * is saved.
 *
 * Diffs run asynchronously (debounced, off the keystroke path) to avoid
 * blocking typing responsiveness.
 */

import { ViewPlugin, gutter, GutterMarker } from '@codemirror/view';
import { RangeSetBuilder, StateField, StateEffect, RangeSet } from '@codemirror/state';
import { seqDiff } from './xmlTokenizer';

// Effects — public API
export const setSavedContent = StateEffect.define();
export const setVcsBaseContent = StateEffect.define();

// Internal effects — used by the async diff plugin to hand computed line
// sets back to the state fields. Not exported; nothing outside this file
// should be driving these directly.
const setChangedLines = StateEffect.define();    // unsaved (yellow)
const setVcsChangedLines = StateEffect.define(); // vcs-modified (orange)

// ── State: saved content (what the file looked like last save) ──
const savedContentField = StateField.define({
  create() { return ''; },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSavedContent)) return effect.value;
    }
    return value;
  },
});

// ── State: VCS base content (what HEAD/BASE has for the file) ──
// Null when there is no VCS base available (untracked file, no provider
// connected, etc). A null value is treated as "no orange layer at all."
const vcsBaseContentField = StateField.define({
  create() { return null; },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVcsBaseContent)) return effect.value;
    }
    return value;
  },
});

// ── Markers ────────────────────────────────────────────────────────────
// Two visual styles. Same gutter column; CSS position:absolute so both
// can be drawn at once, with the yellow bar on top via z-index.
class YellowMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;top:0;width:3px;height:100%;' +
      'background:var(--gutter-changed,#e2c000);z-index:2;';
    return el;
  }
}
class OrangeMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;top:0;width:3px;height:100%;' +
      'background:var(--gutter-vcs-changed,#e27b00);z-index:1;';
    return el;
  }
}
class BothMarker extends GutterMarker {
  // Orange background with a yellow bar in front — the user sees yellow
  // but the orange peeks out as a narrow fringe so the "this line has
  // uncommitted changes too" signal isn't completely lost.
  toDOM() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;left:0;top:0;width:3px;height:100%;';
    const orange = document.createElement('div');
    orange.style.cssText =
      'position:absolute;left:0;top:0;width:3px;height:100%;' +
      'background:var(--gutter-vcs-changed,#e27b00);z-index:1;';
    const yellow = document.createElement('div');
    yellow.style.cssText =
      'position:absolute;left:0;top:0;width:3px;height:100%;' +
      'background:var(--gutter-changed,#e2c000);z-index:2;';
    wrap.appendChild(orange);
    wrap.appendChild(yellow);
    return wrap;
  }
}

const yellowMarker = new YellowMarker();
const orangeMarker = new OrangeMarker();
const bothMarker = new BothMarker();

// ── State: per-line status derived from the two diffs ──
// Each StateField holds a RangeSet of markers at line start positions.
// They're recomputed by the async diff plugin (see below) and merged at
// render time in the gutter() markers callback.
// Exported so the scrollbar overview markers (searchScrollMarkers.js) can
// read the same per-line change sets the gutter draws — keeping the two
// surfaces in lockstep. Consumers only ever READ positions from these.
export const changeMarkersField = StateField.define({
  create() { return RangeSet.empty; },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setChangedLines)) {
        const changed = effect.value;
        if (!changed || changed.size === 0) return RangeSet.empty;
        const builder = new RangeSetBuilder();
        for (const lineIdx of changed) {
          if (lineIdx < tr.state.doc.lines) {
            const line = tr.state.doc.line(lineIdx + 1);
            builder.add(line.from, line.from, yellowMarker);
          }
        }
        return builder.finish();
      }
    }
    return value;
  },
});

export const vcsMarkersField = StateField.define({
  create() { return RangeSet.empty; },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVcsChangedLines)) {
        const changed = effect.value;
        if (!changed || changed.size === 0) return RangeSet.empty;
        const builder = new RangeSetBuilder();
        for (const lineIdx of changed) {
          if (lineIdx < tr.state.doc.lines) {
            const line = tr.state.doc.line(lineIdx + 1);
            builder.add(line.from, line.from, orangeMarker);
          }
        }
        return builder.finish();
      }
    }
    return value;
  },
});

// ── Async diff scheduler ───────────────────────────────────────────────
// Recomputes both diffs after 300ms of quiet. Bails early when nothing
// relevant has changed since the last computation.
const diffScheduler = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.lastSaved = '';
      this.lastBase = null;
      this.lastDoc = '';
      this.scheduleDiff();
    }

    update(update) {
      const relevant = update.transactions.some(tr =>
        tr.effects.some(e => e.is(setSavedContent) || e.is(setVcsBaseContent))
      );
      if (update.docChanged || relevant) this.scheduleDiff();
    }

    scheduleDiff() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.computeDiff();
      }, 300);
    }

    computeDiff() {
      const view = this.view;
      const saved = view.state.field(savedContentField);
      const base = view.state.field(vcsBaseContentField);
      const current = view.state.doc.toString();

      // Fast-exit when nothing relevant changed since last run.
      if (
        saved === this.lastSaved &&
        base === this.lastBase &&
        current === this.lastDoc
      ) return;
      this.lastSaved = saved;
      this.lastBase = base;
      this.lastDoc = current;

      const effects = [];

      // Unsaved-edit diff (yellow).
      if (saved === current || !saved) {
        effects.push(setChangedLines.of(new Set()));
      } else {
        const changed = seqDiff(saved.split('\n'), current.split('\n'));
        effects.push(setChangedLines.of(changed));
      }

      // VCS-base diff (orange). null base = no provider data, clear.
      if (base == null) {
        effects.push(setVcsChangedLines.of(new Set()));
      } else if (base === current) {
        effects.push(setVcsChangedLines.of(new Set()));
      } else {
        const changed = seqDiff(base.split('\n'), current.split('\n'));
        effects.push(setVcsChangedLines.of(changed));
      }

      view.dispatch({ effects });
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  }
);

// ── Gutter extension ──────────────────────────────────────────────────
// Merge the two marker sets per line. We rebuild a RangeSet each render
// containing the *composed* marker (yellow-only / orange-only / both).
// This keeps the two underlying fields independent (one can update
// without invalidating the other) while still giving the gutter a
// single marker per line so position:absolute stacking works.
const changeGutter = gutter({
  class: 'cm-changeGutter',
  markers(view) {
    const yellow = view.state.field(changeMarkersField);
    const orange = view.state.field(vcsMarkersField);
    if (yellow.size === 0 && orange.size === 0) return RangeSet.empty;

    // Walk the doc line-by-line and compose. Efficient enough in
    // practice: CodeMirror only calls markers() per viewport pass and
    // both sets are small (only changed lines).
    const yellowPositions = new Set();
    const orangePositions = new Set();
    const yIter = yellow.iter();
    while (yIter.value) { yellowPositions.add(yIter.from); yIter.next(); }
    const oIter = orange.iter();
    while (oIter.value) { orangePositions.add(oIter.from); oIter.next(); }

    const builder = new RangeSetBuilder();
    // Union of positions, visited in sorted order so builder.add gets
    // ascending offsets (required by RangeSetBuilder).
    const positions = Array.from(new Set([...yellowPositions, ...orangePositions]))
      .sort((a, b) => a - b);
    for (const pos of positions) {
      const y = yellowPositions.has(pos);
      const o = orangePositions.has(pos);
      let marker;
      if (y && o) marker = bothMarker;
      else if (y) marker = yellowMarker;
      else marker = orangeMarker;
      builder.add(pos, pos, marker);
    }
    return builder.finish();
  },
  initialSpacer: () => yellowMarker,
});

/**
 * Create the change gutter extension.
 * Returns an array of CodeMirror extensions that together implement the
 * two-layer change gutter.
 */
export function createChangeGutter() {
  return [
    savedContentField,
    vcsBaseContentField,
    changeMarkersField,
    vcsMarkersField,
    diffScheduler,
    changeGutter,
  ];
}
