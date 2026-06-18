/**
 * Validation engine for the Arcen XML Editor.
 *
 * Checks:
 * 1. Invalid FK references (node-dropdown/node-list → nonexistent ID)
 * 2. Invalid copy_from references
 * 3. Invalid node_source in metadata (target table doesn't exist)
 * 4. Unknown attributes (not in schema)
 * 5. Duplicate IDs within same table (unless is_partial_record)
 * 6. Type mismatches (non-numeric in int/float) — warning
 * 7. Malformed XML structure
 * 8. Invalid existing-override (overriding attr not in SharedMetaData)
 * 9. Wrong-name nodes (invalid sub-node names)
 *
 * Removed: min/max range and maxlength checks — those properties are
 * deprecated by the engine and stripped from the metadata files.
 */

import { tokenize, buildAttrMap, buildLocalKeyIndex, localKeyValuesInScope } from './xmlTokenizer';
import { buildMergedSchema, composeSchemaForFileLayer } from './schemaParser';
import { resolveSwapChain, allowedTargetLayers } from './fkIndex';
import { findMisspelledWords, findMisspelledWordsInMetadata, spellingMessagePrefix } from './spellcheck';

// ─── Cross-layer reference helpers (suite mode) ─────────────────────────
// In suite mode every file belongs to a layer — 'base' or 'dlc<N>'. The
// reference rules: base may reference only base; a DLC may reference base
// plus its own content; never DLC↔DLC. Narrow mode has one layer ('base')
// so these helpers collapse to plain existence checks.

// Friendly label for a layer id, used in validation messages.
// `modDisplayByLayer` is an optional { layerId → displayName } map; when
// provided, mod-layer labels become "Mod: <Display Name>" instead of the
// raw layer id.
function layerLabel(layer, modDisplayByLayer) {
  if (!layer || layer === 'base') return 'the base game';
  const dlc = /^dlc(\d+)$/.exec(layer);
  if (dlc) return `DLC${dlc[1]}`;
  if (/^mod_/.test(layer)) {
    const name = modDisplayByLayer && modDisplayByLayer[layer];
    return name ? `Mod: ${name}` : `Mod: ${layer.replace(/^mod_[xnw]_/, '')}`;
  }
  return layer;
}

// Classify a reference value against a layered FK table entry, from the
// perspective of a file in `referrerLayer`. Returns one of:
//   { status: 'ok' }
//   { status: 'cross-layer', layers: [...] } — value exists, but only in
//        layer(s) the referrer is not permitted to see
//   { status: 'missing' }                    — value not found in any layer
//
// `extraAllowedLayers` widens the permitted set for THIS reference — used to
// honor the row-level conditional cross-DLC rule (a row that declares
// `required_expansion_list="OtherDLC_dirname"` may reference rows in that
// DLC because the engine only loads the row when that DLC is present).
function classifyLayeredReference(table, value, isCompound, referrerLayer, extraAllowedLayers, unrestricted = false) {
  // "None" is the AIW2 / Arcen-universal null sentinel for any FK-typed
  // attribute — the engine treats it as "no value" regardless of whether
  // a row literally named None exists in the target table. The empty-set
  // glyph ∅ is also accepted; some newer code paths use it as a clearer
  // visual marker for "intentionally empty" (especially in mod data
  // where "None" might collide with a real entity name). Always accept
  // either; the engine treats both as null at runtime.
  if (value === 'None' || value === '∅') return { status: 'ok' };
  const has = (entry) => !!entry && (isCompound
    ? (entry.subIds?.has(value) || entry.ids?.has(value))
    : entry.ids?.has(value));
  // No per-layer data (defensive) — fall back to a plain union check.
  if (!table.byLayer || Object.keys(table.byLayer).length === 0) {
    return has(table) ? { status: 'ok' } : { status: 'missing' };
  }
  // `unrestricted` (from `can_make_invalid_cross_links="true"`): the
  // schema author has opted this field out of layer-visibility
  // enforcement, so any layer that contains the value is fine. We still
  // report 'missing' if it doesn't exist anywhere — unrestricted means
  // "no layer barriers", not "any string is valid".
  if (unrestricted) {
    for (const entry of Object.values(table.byLayer)) {
      if (has(entry)) return { status: 'ok' };
    }
    return { status: 'missing' };
  }
  const allowed = allowedTargetLayers(referrerLayer, extraAllowedLayers);
  const foundIn = [];
  for (const [layer, entry] of Object.entries(table.byLayer)) {
    if (has(entry)) foundIn.push(layer);
  }
  if (foundIn.length === 0) return { status: 'missing' };
  if (foundIn.some((l) => allowed.includes(l))) return { status: 'ok' };
  return { status: 'cross-layer', layers: foundIn };
}

// Resolve a CSV of dirNames against a { dirName → layerId } map. Unknown
// names are dropped silently — a row referencing a non-existent expansion or
// mod can't grant itself any extra permissions; the FK check itself reports
// the real problem if there is one.
function resolveDirListToLayers(csv, dirNameToLayer) {
  if (!csv || !dirNameToLayer) return null;
  const out = [];
  for (const raw of String(csv).split(',')) {
    const dn = raw.trim();
    if (!dn) continue;
    const layer = dirNameToLayer[dn];
    if (layer) out.push(layer);
  }
  return out.length ? out : null;
}

// Backwards-compat name kept for any external callers; new code can use
// resolveDirListToLayers directly with either map.
const resolveRequiredExpansionLayers = resolveDirListToLayers;

/**
 * Build the layer-info maps that validateAll / validateXMLFile use, from the
 * raw expansions + mods arrays in discoverData()'s output. Pure derivation —
 * App.jsx calls this once whenever dataLayout changes and stashes the result
 * for both inline (saveFile path) and worker (full validation) callers.
 *
 * Returns:
 *   expansionDirNameToLayer  { dirName → 'dlc<N>' }
 *   modFolderNameToLayer     { dirName → 'mod_<src>_<dirName>' } — when the
 *                            same dir name appears in multiple sources, the
 *                            local (x) one wins, then non-distributed (n),
 *                            then workshop (w). Matches the load-order tier.
 *   modDisplayByLayer        { layerId → displayName } for friendly error msgs
 *   modExtrasByLayer         { modLayerId → [layerId,...] } — the mod's
 *                            declared required_expansions + required_mods
 *                            resolved to layer ids. Used as the file-level
 *                            baseline extras for everything in that mod.
 */
export function buildLayerMaps(expansions, mods) {
  const expansionDirNameToLayer = {};
  for (const exp of (expansions || [])) {
    expansionDirNameToLayer[exp.dirName] = exp.id;
  }
  const tier = (l) => (l.startsWith('mod_x_') ? 0 : l.startsWith('mod_n_') ? 1 : 2);
  const modsSortedByTier = [...(mods || [])].sort((a, b) => tier(a.layerId) - tier(b.layerId));
  const modFolderNameToLayer = {};
  for (const m of modsSortedByTier) {
    if (!(m.dirName in modFolderNameToLayer)) modFolderNameToLayer[m.dirName] = m.layerId;
  }
  const modDisplayByLayer = {};
  for (const m of (mods || [])) modDisplayByLayer[m.layerId] = m.displayName;
  const modExtrasByLayer = {};
  for (const m of (mods || [])) {
    const set = new Set();
    for (const dn of (m.requiredExpansions || [])) {
      const l = expansionDirNameToLayer[dn];
      if (l) set.add(l);
    }
    for (const dn of (m.requiredMods || [])) {
      const l = modFolderNameToLayer[dn];
      if (l) set.add(l);
    }
    modExtrasByLayer[m.layerId] = [...set];
  }
  return { expansionDirNameToLayer, modFolderNameToLayer, modDisplayByLayer, modExtrasByLayer };
}

// Standard explanatory clause appended to cross-layer error messages.
function crossLayerRuleClause(referrerLayer) {
  return (!referrerLayer || referrerLayer === 'base')
    ? 'Base game data may only reference base game data.'
    : 'A DLC may only reference the base game and its own content.';
}

/**
 * Convert the `structuralErrors` array from discoverData() into validation
 * entries. These describe layout problems rather than file content issues, so
 * they carry `kind` + `folderPath` for the validation window to route the
 * click to Explorer instead of a file:line jump.
 *
 * Kinds emitted by the current discover pass:
 *   no-schema        — folder has data but no .metadata anywhere. One notice
 *                      per folder (not per XML file). Surfaced as a warning
 *                      because the data is loadable; it just can't be
 *                      schema-validated.
 *   duplicate-schema — two layers both ship a .metadata for the same folder.
 *                      The first one wins; the duplicate is ignored.
 *
 * Legacy kinds still recognised for graceful upgrade behaviour:
 *   orphan-folder, metadata-in-expansion — pre-DLC-owned-schema era, kept so
 *   that an older renderer talking to a newer main process doesn't crash.
 */
export function structuralErrorsToEntries(structuralErrors) {
  const out = [];
  for (const se of structuralErrors || []) {
    if (se.kind === 'no-schema') {
      const layerList = (se.contributingLayers || []).map(layerLabel).join(', ');
      out.push({
        severity: 'warning',
        file: se.folderName,
        line: 1,
        message: `Folder "${se.folderName}" has ${se.xmlFileCount} XML file(s) (from ${layerList}) but no _${se.folderName}.metadata anywhere — its contents will load but cannot be schema-validated. Add a metadata file in the base game (or in the DLC that owns this table) to enable validation.`,
        kind: 'no-schema',
        folderPath: se.folderPath,
      });
    } else if (se.kind === 'duplicate-schema') {
      out.push({
        severity: 'warning',
        file: `${se.expansion}/${se.folderName}`,
        line: 1,
        message: `Duplicate schema for "${se.folderName}": already defined in ${layerLabel(se.ownedBy)}, redefined in ${layerLabel(se.layer)} (${se.expansion}). The earlier definition wins; the duplicate ${se.relPath} is ignored.`,
        kind: 'duplicate-schema',
        folderPath: se.folderPath,
      });
    } else if (se.kind === 'orphan-folder') {
      // Legacy — should no longer be emitted but kept for safety.
      out.push({
        severity: 'error',
        file: `${se.expansion}/${se.folderName}`,
        line: 1,
        message: `Expansion folder "${se.folderName}" (in ${layerLabel(se.layer)}, ${se.expansion}) has no matching folder in the base game. Its ${se.xmlFileCount} XML file(s) are not loaded — check the folder name for a typo.`,
        kind: 'orphan-folder',
        folderPath: se.folderPath,
      });
    } else if (se.kind === 'extra-source-missing') {
      // A directory listed in _extraDataSources.txt doesn't exist under the
      // data root. The editor ignores it gracefully; this just tells the user.
      out.push({
        severity: 'warning',
        file: se.dir,
        line: 1,
        message: `Extra data source folder "${se.dir}" (listed in _extraDataSources.txt) was not found under the data root — its contents can't be loaded. Check the path or remove the line.`,
        kind: 'extra-source-missing',
      });
    } else if (se.kind === 'metadata-in-expansion') {
      // Legacy — DLCs are now allowed to host schemas, so this kind is no
      // longer emitted by the current discover pass.
      out.push({
        severity: 'warning',
        file: `${se.expansion}/${se.folderName}/${se.file}`,
        line: 1,
        message: `Expansions never define schemas — the .metadata file "${se.file}" in ${layerLabel(se.layer)} (${se.expansion}) is ignored. Schemas come from the base game only.`,
        kind: 'metadata-in-expansion',
        folderPath: se.folderPath,
      });
    }
  }
  return out;
}

/**
 * @typedef {{ severity: 'error'|'warning', file: string, line: number, message: string }} ValidationEntry
 */

/**
 * Validate a single XML file.
 *
 * @param {string} content — file content
 * @param {string} relativePath — e.g. "1_BuildingType/BuildingTypes.xml"
 * @param {object} mergedSchema — from buildMergedSchema()
 * @param {object} fkIndex — tableName → layered FK table entry
 * @param {object} lookupSwaps — oldId → newId map
 * @param {object} [ctx] — { layer, folderName, expansionDirNameToLayer }:
 *   - layer: the file's layer id ('base' | 'dlc<N>')
 *   - folderName: the logical table folder name (drives copy_from self-lookup)
 *   - expansionDirNameToLayer: object mapping each expansion's directory name
 *     (the value form used in `required_expansion_list`) to its layer id.
 *     Required for the row-level conditional cross-DLC reference rule.
 * @returns {ValidationEntry[]}
 */
export function validateXMLFile(content, relativePath, mergedSchema, fkIndex, lookupSwaps, ctx) {
  const errors = [];
  const referrerLayer = ctx?.layer || 'base';
  const ctxFolderName = ctx?.folderName || relativePath.split('/')[0];
  const expansionDirNameToLayer = ctx?.expansionDirNameToLayer || {};
  const modFolderNameToLayer = ctx?.modFolderNameToLayer || {};
  const modDisplayByLayer = ctx?.modDisplayByLayer || null;
  // The mod-level baseline extras for this file. If the file lives in a mod
  // layer, the mod's required_mods + required_expansions (from ModDetails.xml)
  // resolved to layer ids — every reference in the file gets these extras
  // applied on top of any per-row required_*_list.
  const fileModExtras = ctx?.fileModExtras || null;

  if (!mergedSchema) return errors;

  // The XML attribute that holds each row's central identifier ("id" in
  // Heart of the Machine, "name" in AI War 2). Derived from the merged
  // schema, which inherits the flagged attribute from SharedMetaData.
  const centralAttr = (mergedSchema.attributes || []).find((a) => a.is_central_identifier === 'true');
  const centralIdKey = (centralAttr && centralAttr.key) ? centralAttr.key : 'id';

  // Attributes starting with this prefix are conventional extension points
  // that mods / DLCs (and sometimes the base game) hang on rows for arbitrary
  // purposes — they're inherently off-schema. Don't flag them as "unknown".
  const isCustomExtensionAttr = (nm) => typeof nm === 'string' && nm.startsWith('custom_');

  // Single-root tables: attributes on <root> directly, no child nodes
  // Check malformed XML + unknown attributes, skip node-structure checks
  if (mergedSchema.isForSingleRoot) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/xml');
      if (doc.querySelector('parsererror')) {
        errors.push({ severity: 'error', file: relativePath, line: 1, message: 'Malformed XML' });
        return errors;
      }
    } catch (e) {
      errors.push({ severity: 'error', file: relativePath, line: 1, message: 'XML parse error: ' + e.message });
      return errors;
    }
    // Validate attributes on root against schema
    const lines = content.split('\n');
    function lineAt(pos) {
      let line = 1, p = 0;
      for (const l of lines) {
        if (pos >= p && pos < p + l.length + 1) return line;
        p += l.length + 1; line++;
      }
      return line;
    }
    const tokens = tokenize(content);
    // For single-root, all attributes are on root — check against merged schema attributes
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].c !== 'an') continue;
      const nm = tokens[i].s;
      const ns = tokens[i].p;
      // Skip xml declaration attributes
      if (nm === 'version' || nm === 'encoding') continue;
      // Mod / DLC extension attributes are off-schema by design.
      if (isCustomExtensionAttr(nm)) continue;
      const attrDef = mergedSchema.attributes.find(a => a.key === nm);
      if (!attrDef) {
        errors.push({
          severity: 'warning', file: relativePath, line: lineAt(ns),
          message: `Unknown attribute "${nm}" — not defined in schema`,
        });
      }
    }
    return errors;
  }

  // ── Check 9: Malformed XML ──
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      errors.push({
        severity: 'error',
        file: relativePath,
        line: 1,
        message: 'Malformed XML: ' + parseError.textContent.slice(0, 120),
      });
      return errors; // Can't do further validation on broken XML
    }
  } catch (e) {
    errors.push({ severity: 'error', file: relativePath, line: 1, message: 'XML parse error: ' + e.message });
    return errors;
  }

  const lines = content.split('\n');
  const tokens = tokenize(content);
  const attrMap = buildAttrMap(tokens, mergedSchema);
  // Record-scoped local keys (self-FK). Empty/inert unless the schema declares
  // `local_key` attributes (normal data tables don't).
  const localKeyIndex = buildLocalKeyIndex(tokens, mergedSchema);

  // Build line lookup: position → line number
  function lineAt(pos) {
    let line = 1;
    let p = 0;
    for (const l of lines) {
      if (pos >= p && pos < p + l.length + 1) return line;
      p += l.length + 1;
      line++;
    }
    return line;
  }

  // ── Check 12: Duplicate attributes on the same XML node ──
  {
    let currentNodeAttrs = new Map(); // attrName → position
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      // New opening tag — reset the per-node attribute set
      if (tk.c === 'br' && (tk.s === '<' || tk.s === '</')) {
        currentNodeAttrs = new Map();
      }
      if (tk.c === 'an') {
        if (currentNodeAttrs.has(tk.s)) {
          errors.push({
            severity: 'error',
            file: relativePath,
            line: lineAt(tk.p),
            message: `Duplicate attribute "${tk.s}" on the same node`,
          });
        } else {
          currentNodeAttrs.set(tk.s, tk.p);
        }
      }
    }
  }

  // Collect all IDs and partial flags for duplicate check (check 5)
  const idMap = new Map();

  // ── Walk through top-level nodes ──
  const parser = new DOMParser();
  const doc = parser.parseFromString(content, 'text/xml');
  const root = doc.documentElement;

  for (const node of root.children) {
    const tagName = node.tagName;
    const nodeLineMatch = content.indexOf('<' + tagName);
    // Approximate line from position
    const approxPos = content.indexOf(`<${tagName}`, 0);

    // ── Check 11: Wrong-name nodes ──
    const validTopNames = [mergedSchema.nodeName, 'root'];
    const validSubNames = (mergedSchema.subNodes || []).map((sn) => sn.id);

    if (tagName !== mergedSchema.nodeName && tagName !== 'root') {
      // Check if it's a valid sub-node appearing at top level (wrong place)
      if (validSubNames.includes(tagName)) {
        errors.push({
          severity: 'error',
          file: relativePath,
          line: lineAt(approxPos),
          message: `<${tagName}> is a sub-node and should not appear at the top level`,
        });
      } else {
        errors.push({
          severity: 'error',
          file: relativePath,
          line: lineAt(approxPos),
          message: `Unknown node <${tagName}> — expected <${mergedSchema.nodeName}>`,
        });
      }
    }

    // Collect ID for duplicate check. The attribute name depends on the
    // dataset's central identifier (id / name) — see centralIdKey above.
    const id = node.getAttribute(centralIdKey);
    const isPartial = node.getAttribute('is_partial_record') === 'true';
    if (id) {
      if (!idMap.has(id)) idMap.set(id, []);
      idMap.get(id).push({ line: lineAt(approxPos), isPartial });
    }

    // Check sub-nodes
    for (const child of node.children) {
      const childTag = child.tagName;
      if (!validSubNames.includes(childTag)) {
        const childPos = content.indexOf(`<${childTag}`, approxPos + 1);
        errors.push({
          severity: 'error',
          file: relativePath,
          line: lineAt(childPos),
          message: `Invalid sub-node <${childTag}> inside <${tagName}>`,
        });
      }
    }
  }

  // ── Check 5: Duplicate IDs ──
  for (const [id, entries] of idMap) {
    if (entries.length > 1) {
      const anyPartial = entries.some((e) => e.isPartial);
      if (!anyPartial) {
        for (const entry of entries) {
          errors.push({
            severity: 'error',
            file: relativePath,
            line: entry.line,
            message: `Duplicate ID "${id}" (use is_partial_record="true" if intentional)`,
          });
        }
      }
    }
  }

  // ── Build position→context map in a single pass ──
  // Walk tokens once, tracking the node stack, and record the enclosing
  // tag name at each attribute-name token position.
  const attrContextMap = new Map(); // attr position → enclosing tag name
  {
    const stack = [];
    for (let ti = 0; ti < tokens.length; ti++) {
      const tk = tokens[ti];
      if (tk.c === 'br' && tk.s === '<' && ti + 1 < tokens.length && tokens[ti + 1].c === 'tg') {
        const tagName = tokens[ti + 1].s;
        // Check if self-closing by scanning forward for /> vs >
        let selfClosing = false;
        for (let j = ti + 2; j < tokens.length; j++) {
          if (tokens[j].c === 'br' && tokens[j].s === '/>') { selfClosing = true; break; }
          if (tokens[j].c === 'br' && tokens[j].s === '>') break;
        }
        if (!selfClosing) stack.push(tagName);
        // Record context for all attribute tokens within this tag
        for (let j = ti + 2; j < tokens.length; j++) {
          if (tokens[j].c === 'br' && (tokens[j].s === '>' || tokens[j].s === '/>')) break;
          if (tokens[j].c === 'an') {
            attrContextMap.set(tokens[j].p, tagName);
          }
        }
      } else if (tk.c === 'br' && tk.s === '</' && ti + 1 < tokens.length && tokens[ti + 1].c === 'tg') {
        const tagName = tokens[ti + 1].s;
        const idx = stack.lastIndexOf(tagName);
        if (idx >= 0) stack.splice(idx, 1);
      }
    }
  }

  // ── Per-attribute checks ──
  for (const attr of attrMap) {
    const line = lineAt(attr.vs);
    const parentTag = attrContextMap.get(attr.ns2) || null;

    // Engine-level pass attributes — not declared in any schema, but
    // recognized everywhere by the runtime. Two flavors:
    //
    //   `is_pass="<int>"` — bare integer pass value, valid on any node
    //     regardless of context.
    //
    //   `<companion>_is_pass="<int>"` — pass value paired with another
    //     attribute on the same node. The companion must be a real
    //     schema-defined attribute in this node's context (so a typo
    //     like `stategy_text_is_pass` is still flagged).
    //
    // Both must hold an integer (positive or negative). Anything else
    // is a real validation error.
    if (attr.nm === 'is_pass' || attr.nm.endsWith('_is_pass')) {
      if (attr.nm !== 'is_pass') {
        const companionName = attr.nm.slice(0, -'_is_pass'.length);
        let companionExists = mergedSchema.attributes.some((a) => a.key === companionName);
        if (!companionExists && parentTag && parentTag !== mergedSchema.nodeName && parentTag !== 'root') {
          const subNode = mergedSchema.subNodes?.find((sn) => sn.id === parentTag);
          if (subNode) {
            companionExists = subNode.attributes.some((a) => a.key === companionName);
          }
        }
        if (!companionExists) {
          const ctxLabel = parentTag ? `<${parentTag}>` : 'top level';
          errors.push({
            severity: 'warning',
            file: relativePath,
            line,
            message: `Unknown _is_pass attribute "${attr.nm}" in ${ctxLabel} — companion "${companionName}" is not defined in the schema`,
          });
          continue;
        }
      }
      if (attr.v && !/^-?\d+$/.test(attr.v)) {
        errors.push({
          severity: 'error',
          file: relativePath,
          line,
          message: `Attribute "${attr.nm}" must be an integer, got "${attr.v}"`,
        });
      }
      continue;
    }

    // Check 4: Unknown attributes (context-aware)
    let validInContext = false;

    // Mod / DLC extension attributes are off-schema by design; never flag them.
    if (isCustomExtensionAttr(attr.nm)) {
      continue;
    }

    if (!attr.d) {
      // Not in schema at all
      validInContext = false;
    } else if (parentTag === mergedSchema.nodeName || parentTag === 'root' || parentTag === null) {
      // Top-level node — check if attr is a top-level attribute
      validInContext = mergedSchema.attributes.some((a) => a.key === attr.nm);
    } else {
      // Inside a sub-node — the attr must be one of that sub-node's own
      // attributes, or a top-level attribute flagged to cascade into children.
      // A non-cascading top-level attribute (id, display_name, …) belongs only
      // on the outermost node, so it's wrong-context here.
      const subNode = mergedSchema.subNodes?.find((sn) => sn.id === parentTag);
      if (subNode) {
        validInContext = subNode.attributes.some((a) => a.key === attr.nm) ||
                         mergedSchema.attributes.some((a) => a.key === attr.nm && a.cascades_to_child_nodes === 'true');
      } else {
        // Unknown sub-node context — just check globally
        validInContext = !!attr.d;
      }
    }

    if (!validInContext) {
      const ctxLabel = parentTag ? `<${parentTag}>` : 'top level';
      errors.push({
        severity: 'warning',
        file: relativePath,
        line,
        message: `Unknown attribute "${attr.nm}" in ${ctxLabel} — not defined in schema for this context`,
      });
      continue;
    }

    // Build set of extra allowed values for this attribute (e.g., "None", "All")
    const extraAllowed = attr.d?.node_extra_allowed
      ? new Set(attr.d.node_extra_allowed.split(',').map(s => s.trim()).filter(Boolean))
      : null;

    // Row-level conditional cross-layer permission. Two row-sibling attrs:
    //   required_expansion_list="DLC_dir,..."  → may reference those DLCs
    //   required_mod_list="ModFolder,..."      → may reference those mods
    // The engine only loads the row when those layers are present, so the
    // reference is safe. Combined with the file-level mod extras (fileModExtras)
    // — which are the mod's declared required_* from ModDetails.xml — these
    // form the full set of extras passed to classifyLayeredReference.
    const rowExpansionExtras = resolveDirListToLayers(attr.requiredExpansionList, expansionDirNameToLayer);
    const rowModExtras = resolveDirListToLayers(attr.requiredModList, modFolderNameToLayer);
    let extraAllowedLayers = null;
    if (fileModExtras || rowExpansionExtras || rowModExtras) {
      const set = new Set();
      if (fileModExtras) for (const l of fileModExtras) set.add(l);
      if (rowExpansionExtras) for (const l of rowExpansionExtras) set.add(l);
      if (rowModExtras) for (const l of rowModExtras) set.add(l);
      extraAllowedLayers = [...set];
    }

    // Per-field opt-out from the layer-visibility check. Mirrors the
    // schema `can_make_invalid_cross_links="true"` flag. When set, the
    // validator only checks "does this value exist somewhere in the
    // target table" and skips the cross-layer barrier.
    const unrestricted = attr.d?.can_make_invalid_cross_links === 'true';

    // Check 1: Invalid FK references (supports node_sub_source Parent:Child
    // format, and enforces the suite-mode cross-layer rules).
    if ((attr.tp === 'node-dropdown') && attr.src && attr.src !== 'self') {
      const table = fkIndex[attr.src];
      if (table && attr.v && !extraAllowed?.has(attr.v)) {
        const isCompound = attr.v.includes(':');
        const res = classifyLayeredReference(table, attr.v, isCompound, referrerLayer, extraAllowedLayers, unrestricted);
        if (res.status === 'cross-layer') {
          const where = res.layers.map((l) => layerLabel(l, modDisplayByLayer)).join(', ');
          errors.push({
            severity: 'error', file: relativePath, line,
            message: `Cross-layer reference: "${attr.v}" exists only in ${where}, but ${layerLabel(referrerLayer)} cannot reference it. ${crossLayerRuleClause(referrerLayer)}`,
          });
        } else if (res.status === 'missing') {
          const swapped = lookupSwaps ? resolveSwapChain(lookupSwaps, attr.v) : null;
          const swapValid = swapped && table.ids.has(swapped);
          let msg = `Invalid reference: "${attr.v}" not found in ${attr.src}`;
          if (swapValid) {
            msg += `. LookupSwaps indicates you might mean: ${swapped}?`;
          }
          errors.push({ severity: 'error', file: relativePath, line, message: msg });
        }
      }
    }

    if (attr.tp === 'node-list' && attr.src && attr.src !== 'self') {
      const table = fkIndex[attr.src];
      if (table && attr.v) {
        for (const val of attr.v.split(',').filter(Boolean)) {
          if (extraAllowed?.has(val)) continue; // explicitly allowed
          const isCompound = val.includes(':');
          const res = classifyLayeredReference(table, val, isCompound, referrerLayer, extraAllowedLayers, unrestricted);
          if (res.status === 'cross-layer') {
            const where = res.layers.map((l) => layerLabel(l, modDisplayByLayer)).join(', ');
            errors.push({
              severity: 'error', file: relativePath, line,
              message: `Cross-layer reference in list: "${val}" exists only in ${where}, but ${layerLabel(referrerLayer)} cannot reference it. ${crossLayerRuleClause(referrerLayer)}`,
            });
          } else if (res.status === 'missing') {
            const swapped = lookupSwaps ? resolveSwapChain(lookupSwaps, val) : null;
            const swapValid = swapped && table.ids.has(swapped);
            let msg = `Invalid reference in list: "${val}" not found in ${attr.src}`;
            if (swapValid) {
              msg += `. LookupSwaps indicates you might mean: ${swapped}?`;
            }
            errors.push({ severity: 'error', file: relativePath, line, message: msg });
          }
        }
      }
    }

    // Check 2: Invalid copy_from (references the same table; cross-layer rules apply)
    //
    // When a sub-node redefines copy_from with its own node_source pointing at
    // a different table (AIW2 does this for e.g. <var_map>/<style> whose
    // copy_from references TextStyles, not the parent TextVarMaps table), the
    // regular node-dropdown check above already validated it against the right
    // table. The self-table check below would then double-report against the
    // wrong table, so skip it whenever a non-self node_source is in play.
    const copyFromOverride = attr.d && attr.d.node_source && attr.d.node_source !== 'self';
    if (attr.nm === 'copy_from' && attr.v && !copyFromOverride) {
      const selfTable = fkIndex[ctxFolderName] || fkIndex[ctxFolderName.replace(/^\d+_/, '')];
      if (selfTable) {
        const res = classifyLayeredReference(selfTable, attr.v, false, referrerLayer, extraAllowedLayers);
        if (res.status === 'cross-layer') {
          const where = res.layers.map((l) => layerLabel(l, modDisplayByLayer)).join(', ');
          errors.push({
            severity: 'error', file: relativePath, line,
            message: `Cross-layer copy_from: "${attr.v}" exists only in ${where}, but ${layerLabel(referrerLayer)} cannot copy from it. ${crossLayerRuleClause(referrerLayer)}`,
          });
        } else if (res.status === 'missing') {
          errors.push({
            severity: 'error', file: relativePath, line,
            message: `Invalid copy_from: "${attr.v}" not found in this table`,
          });
        }
      }
    }

    // Check 13: lang-string — validate against Language table (blank is allowed)
    if (attr.tp === 'lang-string' && attr.v) {
      const langTable = fkIndex['Language'] || fkIndex['0_Language'];
      if (langTable) {
        const res = classifyLayeredReference(langTable, attr.v, false, referrerLayer, extraAllowedLayers);
        if (res.status === 'cross-layer') {
          const where = res.layers.map((l) => layerLabel(l, modDisplayByLayer)).join(', ');
          errors.push({
            severity: 'error', file: relativePath, line,
            message: `Cross-layer lang-string reference: "${attr.v}" exists only in ${where}, but ${layerLabel(referrerLayer)} cannot reference it. ${crossLayerRuleClause(referrerLayer)}`,
          });
        } else if (res.status === 'missing') {
          const swapped = lookupSwaps ? resolveSwapChain(lookupSwaps, attr.v) : null;
          const swapValid = swapped && langTable.ids.has(swapped);
          let msg = `Invalid lang-string reference: "${attr.v}" not found in Language table`;
          if (swapValid) msg += `. LookupSwaps indicates you might mean: ${swapped}?`;
          errors.push({ severity: 'error', file: relativePath, line, message: msg });
        }
      }
    }

    // Check 15: local references (self-FK). A `local-dropdown` / `local-list`
    // value must be a `local_key` defined by a `local_source`-typed sub_node
    // within the SAME record (e.g. a transition's `to` must name a <state> id in
    // the same <motion_set>). Blank is allowed (e.g. initial_state="" = first).
    if ((attr.tp === 'local-dropdown' || attr.tp === 'local-list') && attr.d?.local_source && attr.v) {
      const srcType = attr.d.local_source;
      const valid = new Set(localKeyValuesInScope(localKeyIndex, attr.ns2, srcType));
      const vals = attr.tp === 'local-list'
        ? attr.v.split(',').map((s) => s.trim()).filter(Boolean)
        : [attr.v];
      for (const val of vals) {
        if (!val || val === 'None') continue;
        if (!valid.has(val)) {
          errors.push({
            severity: 'error', file: relativePath, line,
            message: `Invalid local reference: "${val}" is not a <${srcType}> id defined in this <${mergedSchema.nodeName}>`,
          });
        }
      }
    }

    // Check 6: Type mismatches
    if (attr.tp === 'int-textbox' && attr.v) {
      if (!/^-?\d+$/.test(attr.v)) {
        errors.push({
          severity: 'warning',
          file: relativePath,
          line,
          message: `Type mismatch: "${attr.nm}" expects integer, got "${attr.v}"`,
        });
      }
    }
    if (attr.tp === 'range-int' && attr.v) {
      // range-int: two ints separated by comma, e.g. "10,20"
      if (!/^-?\d+\s*,\s*-?\d+$/.test(attr.v)) {
        errors.push({
          severity: 'warning',
          file: relativePath,
          line,
          message: `Type mismatch: "${attr.nm}" expects two integers separated by comma, got "${attr.v}"`,
        });
      }
    }
    if (attr.tp === 'float-textbox' && attr.v) {
      if (!/^-?\d+(\.\d+)?$/.test(attr.v)) {
        errors.push({
          severity: 'warning',
          file: relativePath,
          line,
          message: `Type mismatch: "${attr.nm}" expects number, got "${attr.v}"`,
        });
      }
    }
    if (attr.tp === 'range-float' && attr.v) {
      // range-float: two floats separated by comma, e.g. "1.0,2.5"
      if (!/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(attr.v)) {
        errors.push({
          severity: 'warning',
          file: relativePath,
          line,
          message: `Type mismatch: "${attr.nm}" expects two numbers separated by comma, got "${attr.v}"`,
        });
      }
    }

  }

  return errors;
}

/**
 * Validate a metadata file.
 * Check 3: Invalid node_source (target table doesn't exist)
 * Check 10: Invalid existing-override
 */
export function validateMetadataFile(content, relativePath, sharedSchema, allFolderNames) {
  const errors = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      errors.push({ severity: 'error', file: relativePath, line: 1, message: 'Malformed metadata XML' });
      return errors;
    }

    const lines = content.split('\n');
    function lineAt(pos) {
      let line = 1, p = 0;
      for (const l of lines) {
        if (pos >= p && pos < p + l.length + 1) return line;
        p += l.length + 1;
        line++;
      }
      return line;
    }

    const sharedAttrNames = new Set(
      (sharedSchema?.attributes || []).map((a) => a.key)
    );

    const folderNameSet = new Set(allFolderNames);
    const baseNameSet = new Set(allFolderNames.map((n) => n.replace(/^\d+_/, '')));

    // Walk all <attribute> elements
    let searchOffset = 0;
    for (const el of doc.querySelectorAll('attribute')) {
      const key = el.getAttribute('key') || '';
      const type = el.getAttribute('type') || '';
      const nodeSource = el.getAttribute('node_source') || '';
      const searchStr = nodeSource ? `node_source="${nodeSource}"` : `key="${key}"`;
      const pos = content.indexOf(searchStr, searchOffset);
      if (pos >= 0) searchOffset = pos + 1;

      // Check 14: Identifier attributes must not be localized.
      // is_central_identifier / is_id_for_layer mark opaque lookup keys (the
      // row's id, the layer id) — never shown to players, never translated, and
      // always skipped by spell/grammar checking. Setting is_localized="true" on
      // one is a mistake (it's what caused AI War's `name` key — the id key
      // there — to be wrongly spellchecked despite both flags being set).
      const isCentralId = el.getAttribute('is_central_identifier') === 'true';
      const isIdForLayer = el.getAttribute('is_id_for_layer') === 'true';
      if ((isCentralId || isIdForLayer) && el.getAttribute('is_localized') === 'true') {
        const flag = isCentralId ? 'is_central_identifier' : 'is_id_for_layer';
        errors.push({
          severity: 'error',
          file: relativePath,
          line: lineAt(pos),
          message: `Identifier attribute "${key}" (${flag}="true") must not set is_localized="true" — identifiers are opaque keys, never translated, spellchecked, or grammar-checked.`,
        });
      }

      // Check 10: Invalid existing-override
      if (type === 'existing-override') {
        if (!sharedAttrNames.has(key)) {
          errors.push({
            severity: 'error',
            file: relativePath,
            line: lineAt(pos),
            message: `existing-override for "${key}" but it's not in SharedMetaData`,
          });
        }
      }

      // Check 3: Invalid node_source
      if (nodeSource && nodeSource !== 'self') {
        if (!folderNameSet.has(nodeSource) && !baseNameSet.has(nodeSource)) {
          // Suggest near-matches
          const suggestions = allFolderNames
            .map((n) => n.replace(/^\d+_/, ''))
            .filter((n) => {
              const a = n.toLowerCase(), b = nodeSource.toLowerCase();
              return a.includes(b) || b.includes(a) ||
                levenshtein(a, b) <= 3;
            })
            .slice(0, 3);

          let msg = `node_source "${nodeSource}" — target table not found`;
          if (suggestions.length > 0) {
            msg += `. Did you mean: ${suggestions.join(', ')}?`;
          }
          errors.push({
            severity: 'error',
            file: relativePath,
            line: lineAt(pos),
            message: msg,
          });
        }
      }
    }
  } catch (e) {
    errors.push({ severity: 'error', file: relativePath, line: 1, message: 'Error validating metadata: ' + e.message });
  }

  return errors;
}

/**
 * Run full validation across all files.
 */
/**
 * Run full validation across all files.
 *
 * @param {object} opts — optional { spellchecker, runFullSpellingPass }
 *   spellchecker: { correct(word, isDev), suggest(word) } or null
 *   runFullSpellingPass: boolean — when true (and spellchecker is set), Pass 2
 *     scans every target attribute for misspellings. Other callers leave this
 *     false: Pass 2 is expensive (synchronous nspell over all files in the
 *     calling thread).
 */
export async function validateAll(folders, allFileContents, schemas, sharedSchema, fkIndex, lookupSwaps, opts) {
  const allErrors = [];
  const allFolderNames = folders.map((f) => f.name);
  const spellchecker = opts?.spellchecker || null;
  const runFullSpellingPass = !!opts?.runFullSpellingPass;

  // Layout-level structural errors (orphan expansion folders, stray
  // .metadata in an expansion) — already in validation-entry shape.
  if (opts?.structuralErrors?.length) {
    allErrors.push(...opts.structuralErrors);
  }

  // ── Pass 1: Core validation (FK, schema, type checks — fast, synchronous) ──
  const mergedSchemas = new Map(); // cache for pass 2/3
  for (const folder of folders) {
    const schema = schemas[folder.name];
    if (!schema) continue;
    if (schema.neverValidate) continue;

    const merged = buildMergedSchema(sharedSchema, schema);
    mergedSchemas.set(folder.name, merged);

    // Composed-schema cache, keyed by layer for this folder. For non-mod
    // layers (and mod layers with no applicable extensions) the cache
    // entry is === merged, so the cached schema is referentially the
    // same object — keeps any downstream identity caches hot.
    const composedByLayer = new Map();
    const getComposedSchema = (layer) => {
      if (composedByLayer.has(layer)) return composedByLayer.get(layer);
      const result = composeSchemaForFileLayer(
        merged, opts?.schemaExtensions, opts?.modExtrasByLayer, layer, folder.name
      );
      composedByLayer.set(layer, result);
      return result;
    };

    for (const xmlFile of folder.xmlFiles) {
      const content = allFileContents[xmlFile.relativePath];
      if (!content) continue;
      const fileLayer = xmlFile.layer || 'base';
      const ctx = {
        layer: fileLayer,
        folderName: folder.name,
        expansionDirNameToLayer: opts?.expansionDirNameToLayer,
        modFolderNameToLayer: opts?.modFolderNameToLayer,
        modDisplayByLayer: opts?.modDisplayByLayer,
        // Mod-level baseline extras (from ModDetails.xml required_mods +
        // required_expansions). Only applies to mod-layer files; for base/DLC
        // files it's null and the row-level required_*_list still works.
        fileModExtras: opts?.modExtrasByLayer ? opts.modExtrasByLayer[fileLayer] : null,
      };
      const composed = getComposedSchema(fileLayer);
      const errs = validateXMLFile(content, xmlFile.relativePath, composed, fkIndex, lookupSwaps, ctx);
      allErrors.push(...errs);
    }

    const metaContent = allFileContents[folder.metadataRelPath];
    if (metaContent) {
      const errs = validateMetadataFile(metaContent, folder.metadataRelPath, sharedSchema, allFolderNames);
      allErrors.push(...errs);
    }
  }

  // ── Pass 2: Spelling (synchronous nspell, runs after core validation) ──
  // Only fires when explicitly requested. Grammar-only runs use spellchecker
  // for Pass 3 dedup but skip this expensive synchronous pass — without the
  // gate, clicking "Grammar Check" used to re-run a full spell pass too.
  if (spellchecker && runFullSpellingPass) {
    for (const folder of folders) {
      const merged = mergedSchemas.get(folder.name);
      if (!merged) continue;

      for (const xmlFile of folder.xmlFiles) {
        const content = allFileContents[xmlFile.relativePath];
        if (!content) continue;
        const misspelled = findMisspelledWords(
          content, merged,
          (w) => spellchecker.correct(w),
          (w) => spellchecker.suggest(w)
        );
        const lines = content.split('\n');
        for (const m of misspelled) {
          const line = lineAtInContent(lines, m.absPos);
          const snippet = buildContextSnippet(content, m.absPos, m.word.length);
          let msg = spellingMessagePrefix(m);
          if (snippet) msg += ` — ...${snippet}...`;
          if (m.suggestions.length > 0) {
            msg += `. Did you mean: ${m.suggestions.join(', ')}?`;
          }
          allErrors.push({
            severity: 'warning', file: xmlFile.relativePath, line, message: msg,
            isDev: m.isDev, absPos: m.absPos,
            forbiddenChar: !!m.forbiddenChar,
            suggestions: m.suggestions || [],
          });
        }
      }

      // Metadata spelling
      const metaContent = allFileContents[folder.metadataRelPath];
      if (metaContent) {
        const metaPath = folder.metadataRelPath;
        const misspelled = findMisspelledWordsInMetadata(
          metaContent,
          (w) => spellchecker.correct(w),
          (w) => spellchecker.suggest(w)
        );
        const lines = metaContent.split('\n');
        for (const m of misspelled) {
          const line = lineAtInContent(lines, m.absPos);
          const snippet = buildContextSnippet(metaContent, m.absPos, m.word.length);
          let msg = spellingMessagePrefix(m);
          if (snippet) msg += ` — ...${snippet}...`;
          if (m.suggestions.length > 0) {
            msg += `. Did you mean: ${m.suggestions.join(', ')}?`;
          }
          allErrors.push({
            severity: 'warning', file: metaPath, line, message: msg,
            isDev: m.isDev, absPos: m.absPos,
            forbiddenChar: !!m.forbiddenChar,
            suggestions: m.suggestions || [],
          });
        }
      }
    }
  }

  // (Pass 3 — grammar — has been removed. Harper produced too much noise vs
  // signal. A future LLM-based grammar pass will run here, gated behind a
  // user-provided API key.)

  return allErrors;
}

// Shared line-at-position helper for validation passes.
// Clamps to the last line if pos is at/past EOF — without this, positions that
// drift past the file (e.g. stale tokenizer offset, off-by-one) used to report
// `lines.length + 1`, which the validation UI rendered as a phantom line "after
// the entire everything."
function lineAtInContent(lines, pos) {
  let line = 1, p = 0;
  for (const l of lines) {
    if (pos >= p && pos < p + l.length + 1) return line;
    p += l.length + 1; line++;
  }
  return Math.max(1, lines.length);
}

/**
 * Build a short context snippet around a position in the text.
 * Shows ~3 words before and after the target, with the target highlighted.
 */
function buildContextSnippet(text, pos, len) {
  const CONTEXT_CHARS = 30;
  const start = Math.max(0, pos - CONTEXT_CHARS);
  const end = Math.min(text.length, pos + len + CONTEXT_CHARS);
  let before = text.slice(start, pos).replace(/[\r\n\t]+/g, ' ');
  const target = text.slice(pos, pos + len);
  let after = text.slice(pos + len, end).replace(/[\r\n\t]+/g, ' ');

  // Trim to word boundaries
  if (start > 0) {
    const sp = before.indexOf(' ');
    if (sp >= 0) before = before.slice(sp + 1);
  }
  if (end < text.length) {
    const sp = after.lastIndexOf(' ');
    if (sp >= 0) after = after.slice(0, sp);
  }

  return `${before}[${target}]${after}`;
}

// Simple Levenshtein distance for typo suggestions
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return d[m][n];
}
