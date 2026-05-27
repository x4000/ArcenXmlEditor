// Grammar target extraction — what gets sent to the LLM grammar checker.
//
// Mirrors the spellcheck-target rules but skips a few categories the user
// chose to exclude from grammar checking specifically:
//   - dev-context fields (internal_notes, tooltip, *translation_notes*, and
//     anything inside skip_all_localization_on_node) — they're code/notes,
//     not user-facing prose
//   - attribute values that contain {placeholder} markers — the surrounding
//     prose is intentionally a bit awkward for translation flexibility, and
//     the false-positive rate from grammar checkers there is too high
//
// Numeric placeholders {0}, {1}, … get substituted with a default noun
// ("Diamond") in the cleaned text so the LLM can reason about a complete
// sentence; word-form placeholders ({RClick}, {player_name}) get blanked
// to spaces. The original text is preserved for displaying to the user.

import { tokenize, buildAttrMap } from './xmlTokenizer';
import {
  isSpellcheckTarget,
  buildNodeFlagRanges,
  isInRange,
  isDevNotesAttr,
  isInferredDevContext,
} from './spellcheck';

const NUMERIC_PLACEHOLDER_RE = /\{\d+\}/g;
const OTHER_CURLY_RE = /\{[^{}]*\}/g;
const ESCAPED_MARKUP_RE = /&lt;[\s\S]*?&gt;/g;
const URL_RE = /https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|[a-zA-Z0-9._-]+\.[a-zA-Z]{2,}(?:\/[^\s<>"]*)?/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PATH_RE = /[a-zA-Z0-9_\-.]*\/[a-zA-Z0-9_\-.]+(?:\/[a-zA-Z0-9_\-.]*)*/g;
const ENTITY_RE = /&[a-zA-Z]+;|&#[0-9]+;|&#x[0-9a-fA-F]+;/g;

const ANY_CURLY_PLACEHOLDER_RE = /\{[^{}]*\}/;

const PLACEHOLDER_NOUN = 'Diamond';

/**
 * Clean text for grammar checking. Returns a string suitable for the LLM.
 * Numeric placeholders are substituted with a noun so sentences stay
 * grammatical; other markup is blanked with spaces to keep the surrounding
 * sentence shape intact.
 */
export function cleanForGrammar(text) {
  if (!text) return '';
  let out = text;
  out = out.replace(NUMERIC_PLACEHOLDER_RE, () => PLACEHOLDER_NOUN);
  for (const re of [ESCAPED_MARKUP_RE, OTHER_CURLY_RE, URL_RE, EMAIL_RE, PATH_RE, ENTITY_RE]) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => ' '.repeat(m.length));
  }
  return out;
}

/**
 * Extract grammar targets from an XML file. Returns array of:
 *   { text, cleanedText, attrName, nodeId, absPos, isDev, hasPlaceholder }
 *
 * `text` is the original attribute value (used for display + indexOf when
 * mapping a quote back to a position). `cleanedText` is what gets sent to
 * the LLM. They differ when the attribute contained markup or numeric
 * placeholders.
 *
 * Targets in dev contexts and targets containing any {placeholder} are
 * still returned but flagged via isDev / hasPlaceholder; the caller chooses
 * whether to actually send them to the LLM.
 */
export function extractGrammarTargets(content, mergedSchema) {
  const targets = [];
  if (!mergedSchema) return targets;

  const tokens = tokenize(content);
  const attrMap = buildAttrMap(tokens, mergedSchema);

  const skipRanges = buildNodeFlagRanges(tokens, content, 'no_spellcheck_or_grammar');
  const devRanges = buildNodeFlagRanges(tokens, content, 'skip_all_localization_on_node');

  let activeNodeId = '';
  for (const attr of attrMap) {
    if (attr.nm === 'id' && attr.v) {
      activeNodeId = attr.v;
    }

    if (!isSpellcheckTarget(attr)) continue;
    if (!attr.v || attr.v.trim().length === 0) continue;
    if (isInRange(skipRanges, attr.vs)) continue;

    const isDev = isDevNotesAttr(attr.nm)
      || isInferredDevContext(attr)
      || isInRange(devRanges, attr.vs);

    targets.push({
      text: attr.v,
      cleanedText: cleanForGrammar(attr.v),
      attrName: attr.nm,
      nodeId: activeNodeId,
      absPos: attr.vs,
      isDev,
      hasPlaceholder: ANY_CURLY_PLACEHOLDER_RE.test(attr.v),
    });
  }

  return targets;
}
