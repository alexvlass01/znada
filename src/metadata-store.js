'use strict';

// Persistence for everything META-001 learns but the user never typed: file
// fingerprints, and the journal of questions already asked about them.
//
// This is deliberately NOT the library store. Tags, author, source and rating end up in
// `config.library.json` under the revision discipline that protects user data, because
// once they are on a photo the user owns them — he can edit them, and a merge must not
// lose his version. What lives here is only the derived half:
//
//   files   pathKey -> { size, mtimeMs, values } — what hashing this file produced,
//           and the evidence that lets us skip re-hashing it.
//   lookups md5:<hash> -> { result, providers } — what each catalogue answered.
//
// Losing this file costs re-hashing and, worse, re-asking; it never costs user data.
// That is why it heals by starting empty instead of the elaborate recovery
// `library-store.js` performs: there is nothing here that exists nowhere else.
//
// The journal is keyed by the fingerprint rather than by photo id on purpose. The same
// bytes in two folders are one question. That property is what keeps a future mass run
// from asking a catalogue the same thing hundreds of times.
//
// No Electron dependency — paths are passed in — so this stays unit-testable.

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const SUFFIX = '.metadata.json';

// Bounds, so a cache cannot grow without limit on a machine with a huge library.
// Eviction is by age of last touch, which for the journal means the oldest ANSWER —
// evicting it only costs one repeated question much later, never a wrong one.
const FILE_LIMIT = 20000;
const LOOKUP_LIMIT = 20000;

// Named after its config, exactly like the library store, so two profiles in one
// directory cannot silently share a cache.
function storePathFor(configPath) {
  const raw = String(configPath || '');
  const dir = path.dirname(raw);
  const base = path.basename(raw).replace(/\.json$/i, '') || 'config';
  return path.join(dir, base + SUFFIX);
}

function emptyStore() {
  return { version: VERSION, files: {}, lookups: {} };
}

function touchStamp(raw, fallback) {
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 ? at : fallback;
}

// Keep the newest `limit` entries by last touch. Object key order is insertion order,
// which is not the order we care about, so the age is stored explicitly rather than
// inferred from position.
function boundMap(map, limit, now) {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  const ranked = keys
    .map((key) => ({ key, at: touchStamp(map[key] && map[key].at, now) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
  const out = {};
  for (const entry of ranked) out[entry.key] = map[entry.key];
  return out;
}

function normalizeStore(raw, now) {
  const at = Number(now) || Date.now();
  const store = emptyStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  for (const name of ['files', 'lookups']) {
    const source = raw[name];
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const key of Object.keys(source)) {
      const value = source[key];
      if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      store[name][key] = value;
    }
  }
  store.files = boundMap(store.files, FILE_LIMIT, at);
  store.lookups = boundMap(store.lookups, LOOKUP_LIMIT, at);
  return store;
}

// Fail-open by design: an unreadable or unparseable cache is simply absent. The only
// cost is doing the work again, and refusing to start would turn a corrupted cache into
// a broken feature.
function load(configPath, now) {
  const file = storePathFor(configPath);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') console.error('metadata.json недоступен, кеш начинается пустым:', err);
    return emptyStore();
  }
  try {
    // One UTF-8 BOM tolerated on read; the app itself always writes without one.
    return normalizeStore(JSON.parse(raw.replace(/^\uFEFF/, '')), now);
  } catch (err) {
    console.error('metadata.json не разбирается, кеш начинается пустым:', err);
    return emptyStore();
  }
}

// Atomic write (tmp + rename). Returns false rather than throwing: a cache that failed
// to persist must never take down the lookup that already succeeded in memory.
function save(store, configPath, now) {
  const file = storePathFor(configPath);
  const at = Number(now) || Date.now();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const clean = normalizeStore(store, at);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('Не удалось сохранить metadata.json:', err);
    return false;
  }
}

// Debounced writer, same shape as the library one: a burst of lookups produces a single
// write, and timers are injected so tests never wait on wall-clock time.
function createWriter(opts) {
  const o = opts || {};
  const configPath = o.configPath;
  const delayMs = Number.isFinite(o.delayMs) ? o.delayMs : 1500;
  const saveFn = o.saveFn || save;
  const setTimer = o.setTimer || setTimeout;
  const clearTimer = o.clearTimer || clearTimeout;
  let timer = null;
  let pending = null;
  let writes = 0;

  function write() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!pending) return false;
    writes++;
    // Unlike the library writer there is no retry ladder here. A lost cache write is
    // re-derivable work, and keeping a stale copy pending would only delay the next
    // real write for something nobody would miss.
    const ok = saveFn(pending, configPath);
    pending = null;
    return ok;
  }

  return {
    markDirty(store) {
      pending = store || emptyStore();
      if (timer) return;
      timer = setTimer(() => { timer = null; write(); }, delayMs);
    },
    flush() { return write(); },
    isPending() { return pending !== null; },
    writeCount() { return writes; },
    dispose() { if (timer) clearTimer(timer); timer = null; pending = null; },
  };
}

module.exports = {
  VERSION,
  SUFFIX,
  FILE_LIMIT,
  LOOKUP_LIMIT,
  storePathFor,
  emptyStore,
  normalizeStore,
  boundMap,
  load,
  save,
  createWriter,
};
