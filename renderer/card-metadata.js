'use strict';

// META-001. Asking an online catalogue about a photo the user already has — shared by
// the main window and the fullscreen viewer, for the same reason `card-transfer.js` is:
// the two windows differ only in which IPC bridge they own and how they speak to the
// user, and everything else about this action is identical.
//
// The outcome mapping is the part worth keeping in one place. There are five distinct
// endings and they must not be flattened into "worked / did not":
//
//   found + new tags   the point of the feature
//   found + nothing new  the record already had everything the post could give
//   nothing found      the file is not byte-identical to anything the catalogue holds
//   busy               our own budget said "not yet" — nothing was asked
//   error              the catalogue would not answer
//
// A feature that answers the last three with silence is a feature the user concludes is
// broken, so every one of them says something.

(function initCardMetadata(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardMetadata = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardMetadataFactory() {
  // Pure: which message an outcome deserves, and with which numbers. Checked without a
  // window, because this is exactly where "said it found something when it did not"
  // would hide.
  function outcomeMessage(res) {
    if (!res || !res.status) return { key: 'card.lookupFailed', params: null };
    if (res.status === 'busy') {
      const seconds = Math.max(1, Math.ceil((Number(res.retryAfterMs) || 0) / 1000));
      return { key: 'card.lookupBusy', params: { n: seconds } };
    }
    if (res.status === 'absent') return { key: 'card.lookupNothing', params: null };
    if (res.status !== 'found') return { key: 'card.lookupFailed', params: null };
    const added = Number(res.addedTags) || 0;
    return added > 0
      ? { key: 'card.lookupAdded', params: { n: added } }
      : { key: 'card.lookupNoNew', params: null };
  }

  // True when the answer actually changed the record, and therefore anything showing
  // that record has to be redrawn.
  function changedRecord(res) {
    return !!(res && res.status === 'found' && (Number(res.addedTags) || 0) > 0);
  }

  // One lookup in flight per photo per window. Not a substitute for the queue in main —
  // that is what protects the catalogue — but it stops a double click from producing
  // two identical progress notices.
  const running = new Set();

  // `ctx` = { bridge, id, t, notify, onBusy, onApplied }
  //   notify(message) — the window's own way of speaking.
  //   onBusy(flag)    — optional, for disabling the control that started this.
  //   onApplied(res)  — optional, called only when the record really changed.
  async function run(ctx) {
    const o = ctx || {};
    const bridge = o.bridge;
    const id = o.id;
    const t = typeof o.t === 'function' ? o.t : (key) => key;
    const notify = typeof o.notify === 'function' ? o.notify : () => {};
    if (!id || !bridge || typeof bridge.itemLookupMetadata !== 'function') return null;
    if (running.has(id)) return null;

    running.add(id);
    if (typeof o.onBusy === 'function') o.onBusy(true);
    notify(t('card.lookupRunning'));
    let res;
    try {
      res = await bridge.itemLookupMetadata(id);
    } catch {
      // A rejected bridge call is indistinguishable to the user from the catalogue
      // failing, and both deserve the same honest "could not check".
      res = { status: 'error', reason: 'bridge' };
    } finally {
      running.delete(id);
      if (typeof o.onBusy === 'function') o.onBusy(false);
    }
    const message = outcomeMessage(res);
    notify(t(message.key, message.params || undefined));
    if (changedRecord(res) && typeof o.onApplied === 'function') o.onApplied(res);
    return res;
  }

  function isRunning(id) {
    return running.has(id);
  }

  return { outcomeMessage, changedRecord, run, isRunning };
}));
