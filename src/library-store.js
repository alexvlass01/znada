'use strict';

// Persistence for the photo pool. The pool used to live inside config.json, which
// is rewritten in full and synchronously on every settings change — fine for a
// hundred entries, ruinous once a watched folder's photos each get their own
// record. Measured on a real profile: config.json fell from 64.9 KB to 4.4 KB and
// stopped growing with the library, and adding one tag went from 22.3 ms to 2.7 ms.
//
// The pool now lives in its own file next to the folder index, with the same
// shape it always had ({ [id]: Item }), so nothing in main/renderer has to change
// how it reads the library. Only where the bytes land changed.
//
// No Electron dependency — paths are passed in — so this stays unit-testable.

const fs = require('fs');
const path = require('path');

const VERSION = 1;
const SUFFIX = '.library.json';

// The store sits beside its config and is NAMED AFTER IT: `config.json` gets
// `config.library.json`. A fixed name like `library.json` would be shorter, but two
// config files in one directory would then silently share a pool — and a planned
// settings backup/restore (DATA-001) does exactly that. Verified: with a shared
// name, loading one config merged in the other's items.
function storePathFor(configPath) {
  const raw = String(configPath || '');
  const dir = path.dirname(raw);
  const base = path.basename(raw).replace(/\.json$/i, '') || 'config';
  return path.join(dir, `${base}${SUFFIX}`);
}

function emptyStore() {
  return { version: VERSION, library: {}, trash: [] };
}

// Bounded so the file cannot grow without limit.
//
// What falling off the end MEANS matters, because the trash is also what keeps the
// wallpaper collector away from those files. An entry that is dropped loses that
// protection and its file returns to the normal orphan sweep — it ends up in
// wallpapers/.trash, still on disk, but no longer offered for one-click restore.
// That is only honest if the list the user sees is the same list that survives a
// restart, so `pushEntry` bounds on the way IN as well; otherwise the oldest entry
// would quietly stop being protected the next time the app started (BUG-008).
const TRASH_LIMIT = 500;

// One removed pool photo, kept so the user can put it back. `item` is the whole
// record (tags, favourite, author, source), because that is what they would
// otherwise have to retype.
function normalizeTrashEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw.item;
  if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path) return null;
  if (typeof item.id !== 'string' || !item.id) return null;
  const at = Number(raw.removedAt);
  const entry = { item, removedAt: Number.isFinite(at) && at > 0 ? at : Date.now() };
  // WHY it was removed, not just that it was. Empty means the user named this photo;
  // a folder path means it went with that folder. Putting the folder back may only
  // undo the second kind — otherwise restoring a folder silently reverses a separate
  // decision the user made about one photo inside it.
  if (typeof raw.via === 'string' && raw.via) entry.via = raw.via;
  // Which single user action this entry belongs to. Set by the removal that wrote it;
  // absent on entries from older builds, which are then treated as one-entry removals
  // so their bounding behaves exactly as it always did.
  if (typeof raw.group === 'string' && raw.group) entry.group = raw.group;
  // Where the photo was placed when it was taken away. Without this a restore put the
  // record back and left the monitor empty: the star and the tags returned, the
  // wallpaper did not. Undo could do it from a snapshot held in memory; after a restart
  // that snapshot is gone, so the placement has to travel with the entry itself.
  if (Array.isArray(raw.slots)) {
    const slots = [];
    for (const slot of raw.slots) {
      if (!slot || typeof slot.monitorId !== 'string' || !slot.monitorId) continue;
      if (slot.theme !== 'light' && slot.theme !== 'dark') continue;
      const index = Number(slot.index);
      slots.push({
        monitorId: slot.monitorId,
        theme: slot.theme,
        index: Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0,
        // Whether the slot was left empty by this removal, so a restore knows to lift
        // the "deliberately empty" marker instead of leaving a slot that plays nothing.
        emptied: slot.emptied === true,
      });
    }
    if (slots.length) entry.slots = slots;
  }
  return entry;
}

// Add a removal to the front and return the bounded list plus whatever it pushed
// out, so the caller can act on the eviction instead of discovering it after a
// restart. Pure: the caller owns the list.
function pushEntry(list, entry) {
  const candidate = normalizeTrashEntry(entry);
  if (!candidate) return { trash: boundedTrash(list), evicted: [] };
  const merged = boundedTrash([candidate, ...(Array.isArray(list) ? list : [])]);
  const kept = new Set(merged.map((e) => e.item.id));
  const evicted = boundedTrash([...(Array.isArray(list) ? list : [])])
    .filter((e) => !kept.has(e.item.id));
  return { trash: merged, evicted };
}

// Does the file still hold a library, or only something shaped like JSON?
//
// This is NOT the same question as "did it parse". A file can parse perfectly and
// still have lost its contents: {"library":"not-an-object"} is valid JSON. The old
// code asked only the parse question, so normalizeStore quietly coerced a wrecked
// container into an empty pool, load reported broken:false, and the next save wrote
// that emptiness over the file — with no backup, because nothing had gone "wrong".
// Structurally broken input must reach the SAME degraded path as unparseable input.
//
// Deliberately narrow: only the containers are judged. A single entry missing its
// path is normal wear and keeps being filtered out silently — that has always been
// tolerated and is not corruption. `version` is NOT judged either: it is unused
// today, and failing an unknown version would put a rollback from a future build
// into degraded mode. That is a separate decision, not this defect.
function validateStoreShape(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'store-not-an-object' };
  }
  // The pool is not optional. save() writes `library` on every path — emptyStore()
  // starts from {} and save() falls back to {} — so a file WITHOUT it, or with null
  // in its place, is not something this app has ever produced. The first cut of this
  // check tolerated both, which left the hole it was written to close: {} sailed
  // through as healthy. Worse, the test asserted that as correct and so locked it in.
  if (!('library' in raw) || raw.library === null
    || typeof raw.library !== 'object' || Array.isArray(raw.library)) {
    return { ok: false, reason: 'library-missing-or-not-an-object' };
  }
  // `trash` is different, and the difference is historical rather than stylistic: the
  // earliest store shape had no trash at all, so ABSENT stays acceptable. Present but
  // not an array — null included — is damage by the same argument as above.
  if ('trash' in raw && !Array.isArray(raw.trash)) {
    return { ok: false, reason: 'trash-not-an-array' };
  }
  return { ok: true, reason: '' };
}

// Damage the container check cannot see, because the container is fine.
//
// One record short of a path is ordinary wear and is filtered out silently — that
// has always been true and stays true. But there is no honest reading in which a
// library that declared records and kept NONE of them is the same event. That went
// through as healthy, read as empty, and the next save wrote the emptiness over the
// file: the same silent, final loss the container check was added to stop, one level
// further in. Partial loss is deliberately still tolerated: any threshold between
// "one" and "all" would be a number picked out of the air, whereas "not one record
// survived" is a difference in kind.
function describeStoreDamage(parsed, normalized) {
  const shape = validateStoreShape(parsed);
  if (!shape.ok) return shape;
  const declared = Object.keys(parsed.library).length;
  if (declared > 0 && Object.keys(normalized.library).length === 0) {
    return { ok: false, reason: 'no-record-survived' };
  }
  return { ok: true, reason: '' };
}

function normalizeStore(raw) {
  const out = emptyStore();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const lib = raw.library && typeof raw.library === 'object' && !Array.isArray(raw.library) ? raw.library : {};
  for (const [id, item] of Object.entries(lib)) {
    if (!id || !item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (typeof item.path !== 'string' || !item.path) continue;
    out.library[id] = item;
  }
  out.trash = boundedTrash(raw.trash);
  return out;
}

// Newest first, one entry per photo, bounded. Shared by load and save so the file and
// the in-memory list can never disagree about ordering or size.
//
// The bound applies to whole REMOVALS, never to part of one. A flat cut at 500 meant
// that removing a folder of 520 starred photos reported all 520 removed and kept 500:
// putting the folder back returned 500 photos and lost the stars and tags of the other
// 20 for good, with nothing on screen saying so. One removal is one user action, so it
// is remembered whole or not at all — which also means a single very large removal is
// allowed to exceed the limit rather than being silently truncated. Older removals are
// dropped whole to make room.
function boundedTrash(input) {
  const seen = new Set();
  const all = [];
  for (const candidate of (Array.isArray(input) ? input : [])) {
    const entry = normalizeTrashEntry(candidate);
    if (!entry) continue;
    all.push(entry);
  }
  all.sort((a, b) => b.removedAt - a.removedAt);
  const unique = all.filter((e) => {
    if (seen.has(e.item.id)) return false;   // a re-removed photo keeps its newest entry
    seen.add(e.item.id);
    return true;
  });

  // Entries carry the id of the removal that wrote them. Inferring it from the
  // timestamp instead would merge two separate removals that happened in the same
  // millisecond, and would split one removal that straddled a tick.
  const groupOf = (e) => (e.group ? `g:${e.group}` : `e:${e.removedAt}:${e.item.id}`);
  const out = [];
  let index = 0;
  while (index < unique.length) {
    const stamp = groupOf(unique[index]);
    let end = index;
    while (end < unique.length && groupOf(unique[end]) === stamp) end++;
    const group = unique.slice(index, end);
    // The newest removal is always kept whole, even when it alone is over the limit:
    // the user just did it, and it is the one they are most likely to undo.
    if (out.length && out.length + group.length > TRASH_LIMIT) break;
    out.push(...group);
    index = end;
  }
  return out;
}

// Which pool wins when both files carry one. The dedicated store is authoritative:
// it is what current builds write. Ids found only in the config copy are kept
// rather than dropped — an older build that was rolled back knows nothing about
// this file and would have written its own pool back into config.json.
function mergeLibraries(fromStore, fromConfig) {
  const merged = {};
  for (const [id, item] of Object.entries(fromConfig || {})) {
    if (id && item && typeof item === 'object') merged[id] = item;
  }
  for (const [id, item] of Object.entries(fromStore || {})) {
    if (id && item && typeof item === 'object') merged[id] = item;
  }
  return merged;
}

// Same rule as the pool: the store wins for entries present in both, but an entry the
// recovery path left inline is kept rather than dropped.
function mergeTrash(fromStore, fromConfig) {
  const merged = boundedTrash([...(Array.isArray(fromStore) ? fromStore : []),
    ...(Array.isArray(fromConfig) ? fromConfig : [])]);
  return merged;
}

// Never throws. Three outcomes, and they must stay distinct. Treating them all as "no store yet"
// meant a locked or unreadable file looked identical to a fresh profile: the app
// started with an empty pool and the next save would have written that emptiness over
// a perfectly good file.
//   * missing            -> existed:false            (nothing written yet)
//   * unparseable        -> broken:true + backup     (recoverable, fall back to inline)
//   * unreadable (EACCES,
//     EBUSY, EIO, …)     -> unreadable:true          (say nothing about the contents)
function load(configPath) {
  const file = storePathFor(configPath);
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { library: {}, trash: [], existed: false, broken: false, unreadable: false, newerVersion: false };
    console.error('library.json недоступен для чтения; пул берётся из config.json и НЕ перезаписывается:', err);
    return { library: {}, trash: [], existed: true, broken: false, unreadable: true, newerVersion: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`); } catch {}
    console.error('library.json не разбирается, бэкап сохранён; пул будет взят из config.json:', err);
    return { library: {}, trash: [], existed: true, broken: true, unreadable: false, newerVersion: false };
  }
  // A build newer than this one may have written fields we know nothing about, and
  // save() would drop every one of them while stamping the version back down. Reading
  // is safe; WRITING is what destroys the newer profile, so the caller is told and
  // blocks writes. Refusing to load instead would strand a rollback with no library.
  const newerVersion = Number(parsed && parsed.version) > VERSION;
  const store = normalizeStore(parsed);
  const damage = describeStoreDamage(parsed, store);
  if (!damage.ok) {
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`); } catch {}
    console.error(`library.json повреждён (${damage.reason}), бэкап сохранён; запись заблокирована.`);
    // Hand back whatever IS well formed. A store whose library is unusable must still
    // surrender the trash — those photos exist nowhere else — and the same holds the
    // other way round. The first cut of this check returned empty for both, which broke
    // that invariant while its unit test kept passing, because the test exercised
    // normalizeStore rather than the path the app actually takes.
    return { library: store.library, trash: store.trash, existed: true, broken: true, unreadable: false, newerVersion };
  }
  return { library: store.library, trash: store.trash, existed: true, broken: false, unreadable: false, newerVersion };
}

// Atomic write (tmp + rename) so a crash mid-write cannot truncate the pool.
// Returns false instead of throwing: a failed pool write must never take down a
// settings change that was already applied in memory.
function save(library, configPath, trash = []) {
  const file = storePathFor(configPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const bounded = boundedTrash(trash);
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, library: library || {}, trash: bounded }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('Не удалось сохранить library.json:', err);
    return false;
  }
}

// Debounced writer. Adding one tag used to cost a full config write; now it marks
// the pool dirty and a single write covers the whole burst. Timers are injected so
// tests drive this without waiting on wall-clock time.
function createWriter({
  configPath,
  delayMs = 1200,
  saveFn = save,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  let pending = null;   // the library object to write; null = nothing outstanding
  let writes = 0;
  let retries = 0;
  const MAX_RETRIES = 3;

  // A failed write KEEPS the pending version. Clearing it first meant a single
  // transient error (antivirus holding the file, a full disk that frees up a second
  // later) silently threw away the newest pool: nothing was pending any more, so the
  // retry never came and the quit-time flush had nothing to write.
  function write() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!pending) return false;
    const { library, trash } = pending;
    writes++;
    const okWrite = saveFn(library, configPath, trash);
    if (okWrite) { pending = null; retries = 0; return true; }
    // Bounded retry so a transient failure heals on its own instead of waiting for
    // the user's next edit. It stays pending either way, so quit-time flush still has it.
    if (retries < MAX_RETRIES) {
      retries++;
      timer = setTimer(() => { timer = null; write(); }, delayMs);
    }
    return false;
  }

  return {
    // Cheap: records that the pool changed and schedules one write for the burst.
    markDirty(library, trash) {
      pending = { library: library || {}, trash: Array.isArray(trash) ? trash : [] };
      retries = 0;
      if (timer) return;
      timer = setTimer(() => { timer = null; write(); }, delayMs);
    },
    // Durability points: quit, suspend, anything that must not lose the last edit.
    flush() { return write(); },
    isPending() { return pending !== null; },
    writeCount() { return writes; },
    retryCount() { return retries; },
    dispose() { if (timer) clearTimer(timer); timer = null; pending = null; },
  };
}

module.exports = {
  validateStoreShape,
  describeStoreDamage,
  VERSION, SUFFIX, TRASH_LIMIT, storePathFor, emptyStore, normalizeStore, normalizeTrashEntry,
  boundedTrash, pushEntry, mergeLibraries, mergeTrash, load, save, createWriter,
};
