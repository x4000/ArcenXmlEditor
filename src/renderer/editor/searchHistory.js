/**
 * In-memory search/replace history. Four caches, kept per-window for the
 * lifetime of the renderer process — never written to disk.
 *
 *   global-find      — the GlobalSearch panel's find input
 *   global-replace   — the GlobalSearch panel's replace input
 *   local-find       — CodeMirror in-editor search panel's find input
 *   local-replace    — CodeMirror in-editor search panel's replace input
 *
 * Per the user spec the four caches do NOT share entries: a search you
 * ran in the editor's local Ctrl+F doesn't appear in the global search
 * find dropdown. Find and replace caches also stay separate.
 */

const MAX_ENTRIES = 30;

const caches = {
  'global-find': [],
  'global-replace': [],
  'local-find': [],
  'local-replace': [],
};

/**
 * Add `value` to the named cache. Empty/non-string values are ignored.
 * If the value already exists it's moved to the front (most-recent),
 * not duplicated. Cache is capped at 30 entries; oldest fall off.
 */
export function addEntry(cacheName, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  const cache = caches[cacheName];
  if (!cache) return;
  const idx = cache.indexOf(value);
  if (idx >= 0) cache.splice(idx, 1);
  cache.unshift(value);
  if (cache.length > MAX_ENTRIES) cache.length = MAX_ENTRIES;
}

/**
 * Returns a fresh copy of the cache so callers can render without
 * worrying about mutation. Order is most-recent first.
 */
export function getEntries(cacheName) {
  return caches[cacheName] ? [...caches[cacheName]] : [];
}
