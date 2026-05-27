/**
 * Spellcheck engine and CM6 inline decoration extension.
 *
 * Uses nspell (Hunspell-compatible) for spelling with:
 * - Standard English dictionary (dictionary-en)
 * - User custom dictionary (_spellingDictionary.txt in DATA_ROOT)
 *
 * Inline decorations apply red wavy underlines on misspelled words in:
 * - XML files: string+is_localized attrs, internal_notes, *translation_notes*
 * - Metadata files: tooltip attribute values
 *
 * Also exports helpers used by validation.js for batch spellchecking.
 */

import { ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { tokenize, buildAttrMap } from './xmlTokenizer';

// ─── Word extraction ───────────────────────────────────────────────

// Split text into words with their offsets within the text.
// Skips: URLs, email addresses, paths, XML entities, ordinals, code-like tokens.
// Uses Unicode letter class + digits + hyphen so hyphenated tokens like "grav-lev"
// or "what-do-you-think" stay intact as one word. Alphanumeric tokens like "LD50"
// or "A1" also stay whole. All-digit tokens and words that are just hyphens are
// filtered out afterward so we don't flag pure numbers like "2023" or raw dashes.
const WORD_RE = /[\p{L}\d'\u2019-]+/gu;
const ORDINAL_RE = /^\d+(st|nd|rd|th)$/i;

/**
 * Returns true if `word` should be considered correctly spelled, either directly
 * or via the hyphenated-word fallback:
 *
 *   1. Direct dictionary check: checkWord(word, isDev) → true. nspell already
 *      accepts case variants — so if "Good" is in the dictionary, "GOOD" is also
 *      accepted automatically. (User-added custom words behave the same.)
 *   2. Hyphenated word: if every hyphen-separated part is acceptable (recursively),
 *      the whole word is treated as valid. Covers "grav-lev" (as a whole, if in dict),
 *      "what-do-you-think" (chained words), "gravlev-style" (parts are words or
 *      dictionary-accepted).
 */
function isWordAcceptable(word, checkWord, isDev) {
  if (checkWord(word, isDev)) return true;

  // All-digit tokens are not misspellings. The top-level extractor already
  // filters pure-digit standalone words, but they can appear as parts of a
  // hyphenated token like "50-7000km" — the hyphen fallback below recurses
  // into each part, so "50" and "7000km" both need to pass.
  if (/^\d+$/.test(word)) return true;

  // Hyphenated fallback — recurse per part. Each part must itself be acceptable.
  if (word.includes('-')) {
    const parts = word.split('-').filter((p) => p.length > 0);
    if (parts.length > 1 && parts.every((p) => isWordAcceptable(p, checkWord, isDev))) {
      return true;
    }
  }

  // Number-prefix fallback: "2000km", "100ml", "5kg", "32GB" etc. If the letter
  // suffix (the unit) is a valid word on its own, the whole token is accepted.
  // Also accept English approximators like "ish" and ordinal-ish "s" (e.g. "90s").
  const numPrefixMatch = /^\d+([A-Za-z]+)$/.exec(word);
  if (numPrefixMatch) {
    const suffix = numPrefixMatch[1];
    const low = suffix.toLowerCase();
    if (low === 'ish' || low === 's') return true;
    if (isWordAcceptable(suffix, checkWord, isDev)) return true;
  }

  return false;
}

/**
 * Classify a word by script composition.
 * Returns: 'ascii' (all a-z/A-Z), 'mixed' (both ASCII and non-ASCII letters),
 * 'nonascii' (all non-ASCII letters), or 'other'.
 */
export function classifyWordScript(word) {
  let hasAscii = false, hasNonAscii = false;
  for (let i = 0; i < word.length; i++) {
    const cp = word.charCodeAt(i);
    if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) hasAscii = true;
    else if (cp > 0x7F) hasNonAscii = true;
  }
  if (hasAscii && hasNonAscii) return 'mixed';
  if (hasAscii) return 'ascii';
  if (hasNonAscii) return 'nonascii';
  return 'other';
}

// Map of visually-identical (or near-identical) non-ASCII characters to their
// ASCII equivalents. Primarily Cyrillic and Greek capitals/lowercase that look
// like Latin letters. Used for auto-fix suggestions on mixed-script words.
const HOMOGLYPH_MAP = {
  // Cyrillic uppercase
  '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E', '\u041D': 'H',
  '\u041A': 'K', '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0422': 'T',
  '\u0425': 'X', '\u0423': 'Y', '\u0406': 'I', '\u0408': 'J',
  // Cyrillic lowercase
  '\u0430': 'a', '\u0441': 'c', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j',
  // Greek uppercase
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
  // Greek lowercase that look like Latin
  '\u03BF': 'o', '\u03C1': 'p', '\u03C5': 'u', '\u03C7': 'x',
};

/**
 * Convert a mixed-script word's non-ASCII homoglyphs to their ASCII equivalents.
 * Returns the converted word, or null if any non-ASCII character has no known
 * ASCII equivalent (in which case we can't auto-fix).
 */
export function asciifyHomoglyphs(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const cp = ch.charCodeAt(0);
    if (cp <= 0x7F) {
      out += ch;
    } else if (HOMOGLYPH_MAP[ch]) {
      out += HOMOGLYPH_MAP[ch];
    } else {
      return null; // Unknown non-ASCII — can't safely convert
    }
  }
  return out;
}

// Patterns to blank out before word extraction (replaced with spaces to preserve offsets)
const URL_RE = /https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}(?:\/[^\s<>"]*)?/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// File/URL-style paths, e.g. "/PlayerData/Dumps/NPCTargeting/", "foo/bar", "./relative".
// Requires at least one "/" between path-like segments to distinguish from prose.
// Runs after URL_RE so full URLs (https://...) are blanked first.
const PATH_RE = /[a-zA-Z0-9_\-.]*\/[a-zA-Z0-9_\-.]+(?:\/[a-zA-Z0-9_\-.]*)*/g;
// Curly-brace markup tokens (text substitution / interpolation placeholders):
// {RClick}, {0}, {player_name}, etc. Skip these entirely.
const CURLY_MARKUP_RE = /\{[^{}]*\}/g;
// Escaped XML/HTML-like markup used inside localizable strings, e.g. "&lt;color=#47a4ec&gt;"
// or "&lt;link=EnemyAndCanvas&gt;...&lt;/link&gt;". The text BETWEEN opening and closing
// tags is still extracted (it's visible to the player); only the tag markers are blanked.
// This MUST run before the plain ENTITY_RE so we don't prematurely blank out &lt;/&gt;
// inside a still-complete markup tag span.
const ESCAPED_MARKUP_RE = /&lt;[\s\S]*?&gt;/g;
const ENTITY_RE = /&[a-zA-Z]+;|&#[0-9]+;|&#x[0-9a-fA-F]+;/g;
const ORDINAL_FULL_RE = /\d+(?:st|nd|rd|th)\b/gi;

// Variable-like identifiers used in developer notes fields (tooltip, internal_notes,
// *translation_notes). A single word token is treated as an identifier if it contains
// AT LEAST ONE of these signals:
//   1. An underscore between identifier chars (is_considered_basic_guard, Debug_IncludeInWorkProgress)
//   2. A lowercase→uppercase transition (myVariable, IncludeInWorkProgress)
//   3. A digit adjacent to a letter (A5LevelItemCategory, Level5Item, apple2banana)
// A single-word PascalCase name like "Proper" or "USA" is NOT matched — those are proper nouns.
// Plain numbers or words without any of these signals are also NOT matched.
const IDENTIFIER_RE = /\b(?=[a-zA-Z0-9_]*(?:_|[a-z][A-Z]|\d[a-zA-Z]|[a-zA-Z]\d))[a-zA-Z0-9_]+\b/g;

/**
 * Extract words from text, blanking out patterns that shouldn't be spellchecked.
 * @param {string} text — source text
 * @param {boolean} skipIdentifiers — if true, also blank out variable-like identifiers.
 *   Pass true for developer-notes fields (tooltip, internal_notes, *translation_notes).
 *   Pass false for user-facing fields (display_name, description, etc.).
 */
function extractWords(text, skipIdentifiers = false) {
  // Blank out URLs, emails, paths, escaped markup tags, plain XML entities, and ordinals
  // (replace with spaces to keep offsets stable).
  // Order matters:
  //  - ESCAPED_MARKUP runs before ENTITY so full "&lt;tag&gt;" spans are blanked as a unit
  //    (otherwise &lt; and &gt; get blanked individually, leaving the tag internals exposed).
  //  - URL runs before PATH so full URLs (https://...) are blanked first; PATH then picks up
  //    bare paths like "/PlayerData/Dumps/NPCTargeting/" that URL_RE wouldn't catch.
  let cleaned = text;
  const patterns = [ESCAPED_MARKUP_RE, CURLY_MARKUP_RE, URL_RE, EMAIL_RE, PATH_RE, ENTITY_RE, ORDINAL_FULL_RE];
  if (skipIdentifiers) patterns.push(IDENTIFIER_RE);
  for (const re of patterns) {
    re.lastIndex = 0;
    cleaned = cleaned.replace(re, (match) => ' '.repeat(match.length));
  }

  const words = [];
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(cleaned)) !== null) {
    let w = m[0];
    let offset = m.index;

    // Strip leading quotes/apostrophes/hyphens (e.g., 'word → word, -dash → dash)
    while (w.length > 0 && (w[0] === "'" || w[0] === '\u2019' || w[0] === '-')) {
      w = w.slice(1);
      offset++;
    }
    // Strip trailing quotes/apostrophes/hyphens (e.g., word' → word, word- → word)
    while (w.length > 0 && (w[w.length - 1] === "'" || w[w.length - 1] === '\u2019' || w[w.length - 1] === '-')) {
      w = w.slice(0, -1);
    }

    // Skip single characters or empty after stripping
    if (w.length <= 1) continue;
    // Skip pure-digit tokens (e.g. "2023", "42") — those aren't words to spellcheck
    if (!/\p{L}/u.test(w)) continue;
    words.push({ word: w, offset });
  }
  return words;
}

// ─── Spellcheck target detection ───────────────────────────────────

/**
 * Determine if an attribute (from buildAttrMap) should be spellchecked.
 * @param {object} attr — attribute from buildAttrMap
 * @returns {boolean}
 */
export function isSpellcheckTarget(attr) {
  // Never spellcheck ID-like attributes, even if somehow marked localized.
  // These are opaque identifiers (foreign-key targets, layer IDs, etc.), not human text.
  if (attr.nm === 'id' || attr.nm === 'key') return false;
  if (attr.d) {
    if (truthyFlag(attr.d.is_central_identifier)) return false;
    if (truthyFlag(attr.d.is_id_for_layer)) return false;
    if (truthyFlag(attr.d.is_partial_identifier)) return false;
    if (truthyFlag(attr.d.is_data_copy_identifier)) return false;
    // Explicit opt-out: never spellcheck or grammar-check this attribute
    if (truthyFlag(attr.d.no_spellcheck_or_grammar)) return false;
    // sub_id, path, FQN, ClassName, DllName, and MethodName are opaque
    // identifier types — never check them even if they somehow had
    // is_localized set. These behave like strings for editing but their
    // contents are references to IDs, filesystem paths, or code
    // class/method/DLL names, not human text.
    if (
      attr.d.type === 'sub_id' ||
      attr.d.type === 'path' ||
      attr.d.type === 'FQN' ||
      attr.d.type === 'ClassName' ||
      attr.d.type === 'DllName' ||
      attr.d.type === 'MethodName'
    ) return false;
  }

  // By attribute key name (regardless of type/schema)
  if (attr.nm === 'internal_notes') return true;
  if (attr.nm.includes('translation_notes')) return true;

  // By schema definition: type="string" with the is_localized flag set.
  // If is_localized="true" → user-facing text (normal spellcheck)
  // If is_localized="false" (via existing-override) → dev-facing text, still spellchecked
  //   but with identifier exclusions applied (see isInferredDevContext below).
  // If is_localized is missing entirely → not a localization field, skip.
  if (attr.d && attr.d.type === 'string' && attr.d.is_localized !== undefined && attr.d.is_localized !== null) {
    return true;
  }

  return false;
}

/**
 * Returns true if this attribute's text should be treated as developer-facing
 * even if the attribute key isn't one of the known dev-notes names. Used to
 * enable variable-name exclusions in these contexts:
 *   - is_localized="false" override (e.g. BuildingPrefab, LevelEditorPaletteGroup)
 *   - node has skip_all_localization_on_node="true" (Lang nodes flagged untranslated)
 */
export function isInferredDevContext(attr) {
  if (!attr || !attr.d) return false;
  // Overridden to non-localized → the text is dev-facing
  if (attr.d.is_localized === 'false' || attr.d.is_localized === false) return true;
  return false;
}

// Interpret schema boolean flags (stored as strings like "true"/"false")
function truthyFlag(val) {
  return val === 'true' || val === true;
}

/**
 * Check if an attribute in a metadata file should be spellchecked.
 * Only tooltip values get checked in metadata.
 * @param {string} attrName
 * @returns {boolean}
 */
export function isMetadataSpellcheckTarget(attrName) {
  return attrName === 'tooltip';
}

/**
 * Returns true if the attribute is a "developer notes" field where variable-like
 * identifiers (CamelCase, snake_case) should be treated as code references, not words.
 * These are: internal_notes, anything with translation_notes in the key, and tooltip
 * (in metadata). User-facing fields like display_name, description, etc. return false.
 */
export function isDevNotesAttr(attrName) {
  if (attrName === 'internal_notes') return true;
  if (attrName === 'tooltip') return true;
  if (attrName && attrName.includes('translation_notes')) return true;
  return false;
}

// ─── Forbidden characters ──────────────────────────────────────────
//
// Certain typographic Unicode characters don't render correctly in every
// font the game ships. They get reported as spelling errors with an ASCII
// replacement as the suggestion, so the validator's normal "Replace
// with X" / "Replace all X with Y" context-menu actions just work.
//
// Detected in BOTH user-facing and dev-context attributes — they're easy
// to introduce by accident (autocorrect, paste from Word/Slack) and there's
// no good reason to allow them anywhere in source.
const FORBIDDEN_CHAR_FIXES = {
  '…': { fix: '...', name: 'ellipsis' },
  '—': { fix: '--', name: 'em-dash' },
  '–': { fix: '-', name: 'en-dash' },
  '‘': { fix: "'", name: 'left single quote' },
  '’': { fix: "'", name: 'right single quote' },
  '“': { fix: '"', name: 'left double quote' },
  '”': { fix: '"', name: 'right double quote' },
};

/**
 * Look up the ASCII replacement for a single forbidden character. Returns
 * `null` if the character isn't on the forbidden list. Used by both the
 * inline editor's right-click handler and the validator window's context
 * menu so the fix logic stays in one place.
 */
export function getForbiddenCharFix(ch) {
  const info = FORBIDDEN_CHAR_FIXES[ch];
  return info ? info.fix : null;
}

function wordContainsForbiddenChar(word) {
  for (let i = 0; i < word.length; i++) {
    if (FORBIDDEN_CHAR_FIXES[word[i]]) return true;
  }
  return false;
}

/**
 * Build the leading "Spelling: ..." portion of a validator message for a
 * misspelled-word entry. Each call site appends its own snippet and
 * "Did you mean: X?" suffix afterward, so this helper is just about the
 * prefix shape — kept centralized so the three entry kinds (normal /
 * mixed-script / forbidden-char) stay formatted consistently.
 */
export function spellingMessagePrefix(m) {
  if (m.forbiddenChar) {
    return `Spelling: "${m.word}" (${m.forbiddenName}) in ${m.attrName}`;
  }
  if (m.mixedScript) {
    return `Spelling: "${m.word}" (mixed script / homoglyph) in ${m.attrName}`;
  }
  return `Spelling: "${m.word}" in ${m.attrName}`;
}

function findForbiddenCharsInValue(value, valueStartPos, attrName, isDev) {
  const out = [];
  for (let i = 0; i < value.length; i++) {
    const info = FORBIDDEN_CHAR_FIXES[value[i]];
    if (!info) continue;
    out.push({
      word: value[i],
      absPos: valueStartPos + i,
      attrName,
      suggestions: [info.fix],
      isDev,
      forbiddenChar: true,
      forbiddenName: info.name,
    });
  }
  return out;
}

// ─── Batch spellcheck (for validation) ─────────────────────────────

/**
 * Check all spellcheck-target attributes in a file's content.
 * Returns array of { word, offset, line, attrName, suggestions }.
 *
 * @param {string} content — file text
 * @param {object} mergedSchema — from buildMergedSchema()
 * @param {function} checkWord — (word) => boolean (true = correct)
 * @param {function} suggestWord — (word) => string[]
 * @returns {Array<{word: string, absPos: number, attrName: string}>}
 */
export function findMisspelledWords(content, mergedSchema, checkWord, suggestWord) {
  const results = [];
  const tokens = tokenize(content);
  const attrMap = buildAttrMap(tokens, mergedSchema);

  // Ranges inside nodes with skip_all_localization_on_node="true" — treated as
  // developer-facing (spellchecked, but variable identifiers are excluded).
  const devRanges = buildNodeFlagRanges(tokens, content, 'skip_all_localization_on_node');
  // Ranges inside nodes with no_spellcheck_or_grammar="true" — skip entirely.
  const skipRanges = buildNodeFlagRanges(tokens, content, 'no_spellcheck_or_grammar');

  for (const attr of attrMap) {
    if (!isSpellcheckTarget(attr)) continue;
    if (!attr.v) continue;
    // Node-level "never check" flag: skip this attribute entirely
    if (isInRange(skipRanges, attr.vs)) continue;

    // Is this attribute a dev context? True if:
    //  - the attr name is itself a dev-notes name (internal_notes, tooltip, *translation_notes*)
    //  - is_localized was explicitly overridden to "false" for this attr
    //  - the attr lives inside a node with skip_all_localization_on_node="true"
    const isDev = isDevNotesAttr(attr.nm)
      || isInferredDevContext(attr)
      || isInRange(devRanges, attr.vs);

    const words = extractWords(attr.v, isDev);
    for (const { word, offset } of words) {
      // Words containing forbidden chars (smart quotes, em-dashes etc.)
      // are reported separately by the per-char pass below — no point
      // running nspell on them, as the dictionary would reject them
      // for the wrong reason and produce noisy double-flags.
      if (wordContainsForbiddenChar(word)) continue;

      const script = classifyWordScript(word);
      if (script === 'nonascii' || script === 'other') continue; // foreign text — skip
      if (script === 'mixed') {
        // Mixed-script: keep strict direct check (homoglyphs shouldn't be helped
        // by hyphen-split or emphasis fallbacks).
        if (checkWord(word, isDev)) continue;
        results.push({
          word, absPos: attr.vs + offset, attrName: attr.nm,
          suggestions: [], mixedScript: true, isDev,
        });
        continue;
      }
      if (!isWordAcceptable(word, checkWord, isDev)) {
        const suggestions = suggestWord ? suggestWord(word).slice(0, 5) : [];
        results.push({
          word,
          absPos: attr.vs + offset,
          attrName: attr.nm,
          suggestions,
          isDev,
        });
      }
    }

    // Per-character forbidden-char pass — runs on every spellcheckable attribute
    // regardless of dev context.
    results.push(...findForbiddenCharsInValue(attr.v, attr.vs, attr.nm, isDev));
  }

  return results;
}

/**
 * Find misspelled words in metadata tooltip values.
 * Uses raw token walking since metadata doesn't use buildAttrMap with a schema.
 *
 * @param {string} content — metadata file text
 * @param {function} checkWord
 * @param {function} suggestWord
 * @returns {Array<{word: string, absPos: number, attrName: string}>}
 */
export function findMisspelledWordsInMetadata(content, checkWord, suggestWord) {
  const results = [];
  const tokens = tokenize(content);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].c !== 'an' || tokens[i].s !== 'tooltip') continue;
    // Find the next attribute value token
    for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
      if (tokens[j].c === 'av') {
        const val = tokens[j].s;
        const valPos = tokens[j].p;
        // Metadata only spellchecks 'tooltip' — always a dev-notes field
        const words = extractWords(val, true);
        for (const { word, offset } of words) {
          if (wordContainsForbiddenChar(word)) continue;
          const script = classifyWordScript(word);
          if (script === 'nonascii' || script === 'other') continue;
          if (script === 'mixed') {
            if (checkWord(word, true)) continue;
            results.push({
              word, absPos: valPos + offset, attrName: 'tooltip',
              suggestions: [], mixedScript: true, isDev: true,
            });
            continue;
          }
          if (!isWordAcceptable(word, checkWord, true)) {
            const suggestions = suggestWord ? suggestWord(word).slice(0, 5) : [];
            results.push({
              word,
              absPos: valPos + offset,
              attrName: 'tooltip',
              suggestions,
              isDev: true,
            });
          }
        }
        results.push(...findForbiddenCharsInValue(val, valPos, 'tooltip', true));
        break;
      }
    }
  }

  return results;
}

// ─── CM6 Inline Decoration Extension ───────────────────────────────

const spellingErrorMark = Decoration.mark({ class: 'cm-spelling-error' });

/**
 * Create a CM6 ViewPlugin that underlines misspelled words.
 *
 * @param {function} getSchema — returns current merged schema (null for metadata)
 * @param {function} getSpellchecker — returns { correct(word), suggest(word) } or null
 * @param {boolean} isSchemaFile — true if editing a .metadata file
 */
export function createSpellcheckDecorations(getSchema, getSpellchecker, isSchemaFile) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = this.buildDecorations(view);
        this.rebuildTimer = null;
      }

      // Debounced rebuild. Spellcheck is the heaviest per-keystroke work:
      // it tokenizes the full document, builds an attribute map, and then
      // for every spellchecked attribute runs extractWords + dictionary
      // lookup per word. Running that every keystroke on a large schema
      // file blows the frame budget. 150 ms debounce coalesces keystroke
      // bursts into one rebuild; squiggles only lag while the user is
      // actively typing, which matches VSCode/IntelliJ behavior.
      //
      // Map the decoration set forward through every doc change so
      // squiggles stay anchored to the words they describe during the
      // debounce window. Without mapping, existing underlines would sit
      // at the wrong offsets after any insertion/deletion — the visible
      // "swirl" effect on lines the user isn't typing on.
      //
      // viewportChanged is not a trigger — decorations are positional
      // and CodeMirror clips them to the viewport itself.
      update(update) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
          this.scheduleRebuild();
        }
      }

      scheduleRebuild() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => {
          this.rebuildTimer = null;
          this.decorations = this.buildDecorations(this.view);
          this.view.dispatch({});
        }, 150);
      }

      destroy() {
        if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      }

      buildDecorations(view) {
        const checker = getSpellchecker();
        if (!checker) return Decoration.none;

        const doc = view.state.doc.toString();
        const decos = [];

        if (isSchemaFile) {
          // Metadata: check tooltip values only (always a dev-notes field)
          const tokens = tokenize(doc);
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].c !== 'an' || tokens[i].s !== 'tooltip') continue;
            for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
              if (tokens[j].c === 'av') {
                this.checkValue(tokens[j].s, tokens[j].p, checker, decos, true);
                break;
              }
            }
          }
        } else {
          // XML: check spellcheck-target attributes
          const schema = getSchema();
          if (!schema) return Decoration.none;

          const tokens = tokenize(doc);
          const attrMap = buildAttrMap(tokens, schema);
          const devRanges = buildNodeFlagRanges(tokens, doc, 'skip_all_localization_on_node');
          const skipRanges = buildNodeFlagRanges(tokens, doc, 'no_spellcheck_or_grammar');

          for (const attr of attrMap) {
            if (!isSpellcheckTarget(attr)) continue;
            if (!attr.v) continue;
            if (isInRange(skipRanges, attr.vs)) continue;
            const isDev = isDevNotesAttr(attr.nm)
              || isInferredDevContext(attr)
              || isInRange(devRanges, attr.vs);
            this.checkValue(attr.v, attr.vs, checker, decos, isDev);
          }
        }

        if (decos.length === 0) return Decoration.none;

        // Sort by position (required by RangeSetBuilder)
        decos.sort((a, b) => a.from - b.from || a.to - b.to);

        const builder = new RangeSetBuilder();
        for (const d of decos) {
          builder.add(d.from, d.to, spellingErrorMark);
        }
        return builder.finish();
      }

      checkValue(value, valueStartPos, checker, decos, isDev) {
        const words = extractWords(value, isDev);
        const checkFn = (w, dev) => checker.correct(w, dev);
        for (const { word, offset } of words) {
          // Same dedup rule as the batch pass — let the forbidden-char
          // pass below own any word that contains one of those chars.
          if (wordContainsForbiddenChar(word)) continue;
          const script = classifyWordScript(word);
          if (script === 'nonascii' || script === 'other') continue;
          // Flag words not accepted by dictionary or the hyphen/emphasis fallbacks.
          if (!isWordAcceptable(word, checkFn, isDev)) {
            decos.push({
              from: valueStartPos + offset,
              to: valueStartPos + offset + word.length,
            });
          }
        }
        // Per-char forbidden decoration — same red-squiggle class.
        for (let i = 0; i < value.length; i++) {
          if (FORBIDDEN_CHAR_FIXES[value[i]]) {
            decos.push({
              from: valueStartPos + i,
              to: valueStartPos + i + 1,
            });
          }
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// ─── Localization dev-context support ──────────────────────────────

/**
 * Scan tokens to find ranges of nodes that have a specific attribute set to "true".
 * Returns sorted array of { from, to } ranges covering each matching node, or null.
 *
 * Used to identify:
 *   - skip_all_localization_on_node="true" → treat as developer-facing (dev context)
 *   - no_spellcheck_or_grammar="true" → skip spell + grammar entirely on this node
 */
export function buildNodeFlagRanges(tokens, content, flagName) {
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].c !== 'an' || tokens[i].s !== flagName) continue;
    // Find the value
    let val = null;
    for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
      if (tokens[j].c === 'av') { val = tokens[j].s; break; }
    }
    if (val !== 'true') continue;

    // Find the opening bracket of this tag
    let tagStart = tokens[i].p;
    while (tagStart > 0 && content[tagStart] !== '<') tagStart--;

    // Find the end of this node (closing tag or self-closing)
    let depth = 0;
    let tagEnd = content.length;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].c === 'br') {
        if (tokens[j].s === '/>') {
          if (depth === 0) { tagEnd = tokens[j].p + 2; break; }
        } else if (tokens[j].s === '>') {
          // Could be opening tag end — next non-whitespace determines
        } else if (tokens[j].s === '</') {
          if (depth === 0) {
            // Find closing >
            for (let k = j + 1; k < tokens.length; k++) {
              if (tokens[k].c === 'br' && tokens[k].s === '>') {
                tagEnd = tokens[k].p + 1;
                break;
              }
            }
            break;
          }
          depth--;
        } else if (tokens[j].s === '<' && j > i) {
          depth++;
        }
      }
    }

    ranges.push({ from: tagStart, to: tagEnd });
  }

  return ranges.length > 0 ? ranges : null;
}

/**
 * Check if a position falls within any dev-context range.
 */
export function isInRange(ranges, pos) {
  if (!ranges) return false;
  for (const r of ranges) {
    if (pos >= r.from && pos < r.to) return true;
  }
  return false;
}
