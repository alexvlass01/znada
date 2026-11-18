'use strict';

// CODE-001 1.5. Each instance owns the thumbnail LRU, in-flight requests and queue.
// Main supplies authority and metadata writers; no Electron or captured config here.
const fs = require('fs');
const path = require('path');
const mediaType = require('./media-type');
const { createTaskQueue } = require('./task-queue');

/**
 * @typedef {{ url: string, width: number, height: number }} ThumbnailData
 * @param {{
 *   thumbnailHost: { thumbnail: (path: string, width: number, quality: number) => Promise<{ mime?: string, dataBase64?: string, width?: number, height?: number, encodedBytes?: number, windowsCache?: string }>, mediaInfo: (path: string) => Promise<{ durationMs: number, width: number, height: number }> },
 *   isAuthorizedMediaPath: (path: string) => boolean,
 *   queueLiveFolderAspect: (path: string, aspect: number) => void,
 *   setAspect: (id: string, path: string, aspect: number) => boolean,
 *   saveLibrarySoon: () => void,
 *   diagEvent: (event: object) => void,
 *   diagSpan: (category: string, name: string, attributes: object) => (attributes: object) => void
 * }} dependencies
 */
function createThumbnailService({ thumbnailHost, isAuthorizedMediaPath, queueLiveFolderAspect,
  setAspect, saveLibrarySoon, diagEvent, diagSpan }) {
  // Count after authority, before caches: tests distinguish refusal from helper failure.
  let attempts = 0;
  // Маленький тамбнейл для библиотечных превью (через Windows shell) → data-URL. Без него
  // карточки грузили бы полноразмерные (до 4K) файлы → тормоза декодирования + «лесенка»
  // при даунскейле. Вместе с URL держим размер thumbnail: его пропорция совпадает с оригиналом
  // и нужна justified-сетке. Windows cache принимает scalar width, поэтому LRU-key = "путь|W".
  const thumbCache = new Map();
  const thumbPending = new Map();
  // Diagnostics observes every thumbnail job (queue wait + run + depth) through the
  // optional task-queue hooks; with diagnostics off the hook body is a null-check.
  const runThumbnailTask = createTaskQueue(2, {
    onSettle: ({ ok, startedAt, waitMs, runMs, pending, active }) => diagEvent({
      kind: 'span',
      category: 'task-queue',
      name: 'thumbnail-task',
      timestampMs: startedAt,
      durationMs: runMs,
      attributes: { status: ok ? 'ok' : 'error', waitMs, pending, active },
    }),
  });
  const THUMB_CAP = 800;
  function cachedThumb(key) {
    const hit = thumbCache.get(key);
    if (hit === undefined) return undefined;
    thumbCache.delete(key);
    thumbCache.set(key, hit);
    return hit;
  }
  async function thumbnailData(p, w, h, priority = 0) {
    if (!p || typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) {
      return { url: '', width: 0, height: 0 };
    }
    // SEC-002. A thumbnail IS the file's contents, re-encoded and handed back as a data
    // URL. Guarded here rather than at each of the three channels above it, so a fourth
    // caller cannot arrive without the check.
    if (!isAuthorizedMediaPath(p)) return { url: '', width: 0, height: 0 };
    attempts += 1;
    const requestedWidth = Number(w);
    const requestedHeight = Number(h);
    const W = Number.isFinite(requestedWidth) ? Math.max(16, Math.min(1024, Math.round(requestedWidth))) : 320;
    const H = Number.isFinite(requestedHeight) ? Math.max(16, Math.min(1024, Math.round(requestedHeight))) : 200;
    const key = `${p}|${W}`;
    const hit = cachedThumb(key);
    if (hit !== undefined) {
      if (hit.width > 0 && hit.height > 0) queueLiveFolderAspect(p, hit.width / hit.height);
      return hit;
    }
    const pending = thumbPending.get(key);
    if (pending) return pending;
    const job = runThumbnailTask(async () => {
      const lateHit = cachedThumb(key);
      if (lateHit !== undefined) {
        if (lateHit.width > 0 && lateHit.height > 0) queueLiveFolderAspect(p, lateHit.width / lateHit.height);
        return lateHit;
      }
      let data = { url: '', width: 0, height: 0 };
      let cacheable = true;
      // Extraction and encoding run in the isolated Windows helper. Main keeps only
      // the lightweight JSONL round-trip and the bounded in-memory result cache.
      const endRequest = diagSpan('thumbnail', 'helper-roundtrip', { width: W, height: H });
      try {
        const result = await thumbnailHost.thumbnail(p, W, 82);
        const mime = result && result.mime === 'image/png' ? 'image/png' : 'image/jpeg';
        const body = result && typeof result.dataBase64 === 'string' ? result.dataBase64 : '';
        const width = Number(result && result.width) || 0;
        const height = Number(result && result.height) || 0;
        if (body && width > 0 && height > 0) {
          data = { url: 'data:' + mime + ';base64,' + body, width, height };
        }
        endRequest({
          status: data.url ? 'ok' : 'empty',
          bytes: Number(result && result.encodedBytes) || 0,
          width,
          height,
          windowsCache: String(result && result.windowsCache || ''),
        });
      } catch (error) {
        cacheable = !(error && error.retriable);
        endRequest({ status: 'error', errorCode: String(error && error.code || 'helper_failed') });
      }
      if (cacheable) {
        thumbCache.set(key, data);
        if (thumbCache.size > THUMB_CAP) {
          const k0 = thumbCache.keys().next().value;
          thumbCache.delete(k0);
        }
      }
      if (data.width > 0 && data.height > 0) queueLiveFolderAspect(p, data.width / data.height);
      return data;
    }, { priority }).finally(() => {
      thumbPending.delete(key);
    });
    thumbPending.set(key, job);
    return job;
  }
  // Resolve proportions before renderer inserts the next justified-grid chunk. A small
  // worker pool avoids hammering Windows shell with dozens of simultaneous thumbnail jobs.
  // Pool-item aspects are persisted as additive metadata; folder-expanded images are
  // persisted separately in folder-state by thumbnailData's batched backfill.
  async function aspects(entries, w, h) {
    const input = Array.isArray(entries) ? entries.slice(0, 100) : [];
    const result = new Array(input.length);
    let cursor = 0;
    let changed = false;
    const worker = async () => {
      while (cursor < input.length) {
        const index = cursor++;
        const entry = input[index] || {};
        const p = typeof entry.path === 'string' ? entry.path : '';
        const data = await thumbnailData(p, w, h);
        const aspect = data.width > 0 && data.height > 0 ? data.width / data.height : 0;
        result[index] = { path: p, aspect };
        if (aspect && entry.id && setAspect(entry.id, p, aspect)) changed = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, input.length) }, () => worker()));
    // Internal metadata backfill must not broadcast config and restart the visible
    // library render that requested it. Only pool aspects changed, so this goes
    // through the batched pool writer instead of a full config rewrite.
    if (changed) saveLibrarySoon();
    return result;
  }

  // MEDIA-002. Length and frame size of a video, for its card badge and "Details". Same
  // authority as a thumbnail. Remembered by path + size + modified time so a grid scroll
  // asks the helper once per file; a failure is not remembered.
  const videoCache = new Map();
  const VIDEO_CAP = 4000;
  async function videoInfo(p) {
    if (!p || typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) return null;
    if (!mediaType.isVideoPath(p) || !isAuthorizedMediaPath(p)) return null;
    let stats;
    try { stats = await fs.promises.stat(p); } catch { return null; }
    if (!stats.isFile()) return null;
    const key = `${p}|${stats.size}|${stats.mtimeMs}`;
    if (videoCache.has(key)) return videoCache.get(key);
    let info;
    try { info = await thumbnailHost.mediaInfo(p); } catch { return null; }
    const result = { durationMs: info.durationMs, width: info.width, height: info.height };
    videoCache.set(key, result);
    if (videoCache.size > VIDEO_CAP) videoCache.delete(videoCache.keys().next().value);
    return result;
  }

  return { thumbnailData, aspects, videoInfo, attempts: () => attempts };
}

module.exports = { createThumbnailService };
