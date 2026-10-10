'use strict';

// BUG-035. Does this picture MOVE? Answered from the file's own bytes, never from its
// name: a .gif can be one still frame, and a .png (APNG) or .webp can be an animation.
//
// Why it matters: the grids draw a still thumbnail of every picture, the desktop shows
// only a still frame (Windows' IDesktopWallpaper takes a single image), and yet the
// viewer plays the animation. Owner's decision 2026-09-26: a moving picture carries one
// "GIF" chip wherever it is shown as a card, and everything that stands for the desktop
// shows the frame the desktop really shows. Both need this one answer.
//
// Nothing here decodes pixels. GIF is walked block by block (sub-block lengths only),
// PNG and WebP by their chunk headers, so the cost is a few small reads — except for a
// GIF, where the second frame starts only after the first frame's data. The quick
// answer stops there; counting every frame (the details sheet) walks the whole file,
// up to a hard cap.

const fs = require('fs');

// First read. Covers every header this module looks at in ordinary files; a PNG whose
// metadata runs longer than this is walked further by position.
const PROBE_BYTES = 64 * 1024;
// Later sequential reads while walking a GIF.
const READ_CHUNK = 256 * 1024;
// Never walk a GIF further than this. Past it the answer is "unknown", not a guess.
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
// Guards for chunk walks over a damaged or hostile file.
const MAX_CHUNKS = 200000;

// Formats that can carry more than one frame. Anything else is still by definition.
const CAN_MOVE = Object.freeze(['gif', 'png', 'webp']);
const CAN_MOVE_SET = new Set(CAN_MOVE);

// What the chip's tooltip and the details sheet call each moving format. An animated
// PNG is "APNG": "PNG" alone would read as "a still picture".
const DISPLAY_NAMES = Object.freeze({ gif: 'GIF', png: 'APNG', webp: 'WEBP' });

function sniffFormat(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf.length >= 6) {
    const magic = buf.toString('latin1', 0, 6);
    if (magic === 'GIF87a' || magic === 'GIF89a') return 'gif';
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG'
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return '';
}

function displayName(format) {
  const key = String(format || '').toLowerCase();
  return DISPLAY_NAMES[key] || key.toUpperCase();
}

// Can a file with this extension move at all? Used to leave JPEG and BMP unopened.
// A still format under a moving extension is found out by sniffing; a moving format
// hiding under a still extension is not looked for, and stays a still picture here.
function mayMove(filePath) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filePath || ''));
  return !!match && CAN_MOVE_SET.has(match[1].toLowerCase());
}

// What a site says about a file it will hand over, for a card that has no bytes yet.
// Boorus tag animations "animated" (plus "animated_gif" and the like). The tag counts only
// when the bytes the card will download are of a format that can move: a site may serve
// a JPEG sample of a moving original, and that JPEG does not move.
const MOVING_TAGS = new Set(['animated', 'animated_gif', 'animated_png', 'animated_webp']);
function taggedAsMoving(tags, format) {
  if (!CAN_MOVE_SET.has(String(format || '').toLowerCase())) return false;
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/\s+/);
  return list.some((tag) => MOVING_TAGS.has(String(tag).trim().toLowerCase()));
}

// --- GIF --------------------------------------------------------------------------
// A streaming walker: it is fed chunks in file order and counts image descriptors,
// which is what a frame is. It never looks inside the compressed image data, only at
// the length byte in front of each sub-block, so it needs no LZW decoder.
function createGifWalker() {
  let state = 'header';
  let fixed = [];      // bytes of a fixed-size structure being collected across chunks
  let want = 13;       // header (6) + logical screen descriptor (7)
  let skip = 0;        // bytes still to skip
  let after = 'block'; // state to resume once the skip is done
  let frames = 0;
  let done = false;
  let broken = false;

  const beginSkip = (count, next) => {
    if (count > 0) { skip = count; after = next; state = 'skip'; } else { state = next; }
  };

  function push(chunk) {
    const len = chunk.length;
    let i = 0;
    while (i < len && !done && !broken) {
      if (state === 'skip') {
        const step = Math.min(skip, len - i);
        i += step;
        skip -= step;
        if (skip === 0) state = after;
        continue;
      }
      if (state === 'header' || state === 'descriptor') {
        const step = Math.min(want - fixed.length, len - i);
        for (let k = 0; k < step; k++) fixed.push(chunk[i + k]);
        i += step;
        if (fixed.length < want) continue;
        if (state === 'header') {
          const magic = String.fromCharCode(...fixed.slice(0, 6));
          if (magic !== 'GIF87a' && magic !== 'GIF89a') { broken = true; break; }
          const packed = fixed[10];
          beginSkip((packed & 0x80) ? 3 * (1 << ((packed & 0x07) + 1)) : 0, 'block');
        } else {
          // Image descriptor after its 0x2C: position (4), size (4), packed (1). A local
          // colour table may follow, then one byte of LZW minimum code size.
          const packed = fixed[8];
          const table = (packed & 0x80) ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
          beginSkip(table + 1, 'sub-len');
        }
        continue;
      }
      const byte = chunk[i++];
      if (state === 'block') {
        if (byte === 0x21) state = 'ext-label';
        else if (byte === 0x2c) { frames += 1; fixed = []; want = 9; state = 'descriptor'; }
        else if (byte === 0x3b) done = true;
        else if (byte !== 0x00) broken = true; // 0x00: stray padding some encoders leave
      } else if (state === 'ext-label') {
        state = 'sub-len';
      } else if (state === 'sub-len') {
        if (byte === 0) state = 'block';
        else beginSkip(byte, 'sub-len');
      }
    }
  }

  return {
    push,
    get frames() { return frames; },
    get done() { return done; },
    get broken() { return broken; },
  };
}

async function gifMotion(head, readAt, { countFrames, maxScanBytes }) {
  const walker = createGifWalker();
  let position = 0;
  let chunk = head;
  for (;;) {
    walker.push(chunk);
    position += chunk.length;
    if (walker.broken || walker.done) break;
    if (!countFrames && walker.frames >= 2) break;
    if (chunk.length === 0 || position >= maxScanBytes) break;
    chunk = await readAt(position, Math.min(READ_CHUNK, maxScanBytes - position));
    if (chunk.length === 0) break; // end of file without a trailer: what is there, plays
  }
  const frames = walker.frames;
  if (frames >= 2) {
    // "Exact" only when the walk reached the end; the quick answer stops at two.
    const exact = walker.done || (countFrames && !walker.broken && position < maxScanBytes);
    return { format: 'gif', animated: true, frames: exact ? frames : null };
  }
  if (walker.done || walker.broken || position < maxScanBytes) {
    return { format: 'gif', animated: false, frames: frames || null };
  }
  return { format: 'gif', animated: null, frames: null }; // cap reached inside frame one
}

// --- PNG / APNG -------------------------------------------------------------------
// An animated PNG announces itself with an acTL chunk, which the format requires to
// come BEFORE the first IDAT. acTL carries the number of frames directly.
async function pngMotion(readAt) {
  let offset = 8;
  for (let n = 0; n < MAX_CHUNKS; n++) {
    const header = await readAt(offset, 16);
    if (header.length < 8) break;
    const size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    if (type === 'acTL') {
      if (header.length < 12) break;
      const frames = header.readUInt32BE(8);
      return { format: 'png', animated: frames >= 2, frames: frames >= 2 ? frames : 1 };
    }
    if (type === 'IDAT' || type === 'IEND') return { format: 'png', animated: false, frames: 1 };
    offset += 12 + size;
  }
  return { format: 'png', animated: null, frames: null };
}

// --- WebP -------------------------------------------------------------------------
// Only the extended layout (VP8X) can animate, and says so in a flag. Frames are the
// ANMF chunks; counting them reads each chunk's 8-byte header and jumps its payload.
async function webpMotion(head, readAt, { countFrames }) {
  if (head.length < 21 || head.toString('latin1', 12, 16) !== 'VP8X') {
    return { format: 'webp', animated: false, frames: 1 };
  }
  const animated = (head[20] & 0x02) !== 0;
  if (!animated) return { format: 'webp', animated: false, frames: 1 };
  if (!countFrames) return { format: 'webp', animated: true, frames: null };
  const riffEnd = 8 + head.readUInt32LE(4);
  let offset = 12;
  let frames = 0;
  for (let n = 0; n < MAX_CHUNKS && offset + 8 <= riffEnd; n++) {
    const header = await readAt(offset, 8);
    if (header.length < 8) break;
    const size = header.readUInt32LE(4);
    if (header.toString('latin1', 0, 4) === 'ANMF') frames += 1;
    offset += 8 + size + (size & 1);
  }
  return { format: 'webp', animated: true, frames: frames >= 2 ? frames : null };
}

// --- size -------------------------------------------------------------------------
// The picture's own pixel size, from the header already in hand (0 when this header
// does not say). The previews that stand for the desktop ask for the still frame at this
// size: the thumbnail helper scales a small picture UP to whatever it is asked for, and
// "Center" or "Tile" would then draw the frame bigger than the file itself.
function headerSize(format, head) {
  if (format === 'gif' && head.length >= 10) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  if (format === 'png' && head.length >= 24 && head.toString('latin1', 12, 16) === 'IHDR') {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (format === 'webp' && head.length >= 30 && head.toString('latin1', 12, 16) === 'VP8X') {
    return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
  }
  return { width: 0, height: 0 };
}

// --- files --------------------------------------------------------------------------
// { format, animated, frames, width, height }: `animated` is true, false, or null when
// the file could not be settled within the limits; `frames` is an exact count or null;
// the size is the header's (see headerSize).
async function readMotion(filePath, options = {}) {
  const countFrames = !!options.countFrames;
  const maxScanBytes = Number(options.maxScanBytes) > 0 ? Number(options.maxScanBytes) : MAX_SCAN_BYTES;
  const open = options.open || ((p) => fs.promises.open(p, 'r'));
  const handle = await open(filePath);
  try {
    const readAt = async (position, length) => {
      if (length <= 0) return Buffer.alloc(0);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const head = await readAt(0, Math.min(PROBE_BYTES, maxScanBytes));
    const format = sniffFormat(head);
    let answer;
    if (format === 'gif') answer = await gifMotion(head, readAt, { countFrames, maxScanBytes });
    else if (format === 'png') answer = await pngMotion(readAt);
    else if (format === 'webp') answer = await webpMotion(head, readAt, { countFrames });
    else answer = { format, animated: false, frames: null };
    return { ...answer, ...headerSize(format, head) };
  } finally {
    await handle.close().catch(() => {});
  }
}

// A path -> answer reader with a bounded LRU keyed by path, size and modification time,
// and in-flight dedup. Only extensions that can move are opened at all. A read that
// fails (a locked or vanished file, a disk that went away) is not remembered, so the
// next request tries again; a file that was read and settled is.
function createMotionReader(options = {}) {
  const statPath = options.statPath || ((p) => fs.promises.stat(p));
  const read = options.readMotion || readMotion;
  const requestedCap = Math.trunc(Number(options.cacheCap));
  const cacheCap = Number.isFinite(requestedCap) && requestedCap > 0 ? requestedCap : 4000;
  const cache = new Map();
  const pending = new Map();

  const remember = (key, value) => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheCap) cache.delete(cache.keys().next().value);
  };

  return async function motionOf(filePath, { countFrames = false } = {}) {
    if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return null;
    if (!mayMove(filePath)) return null;
    let stat;
    try { stat = await statPath(filePath); } catch { return null; }
    if (!stat || !stat.isFile()) return null;
    const base = `${process.platform === 'win32' ? filePath.toLowerCase() : filePath}|${Number(stat.size) || 0}|${Number(stat.mtimeMs) || 0}`;
    const known = cache.get(base);
    // A full answer serves a quick question; a quick one serves a full question only
    // when it already carries an exact count (APNG) or says the picture is still.
    if (known && (known.full || !countFrames || known.value.animated !== true || known.value.frames)) {
      return known.value;
    }
    const flightKey = `${base}|${countFrames ? 'full' : 'quick'}`;
    if (pending.has(flightKey)) return pending.get(flightKey);
    const job = Promise.resolve()
      .then(() => read(filePath, { countFrames }))
      .then((value) => {
        const current = cache.get(base);
        if (!current || countFrames || !current.full) remember(base, { value, full: countFrames });
        return value;
      })
      .catch(() => null)
      .finally(() => { pending.delete(flightKey); });
    pending.set(flightKey, job);
    return job;
  };
}

module.exports = {
  PROBE_BYTES,
  READ_CHUNK,
  MAX_SCAN_BYTES,
  CAN_MOVE,
  sniffFormat,
  displayName,
  mayMove,
  taggedAsMoving,
  createGifWalker,
  headerSize,
  readMotion,
  createMotionReader,
};
