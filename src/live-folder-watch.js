'use strict';

const fs = require('fs');
const path = require('path');
const { pathKey } = require('./path-key');

function normalizedRoot(value) {
  try { return pathKey(path.resolve(String(value || ''))); }
  catch { return ''; }
}

function createController(options = {}) {
  const watch = typeof options.watch === 'function' ? options.watch : fs.watch;
  const onChange = typeof options.onChange === 'function' ? options.onChange : async () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : 1500;
  const records = new Map();
  let disposed = false;

  function closeWatcher(record) {
    if (!record || !record.watcher) return;
    try { record.watcher.close(); } catch {}
    record.watcher = null;
  }

  function closeRecord(record) {
    if (!record) return;
    if (record.timer) clearTimer(record.timer);
    record.timer = null;
    record.queued = false;
    closeWatcher(record);
  }

  async function run(record) {
    record.timer = null;
    if (disposed || records.get(record.id) !== record) return;
    if (record.running) {
      record.queued = true;
      return;
    }
    record.running = true;
    try { await onChange(record.id, record.rootPath); }
    catch (err) { onError(record.id, err); }
    finally {
      record.running = false;
      if (record.queued && !disposed && records.get(record.id) === record) {
        record.queued = false;
        schedule(record);
      }
    }
  }

  function schedule(record) {
    if (disposed || !record || records.get(record.id) !== record) return;
    if (record.timer) clearTimer(record.timer);
    record.timer = setTimer(() => run(record), debounceMs);
    if (record.timer && typeof record.timer.unref === 'function') record.timer.unref();
  }

  function startWatcher(record) {
    if (disposed || record.watcher) return false;
    try {
      const watcher = watch(record.rootPath, { recursive: true }, () => schedule(record));
      record.watcher = watcher;
      if (watcher && typeof watcher.on === 'function') {
        watcher.on('error', (err) => {
          if (records.get(record.id) !== record || record.watcher !== watcher) return;
          closeWatcher(record);
          onError(record.id, err);
        });
      }
      return true;
    } catch (err) {
      record.watcher = null;
      onError(record.id, err);
      return false;
    }
  }

  function sync(items) {
    if (disposed) return { watched: 0, failed: 0 };
    const wanted = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item && item.id || '').trim();
      const rootPath = String(item && item.path || '').trim();
      if (id && rootPath) wanted.set(id, { id, rootPath, key: normalizedRoot(rootPath) });
    }

    for (const [id, record] of records) {
      const next = wanted.get(id);
      if (!next || next.key !== record.key) {
        closeRecord(record);
        records.delete(id);
      }
    }

    for (const item of wanted.values()) {
      let record = records.get(item.id);
      if (!record) {
        record = {
          ...item,
          watcher: null,
          timer: null,
          running: false,
          queued: false,
        };
        records.set(item.id, record);
      }
      startWatcher(record);
    }

    let watched = 0;
    for (const record of records.values()) if (record.watcher) watched++;
    return { watched, failed: records.size - watched };
  }

  function trigger(folderId) {
    const record = records.get(folderId);
    if (!record) return false;
    schedule(record);
    return true;
  }

  function restart(folderId) {
    const record = records.get(folderId);
    if (!record || disposed) return false;
    closeWatcher(record);
    return startWatcher(record);
  }

  function closeAll() {
    disposed = true;
    for (const record of records.values()) closeRecord(record);
    records.clear();
  }

  return { sync, trigger, restart, closeAll };
}

module.exports = { createController };
