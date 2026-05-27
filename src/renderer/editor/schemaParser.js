/**
 * Parses .metadata XML files into structured schema objects.
 *
 * SharedMetaData.metadata → universal attributes inherited by every table.
 * Per-folder .metadata → table-specific attributes, sub-nodes, FK references.
 *
 * Uses simple regex/string parsing since metadata files are small and well-structured.
 * A full XML parser (DOMParser) could also be used in the renderer.
 */

/**
 * DOMParser doesn't throw on malformed XML — it returns a doc whose root is
 * a <parsererror> element. Returns true if the parse succeeded and produced
 * a real root element. Used to reject in-flight reads (file written by an
 * external tool — SVN/Git temp-rename, antivirus pause — that we caught
 * mid-write) so we don't poison the schema with an empty attribute set,
 * which would flag every attribute in every file as unknown.
 */
function isParsedOk(doc) {
  if (!doc || !doc.documentElement) return false;
  if (doc.documentElement.nodeName === 'parsererror') return false;
  if (doc.getElementsByTagName('parsererror').length > 0) return false;
  return true;
}

/**
 * Parse SharedMetaData.metadata content.
 * Returns: { attributes: [...] } on success, or null if parsing failed.
 * Callers MUST handle null by keeping the previous schema — passing an
 * empty schema to validation breaks every file at once.
 */
export function parseSharedMetadata(xmlContent) {
  const attrs = parseAttributes(xmlContent);
  if (attrs === null) return null;
  return { attributes: attrs };
}

/**
 * Return the XML attribute name that serves as each row's central identifier
 * for THIS dataset (the SharedMetaData attribute flagged is_central_identifier).
 * Heart of the Machine uses "id"; AI War 2 uses "name". The identifier is
 * universal across all tables in a dataset — SharedMetaData defines it once.
 *
 * Falls back to "id" if no SharedMetaData has been loaded yet or no attribute
 * carries the flag (matches the historical hard-coded default so legacy data
 * still works during the bootstrap window before sharedSchema arrives).
 */
export function getCentralIdentifierKey(sharedSchema) {
  if (!sharedSchema || !sharedSchema.attributes) return 'id';
  const attr = sharedSchema.attributes.find((a) => a.is_central_identifier === 'true');
  return (attr && attr.key) ? attr.key : 'id';
}

/**
 * Parse a per-folder .metadata file.
 * Returns: { nodeName, attributes, subNodes, overrides } on success,
 * or null if parsing failed (see parseSharedMetadata note).
 */
export function parseMetadata(xmlContent, folderName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, 'text/xml');
  if (!isParsedOk(doc)) return null;
  const root = doc.documentElement;

  // node_name is legitimately absent for is_for_single_root files
  // (singleton-style metadata where the root node holds attributes
  // directly). Empty nodeName is not a parse failure — buildFKIndex
  // already skips schemas without a nodeName.
  const nodeName = root.getAttribute('node_name') || '';
  const neverValidate = root.getAttribute('never_validate') === 'true';
  const isForSingleRoot = root.getAttribute('is_for_single_root') === 'true';

  const attributes = [];
  const overrides = [];
  const subNodes = [];

  // Top-level <attribute> elements
  for (const el of root.querySelectorAll(':scope > attribute')) {
    const attr = parseAttributeElement(el);
    if (attr.type === 'existing-override') {
      overrides.push(attr);
    } else {
      attributes.push(attr);
    }
  }

  // <sub_node> elements — parse ALL levels (sub-nodes can be nested)
  for (const snEl of root.querySelectorAll('sub_node')) {
    const subNode = {
      id: snEl.getAttribute('id') || '',
      attributes: [],
    };
    for (const el of snEl.querySelectorAll(':scope > attribute')) {
      subNode.attributes.push(parseAttributeElement(el));
    }
    subNodes.push(subNode);
  }

  // Surface direct children of <root> that aren't one of the recognized tags
  // (`attribute`, `sub_node`). Without this, common typos like `<atribute>`
  // are silently dropped — the mod author thinks their schema has 6 fields,
  // the validator sees 0, and nothing tells them why. Console-only is OK for
  // now (the validator window pulls from a different pipeline), but it
  // surfaces immediately in dev mode and is grep-able for users who notice
  // "my new schema entries aren't taking effect."
  const KNOWN_ROOT_CHILDREN = new Set(['attribute', 'sub_node']);
  for (const child of root.children) {
    const tag = child.nodeName;
    if (KNOWN_ROOT_CHILDREN.has(tag)) continue;
    // tag is `parsererror` only when DOMParser already failed — we returned
    // null above for that case, so any tag here is a real unrecognized child.
    console.warn(
      `[schemaParser] Unknown element <${tag}> in ${folderName || '<unknown>'} metadata — `
      + `did you mean <attribute> or <sub_node>? Its contents will be ignored.`
    );
  }
  // Same for direct children of each <sub_node>.
  for (const snEl of root.querySelectorAll('sub_node')) {
    for (const child of snEl.children) {
      const tag = child.nodeName;
      if (tag === 'attribute' || tag === 'sub_node' || tag === 'option') continue;
      console.warn(
        `[schemaParser] Unknown element <${tag}> inside <sub_node id="${snEl.getAttribute('id') || ''}">`
        + ` in ${folderName || '<unknown>'} metadata — its contents will be ignored.`
      );
    }
  }

  return { nodeName, neverValidate, isForSingleRoot, attributes, subNodes, overrides, folderName };
}

function parseAttributeElement(el) {
  const result = {
    key: el.getAttribute('key') || '',
    type: el.getAttribute('type') || 'string',
  };

  // Optional attributes.
  // Removed (deprecated by the engine, stripped from data files):
  //   minlength, maxlength, min, max, is_required, content_width_px.
  const optionals = [
    'default', 'node_source', 'node_sub_source', 'node_extra_allowed',
    'tooltip', 'description',
    'is_localized',
    // ID-like flags — spellcheck and other string-handling logic should treat these
    // as opaque identifiers, never as human text.
    'is_central_identifier', 'is_id_for_layer', 'is_partial_identifier',
    'is_data_copy_identifier', 'is_internal_notes', 'is_translation_notes',
    'is_description', 'is_user_facing_name',
    // Explicit opt-out from spellcheck and grammar checking — for fields where
    // text content should never be examined as prose (e.g. opaque tokens).
    'no_spellcheck_or_grammar',
    // Per-field override of the layer-visibility rules. When "true" on a
    // node-dropdown / node-list field, the validator skips the "can this
    // layer reference that layer?" check and the FK picker shows targets
    // from every layer (not just the file's allowed-target set). Used for
    // truly cross-cutting links where the engine handles missing-target
    // gracefully at runtime (e.g. a base entity referencing optional
    // mod-introduced content). See design.md §31 for the default rules.
    'can_make_invalid_cross_links',
  ];

  for (const attr of optionals) {
    const val = el.getAttribute(attr);
    if (val !== null) result[attr] = val;
  }

  // Dropdown options
  const options = [];
  for (const opt of el.querySelectorAll(':scope > option')) {
    options.push(opt.getAttribute('value') || opt.textContent);
  }
  if (options.length) result.options = options;

  return result;
}

/**
 * Simple fallback parser for SharedMetaData which may not use sub_node structure.
 */
function parseAttributes(xmlContent) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlContent, 'text/xml');
  if (!isParsedOk(doc)) return null;
  const root = doc.documentElement;
  const attrs = [];

  for (const el of root.querySelectorAll('attribute')) {
    attrs.push(parseAttributeElement(el));
  }

  return attrs;
}

/**
 * Build a merged attribute list for a given table:
 * SharedMetaData attrs + overrides + table-specific attrs
 */
export function buildMergedSchema(sharedSchema, tableSchema) {
  if (!sharedSchema || !tableSchema) return null;

  const merged = [];

  // Start with shared attributes, applying overrides
  for (const attr of sharedSchema.attributes) {
    const override = tableSchema.overrides?.find((o) => o.key === attr.key);
    if (override) {
      // Merge override properties onto shared attr
      merged.push({ ...attr, ...override, type: attr.type });
    } else {
      merged.push({ ...attr });
    }
  }

  // Add table-specific attributes
  for (const attr of tableSchema.attributes) {
    merged.push({ ...attr });
  }

  return {
    nodeName: tableSchema.nodeName,
    isForSingleRoot: tableSchema.isForSingleRoot || false,
    attributes: merged,
    subNodes: tableSchema.subNodes || [],
  };
}

/**
 * Compose a base merged schema with zero or more mod schema extensions.
 *
 * An extension is a parsed `_<TableName>.metadata` shipped by a mod for a
 * table whose primary schema lives elsewhere (base / DLC / an earlier mod).
 * Its job is to declare extra fields and sub-nodes the mod's DLL reads at
 * runtime — e.g. Reclaimers shipping a `_GameEntity.metadata` that adds a
 * `charge_type` sub-node — so the validator stops flagging those as unknown
 * inside files belonging to the mod (and to mods that require it).
 *
 * Composition rules:
 *   - Extension attributes at the top level: add if the key isn't already
 *     present in `merged.attributes`. Existing entries win (extensions are
 *     additive; the primary schema is authoritative for shared keys).
 *   - Extension sub_nodes: if a sub_node with the same id exists in
 *     `merged.subNodes`, merge their attribute lists (extension adds attrs
 *     whose keys aren't already there). Otherwise append the new sub_node.
 *   - Empty/missing extensions are no-ops; returns the base merged schema
 *     unchanged (referentially equal when no extensions apply, so cheap
 *     downstream caches stay hot).
 *
 * Returns a new object; never mutates either input.
 */
export function composeSchemaWithExtensions(merged, extensions) {
  if (!merged) return merged;
  if (!extensions || extensions.length === 0) return merged;

  // Deep-enough copy: shared inner attribute objects are fine (we never
  // mutate them), but the containers must be fresh so caller mutations
  // don't leak into the cached base.
  const attributes = [...merged.attributes];
  const subNodes = merged.subNodes ? merged.subNodes.map((sn) => ({ ...sn, attributes: [...sn.attributes] })) : [];
  const attrKeys = new Set(attributes.map((a) => a.key));
  const subNodeIndexById = new Map(subNodes.map((sn, i) => [sn.id, i]));

  for (const ext of extensions) {
    if (!ext) continue;
    for (const a of (ext.attributes || [])) {
      if (!a.key || attrKeys.has(a.key)) continue;
      attributes.push({ ...a });
      attrKeys.add(a.key);
    }
    for (const sn of (ext.subNodes || [])) {
      const existingIdx = sn.id != null ? subNodeIndexById.get(sn.id) : undefined;
      if (existingIdx == null) {
        subNodes.push({ id: sn.id || '', attributes: [...(sn.attributes || [])] });
        subNodeIndexById.set(sn.id, subNodes.length - 1);
      } else {
        const target = subNodes[existingIdx];
        const existingKeys = new Set(target.attributes.map((a) => a.key));
        for (const a of (sn.attributes || [])) {
          if (!a.key || existingKeys.has(a.key)) continue;
          target.attributes.push({ ...a });
          existingKeys.add(a.key);
        }
      }
    }
  }

  return {
    nodeName: merged.nodeName,
    isForSingleRoot: merged.isForSingleRoot,
    attributes,
    subNodes,
  };
}

/**
 * Pick the applicable mod schema extensions for a file in `layer` validating
 * against table `folderName`, then return the composed schema. Used by both
 * the worker validator and the renderer's inline (saveFile + EditorPane)
 * code paths so the rules live in one place.
 *
 * Visibility (mirrors §32.5):
 *   - Base / DLC layers: no extensions apply. Returns `merged` unchanged.
 *   - Mod layer L: extensions from L itself, plus extensions from any mod
 *     in L's modExtras (i.e. the mods L declared in `required_mods`). DLCs
 *     in L's extras don't contribute — DLCs don't ship mod extensions.
 *
 * @param {object} merged — base merged schema from buildMergedSchema
 * @param {object} schemaExtensions — { [modLayer]: { [folderName]: parsedExt } }
 * @param {object} modExtrasByLayer — { [modLayer]: ['base'/'dlcN'/'mod_...', ...] }
 * @param {string} layer — the file's layer
 * @param {string} folderName — the file's table folder
 */
export function composeSchemaForFileLayer(merged, schemaExtensions, modExtrasByLayer, layer, folderName) {
  if (!merged || !layer || !layer.startsWith('mod_')) return merged;
  if (!schemaExtensions) return merged;
  const applicable = [];
  const own = schemaExtensions[layer]?.[folderName];
  if (own) applicable.push(own);
  const extras = (modExtrasByLayer && modExtrasByLayer[layer]) || [];
  for (const l of extras) {
    if (!l || !l.startsWith('mod_') || l === layer) continue;
    const ext = schemaExtensions[l]?.[folderName];
    if (ext) applicable.push(ext);
  }
  if (applicable.length === 0) return merged;
  return composeSchemaWithExtensions(merged, applicable);
}
