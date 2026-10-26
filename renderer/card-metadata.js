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
    if (res.status === 'ambiguous') return { key: 'card.lookupAmbiguous', params: null };
    if (res.status === 'busy') {
      const seconds = Math.max(1, Math.ceil((Number(res.retryAfterMs) || 0) / 1000));
      return { key: 'card.lookupBusy', params: { n: seconds } };
    }
    if (res.status === 'absent') return { key: 'card.lookupNothing', params: null };
    // DATA-009. Nothing failed and nothing was asked wrongly: Znada is moving its files
    // and will not change the library meanwhile. "Could not check" would send the user
    // looking for a network fault that is not there.
    if (res.reason === 'media_move_running') return { key: 'mediaFolder.frozen', params: null };
    if (res.status === 'error') {
      const errors = {
        timeout: 'card.lookupTimeout', network: 'card.lookupNetwork',
        errorRecently: 'card.lookupRecentError', noProvider: 'card.lookupUnavailable',
        unavailable: 'card.lookupUnavailable', thumbnail: 'card.lookupPreviewFailed',
        changed: 'card.lookupChanged', denied: 'card.lookupChanged',
        malformed: 'card.lookupResponseFailed', mismatch: 'card.lookupResponseFailed',
      };
      if (Object.hasOwn(errors, res.reason)) return { key: errors[res.reason], params: null };
      if (/^\d{3}$/.test(res.reason || '')) return { key: 'card.lookupHttpError', params: { n: Number(res.reason) } };
    }
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
  let comparisonSequence = 0;

  // Progress and its final outcome survive a short toast, in both windows. Each
  // concurrent lookup owns its row; a result can only be dismissed once it settles.
  function lookupNotice(t) {
    if (typeof document === 'undefined') return { visible: false, update() {}, finish() {} };
    const stack = document.getElementById('lookupNotices');
    if (!stack) return { visible: false, update() {}, finish() {} };
    const viewer = !!document.getElementById('viewerRoot');
    for (const old of Array.from(stack.querySelectorAll('.metadata-lookup-done')).slice(0, -5)) old.remove();
    const row = document.createElement('div');
    row.className = viewer ? 'media-notice media-notice-wrap metadata-lookup' : 'toast show metadata-lookup';
    row.setAttribute('aria-busy', 'true');
    const indicator = document.createElement('span');
    indicator.className = 'metadata-lookup-spinner';
    indicator.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = viewer ? 'media-notice-action' : 'toast-action';
    close.textContent = '×';
    close.setAttribute('aria-label', t('card.lookupDismiss'));
    close.hidden = true;
    close.addEventListener('click', () => row.remove());
    row.append(indicator, status, close);
    stack.appendChild(row);
    return {
      visible: true,
      update(message) { status.textContent = message; },
      finish(message) {
        status.textContent = message;
        row.classList.add('metadata-lookup-done');
        row.setAttribute('aria-busy', 'false');
        indicator.remove();
        close.hidden = false;
      },
    };
  }

  // One shared comparison in both windows. Only locally constructed text and
  // validated image URLs enter the DOM; remote HTML and tags never do.
  function confirmCandidate(candidate, t) {
    if (typeof document === 'undefined') return Promise.resolve(null);
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const modal = document.createElement('dialog');
      modal.className = 'metadata-compare';
      const title = document.createElement('h2');
      title.textContent = t('card.lookupCompareTitle');
      title.id = 'metadata-compare-title-' + (++comparisonSequence);
      modal.setAttribute('aria-labelledby', title.id);
      const description = document.createElement('p');
      description.textContent = t('card.lookupCompareBody', { n: candidate.similarity, source: candidate.sourceName || candidate.provider });
      const images = document.createElement('div');
      images.className = 'metadata-compare-images';
      let loaded = 0;
      let failed = false;
      let revealed = !candidate.blur;
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'metadata-compare-apply';
      apply.textContent = t('card.lookupCompareApply');
      apply.disabled = true;
      for (const [url, label] of [[candidate.original, 'card.lookupOriginal'], [candidate.thumb, 'card.lookupCandidate']]) {
        const figure = document.createElement('figure');
        const img = document.createElement('img');
        img.alt = t(label);
        img.referrerPolicy = 'no-referrer';
        if (candidate.blur) img.className = 'metadata-compare-blur';
        let fallback = label === 'card.lookupCandidate' && candidate.fallbackThumb !== url ? candidate.fallbackThumb : '';
        img.addEventListener('load', () => { loaded++; apply.disabled = failed || loaded !== 2 || !revealed; }, { once: true });
        img.addEventListener('error', () => {
          if (fallback) { const next = fallback; fallback = ''; img.src = next; return; }
          failed = true;
          description.textContent = t('card.lookupCompareImageFailed'); apply.disabled = true;
        });
        img.src = url;
        const caption = document.createElement('figcaption');
        caption.textContent = t(label);
        figure.append(img, caption);
        images.appendChild(figure);
      }
      const actions = document.createElement('div');
      actions.className = 'metadata-compare-actions';
      if (!revealed) {
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.textContent = t('card.lookupReveal');
        reveal.addEventListener('click', () => {
          for (const image of images.querySelectorAll('img')) image.classList.remove('metadata-compare-blur');
          revealed = true;
          apply.disabled = failed || loaded !== 2;
          reveal.remove();
        });
        actions.appendChild(reveal);
      }
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = t('card.lookupCompareCancel');
      function finish(accept) {
        modal.close();
        modal.remove();
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        resolve(accept);
      }
      cancel.addEventListener('click', () => finish(false));
      apply.addEventListener('click', () => { if (!apply.disabled) finish(true); });
      modal.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
      modal.addEventListener('keydown', (event) => event.stopPropagation());
      actions.append(cancel, apply);
      modal.append(title, description, images, actions);
      document.body.appendChild(modal);
      modal.showModal();
      cancel.focus();
    });
  }

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
    const notice = lookupNotice(t);
    notice.update(t('card.lookupRunning'));
    if (typeof o.onBusy === 'function') o.onBusy(true);
    if (!notice.visible) notify(t('card.lookupRunning'));
    let res;
    try {
      res = await bridge.itemLookupMetadata(id);
      // A manual click requests both stages; the owner rejected a second consent
      // prompt. Only a definite MD5 miss falls through, never an error or a busy host.
      if (res?.status === 'absent' && typeof bridge.itemLookupVisualMetadata === 'function') {
        notice.update(t('card.lookupVisualRunning'));
        if (!notice.visible) notify(t('card.lookupVisualRunning'));
        res = await bridge.itemLookupVisualMetadata(id);
        if (res?.status === 'candidate') {
          notice.update(t('card.lookupCompareTitle'));
          const ask = typeof o.confirmCandidate === 'function' ? o.confirmCandidate : confirmCandidate;
          const accepted = await ask(res, t);
          notice.update(t('card.lookupApplying'));
          res = await bridge.itemConfirmVisualMetadata(id, res.token, accepted === true ? true : accepted === false ? false : null);
        }
      }
    } catch {
      // A rejected bridge call is indistinguishable to the user from the catalogue
      // failing, and both deserve the same honest "could not check".
      res = { status: 'error', reason: 'bridge' };
    } finally {
      running.delete(id);
      if (typeof o.onBusy === 'function') o.onBusy(false);
    }
    if (res?.status === 'cancelled') {
      notice.finish(res.reason === 'dismissed' ? t('card.lookupDismissed') : t('card.lookupCancelled'));
      return res;
    }
    const message = outcomeMessage(res);
    notice.finish(t(message.key, message.params || undefined));
    if (!notice.visible) notify(t(message.key, message.params || undefined));
    if (changedRecord(res) && typeof o.onApplied === 'function') o.onApplied(res);
    return res;
  }

  function isRunning(id) {
    return running.has(id);
  }

  return { outcomeMessage, changedRecord, run, isRunning };
}));
