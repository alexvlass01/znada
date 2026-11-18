'use strict';

// One synchronous transaction for the pool + slot mutation. Filesystem validation
// stays in main.js and must set allowCreate only after the path/type is confirmed.
// Therefore every failure returned here leaves both config.library and slots intact.
//
// Creating a pool entry goes through `options.addToPool` when the pool owner supplies it, so
// this shares the pool owner's single entry point instead of being a second door: a photo added
// here has to shed its removed state exactly like one added anywhere else, or it ends
// up active in a slot while still marked removed (BUG-011).

const library = require('./library');
const mediaType = require('./media-type');

// MEDIA-002. Video is a Library card, never a wallpaper. Refused here, before any pool
// record is created, so every route into a slot answers the same and a refusal leaves
// nothing behind. `resolveSlot` drops video as well; this check exists so the window
// gets a reason it can explain instead of an assignment that silently does nothing.
function isVideoRecord(record, item) {
  if (item && item.type !== 'folder') return mediaType.isVideoPath(item.path);
  return !!record && record.type !== 'folder' && mediaType.isVideoPath(record.path);
}

// Use the pool owner's funnel when it is provided; fall back to the plain add for tests that
// exercise this module on its own.
function addPooled(config, type, p, options) {
  if (typeof options.addToPool === 'function') return options.addToPool(type, p, options.extra);
  return library.addPath(config.library, type, p, options.extra);
}

// Assigning an item that ALREADY has a pool record used to skip the funnel entirely,
// because nothing was being created. But "already in the pool" and "not removed" are
// different facts: a profile left in the active+removed state by an older build (or
// by the folder cascade that used to miss its descendants) stayed broken no matter how
// many times the user assigned the photo. Going through the funnel here repairs it —
// the funnel dedups, so for an existing record this costs a lookup and nothing else.
function activatePooled(config, item, options) {
  if (!item || typeof options.addToPool !== 'function') return;
  const type = item.type === 'folder' ? 'folder' : 'image';
  try { options.addToPool(type, item.path, options.extra); }
  catch { /* assignment must not fail because a tombstone could not be cleared */ }
}

function assignmentError(config, error) {
  return { config, ok: false, error, id: null, created: false };
}

function assignRecord(config, record, monitorId, which, options = {}) {
  if (!config || typeof config !== 'object' || !config.library || typeof config.library !== 'object'
      || !config.monitors || typeof config.monitors !== 'object'
      || !monitorId || !record || typeof record !== 'object') {
    return assignmentError(config, 'bad_request');
  }

  let item = record.id ? library.getItem(config.library, record.id) : null;
  if (!item && typeof record.path === 'string' && record.path) {
    item = library.getItem(config.library, library.idFor(record.path));
  }
  if (isVideoRecord(record, item)) return assignmentError(config, 'video');

  let created = false;
  if (!item) {
    if (!options.allowCreate || typeof record.path !== 'string' || !record.path) {
      return assignmentError(config, 'missing_item');
    }
    const type = record.type === 'folder' ? 'folder' : 'image';
    const id = addPooled(config, type, record.path, options);
    item = library.getItem(config.library, id);
    if (!item) return assignmentError(config, 'missing_item');
    created = true;
  } else {
    activatePooled(config, item, options);
  }

  const theme = which === 'dark' ? 'dark' : 'light';
  if (!config.monitors[monitorId]) {
    config.monitors[monitorId] = { light: { itemIds: [] }, dark: { itemIds: [] } };
  }
  const monitor = config.monitors[monitorId];
  if (!monitor.light || !Array.isArray(monitor.light.itemIds)) monitor.light = { itemIds: [] };
  if (!monitor.dark || !Array.isArray(monitor.dark.itemIds)) monitor.dark = { itemIds: [] };
  const slot = monitor[theme];
  if (!slot.itemIds.includes(item.id)) slot.itemIds.push(item.id);
  library.clearSlotExplicitEmpty(slot);

  return { config, ok: true, error: null, id: item.id, created, item };
}

function assignRecords(config, preparedRecords, monitorId, which) {
  if (!config || typeof config !== 'object' || !config.library || typeof config.library !== 'object'
      || !config.monitors || typeof config.monitors !== 'object' || !monitorId
      || !Array.isArray(preparedRecords) || !preparedRecords.length) {
    return { config, ok: false, error: 'bad_request', assigned: 0, failed: 0, ids: [], createdIds: [], items: [] };
  }
  const ids = [];
  const createdIds = [];
  const items = [];
  let failed = 0;
  let videos = 0;
  for (const prepared of preparedRecords) {
    const record = prepared && prepared.record;
    const options = (prepared && prepared.options) || {};
    if (!record || typeof record !== 'object') { failed += 1; continue; }
    let item = record.id ? library.getItem(config.library, record.id) : null;
    if (!item && typeof record.path === 'string' && record.path) {
      item = library.getItem(config.library, library.idFor(record.path));
    }
    if (isVideoRecord(record, item)) { videos += 1; continue; }
    if (!item && options.allowCreate && typeof record.path === 'string' && record.path) {
      const type = record.type === 'folder' ? 'folder' : 'image';
      const id = addPooled(config, type, record.path, options);
      item = library.getItem(config.library, id);
      if (item) createdIds.push(item.id);
    } else if (item) {
      activatePooled(config, item, options);
    }
    if (!item) { failed += 1; continue; }
    ids.push(item.id);
    items.push(item);
  }
  if (ids.length) {
    const theme = which === 'dark' ? 'dark' : 'light';
    if (!config.monitors[monitorId]) {
      config.monitors[monitorId] = { light: { itemIds: [] }, dark: { itemIds: [] } };
    }
    const monitor = config.monitors[monitorId];
    if (!monitor.light || !Array.isArray(monitor.light.itemIds)) monitor.light = { itemIds: [] };
    if (!monitor.dark || !Array.isArray(monitor.dark.itemIds)) monitor.dark = { itemIds: [] };
    const slot = monitor[theme];
    const slotIds = new Set(slot.itemIds);
    for (const id of ids) {
      if (slotIds.has(id)) continue;
      slotIds.add(id);
      slot.itemIds.push(id);
    }
    library.clearSlotExplicitEmpty(slot);
  }
  return {
    config,
    ok: ids.length > 0,
    // Only video in the selection is its own answer; a mix assigns the pictures and
    // reports the skipped videos beside them.
    error: ids.length ? null : (videos && !failed ? 'video' : 'missing_item'),
    assigned: ids.length,
    failed,
    videos,
    ids,
    createdIds,
    items,
  };
}

module.exports = { assignRecord, assignRecords };
