'use strict';

window.createOnlineVideoDownloads = function createOnlineVideoDownloads(api, t) {
  const active = new Map();
  const byRequest = new Map();
  const keyOf = item => JSON.stringify([item.provider, item.id, item.full]);

  api.onInternetVideoProgress?.(({ requestId, received, total }) => {
    const transfer = byRequest.get(requestId);
    if (!transfer || transfer.cancelling) return;
    transfer.received = received;
    transfer.total = total;
    transfer.update();
  });

  function sync(host, item) {
    let panel = host?.querySelector(':scope > .online-video-download');
    const transfer = active.get(keyOf(item));
    if (!transfer) {
      panel?.remove();
      return;
    }
    if (panel?.dataset.requestId !== transfer.id) {
      panel?.remove();
      panel = document.createElement('div');
      panel.className = 'online-video-download';
      panel.dataset.requestId = transfer.id;
      panel.addEventListener('click', event => event.stopPropagation());
      const progress = document.createElement('progress');
      progress.setAttribute('aria-label', t('video.downloading'));
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pill media-action';
      cancel.textContent = t('mediaFolder.cancel');
      cancel.addEventListener('click', async () => {
        transfer.cancelling = true;
        transfer.update();
        try { await api.cancelInternetVideo(transfer.id); } catch {
          transfer.cancelling = false;
          transfer.update();
        }
      });
      panel.append(progress, cancel);
      host?.append(panel);
    }
    const progress = panel.querySelector('progress');
    if (transfer.total > 0) {
      progress.max = transfer.total;
      progress.value = transfer.received;
    } else progress.removeAttribute('value');
    panel.querySelector('button').disabled = transfer.cancelling;
  }

  async function download(item, query, update) {
    const key = keyOf(item);
    const existing = active.get(key);
    if (existing) return existing.result;
    const id = crypto.randomUUID();
    const transfer = { id, received: 0, total: 0, cancelling: false, update };
    active.set(key, transfer);
    byRequest.set(id, transfer);
    transfer.result = Promise.resolve().then(() => api.internetAdd(item, query, id));
    update();
    try {
      return await transfer.result;
    } finally {
      byRequest.delete(id);
      active.delete(key);
      update();
    }
  }

  return { sync, download };
};
