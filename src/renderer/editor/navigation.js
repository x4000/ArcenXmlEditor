/**
 * Ctrl+click navigation logic, shared by the main window (App.jsx) and every
 * detached window (DetachedApp.jsx).
 *
 * These used to live as closures inside App.jsx only; the detached window wired
 * the EditorPane's onNavigateToFK / onNavigateToMetadata props to empty no-ops,
 * so Ctrl+click did nothing there. Pulling the logic out into pure functions
 * that take an explicit context lets both windows share ONE implementation —
 * no divergence, and the detached window gets the same behavior the main one
 * has always had.
 *
 * Each function is UI-framework-agnostic: it reads/writes through callbacks the
 * caller supplies (getContent / setContent / openFile / scrollTo), so it never
 * touches React state directly.
 */

/**
 * Ctrl+click an FK value (or pick "go to" from an FK dropdown): open the file
 * that defines the referenced row and scroll to it.
 *
 * @param {string} tableName  node_source of the FK (folder or base name)
 * @param {string} id         the referenced central id ("" → open the table's
 *                            metadata file, used by the schema-editor path)
 * @param {object} ctx
 *   folders       Array — discovered folders (each has name, metadataRelPath, xmlFiles)
 *   getContent    (relPath) => string|undefined — current cached file content
 *   openFile      (relPath, type) => Promise — open/activate a tab; resolves once active
 *   scrollTo      ({file, line, highlight}) => void — queue a scroll/highlight
 */
export function navigateToFKRow(tableName, id, ctx) {
  const { folders, getContent, openFile, scrollTo } = ctx;
  const baseName = tableName.replace(/^\d+_/, '');
  const folder = folders.find((f) => {
    const fb = f.name.replace(/^\d+_/, '');
    return fb === baseName || f.name === tableName;
  });
  if (!folder) return;

  // Empty ID = navigate to the table's metadata file (from schema editor)
  if (!id) {
    const metaRelPath = folder.metadataRelPath;
    if (metaRelPath) openFile(metaRelPath, 'schema');
    return;
  }

  // Search XML files in this folder for exact ID match
  for (const xmlFile of folder.xmlFiles) {
    const content = getContent(xmlFile.relativePath);
    if (!content) continue;
    const pattern = `id="${id}"`;
    const idx = content.indexOf(pattern);
    if (idx >= 0) {
      const line = content.slice(0, idx).split('\n').length;
      openFile(xmlFile.relativePath, 'xml').then(() => {
        scrollTo({ file: xmlFile.relativePath, line, highlight: id });
      });
      return;
    }
  }

  // No exact match found — find the file with the most similar ID
  let bestFile = null;
  let bestId = null;
  let bestScore = -1;
  const idLower = id.toLowerCase();

  for (const xmlFile of folder.xmlFiles) {
    const content = getContent(xmlFile.relativePath);
    if (!content) continue;
    const idRe = /\bid="([^"]*)"/g;
    let m;
    while ((m = idRe.exec(content)) !== null) {
      const candidate = m[1];
      const cLower = candidate.toLowerCase();
      // Score by common prefix length
      let score = 0;
      for (let i = 0; i < Math.min(idLower.length, cLower.length); i++) {
        if (idLower[i] === cLower[i]) score++;
        else break;
      }
      // Bonus for substring containment
      if (cLower.includes(idLower) || idLower.includes(cLower)) score += 50;
      if (score > bestScore) {
        bestScore = score;
        bestFile = xmlFile.relativePath;
        bestId = candidate;
      }
    }
  }

  if (bestFile) {
    const content = getContent(bestFile);
    const idx = bestId ? content.indexOf(`id="${bestId}"`) : 0;
    const line = idx >= 0 ? content.slice(0, idx).split('\n').length : 1;
    openFile(bestFile, 'xml').then(() => {
      scrollTo({ file: bestFile, line, highlight: bestId });
    });
  } else if (folder.xmlFiles.length > 0) {
    // Fall back to first file in folder
    openFile(folder.xmlFiles[0].relativePath, 'xml');
  }
}

// Return {start, end} spanning the `<sub_node id="X"> … </sub_node>` block whose
// id is `subId`, accounting for nested sub_nodes (so a parent block isn't cut
// short at a child's closing tag). `end` is the offset of the matching
// `</sub_node>`. Returns null if no such sub_node opening is present.
function subNodeBlockRange(content, subId) {
  const start = content.indexOf(`<sub_node id="${subId}"`);
  if (start < 0) return null;
  let depth = 0;
  let i = start;
  while (i < content.length) {
    const open = content.indexOf('<sub_node', i + 1);
    const close = content.indexOf('</sub_node>', i + 1);
    if (close < 0) return { start, end: content.length };
    if (open >= 0 && open < close) {
      depth++;
      i = open + '<sub_node'.length;
    } else {
      if (depth === 0) return { start, end: close };
      depth--;
      i = close + '</sub_node>'.length;
    }
  }
  return { start, end: content.length };
}

// Find the end of an `<attribute …>` node (handles multi-line attributes).
// An attribute ends with /> or </attribute>.
function findAttrEnd(content, startIdx) {
  let i = startIdx;
  let inQuote = false;
  while (i < content.length) {
    if (content[i] === '"') { inQuote = !inQuote; i++; continue; }
    if (inQuote) { i++; continue; }
    if (content[i] === '/' && i + 1 < content.length && content[i + 1] === '>') {
      const nl = content.indexOf('\n', i + 2);
      return nl >= 0 ? nl + 1 : i + 2;
    }
    if (content.startsWith('</attribute>', i)) {
      const nl = content.indexOf('\n', i + 12);
      return nl >= 0 ? nl + 1 : i + 12;
    }
    i++;
  }
  return content.length;
}

/**
 * Ctrl+click an attribute NAME: jump to where that attribute is declared in the
 * metadata. If it isn't declared anywhere visible, drop a `FIELD_NEEDED` stub in
 * the right schema file and jump there so the author can fill it in.
 *
 * @param {string} attrName   the attribute key clicked
 * @param {string|null} parentTag  enclosing tag (sub-node id) or null/root for top level
 * @param {object} ctx
 *   activeRelPath        string — the file the click happened in
 *   folderNameOf         (relPath) => string — logical folder for a path
 *   folders              Array
 *   sharedMetadataRelPath string|null — SharedMetaData.metadata path
 *   layerByRelPath       Map<relPath, {layer}> — file → layer info
 *   modSchemaExtensions  Array — mod schema-extension records (may be empty;
 *                        detached windows don't track these, which only costs
 *                        mod-extension targeting — base/DLC files are unaffected)
 *   schemas              Object — folderName → parsed schema
 *   getContent           (relPath) => string|undefined
 *   setContent           (relPath, content) => void — commit an edited file
 *   openFile             (relPath, type) => Promise
 *   scrollTo             ({file, line, highlight}) => void
 *   scheduleScroll       (fn) => void — defer a scroll until after the inserted
 *                        content commits (App uses a 100ms timeout); optional,
 *                        defaults to a microtask-ish setTimeout(…, 100)
 */
export function navigateToMetadataDef(attrName, parentTag, ctx) {
  const {
    activeRelPath, folderNameOf, folders, sharedMetadataRelPath,
    layerByRelPath, modSchemaExtensions, schemas,
    getContent, setContent, openFile, scrollTo,
    scheduleScroll = (fn) => setTimeout(fn, 100),
    island = null,
  } = ctx;

  if (!activeRelPath) return;

  // Island data file: its schema is the island's own standalone `_<Name>.metadata`
  // — no folder lookup, no SharedMetaData, no mod extensions. Synthesize a
  // folder-like shape so the search/insert logic below works unchanged.
  const folderName = island ? island.name : folderNameOf(activeRelPath);
  const folder = island
    ? { name: island.name, metadataRelPath: island.metadataRelPath, metadataPath: island.metadataPath }
    : folders.find((f) => f.name === folderName);
  if (!folder) return;
  const schemaNodeName = island ? island.nodeName : schemas?.[folderName]?.nodeName;
  const sharedRel = island ? null : sharedMetadataRelPath;
  const activeLayer = island ? null : layerByRelPath?.get(activeRelPath)?.layer;

  // Mod-extension lookup for this file's mod (if applicable; never for islands).
  let extRecord = null;
  if (activeLayer && activeLayer.startsWith('mod_')) {
    extRecord = (modSchemaExtensions || []).find(
      (e) => e.modLayer === activeLayer && e.folderName === folderName
    ) || null;
  }

  // Build candidate list in priority order, dropping any that don't exist on
  // disk (folder.metadataRelPath is null for schemaless folders; sharedRel is
  // null on first run before discovery completes).
  const candidates = [];
  if (folder.metadataRelPath) candidates.push(folder.metadataRelPath);
  if (extRecord && extRecord.metadataRelPath !== folder.metadataRelPath) {
    candidates.push(extRecord.metadataRelPath);
  }
  if (sharedRel) candidates.push(sharedRel);

  // Where to put a FIELD_NEEDED stub if the attribute is absent everywhere.
  const insertTarget = extRecord ? extRecord.metadataRelPath : folder.metadataRelPath;
  if (candidates.length === 0 && !insertTarget) return;

  // Search each candidate for the literal `key="<attr>"` pattern. When the
  // clicked attribute sits inside a sub-node, search WITHIN that sub_node's
  // block first so a same-named attribute in a SIBLING sub-node doesn't capture
  // the jump (e.g. `cutoff` exists in both severity_regular and
  // severity_multiplicative). Fall back to a global search afterward — that
  // covers cascading top-level attrs declared outside any sub_node block.
  const isSubNodeCtx = parentTag && parentTag !== 'root' && parentTag !== schemaNodeName;
  const findAttrInCandidate = (relPath) => {
    const content = getContent(relPath);
    if (!content) return null;
    if (isSubNodeCtx) {
      const block = subNodeBlockRange(content, parentTag);
      if (block) {
        const rel = content.slice(block.start, block.end).indexOf(`key="${attrName}"`);
        if (rel >= 0) {
          const abs = block.start + rel;
          return { file: relPath, line: content.slice(0, abs).split('\n').length };
        }
      }
    }
    const idx = content.indexOf(`key="${attrName}"`);
    if (idx < 0) return null;
    return { file: relPath, line: content.slice(0, idx).split('\n').length };
  };

  let hit = null;
  for (const c of candidates) {
    hit = findAttrInCandidate(c);
    if (hit) break;
  }

  if (hit) {
    openFile(hit.file, 'schema').then(() => {
      scrollTo({ file: hit.file, line: hit.line, highlight: attrName });
    });
    return;
  }

  // Not declared anywhere — fall through to FIELD_NEEDED insertion.
  const metaRelPath = insertTarget;
  if (!metaRelPath) return;
  openFile(metaRelPath, 'schema').then(() => {
    const metaContent = getContent(metaRelPath);
    if (!metaContent) return;

    // If a FIELD_NEEDED comment for this attr is already present (from a prior
    // Ctrl+click that hasn't been resolved yet), jump to it instead of stacking.
    const existingFN = metaContent.indexOf(`FIELD_NEEDED: ${attrName}`);
    if (existingFN >= 0) {
      const line = metaContent.slice(0, existingFN).split('\n').length;
      scrollTo({ file: metaRelPath, line, highlight: attrName });
      return;
    }

    const comment = `\t<!--FIELD_NEEDED: ${attrName}-->\n`;
    const nodeName = schemaNodeName;
    const isSubNode = parentTag && parentTag !== nodeName && parentTag !== 'root';

    let insertPos;

    if (isSubNode) {
      const subNodePattern = `<sub_node id="${parentTag}"`;
      const subIdx = metaContent.indexOf(subNodePattern);
      if (subIdx >= 0) {
        const closeSubIdx = metaContent.indexOf('</sub_node>', subIdx);
        if (closeSubIdx >= 0) {
          // Find last attribute in this sub_node block and insert after it
          const subBlock = metaContent.slice(subIdx, closeSubIdx);
          const subAttrRe = /<attribute /g;
          let lastSubAttrPos = -1;
          let sm;
          while ((sm = subAttrRe.exec(subBlock)) !== null) {
            lastSubAttrPos = subIdx + sm.index;
          }
          if (lastSubAttrPos >= 0) {
            insertPos = findAttrEnd(metaContent, lastSubAttrPos);
          } else {
            // No attributes in sub_node yet — insert after the opening tag
            const gtIdx = metaContent.indexOf('>', subIdx);
            const nl = metaContent.indexOf('\n', gtIdx);
            insertPos = nl >= 0 ? nl + 1 : gtIdx + 1;
          }
        } else {
          const gtIdx = metaContent.indexOf('>', subIdx);
          insertPos = gtIdx >= 0 ? gtIdx + 1 : subIdx + subNodePattern.length;
        }
      } else {
        const rootCloseIdx = metaContent.lastIndexOf('</root>');
        insertPos = rootCloseIdx >= 0 ? rootCloseIdx : metaContent.length;
      }
    } else {
      // Top-level: find the last attribute before any sub_node and insert after its end
      const subNodeIdx = metaContent.indexOf('<sub_node');
      const rootCloseIdx = metaContent.lastIndexOf('</root>');
      const boundary = subNodeIdx >= 0 ? subNodeIdx : (rootCloseIdx >= 0 ? rootCloseIdx : metaContent.length);

      const attrRe = /\t<attribute /g;
      let lastAttrStart = -1;
      let m;
      while ((m = attrRe.exec(metaContent)) !== null) {
        if (m.index < boundary) lastAttrStart = m.index;
      }

      if (lastAttrStart >= 0) {
        insertPos = findAttrEnd(metaContent, lastAttrStart);
      } else if (subNodeIdx >= 0) {
        insertPos = metaContent.lastIndexOf('\n', subNodeIdx);
        if (insertPos < 0) insertPos = subNodeIdx;
        else insertPos += 1;
      } else if (rootCloseIdx >= 0) {
        insertPos = rootCloseIdx;
      } else {
        insertPos = metaContent.length;
      }
    }

    const insertContent = metaContent.slice(0, insertPos) + comment + metaContent.slice(insertPos);
    setContent(metaRelPath, insertContent);

    const insertedLine = insertContent.slice(0, insertPos).split('\n').length;
    scheduleScroll(() => {
      scrollTo({ file: metaRelPath, line: insertedLine, highlight: attrName });
    });
  });
}

/**
 * Ctrl+click a tag the schema doesn't recognize: declare it as a `<sub_node>`
 * stub in the right metadata file and jump there. Shared by both windows so the
 * detached window stops dead-ending this gesture.
 *
 * @param {string} tagName  the unknown tag clicked
 * @param {object} ctx  same shape as navigateToMetadataDef's ctx, plus:
 *   notify  (message) => void — surface the "no schema to add to" case
 *           (defaults to the global alert when available)
 */
export function addUnknownSubNodeStub(tagName, ctx) {
  const {
    activeRelPath, folderNameOf, folders, layerByRelPath, modSchemaExtensions,
    getContent, setContent, openFile, scrollTo,
    scheduleScroll = (fn) => setTimeout(fn, 100),
    notify = (msg) => { try { globalThis.alert?.(msg); } catch (_) {} },
  } = ctx;

  if (!activeRelPath || !tagName) return;
  const folderName = folderNameOf(activeRelPath);
  const folder = folders.find((f) => f.name === folderName);
  if (!folder) return;

  let metaRelPath = folder.metadataRelPath;
  const activeLayer = layerByRelPath?.get(activeRelPath)?.layer;
  if (activeLayer && activeLayer.startsWith('mod_')) {
    const ext = (modSchemaExtensions || []).find(
      (e) => e.modLayer === activeLayer && e.folderName === folderName
    );
    if (ext) metaRelPath = ext.metadataRelPath;
  }
  if (!metaRelPath) {
    // The folder has data but no schema in any layer. Nowhere to add the
    // sub_node — bail. The user has to create a schema first (or, for a mod, a
    // partial-schema via the MODS sidebar).
    notify(`No schema file exists for ${folderName}. Create one before declaring sub-nodes.`);
    return;
  }

  openFile(metaRelPath, 'schema').then(() => {
    const metaContent = getContent(metaRelPath);
    if (!metaContent) return;

    // If a sub_node with this id already exists (maybe just not in the parsed
    // in-memory schema yet, e.g. mid-edit), jump to it rather than duplicating.
    const existingPattern = `<sub_node id="${tagName}"`;
    const existingIdx = metaContent.indexOf(existingPattern);
    if (existingIdx >= 0) {
      const line = metaContent.slice(0, existingIdx).split('\n').length;
      scrollTo({ file: metaRelPath, line, highlight: tagName });
      return;
    }

    const stub =
      `\t<sub_node id="${tagName}">\n` +
      `\t\t<!--FIELD_NEEDED: declare attributes for <${tagName}> here-->\n` +
      `\t</sub_node>\n`;

    // Insert just before </root>. If no </root> (unclosed mid-edit file),
    // append at end as a best-effort.
    const rootCloseIdx = metaContent.lastIndexOf('</root>');
    const insertPos = rootCloseIdx >= 0 ? rootCloseIdx : metaContent.length;
    const newContent = metaContent.slice(0, insertPos) + stub + metaContent.slice(insertPos);
    setContent(metaRelPath, newContent);

    const insertedLine = newContent.slice(0, insertPos).split('\n').length;
    scheduleScroll(() => {
      scrollTo({ file: metaRelPath, line: insertedLine, highlight: tagName });
    });
  });
}
