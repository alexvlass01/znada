'use strict';

const fs = require('fs');
const path = require('path');
const imageInfo = require('./image-info');
const mediaType = require('./media-type');

const DEFAULT_CACHE_CAP = 2000;
const MAX_PATH_CHARS = 32767;

function emptyDetails() {
  return {
    exists: false,
    size: 0,
    modifiedAt: 0,
    width: 0,
    height: 0,
    isFolder: false,
    motion: null,
    video: null,
  };
}

function isValidAbsolutePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PATH_CHARS
    && !value.includes('\0')
    && path.isAbsolute(value);
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.toString();
}

// META-005. One tag the Details sheet is already showing, and nothing else.
// The sheet copies this exact text. It does not lowercase, rewrite or search it.
// A control character is refused: the clipboard must receive one label, not a
// multi-line payload a compromised renderer could hide inside a chip.
const MAX_TAG_COPY_CHARS = 256;

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function copyableTag(value) {
  if (typeof value !== 'string') return '';
  const tag = value.trim();
  if (!tag || tag.length > MAX_TAG_COPY_CHARS) return '';
  if (hasControlChar(tag)) return '';
  return tag;
}

function isSameOrDescendant(candidate, root) {
  if (!isValidAbsolutePath(candidate) || !isValidAbsolutePath(root)) return false;
  const candidatePath = path.resolve(candidate);
  const rootPath = path.resolve(root);
  const relative = path.relative(rootPath, candidatePath);
  return relative === ''
    || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function readHeaderFromDisk(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(imageInfo.IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Returns an async path -> metadata reader with a bounded LRU and in-flight dedup.
// statPath/readHeader are injectable so the filesystem behaviour stays under tests.
// `motion` (BUG-035) answers whether the picture moves and how many frames it has; main
// passes its one shared reader so the sheet and the grid never keep two caches of it.
function createDetailsReader(options = {}) {
  const statPath = options.statPath || ((filePath) => fs.promises.stat(filePath));
  const readHeader = options.readHeader || readHeaderFromDisk;
  const motionOf = typeof options.motion === 'function' ? options.motion : null;
  // MEDIA-002: length and frame size of a video, from main's one shared reader.
  const videoOf = typeof options.video === 'function' ? options.video : null;
  const requestedCap = Math.trunc(Number(options.cacheCap));
  const cacheCap = Number.isFinite(requestedCap) && requestedCap > 0
    ? requestedCap : DEFAULT_CACHE_CAP;
  const dimensionsCache = new Map();
  const dimensionsPending = new Map();

  function cacheGet(key) {
    if (!dimensionsCache.has(key)) return null;
    const value = dimensionsCache.get(key);
    dimensionsCache.delete(key);
    dimensionsCache.set(key, value);
    return value;
  }

  function cachePut(key, value) {
    if (dimensionsCache.has(key)) dimensionsCache.delete(key);
    dimensionsCache.set(key, value);
    while (dimensionsCache.size > cacheCap) {
      dimensionsCache.delete(dimensionsCache.keys().next().value);
    }
  }

  async function dimensionsFor(filePath, key) {
    const cached = cacheGet(key);
    if (cached) return cached;
    if (dimensionsPending.has(key)) return dimensionsPending.get(key);

    const pending = Promise.resolve()
      .then(() => readHeader(filePath))
      .then((buffer) => imageInfo.readDimensions(buffer))
      .then((dimensions) => {
        cachePut(key, dimensions);
        return dimensions;
      })
      // A successful read of an unsupported/corrupt file may cache {0,0}; a
      // transient disk/network failure must remain retryable on the next open.
      .catch(() => ({ width: 0, height: 0 }));
    dimensionsPending.set(key, pending);
    try { return await pending; }
    finally {
      if (dimensionsPending.get(key) === pending) dimensionsPending.delete(key);
    }
  }

  return async function readDetails(filePath) {
    if (!isValidAbsolutePath(filePath)) return emptyDetails();

    let stat;
    try { stat = await statPath(filePath); } catch { return emptyDetails(); }

    const isFolder = !!stat.isDirectory();
    const isFile = !!stat.isFile();
    const base = {
      exists: true,
      size: isFile ? Number(stat.size) || 0 : 0,
      modifiedAt: Number(stat.mtimeMs) || 0,
      isFolder,
      width: 0,
      height: 0,
      motion: null,
      video: null,
    };
    if (!isFile) return base;

    // A video's header is not a picture header; its size comes from Windows' properties.
    if (videoOf && mediaType.isVideoPath(filePath)) {
      const video = await Promise.resolve().then(() => videoOf(filePath)).catch(() => null);
      const info = video || { durationMs: 0, width: 0, height: 0 };
      return { ...base, width: info.width, height: info.height, video: info };
    }

    const cachePath = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    const [dimensions, motion] = await Promise.all([
      dimensionsFor(filePath, `${cachePath}|${base.modifiedAt}|${base.size}`),
      // The sheet is the one place a frame count is shown, so it asks for the full walk.
      motionOf ? Promise.resolve().then(() => motionOf(filePath, { countFrames: true })).catch(() => null) : null,
    ]);
    return { ...base, ...dimensions, motion: motion || null };
  };
}

module.exports = {
  DEFAULT_CACHE_CAP,
  MAX_PATH_CHARS,
  emptyDetails,
  MAX_TAG_COPY_CHARS,
  isValidAbsolutePath,
  isSameOrDescendant,
  normalizeHttpUrl,
  copyableTag,
  readHeaderFromDisk,
  createDetailsReader,
};
