/**
 * FK Cross-Reference Index (layer-aware).
 *
 * Maintains a Set of IDs per table for O(1) existence checks, plus a
 * pre-sorted array for dropdown display.
 *
 * In suite mode each XML file belongs to a *layer* — 'base' (the core game)
 * or 'dlc1' / 'dlc2' / … (an expansion). The index records IDs per layer so
 * validation can enforce the cross-layer reference rules:
 *   - base may only reference base
 *   - dlc<N> may reference base + its own dlc<N>
 *   - no DLC↔DLC references
 * Narrow mode has only the 'base' layer, so all the layer machinery collapses
 * to the original single-set behavior.
 *
 * Per-table entry shape:
 *   index['1_BuildingTag'] = {
 *     ids:       Set<string>   — union of all layers (back-compat)
 *     sorted:    string[]      — union, naturally sorted (back-compat)
 *     subIds:    Set<string>   — union of compound Parent:Child pairs
 *     subSorted: string[]
 *     byLayer: {
 *       base:  { ids, sorted, subIds, subSorted },
 *       dlc1:  { ids, sorted, subIds, subSorted },
 *       ...
 *     }
 *   }
 *
 * Usage:
 *   const index = buildFKIndex(folders, fileContents, schemas);
 *   index['BuildingTag'].ids.has('foo')
 *
 * Incremental update:
 *   updateTableIndex(index, tableName, layeredContents, nodeName, schemas)
 */

import { naturalCompare } from './naturalSort';

/**
 * Which layers a file in `layer` is permitted to reference. Base sees only
 * base; a DLC sees base plus itself. Used by both the validator and the FK
 * dropdown pickers so the allowed set is defined in exactly one place.
 *
 * `extraLayers` widens the allowed set for the specific row being checked —
 * used by the conditional cross-DLC rule: a row whose XML carries
 * `required_expansion_list="OtherDLC_dirname,..."` is only present when those
 * DLCs are installed, so it may safely reference rows from those DLCs. The
 * caller is responsible for translating dirNames to layer ids before passing.
 */
export function allowedTargetLayers(layer, extraLayers) {
  const base = (!layer || layer === 'base') ? ['base'] : ['base', layer];
  if (!extraLayers || extraLayers.length === 0) return base;
  const out = new Set(base);
  for (const l of extraLayers) if (l) out.add(l);
  return [...out];
}

/**
 * Extract all IDs from an XML file's content for a given node_name.
 * `centralIdKey` is the XML attribute that holds the central identifier —
 * "id" for Heart of the Machine, "name" for AI War 2 (defined by the
 * is_central_identifier flag in SharedMetaData).
 */
function extractIDs(xmlContent, nodeName, centralIdKey) {
  const ids = new Set();
  const re = new RegExp(`<${nodeName}[\\s][^>]*\\b${centralIdKey}\\s*=\\s*"([^"]*)"`, 'g');
  let match;
  while ((match = re.exec(xmlContent)) !== null) {
    if (match[1]) ids.add(match[1]);
  }
  return ids;
}

/**
 * Extract compound ParentID:ChildID pairs for sub-source references.
 * subNodeName: the sub-node tag name (e.g., "goal_path")
 * subIdField: the identifier field on the sub-node (e.g., "id")
 * centralIdKey: the parent's central-identifier attribute name
 *   ("id" / "name", per SharedMetaData).
 */
function extractSubSourceIDs(xmlContent, nodeName, subNodeName, subIdField, centralIdKey) {
  const pairs = new Set();
  // Find each parent node with its ID, then find sub-nodes within it
  const parentRe = new RegExp(`<${nodeName}[\\s][^>]*\\b${centralIdKey}\\s*=\\s*"([^"]*)"`, 'g');
  let pm;
  while ((pm = parentRe.exec(xmlContent)) !== null) {
    const parentId = pm[1];
    if (!parentId) continue;
    // Find the closing tag for this parent
    const startPos = pm.index;
    const closeTag = `</${nodeName}>`;
    const endPos = xmlContent.indexOf(closeTag, startPos);
    if (endPos < 0) continue;
    const parentBlock = xmlContent.slice(startPos, endPos);
    // Find sub-nodes within this block
    const subRe = new RegExp(`<${subNodeName}[\\s][^>]*\\b${subIdField}\\s*=\\s*"([^"]*)"`, 'g');
    let sm;
    while ((sm = subRe.exec(parentBlock)) !== null) {
      if (sm[1]) pairs.add(`${parentId}:${sm[1]}`);
    }
  }
  return pairs;
}

/**
 * Compute the set of compound `Parent:Child` pairs that other tables can
 * reach into this table for. Walks every schema looking for attributes whose
 * `node_source` targets this table AND that declare a `node_sub_source` like
 * `sub_node:id_field`. For each such reference, scans the supplied XML
 * contents to extract every parent-child pair.
 *
 * @param {string} tableName — folder name (e.g. "1_TimelineGoal")
 * @param {string} baseName — folder name without numeric prefix
 * @param {string} nodeName — XML tag name for entries in this table
 * @param {Iterable<string>} xmlContents — XML file contents to scan
 * @param {Object} schemas — folderName → parsed metadata
 * @returns {Set<string>} compound IDs in `Parent:Child` form
 */
function computeSubSourcePairs(tableName, baseName, nodeName, xmlContents, schemas, centralIdKey) {
  const subSourcePairs = new Set();
  for (const otherSchema of Object.values(schemas)) {
    if (!otherSchema) continue;
    const allAttrs = [...(otherSchema.attributes || [])];
    for (const sn of otherSchema.subNodes || []) {
      allAttrs.push(...(sn.attributes || []));
    }
    for (const attr of allAttrs) {
      if (!attr.node_sub_source) continue;
      const src = attr.node_source;
      if (src !== tableName && src !== baseName) continue;
      const parts = attr.node_sub_source.split(':');
      if (parts.length !== 2) continue;
      const [subNodeName, subIdField] = parts;
      for (const content of xmlContents) {
        if (!content) continue;
        for (const pair of extractSubSourceIDs(content, nodeName, subNodeName, subIdField, centralIdKey)) {
          subSourcePairs.add(pair);
        }
      }
    }
  }
  return subSourcePairs;
}

/**
 * Build a single table's index entry from a list of layered file contents.
 * Shared by `buildFKIndex` (full build) and `updateTableIndex` (incremental).
 *
 * @param {Array<{layer: string, content: string}>} layeredContents
 * @param {string} tableName — folder name (e.g. "1_TimelineGoal")
 * @param {string} baseName — folder name without numeric prefix
 * @param {string} nodeName — XML tag name for entries in this table
 * @param {Object} schemas — full schemas map (for sub-source pairs)
 */
function buildTableEntry(layeredContents, tableName, baseName, nodeName, schemas, centralIdKey) {
  // Group contents by layer.
  const byLayerContents = new Map(); // layer → string[]
  for (const { layer, content } of layeredContents) {
    const key = layer || 'base';
    if (!byLayerContents.has(key)) byLayerContents.set(key, []);
    if (content) byLayerContents.get(key).push(content);
  }

  const byLayer = {};
  const unionIds = new Set();
  const unionSub = new Set();
  for (const [layer, contents] of byLayerContents) {
    const ids = new Set();
    for (const content of contents) {
      for (const id of extractIDs(content, nodeName, centralIdKey)) ids.add(id);
    }
    const subIds = schemas
      ? computeSubSourcePairs(tableName, baseName, nodeName, contents, schemas, centralIdKey)
      : new Set();
    byLayer[layer] = {
      ids,
      sorted: [...ids].sort(naturalCompare),
      subIds,
      subSorted: [...subIds].sort(naturalCompare),
    };
    for (const id of ids) unionIds.add(id);
    for (const pair of subIds) unionSub.add(pair);
  }

  return {
    ids: unionIds,
    sorted: [...unionIds].sort(naturalCompare),
    subIds: unionSub,
    subSorted: [...unionSub].sort(naturalCompare),
    byLayer,
  };
}

/**
 * Detect the actual node name for a folder. For neverValidate tables the
 * metadata node_name may be a dummy, so we sniff the first XML file instead.
 */
function resolveNodeName(folder, schema, allFileContents) {
  let nodeName = schema.nodeName;
  if (schema.neverValidate) {
    for (const xmlFile of folder.xmlFiles) {
      const content = allFileContents[xmlFile.relativePath];
      if (!content) continue;
      const m = content.match(/<root>\s*<([\w.-]+)\s/);
      if (m) { nodeName = m[1]; break; }
    }
  }
  return nodeName;
}

/**
 * Build the full FK index from all discovered folders and their file contents.
 *
 * @param {Array} folders — from discoverData(); each xmlFile carries `layer`
 * @param {Object} allFileContents — relativePath → string content
 * @param {Object} schemas — folderName → parsed metadata with { nodeName }
 * @param {string} [centralIdKey='id'] — XML attribute holding each row's
 *   central identifier ("id" for Heart of the Machine, "name" for AI War 2).
 *   Defaults to "id" so calls that predate AIW2 support keep working.
 * @returns {Object} tableName → table entry (see file header)
 */
export function buildFKIndex(folders, allFileContents, schemas, centralIdKey = 'id') {
  const index = {};

  for (const folder of folders) {
    const schema = schemas[folder.name];
    if (!schema || !schema.nodeName) continue;

    const tableName = folder.name;
    const baseName = folder.name.replace(/^\d+_/, '');
    const nodeName = resolveNodeName(folder, schema, allFileContents);

    const layeredContents = folder.xmlFiles.map((xf) => ({
      layer: xf.layer || 'base',
      content: allFileContents[xf.relativePath],
    }));

    index[tableName] = buildTableEntry(layeredContents, tableName, baseName, nodeName, schemas, centralIdKey);

    if (baseName !== tableName) {
      index[baseName] = index[tableName];
    }
  }

  return index;
}

/**
 * Incrementally update a single table's index after a file save. Rebuilds the
 * whole table (all layers) from the supplied layered contents — cheap enough
 * for one table, and keeps byLayer / subIds perfectly consistent.
 *
 * @param {Object} index — the live FK index (mutated in place)
 * @param {string} tableName — folder name (e.g. "1_TimelineGoal")
 * @param {Array<{layer: string, content: string}>} layeredContents
 * @param {string} nodeName — XML tag name for entries in this table
 * @param {Object} [schemas] — full schemas map; required to recompute subIds
 */
export function updateTableIndex(index, tableName, layeredContents, nodeName, schemas, centralIdKey = 'id') {
  const baseName = tableName.replace(/^\d+_/, '');
  index[tableName] = buildTableEntry(layeredContents, tableName, baseName, nodeName, schemas, centralIdKey);
  if (baseName !== tableName) {
    index[baseName] = index[tableName];
  }
}

/**
 * Resolve FK references — given a node_source name, find matching table.
 * Handles both folder names ("1_BuildingTag") and base names ("BuildingTag").
 */
export function resolveFK(index, nodeSource) {
  if (!nodeSource || nodeSource === 'self') return null;
  return index[nodeSource] || null;
}

/**
 * Build a LookupSwaps map from the LookupSwaps XML content.
 *
 * LookupSwaps files can ship in any layer (base or any expansion). They are
 * intentionally validation-free fallbacks — entries usually point at IDs that
 * no longer exist — so every layer's swaps are merged together unconditionally.
 *
 * Returns: { oldId → newId }
 */
export function buildLookupSwaps(allFileContents, centralIdKey = 'id') {
  const swaps = {};
  // Find every LookupSwaps XML file, in any layer.
  //
  // Tag name varies by project (HotM: <lookup_swap>, AIW2: <swap>), and the
  // "from" / "to" attribute pair tracks the dataset's central identifier:
  //   id   → new_id     (Heart of the Machine)
  //   name → new_name   (AI War 2)
  // We match by attribute presence rather than tag name so this stays robust
  // if a future project picks yet another tag name.
  const fromKey = centralIdKey;
  const toKey = `new_${centralIdKey}`;
  // Use one regex per attribute-order possibility so we don't require a fixed
  // order in the source XML (authors freely write either order).
  const reA = new RegExp(`<\\w+[^>]*\\b${fromKey}\\s*=\\s*"([^"]*)"[^>]*\\b${toKey}\\s*=\\s*"([^"]*)"`, 'g');
  const reB = new RegExp(`<\\w+[^>]*\\b${toKey}\\s*=\\s*"([^"]*)"[^>]*\\b${fromKey}\\s*=\\s*"([^"]*)"`, 'g');
  for (const [path, content] of Object.entries(allFileContents)) {
    if (!path.includes('LookupSwaps') || !path.endsWith('.xml')) continue;
    let m;
    while ((m = reA.exec(content)) !== null) {
      if (m[1] && m[2]) swaps[m[1]] = m[2];
    }
    while ((m = reB.exec(content)) !== null) {
      // m[1] is the "to", m[2] is the "from" in this ordering
      if (m[1] && m[2]) swaps[m[2]] = m[1];
    }
  }
  return swaps;
}

/**
 * Resolve a value through the LookupSwaps chain.
 * Returns the final resolved name, or null if no swap exists.
 */
export function resolveSwapChain(swaps, oldId, maxDepth = 10) {
  let current = oldId;
  let depth = 0;
  while (swaps[current] && depth < maxDepth) {
    current = swaps[current];
    depth++;
  }
  return depth > 0 ? current : null;
}

/**
 * Get sorted options for a dropdown from the FK index — union of all layers.
 */
export function getFKOptions(index, nodeSource) {
  const entry = resolveFK(index, nodeSource);
  return entry ? entry.sorted : [];
}

/**
 * Get sorted FK options visible from a given editing layer. A base file sees
 * only base IDs; a DLC file sees base + its own DLC. Falls back to the union
 * when the entry has no byLayer info (defensive — shouldn't happen post-build).
 *
 * `unrestricted` mirrors the schema `can_make_invalid_cross_links="true"`
 * flag — when true, returns IDs from EVERY layer regardless of the
 * referrer's allowed set. The picker UI uses this so the user can deliberately
 * link a base file to a DLC/mod row without the validator flagging it.
 */
export function getFKOptionsForLayer(index, nodeSource, layer, extraLayers, unrestricted = false) {
  const entry = resolveFK(index, nodeSource);
  if (!entry) return [];
  if (!entry.byLayer) return entry.sorted;
  if (unrestricted) {
    const out = new Set();
    for (const bl of Object.values(entry.byLayer)) {
      for (const id of bl.sorted) out.add(id);
    }
    return [...out].sort(naturalCompare);
  }
  const allowed = allowedTargetLayers(layer, extraLayers);
  const out = new Set();
  for (const l of allowed) {
    const bl = entry.byLayer[l];
    if (bl) for (const id of bl.sorted) out.add(id);
  }
  return [...out].sort(naturalCompare);
}

/**
 * Same as getFKOptionsForLayer but for compound sub-source pairs.
 */
export function getFKSubOptionsForLayer(index, nodeSource, layer, extraLayers, unrestricted = false) {
  const entry = resolveFK(index, nodeSource);
  if (!entry) return [];
  if (!entry.byLayer) return entry.subSorted || [];
  if (unrestricted) {
    const out = new Set();
    for (const bl of Object.values(entry.byLayer)) {
      for (const id of (bl.subSorted || [])) out.add(id);
    }
    return [...out].sort(naturalCompare);
  }
  const allowed = allowedTargetLayers(layer, extraLayers);
  const out = new Set();
  for (const l of allowed) {
    const bl = entry.byLayer[l];
    if (bl) for (const id of bl.subSorted) out.add(id);
  }
  return [...out].sort(naturalCompare);
}
