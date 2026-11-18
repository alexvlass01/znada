'use strict';

// CODE-001 2.1a. The one owner of WRITING config.json and the pool file, and of the two
// "do not write" modes. main.js still holds the config object itself and hands it in
// through getConfig/setConfig (CODE-001 stage 2 specification, R2): what
// moved here is everything that decides whether a file is written and in what order.
// The flags and the batched pool writer are instance state, so nothing outside this
// module can flip a mode or walk past the door. No Electron here.

/**
 * @param {{
 *   configPath: string,
 *   configMod: { load: (path: string, options?: { restore?: any }) => any, save: (config: any, path: string, options?: { skipLibrary?: boolean, keepInline?: boolean }) => boolean },
 *   libraryStore: {
 *     createWriter: (options: { configPath: string, onWriteFailure?: () => void }) => { markDirty: (library: any, trash: any) => void, flush: () => boolean, isPending: () => boolean, dispose: () => void },
 *     save: (library: any, configPath: string, trash: any) => boolean,
 *   },
 *   poolConsistency: { repairDanglingSlots: (monitors: any, library: any) => number },
 *   normalizeOnlineSources: (sources: any) => any,
 *   getConfig: () => any,
 *   setConfig: (config: any) => void,
 *   onLoaded: () => void,
 *   broadcast: () => void,
 *   notify: (channel: string, messageKey: string, options: { titleKey: string, bodyKey: string }) => void,
 *   randomId: () => string,
 *   restore?: ((kind: string) => ({ text: string, takenAt: number } | null)) | null,
 *   reportRestored?: (kind: string, takenAt: number) => void,
 *   log?: { error: (...args: any[]) => void },
 * }} dependencies
 */
function createConfigStore({
  configPath, configMod, libraryStore, poolConsistency, normalizeOnlineSources,
  getConfig, setConfig, onLoaded, broadcast, notify, randomId,
  restore = null, reportRestored = () => {}, log = console,
}) {
  // Set when the pool file could not be read at startup: every write is suppressed so a
  // temporary access problem cannot be turned into an empty library on disk.
  let libraryUnsafeToWrite = false;
  // DATA-001. Set when this session's settings or library came from a last good copy.
  // The copy is a few hours older than the damaged file, so own-copies added since then
  // have no record any more; the collector would read them as orphans and move them to
  // wallpapers/.trash. Holding it for the session keeps them where they are until a
  // restart, which is what a person who looks for them first will expect.
  let restoredThisSession = false;
  // BUG-023. The same rule for config.json. A read failure is not an empty profile: the
  // app runs on defaults for this session and writes nothing over the file it could not
  // read, so a locked file or a bad sector cannot become "your settings are gone".
  let configUnsafeToWrite = false;
  let slideshowPositionDirty = false;

  // The photo pool has its own file and its own batched writer (see
  // src/library-store.js). Settings stay on the immediate path — they are small and
  // the user expects them saved at once — while pool edits coalesce, so adding tags
  // to a folder full of photos no longer means one full rewrite per tag.
  const libraryWriter = libraryStore.createWriter({
    configPath,
    onWriteFailure: () => enterLibraryWriteDegradedMode(),
  });

  // One channel for the pool file: to the user it is either usable or not, and the two
  // ways it breaks differ only in what they can do about it, which is what the
  // notification body says. There is no matching "working again" line — the file is read
  // once per start and the notifier's state does not survive a restart, so a recovery
  // would have to be invented rather than observed.
  function reportLibraryStoreProblem(kind) {
    notify('library-store', 'journal.libraryStore', {
      titleKey: 'notify.libraryStoreFailedTitle',
      bodyKey: kind === 'broken' ? 'notify.libraryStoreDamagedBody' : 'notify.libraryStoreLockedBody',
    });
  }

  // One channel for config.json, bounded the same way the pool file's is: the notifier is
  // edge-triggered, so a user who keeps clicking switches is told once and not once per
  // click. The two states differ only in what can be done about them, which is what the
  // body says.
  function reportConfigProblem(kind) {
    notify('config-store', 'journal.configStore', {
      titleKey: 'notify.configStoreFailedTitle',
      bodyKey: kind === 'corrupt-unbacked' ? 'notify.configStoreDamagedBody' : 'notify.configStoreLockedBody',
    });
  }

  // BUG-023. One door for every config.json write. The gate is useless if a caller can
  // walk past it, and there were six of them — two on the startup path, one on a timer and
  // one that fires before any window exists. Returns false instead of throwing: a blocked
  // write must be reported to the caller, not take down the action that asked for it.
  function writeConfigFile(options) {
    if (configUnsafeToWrite) {
      reportConfigProblem();
      return false;
    }
    return configMod.save(getConfig(), configPath, options);
  }

  // A store that was healthy at startup can still become unwritable later (locked tmp,
  // full disk, permissions). From that first failed write onward config.json becomes the
  // fail-closed copy for every pool edit until restart. Merely retaining the writer retry
  // is insufficient: a later tag/favourite changes the in-memory pool while the pending
  // trash array may already have been replaced.
  function enterLibraryWriteDegradedMode() {
    if (libraryUnsafeToWrite) return;
    libraryUnsafeToWrite = true;
    log.error('Пул перестал записываться — новые изменения сохраняются inline до перезапуска.');
    writeConfigFile({ skipLibrary: true, keepInline: true });
    reportLibraryStoreProblem('unreadable');
  }

  // DATA-001. The restore is decided inside configMod.load(); this wrapper does what
  // has to follow it on every exit of loadFiles(), including the early ones a degraded
  // pool takes: put a restored config.json back on disk (otherwise the damaged file
  // would be found, and restored, again on the next start) and tell the user.
  function load() {
    loadFiles();
    const config = getConfig();
    const cfgSource = config._configSource || {};
    const poolSource = config._poolSource || {};
    const configRestoredAt = cfgSource.state === 'restored' ? Number(cfgSource.restoredAt) || 0 : 0;
    const poolRestoredAt = Number(poolSource.restoredAt) || 0;
    if (configRestoredAt || poolRestoredAt) restoredThisSession = true;
    if (configRestoredAt) {
      writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite });
      reportRestored('config', configRestoredAt);
    }
    if (poolRestoredAt) reportRestored('library', poolRestoredAt);
  }

  function loadFiles() {
    const loaded = configMod.load(configPath, { restore });
    loaded.onlineSources = normalizeOnlineSources(loaded.onlineSources);
    setConfig(loaded);
    // DATA-006. Straight after the settings are in memory and before anything can reach
    // for a file: every later caller asks wallpapersDir(), and until this runs that answer
    // is still the profile default.
    onLoaded();
    const config = getConfig();

    // BUG-023. Decided FIRST, and before any of the early returns below: a settings file
    // that could not be read must not be written over no matter what the pool file turns
    // out to be. What is in memory right now is the defaults, not the user's profile.
    const cfgSource = config._configSource || {};
    configUnsafeToWrite = cfgSource.writable === false;
    if (configUnsafeToWrite) {
      log.error(
        cfgSource.state === 'corrupt-unbacked'
          ? 'config.json повреждён и бэкап не создан — настройки НЕ перезаписываются до перезапуска.'
          : 'config.json не читается — настройки НЕ перезаписываются до перезапуска.',
      );
      reportConfigProblem(cfgSource.state);
    }

    const source = config._poolSource || {};

    // An unreadable store (locked, permissions, failing disk) says NOTHING about what
    // it contains. Writing over it, or dropping the inline copy that is currently the
    // only readable one, would turn a temporary problem into permanent loss.
    if (source.unreadable) {
      libraryUnsafeToWrite = true;
      log.error('Пул не читается — библиотека НЕ будет перезаписана до перезапуска.');
      reportLibraryStoreProblem('unreadable');
      return;
    }

    // A store that parsed as garbage is BACKED UP, not understood — and what config.json
    // still carries inline is NOT a backup of it. Nothing keeps the two in step: the
    // inline copy is whatever a pre-split build wrote, or what an earlier degraded session
    // left behind, and it can be months out of date.
    //
    // Treating it as a recovery is what made this dangerous (DATA-004). The old rule only
    // refused when the merge came out EMPTY, so a profile with any inline copy at all took
    // the normal path: the damaged file was overwritten with the stale snapshot, config
    // stopped carrying the inline copy, and — because the runtime now believed the pool
    // was whole — the wallpaper collector was free to sweep every own-copy that the
    // records lost in the swap had been protecting.
    //
    // So a damaged store is fail-closed whatever is inline. The file is never rewritten,
    // the .corrupt-*.bak beside it stays the recovery path, and edits made meanwhile go to
    // config.json through the same degraded path as an unreadable store.
    //
    // Deliberately NOT part of this decision: whether anything is assigned to a monitor.
    // The library is independent of placement — a photo can be in it and on no monitor at
    // all — so "no monitor uses anything" was never evidence that the library was empty.
    if (source.broken) {
      libraryUnsafeToWrite = true;
      log.error('Пул повреждён: запись заблокирована, рядом лежит .corrupt-*.bak.');
      reportLibraryStoreProblem('broken');
      return;
    }
    // A store written by a build NEWER than this one is readable, and reading it is
    // the right thing to do — refusing would strand a rollback with no library at all.
    // Writing it back is what destroys data: save() stamps the version back down and
    // drops every field this build does not know about. So the pool is shown and the
    // file is left exactly as the newer build wrote it.
    if (source.newerVersion) {
      libraryUnsafeToWrite = true;
      log.error('Пул записан более новой версией — читаем, но НЕ перезаписываем.');
      reportLibraryStoreProblem('newer-version');
      return;
    }
    libraryUnsafeToWrite = false;

    // DATA-005. The two files are written atomically each but not together, and the
    // settings go first, so a power cut in the pool writer's window leaves a slot naming
    // a record that never reached disk. It fails quietly — the slot looks filled and
    // resolves to nothing — so it is repaired here and SAID OUT LOUD. Only in the healthy
    // mode: in the degraded one the pool is knowingly incomplete, and "repairing" against
    // it would throw away references to records that are merely unreadable right now.
    const repaired = poolConsistency.repairDanglingSlots(config.monitors, config.library);
    if (repaired) {
      log.error(`Ссылок в никуда убрано: ${repaired} (файлы обоев не тронуты).`);
      // DATA-001. After a restore from a copy these are photos added after the copy was
      // taken, not an interrupted save; the restore notice already explains them, and
      // this one would blame a power cut.
      if (!source.restoredAt) {
        notify('pool-consistency', 'journal.poolConsistency', {
          titleKey: 'notify.poolConsistencyTitle',
          bodyKey: 'notify.poolConsistencyBody',
        });
      }
      saveSettings();
    }

    // A config written before the split still carries the pool inline, and a build that
    // was rolled back may have added ids there since. Either way the merged result has
    // to reach the store BEFORE config.json is allowed to stop carrying it — and only
    // if that write is confirmed, which configMod.save now reports.
    // DATA-001: a store restored from a copy is rewritten here too, so the damaged file is
    // replaced by the healthy one (its bytes are kept in the .corrupt-*.bak beside it).
    if (!source.storeExisted || source.mergedInline || source.broken || source.normalizeAdded
      || source.restoredAt) {
      const ok = libraryStore.save(config.library, configPath, config.libraryTrash);
      if (ok) {
        writeConfigFile({ skipLibrary: true, keepInline: false });
      } else {
        // This is the same state as a writer that becomes unwritable later. Merely
        // keeping the inline copy in THIS save is not enough: the next settings-only
        // save would otherwise strip it again while the store still contains nothing.
        enterLibraryWriteDegradedMode();
        log.error('Не удалось создать файл пула — inline-копия в config.json сохранена.');
      }
    }
  }

  function markPoolDirty() {
    // The store file cannot be touched, but config.json can — and while the store is
    // unusable, config.json is the ONLY copy. Writing the pool inline right here is what
    // makes a tag or a star in this mode real: without it the edit was applied in memory,
    // confirmed on screen, and gone after a restart. Synchronous and un-batched on
    // purpose; this is the degraded path, where being correct beats being cheap.
    if (libraryUnsafeToWrite) {
      writeConfigFile({ skipLibrary: true, keepInline: true });
      return;
    }
    const config = getConfig();
    libraryWriter.markDirty(config.library, config.libraryTrash);
  }

  // For edits that touch ONLY the pool (tags, favourites): settings did not change,
  // so rewriting config.json would be pure waste — a tag used to cost a full config
  // write. The renderer still gets told, through the coalesced broadcast.
  function savePool() {
    markPoolDirty();
    broadcast();
  }

  // Default is SAFE: assume the pool may have changed and schedule its write. Deciding
  // by entry counts was cheaper but wrong — a tag, a favourite or a backfilled aspect
  // leaves the counts identical, so those edits were never written and vanished on the
  // next start. Getting this wrong costs data; getting the optimisation wrong only costs
  // a background write, so the cheap path is opt-in and lives in saveSettings().
  function save() {
    // In the degraded mode this single call already wrote the pool inline, so marking
    // the pool as well would write the same bytes twice.
    const inlined = libraryUnsafeToWrite;
    // DATA-005. The pool goes FIRST. Settings used to be written synchronously while the
    // records they name sat in a 1200 ms debounce, so every assignment opened a window in
    // which a crash left a slot pointing at nothing. Written this way round the worst a
    // crash can leave is a record nobody references — an orphan, which the collector moves
    // to wallpapers/.trash rather than deleting.
    //
    // This is not the tag path and does not undo the split storage: tags and favourites go
    // through savePool(), which still coalesces. Only settings that can name a record
    // pay for the ordering, and those are user actions, not bursts.
    // Mark AND flush: flushing alone writes only what someone already marked, so an edit
    // that reached the pool without marking it would never have been written at all.
    let keepInline = inlined;
    if (!inlined) {
      markPoolDirty();
      // A failed flush leaves the newest pool pending for retry, but settings must not
      // point at that in-memory-only record. Keep the same pool inline until a later
      // successful save can safely remove it again.
      keepInline = !libraryWriter.flush();
    }
    const saved = writeConfigFile({ skipLibrary: true, keepInline });
    slideshowPositionDirty = false;
    broadcast();
    return saved;
  }

  // For handlers that provably touch settings and nothing else. Keeps a switch flip from
  // scheduling a full rewrite of thousands of pool records — the coupling the split
  // storage existed to remove — without guessing on the paths that do touch the pool.
  function saveSettings() {
    const saved = writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite });
    if (!saved) return false;
    slideshowPositionDirty = false;
    broadcast();
    return true;
  }

  // Stable, anonymised install id for Znada Cloud usage stats (anonymous users).
  // Generated once (32 hex chars), persisted in config; never contains personal data.
  // Written directly (no broadcast) — it is main-only and the renderer never reads it.
  function ensureAnonId() {
    const config = getConfig();
    if (/^[A-Za-z0-9_-]{8,128}$/.test(config.anonId || '')) return;
    // BUG-023. This is the write that turned a read failure into data loss: it runs on
    // every start, sees no id in the defaults and saves them over the real file. An
    // unreadable config very likely HAS an id, and one we cannot store would be a
    // different install on every launch — so nothing is generated at all.
    if (configUnsafeToWrite) return;
    config.anonId = randomId();
    writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite });
  }

  // TELEM-001. The usage signal marks an attempt as spent BEFORE sending it, so its
  // caller must learn whether the mark reached the disk. No broadcast: main-only state.
  function persistUsagePing() {
    return writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite });
  }

  function persistPosition() {
    if (!slideshowPositionDirty) return;
    // Stays dirty when the write is refused, so the position is retried rather than
    // silently declared saved.
    if (!writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite })) return;
    slideshowPositionDirty = false;
  }

  return Object.freeze({
    load,
    save,
    saveSettings,
    savePool,
    markPoolDirty,
    ensureAnonId,
    markPositionDirty: () => { slideshowPositionDirty = true; },
    persistPosition,
    persistUsagePing,
    positionPending: () => slideshowPositionDirty,
    poolWritable: () => !libraryUnsafeToWrite,
    // The collector and the folder move refuse to act on either kind of degraded copy.
    writesBlocked: () => libraryUnsafeToWrite || configUnsafeToWrite,
    // The collector alone also stops after a restore from a copy (see restoredThisSession).
    sweepBlocked: () => libraryUnsafeToWrite || configUnsafeToWrite || restoredThisSession,
    flush: () => libraryWriter.flush(),
    poolWritePending: () => libraryWriter.isPending(),
    dispose: () => libraryWriter.dispose(),
  });
}

module.exports = { createConfigStore };
