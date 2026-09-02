'use strict';

// BUG-020, through the REAL `internet-search` handler with only the network stubbed.
//
// The whole point of this change is a distinction the modules cannot see on their own:
// what we choose to put in front of somebody who has not asked for anything, versus what
// we hand back when they HAVE asked. Getting that backwards in either direction is a
// defect — a curated search silently hides results the user typed a word to find, and an
// uncurated front page is the complaint this task started from.
//
// So every assertion below is about the requests that actually left the process.

const assert = require('assert');
const path = require('path');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}


function installFetch(answer) {
  const urls = [];
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    urls.push(target);
    calls.push({ url: target, headers: (init && init.headers) || {} });
    // The ordinal is captured HERE, not inside json(). All four requests are awaited
    // together, so reading urls.length lazily handed several of them the same number,
    // their cards came back with identical ids, and deduplication silently ate half the
    // feed — a fixture bug that reads exactly like a real one.
    const n = urls.length;
    const body = answer(target, n);
    // A bare number stands for an HTTP status the site refused with, so a test can say
    // "this one was turned away" without inventing a response shape.
    if (typeof body === 'number') return { ok: false, status: body, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { urls, calls, restore: () => { globalThis.fetch = original; } };
}

// Enough of each provider's shape for parseSearch to produce real cards, with unique ids
// per request so deduplication cannot hide a missing call.
function answerFor(target, n) {
  if (target.includes('wallhaven.cc')) {
    return {
      data: Array.from({ length: 3 }, (_, i) => ({
        id: `wh${n}-${i}`,
        url: `https://wallhaven.cc/w/wh${n}-${i}`,
        path: `https://w.wallhaven.cc/full/wh${n}-${i}.jpg`,
        thumbs: { small: `https://th.wallhaven.cc/small/wh${n}-${i}.jpg` },
        resolution: '3840x2160', dimension_x: 3840, dimension_y: 2160,
        file_type: 'image/jpeg', purity: 'sfw', category: 'general',
      })),
      meta: { current_page: 1, last_page: 5, per_page: 24 },
    };
  }
  if (target.includes('gelbooru.com')) {
    return {
      post: Array.from({ length: 3 }, (_, i) => ({
        id: `${n}${i}`, md5: String(n) + String(i) + 'a'.repeat(30),
        image: `g${n}-${i}.jpg`, file_url: `https://img3.gelbooru.com/images/aa/bb/g${n}-${i}.jpg`,
        preview_url: `https://img3.gelbooru.com/thumbnails/aa/bb/g${n}-${i}.jpg`,
        width: 1920, height: 1080, rating: 'general', tags: 'sky tree',
      })),
      // ONL-014b. This site reports “is there more” through a total and an offset. Without
      // them a three-card fixture reads as a full stop, and every paging check below would
      // pass for the wrong reason — the site would be finished before it was ever asked to
      // carry on.
      '@attributes': { count: 100, offset: 0 },
    };
  }
  if (target.includes('donmai.us')) {
    // The alternative in the same group, so a fallback can actually produce cards.
    return Array.from({ length: 3 }, (_, i) => ({
      id: `${n}${i}`, md5: 'd' + String(n) + String(i) + 'a'.repeat(29), file_ext: 'jpg',
      file_url: `https://cdn.donmai.us/original/aa/d${n}-${i}.jpg`,
      preview_file_url: `https://cdn.donmai.us/preview/aa/d${n}-${i}.jpg`,
      image_width: 1920, image_height: 1080, rating: 'g',
      tag_string: 'sky', tag_string_general: 'sky',
    }));
  }
  return [];
}

const wh = (urls) => urls.filter((u) => u.includes('wallhaven.cc'));
const booru = (urls) => urls.filter((u) => u.includes('gelbooru.com') || u.includes('danbooru.donmai.us'));

// Which page of the group's site was asked for, as a 1-based number whichever site it is.
// The two name it differently — gelbooru `pid`, counted from zero; danbooru `page`,
// counted from one — so asking for one name only works where that site is reachable.
function booruPage(url) {
  return new URL(url).host === 'gelbooru.com'
    ? Number(param(url, 'pid')) + 1
    : Number(param(url, 'page'));
}

// A full page from the group's site, so it reads as "there is more". Gelbooru says that
// with a total in the answer; danbooru ONLY by filling the page it was asked for, and the
// shared fixture's three cards read as a full stop from it. Used by the paging cases
// rather than by the fixture itself, because the card counts elsewhere are built on three.
function fullBooruPage(target, n) {
  const limit = Number(new URL(target).searchParams.get('limit')) || 24;
  const one = answerFor(target, n)[0];
  return Array.from({ length: limit }, (_, i) => ({
    ...one, id: `${n}-${i}`, md5: `d${n}${i}${'a'.repeat(28)}`,
  }));
}

const param = (url, name) => new URL(url).searchParams.get(name);

// BUG-033. Every case below used to inherit which booru it was testing from whether THIS
// machine happened to hold a gitignored key. On the machine that wrote them it was always
// the first site; on a fresh clone the app correctly fell back and eight assertions went
// red, one of them by crashing. The site is stated here instead, so the file means the
// same thing everywhere. `firstSiteUsable: false` is how a case asks for the fallback.
function setup(label, configPatch = {}, { firstSiteUsable = true } = {}) {
  const userData = makeTempProfile(label);
  writeJson(path.join(userData, 'config.json'), {
    autoSwitch: true, style: 'fill', monitors: {}, ...configPatch,
  });
  const main = loadMain(userData);
  main.__test.setProviderCredentials('gelbooru', firstSiteUsable ? { userId: 'test', apiKey: 'test' } : null);
  main.__test.loadConfig();
  return { userData, main };
}

(async () => {
  // --- nothing typed: the curated front page ------------------------------
  {
    const { main } = setup('feed-browse');
    const net = installFetch(answerFor);
    const res = await main.invoke('internet-search', { q: '', page: 1, sort: 'date_added', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });

    ok('the front page is reported as curated, so the interface never has to guess', res.browsing === true);
    ok('each site is asked twice — for what is new and for what is well rated',
      wh(net.urls).length === 2 && booru(net.urls).length === 2);

    const sorts = wh(net.urls).map((u) => param(u, 'sorting')).sort();
    ok('and those two orderings really are new and top', sorts.join() === 'date_added,toplist');

    ok('Wallhaven is asked WITHOUT the people category',
      wh(net.urls).every((u) => param(u, 'categories') === '110'));

    // The FIRST member of a group is the one asked while it CAN answer; the alternative
    // is a fallback, not a co-equal. Checked by host, or a site quietly dropping out
    // would look identical to a site answering.
    //
    // "While it can answer" is the part the earlier version of this left out. It named
    // gelbooru.com outright, and the key that site needs lives in a gitignored file — so
    // the whole suite went red for anyone building without it, while the app was doing
    // exactly the right thing and falling back. Found on the 1.7.3 gate by running the
    // suite twice, with the key and without (BUG-033).
    const boorusAsked = new Set(booru(net.urls).map((u) => new URL(u).host));
    ok('only ONE site of the group is asked, never both at once', boorusAsked.size === 1);
    ok('and it is the first one that can answer, with the fallback used only when it cannot',
      boorusAsked.has('gelbooru.com'));
    const limits = booru(net.urls).map((u) => Number(param(u, 'limit')));
    ok('the anime board is asked for the same page size as Wallhaven, not four times more',
      limits.every((n) => n === 24));

    // Each site spells the same choice its own way — gelbooru `rating:general`,
    // danbooru `rating:g`. Naming one spelling made this pass only on a machine where
    // that site is the one reachable.
    ok('the content rating the user holds is still applied',
      wh(net.urls).every((u) => param(u, 'purity') === '100')
      && booru(net.urls).every((u) => param(u, 'tags').includes(
        new URL(u).host === 'gelbooru.com' ? 'rating:general' : 'rating:g',
      )));

    ok('every card that came back is in the feed', res.items.length === 12);
    ok('and they are not served as two blocks of one site',
      new Set(res.items.slice(0, 6).map((i) => i.provider)).size > 1);

    // The feed is shuffled, and that is checked exactly rather than statistically: with
    // the generator pinned, the same four answers must always come out in the same order,
    // and that order must NOT be the round-robin the merge produces on its own.
    let seed = 42;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pinnedRun = async () => {
      seed = 42;
      main.__test.setBrowseRandom(rng);
      // A fresh recorder each time, so the fixture numbers its answers from one again
      // and the two runs are genuinely comparable.
      const local = installFetch(answerFor);
      const out = await main.invoke('internet-search', { q: '', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });
      local.restore();
      return out;
    };
    const first = await pinnedRun();
    const again = await pinnedRun();
    ok('a pinned generator produces the same feed twice',
      again.items.map((i) => i.id).join(',') === first.items.map((i) => i.id).join(','));
    const roundRobin = first.items.map((i) => i.provider).every((p, i, all) => i === 0 || p !== all[i - 1]);
    ok('and the feed is not left in strict round-robin order', !roundRobin);
    main.__test.setBrowseRandom(null);
  }

  // --- somebody typed something: their search, not ours -------------------
  {
    const { main } = setup('feed-search');
    const net = installFetch(answerFor);
    const res = await main.invoke('internet-search', { q: 'portrait', page: 1, sort: 'toplist', purity: { sfw: true, sketchy: true, nsfw: false }, browse: false });

    ok('a search is not reported as curated', res.browsing === false);
    ok('each site is asked exactly once', wh(net.urls).length === 1 && booru(net.urls).length === 1);
    ok('with EVERY category — a typed word must not be silently narrowed',
      param(wh(net.urls)[0], 'categories') === '111');
    ok('and with the ordering the user chose', param(wh(net.urls)[0], 'sorting') === 'toplist');
    ok('the word itself is passed on', param(wh(net.urls)[0], 'q') === 'portrait');
    ok('the anime board goes back to its full page size',
      Number(param(booru(net.urls)[0], 'limit')) === 100);
    // Wallhaven takes a 3-bit mask; the booru is asked the other way round, by excluding
    // the ratings that were NOT selected. Both must widen, not just one.
    // Explicit stays out and questionable comes in. Each site says that its own way:
    // gelbooru by EXCLUDING what was not chosen, danbooru by LISTING what was. Asserting
    // one of the two spellings is what made this file pass only where that site is
    // reachable, and the key it needs is not in the repository.
    const asked = booru(net.urls)[0];
    const askedTags = param(asked, 'tags');
    ok('and the wider content rating the user chose is honoured',
      param(wh(net.urls)[0], 'purity') === '110'
      && (new URL(asked).host === 'gelbooru.com'
        ? askedTags.includes('-rating:explicit') && !askedTags.includes('-rating:questionable')
        : /rating:[gsq,]*q/.test(askedTags) && !/rating:[gsqe,]*e/.test(askedTags)));
  }

  // --- the same front page when the first site cannot be reached -----------
  //
  // This is what a build without the bundled key actually does, and until BUG-033 nothing
  // exercised it: the suite simply inherited whichever site the machine could reach, so on
  // the machine that wrote these cases the fallback was never once asked.
  {
    const { main } = setup('feed-fallback', {}, { firstSiteUsable: false });
    const net = installFetch(answerFor);
    const res = await main.invoke('internet-search', { q: '', page: 1, sort: 'date_added', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });

    const asked = new Set(booru(net.urls).map((u) => new URL(u).host));
    ok('with no key for the first site, the fallback is the one asked',
      asked.size === 1 && asked.has('danbooru.donmai.us'));
    ok('and the front page is still curated, not silently turned into a search',
      res.browsing === true);
    ok('the other source is unaffected and still asked twice', wh(net.urls).length === 2);
    ok('and cards actually come back, from both sources',
      res.items.length > 0 && new Set(res.items.map((i) => i.provider)).size > 1);
    ok('the rating the user chose still reaches the fallback, in its own spelling',
      booru(net.urls).every((u) => /rating:[gsq,]*g/.test(param(u, 'tags'))));
  }

  // --- and it pages forward too ---------------------------------------------
  //
  // Paging was only ever exercised against the first site, whose answer carries a total.
  // The fallback says "there is more" a completely different way — by filling the page it
  // was asked for — and numbers its pages from one rather than zero. Neither had a test.
  {
    const { main } = setup('feed-fallback-paging', {}, { firstSiteUsable: false });
    const net = installFetch((target, n) => {
      if (target.includes('wallhaven.cc')) return { data: [], meta: { current_page: 1, last_page: 1, per_page: 24 } };
      if (target.includes('donmai.us')) return fullBooruPage(target, n);
      return answerFor(target, n);
    });
    const first = await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('the fallback answers a search at all', first.items.length > 0 && !!first.resume);
    ok('and it is asked for its first page', booruPage(booru(net.urls)[0]) === 1);

    net.urls.length = 0;
    await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false, resume: first.resume });
    ok('a second press moves the fallback on rather than re-asking the same page',
      booruPage(booru(net.urls)[0]) === 2);
    ok('and the source that had nothing more is not asked again', wh(net.urls).length === 0);
  }

  // --- curation can never leak into a real search --------------------------
  {
    const { main } = setup('feed-guard');
    const net = installFetch(answerFor);
    // A renderer that asks for both at once is contradicting itself. The handler must
    // resolve that towards the SEARCH: narrowing what somebody typed is the harmful
    // direction, and showing them an uncurated front page merely looks untidy.
    const res = await main.invoke('internet-search', { q: 'landscape', page: 1, browse: true });
    ok('a request that claims to be both is treated as a search', res.browsing === false);
    ok('so the people category is not removed behind the user\'s back',
      param(wh(net.urls)[0], 'categories') === '111' && wh(net.urls).length === 1);
  }

  // --- carrying on, per site (ONL-014b) ------------------------------------
  // "Show more" no longer marches one page number across everybody. Each site gets a
  // bookmark and is asked to carry on from it, so these checks drive the REAL sequence:
  // ask, take what came back, hand it in again.
  {
    const { main } = setup('feed-more');
    const net = installFetch(answerFor);
    const first = await main.invoke('internet-search', { q: '', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });
    ok('the first round hands back something to carry on with', !!first.resume);
    net.urls.length = 0;
    const second = await main.invoke('internet-search', { q: '', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true, resume: first.resume });

    ok('"show more" on the front page stays curated',
      wh(net.urls).length === 2 && wh(net.urls).every((u) => param(u, 'categories') === '110'));
    ok('and it asks for the next page of what is new',
      wh(net.urls).some((u) => param(u, 'sorting') === 'date_added' && param(u, 'page') === '2'));
    ok('and there is still more after that', !!second.resume);

    // The moving slice exists only because one site's "top" has no time window. A site
    // whose top renews on its own must be asked for the ordinary page.
    ok('a site whose top renews on its own is asked for the plain page',
      param(wh(net.urls).find((u) => param(u, 'sorting') === 'toplist'), 'page') === '2');
  }

  // Gelbooru's "top" has no time window at all — verified against the live API — so it is
  // read from a random slice. The slice is now chosen ONCE and then walks forward: it
  // used to be re-rolled on every press, which could ask for a slice already on screen.
  //
  // This case is about THAT site specifically — its paging starts at zero and its top is
  // all-time, neither of which is true of the fallback — so `setup` states the site
  // rather than letting the machine decide it.
  {
    const { main } = setup('feed-slice');
    const topPid = (urls) => Number(param(booru(urls).find((u) => param(u, 'tags').includes('sort:score')), 'pid'));
    const run = async (roll) => {
      main.__test.setBrowseRandom(() => roll);
      const net = installFetch(answerFor);
      const one = await main.invoke('internet-search', { q: '', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });
      const started = topPid(net.urls);
      net.urls.length = 0;
      // The dice are deliberately re-rolled to something else between the two rounds.
      // If the slice were still being chosen per request, this is what would show it.
      main.__test.setBrowseRandom(() => 0.95);
      await main.invoke('internet-search', { q: '', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true, resume: one.resume });
      const carried = topPid(net.urls);
      net.restore();
      main.__test.setBrowseRandom(null);
      return { started, carried };
    };
    // Gelbooru numbers its pages from zero, so a roll of 0 legitimately lands on the very
    // top — that IS one of the slices.
    const low = await run(0);
    ok('the top itself is one of the slices', low.started === 0);
    ok('and asking for more walks on from it rather than re-rolling', low.carried === 1);

    const mid = await run(0.55);
    ok('another roll reads a different part of the top', mid.started === 5);
    ok('and that one walks on from where it landed too', mid.carried === 6);

    // The two orderings of ONE site walk forward independently. They start in different
    // places — what is new starts at the beginning, an all-time top starts at a random
    // slice — so a single bookmark shared between them would send one of the two
    // somewhere it never asked to go.
    main.__test.setBrowseRandom(() => 0.55);
    const net = installFetch(answerFor);
    const one = await main.invoke('internet-search', { q: '', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });
    net.urls.length = 0;
    await main.invoke('internet-search', { q: '', purity: { sfw: true, sketchy: false, nsfw: false }, browse: true, resume: one.resume });
    const pidOf = (which) => Number(param(
      booru(net.urls).find((u) => (which === 'top'
        ? param(u, 'tags').includes('sort:score')
        : !param(u, 'tags').includes('sort:score'))),
      'pid',
    ));
    ok('the two orderings of one site keep separate places',
      pidOf('new') === 1 && pidOf('top') === 6);
    net.restore();
    main.__test.setBrowseRandom(null);
  }

  // A site that has said "nothing more" is not asked again. This is the measured waste
  // the change is about: searching a booru-only tag, the other site returned nothing on
  // the first page and was still asked on the four pages after it.
  {
    const { main } = setup('feed-exhausted');
    const net = installFetch((target, n) => {
      if (target.includes('wallhaven.cc')) return { data: [], meta: { current_page: 1, last_page: 1, per_page: 24 } };
      // The other site has to look like it HAS more, and the two say that differently:
      // gelbooru through a total in the answer, danbooru ONLY by filling the page it was
      // asked for. The shared fixture hands back three cards, which reads as a full stop
      // from danbooru — so on a checkout without the gelbooru key this case proved
      // nothing and then failed. Filled here rather than in the shared fixture, because
      // the card counts other cases assert are built on those three.
      if (target.includes('donmai.us')) return fullBooruPage(target, n);
      return answerFor(target, n);
    });
    const first = await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('a site with one page of results is asked once', wh(net.urls).length === 1);
    net.urls.length = 0;
    const second = await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false, resume: first.resume });
    ok('and never again, while the site that still has pages carries on',
      wh(net.urls).length === 0 && booru(net.urls).length > 0 && !!second.resume);
  }

  // A site that FAILED keeps its bookmark, so the next press re-asks the SAME piece.
  // Losing it would leave a permanent hole in the feed for one second of bad network.
  {
    const { main } = setup('feed-retry');
    let breakWallhaven = true;
    const net = installFetch((target, n) => {
      if (target.includes('wallhaven.cc') && breakWallhaven) return 503;
      if (target.includes('donmai.us')) return fullBooruPage(target, n);
      return answerFor(target, n);
    });
    const first = await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('a round where one site fails still answers from the others', !first.error && first.items.length > 0);
    breakWallhaven = false;
    net.urls.length = 0;
    await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false, resume: first.resume });
    ok('the failed site is asked for the very page it lost, not the one after it',
      param(wh(net.urls)[0], 'page') === '1');
    ok('while the site that did answer moves on', booruPage(booru(net.urls)[0]) === 2);
  }

  // ...but not forever. A site that is simply dead would otherwise keep the "show more"
  // button alive while every press added nothing — a dead end the user can see, which is
  // the opposite of what falling back to another site is for.
  {
    const { main } = setup('feed-giveup');
    const net = installFetch((target, n) => {
      if (target.includes('wallhaven.cc')) return 503;
      if (target.includes('gelbooru.com') || target.includes('donmai.us')) {
        return { post: [], '@attributes': { count: 0, offset: 0 } };
      }
      return answerFor(target, n);
    });
    // Pressing only while the feed says there is more, exactly as the window does.
    let token = null;
    const asks = [];
    for (let round = 0; round < 4; round++) {
      net.urls.length = 0;
      const res = await main.invoke('internet-search', { q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false, resume: token });
      asks.push(wh(net.urls).length);
      token = res.resume;
      if (!token) break;
    }
    ok('a site that keeps failing is retried once and then given up on', asks.join() === '1,1');
    ok('and once nobody has anything left there is nothing to carry on with', token === null);
  }

  // A bookmark belongs to the question it was made for.
  {
    const { main } = setup('feed-stale');
    const net = installFetch(answerFor);
    const first = await main.invoke('internet-search', { q: 'cats', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    net.urls.length = 0;
    await main.invoke('internet-search', { q: 'dogs', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false, resume: first.resume });
    ok('a bookmark from a different search is discarded, not followed',
      param(wh(net.urls)[0], 'page') === '1' && param(wh(net.urls)[0], 'q') === 'dogs');
    net.urls.length = 0;
    await main.invoke('internet-search', { q: 'cats', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false, resume: { sig: 'nonsense', slots: 'not an object' } });
    ok('and so is a bookmark that makes no sense at all', param(wh(net.urls)[0], 'page') === '1');

    // A bookmark saying everyone is finished never reaches the window — that is exactly
    // the token that comes back as null. It can still arrive over IPC, and "there was
    // nothing left to ask" must not be dressed up as "the internet is down".
    const resume = require('../src/online-resume');
    const purity = { sfw: true, sketchy: false, nsfw: false };
    const done = { sig: resume.signatureOf({ q: 'cats', purity, browse: false }), slots: {} };
    for (const id of ['wallhaven', 'gelbooru', 'danbooru']) {
      done.slots[resume.slotKey(id, 'date_added')] = { at: null, fails: 0 };
    }
    net.urls.length = 0;
    const nothing = await main.invoke('internet-search', { q: 'cats', purity, browse: false, resume: done });
    ok('with everybody finished nothing goes out, and it is not called an error',
      net.urls.length === 0 && nothing.error === null && nothing.items.length === 0 && nothing.resume === null);
  }

  // --- what the handler keeps, and what it drops ---------------------------
  // ONL-012 moved "which files Znada can use" out of the adapters and into one rule
  // here; ONL-015 made that rule the SAME list a folder is scanned with. So a video
  // still never reaches the user, while a gif and a webp now do — exactly as they
  // always did when they came out of a folder.
  {
    const { main } = setup('feed-media');
    const net = installFetch((target, n) => {
      if (target.includes('wallhaven.cc')) return { data: [], meta: { current_page: 1, last_page: 1, per_page: 24 } };
      if (target.includes('gelbooru.com')) {
        return {
          post: [
            { id: `${n}0`, md5: `${n}0` + 'a'.repeat(30), image: 'a.jpg', file_url: 'https://img3.gelbooru.com/images/aa/a.jpg', preview_url: 'https://img3.gelbooru.com/thumbnails/aa/a.jpg', width: 1920, height: 1080, rating: 'general', tags: 'sky' },
            { id: `${n}1`, md5: `${n}1` + 'a'.repeat(30), image: 'b.webm', file_url: 'https://img3.gelbooru.com/images/aa/b.webm', preview_url: 'https://img3.gelbooru.com/thumbnails/aa/b.jpg', width: 1920, height: 1080, rating: 'general', tags: 'sky' },
            { id: `${n}2`, md5: `${n}2` + 'a'.repeat(30), image: 'c.gif', file_url: 'https://img3.gelbooru.com/images/aa/c.gif', preview_url: 'https://img3.gelbooru.com/thumbnails/aa/c.jpg', width: 1920, height: 1080, rating: 'general', tags: 'sky' },
            { id: `${n}3`, md5: `${n}3` + 'a'.repeat(30), image: 'd.webp', file_url: 'https://img3.gelbooru.com/images/aa/d.webp', preview_url: 'https://img3.gelbooru.com/thumbnails/aa/d.jpg', width: 1920, height: 1080, rating: 'general', tags: 'sky' },
          ],
        };
      }
      // The same four in the other site's shape. This case is about WHICH FORMATS a site
      // may send, not about which site sends them, so it has to run wherever the group's
      // request actually lands — and without the gelbooru key that is the fallback.
      if (target.includes('donmai.us')) {
        return ['jpg', 'webm', 'gif', 'webp'].map((ext, i) => ({
          id: `${n}${i}`, md5: `d${n}${i}${'a'.repeat(29)}`, file_ext: ext,
          file_url: `https://cdn.donmai.us/original/aa/d${n}-${i}.${ext}`,
          preview_file_url: `https://cdn.donmai.us/preview/aa/d${n}-${i}.jpg`,
          image_width: 1920, image_height: 1080, rating: 'g',
          tag_string: 'sky', tag_string_general: 'sky',
        }));
      }
      return [];
    });
    const res = await main.invoke('internet-search', { q: '', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: true });
    const formats = res.items.map((i) => i.format).sort();
    ok('a picture reaches the feed', res.items.length > 0);
    ok('a video does not, even though the site offered it', !formats.includes('webm'));
    // ONL-015. These two used to be dropped here and accepted from a folder, which made
    // the same file two different things depending on where it came from.
    ok('a gif and a webp do, because a folder full of them always worked',
      formats.includes('gif') && formats.includes('webp'));
    ok('and what a site may send is literally what a folder may hold', (() => {
      const online = require('../src/media-type').WALLPAPER_FORMATS.slice().sort().join();
      const local = [...require('../src/playlist').IMG_EXTS].map((e) => e.slice(1)).sort().join();
      return online === local;
    })());
    ok('and the site was asked normally — nothing about this is a special case',
      booru(net.urls).length === 2);
  }


  // --- ONL-012: one path, and what it carries -----------------------------
  {
    const { main } = setup('feed-handler');
    const net = installFetch(answerFor);
    const res = await main.invoke('internet-search', { q: 'x', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });

    // A site whose image hosts refuse a request that does not say where it came from
    // declares that header; every other site must NOT be given it.
    const withReferer = net.calls.filter((c) => c.headers && c.headers.Referer);
    ok('the header a site declares is sent to that site and to no other',
      withReferer.length === 1 && withReferer[0].url.includes('gelbooru.com'));
    ok('every request identifies the app', net.calls.every((c) => !!(c.headers && c.headers['User-Agent'])));

    // The one fact the windows need, carried on the card so they never hold a registry
    // or name a site themselves.
    const byProvider = (id) => res.items.filter((i) => i.provider === id);
    ok('a card says whether its site can be loaded straight from a window',
      byProvider('wallhaven').every((i) => i.loadsDirectly === true)
      && byProvider('gelbooru').every((i) => i.loadsDirectly === false));
  }

  // A site that cannot answer must simply drop out, and its alternative take over —
  // this is the hardwired pair replaced by registry order.
  {
    const { main } = setup('feed-fallback');
    const net = installFetch((target, n) => {
      if (target.includes('gelbooru.com')) throw Object.assign(new Error('down'), { name: 'TypeError' });
      return answerFor(target, n);
    });
    const res = await main.invoke('internet-search', { q: 'x', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('the alternative is asked when the first cannot answer',
      net.urls.some((u) => u.includes('donmai.us')) && res.items.some((i) => i.provider === 'danbooru'));
    ok('and the user is told nothing while any site still works', !res.error);
    // ONL-012 review. The handler's format rule travels WITH the request, so a site that
    // can narrow its own reply does not spend page slots on files this end would only
    // throw away. Asserted on the wire, in this site's spelling: it says `jpg` and has
    // never heard of `jpeg`, so the handler's three formats must arrive as two terms.
    ok('the handler tells the site which formats it wants, in the site\'s own spelling',
      new URL(net.urls.find((u) => u.includes('donmai.us'))).searchParams.get('tags')
        .split(' ').includes('filetype:jpg,png,bmp,webp,gif'));
  }

  {
    const { main } = setup('feed-alldown');
    installFetch(() => { throw Object.assign(new Error('down'), { name: 'TypeError' }); });
    const res = await main.invoke('internet-search', { q: 'x', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('only when nothing answers at all is there something to say',
      res.items.length === 0 && !!res.error);
  }

  // ONL-015. "Which picture files does Znada handle?" used to have two answers: a folder
  // yielded bmp, webp and gif, a site was allowed jpg and png only. Nobody chose the
  // narrow one — it was each booru adapter's private list, and the wallpaper site had no
  // rule at all. One answer now, and this is what stops it splitting again.
  {
    const { main } = setup('feed-formats');
    const playlist = require('../src/playlist');
    const online = main.__test.acceptedFormats();
    const local = [...playlist.IMG_EXTS].map((e) => e.replace(/^\./, ''));
    ok('a site may send exactly what a folder may hold — neither more nor less',
      online.slice().sort().join() === local.slice().sort().join() && online.length === 6);
    ok('and moving pictures are on neither list',
      !online.includes('webm') && !online.includes('mp4'));

    // ONL-015. Not every site can say what format a card is. Our own catalogue does not
    // carry one on a browse card, and it is ours — so it vouches for its content instead
    // of being judged on a fact it never stated. Which of the two a site is, it declares.
    const one = main.__test.searchOneProvider;
    const site = (over) => Object.assign({
      id: 'test', status: 'active', credentials: { kind: 'none', required: false },
      capabilities: { browse: true, cardFormat: true },
      search: async () => ({ items: [{ id: 'a', format: '' }, { id: 'b', format: 'webm' }], meta: {} }),
    }, over);

    const judged = await one(site({}), {});
    ok('a site that said it states formats gets its formatless card refused, not excused',
      judged.items.length === 0);

    const trusted = await one(site({ capabilities: { browse: true, cardFormat: false } }), {});
    ok('a site that said it cannot state one keeps its cards',
      trusted.items.length === 2);

    const omitted = await one(site({ capabilities: { browse: true } }), {});
    ok('omitting the format declaration is strict: a formatless card is not trusted',
      omitted.items.length === 0);

    let formatsSeen = null;
    await one(site({
      search: async (params) => {
        formatsSeen = params.formats;
        return { items: [{ id: 'a', format: 'jpg' }], meta: {} };
      },
    }), { formats: ['webm'] });
    ok('an IPC caller cannot replace the canonical format list handed to a site',
      formatsSeen.slice().sort().join() === require('../src/media-type').WALLPAPER_FORMATS.slice().sort().join());
  }

  // ONL-014. Suggestions while somebody types used to reach ONE named site with no
  // alternative, so while that site was unreachable the dropdown silently offered
  // nothing. It is a declared capability now, with the same fall-through as everything
  // else. Driven with sites the shipped registry cannot produce.
  {
    const { main } = setup('feed-suggest');
    const suggest = main.__test.suggestTagsFromProviders;
    const site = (id, over) => Object.assign({
      id,
      status: 'active',
      credentials: { kind: 'none', required: false },
      capabilities: { tagSuggest: true },
      suggestTags: async () => ({ items: [{ name: id, count: 1, category: 'general' }] }),
    }, over);

    ok('the shipped sites that can answer the box are both boards, in registry order',
      main.__test.suggestTagProviders().join() === 'gelbooru,danbooru');

    const broken = await suggest('sk', 5, [
      site('first', { suggestTags: async () => { throw new Error('down'); } }),
      site('second'),
    ]);
    ok('a site that throws is skipped and the next one answers',
      broken.items.length === 1 && broken.items[0].name === 'second' && !broken.error);

    const refused = await suggest('sk', 5, [site('first', { suggestTags: async () => ({ error: '429' }) }), site('second')]);
    ok('and so is one that is refused', refused.items[0].name === 'second');

    const keyless = await suggest('sk', 5, [
      site('needsKey', { credentials: { kind: 'bundled', required: true } }),
      site('second'),
    ]);
    ok('a site that requires a key it has not got is not asked at all',
      keyless.items[0].name === 'second');

    // An empty answer from a site that ANSWERED is an answer — that prefix matches
    // nothing there — so the round stops. Falling through would double the traffic on
    // every keystroke that happens to match nothing.
    const asked = [];
    const empty = await suggest('sk', 5, [
      site('first', { suggestTags: async () => { asked.push('first'); return { items: [] }; } }),
      site('second', { suggestTags: async () => { asked.push('second'); return { items: [] }; } }),
    ]);
    ok('an empty answer is an answer, so the next site is not asked as well',
      asked.join() === 'first' && !empty.items.length && !empty.error);

    const allDown = await suggest('sk', 5, [site('first', { suggestTags: async () => ({ error: 'timeout' }) })]);
    ok('only when nobody can answer is there an error', allDown.error === 'timeout');

    ok('a site that never said it can answer the box is not asked',
      main.__test.suggestTagProviders([site('quiet', { capabilities: { tagSuggest: false } })]).length === 0);
    ok('nor is a retired one',
      main.__test.suggestTagProviders([site('old', { status: 'retired' })]).length === 0);
    ok('nor is one that declared the capability but brought no way of answering',
      main.__test.suggestTagProviders([site('talker', { suggestTags: undefined })]).length === 0);

    // Ranking is the handler's, not each site's: they return what they found, and the
    // best few are chosen once, the same way, whoever answered.
    //
    // This input is arranged so that ALL THREE steps have to happen. The duplicates are
    // the two most popular entries, so a missing deduplication survives the cut; and the
    // list arrives out of order, so a missing sort changes the answer. An earlier version
    // of this check had the duplicates at the bottom and the list already sorted, and it
    // passed while neither step did anything — a mutation had to point that out.
    const ranked = await suggest('sk', 2, [site('x', {
      suggestTags: async () => ({
        items: [
          { name: 'skyline', count: 40, category: 'general' },
          { name: 'sky', count: 900, category: 'general' },
          { name: 'sky', count: 800, category: 'general' },
          { name: 'sky_(x)', count: 10, category: 'general' },
        ],
      }),
    })]);
    ok('the answer is deduplicated, ordered by popularity and cut to what was asked for',
      ranked.items.map((i) => i.name).join() === 'sky,skyline');
  }

  // ONL-014c. A site reached by a SESSION, and one that pages by an opaque marker. Both
  // are driven with a made-up site: the real one needs an account, and what is being
  // checked is the shared handler's side of the bargain, not the catalogue's.
  {
    const { main } = setup('feed-session');
    const all = main.__test.searchAllProviders;

    // A key in a file is read once and kept. A session must be asked for every time, or
    // signing out leaves the app acting signed in until it restarts. The difference is
    // visible as identity: a cached answer is the SAME object twice.
    const creds = main.__test.providerCredentials;
    let handed = 0;
    const bundled = {
      id: 'keyed', credentials: { kind: 'bundled', required: false },
      loadCredentials: () => { handed += 1; return { key: 'k' }; },
    };
    const first = creds(bundled);
    const second = creds(bundled);
    ok('a key in a file is read once and then remembered',
      handed === 1 && first === second);

    // A session must never come from the file-reading hook, and must never be cached.
    // Counting the hook is what makes this falsifiable: take the session branch away and
    // the hook is called and its answer kept, exactly like a key in a file.
    let sessionHookCalls = 0;
    const sessionSite = {
      id: 'account',
      credentials: { kind: 'session', required: true },
      loadCredentials: () => { sessionHookCalls += 1; return { who: 'me' }; },
    };
    const a1 = creds(sessionSite);
    const a2 = creds(sessionSite);
    ok('a session never comes from a site’s own file-reading hook', sessionHookCalls === 0);
    ok('and it is asked for afresh every time, never remembered',
      (a1 === null && a2 === null) || a1 !== a2);

    // A marker is opaque: stored, handed back, never interpreted. Driven through the REAL
    // round, so the wiring between a stored bookmark and the parameters a site is handed
    // is what is being checked — building those parameters in the test would prove only
    // that the test can build them.
    {
      const resume = require('../src/online-resume');
      const round = main.__test.searchRound;
      const handed = [];
      const marked = {
        id: 'marked', status: 'active', group: 'marked',
        credentials: { kind: 'none', required: false },
        capabilities: { browse: true, cardFormat: false },
        cardKind: 'cloud',
        search: async (params) => {
          handed.push({ page: params.page, cursor: params.cursor });
          return { items: [{ id: 'x' }], meta: { nextCursor: 'mark-2' } };
        },
      };
      const token = resume.emptyToken('s');
      const first = await round(token, 'date_added', {}, [marked]);
      main.__test.recordRound(token, first.attempts);
      ok('a site nobody has asked yet gets no marker at all',
        handed[0].cursor === '' && handed[0].page === 1);
      ok('and the marker it answered with becomes its bookmark',
        resume.positionOf(token, resume.slotKey('marked', 'date_added')) === 'mark-2');

      await round(token, 'date_added', {}, [marked]);
      ok('which is handed straight back on the next round, not turned into a page number',
        handed[1].cursor === 'mark-2');

      // A failure keeps the place — and for a site that pages by a marker, the place IS
      // the marker. Recording a page number instead would silently send it back to the
      // beginning on the next press.
      const brittle = Object.assign({}, marked, {
        search: async (params) => { handed.push({ page: params.page, cursor: params.cursor }); return { error: '503' }; },
      });
      // Recorded after EACH round, as the handler does. Recording only at the end would
      // give the first failure no chance to move the bookmark, and this check would pass
      // whether or not the marker survived.
      const fail1 = await round(token, 'date_added', {}, [brittle]);
      main.__test.recordRound(token, fail1.attempts);
      const fail2 = await round(token, 'date_added', {}, [brittle]);
      main.__test.recordRound(token, fail2.attempts);
      ok('a site that pages by a marker keeps the MARKER when it fails, not a page number',
        handed[2].cursor === 'mark-2' && handed[3].cursor === 'mark-2');

      // The card has to say what KIND it is, or a window would have to ask which site it
      // came from — the thing this whole line of work removes.
      ok('and every card it produced says what kind of card it is',
        first.results[0].items.every((i) => i.cardKind === 'cloud'));
    }

    // A marker is opaque: stored, handed back, never interpreted.
    const seen = [];
    const cursorSite = (over) => Object.assign({
      id: 'marked', status: 'active', group: 'marked',
      credentials: { kind: 'none', required: false },
      capabilities: { browse: true, cardFormat: false },
      search: async (params) => {
        seen.push(params.cursor);
        return { items: [{ id: 'x' }], meta: { nextCursor: 'mark-2' } };
      },
    }, over);

    // The shipped registry cannot produce a marker site, so the round trip is driven
    // through searchAllProviders and the bookmark bookkeeping directly.
    const resume = require('../src/online-resume');
    const sig = resume.signatureOf({ q: 'x', purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    const token = resume.emptyToken(sig);
    const key = resume.slotKey('marked', 'date_added');
    const round = await all(() => ({ sort: 'date_added', page: 1, cursor: '' }), [cursorSite({})]);
    resume.record(token, key, '', { next: resume.nextFrom(round.results[0], 1) });
    ok('the marker a site handed back becomes its bookmark, untouched',
      resume.positionOf(token, key) === 'mark-2');

    seen.length = 0;
    await all(() => ({ sort: 'date_added', page: 1, cursor: resume.positionOf(token, key) }), [cursorSite({})]);
    ok('and it is handed straight back on the next round',
      seen.join() === 'mark-2');
  }

  // ONL-014c. The handler asks a site only when the switch that site DECLARED is on.
  // Drive this with two harmless fake sites: the shipped catalogue needs a live account,
  // which would make a source-toggle test pass merely because credentials were absent.
  {
    const asked = [];
    const site = (id, sourceKey) => ({
      id, sourceKey, status: 'active', group: id,
      credentials: { kind: 'none', required: false },
      capabilities: { browse: true, cardFormat: false },
      search: async () => { asked.push(id); return { items: [{ id }], meta: {} }; },
    });

    const cloudOnly = setup('feed-source-cloud', {
      onlineSources: { lumina: true, internet: false },
    }).main;
    await cloudOnly.__test.searchRound(
      require('../src/online-resume').emptyToken('cloud-only'),
      'date_added', {}, [site('public-default'), site('catalogue', 'lumina')],
    );
    ok('with only the catalogue switch on, a default Internet site is not asked',
      asked.join() === 'catalogue');

    asked.length = 0;
    const internetOnly = setup('feed-source-internet', {
      onlineSources: { lumina: false, internet: true },
    }).main;
    await internetOnly.__test.searchRound(
      require('../src/online-resume').emptyToken('internet-only'),
      'date_added', {}, [site('public-default'), site('catalogue', 'lumina')],
    );
    ok('a site with no special source key follows the Internet switch',
      asked.join() === 'public-default');
  }

  // The adult-content answer follows the registry instead of asserting a constant.
  {
    const { main } = setup('feed-explicit');
    const reach = main.__test.explicitContentReachableIn;
    ok('a site that serves it without a key makes it reachable',
      reach([{ id: 'a', capabilities: { explicit: 'always' }, credentials: { kind: 'none' } }]) === true);
    ok('a site that needs a key it has not got does not',
      reach([{ id: 'b', capabilities: { explicit: 'withCredentials' }, credentials: { kind: 'bundled', required: false } }]) === false);
    ok('and neither does a site that never serves it, nor an empty list',
      reach([{ id: 'c', capabilities: { explicit: 'never' }, credentials: { kind: 'none' } }]) === false
      && reach([]) === false
      && reach(null) === false);
  }


  // --- a site that misbehaves must drop out, not take the round down -------
  // Driven through one site directly: a shipped site cannot be made to throw, and these
  // are exactly the guarantees that matter for a site we have not written yet.
  {
    const { main } = setup('feed-broken');
    const one = main.__test.searchOneProvider;
    const base = { id: 'test', name: 'Test', group: 'g', hosts: {}, capabilities: { browse: true }, requestHeaders: {} };

    const thrown = await one({ ...base, search: () => { throw new Error('boom'); } }, {});
    ok('a site that throws becomes an error, not an exception', thrown.error === 'network' && thrown.items.length === 0);

    const rejected = await one({ ...base, search: async () => { throw new Error('boom'); } }, {});
    ok('and so does one that rejects', rejected.error === 'network');

    const silent = await one({ ...base, search: async () => undefined }, {});
    ok('a site that answers nothing is an error rather than an empty success', silent.error === 'network');

    const noHook = await one({ ...base }, {});
    ok('a site with no search hook is simply unable to answer', noHook.error === 'unsupported');

    const needsKey = await one({ ...base, credentials: { kind: 'bundled', required: true }, search: async () => ({ items: [{ mediaType: 'image', format: 'jpg' }] }) }, {});
    ok('a site that requires a key it has not got is not asked at all', needsKey.error === 'unavailable');

    const junk = await one({ ...base, search: async () => ({ items: 'not a list' }) }, {});
    ok('rubbish where the pictures should be is an empty answer, not a crash',
      junk.error === null && junk.items.length === 0);
  }

  // A site that is refused, or that answers 200 while reporting a failure in the body.
  {
    const { main } = setup('feed-refused');
    const net = installFetch((target, n) => {
      if (target.includes('gelbooru.com')) return 429;
      return answerFor(target, n);
    });
    const res = await main.invoke('internet-search', { q: 'x', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('a refused request is a failure, so the alternative takes over',
      net.urls.some((u) => u.includes('donmai.us')) && res.items.some((i) => i.provider === 'danbooru'));
  }
  {
    const { main } = setup('feed-softfail');
    const net = installFetch((target, n) => {
      // This site can answer 200 and still be reporting a failure inside the body.
      if (target.includes('gelbooru.com')) return { success: false, message: 'Search error' };
      return answerFor(target, n);
    });
    const res = await main.invoke('internet-search', { q: 'x', page: 1, purity: { sfw: true, sketchy: false, nsfw: false }, browse: false });
    ok('a failure reported inside a successful answer is still a failure',
      net.urls.some((u) => u.includes('donmai.us')) && res.items.some((i) => i.provider === 'danbooru'));
  }

  // Who gets asked at all, driven with sites the shipped registry cannot produce.
  {
    const { main } = setup('feed-who');
    const asked = [];
    const site = (over) => ({
      id: over.id, name: over.id, group: over.group || over.id, hosts: {}, requestHeaders: {},
      capabilities: { browse: true, ...(over.capabilities || {}) },
      status: over.status || 'active',
      search: async () => { asked.push(over.id); return { items: [], meta: {} }; },
    });
    await main.__test.searchAllProviders(() => ({}), [
      site({ id: 'yes' }),
      site({ id: 'cannot-browse', capabilities: { browse: false } }),
      site({ id: 'alsoyes' }),
    ]);
    ok('a site that never said it can browse is not asked', !asked.includes('cannot-browse'));
    ok('the ones that did say so are', asked.includes('yes') && asked.includes('alsoyes'));

    asked.length = 0;
    await main.__test.searchAllProviders(() => ({}), [site({ id: 'first', group: 'g' }), site({ id: 'second', group: 'g' })]);
    ok('within one group only the first is asked while it answers',
      asked.join() === 'first');

    asked.length = 0;
    await main.__test.searchAllProviders(() => ({}), [site({ id: 'retired', status: 'retired' }), site({ id: 'live' })]);
    ok('a retired site is never asked for new pictures, even though it is still known',
      !asked.includes('retired') && asked.includes('live'));
  }


  unloadMain();
  console.log(`\nAll ${passed} online browse-feed tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
