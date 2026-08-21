'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../src/image-info');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

// --- builders for synthetic headers -------------------------------------
function pngHeader(w, h) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function jpegHeader(w, h, { marker = 0xc0, pad = 0 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (pad > 0) {
    // APP0-style segment that must be skipped via its length field
    const seg = Buffer.alloc(4 + pad);
    seg[0] = 0xff; seg[1] = 0xe0;
    seg.writeUInt16BE(2 + pad, 2);
    parts.push(seg);
  }
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = marker;
  sof.writeUInt16BE(8, 2);   // segment length
  sof[4] = 8;                // sample precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

function gifHeader(w, h, magic = 'GIF89a') {
  const buf = Buffer.alloc(10);
  buf.write(magic, 0, 'latin1');
  buf.writeUInt16LE(w, 6);
  buf.writeUInt16LE(h, 8);
  return buf;
}

function bmpHeader(w, h) {
  const buf = Buffer.alloc(26);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  return buf;
}

function bmpCoreHeader(w, h) {
  const buf = Buffer.alloc(22);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(12, 14);
  buf.writeUInt16LE(w, 18);
  buf.writeUInt16LE(h, 20);
  return buf;
}

function webpHeader(kind, w, h) {
  const buf = Buffer.alloc(32);
  buf.write('RIFF', 0, 'latin1');
  buf.write('WEBP', 8, 'latin1');
  buf.write(kind, 12, 'latin1');
  if (kind === 'VP8 ') {
    buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a;
    buf.writeUInt16LE(w, 26);
    buf.writeUInt16LE(h, 28);
  } else if (kind === 'VP8L') {
    buf[20] = 0x2f;
    buf.writeUInt32LE(((h - 1) << 14) | (w - 1), 21);
  } else if (kind === 'VP8X') {
    const w1 = w - 1; const h1 = h - 1;
    buf[24] = w1 & 0xff; buf[25] = (w1 >> 8) & 0xff; buf[26] = (w1 >> 16) & 0xff;
    buf[27] = h1 & 0xff; buf[28] = (h1 >> 8) & 0xff; buf[29] = (h1 >> 16) & 0xff;
  }
  return buf;
}

// --- format coverage ----------------------------------------------------
const png = I.readDimensions(pngHeader(1920, 1080));
ok('PNG: IHDR dimensions', png.width === 1920 && png.height === 1080);

const jpg = I.readDimensions(jpegHeader(2400, 1600));
ok('JPEG: SOF0 dimensions (width/height order)', jpg.width === 2400 && jpg.height === 1600);
ok('JPEG: skips metadata segments by length', (() => {
  const r = I.readDimensions(jpegHeader(800, 600, { pad: 5000 }));
  return r.width === 800 && r.height === 600;
})());
ok('JPEG: progressive SOF2 is also read', (() => {
  const r = I.readDimensions(jpegHeader(640, 480, { marker: 0xc2 }));
  return r.width === 640 && r.height === 480;
})());
ok('JPEG: DHT (c4) is not mistaken for a frame header', (() => {
  const dht = Buffer.alloc(6); dht[0] = 0xff; dht[1] = 0xc4; dht.writeUInt16BE(4, 2);
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, jpegHeader(320, 200).slice(2)]);
  const r = I.readDimensions(buf);
  return r.width === 320 && r.height === 200;
})());

const gif = I.readDimensions(gifHeader(500, 300));
ok('GIF: little-endian screen descriptor', gif.width === 500 && gif.height === 300);
ok('GIF: 87a signature also accepted', I.readDimensions(gifHeader(12, 34, 'GIF87a')).width === 12);

const bmp = I.readDimensions(bmpHeader(1024, 768));
ok('BMP: DIB header dimensions', bmp.width === 1024 && bmp.height === 768);
ok('BMP: top-down (negative height) reported positive', I.readDimensions(bmpHeader(64, -48)).height === 48);
ok('BMP: OS/2 core header dimensions', (() => {
  const r = I.readDimensions(bmpCoreHeader(320, 200));
  return r.width === 320 && r.height === 200;
})());
ok('BMP: unknown short DIB headers are rejected', (() => {
  const buf = bmpHeader(100, 50);
  buf.writeUInt32LE(16, 14);
  return I.readDimensions(buf).width === 0;
})());

ok('WebP: lossy VP8', (() => { const r = I.readDimensions(webpHeader('VP8 ', 1280, 720)); return r.width === 1280 && r.height === 720; })());
ok('WebP: lossless VP8L', (() => { const r = I.readDimensions(webpHeader('VP8L', 300, 200)); return r.width === 300 && r.height === 200; })());
ok('WebP: extended VP8X', (() => { const r = I.readDimensions(webpHeader('VP8X', 4096, 2160)); return r.width === 4096 && r.height === 2160; })());
ok('WebP: malformed VP8 start code is rejected', (() => {
  const buf = webpHeader('VP8 ', 1280, 720);
  buf[23] = 0;
  const r = I.readDimensions(buf);
  return r.width === 0 && r.height === 0;
})());

// --- robustness ---------------------------------------------------------
ok('unknown format returns zeros, not a throw', (() => {
  const r = I.readDimensions(Buffer.from('not an image at all', 'latin1'));
  return r.width === 0 && r.height === 0;
})());
ok('empty/short/absent input is safe', (() => {
  return I.readDimensions(Buffer.alloc(0)).width === 0
    && I.readDimensions(null).width === 0
    && I.readDimensions(undefined).height === 0
    && I.readDimensions(Buffer.from([0x89, 0x50])).width === 0;
})());
ok('truncated PNG does not report a size', I.readDimensions(pngHeader(10, 10).slice(0, 18)).width === 0);
ok('JPEG whose frame header is past the chunk reports unknown', (() => {
  const r = I.readDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  return r.width === 0 && r.height === 0;
})());
ok('JPEG does not scan entropy after SOS for a false frame marker', (() => {
  const r = I.readDimensions(Buffer.from([
    0xff, 0xd8, 0xff, 0xda, 0x00, 0x02,
    0xff, 0xc0, 0x00, 0x08, 0x08, 0x02, 0x58, 0x03, 0x20,
  ]));
  return r.width === 0 && r.height === 0;
})());
ok('zero dimensions are treated as unknown', I.readDimensions(pngHeader(0, 100)).width === 0);
ok('accepts a plain Uint8Array', (() => {
  const r = I.readDimensions(Uint8Array.from(pngHeader(7, 9)));
  return r.width === 7 && r.height === 9;
})());
ok('header budget is bounded', I.IMAGE_HEADER_BYTES > 0 && I.IMAGE_HEADER_BYTES <= 1024 * 1024);

// --- real files shipped with the app ------------------------------------
const assetsDir = path.join(__dirname, '..', 'assets');
const realPngs = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter((f) => f.toLowerCase().endsWith('.png')).slice(0, 5)
  : [];
ok('real PNG assets report plausible sizes', realPngs.length > 0 && realPngs.every((name) => {
  const fd = fs.openSync(path.join(assetsDir, name), 'r');
  const buf = Buffer.alloc(I.IMAGE_HEADER_BYTES);
  const read = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const { width, height } = I.readDimensions(buf.slice(0, read));
  return width > 0 && height > 0 && width <= 8192 && height <= 8192;
}));
console.log(`     (checked ${realPngs.length} real asset PNG(s))`);

console.log('\nAll ' + passed + ' image-info tests passed.');
