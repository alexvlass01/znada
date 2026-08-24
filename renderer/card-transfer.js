'use strict';

// ONL-009. What the card actions actually DO, once — shared by the main window and the
// fullscreen viewer.
//
// The two windows differ in exactly two ways, so those are the two things passed in:
// the IPC bridge they own (`window.api` vs `window.viewerApi`), and how they tell the
// user something happened (a toast vs the viewer's own notice). Everything else — the
// order of operations, which message belongs to which outcome, and the fact that a
// failure is always reported — is identical and therefore lives here.
//
// Without this, "save as" and "copy picture" would exist twice, drift apart, and the
// next fix would land in one of them. That already happened once on this screen.

(function initCardTransfer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardTransfer = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardTransferFactory() {
  // Which message an outcome deserves. Pure, so the mapping can be checked without a
  // window: this is where "said it worked when it did not" would hide.
  function outcomeMessage(action, res) {
    const ok = !!(res && res.ok);
    switch (action) {
      case 'openSource':
        if (ok) return '';
        return res && res.error === 'noSource' ? 'card.noSource' : 'details.openFailed';
      case 'copyLink':
        return ok ? 'card.copiedLink' : 'card.linkFailed';
      case 'copyFile':
        return ok ? 'card.copiedFile' : 'card.copyFailed';
      case 'saveAs':
        return ok ? 'card.saved' : 'card.saveFailed';
      default:
        return '';
    }
  }

  // Whether the user should be told something is under way before it finishes. Only
  // for the two that may have to fetch the picture first; a link needs no ceremony.
  function pendingMessage(action) {
    if (action === 'copyFile') return 'card.copyingFile';
    if (action === 'saveAs') return 'card.saving';
    return '';
  }

  const BRIDGE_METHOD = {
    openSource: 'cardOpenSource',
    copyLink: 'cardCopyLink',
    copyFile: 'cardCopyFile',
    saveAs: 'cardSaveAs',
  };

  // `ctx` = { bridge, descriptor, t, notify, onAddToLibrary }
  //   notify({ message, actionLabel, onAction }) — the window's own way of speaking.
  //   onAddToLibrary — offered after a save, because the owner's rule is that an
  //   export leaves no library record unless the user says so.
  async function run(action, ctx = {}) {
    const method = BRIDGE_METHOD[action];
    const bridge = ctx.bridge;
    const t = typeof ctx.t === 'function' ? ctx.t : (k) => k;
    const notify = typeof ctx.notify === 'function' ? ctx.notify : () => {};
    if (!method || !bridge || typeof bridge[method] !== 'function' || !ctx.descriptor) {
      return { ok: false, error: 'unsupported' };
    }

    const pending = pendingMessage(action);
    if (pending) notify({ message: t(pending) });

    let res;
    try { res = await bridge[method](ctx.descriptor); }
    catch { res = { ok: false, error: 'failed' }; }

    // A cancelled save dialog is not a failure and must not be announced as one.
    if (res && res.canceled) return { ok: false, canceled: true };

    const key = outcomeMessage(action, res);
    if (action === 'saveAs' && res && res.ok && typeof ctx.onAddToLibrary === 'function') {
      notify({
        message: t(key),
        actionLabel: t('card.addToLibrary'),
        onAction: ctx.onAddToLibrary,
      });
      return res;
    }
    if (key) notify({ message: t(key) });
    return res || { ok: false, error: 'failed' };
  }

  return { run, outcomeMessage, pendingMessage, BRIDGE_METHOD };
}));
