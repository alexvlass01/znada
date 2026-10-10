'use strict';

// BUG-035. Does a picture move — read from its bytes, never from its name.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const motion = require('../src/image-motion');

let checks = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    await fn();
    checks += 1;
    console.log(`  ok ${name}`);
  });
}

// --- tiny file builders -------------------------------------------------------------
const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
const u16le = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);

// A GIF with `frames` frames. `dataBytes` pads each frame's compressed data with
// sub-blocks, so a first frame can be made longer than the first read.
function gif(frames, { dataBytes = 4, trailer = true, localTable = false, loop = true, width = 2, height = 2 } = {}) {
  const parts = [Buffer.from('GIF89a'), u16le(width), u16le(height), Buffer.from([0x80, 0, 0]), Buffer.alloc(6)];
  if (loop) parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0'), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));
  for (let f = 0; f < frames; f++) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00])); // graphic control
    parts.push(Buffer.from([0x2c]), u16le(0), u16le(0), u16le(2), u16le(2), Buffer.from([localTable ? 0x80 : 0x00]));
    if (localTable) parts.push(Buffer.alloc(6));
    parts.push(Buffer.from([0x02])); // LZW minimum code size
    let left = dataBytes;
    while (left > 0) {
      const n = Math.min(255, left);
      parts.push(Buffer.from([n]), Buffer.alloc(n, 0x4c));
      left -= n;
    }
    parts.push(Buffer.from([0x00])); // block terminator
  }
  if (trailer) parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return bytes(len, type, data, Buffer.alloc(4)); // CRC is not checked here
}
function png({ frames = 0, filler = 0, width = 640, height = 360 } = {}) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  const ihdr = pngChunk('IHDR', ihdrData);
  const parts = [sig, ihdr];
  if (filler) parts.push(pngChunk('tEXt', Buffer.alloc(filler, 0x61)));
  if (frames) {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(frames, 0);
    parts.push(pngChunk('acTL', actl));
  }
  parts.push(pngChunk('IDAT', Buffer.alloc(10)), pngChunk('IEND'));
  return Buffer.concat(parts);
}

function riffChunk(type, size, payloadFill = 0) {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(size, 4);
  return Buffer.concat([head, Buffer.alloc(size + (size & 1), payloadFill)]);
}
function webp({ extended = false, flags = 0, frames = 0, oddPayload = false, width = 800, height = 600 } = {}) {
  const chunks = [];
  if (!extended) {
    chunks.push(riffChunk('VP8 ', 10));
  } else {
    const vp8x = riffChunk('VP8X', 10);
    vp8x[8] = flags;
    vp8x.writeUIntLE(width - 1, 12, 3); // canvas size is stored minus one
    vp8x.writeUIntLE(height - 1, 15, 3);
    chunks.push(vp8x);
    if (frames) chunks.push(riffChunk('ANIM', 6));
    for (let f = 0; f < frames; f++) chunks.push(riffChunk('ANMF', oddPayload ? 17 : 16));
  }
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-motion-'));
let fileNo = 0;
function file(name, content) {
  const p = path.join(dir, `${fileNo++}-${name}`);
  fs.writeFileSync(p, content);
  return p;
}

// --- format sniffing --------------------------------------------------------------
check('the format is read from the bytes, not the name', () => {
  assert.strictEqual(motion.sniffFormat(gif(1)), 'gif');
  assert.strictEqual(motion.sniffFormat(png()), 'png');
  assert.strictEqual(motion.sniffFormat(webp()), 'webp');
  assert.strictEqual(motion.sniffFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.strictEqual(motion.sniffFormat(Buffer.from('BM\0\0\0\0')), 'bmp');
  assert.strictEqual(motion.sniffFormat(Buffer.from('nope')), '');
  assert.strictEqual(motion.sniffFormat(null), '');
});

check('only extensions that can move are ever opened', () => {
  for (const p of ['C:\\a\\b.gif', 'C:\\a\\b.PNG', 'C:\\a\\b.webp']) assert.ok(motion.mayMove(p), p);
  for (const p of ['C:\\a\\b.jpg', 'C:\\a\\b.jpeg', 'C:\\a\\b.bmp', 'C:\\a\\gif', '']) assert.ok(!motion.mayMove(p), p);
});

check('a site\'s "animated" tag counts only for bytes that can move', () => {
  assert.strictEqual(motion.taggedAsMoving(['1girl', 'animated'], 'gif'), true);
  assert.strictEqual(motion.taggedAsMoving('sky animated_png', 'PNG'), true, 'a space-separated tag string');
  assert.strictEqual(motion.taggedAsMoving(['animated'], 'jpg'), false, 'a JPEG sample of a moving original is still');
  assert.strictEqual(motion.taggedAsMoving(['video', 'sound'], 'gif'), false, 'only the animation tags count');
  assert.strictEqual(motion.taggedAsMoving(null, 'gif'), false);
});

check('each moving format has a name a person can read', () => {
  assert.strictEqual(motion.displayName('gif'), 'GIF');
  assert.strictEqual(motion.displayName('png'), 'APNG', 'an animated PNG must not read as a still "PNG"');
  assert.strictEqual(motion.displayName('webp'), 'WEBP');
});

// --- GIF --------------------------------------------------------------------------
check('the GIF walker counts frames without decoding, whatever the chunking', () => {
  for (const data of [gif(1), gif(3), gif(5, { localTable: true }), gif(2, { dataBytes: 700 })]) {
    const whole = motion.createGifWalker();
    whole.push(data);
    const bytewise = motion.createGifWalker();
    for (const b of data) bytewise.push(Buffer.from([b]));
    assert.strictEqual(bytewise.frames, whole.frames);
    assert.ok(whole.done && bytewise.done, 'the trailer is reached');
  }
  const three = motion.createGifWalker();
  three.push(gif(3));
  assert.strictEqual(three.frames, 3);
  const garbage = motion.createGifWalker();
  garbage.push(Buffer.from('GIF89a\x02\x00\x02\x00\x00\x00\x00\x99'));
  assert.ok(garbage.broken, 'an unknown block stops the walk instead of looping');
});

check('a one-frame GIF is still, a GIF with two frames moves', async () => {
  const still = await motion.readMotion(file('still.gif', gif(1)));
  assert.deepStrictEqual(still, { format: 'gif', animated: false, frames: 1, width: 2, height: 2 });
  // A small file fits the first read whole, so even the quick answer reaches the end.
  const moving = await motion.readMotion(file('moving.gif', gif(3)));
  assert.deepStrictEqual(moving, { format: 'gif', animated: true, frames: 3, width: 2, height: 2 });
  // A long one: the quick answer stops at the second frame and does not guess a count.
  const long = gif(3, { dataBytes: motion.PROBE_BYTES * 2 });
  const quick = await motion.readMotion(file('long.gif', long));
  assert.deepStrictEqual(quick, { format: 'gif', animated: true, frames: null, width: 2, height: 2 });
  const counted = await motion.readMotion(file('counted.gif', long), { countFrames: true });
  assert.deepStrictEqual(counted, { format: 'gif', animated: true, frames: 3, width: 2, height: 2 });
});

check('a first frame longer than the first read is walked through', async () => {
  const big = gif(2, { dataBytes: motion.PROBE_BYTES * 3 });
  assert.ok(big.length > motion.PROBE_BYTES * 3);
  const answer = await motion.readMotion(file('big.gif', big));
  assert.strictEqual(answer.animated, true);
});

check('past the scan cap inside frame one the answer is unknown, not a guess', async () => {
  const big = gif(2, { dataBytes: 20000 });
  const answer = await motion.readMotion(file('capped.gif', big), { maxScanBytes: 5000 });
  assert.deepStrictEqual(answer, { format: 'gif', animated: null, frames: null, width: 2, height: 2 });
});

check('a GIF cut short still counts what it has', async () => {
  const cut = await motion.readMotion(file('cut.gif', gif(2, { trailer: false })), { countFrames: true });
  assert.deepStrictEqual(cut, { format: 'gif', animated: true, frames: 2, width: 2, height: 2 });
  const cutStill = await motion.readMotion(file('cut-still.gif', gif(1, { trailer: false })));
  assert.strictEqual(cutStill.animated, false);
});

// --- PNG / APNG ---------------------------------------------------------------------
check('a PNG moves only when it announces two or more frames before its image data', async () => {
  assert.deepStrictEqual(await motion.readMotion(file('still.png', png())), { format: 'png', animated: false, frames: 1, width: 640, height: 360 });
  assert.deepStrictEqual(await motion.readMotion(file('apng.png', png({ frames: 12 }))), { format: 'png', animated: true, frames: 12, width: 640, height: 360 });
  assert.deepStrictEqual(await motion.readMotion(file('one.png', png({ frames: 1 }))), { format: 'png', animated: false, frames: 1, width: 640, height: 360 });
});

check('metadata longer than the first read does not hide an APNG', async () => {
  const answer = await motion.readMotion(file('long-meta.png', png({ frames: 4, filler: motion.PROBE_BYTES * 2 })));
  assert.deepStrictEqual(answer, { format: 'png', animated: true, frames: 4, width: 640, height: 360 });
});

// --- WebP -------------------------------------------------------------------------
check('only an extended WebP with the animation flag moves', async () => {
  assert.strictEqual((await motion.readMotion(file('simple.webp', webp()))).animated, false);
  assert.strictEqual((await motion.readMotion(file('alpha.webp', webp({ extended: true, flags: 0x10 })))).animated, false);
  const quick = await motion.readMotion(file('anim.webp', webp({ extended: true, flags: 0x02, frames: 3 })));
  assert.deepStrictEqual(quick, { format: 'webp', animated: true, frames: null, width: 800, height: 600 });
});

check('WebP frames are counted by chunk, odd payloads padded', async () => {
  const even = await motion.readMotion(file('even.webp', webp({ extended: true, flags: 0x12, frames: 4 })), { countFrames: true });
  assert.deepStrictEqual(even, { format: 'webp', animated: true, frames: 4, width: 800, height: 600 });
  const odd = await motion.readMotion(file('odd.webp', webp({ extended: true, flags: 0x02, frames: 3, oddPayload: true })), { countFrames: true });
  assert.strictEqual(odd.frames, 3);
});

check('a JPEG or an unknown file is simply still', async () => {
  assert.deepStrictEqual(await motion.readMotion(file('photo.gif', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))), { format: 'jpg', animated: false, frames: null, width: 0, height: 0 });
  assert.deepStrictEqual(await motion.readMotion(file('junk.gif', Buffer.from('not an image'))), { format: '', animated: false, frames: null, width: 0, height: 0 });
});

// --- size ---------------------------------------------------------------------------
check('the picture\'s own size is read from each format\'s header', () => {
  assert.deepStrictEqual(motion.headerSize('gif', gif(2, { width: 1920, height: 1080 })), { width: 1920, height: 1080 });
  assert.deepStrictEqual(motion.headerSize('png', png({ frames: 3, width: 70000, height: 5 })), { width: 70000, height: 5 });
  assert.deepStrictEqual(motion.headerSize('webp', webp({ extended: true, flags: 0x02, width: 3840, height: 2160 })), { width: 3840, height: 2160 });
  // A simple (VP8) WebP keeps its size elsewhere, and cannot move anyway: unknown is fine.
  assert.deepStrictEqual(motion.headerSize('webp', webp()), { width: 0, height: 0 });
  assert.deepStrictEqual(motion.headerSize('gif', Buffer.from('GIF89a')), { width: 0, height: 0 }, 'a cut header is not read past its end');
  assert.deepStrictEqual(motion.headerSize('jpg', Buffer.alloc(64)), { width: 0, height: 0 });
});

// --- the cached reader --------------------------------------------------------------
check('the reader answers from its cache until the file changes', async () => {
  let reads = 0;
  let size = 100;
  const reader = motion.createMotionReader({
    statPath: async () => ({ isFile: () => true, size, mtimeMs: 1 }),
    readMotion: async () => { reads += 1; return { format: 'gif', animated: true, frames: null }; },
  });
  await reader('C:\\x\\a.gif');
  await reader('C:\\x\\a.gif');
  assert.strictEqual(reads, 1);
  size = 101;
  await reader('C:\\x\\a.gif');
  assert.strictEqual(reads, 2, 'a replaced file is read again');
});

check('two questions at once share one read; a failed read is not remembered', async () => {
  let reads = 0;
  let fail = true;
  const reader = motion.createMotionReader({
    statPath: async () => ({ isFile: () => true, size: 1, mtimeMs: 1 }),
    readMotion: async () => {
      reads += 1;
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      if (fail) throw new Error('locked');
      return { format: 'png', animated: true, frames: 7 };
    },
  });
  const [a, b] = await Promise.all([reader('C:\\x\\b.png'), reader('C:\\x\\b.png')]);
  assert.strictEqual(reads, 1);
  assert.strictEqual(a, null);
  assert.strictEqual(b, null);
  fail = false;
  assert.deepStrictEqual(await reader('C:\\x\\b.png'), { format: 'png', animated: true, frames: 7 });
  assert.strictEqual(reads, 2, 'the failure was not cached');
});

check('a quick answer is upgraded to a full count only when a count is missing', async () => {
  const asked = [];
  const reader = motion.createMotionReader({
    statPath: async () => ({ isFile: () => true, size: 1, mtimeMs: 1 }),
    readMotion: async (p, opts) => {
      asked.push(!!opts.countFrames);
      return opts.countFrames ? { format: 'gif', animated: true, frames: 9 } : { format: 'gif', animated: true, frames: null };
    },
  });
  await reader('C:\\x\\c.gif');
  assert.deepStrictEqual(await reader('C:\\x\\c.gif', { countFrames: true }), { format: 'gif', animated: true, frames: 9 });
  assert.deepStrictEqual(await reader('C:\\x\\c.gif'), { format: 'gif', animated: true, frames: 9 }, 'the full answer now serves quick questions');
  assert.deepStrictEqual(asked, [false, true]);
});

check('a still picture or a still extension never costs a full read', async () => {
  let reads = 0;
  let stats = 0;
  const reader = motion.createMotionReader({
    statPath: async () => { stats += 1; return { isFile: () => true, size: 1, mtimeMs: 1 }; },
    readMotion: async () => { reads += 1; return { format: 'gif', animated: false, frames: 1 }; },
  });
  assert.strictEqual(await reader('C:\\x\\photo.jpg'), null);
  assert.strictEqual(stats, 0, 'a JPEG is not even looked at');
  await reader('C:\\x\\still.gif');
  await reader('C:\\x\\still.gif', { countFrames: true });
  assert.strictEqual(reads, 1);
});

(async () => {
  try {
    for (const run of pending) await run();
    console.log(`PASS image-motion: ${checks} checks`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
