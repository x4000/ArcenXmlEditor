/**
 * Display-name helpers for the suite-mode layer system.
 *
 * A file belongs to a layer — 'base' or 'dlc<N>'. DLC files are shown in the
 * same folder rows as base files (as if they were never moved out), so the
 * UI needs a way to flag which ones come from an expansion.
 *
 * Rule (per design): if a DLC file's name already ends with the matching
 * `_DLC<N>` suffix, the suffix already communicates the layer — leave the
 * name alone. Otherwise append a ` [DLC<N>]` tag. A file carrying a `_DLC`
 * suffix for the *wrong* number still gets the correct `[DLC<N>]` tag so the
 * mismatch is visible.
 */

// Strip .xml / .metadata for display. Every file in the editor is one of
// those two types; repeating the extension on every row is visual noise.
export function stripDataExt(fileName) {
  return (fileName || '').replace(/\.(xml|metadata)$/i, '');
}

// The suite-mode base layer's path prefix. Constant of the suite layout.
const SUITE_BASE_PREFIX = 'GameData/Configuration/';

// Trim the base-layer prefix from a relativePath for display. In suite mode
// base-game files become bare <folder>/<file>, dropping the GameData/
// Configuration/ noise that would otherwise repeat on every row. Expansion
// files keep their Expansions/<dir>/ prefix — there, the location usefully
// identifies the layer. A no-op in narrow mode (no prefix present).
export function displayRelPath(relPath) {
  if (typeof relPath !== 'string') return relPath;
  return relPath.startsWith(SUITE_BASE_PREFIX)
    ? relPath.slice(SUITE_BASE_PREFIX.length)
    : relPath;
}

/**
 * Compute the display name for a file given its layer.
 *
 * @param {string} fileName — bare filename (with extension)
 * @param {string} [layer] — 'base' | 'dlc<N>' | 'mod_<src>_<dir>'
 * @param {number} [layerNum] — 0 for base, N for dlc<N>, 1000+ for mod files
 * @param {string} [modDisplayName] — only for mod-layer files, the mod's
 *   English display name from ModDetails.xml. Required to produce the
 *   "[Mod: <Name>]" tag — without it the tag falls back to the layer id.
 */
export function fileDisplayName(fileName, layer, layerNum, modDisplayName) {
  const base = stripDataExt(fileName);
  if (!layer || layer === 'base') return base;
  // Mod-layer files: tag with the mod's display name, no number.
  if (layer.startsWith('mod_')) {
    const name = modDisplayName || layer.replace(/^mod_[xnw]_/, '');
    return `${base} [Mod: ${name}]`;
  }
  // DLC files: tag with DLC<N> unless the filename already carries the
  // matching _DLC<N> suffix.
  if (!layerNum) return base;
  if (new RegExp(`_DLC${layerNum}$`, 'i').test(base)) return base;
  return `${base} [DLC${layerNum}]`;
}
