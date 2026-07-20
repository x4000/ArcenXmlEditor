/**
 * Web Worker for validation + spelling.
 *
 * Runs in a separate thread so the UI never freezes.
 * Receives file contents, schemas, FK index, and dictionary data.
 * Returns validation errors (core checks + spelling).
 * Grammar checking is NOT done here (requires Electron IPC).
 */

// Web Workers lack DOMParser — polyfill with linkedom (full browser-like DOM API)
import { DOMParser } from 'linkedom';
self.DOMParser = DOMParser;

import { validateAll } from './validation';
import { findMisspelledWords, findMisspelledWordsInMetadata, asciifyHomoglyphs, spellingMessagePrefix } from './spellcheck';
import { buildMergedSchema } from './schemaParser';
import NSpell from 'nspell';

let cachedChecker = null;
let cachedDictHash = '';
let cachedDevWords = new Set(); // dev-only words — applied as an additional accept list in dev contexts

// Persistent file-content cache. The renderer now ships only deltas on each
// validate call (contentChanges / contentRemoved) instead of the full content
// map every tick, which used to cost ~300-500ms of main-thread structured-
// clone time on medium projects. The worker holds the authoritative copy
// across messages; validateAll sees `workerFileContents` rather than a
// fresh payload.
//
// A `fullContents` payload still works — it replaces the cache wholesale.
// That's used for the initial sync and explicit "refresh from disk" paths.
let workerFileContents = {};

// Build or reuse a spellchecker from dictionary data.
// If no dict data is passed, returns the cached checker (if any) — useful for
// spellcheck-only calls after a warmup has already initialized the dictionary.
function getSpellchecker(dictAff, dictDic, customWords, devWords) {
  // Always refresh the dev words set when provided — cheap and keeps it in sync
  if (devWords && Array.isArray(devWords)) {
    cachedDevWords = new Set(devWords);
  }

  if (!dictAff || !dictDic) return cachedChecker;

  // Simple cache: reuse if same dictionary data
  const hash = dictAff.length + ':' + dictDic.length + ':' + (customWords?.length || 0);
  if (cachedChecker && cachedDictHash === hash) return cachedChecker;

  const checker = new NSpell(dictAff, dictDic);
  if (customWords?.length) {
    for (const word of customWords) {
      checker.add(word);
    }
  }
  cachedChecker = checker;
  cachedDictHash = hash;
  return checker;
}

// Dev-aware correctness check. User-facing fields use only the regular dictionary;
// dev contexts ALSO consult the dev-only dictionary.
function makeCorrectFn(spellchecker) {
  return (word, isDev) => {
    if (spellchecker.correct(word)) return true;
    if (isDev && cachedDevWords.has(word)) return true;
    return false;
  };
}

// Reconstruct Set objects from serialized FK index
// (postMessage structured clone converts Sets to empty objects).
// Rebuilds the union sets AND each per-layer byLayer sub-entry so cross-layer
// validation has live Sets to test against.
function reconstructFKIndex(fkIndex) {
  if (!fkIndex) return fkIndex;
  const rebuilt = {};
  for (const [table, data] of Object.entries(fkIndex)) {
    const byLayer = {};
    if (data.byLayer) {
      for (const [layer, bl] of Object.entries(data.byLayer)) {
        byLayer[layer] = {
          ...bl,
          ids: new Set(bl.sorted || []),
          subIds: new Set(bl.subSorted || []),
        };
      }
    }
    rebuilt[table] = {
      ...data,
      ids: new Set(data.sorted || []),
      subIds: data.subSorted ? new Set(data.subSorted) : new Set(),
      byLayer,
    };
  }
  return rebuilt;
}

// Line-number helper for spelling-only path
function lineAt(content, pos) {
  let line = 1, p = 0;
  const lines = content.split('\n');
  for (const l of lines) {
    if (pos >= p && pos < p + l.length + 1) return line;
    p += l.length + 1; line++;
  }
  return line;
}

function buildContextSnippet(text, pos, len) {
  const CONTEXT_CHARS = 30;
  const start = Math.max(0, pos - CONTEXT_CHARS);
  const end = Math.min(text.length, pos + len + CONTEXT_CHARS);
  let before = text.slice(start, pos).replace(/[\r\n\t]+/g, ' ');
  const target = text.slice(pos, pos + len);
  let after = text.slice(pos + len, end).replace(/[\r\n\t]+/g, ' ');
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

self.onmessage = async function (e) {
  const {
    type, folders, allFileContents, schemas, sharedSchema, fkIndex, lookupSwaps,
    dictAff, dictDic, customWords, devWords, includeSpelling, structuralErrors,
    expansionDirNameToLayer, modFolderNameToLayer, modDisplayByLayer, modExtrasByLayer,
    schemaExtensions,
    // Incremental-sync fields (see workerFileContents comment above).
    fullContents, contentChanges, contentRemoved,
  } = e.data;

  if (type === 'warmup') {
    // Preload the spellchecker so subsequent spellcheck-only calls are fast
    try {
      getSpellchecker(dictAff, dictDic, customWords, devWords);
      self.postMessage({ type: 'warmup-done' });
    } catch (err) {
      console.error('Warmup error:', err);
      self.postMessage({ type: 'warmup-done' });
    }
    return;
  }

  if (type === 'update-dev-words') {
    // Incremental dev-word update without re-warming the full dictionary
    if (Array.isArray(devWords)) cachedDevWords = new Set(devWords);
    return;
  }

  if (type === 'add-custom-word') {
    // Dictionary additions are the hot path when triaging a large spelling
    // result set. Mutate the warmed checker instead of rebuilding Hunspell.
    if (cachedChecker && typeof e.data.word === 'string' && e.data.word) {
      cachedChecker.add(e.data.word);
    }
    return;
  }

  if (type === 'add-custom-words') {
    // File-header batch dictionary action. Deduplication happens before this
    // message, but Set keeps this path harmless if a caller repeats a word.
    if (cachedChecker && Array.isArray(e.data.words)) {
      for (const word of new Set(e.data.words)) {
        if (typeof word === 'string' && word) cachedChecker.add(word);
      }
    }
    return;
  }

  if (type === 'update-custom-words') {
    // User added/removed a global-dictionary word. The simplest correct fix is
    // to invalidate the cached checker so the next warmup/validate call rebuilds
    // it with the fresh custom words. If we have the dict data on hand, rebuild
    // immediately so the cache stays warm.
    if (Array.isArray(customWords) && dictAff && dictDic) {
      cachedChecker = null;
      cachedDictHash = '';
      getSpellchecker(dictAff, dictDic, customWords, devWords);
    } else {
      cachedChecker = null;
      cachedDictHash = '';
    }
    return;
  }

  if (type === 'validate') {
    try {
      // Apply the content sync. Three input shapes, in priority order:
      //   1. fullContents: replace cache entirely (used by manual revalidate)
      //   2. contentChanges / contentRemoved: apply as a delta
      //   3. allFileContents: legacy/fallback shape — treat as fullContents
      //      for callers that haven't been migrated to the delta protocol.
      if (fullContents) {
        workerFileContents = fullContents;
      } else if (contentChanges || contentRemoved) {
        if (contentChanges) {
          for (const [p, c] of Object.entries(contentChanges)) workerFileContents[p] = c;
        }
        if (contentRemoved) {
          for (const p of contentRemoved) delete workerFileContents[p];
        }
      } else if (allFileContents) {
        workerFileContents = allFileContents;
      }

      // Reconstruct Sets that were lost during postMessage serialization
      const rebuiltIndex = reconstructFKIndex(fkIndex);

      const opts = {
        structuralErrors: structuralErrors || [],
        expansionDirNameToLayer: expansionDirNameToLayer || {},
        modFolderNameToLayer: modFolderNameToLayer || {},
        modDisplayByLayer: modDisplayByLayer || {},
        modExtrasByLayer: modExtrasByLayer || {},
        schemaExtensions: schemaExtensions || {},
      };
      if (includeSpelling) {
        const spellchecker = getSpellchecker(dictAff, dictDic, customWords, devWords);
        if (spellchecker) { opts.spellchecker = spellchecker; opts.runFullSpellingPass = true; }
      }
      const errors = await validateAll(folders, workerFileContents, schemas, sharedSchema, rebuiltIndex, lookupSwaps, opts);
      self.postMessage({ type: 'results', errors });
    } catch (err) {
      console.error('Validation worker error:', err);
      self.postMessage({ type: 'results', errors: [] });
    }
  } else if (type === 'spellcheck-only') {
    // Fast path: only run spelling, skip core validation entirely.
    // Used by the parallel spellcheck to avoid redoing core work per worker.
    try {
      const spellchecker = getSpellchecker(dictAff, dictDic, customWords, devWords);
      if (!spellchecker) {
        self.postMessage({ type: 'results', errors: [] });
        return;
      }

      const errors = [];
      const correct = makeCorrectFn(spellchecker);
      // Suggestions are NOT computed during scan — suggest() is extremely slow (~35ms/call)
      // and we only need suggestions when the user actually right-clicks a misspelling.
      // Suggestions are fetched lazily via IPC from the validation window / inline editor.

      for (const folder of folders) {
        const schema = schemas[folder.name];
        if (!schema || schema.neverValidate) continue;
        const merged = buildMergedSchema(sharedSchema, schema);
        if (!merged) continue;

        for (const xmlFile of folder.xmlFiles) {
          const content = allFileContents[xmlFile.relativePath];
          if (!content) continue;
          const misspelled = findMisspelledWords(content, merged, correct, null);
          for (const m of misspelled) {
            const snippet = buildContextSnippet(content, m.absPos, m.word.length);
            let msg = spellingMessagePrefix(m);
            if (m.mixedScript) {
              const ascii = asciifyHomoglyphs(m.word);
              if (ascii && ascii !== m.word) msg += `. Did you mean: ${ascii}?`;
            } else if (m.suggestions && m.suggestions.length > 0) {
              msg += `. Did you mean: ${m.suggestions.join(', ')}?`;
            }
            if (snippet) msg += ` — ...${snippet}...`;
            // Forbidden-char entries already carry their ASCII fix in m.suggestions.
            // Mixed-script entries get the asciified form computed above (added to
            // the message text). Regular misspellings have no suggestions at this
            // stage — they're fetched lazily on right-click via IPC.
            const sugsForEntry = m.forbiddenChar ? (m.suggestions || []) : [];
            errors.push({
              severity: 'warning',
              file: xmlFile.relativePath,
              line: lineAt(content, m.absPos),
              message: msg,
              isDev: m.isDev,
              // Exact character position in the file — used by the click-to-navigate
              // code to highlight THIS occurrence of the word, not the first occurrence
              // on the line (e.g. when the word appears in both `id=` and `display_name=`).
              absPos: m.absPos,
              forbiddenChar: !!m.forbiddenChar,
              suggestions: sugsForEntry,
            });
          }
        }

        // Metadata tooltips
        const metaPath = folder.metadataRelPath;
        const metaContent = allFileContents[metaPath];
        if (metaContent) {
          const misspelled = findMisspelledWordsInMetadata(metaContent, correct, null);
          for (const m of misspelled) {
            const snippet = buildContextSnippet(metaContent, m.absPos, m.word.length);
            let msg = spellingMessagePrefix(m);
            if (m.mixedScript) {
              const ascii = asciifyHomoglyphs(m.word);
              if (ascii && ascii !== m.word) msg += `. Did you mean: ${ascii}?`;
            } else if (m.suggestions && m.suggestions.length > 0) {
              msg += `. Did you mean: ${m.suggestions.join(', ')}?`;
            }
            if (snippet) msg += ` — ...${snippet}...`;
            const sugsForEntry = m.forbiddenChar ? (m.suggestions || []) : [];
            errors.push({
              severity: 'warning',
              file: metaPath,
              line: lineAt(metaContent, m.absPos),
              message: msg,
              isDev: m.isDev,
              absPos: m.absPos,
              forbiddenChar: !!m.forbiddenChar,
              suggestions: sugsForEntry,
            });
          }
        }
      }

      self.postMessage({ type: 'results', errors });
    } catch (err) {
      console.error('Spellcheck worker error:', err);
      self.postMessage({ type: 'results', errors: [] });
    }
  }
};
