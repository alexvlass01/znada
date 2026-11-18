'use strict';

// CODE-001 step 1.2. The fingerprint lookup as a service, driven with fake dependencies.
//
// The ORDER of the real sequence — fingerprint, journal, provider, merge, save — is proved
// through the real main.js in test/metadata-lookup-integration.test.js and its neighbours,
// which this move left untouched. What only a module test can show is what the move itself
// made possible to get wrong:
//   * the pool is read through getConfig() at the moment of use, because set-config
//     replaces the whole object and a reference kept from creation would go stale;
//   * every piece of state belongs to the instance: two instances share no budget and no
//     journal, so nothing outlives the test harness's unloadMain;
//   * the move freeze is asked AFTER the network answer, so a lookup that passed the door
//     before a move began still cannot write during it;
//   * the post-check stays in the service and refuses a post that does not carry our hash.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const library = require('../src/library');
const metadataLookup = require('../src/metadata-lookup');
const metadataStore = require('../src/metadata-store');
const libraryFreeze = require('../src/library-freeze');
const service = require('../src/metadata-lookup-service');
const { makeTempDir } = require('./helpers/temp-dir');

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); }
}

const BYTES = Buffer.from('a photo the user already has');
const HASH = crypto.createHash('md5').update(BYTES).digest('hex');

// One site that can be asked by fingerprint and needs no key, under the real id the
// planner knows; it records every question so a test can tell "asked" from "not asked".
function fakeSite(answer) {
  const site = {
    id: 'danbooru',
    status: 'active',
    credentials: { kind: 'none', required: false },
    capabilities: { fingerprints: ['md5'] },
    asked: [],
    async findByFingerprint(kind, hash, ctx) {
      site.asked.push(hash);
      return answer(kind, hash, ctx);
    },
  };
  return site;
}

function found(hash) {
  return { result: { provider: 'danbooru', postId: '42', page: 'https://danbooru.donmai.us/posts/42', md5: hash, author: 'someone', rating: 'general', tags: ['sky', 'cloud'] } };
}

function setup(name, opts = {}) {
  const dir = makeTempDir('znada-metasvc-' + name + '-');
  const photo = path.join(dir, 'photo.png');
  fs.writeFileSync(photo, BYTES);
  const config = { library: {} };
  const id = library.addPath(config.library, 'image', photo, { addedAt: 1 });
  const state = { config, saves: 0, moving: false, authorized: true };
  const site = opts.site || fakeSite(async (kind, hash) => found(hash));
  const svc = service.create({
    configPath: path.join(dir, 'config.json'),
    getConfig: () => state.config,
    library,
    lookup: metadataLookup,
    registry: { active: () => [site], byId: (pid) => (pid === site.id ? site : null) },
    providers: { credentials: () => null },
    userAgent: 'Znada/test',
    isAuthorizedItemPath: () => state.authorized,
    isMoveRunning: () => state.moving,
    savePoolOnly: () => { state.saves++; },
    ...(opts.deps || {}),
  });
  return { dir, photo, id, state, site, svc };
}

(async () => {
  // The service writes nothing to the network itself here; a real request would mean a
  // fake was bypassed, and that must fail loudly rather than reach a real host.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network in this test'); };
  try {
    {
      const { id, state, site, svc } = setup('happy');
      const reply = await svc.lookupItem(id);
      const item = library.getItem(state.config.library, id);
      ok('a found post is written onto the record and the pool is saved once',
        reply.status === 'found' && reply.addedTags === 2 && item.author === 'someone'
        && item.tags.includes('sky') && state.saves === 1 && site.asked.length === 1);
      svc.dispose();
    }

    {
      // set-config replaces the whole object. The service was created with the first one.
      const { id, state, svc } = setup('fresh-config');
      const replaced = { library: JSON.parse(JSON.stringify(state.config.library)) };
      state.config = replaced;
      const reply = await svc.lookupItem(id);
      ok('the pool is read at the moment of use, not the object it was created with',
        reply.status === 'found' && library.getItem(replaced.library, id).author === 'someone');
      svc.dispose();
    }

    {
      const { id, state, site, svc } = setup('denied');
      state.authorized = false;
      const reply = await svc.lookupItem(id);
      ok('a path nothing vouches for is refused before it is read or asked about',
        reply.status === 'error' && reply.reason === 'denied' && site.asked.length === 0
        && svc.cache().files && Object.keys(svc.cache().files).length === 0);
      svc.dispose();
    }

    {
      // The answer arrives while a move has started: the door was passed before it.
      let started;
      const { id, state, svc } = setup('move', {
        site: fakeSite(async (kind, hash) => { started(); return found(hash); }),
      });
      const begun = new Promise((resolve) => { started = resolve; });
      const pending = svc.lookupItem(id);
      await begun;
      state.moving = true;
      const reply = await pending;
      const item = library.getItem(state.config.library, id);
      ok('a write that lands during a move is refused with the freeze reason and nothing is saved',
        reply.status === 'error' && reply.reason === libraryFreeze.MOVE_RUNNING
        && state.saves === 0 && !item.author && item.tags.length === 0);
      state.moving = false;
      const again = await svc.lookupItem(id);
      ok('after the move the journal answers without asking the site again',
        again.status === 'found' && again.cached === true && state.saves === 1);
      svc.dispose();
    }

    {
      const { id, state, svc } = setup('mismatch', {
        site: fakeSite(async () => found('0'.repeat(32))),
      });
      const reply = await svc.lookupItem(id);
      ok('a post carrying another hash is not believed and writes nothing',
        reply.status === 'absent' && state.saves === 0
        && library.getItem(state.config.library, id).tags.length === 0);
      svc.dispose();
    }

    {
      // Two instances, as two harness loads of main.js would make. The site needs two
      // requests; the first instance's limiter holds the second one back for a minute,
      // far past the short gap worth waiting inside the worker. The second instance must
      // not notice anything the first one did.
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      const site = fakeSite(async (kind, hash, ctx) => {
        const first = await ctx.fetchJson('https://danbooru.donmai.us/posts.json');
        if (first.error) return first;
        const second = await ctx.fetchJson('https://danbooru.donmai.us/tags.json');
        return second.error ? second : found(hash);
      });
      // Both get a bucket of exactly two requests that will not refill within the test.
      // Both are configured BEFORE either asks anything: configuring clears the limiter, and
      // a clear after the first instance's lookup would hide a limiter the two shared.
      const a = setup('budget-a', { site });
      const b = setup('budget-b', { site });
      b.svc.setBudget({ ratePerMinute: 1, burst: 2, minGapMs: 0 });
      a.svc.setBudget({ ratePerMinute: 1, burst: 2, minGapMs: 60000 });
      const blocked = await a.svc.lookupItem(a.id);
      ok('our own limiter says busy and nothing is journalled',
        blocked.status === 'busy' && blocked.reason === 'gap'
        && Object.keys(a.svc.cache().lookups).length === 0);
      // A shared limiter would carry the token the first instance spent: one left, and the
      // site's second request refused.
      const other = await b.svc.lookupItem(b.id);
      ok('a second instance has its own budget and its own journal',
        other.status === 'found' && Object.keys(a.svc.cache().lookups).length === 0
        && Object.keys(b.svc.cache().lookups).length === 1);
      a.svc.dispose();
      b.svc.dispose();
    }

    {
      // PERF-007. The live maps are what the process holds. A second lookup must cut
      // them with the same age rule as the file on disk, and must not touch a tag the
      // person already wrote.
      const { id, state, site, svc } = setup('live-evict');
      library.addTag(state.config.library, id, 'mine');
      const first = await svc.lookupItem(id);
      const cache = svc.cache();
      for (let i = 0; i < metadataStore.FILE_LIMIT + 1000; i++) cache.files['flood-file-' + i] = { at: 1 };
      for (let i = 0; i < metadataStore.LOOKUP_LIMIT + 1000; i++) cache.lookups['flood-lookup-' + i] = { at: 1 };
      const second = await svc.lookupItem(id);
      const item = library.getItem(state.config.library, id);
      const journalKey = metadataLookup.journalKey('md5', HASH);
      ok('a flooded cache is cut on the next lookup and the user tag stays',
        first.status === 'found' && second.status === 'found' && second.cached === true
        && item.tags.includes('mine') && item.tags.includes('sky')
        && Object.keys(cache.files).length <= metadataStore.FILE_LIMIT
        && Object.keys(cache.lookups).length <= metadataStore.LOOKUP_LIMIT
        && !!cache.lookups[journalKey]
        && site.asked.length === 1);
      svc.dispose();
    }

    {
      const clock = {
        timers: [],
        setTimer(fn) {
          const timer = { fn, cleared: false, fired: false };
          this.timers.push(timer);
          return timer;
        },
        clearTimer(timer) { if (timer) timer.cleared = true; },
        fire() {
          for (const timer of this.timers.slice()) {
            if (!timer.cleared && !timer.fired) {
              timer.fired = true;
              timer.fn();
            }
          }
        },
      };
      const streams = [];
      const { dir, id, state, svc } = setup('stalled-read', {
        deps: {
          queueLimit: 4,
          jobTimeoutMs: 3000,
          hashTimeoutMs: 3000,
          setTimer: (fn) => clock.setTimer(fn),
          clearTimer: (timer) => clock.clearTimer(timer),
          createReadStream() {
            const stream = new EventEmitter();
            stream.destroyed = false;
            stream.destroy = () => { stream.destroyed = true; stream.emit('close'); };
            if (!streams.length) {
              streams.push(stream);
              return stream;
            }
            process.nextTick(() => {
              stream.emit('data', Buffer.from('the next photo'));
              stream.emit('end');
            });
            streams.push(stream);
            return stream;
          },
        },
      });
      const secondPath = path.join(dir, 'next.png');
      fs.writeFileSync(secondPath, Buffer.from('the next photo'));
      const secondId = library.addPath(state.config.library, 'image', secondPath, { addedAt: 2 });
      const firstJob = svc.lookupItem(id);
      const secondJob = svc.lookupItem(secondId);
      for (let i = 0; i < 20 && !streams.length; i++) await new Promise((resolve) => { setImmediate(resolve); });
      clock.fire();
      const timedOut = await firstJob;
      const followed = await secondJob;
      const firstItem = library.getItem(state.config.library, id);
      ok('a stalled file times out, releases the stream, and the next file is looked up',
        streams[0] && streams[0].destroyed === true
        && timedOut.status === 'error' && timedOut.reason === 'timeout'
        && firstItem.tags.length === 0
        && followed.status === 'found' && followed.addedTags === 2);
      svc.dispose();
    }

    {
      const clock = {
        timers: [],
        setTimer(fn) {
          const timer = { fn, cleared: false, fired: false };
          this.timers.push(timer);
          return timer;
        },
        clearTimer(timer) { if (timer) timer.cleared = true; },
        fire() {
          for (const timer of this.timers.slice()) {
            if (!timer.cleared && !timer.fired) {
              timer.fired = true;
              timer.fn();
            }
          }
        },
      };
      let opens = 0;
      const { dir, state, svc } = setup('queue-cap', {
        deps: {
          queueLimit: 2,
          jobTimeoutMs: 4000,
          hashTimeoutMs: 4000,
          setTimer: (fn) => clock.setTimer(fn),
          clearTimer: (timer) => clock.clearTimer(timer),
          createReadStream() {
            opens += 1;
            const stream = new EventEmitter();
            stream.destroyed = false;
            stream.destroy = () => { stream.destroyed = true; };
            return stream;
          },
        },
      });
      const ids = [];
      for (let i = 0; i < 23; i++) {
        const file = path.join(dir, 'cap-' + i + '.png');
        fs.writeFileSync(file, Buffer.from('cap-' + i));
        ids.push(library.addPath(state.config.library, 'image', file, { addedAt: 1 }));
      }
      const tracked = ids.map((itemId) => {
        const box = { done: false, reply: null };
        svc.lookupItem(itemId).then((reply) => { box.done = true; box.reply = reply; });
        return box;
      });
      for (let i = 0; i < 30 && (tracked.filter((box) => box.done).length < 20 || opens < 1); i++) {
        await new Promise((resolve) => { setImmediate(resolve); });
      }
      const busy = tracked.filter((box) => box.done);
      ok('lookups past the cap are busy and do not open another read (' + busy.length + ' busy, ' + opens + ' reads)',
        busy.length === 20
        && busy.every((box) => box.reply.status === 'busy' && box.reply.reason === 'queue')
        && opens === 1);
      for (let i = 0; i < 30 && tracked.some((box) => !box.done); i++) {
        clock.fire();
        await new Promise((resolve) => { setImmediate(resolve); });
      }
      svc.dispose();
    }

    {
      const clock = {
        timers: [],
        setTimer(fn) {
          const timer = { fn, cleared: false, fired: false };
          this.timers.push(timer);
          return timer;
        },
        clearTimer(timer) { if (timer) timer.cleared = true; },
        fire() {
          for (const timer of this.timers.slice()) {
            if (!timer.cleared && !timer.fired) {
              timer.fired = true;
              timer.fn();
            }
          }
        },
      };
      let stream = null;
      const { photo, svc } = setup('direct-fingerprint-timeout', {
        deps: {
          hashTimeoutMs: 2000,
          setTimer: (fn) => clock.setTimer(fn),
          clearTimer: (timer) => clock.clearTimer(timer),
          createReadStream() {
            stream = new EventEmitter();
            stream.destroyed = false;
            stream.destroy = () => { stream.destroyed = true; stream.emit('close'); };
            return stream;
          },
        },
      });
      const pending = svc.fingerprint(photo);
      for (let i = 0; i < 20 && !stream; i++) await new Promise((resolve) => { setImmediate(resolve); });
      clock.fire();
      const print = await pending;
      const files = svc.cache().files || {};
      ok('a direct fingerprint of a stalled file times out without caching a hash',
        print.error === 'timeout' && stream.destroyed === true
        && Object.keys(files).length === 0);
      svc.dispose();
    }

    {
      // Замечание независимой проверки PR #334: строку «отменено сигналом очереди» можно было убрать, и
      // набор оставался зелёным. Тогда отменённый запрос считался бы отказом сайта, и следующий вопрос
      // тому же сайту упёрся бы в штрафную паузу, хотя сайт ничего плохого не ответил.
      const clock = {
        timers: [],
        setTimer(fn) { const timer = { fn, cleared: false, fired: false }; this.timers.push(timer); return timer; },
        clearTimer(timer) { if (timer) timer.cleared = true; },
        fire() {
          for (const timer of this.timers.slice()) {
            if (!timer.cleared && !timer.fired) { timer.fired = true; timer.fn(); }
          }
        },
      };
      let hanging = true;
      globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
        if (!hanging) { resolve({ ok: true, status: 200, json: async () => ({}) }); return; }
        const signal = opts && opts.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
          }, { once: true });
        }
      });
      const site = fakeSite(async (kind, hash, ctx) => {
        const res = await ctx.fetchJson('https://danbooru.donmai.us/posts.json');
        return res.error ? res : found(hash);
      });
      const { id, svc } = setup('abort-no-penalty', {
        site,
        deps: {
          jobTimeoutMs: 4000,
          setTimer: (fn) => clock.setTimer(fn),
          clearTimer: (timer) => clock.clearTimer(timer),
        },
      });
      const pending = svc.lookupItem(id);
      for (let i = 0; i < 40; i++) await new Promise((resolve) => { setImmediate(resolve); });
      clock.fire();
      const cancelled = await pending;
      hanging = false;
      const next = await svc.lookupItem(id);
      ok('a lookup the queue cancelled leaves the site unpunished',
        cancelled.status === 'error' && next.status === 'found');
      svc.dispose();
    }

    ok('the hash check ignores case and surrounding space and refuses an empty side',
      service.postMatchesHash({ md5: ' ' + HASH.toUpperCase() + ' ' }, HASH)
      && !service.postMatchesHash({ md5: '' }, '')
      && !service.postMatchesHash({}, HASH)
      && !service.postMatchesHash(null, HASH));
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
