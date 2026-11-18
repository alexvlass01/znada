'use strict';

// LIB-030. The shared background pass over the library, and the checks that run on it.
//
// Direction from the owner (2026-11-02): eventually the whole library is checked by
// itself — identical files, "you already have this" in Online, source and tags, and more
// later. So there is ONE pass that knows every file and its fingerprint, and a check is a
// consumer of that pass, never a walk of the library of its own. The first and so far
// only check is identical files (src/duplicate-files.js).
//
// What the pass promises:
//   * it never touches the network, and never changes a file or a library record;
//   * a file is fingerprinted once, and again only when its size or modified time
//     changed. The fingerprint cache belongs to src/metadata-lookup-service.js — this is
//     a second caller of it, not a second cache;
//   * one file at a time with a breath in between, and it stands aside for a game or a
//     fullscreen app and for a move of Znada's own folder (`isBusy`);
//   * a restart carries on where it stopped: whatever was fingerprinted is in the cache.
//
// Owns: its state file (what was found, what the user has already been told) and the
// pass timer. Does not own: which files the library holds (`listFiles`), fingerprints
// (`fingerprint`), whether now is a bad moment (`isBusy`), whether the check is switched
// on (`isEnabled`) or how the window hears about it (`onChange`).
//
// LIB-031. The second consumer: "this Online card is a file you already have". For that
// the pass fingerprints EVERY photo, not only the ones that share a size, and keeps in
// memory which fingerprint and size belong to which file (`finder()`). It has no switch
// of its own (owner, 2026-11-08), so the pass now runs whatever the identical-files switch
// says; that switch only decides whether identical files are looked for and announced.
// Order: files that share a size first (the identical-files answer is ready as soon as
// before), then every other photo. Videos are read only as identical-file candidates.

const fs = require('fs');
const path = require('path');
const { pathKey } = require('./path-key');
const duplicateFiles = require('./duplicate-files');

const SUFFIX = '.checks.json';
// After a library change. A burst of changes — a folder scan, a batch removal — is one
// pass, and a pass already waiting is not pushed back by the next change: a library that
// changes every few seconds must still get checked.
const SETTLE_MS = 15000;
const SWITCHED_ON_MS = 2000;
const BUSY_RETRY_MS = 60000;
// Asking "is a game running" goes to the wallpaper host; once per file would be needless.
const BUSY_CHECK_MS = 10000;
// The breath between two files that had to be read from disk.
const GAP_MS = 20;
const STAT_CONCURRENCY = 8;
// LIB-031. How often, at most, the window is told that what the library holds may have
// changed: the first full read finds thousands of fingerprints in a few minutes, and one
// re-ask of the Online cards per few seconds is plenty.
const HAVE_NOTICE_MS = 3000;

// Named after its config, like the library and metadata stores, so two profiles in one
// directory cannot share it.
function storePathFor(configPath) {
  const raw = String(configPath || '');
  const base = path.basename(raw).replace(/\.json$/i, '') || 'config';
  return path.join(path.dirname(raw), base + SUFFIX);
}

// Fail-open: an unreadable file is an empty one. The cost is one pass and, at worst, one
// repeated notification.
function load(file, logger = console) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') logger.error('checks.json недоступен, начинаем с пустого:', err);
    return duplicateFiles.emptyState();
  }
  try {
    return duplicateFiles.normalizeState(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch (err) {
    logger.error('checks.json не разбирается, начинаем с пустого:', err);
    return duplicateFiles.emptyState();
  }
}

// Atomic (tmp + rename), and false instead of a throw: a state that failed to persist
// must not take down the pass that produced it.
function save(file, state, logger = console) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(duplicateFiles.normalizeState(state)), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.error('Не удалось сохранить checks.json:', err);
    return false;
  }
}

/**
 * @param {{
 *   configPath: string,
 *   isEnabled: () => boolean,
 *   listFiles: () => Array<{ path: string, size?: number, video?: boolean, watched?: boolean }>,
 *   fingerprint: (path: string) => Promise<{ value?: string, cached?: boolean, error?: string }>,
 *   cachedFingerprint?: (path: string) => Promise<string>,
 *   isBusy: () => Promise<boolean> | boolean,
 *   onChange?: (summary: any) => void,
 *   onHaveChange?: () => void,
 *   stat?: (path: string) => Promise<{ size: number, mtimeMs?: number, isFile: () => boolean }>,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   now?: () => number,
 *   logger?: { error: Function },
 *   delays?: { settleMs?: number, switchedOnMs?: number, busyRetryMs?: number, busyCheckMs?: number, gapMs?: number, haveNoticeMs?: number },
 * }} deps
 */
function createLibraryChecks(deps) {
  const {
    configPath, isEnabled, listFiles, fingerprint, isBusy,
    cachedFingerprint = null,
    onChange = () => {},
    onHaveChange = null,
    stat = (p) => fs.promises.stat(p),
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    logger = console,
    delays = {},
  } = deps;
  const delay = (name, fallback) => (Number.isFinite(delays[name]) ? delays[name] : fallback);
  const settleMs = delay('settleMs', SETTLE_MS);
  const switchedOnMs = delay('switchedOnMs', SWITCHED_ON_MS);
  const busyRetryMs = delay('busyRetryMs', BUSY_RETRY_MS);
  const busyCheckMs = delay('busyCheckMs', BUSY_CHECK_MS);
  const gapMs = delay('gapMs', GAP_MS);
  const haveNoticeMs = delay('haveNoticeMs', HAVE_NOTICE_MS);
  const file = storePathFor(configPath);

  let state = null;
  let timer = null;
  // Nothing runs before the app is up: main calls start() once the window and the folder
  // scan have been set going. Library changes before that schedule nothing.
  let started = false;
  let running = false;
  let again = false;
  // Bumped to abandon a pass in flight (switched off, disposed): the loop checks it
  // between files and throws its partial result away.
  let generation = 0;
  let passes = 0;
  /** @type {Promise<void>} */
  let recalling = Promise.resolve();
  // True while the identical-files part of a pass runs: that is what Settings shows as
  // "checking". The read of every other photo after it is not that check's business.
  let duplicatesRunning = false;

  // LIB-031. What the passes learned, by path key: the file's path as the library spells
  // it, its size and its fingerprint. In memory only — the fingerprints themselves live in
  // META-001's cache, and recall() rebuilds this from that cache right after launch: the
  // pass waits a minute, and until the cards know, a photo the user has shows "+".
  const known = new Map();
  const keysByHash = new Map();
  let haveTimer = null;
  let lastHaveAt = -Infinity;

  function current() {
    if (!state) state = load(file, logger);
    return state;
  }

  function persist() { return save(file, current(), logger); }

  function enabled() {
    try { return isEnabled() === true; } catch { return false; }
  }

  function inventory() {
    try {
      const files = listFiles();
      return Array.isArray(files) ? files : [];
    } catch (err) {
      logger.error('library checks: список файлов недоступен:', err);
      return [];
    }
  }

  function keysOf(files) {
    const keys = new Set();
    for (const f of files) if (f && typeof f.path === 'string' && f.path) keys.add(pathKey(f.path));
    return keys;
  }

  // Found groups as the library stands right now — see duplicateFiles.presentGroups.
  function liveGroups() {
    return duplicateFiles.presentGroups(current().groups, keysOf(inventory()));
  }

  function summary() {
    const on = enabled();
    const groups = on ? liveGroups() : [];
    return {
      enabled: on,
      running: on && duplicatesRunning,
      checked: current().checkedAt > 0,
      copies: duplicateFiles.extraCopies(groups),
      groups: groups.length,
      fresh: on ? duplicateFiles.freshCopies(groups, current().announced) : 0,
    };
  }

  function notify() {
    try { onChange(summary()); } catch (err) { logger.error('library checks: onChange:', err); }
  }

  // LIB-031. The window re-asks its Online cards after this. Only with a listener: the
  // unit tests count the timers waiting, and a notice nobody hears needs no timer.
  function haveChanged() {
    if (typeof onHaveChange !== 'function' || haveTimer) return;
    const waitMs = Math.max(0, lastHaveAt + haveNoticeMs - now());
    haveTimer = timers.setTimeout(() => {
      haveTimer = null;
      lastHaveAt = now();
      try { onHaveChange(); } catch (err) { logger.error('library checks: onHaveChange:', err); }
    }, waitMs);
    if (haveTimer && typeof haveTimer.unref === 'function') haveTimer.unref();
  }

  // A library change. The pass runs whatever the identical-files switch says: LIB-031 has
  // no switch and needs every fingerprint. What the library shows changed, so the Online
  // cards are re-asked too — a photo removed a moment ago is no longer "already yours".
  function schedule(delayMs = settleMs) {
    haveChanged();
    if (!started) return false;
    if (running) { again = true; return true; }
    if (timer) return true;
    timer = timers.setTimeout(() => { timer = null; void run(); }, Math.max(0, Number(delayMs) || 0));
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function cancel() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (haveTimer) timers.clearTimeout(haveTimer);
    haveTimer = null;
    again = false;
    generation += 1;
  }

  // Opens the gate; with a delay, also schedules the first pass.
  function start(delayMs) {
    started = true;
    recalling = recall();
    return Number.isFinite(delayMs) ? schedule(delayMs) : false;
  }

  // The switch in Settings moved. On: look soon. Off: identical files are neither looked
  // for nor announced any more (summary() and duplicates() answer empty at once), but the
  // pass itself goes on — LIB-031 needs its fingerprints and has no switch.
  function settingsChanged() {
    if (enabled()) schedule(switchedOnMs);
    notify();
  }

  // Watch-folder index sizes are hints until the background pass measures the file.
  async function withSizes(files) {
    const out = [];
    const missing = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !f.path) continue;
      const size = Number(f.size);
      if (!f.watched && Number.isFinite(size) && size > 0) out.push({ path: f.path, size, video: f.video === true, mtimeMs: undefined });
      else missing.push(f);
    }
    for (let i = 0; i < missing.length; i += STAT_CONCURRENCY) {
      await Promise.all(missing.slice(i, i + STAT_CONCURRENCY).map(async (f) => {
        try {
          const st = await stat(f.path);
          if (st && (typeof st.isFile !== 'function' || st.isFile()) && st.size > 0) {
            out.push({ path: f.path, size: st.size, video: f.video === true, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }));
    }
    return out;
  }

  async function busyNow() {
    try { return (await isBusy()) === true; } catch { return false; }
  }

  function wait(ms) {
    return new Promise((resolve) => { timers.setTimeout(resolve, ms); });
  }

  // LIB-031. Notes what a file's fingerprint is. True when that is news.
  function remember(item, hash) {
    const value = String(hash || '').trim().toLowerCase();
    const before = known.get(item.key);
    if (before && before.hash === value && before.path === item.path && before.size === item.size
      && before.mtimeMs === item.mtimeMs) return false;
    if (before && before.hash && before.hash !== value) forgetHash(item.key, before.hash);
    known.set(item.key, { path: item.path, size: item.size, mtimeMs: item.mtimeMs, hash: value });
    if (value) {
      const set = keysByHash.get(value) || new Set();
      set.add(item.key);
      keysByHash.set(value, set);
    }
    return true;
  }

  function forgetHash(key, hash) {
    const set = keysByHash.get(hash);
    if (!set) return;
    set.delete(key);
    if (!set.size) keysByHash.delete(hash);
  }

  // The size is what a site without a fingerprint is matched by: kept current even before
  // the file is read.
  function noteSize(f) {
    const was = known.get(f.key);
    if (was && was.size === f.size && was.path === f.path && was.mtimeMs === f.mtimeMs) return false;
    // A replacement no longer has the old fingerprint, even if its new one cannot be read.
    remember(f, '');
    return Boolean(was);
  }

  // LIB-031. Right after launch: what the fingerprint cache already knows about the library,
  // for a stat per file and no read of any file. Not a pass: nothing is hashed or stored,
  // and a file the cache does not know simply waits for the pass.
  async function recall() {
    if (typeof cachedFingerprint !== 'function') return;
    const gen = generation;
    const live = () => gen === generation;
    try {
      if (await busyNow()) return;
      const sized = (await withSizes(inventory())).filter((f) => !f.video);
      let learned = false;
      for (let i = 0; i < sized.length && live(); i += STAT_CONCURRENCY) {
        await Promise.all(sized.slice(i, i + STAT_CONCURRENCY).map(async (f) => {
          const hash = await cachedFingerprint(f.path);
          if (!live()) return;
          const item = { ...f, key: pathKey(f.path) };
          if (noteSize(item)) learned = true;
          if (hash && remember(item, hash)) learned = true;
        }));
      }
      if (learned && live()) haveChanged();
    } catch (err) {
      logger.error('library checks: отпечатки из кеша:', err);
    }
  }

  // After a complete pass: files the library no longer holds are forgotten.
  function prune(keys) {
    let changed = false;
    for (const [key, entry] of known) {
      if (keys.has(key)) continue;
      known.delete(key);
      if (entry.hash) forgetHash(key, entry.hash);
      changed = true;
    }
    return changed;
  }

  async function run() {
    if (running) return;
    running = true;
    const gen = ++generation;
    let busy = false;
    let lastBusyAt = -Infinity;
    const live = () => gen === generation;

    // Reads one list of files. False when the pass has to stop: abandoned, or a game.
    async function readAll(list, entries) {
      for (const item of list) {
        if (!live()) return false;
        if (now() - lastBusyAt >= busyCheckMs) {
          lastBusyAt = now();
          if (await busyNow()) { busy = true; return false; }
        }
        let print = null;
        try { print = await fingerprint(item.path); } catch (err) { logger.error('library checks: отпечаток:', err); }
        const hash = print && typeof print.value === 'string' ? print.value : '';
        if (hash) {
          if (entries) entries.push({ ...item, hash });
          if (remember(item, hash)) haveChanged();
        }
        if (print && !print.cached && gapMs > 0) await wait(gapMs);
      }
      return live();
    }

    notify();
    try {
      const sized = await withSizes(inventory());
      const keys = new Set();
      for (const f of sized) {
        f.key = pathKey(f.path);
        keys.add(f.key);
        if (noteSize(f)) haveChanged();
      }

      // Identical files first, exactly as before LIB-031: their answer is ready as soon.
      if (enabled()) {
        duplicatesRunning = true;
        notify();
        const entries = [];
        if (!(await readAll(duplicateFiles.candidates(sized), entries))) return;
        duplicatesRunning = false;
        // Switched off while the files were being read: nothing to look for, nothing kept.
        if (enabled()) {
          const s = current();
          s.groups = duplicateFiles.groupsOf(entries);
          s.checkedAt = now();
          passes += 1;
          persist();
        }
        notify();
      }

      // LIB-031. Every photo, so an Online card can recognise any file the user has. A file
      // read a moment ago is in the fingerprint cache and costs a stat. Smaller files
      // first: more of the library is covered sooner on the first, long read.
      const seen = new Set();
      const rest = [];
      for (const f of sized) {
        if (f.video || seen.has(f.key)) continue;
        seen.add(f.key);
        rest.push(f);
      }
      rest.sort((a, b) => (a.size - b.size) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (!(await readAll(rest, null))) return;
      if (prune(keys)) haveChanged();
    } catch (err) {
      logger.error('library checks: проход прерван:', err);
    } finally {
      running = false;
      duplicatesRunning = false;
      if (gen === generation) {
        // A game is still a game in a minute; anything that changed meanwhile is covered
        // by the same pass.
        if (busy) { again = false; schedule(busyRetryMs); }
        else if (again) { again = false; schedule(settleMs); }
      }
      notify();
    }
  }

  // LIB-031. What the library holds right now, by fingerprint and by size. Built once per
  // question from the current file list, so a photo removed a moment ago is not offered
  // even before the next pass, and the path given is the one the library shows.
  function finder() {
    const present = new Map();
    for (const f of inventory()) {
      if (!f || typeof f.path !== 'string' || !f.path || f.video === true) continue;
      const key = pathKey(f.path);
      if (!present.has(key)) present.set(key, f);
    }
    let bySizeIndex = null;
    return {
      byHash(hash) {
        const set = keysByHash.get(String(hash || '').trim().toLowerCase());
        if (!set) return '';
        for (const key of set) {
          const f = present.get(key);
          if (f) return f.path;
        }
        return '';
      },
      bySize(size) {
        if (!bySizeIndex) {
          bySizeIndex = new Map();
          for (const [key, f] of present) {
            const own = Number(f.size);
            const was = known.get(key);
            const n = f.watched && was ? was.size : (Number.isFinite(own) && own > 0 ? own : (was ? was.size : 0));
            if (!n) continue;
            const list = bySizeIndex.get(n) || [];
            list.push(f.path);
            bySizeIndex.set(n, list);
          }
        }
        return (bySizeIndex.get(Number(size)) || []).slice();
      },
    };
  }

  // The window showed the notification: every copy found so far counts as announced.
  function acknowledge() {
    const s = current();
    s.announced = duplicateFiles.announce(liveGroups(), s.announced);
    persist();
    notify();
    return summary();
  }

  // The groups for the Library view, largest first, files that left the library dropped.
  function duplicates() {
    if (!enabled()) return [];
    return liveGroups().map((group) => ({ size: group.size, paths: group.files.map((f) => f.path) }));
  }

  function dispose() {
    cancel();
  }

  return Object.freeze({
    start,
    schedule,
    settingsChanged,
    summary,
    duplicates,
    finder,
    acknowledge,
    dispose,
    // For main's test hooks only.
    runNow: run,
    passCount: () => passes,
    // The recall start() began; it never rejects. Tests wait on this instead of a timer.
    recalled: () => recalling,
    isScheduled: () => !!timer,
    statePath: () => file,
  });
}

module.exports = {
  SUFFIX,
  SETTLE_MS,
  BUSY_RETRY_MS,
  HAVE_NOTICE_MS,
  storePathFor,
  load,
  save,
  createLibraryChecks,
};
