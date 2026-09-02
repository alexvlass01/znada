'use strict';

// META-001 through the REAL main.js, over a real profile directory, with only the
// network stubbed.
//
// The module suites prove each piece is correct on its own. What they cannot see is the
// ORDER main.js runs them in, what it saves afterwards, and what it re-checks before
// writing — which is exactly where every defect in this project's last four review
// rounds actually lived. So this file asserts on files and config after the fact, and
// counts the requests that went out.
//
// One thing this deliberately does NOT assert: WHICH catalogue answered. Gelbooru is
// only reachable in a build that carries credentials, so on a machine without the key
// file the same behaviour arrives via Danbooru. Pinning the provider would make the
// suite pass or fail on whether a gitignored file happens to be present.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');
const library = require('../src/library');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const PIXELS = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HASH = crypto.createHash('md5').update(PIXELS).digest('hex');

// A post that both adapters can be fed: each reads only the fields it knows. The
// rating is the one field they spell differently — Gelbooru sends the word, Danbooru a
// single letter — so it is passed in rather than guessed.
function postFor(hash, rating) {
  return {
    id: 4242,
    md5: hash,
    rating,
    file_ext: 'png',
    tags: '1girl sky artist_name highres',
    tag_string: '1girl sky artist_name highres',
    tag_string_artist: 'artist_name',
    tag_string_general: '1girl sky',
    tag_string_meta: 'highres',
  };
}

// The network, replaced. Records every URL so the tests can count real traffic, and
// answers both hosts so the run is identical with or without bundled credentials.
function installFetch(plan) {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    urls.push(target);
    const answer = plan(target, urls.length);
    if (answer === 'boom') throw Object.assign(new Error('offline'), { name: 'TypeError' });
    if (typeof answer === 'number') return { ok: false, status: answer, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

// Both providers' "here is the post" shape, plus Gelbooru's separate tag-kind endpoint.
function answerFound(target, hash) {
  if (target.includes('s=tag')) {
    return { tag: [{ name: 'artist_name', type: 1 }, { name: 'highres', type: 5 }, { name: 'sky', type: 0 }] };
  }
  if (target.includes('gelbooru.com')) return { post: [postFor(hash, 'questionable')] };
  return [postFor(hash, 'q')];
}

function answerEmpty(target) {
  if (target.includes('s=tag')) return { tag: [] };
  if (target.includes('gelbooru.com')) return { post: [] };
  return [];
}

function setup(label, itemOver = {}) {
  const userData = makeTempProfile(label);
  const photo = path.join(userData, 'wallpapers', 'wp-known.png');
  fs.writeFileSync(photo, PIXELS);
  // The id is DERIVED from the path — that is the library's identity model, and seeding
  // an invented one would test a pool shape the app can never produce.
  const id = library.idFor(photo);
  writeJson(path.join(userData, 'config.json'), {
    autoSwitch: true,
    style: 'fill',
    monitors: {},
    library: { [id]: Object.assign({ id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [], author: '', rev: 1 }, itemOver) },
  });
  const main = loadMain(userData);
  // app.whenReady() never resolves under the harness, so the startup sequence has to
  // be entered explicitly — exactly as the other main.js orchestration suites do.
  main.__test.loadConfig();
  // Loosened only so the suite does not spend real seconds inside the limiter; the
  // limiter itself is exercised in test/request-budget.test.js and, below, by asking
  // for the strict limits back.
  main.__test.setMetadataBudget({ ratePerMinute: 6000, burst: 500, minGapMs: 0 });
  return { userData, photo, id, main };
}

function itemOf(main, id) {
  return main.__test.getConfig().library[id];
}

(async () => {
  // --- a photo the catalogue knows ---------------------------------------
  {
    const { userData, id, main } = setup('meta-found');
    const net = installFetch((target) => answerFound(target, HASH));
    const res = await main.__test.lookupItemMetadata(id);
    ok('a known file is reported as found', res.status === 'found');

    const item = itemOf(main, id);
    ok('the question that went out was about the file\'s own bytes',
      net.urls.length >= 1 && net.urls[0].includes(encodeURIComponent('md5:' + HASH)));
    ok('every tag from the post lands on the photo',
      ['1girl', 'sky', 'artist_name', 'highres'].every((tag) => item.tags.includes(tag)));
    ok('and the reply says how many were added', res.addedTags === item.tags.length);
    ok('the artist becomes the author', item.author === 'artist name');
    ok('the post page becomes the source', /^https:\/\/(gelbooru\.com|danbooru\.donmai\.us)\//.test(item.source));
    ok('the rating is stored spelled out, not as a provider letter', item.rating === 'questionable');
    ok('the record\'s revision moved, so the write cannot lose a later merge', item.rev > 1);

    // The whole point of the journal: the same bytes are one question, forever.
    const before = net.urls.length;
    const again = await main.__test.lookupItemMetadata(id);
    ok('asking again sends no new request at all', net.urls.length === before);
    ok('and still answers from what is already known', again.status === 'found' && again.cached === true);
    ok('with nothing new to add the second time', again.addedTags === 0);

    // A second copy of the same file is the same bytes, so it must cost nothing.
    const twin = path.join(userData, 'wallpapers', 'wp-copy.png');
    fs.writeFileSync(twin, PIXELS);
    main.__test.addToPool('image', twin, {});
    const twinId = Object.keys(main.__test.getConfig().library).find((id) => main.__test.getConfig().library[id].path === twin);
    const twinRes = await main.__test.lookupItemMetadata(twinId);
    ok('a second copy of the same file asks nobody', net.urls.length === before);
    ok('but is still tagged from the remembered answer',
      twinRes.status === 'found' && main.__test.getConfig().library[twinId].tags.includes('sky'));

    // The journal must outlive the process, or a restart re-asks everything.
    main.__test.flushMetadataWriter();
    const journal = JSON.parse(fs.readFileSync(path.join(userData, 'config.metadata.json'), 'utf8'));
    ok('the fingerprint and the answer are written to disk',
      Object.keys(journal.files).length >= 1 && !!journal.lookups['md5:' + HASH]);
    ok('the stored answer keeps the tag kinds for a later screen to group by',
      journal.lookups['md5:' + HASH].result.tags.some((t) => t.type === 'artist'));

    net.restore();
    unloadMain();
  }

  // --- one operation under the REAL production gap --------------------------
  //
  // Gelbooru resolves tag kinds in a second request immediately after finding the post.
  // The default 350 ms host gap used to reject that second request as if it were another
  // user burst. The lookup was then journalled as final without an author/tag kinds, so
  // pressing the button again could never repair the partial result.
  {
    const { id, main } = setup('meta-production-gap');
    main.__test.setProviderCredentials('gelbooru', { userId: 'test', apiKey: 'test' });
    main.__test.setMetadataBudget(null); // exact production defaults, including minGapMs
    const net = installFetch((target) => answerFound(target, HASH));

    const res = await main.__test.lookupItemMetadata(id);
    const item = itemOf(main, id);
    ok('one lookup waits out its own production host gap instead of losing enrichment',
      res.status === 'found' && net.urls.some((url) => url.includes('s=tag')));
    ok('the production gap still lets the artist reach the record', item.author === 'artist name');

    net.restore();
    unloadMain();
  }

  // --- a photo nobody has -------------------------------------------------
  {
    const { userData, id, main } = setup('meta-absent');
    const net = installFetch(answerEmpty);
    const res = await main.__test.lookupItemMetadata(id);
    ok('an unknown file is reported as not found, not as an error', res.status === 'absent');
    ok('and nothing was written to the photo', itemOf(main, id).tags.length === 0 && !itemOf(main, id).author);

    const asked = net.urls.length;
    ok('every available catalogue was asked before giving up', asked >= 1);
    const again = await main.__test.lookupItemMetadata(id);
    ok('a miss is not re-asked straight away', net.urls.length === asked && again.status === 'absent');

    main.__test.flushMetadataWriter();
    const journal = JSON.parse(fs.readFileSync(path.join(userData, 'config.metadata.json'), 'utf8'));
    ok('the miss is remembered against the fingerprint',
      !!journal.lookups['md5:' + HASH] && journal.lookups['md5:' + HASH].result === null);

    net.restore();
    unloadMain();
  }

  // --- the catalogue answers about the WRONG file --------------------------
  {
    const { id, main } = setup('meta-mismatch');
    // A search term that was ignored returns an arbitrary post. Believing it would
    // write a stranger's tags onto the user's photo — worse than finding nothing.
    const net = installFetch((target) => answerFound(target, 'f'.repeat(32)));
    const res = await main.__test.lookupItemMetadata(id);
    ok('a post whose hash is not ours is refused', res.status === 'absent');
    ok('and not one of its tags reaches the photo', itemOf(main, id).tags.length === 0);
    net.restore();
    unloadMain();
  }

  // --- what the user typed himself ----------------------------------------
  {
    const { id, main } = setup('meta-preserve', { author: 'Photo by me', source: 'https://my.site/page', tags: ['sky'] });
    const net = installFetch((target) => answerFound(target, HASH));
    const res = await main.__test.lookupItemMetadata(id);
    const item = itemOf(main, id);
    ok('an author the user set is not overwritten', item.author === 'Photo by me');
    ok('nor is a source he already had', item.source === 'https://my.site/page');
    ok('and the reply says which fields were left alone', res.skipped.join() === 'author,source');
    ok('while the new tags are still added', item.tags.includes('artist_name') && item.tags.includes('sky'));
    ok('a tag he already had is not duplicated', item.tags.filter((t) => t === 'sky').length === 1);
    net.restore();
    unloadMain();
  }

  // --- the catalogue is unreachable ---------------------------------------
  {
    const { id, main } = setup('meta-error');
    const net = installFetch(() => 'boom');
    const res = await main.__test.lookupItemMetadata(id);
    ok('an unreachable catalogue is an error, never a silent "not found"', res.status === 'error');
    ok('and nothing is written to the photo', itemOf(main, id).tags.length === 0);

    // An unreachable catalogue rests briefly — but it must never be REMEMBERED as
    // "this picture is not there". Saying so would be a lie the user acts on: he would
    // stop pressing the button on a photo that is perfectly findable.
    net.restore();
    const good = installFetch((target) => answerFound(target, HASH));
    main.__test.setMetadataBudget({ ratePerMinute: 6000, burst: 500, minGapMs: 0 });
    const resting = await main.__test.lookupItemMetadata(id);
    ok('an immediate retry is held back rather than sent', good.urls.length === 0);
    ok('and it is still called an error, never "nothing found"',
      resting.status === 'error' && resting.reason === 'errorRecently');

    // Age the journal past the rest period instead of waiting an hour. The point being
    // checked is that a failure EXPIRES — a permanent one would silence the photo for a
    // month on the strength of one bad minute.
    const cache = main.__test.metadataCache();
    for (const entry of Object.values(cache.lookups)) {
      for (const seen of Object.values(entry.providers || {})) seen.at -= 2 * 60 * 60 * 1000;
    }
    const retry = await main.__test.lookupItemMetadata(id);
    ok('once the rest period has passed the photo is asked about again',
      retry.status === 'found' && good.urls.length >= 1);
    ok('and the tags finally land', itemOf(main, id).tags.includes('sky'));
    good.restore();
    unloadMain();
  }

  // --- one catalogue answered, the OTHER was never reached ------------------
  //
  // BUG-032, found on the 1.7.3 gate. The case above has every provider resting after an
  // error, and it was the only one checked. Mixed is the common one in real life: one
  // catalogue answers, the other times out. Absence is a claim about ALL of them, so it
  // cannot be made while one has not spoken — and a miss is remembered for a month, so
  // the wrong answer sticks and pressing again does not re-ask.
  {
    const { id, main } = setup('meta-mixed');
    const now = Date.now();
    main.__test.metadataCache().lookups[`md5:${HASH}`] = {
      result: null,
      providers: {
        gelbooru: { at: now, status: 'absent' },
        danbooru: { at: now, status: 'error' },
      },
    };
    // Nothing is pending, so the answer is decided from the journal alone. Any request
    // here would mean the premise of the case is wrong.
    const net = installFetch(() => { throw new Error('nothing may be asked in this state'); });
    const res = await main.__test.lookupItemMetadata(id);
    ok('one catalogue saying "not here" is not enough while another was never reached',
      res.status === 'error' && res.reason === 'errorRecently');
    ok('and nothing was asked to decide it', net.urls.length === 0);
    ok('and nothing was written to the photo', itemOf(main, id).tags.length === 0);
    net.restore();
    unloadMain();
  }

  // --- refused by the host -------------------------------------------------
  {
    const { userData, id, main } = setup('meta-refused');
    const net = installFetch(() => 429);
    const res = await main.__test.lookupItemMetadata(id);
    ok('a host that refuses is reported as an error, not as absence', res.status === 'error');

    // The refusal has to stop traffic to that host for EVERY photo, not merely for the
    // one that provoked it — that is the whole ban defence.
    //
    // It must be checked with a DIFFERENT picture, and without resetting the limiter.
    // Asking about the same photo again is blocked by the journal instead, so that
    // version of this test passed while the limiter did nothing at all.
    const another = path.join(userData, 'wallpapers', 'wp-second.png');
    fs.writeFileSync(another, Buffer.concat([PIXELS, Buffer.from('0102', 'hex')]));
    const otherId = main.__test.addToPool('image', another, {});
    const before = net.urls.length;
    const blocked = await main.__test.lookupItemMetadata(otherId);
    ok('a refusal stops requests about other photos too', net.urls.length === before);
    ok('and the user is told to wait rather than told nothing is there',
      blocked.status === 'busy' && blocked.retryAfterMs > 0);
    net.restore();
    unloadMain();
  }

  // --- things that are not a photo ----------------------------------------
  {
    const { userData, id, main } = setup('meta-guards');
    const net = installFetch((target) => answerFound(target, HASH));
    main.__test.addToPool('folder', path.join(userData, 'wallpapers'), {});
    const folderId = Object.keys(main.__test.getConfig().library)
      .find((id) => main.__test.getConfig().library[id].type === 'folder');
    const folder = await main.__test.lookupItemMetadata(folderId);
    ok('a folder cannot be looked up', folder.status === 'error' && folder.reason === 'unsupported');
    ok('an id that is not in the library cannot either',
      (await main.__test.lookupItemMetadata('nope')).reason === 'unsupported');
    ok('none of that sent a request', net.urls.length === 0);

    // The IPC guard, through the real handler. SEC-002 moved this question out of the
    // handler and into the registrar, which refuses before the handler runs and throws
    // rather than answering — so the untrusted sender is now built explicitly instead of
    // being whatever the harness happened to send.
    let denied = null;
    try {
      await main.invokeRaw({ sender: {}, senderFrame: { url: 'https://example.test/' } },
        'item-lookup-metadata', id);
    } catch (err) { denied = err; }
    ok('the handler refuses a sender that is not one of our windows',
      !!denied && /E_IPC_DENIED/.test(denied.message));
    ok('and that refusal sent no request either', net.urls.length === 0);

    // A record whose file is gone must say so rather than hashing nothing.
    fs.rmSync(path.join(userData, 'wallpapers', 'wp-known.png'), { force: true });
    const gone = await main.__test.lookupItemMetadata(id);
    ok('a missing file is reported honestly', gone.status === 'error' && gone.reason === 'missing');
    net.restore();
    unloadMain();
  }

  // --- the file changed under us ------------------------------------------
  {
    const { photo, id, main } = setup('meta-refresh');
    const net = installFetch((target) => answerFound(target, HASH));
    await main.__test.lookupItemMetadata(id);
    const asked = net.urls.length;

    // Different bytes at the same path: the cached fingerprint describes a file that no
    // longer exists, and reusing it would ask about the wrong picture.
    const other = Buffer.concat([PIXELS, Buffer.from('ff', 'hex')]);
    fs.writeFileSync(photo, other);
    const changedHash = crypto.createHash('md5').update(other).digest('hex');
    net.restore();
    const second = installFetch((target) => answerEmpty(target));
    await main.__test.lookupItemMetadata(id);
    ok('a changed file is hashed again rather than answered from cache',
      second.urls.length >= 1 && second.urls[0].includes(encodeURIComponent('md5:' + changedHash)));
    ok('and the question is about the new bytes, not the old',
      !second.urls[0].includes(encodeURIComponent('md5:' + HASH)) && asked >= 1);
    second.restore();
    unloadMain();
  }

  console.log(`\nAll ${passed} metadata lookup integration tests passed.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
