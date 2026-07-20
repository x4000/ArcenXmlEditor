export const IGNORE_SPELLING_ATTR = ' no_spellcheck_or_grammar="true"';

// Find the opening XML tag that contains an absolute spelling position. The
// spelling engine reports positions inside attribute values, so the relevant
// node is the opening tag whose [start, end] range contains the position.
// Quoted `>` characters do not terminate a tag.
export function findOpeningTagAtPosition(content, absPos) {
  if (typeof content !== 'string' || !Number.isFinite(absPos)) return null;

  let i = 0;
  while (i < content.length) {
    if (content[i] !== '<' || i + 1 >= content.length || !/[A-Za-z_]/.test(content[i + 1])) {
      i++;
      continue;
    }

    const start = i;
    let tagNameEnd = i + 1;
    while (tagNameEnd < content.length && /[A-Za-z0-9_:-]/.test(content[tagNameEnd])) {
      tagNameEnd++;
    }

    let end = tagNameEnd;
    let inQuote = null;
    while (end < content.length) {
      const ch = content[end];
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === '>') {
        break;
      }
      end++;
    }

    if (end >= content.length) return null;
    if (absPos >= start && absPos <= end) {
      const tagBody = content.slice(tagNameEnd, end);
      const hasIgnoreAttribute = /\bno_spellcheck_or_grammar\s*=/.test(tagBody);
      const insertAt = content[end - 1] === '/' ? end - 1 : end;
      return { start, end, insertAt, hasIgnoreAttribute };
    }

    i = end + 1;
  }

  return null;
}

// Add the node-level spelling-ignore attribute for all supplied occurrences.
// Multiple misspellings in one node collapse to one insertion, and nodes that
// already have the attribute are skipped. Insertions use original-document
// positions and are applied from right to left so earlier offsets never shift.
export function addIgnoreAttributesForSpellingPositions(content, absPositions) {
  const nodesByStart = new Map();
  for (const absPos of (Array.isArray(absPositions) ? absPositions : [absPositions])) {
    const node = findOpeningTagAtPosition(content, absPos);
    if (node && !nodesByStart.has(node.start)) nodesByStart.set(node.start, node);
  }

  const nodes = [...nodesByStart.values()];
  const insertions = nodes
    .filter((node) => !node.hasIgnoreAttribute)
    .map((node) => ({ from: node.insertAt, insert: IGNORE_SPELLING_ATTR }))
    .sort((a, b) => a.from - b.from);

  let updated = content;
  for (let i = insertions.length - 1; i >= 0; i--) {
    const change = insertions[i];
    updated = updated.slice(0, change.from) + change.insert + updated.slice(change.from);
  }

  return { content: updated, insertions, nodes };
}
