/**
 * XML tokenizer and attribute map builder.
 * Ported from the prototype's tok() and bAM() functions.
 * Used for schema-aware highlighting, click handling, and context menus.
 */

/**
 * Token classes:
 *   cm = comment, xd = xml declaration, br = bracket/punctuation,
 *   tg = tag name, an = attribute name, av = attribute value,
 *   qt = quote, t = text/whitespace
 */
export function tokenize(src) {
  const tk = [];
  let i = 0;
  const L = src.length;

  while (i < L) {
    // Comment
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i);
      const end = e < 0 ? L : e + 3;
      tk.push({ c: 'cm', s: src.slice(i, end), p: i });
      i = end;
    }
    // XML declaration
    else if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i);
      const end = e < 0 ? L : e + 2;
      tk.push({ c: 'xd', s: src.slice(i, end), p: i });
      i = end;
    }
    // Closing tag
    else if (src.startsWith('</', i)) {
      tk.push({ c: 'br', s: '</', p: i });
      i += 2;
      const m = src.slice(i).match(/^[\w.-]+/);
      if (m) {
        tk.push({ c: 'tg', s: m[0], p: i });
        i += m[0].length;
      }
      if (i < L && src[i] === '>') {
        tk.push({ c: 'br', s: '>', p: i });
        i++;
      }
    }
    // Opening tag
    else if (src[i] === '<') {
      tk.push({ c: 'br', s: '<', p: i });
      i++;
      const m = src.slice(i).match(/^[\w.-]+/);
      if (m) {
        tk.push({ c: 'tg', s: m[0], p: i });
        i += m[0].length;
      }
      // Parse attributes until > or />
      while (i < L && src[i] !== '>' && !(src[i] === '/' && i + 1 < L && src[i + 1] === '>')) {
        const ws = src.slice(i).match(/^\s+/);
        if (ws) {
          tk.push({ c: 't', s: ws[0], p: i });
          i += ws[0].length;
          continue;
        }
        const am = src.slice(i).match(/^([\w.-]+)(\s*=\s*)/);
        if (am) {
          tk.push({ c: 'an', s: am[1], p: i });
          tk.push({ c: 'br', s: am[2], p: i + am[1].length });
          i += am[0].length;
          if (i < L && src[i] === '"') {
            const e = src.indexOf('"', i + 1);
            const end = e < 0 ? L : e + 1;
            tk.push({ c: 'qt', s: '"', p: i });
            tk.push({ c: 'av', s: src.slice(i + 1, end - 1), p: i + 1 });
            tk.push({ c: 'qt', s: '"', p: end - 1 });
            i = end;
          }
          continue;
        }
        tk.push({ c: 't', s: src[i], p: i });
        i++;
      }
      if (i + 1 < L && src[i] === '/' && src[i + 1] === '>') {
        tk.push({ c: 'br', s: '/>', p: i });
        i += 2;
      } else if (i < L && src[i] === '>') {
        tk.push({ c: 'br', s: '>', p: i });
        i++;
      }
    }
    // Plain text
    else {
      let nx = src.indexOf('<', i);
      if (nx < 0) nx = L;
      tk.push({ c: 't', s: src.slice(i, nx), p: i });
      i = nx;
    }
  }

  return tk;
}

/**
 * Build attribute map from tokens + schema (context-aware).
 *
 * For each attribute we record:
 *   - nm / vs / ve / v   — name, value positions, value text
 *   - d / tp / src       — schema definition fields (type, node_source)
 *   - parentTag          — the element name this attribute appears on, so
 *                          that same-named attributes in different sub-nodes
 *                          can resolve to different schema definitions.
 *   - requiredExpansionList — the value of the sibling `required_expansion_list`
 *                          attribute on the SAME element, if present (CSV string).
 *                          Drives the conditional cross-layer reference rule:
 *                          a row that says `required_expansion_list="X"` is
 *                          only present when expansion X is installed, so it
 *                          may reference content from expansion X. Resolution
 *                          happens in validation.js.
 *   - requiredModList    — the value of the sibling `required_mod_list`
 *                          attribute on the SAME element, if present. Same
 *                          mechanism as requiredExpansionList but for mods:
 *                          a row gated on mod Y may reference content from
 *                          mod Y. Resolution happens in validation.js.
 *
 * Single forward pass: we collect attributes per element as we encounter them,
 * snapshot the element's required_expansion_list / required_mod_list values,
 * then attach them to every attribute in the element when the opening tag
 * closes (`>` or `/>`).
 */
export function buildAttrMap(tokens, schema) {
  if (!schema) return [];
  const result = [];

  let inOpenTag = false;
  let currentTag = null;
  let pendingAttrs = [];      // attrs of the element currently being parsed
  let requiredExpansionList = null;
  let requiredModList = null;

  function flushElement() {
    for (const a of pendingAttrs) {
      a.requiredExpansionList = requiredExpansionList;
      a.requiredModList = requiredModList;
      result.push(a);
    }
    pendingAttrs = [];
    requiredExpansionList = null;
    requiredModList = null;
    currentTag = null;
    inOpenTag = false;
  }

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.c === 'br' && tk.s === '<' && i + 1 < tokens.length && tokens[i + 1].c === 'tg') {
      // Start of an opening tag — reset per-element state.
      currentTag = tokens[i + 1].s;
      inOpenTag = true;
      pendingAttrs = [];
      requiredExpansionList = null;
      requiredModList = null;
    } else if (tk.c === 'br' && (tk.s === '>' || tk.s === '/>')) {
      flushElement();
    } else if (tk.c === 'an' && inOpenTag) {
      const nm = tk.s;
      const ns = tk.p;
      let vt = null;
      for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
        if (tokens[j].c === 'av') { vt = tokens[j]; break; }
      }
      if (vt) {
        if (nm === 'required_expansion_list') requiredExpansionList = vt.s;
        else if (nm === 'required_mod_list') requiredModList = vt.s;
        const d = findAttrDefInContext(schema, nm, currentTag);
        pendingAttrs.push({
          nm,
          d,
          tp: d ? d.type : 'string',
          ns2: ns,
          ne: ns + nm.length,
          vs: vt.p,
          ve: vt.p + vt.s.length,
          v: vt.s,
          src: d ? d.node_source : null,
          parentTag: currentTag,
          // requiredExpansionList + requiredModList added during flushElement
        });
      }
    }
  }

  // Malformed XML: ended without a closing `>` on the last opening tag.
  // Flush whatever we have so the validator still sees those attrs.
  if (pendingAttrs.length) flushElement();

  return result;
}

/**
 * Does this attribute definition cascade from an outer node into child nodes?
 * By default an attribute is scoped to the node it's declared on; only those
 * flagged `cascades_to_child_nodes="true"` in the schema apply on every node at
 * any depth (genuinely universal fields like copy_from, is_partial_record,
 * internal_notes — see SharedMetaData.metadata).
 */
export function attrCascades(attrDef) {
  return !!attrDef && attrDef.cascades_to_child_nodes === 'true';
}

/**
 * Find an attribute's schema definition, scoped strictly by NODE NAME.
 *
 * An attribute's meaning is determined by the node it sits on, never by where
 * that node happens to live in the tree. So:
 *   - If `parentTag` names a known sub-node, the attribute must be one of THAT
 *     sub-node's own attributes, or a top-level attribute flagged to cascade
 *     into children. We do NOT scan other sub-nodes, and a NON-cascading
 *     top-level attribute (id, display_name, …) does not resolve here either —
 *     it lives solely on the outermost node.
 *   - Otherwise (root node, 'root', null, or an unrecognized outer tag) we
 *     resolve against the full top-level set.
 *
 * Why no "search every sub-node" fallback: sibling sub-nodes routinely sit next
 * to one another and each declares its own, same-named-but-differently-typed
 * fields — e.g. severity_regular's `output` (int) vs severity_multiplicative's
 * `multiplier` (float), or the root `type` (sub_id) vs slot's `type`
 * (node-dropdown). Borrowing a sibling's (or the root's) definition gave the
 * wrong type/tooltip/FK behavior and made one node appear to accept another's
 * attributes. Name-scoped resolution also lets a node type nest arbitrarily — a
 * `transition` under `state`, `all_of`, or `any_of` — and still resolve to its
 * own attribute set.
 */
export function findAttrDefInContext(schema, name, parentTag) {
  if (!schema) return null;

  // Known sub-node: its own attributes first, then only cascading top-level attrs.
  if (parentTag) {
    const subNode = (schema.subNodes || []).find(sn => sn.id === parentTag);
    if (subNode) {
      const snAttr = subNode.attributes?.find(a => a.key === name);
      if (snAttr) return snAttr;
      const cascaded = schema.attributes?.find((a) => a.key === name && attrCascades(a));
      return cascaded || null;
    }
  }

  // Root, 'root', null, or an unrecognized outer tag: the full top-level set.
  const topAttr = schema.attributes?.find((a) => a.key === name);
  if (topAttr) return topAttr;

  return null;
}

/**
 * Find attribute definition in merged schema (global, non-context-aware).
 * Kept for backward compatibility with validation's own context logic.
 */
export function findAttrDef(schema, name) {
  return findAttrDefInContext(schema, name, null);
}

/**
 * Check if position is inside quotes.
 */
export function isInQuotes(text, pos) {
  let q = 0;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '"') q++;
    if (text[i] === '<') q = 0;
  }
  return q % 2 === 1;
}

/**
 * Find the end position of a node starting at `openPos`.
 * Handles self-closing tags, nested same-name tags, and quotes in attributes.
 */
export function findNodeEnd(text, openPos) {
  const m = text.slice(openPos).match(/^<([\w.-]+)/);
  if (!m) return openPos + 1;
  const tn = m[1];
  let i = openPos + 1 + tn.length;
  let inQ = false;

  // Scan past opening tag's attributes
  while (i < text.length) {
    if (text[i] === '"') { inQ = !inQ; i++; continue; }
    if (inQ) { i++; continue; }
    if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '>') return i + 2; // self-closing
    if (text[i] === '>') break;
    i++;
  }
  if (i >= text.length) return text.length;

  // Search for matching closing tag
  let depth = 1;
  let ptr = i + 1;
  while (ptr < text.length && depth > 0) {
    if (text.startsWith('</' + tn, ptr)) {
      depth--;
      if (depth === 0) {
        const gt = text.indexOf('>', ptr);
        return gt >= 0 ? gt + 1 : text.length;
      }
      ptr += tn.length + 2;
    } else if (text.startsWith('<' + tn, ptr)) {
      // Check if self-closing
      let sc = false;
      let q2 = false;
      for (let k = ptr + tn.length + 1; k < text.length; k++) {
        if (text[k] === '"') { q2 = !q2; continue; }
        if (q2) continue;
        if (text[k] === '/' && k + 1 < text.length && text[k + 1] === '>') {
          sc = true;
          ptr = k + 2;
          break;
        }
        if (text[k] === '>') { ptr = k + 1; break; }
      }
      if (!sc) depth++;
    } else {
      ptr++;
    }
  }

  return ptr;
}

/**
 * Determine which node context a position is in.
 * Returns the tag name of the innermost enclosing node, or null.
 */
export function getNodeContext(text, pos) {
  // Walk backwards from pos looking for unclosed opening tags
  const stack = [];
  const tokens = tokenize(text.slice(0, pos));

  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.c === 'br' && tk.s === '<' && i + 1 < tokens.length && tokens[i + 1].c === 'tg') {
      const tagName = tokens[i + 1].s;
      // Check if self-closing by scanning forward
      let selfClosing = false;
      for (let j = i + 2; j < tokens.length; j++) {
        if (tokens[j].c === 'br' && tokens[j].s === '/>') { selfClosing = true; break; }
        if (tokens[j].c === 'br' && tokens[j].s === '>') break;
      }
      if (!selfClosing) stack.push(tagName);
    } else if (tk.c === 'br' && tk.s === '</' && i + 1 < tokens.length && tokens[i + 1].c === 'tg') {
      const tagName = tokens[i + 1].s;
      const idx = stack.lastIndexOf(tagName);
      if (idx >= 0) stack.splice(idx, 1);
    }
    i++;
  }

  return stack.length > 0 ? stack[stack.length - 1] : null;
}

// Attributes that should be dimmed
export const DIMMED_ATTRS = new Set(['internal_notes', 'translation_notes', 'optional_requirement_text_translation_notes']);

/**
 * Accurate diff algorithm using simple LCS with O(NM) DP.
 * For the file sizes we deal with (<10K lines typically),
 * this is fast enough (<10ms) and always correct.
 *
 * Uses optimization: strip common prefix/suffix first,
 * then run DP only on the differing middle section.
 *
 * Returns Set of changed/added line indices in currentLines.
 */
export function seqDiff(savedLines, currentLines) {
  const changed = new Set();
  const n = savedLines.length;
  const m = currentLines.length;

  if (n === 0) {
    for (let i = 0; i < m; i++) changed.add(i);
    return changed;
  }
  if (m === 0) return changed;

  // Strip common prefix
  let prefix = 0;
  while (prefix < n && prefix < m && savedLines[prefix] === currentLines[prefix]) prefix++;

  // Strip common suffix
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix &&
         savedLines[n - 1 - suffix] === currentLines[m - 1 - suffix]) suffix++;

  const sn = n - prefix - suffix; // saved middle length
  const sm = m - prefix - suffix; // current middle length

  if (sn === 0 && sm === 0) return changed; // identical

  if (sn === 0) {
    // Pure insertion
    for (let i = prefix; i < prefix + sm; i++) changed.add(i);
    return changed;
  }
  if (sm === 0) {
    // Pure deletion — no lines to mark in current
    return changed;
  }

  // For small diffs, use full DP LCS on the middle section
  // For very large diffs (>5000 lines middle), fall back to a simpler greedy approach
  if (sn * sm > 25000000) {
    // Fallback: greedy sequential match for very large diffs
    const savedMap = new Map();
    for (let i = 0; i < sn; i++) {
      const line = savedLines[prefix + i];
      if (!savedMap.has(line)) savedMap.set(line, []);
      savedMap.get(line).push(i);
    }
    let lastMatch = -1;
    const matched = new Set();
    for (let ci = 0; ci < sm; ci++) {
      const positions = savedMap.get(currentLines[prefix + ci]);
      if (positions) {
        for (const si of positions) {
          if (si > lastMatch) {
            matched.add(ci);
            lastMatch = si;
            break;
          }
        }
      }
    }
    for (let ci = 0; ci < sm; ci++) {
      if (!matched.has(ci)) changed.add(prefix + ci);
    }
    return changed;
  }

  // DP LCS on middle section
  // Use space-optimized approach: only need two rows
  const prev = new Uint16Array(sm + 1);
  const curr = new Uint16Array(sm + 1);

  for (let si = 1; si <= sn; si++) {
    for (let ci = 1; ci <= sm; ci++) {
      if (savedLines[prefix + si - 1] === currentLines[prefix + ci - 1]) {
        curr[ci] = prev[ci - 1] + 1;
      } else {
        curr[ci] = Math.max(prev[ci], curr[ci - 1]);
      }
    }
    // Swap rows
    for (let ci = 0; ci <= sm; ci++) { prev[ci] = curr[ci]; curr[ci] = 0; }
  }

  // We need to backtrack to find which current lines are in the LCS
  // Rebuild the full DP table for backtracking (only for the middle section)
  const dp = [];
  for (let si = 0; si <= sn; si++) {
    dp[si] = new Uint16Array(sm + 1);
  }
  for (let si = 1; si <= sn; si++) {
    for (let ci = 1; ci <= sm; ci++) {
      if (savedLines[prefix + si - 1] === currentLines[prefix + ci - 1]) {
        dp[si][ci] = dp[si - 1][ci - 1] + 1;
      } else {
        dp[si][ci] = Math.max(dp[si - 1][ci], dp[si][ci - 1]);
      }
    }
  }

  // Backtrack to find LCS members in current
  const inLCS = new Set();
  let si = sn, ci = sm;
  while (si > 0 && ci > 0) {
    if (savedLines[prefix + si - 1] === currentLines[prefix + ci - 1]) {
      inLCS.add(prefix + ci - 1);
      si--; ci--;
    } else if (dp[si - 1][ci] >= dp[si][ci - 1]) {
      si--;
    } else {
      ci--;
    }
  }

  // Lines in the middle section not in LCS are changed
  for (let i = 0; i < sm; i++) {
    if (!inLCS.has(prefix + i)) changed.add(prefix + i);
  }

  return changed;
}
