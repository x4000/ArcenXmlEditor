// Anthropic-API-backed grammar checker.
//
// Runs in the main process so the API key never crosses into the renderer's
// web context. Three concerns owned here:
//   1. Settings I/O (api key, model, enabled) at <settingsDir>/xmlEdGrammarLLM.json
//   2. Cache I/O (per-project) at <dataRoot>/_grammarLLMCache.json — sorted keys
//      and indented for source-control stability
//   3. Anthropic API client — batched requests, JSON-only response, parallelism
//      capped to a small constant so first runs don't trip rate limits

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Config / constants ────────────────────────────────────────────

const SETTINGS_FILENAME = 'xmlEdGrammarLLM.json';
const CACHE_FILENAME = '_grammarLLMCache.json';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Models — kept as a constant list so the renderer can populate the dropdown
// from the same source. Update when new models ship.
const SUPPORTED_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (better quality)' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7 (best quality, most expensive)' },
];
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Batch shape: how many strings per API call, and how many calls in flight.
// Smaller batches make iteration cheaper while we're tuning the prompt and
// shaking out bugs — each round-trip is faster, the model has less context
// to confuse it, and a bad response wastes only a small fraction of the run.
const BATCH_SIZE = 10;
const MAX_PARALLEL = 4;

const SYSTEM_PROMPT = `You are a grammar and clarity checker for game localization strings. Find errors that real players would notice — confusables (their/there, its/it's, your/you're, then/than), single-letter typos that produce a wrong-context valid word (e.g. "one earth" for "on earth"), nonsense or incomplete sentences, duplicate words / determiners / prepositions, subject-verb agreement issues, stray articles or prepositions.

Do NOT flag:
- Stylistic preferences ("could be more concise", "consider rephrasing")
- Spelling of unknown / proper / made-up words (a separate spellchecker handles those)
- {0}, {1}, {RClick} or similar placeholder markers (treat them as opaque)
- Capitalization in titles or all-caps shouts
- Game-specific terminology you don't recognize
- Em-dashes, ellipses, or smart quotes (handled separately)

Respond with JSON only, no prose, no markdown fences. Schema:
{ "results": [ { "id": "<the id from input>", "errors": [ { "quote": "<exact substring from the input>", "kind": "<one of: Confusable, Typo, Nonsense, Duplicate, Agreement, Article, Punctuation, Other>", "message": "<short explanation>", "fix": "<suggested replacement for the quote>" } ] } ] }

Every input id must appear in results, even if errors is []. The "quote" must match the input string verbatim — don't paraphrase or normalize.`;

// ─── Settings I/O ──────────────────────────────────────────────────

function getSettingsPath(settingsDir) {
  if (!settingsDir) return null;
  return path.join(settingsDir, SETTINGS_FILENAME);
}

function loadSettings(settingsDir) {
  const p = getSettingsPath(settingsDir);
  if (!p) return defaultSettings();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return {
        enabled: !!raw.enabled,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        model: SUPPORTED_MODELS.some((m) => m.id === raw.model) ? raw.model : DEFAULT_MODEL,
      };
    }
  } catch (e) {
    console.error('Failed to load grammar LLM settings:', e.message);
  }
  return defaultSettings();
}

function defaultSettings() {
  return { enabled: false, apiKey: '', model: DEFAULT_MODEL };
}

function saveSettings(settingsDir, settings) {
  const p = getSettingsPath(settingsDir);
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const sanitized = {
      enabled: !!settings.enabled,
      apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : '',
      model: SUPPORTED_MODELS.some((m) => m.id === settings.model) ? settings.model : DEFAULT_MODEL,
    };
    fs.writeFileSync(p, JSON.stringify(sanitized, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save grammar LLM settings:', e.message);
    return false;
  }
}

// ─── Cache I/O ─────────────────────────────────────────────────────

function getCachePath(dataRoot) {
  if (!dataRoot) return null;
  return path.join(dataRoot, CACHE_FILENAME);
}

// ─── Cache schema ──────────────────────────────────────────────────
//
// Per text-hash, we store one bucket of per-model results plus a shared
// dismissed list. Storing per-model means switching models doesn't blow
// away your prior cache: switch from Haiku to Sonnet, both keep their
// own results and the cheaper one is still available when you switch back.
//
//   { "<text-hash>": {
//       "results": {
//         "claude-haiku-4-5":  { "scannedAt": <ms>, "lints": [...] },
//         "claude-sonnet-4-6": { "scannedAt": <ms>, "lints": [...] }
//       },
//       "dismissed": ["<fingerprint>", ...]
//     },
//     ...
//   }
//
// The `dismissed` list is shared across models on purpose: a fingerprint is
// SHA-256(kind | quote | message), so cross-model dismissal only kicks in
// when two models produce IDENTICAL lints — which is exactly when the user
// wants the dismissal to apply once and stick.
//
// Older entries used a flat `{scannedAt, model, lints, dismissed}` shape.
// They're migrated transparently on load.

function isLegacyEntry(entry) {
  return entry
    && typeof entry === 'object'
    && !entry.results
    && (typeof entry.model === 'string' || Array.isArray(entry.lints));
}

function migrateLegacyEntry(entry) {
  const model = typeof entry.model === 'string' && entry.model ? entry.model : 'unknown';
  return {
    results: {
      [model]: {
        scannedAt: entry.scannedAt || 0,
        lints: Array.isArray(entry.lints) ? entry.lints : [],
      },
    },
    dismissed: Array.isArray(entry.dismissed) ? entry.dismissed : [],
  };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (isLegacyEntry(entry)) return migrateLegacyEntry(entry);
  // Already new-format — defend against partial corruption.
  const results = {};
  if (entry.results && typeof entry.results === 'object') {
    for (const [model, modelResult] of Object.entries(entry.results)) {
      if (!modelResult || typeof modelResult !== 'object') continue;
      results[model] = {
        scannedAt: modelResult.scannedAt || 0,
        lints: Array.isArray(modelResult.lints) ? modelResult.lints : [],
      };
    }
  }
  return {
    results,
    dismissed: Array.isArray(entry.dismissed) ? entry.dismissed : [],
  };
}

function loadCache(dataRoot) {
  const p = getCachePath(dataRoot);
  if (!p) return {};
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (!raw || typeof raw !== 'object') return {};
      const out = {};
      for (const [hash, entry] of Object.entries(raw)) {
        const normalized = normalizeEntry(entry);
        if (normalized) out[hash] = normalized;
      }
      return out;
    }
  } catch (e) {
    console.error('Failed to load grammar LLM cache:', e.message);
  }
  return {};
}

// Look up cached lints for a (text-hash, model) pair. Returns the lints
// array if present, or null when not yet scanned with that model.
function getCachedLintsForModel(entry, model) {
  if (!entry || !entry.results) return null;
  const r = entry.results[model];
  if (!r || !Array.isArray(r.lints)) return null;
  return r.lints;
}

// Stable JSON for git: top-level keys sorted, results' inner keys sorted by
// model id, dismissed array sorted. Lints keep insertion order from the API.
function stableStringify(cache) {
  const hashKeys = Object.keys(cache).sort();
  const out = {};
  for (const hash of hashKeys) {
    const entry = cache[hash];
    if (!entry) continue;
    const sortedResults = {};
    if (entry.results && typeof entry.results === 'object') {
      const modelKeys = Object.keys(entry.results).sort();
      for (const m of modelKeys) {
        const r = entry.results[m];
        if (!r) continue;
        sortedResults[m] = {
          scannedAt: r.scannedAt || 0,
          lints: Array.isArray(r.lints) ? r.lints : [],
        };
      }
    }
    out[hash] = {
      results: sortedResults,
      dismissed: Array.isArray(entry.dismissed) ? [...entry.dismissed].sort() : [],
    };
  }
  return JSON.stringify(out, null, 2);
}

function saveCache(dataRoot, cache) {
  const p = getCachePath(dataRoot);
  if (!p) return false;
  try {
    fs.writeFileSync(p, stableStringify(cache), 'utf-8');
    return true;
  } catch (e) {
    console.error('Failed to save grammar LLM cache:', e.message);
    return false;
  }
}

// ─── Hashing ───────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function lintFingerprint(lint) {
  return sha256(`${lint.kind || ''}|${lint.quote || ''}|${lint.message || ''}`);
}

// ─── Anthropic API client ──────────────────────────────────────────

async function callAnthropic({ apiKey, model, items }) {
  // items: [{ id, text }]. Returns parsed JSON: { results: [{id, errors: []}] }
  const userMessage = formatUserMessage(items);
  const body = {
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // Response shape: { content: [{ type: 'text', text: '...' }], ... }
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  // The model might include leading/trailing whitespace or stray code fences
  // despite our instructions. Strip fences if present, then JSON.parse.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Anthropic returned non-JSON content: ${cleaned.slice(0, 200)}`);
  }
}

function formatUserMessage(items) {
  const lines = ['Check the following game localization strings for grammar errors. Return JSON only.'];
  lines.push('');
  for (const item of items) {
    // Use the item's id (a SHA-256 hex prefix) as the JSON key. The text is
    // shown on its own line, surrounded by sentinel quotes the model is told
    // to strip (so it doesn't try to flag the quotes themselves as a problem).
    lines.push(`[${item.id}] ${JSON.stringify(item.text)}`);
  }
  return lines.join('\n');
}

// One-shot test: send a tiny prompt to verify the key + model. Returns
// { ok: true } on success or { ok: false, error: '...' } on failure.
async function testApi({ apiKey, model }) {
  if (!apiKey) return { ok: false, error: 'API key is empty.' };
  if (!model) return { ok: false, error: 'No model selected.' };
  try {
    await callAnthropic({
      apiKey,
      model,
      items: [{ id: 'test1', text: 'The quick brown fox jumps over the lazy dog.' }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// Main entry: given a list of { id, text } items, run them through the API
// in batches with parallelism. Returns Map<id, errors[]>.
async function checkBatch({ apiKey, model, items, onProgress }) {
  const results = new Map();
  if (items.length === 0) return results;

  // Split into batches of BATCH_SIZE
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  let nextBatchIdx = 0;
  let completedBatches = 0;

  async function worker() {
    while (true) {
      const myIdx = nextBatchIdx++;
      if (myIdx >= batches.length) return;
      const batch = batches[myIdx];
      try {
        const json = await callAnthropic({ apiKey, model, items: batch });
        const apiResults = Array.isArray(json.results) ? json.results : [];
        // Index results by id so out-of-order responses still match correctly.
        const byId = new Map();
        for (const r of apiResults) {
          if (r && r.id) byId.set(String(r.id), Array.isArray(r.errors) ? r.errors : []);
        }
        for (const item of batch) {
          results.set(item.id, byId.get(item.id) || []);
        }
      } catch (e) {
        // On any batch failure, mark every item in the batch with no errors
        // — better to return an empty result than to crash the whole pass.
        // Caller can detect partial failure by comparing input vs output count.
        console.error(`Grammar batch ${myIdx} failed:`, e.message);
        for (const item of batch) results.set(item.id, []);
      }
      completedBatches++;
      if (onProgress) onProgress(completedBatches, batches.length);
    }
  }

  const workers = [];
  const concurrency = Math.min(MAX_PARALLEL, batches.length);
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  loadSettings,
  saveSettings,
  loadCache,
  saveCache,
  getCachedLintsForModel,
  sha256,
  lintFingerprint,
  testApi,
  checkBatch,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
};
