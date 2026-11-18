'use strict';

// LIB-031. The two halves of "this Online card is a photo you already have", each with
// its surroundings replaced: main's matcher (src/online-have.js) against a stand-in for
// the library pass, and the window's batching (renderer/online-have.js) against a
// stand-in for main. The real main.js is in test/online-have-main.test.js.

const assert = require('assert');
const Matcher = require('../src/online-have');
const OnlineHave = require('../renderer/online-have');
const OnlineAdd = require('../src/online-add');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const MD5_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MD5_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// The first bytes of a PNG of the given size: all that src/image-info.js reads.
function pngHeader(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function matcher(opts = {}) {
  const reads = [];
  const byHash = opts.byHash || {};
  const bySize = opts.bySize || {};
  const headers = opts.headers || {};
  const m = Matcher.create({
    finder: () => ({
      byHash: (h) => byHash[h] || '',
      bySize: (n) => (bySize[n] || []).slice(),
    }),
    readHeader: async (p) => {
      reads.push(p);
      if (!headers[p]) throw new Error('unreadable');
      return headers[p];
    },
    recordFor: (p) => (opts.records && opts.records[p]) || null,
    logger: { error() {} },
  });
  return { m, reads };
}

(async () => {
  // --- main: by fingerprint -------------------------------------------------------------
  {
    const { m } = matcher({
      byHash: { [MD5_A]: 'C:/watched/a.jpg', [MD5_B]: 'C:/znada/b.jpg' },
      records: { 'C:/znada/b.jpg': { id: 'rec-b', path: 'C:/znada/b.jpg' } },
    });
    const out = await m.match([
      { key: 'g1', md5: MD5_A },
      { key: 'g2', md5: MD5_B.toUpperCase() },
      { key: 'g3', md5: 'cccccccccccccccccccccccccccccccc' },
      { key: 'g4', md5: 'not a fingerprint' },
    ]);
    ok('a card is found by its fingerprint, with no record for a folder file',
      out.g1 && out.g1.path === 'C:/watched/a.jpg' && out.g1.id === '');
    ok('a found file that has a record brings its id, so the card acts on that record',
      out.g2 && out.g2.id === 'rec-b');
    ok('a fingerprint nobody has, or a malformed one, is "no"', out.g3 === null && out.g4 === null);
  }

  // --- main: by size and resolution -------------------------------------------------------
  {
    const { m, reads } = matcher({
      bySize: { 5000: ['C:/w/x.png', 'C:/w/y.png'], 7000: ['C:/w/z.png'] },
      byHash: {},
      headers: { 'C:/w/x.png': pngHeader(1920, 1080), 'C:/w/y.png': pngHeader(2560, 1440), 'C:/w/z.png': pngHeader(800, 600) },
    });
    const out = await m.match([
      { key: 'w1', fileSize: 5000, width: 2560, height: 1440 },
      { key: 'w2', fileSize: 5000, width: 1440, height: 2560 },
      { key: 'w3', fileSize: 7000, width: 800, height: 600, md5: MD5_A },
      { key: 'w4', fileSize: 6000, width: 800, height: 600 },
      { key: 'w5', fileSize: 7000, width: 0, height: 600 },
    ]);
    ok('without a fingerprint, the same size AND resolution is the same photo', out.w1 && out.w1.path === 'C:/w/y.png');
    ok('the same size with the resolution turned round is not', out.w2 === null);
    ok('a card that carries a fingerprint is judged by it alone, whatever the size says', out.w3 === null);
    ok('a size nobody has, or a card without a resolution, is "no"', out.w4 === null && out.w5 === null);
    const before = reads.length;
    await m.match([{ key: 'again', fileSize: 5000, width: 2560, height: 1440 }]);
    ok('a resolution once read is not read again', reads.length === before);
  }
  {
    const many = Array.from({ length: Matcher.MAX_SAME_SIZE + 1 }, (_, i) => `C:/w/${i}.png`);
    const { m, reads } = matcher({ bySize: { 10: many }, headers: {} });
    const out = await m.match([{ key: 'k', fileSize: 10, width: 1, height: 1 }]);
    ok('a size shared by too many files says nothing and reads nothing', out.k === null && reads.length === 0);
  }
  {
    const { m, reads } = matcher({ bySize: { 10: ['C:/w/gone.png'] }, headers: {} });
    await m.match([{ key: 'k', fileSize: 10, width: 1, height: 1 }]);
    await m.match([{ key: 'k', fileSize: 10, width: 1, height: 1 }]);
    ok('an unreadable file is not remembered as "no size" — it is tried again', reads.length === 2);
  }
  {
    const { m } = matcher({ byHash: { [MD5_A]: 'C:/a.jpg' } });
    const cards = Array.from({ length: Matcher.MAX_CARDS + 50 }, (_, i) => ({ key: 'k' + i, md5: MD5_A }));
    const out = await m.match(cards);
    ok('at most a few hundred cards are answered per call', Object.keys(out).length === Matcher.MAX_CARDS);
    ok('a broken request is an empty answer, not a throw',
      Object.keys(await m.match('nope')).length === 0 && Object.keys(await m.match([null, { md5: MD5_A }])).length === 0);
  }

  // --- the button: a found file is a downloaded photo -------------------------------------
  {
    const pool = { r1: { id: 'r1', type: 'image', path: 'C:/znada/r1.jpg', source: 'https://site/post/1' } };
    const found = { 'https://site/post/2': { path: 'C:/watched/two.jpg', id: '' }, 'https://site/post/3': { path: 'C:/znada/r1.jpg', id: 'r1' } };
    const have = { lookup: (kind, item) => found[item.page] || null };
    const two = OnlineAdd.buttonState(pool, 'internet', { page: 'https://site/post/2' }, null, have);
    ok('a card the user has as a folder file shows as added, and taking it out goes by its path',
      two.added && two.action === 'remove' && two.glyph === '✓' && two.pooled.path === 'C:/watched/two.jpg'
      && OnlineAdd.removalPayload(two.pooled)[0].path === 'C:/watched/two.jpg');
    ok('a found file that has a record is that record',
      OnlineAdd.pooledItem(pool, 'internet', { page: 'https://site/post/3' }, have) === pool.r1);
    ok('the download marker comes first',
      OnlineAdd.pooledItem(pool, 'internet', { page: 'https://site/post/1' }, { lookup: () => ({ path: 'C:/other.jpg', id: '' }) }) === pool.r1);
    ok('a card nobody has stays "+"', OnlineAdd.buttonState(pool, 'internet', { page: 'https://site/post/9' }, null, have).action === 'add');
    ok('without the answers the button behaves as before', OnlineAdd.buttonState(pool, 'internet', { page: 'https://site/post/2' }, null).action === 'add');
  }

  // --- the window: one batch, asked again when the library changes -------------------------
  function windowSide(reply) {
    const asked = [];
    const pending = new Map();
    let next = 1;
    let changes = 0;
    const have = OnlineHave.create({
      ask: async (cards) => { asked.push(cards.map((c) => c.key)); return reply(cards); },
      onChange: () => { changes += 1; },
      timers: { setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id; }, clearTimeout: (id) => pending.delete(id) },
    });
    async function fire() {
      const fns = Array.from(pending.values());
      pending.clear();
      for (const fn of fns) fn();
      await new Promise((r) => { setImmediate(r); });
      await new Promise((r) => { setImmediate(r); });
    }
    return { have, asked, pending, fire, changes: () => changes };
  }
  {
    let owned = new Set(['https://site/post/1']);
    const w = windowSide((cards) => Object.fromEntries(cards.map((c) => [c.key, owned.has(c.key) ? { path: 'C:/f/' + c.key.slice(-1) + '.jpg', id: '' } : null])));
    w.have.want('internet', { page: 'https://site/post/1', md5: MD5_A });
    w.have.want('internet', { page: 'https://site/post/2', md5: MD5_B });
    w.have.want('internet', { page: 'https://site/post/3', fileSize: 100, width: 10, height: 10 });
    w.have.want('internet', { page: 'https://site/post/4' });
    ok('cards drawn together are asked in one batch, nothing asked before the pause', w.asked.length === 0 && w.pending.size === 1);
    await w.fire();
    ok('only cards main can match are asked',
      w.asked.length === 1 && w.asked[0].length === 3 && !w.asked[0].includes('https://site/post/4'));
    ok('the answer is what the button reads', w.have.lookup('internet', { page: 'https://site/post/1' }).path === 'C:/f/1.jpg'
      && w.have.lookup('internet', { page: 'https://site/post/2' }) === null);
    ok('a "yes" redraws the cards', w.changes() === 1);

    w.have.want('internet', { page: 'https://site/post/1', md5: MD5_A });
    ok('a card drawn again is not asked again', w.pending.size === 0);

    owned = new Set(['https://site/post/2']);
    w.have.refresh();
    ok('until the new answer arrives, the old one stays on screen', w.have.lookup('internet', { page: 'https://site/post/1' }) !== null);
    await w.fire();
    ok('after the library changed every remembered card is asked again',
      w.asked.length === 2 && w.asked[1].length === 3);
    ok('and the new answers replace the old', w.have.lookup('internet', { page: 'https://site/post/1' }) === null
      && w.have.lookup('internet', { page: 'https://site/post/2' }).path === 'C:/f/2.jpg' && w.changes() === 2);
  }
  {
    // An answer asked for before the library changed arrives after: it is not used.
    let release;
    const w = windowSide(() => new Promise((r) => { release = () => r({ 'https://site/post/1': { path: 'C:/old.jpg', id: '' } }); }));
    w.have.want('internet', { page: 'https://site/post/1', md5: MD5_A });
    await w.fire();
    w.have.refresh();
    release();
    await new Promise((r) => { setImmediate(r); });
    ok('a stale answer is thrown away', w.have.lookup('internet', { page: 'https://site/post/1' }) === null);
  }
  {
    const w = windowSide(() => ({}));
    for (let i = 0; i < OnlineHave.KEEP + 20; i++) w.have.want('internet', { page: 'https://site/p/' + i, md5: MD5_A });
    ok('an endless feed keeps only the latest cards', w.have.size() === OnlineHave.KEEP);
    await w.fire();
    ok('and asks main in batches it accepts', w.asked.every((b) => b.length <= OnlineHave.BATCH) && w.asked.length === 2);
  }
  {
    // In the window, setTimeout called as a method of another object throws "Illegal
    // invocation" — the live app found this when the default timers were { setTimeout }.
    // The module is run here with timers that refuse the same way, and no timers passed.
    const vm = require('vm');
    const fs = require('fs');
    const path = require('path');
    let fired = 0;
    const ctx = {
      OnlineAdd,
      setTimeout: function strictTimer(fn) {
        if (this !== undefined && this !== ctx) throw new TypeError('Illegal invocation');
        fired += 1;
        fn();
        return 1;
      },
      clearTimeout: function strictClear() {
        if (this !== undefined && this !== ctx) throw new TypeError('Illegal invocation');
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'online-have.js'), 'utf8'), ctx);
    const asked = [];
    const have = ctx.OnlineHave.create({ ask: async (cards) => { asked.push(cards); return {}; } });
    have.want('internet', { page: 'https://site/post/1', md5: MD5_A });
    have.refresh();
    await new Promise((r) => { setImmediate(r); });
    ok('with the window\'s own timers, drawing a card and re-asking do not throw', fired >= 1 && asked.length >= 1);
  }
  {
    const have = OnlineHave.create({ ask: null });
    have.want('internet', { page: 'https://site/post/1', md5: MD5_A });
    await have.flushNow();
    ok('without main to ask (the browser preview), every card is simply "no"', have.lookup('internet', { page: 'https://site/post/1' }) === null);
  }

  console.log(`\nAll ${passed} online-have tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
