'use strict';

// Pure image-header reader: pixel dimensions WITHOUT decoding the image.
//
// The details view needs an image's true resolution, which nothing else in Znada
// knows: thumb-info reports the generated thumbnail's size (clamped to 16..1024),
// and only downloaded online items ever carried real dimensions. Decoding a 4K
// original just to read two numbers is exactly the main-process work the thumbnail
// helper was created to avoid, so we parse the container header instead — a few
// bytes, no pixel work, no native dependency.
//
// Callers pass the first chunk of the file (see IMAGE_HEADER_BYTES); every parser
// bails out to { width: 0, height: 0 } when the buffer is short or malformed, and
// the caller renders that as "unknown" rather than failing.

// JPEG keeps its frame header after the metadata segments, which can be large when
// a file carries a colour profile or an embedded preview. 256 KB covers real-world
// photos; beyond that we report unknown instead of reading the whole file.
const IMAGE_HEADER_BYTES = 256 * 1024;

const EMPTY = { width: 0, height: 0 };

function result(width, height) {
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { ...EMPTY };
  return { width: w, height: h };
}

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(buf) {
  // IHDR must be the first chunk: length+type occupy 8..16, dimensions follow.
  if (buf.length < 24 || !startsWith(buf, PNG_SIGNATURE)) return null;
  if (String(buf.slice(12, 16).toString('latin1')) !== 'IHDR') return null;
  return result(buf.readUInt32BE(16), buf.readUInt32BE(20));
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  const magic = buf.slice(0, 6).toString('latin1');
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null;
  return result(buf.readUInt16LE(6), buf.readUInt16LE(8));
}

function bmpSize(buf) {
  if (buf.length < 18 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const dibSize = buf.readUInt32LE(14);
  if (dibSize === 12) {
    // OS/2 BITMAPCOREHEADER stores unsigned 16-bit dimensions.
    if (buf.length < 22) return null;
    return result(buf.readUInt16LE(18), buf.readUInt16LE(20));
  }
  if (dibSize < 40 || buf.length < 26) return null;
  // Windows BITMAPINFOHEADER and successors use signed 32-bit dimensions.
  // A negative height means top-down row order; the canvas height stays positive.
  return result(buf.readInt32LE(18), Math.abs(buf.readInt32LE(22)));
}

function webpSize(buf) {
  if (buf.length < 16 || !startsWith(buf, [0x52, 0x49, 0x46, 0x46]) /* RIFF */) return null;
  if (buf.slice(8, 12).toString('latin1') !== 'WEBP') return null;
  const chunk = buf.slice(12, 16).toString('latin1');
  if (chunk === 'VP8 ') {
    // Lossy: 14-bit dimensions after the start code.
    if (buf.length < 30 || !startsWith(buf, [0x9d, 0x01, 0x2a], 23)) return null;
    return result(buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit width/height packed into 4 bytes after the 0x2f signature.
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return result((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    // Extended: canvas size stored as 24-bit little-endian (value + 1).
    if (buf.length < 30) return null;
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return result(w + 1, h + 1);
  }
  return null;
}

// Markers that carry no payload length and must be skipped byte-wise.
const JPEG_STANDALONE = new Set([0xd8, 0x01]);
// SOF markers hold the frame size; DHT/JPG/DAC (c4/c8/cc) share the range but do not.
function isJpegFrameMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; } // resync past padding
    const marker = buf[offset + 1];
    if (marker === 0xff) { offset++; continue; }      // fill byte
    // A valid frame header precedes scan data. Never scan compressed entropy for
    // marker-looking bytes when a malformed JPEG reaches SOS without a frame.
    if (marker === 0xda || marker === 0xd9) return { ...EMPTY };
    if (JPEG_STANDALONE.has(marker) || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return { ...EMPTY };
    if (isJpegFrameMarker(marker)) {
      if (offset + 9 > buf.length) return { ...EMPTY };
      return result(buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5));
    }
    offset += 2 + length;
  }
  return { ...EMPTY }; // valid JPEG, frame header not within the provided chunk
}

const PARSERS = [pngSize, jpegSize, gifSize, bmpSize, webpSize];

// Returns { width, height }; zeros mean "not recognised / not in this chunk".
function readDimensions(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < 4) return { ...EMPTY };
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  for (const parse of PARSERS) {
    let value = null;
    try { value = parse(buf); } catch { value = null; } // truncated/garbage input
    if (value) return value;
  }
  return { ...EMPTY };
}

module.exports = {
  IMAGE_HEADER_BYTES,
  readDimensions,
  pngSize,
  jpegSize,
  gifSize,
  bmpSize,
  webpSize,
};
