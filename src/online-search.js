'use strict';

// CODE-001. Online search: the front-page feed, a typed search, tag suggestions for the
// search box and the list of sites a window may name. It only READS — nothing here adds to
// the library or touches a file. "Add to Library" and the image proxy stay where the files
// are handled.
//
// Owns: the tag-suggestion cache and the dice for the front page's random slice, both for
// the life of this instance. Does not own: the user's settings (read through `getConfig`
// at the moment of every request — `set-config` replaces the whole object), the monitor
// list (`getMonitors`), or how a site is reached (`providers`, src/provider-access.js).
//
// Moved out of main.js unchanged; the comments below are the ones that stood there.

const onlineSources = require('./online-sources');
const onlineResume = require('./online-resume');
const onlineTagLimit = require('./online-tag-limit');
const sizeFilter = require('./size-filter');
const tagSuggest = require('./tag-suggest');
const mediaFormats = require('./media-type');

const INTERNET_TAG_SUGGEST_CACHE_SIZE = 200;

// ONL-015. What Znada can put on a desktop is ONE list, and it is the same list a folder
// is scanned with (`src/media-type.js`). It used to be narrower here than there, so the
// same webp was ordinary wallpaper from a folder and invisible from a site.
//
// It is used TWICE and deliberately so: every answer is filtered by it, and it is also
// handed to the sites, so one that can narrow its own reply does not spend page slots on
// files that would only be dropped here. Asking and filtering must be the same list, or
// widening one of them silently does nothing.
const ACCEPTED_FORMAT_LIST = mediaFormats.WALLPAPER_FORMATS;

// BUG-020 — the front page is OURS, a search is the user's.
//
// Until somebody types something we are not filtering anything; we are choosing what to
// put in front of them, and that is a different job with different rules. The measured
// problem was that we had never made that choice deliberately: the newest uploads on
// Wallhaven, with every category enabled, are mostly photo shoots of people (56% of a
// page, against 8 landscapes in 48), and the anime board was asked for four times as
// many cards as Wallhaven, so the feed alternated for one screen and then became one
// site for the rest of the page (79% of it).
//
// So while the search box is empty:
//   * Wallhaven is asked WITHOUT the `people` category. This is not a content rating —
//     a perfectly safe portrait is still `people`, which is why turning the rating down
//     does not remove them (measured: 56% -> 31%, not 0%);
//   * both sites are asked for the SAME number of cards, so the feed keeps alternating
//     all the way down instead of turning into one site after the first screen;
//   * both are asked for two orderings at once — what is new and what is well rated —
//     and the result is shuffled into one feed.
//
// The moment the user types anything, none of this applies: they asked for something
// specific and they get it, with every category and their own chosen ordering. The one
// thing that DOES cross over is the content rating, because that is their standing
// answer to "what am I willing to see", not our curation.
const BROWSE_CATEGORIES = '110';     // general + anime, no people
const SEARCH_CATEGORIES = '111';     // a search is not curated
const BROWSE_PAGE_SIZE = 24;         // Wallhaven's own page size; the booru matches it
const BROWSE_SORTS = ['date_added', 'toplist'];
// Wallhaven's "top" is scoped to the last month by default, so it renews on its own.
// Gelbooru has no such window — verified 2026-08-25: it rejects every date-scoped form
// of the query — so its "top" is ALL TIME and would hand back the identical cards on
// every launch. Starting from a random slice of that top keeps the ordering the owner
// asked for and still varies, which is the whole point of putting it on the front page.
const BROWSE_TOP_SLICES = 10;

// ONL-010. How many cards are worth one press before we stop trying to top the page up.
// Deliberately modest: on an anime board a strict 16:9 leaves four cards in a hundred
// (measured 2026-09-03), so "fill the page" is not a promise anybody can keep, and
// chasing it would be the request storm BUG-020 had just finished limiting.
const SIZE_FILTER_MIN_CARDS = 12;
const SIZE_FILTER_EXTRA_ROUNDS = 2;

/**
 * What a round of searching hands back. Most fields appear only on some paths (a size-filtered
 * page, a search every site sat out), so they are optional here as they are in the reply.
 * @typedef {{ items: any[], meta: object, error: (string|null), providerErrors: object,
 *   totals?: object, paused?: object, allPaused?: boolean, sizeFiltered?: boolean }} SearchReply
 */

function create(deps = {}) {
  const {
    getConfig,
    getMonitors = () => [],
    providers,
    // main.js already owns the shared merge/fallback rules. Passing them avoids loading
    // site adapters and machine-local keys through online.js when typechecking this service.
    online,
    // The list of sites: src/provider-registry.js in the app, sites of its own making in a
    // test (one that throws, one with no key, one that pages forever). Handed in rather than
    // required, so this module does not pull every site adapter (and their key files) along.
    registry,
    log = console,
  } = deps;
  if (typeof getConfig !== 'function') throw new Error('online-search: getConfig is required');
  if (!providers) throw new Error('online-search: providers (src/provider-access.js) is required');
  if (!registry) throw new Error('online-search: registry (src/provider-registry.js) is required');
  if (!online) throw new Error('online-search: online result rules are required');

  const internetTagSuggestCache = new Map();
  // Injected so a test can pin the order and the slice; production uses Math.random.
  let browseRandom = typeof deps.random === 'function' ? deps.random : Math.random;

  // Which sources the user has switched on. A site declares WHICH switch it belongs to;
  // the handler never works it out from what kind of site it is.
  function sourceEnabled(descriptor) {
    const config = getConfig();
    return onlineSources.enabled(config && config.onlineSources, descriptor);
  }

  function sourcesSignature() {
    return onlineSources.signature(getConfig().onlineSources);
  }

  // Two more fields used to ride along here — whether a Wallhaven key is bundled, twice
  // under different names. Nothing has ever read them, and keeping them meant main had to
  // name a site to fill them in. What the window actually asks is the next line.
  function status() {
    return {
      // Computed rather than asserted: this used to be a hardcoded `true` beside a comment
      // reasoning about which sites cover it, and that reasoning silently stopped being
      // true whenever a site was removed or shipped without its key.
      nsfwAvailable: providers.explicitContentReachableIn(registry.active().filter(sourceEnabled)),
      // ONL-016. "Details" has to name the site a picture came from, and the registry is
      // the one place that knows what a site is called. Sent as a list rather than copied
      // onto every card, and taken from ALL providers rather than the active ones: a card
      // saved from a site Znada no longer asks must still be able to say where it is from.
      providers: registry.PROVIDERS.map((p) => ({
        id: p.id, name: p.name, status: p.status || 'active',
        sourceKey: p.sourceKey || 'internet', browse: !!(p.capabilities && p.capabilities.browse),
      })),
    };
  }

  async function suggestTags(opts) {
    const prefix = tagSuggest.normalizeTagPrefix(opts && opts.q);
    if (prefix.length < tagSuggest.MIN_PREFIX_LEN) return { items: [], error: null };

    const limit = tagSuggest.clampLimit(opts && opts.limit);
    const selection = sourcesSignature();
    const cacheKey = `${selection}|${prefix}|${limit}`;
    if (internetTagSuggestCache.has(cacheKey)) {
      const cached = internetTagSuggestCache.get(cacheKey);
      internetTagSuggestCache.delete(cacheKey);
      internetTagSuggestCache.set(cacheKey, cached);
      return cached;
    }

    const answer = await suggestTagsFromProviders(prefix, limit, registry.active().filter(sourceEnabled));
    if (selection !== sourcesSignature()) return { items: [], error: null };
    if (answer.error) return { items: [], error: answer.error };
    const result = { items: answer.items, error: null };
    internetTagSuggestCache.set(cacheKey, result);
    while (internetTagSuggestCache.size > INTERNET_TAG_SUGGEST_CACHE_SIZE) {
      internetTagSuggestCache.delete(internetTagSuggestCache.keys().next().value);
    }
    return result;
  }

  // ONL-014. Ask whoever declared they can answer the search box, in registry order, and
  // take the first real answer.
  //
  // This was the last path that reached ONE named site with no alternative: while it was
  // unreachable the dropdown silently offered nothing, and there was no second site to
  // fall through to because there was no list to fall through. Sorting and the final cut
  // are done HERE, so a site returns what it found and does not each invent its own idea
  // of "the best ten".
  function suggestTagProviders(list) {
    return (Array.isArray(list) ? list : registry.active()).filter((descriptor) => (
      descriptor
      && descriptor.status !== 'retired'
      && descriptor.capabilities && descriptor.capabilities.tagSuggest
      && typeof descriptor.suggestTags === 'function'
    ));
  }

  function rankSuggestions(items, limit) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.name || seen.has(item.name)) continue;
      seen.add(item.name);
      out.push(item);
    }
    out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
    return out.slice(0, limit);
  }

  async function suggestTagsFromProviders(prefix, limit, list) {
    let lastError = 'network';
    for (const descriptor of suggestTagProviders(list)) {
      if (descriptor.credentials && descriptor.credentials.required && !providers.credentials(descriptor)) {
        lastError = 'unavailable';
        continue;
      }
      let res;
      try {
        res = await descriptor.suggestTags({ q: prefix, limit }, providers.context(descriptor));
      } catch (err) {
        log.error(`${descriptor.id} tag suggest:`, err);
        res = { error: 'network' };
      }
      if (!res || res.error) { lastError = (res && res.error) || 'network'; continue; }
      const items = rankSuggestions(res.items, limit);
      // An empty answer from a reachable site is an ANSWER — that tag prefix matches
      // nothing — so the next site is not asked. Only a failure falls through.
      return { items, error: null };
    }
    return { items: [], error: lastError };
  }

  // ---------------------------------------------------------------------------
  // ONL-012 — one search path, for every site there will ever be
  // ---------------------------------------------------------------------------
  //
  // There used to be a hand-written search function per site, each with its own fetch,
  // its own timeouts and its own way of turning a failure into a word, plus a hardwired
  // "ask Gelbooru, and Danbooru if that failed". None of it generalised: a fourth site
  // would have needed every one of those written again, and the graceful behaviour we
  // already had would not have come with it.
  //
  // Now the handler knows nothing about any site. It asks whoever DECLARES they can
  // answer, in the order the registry lists them, and everything peculiar to a site lives
  // in that site's own file.

  // Is this a picture Znada can use?
  //
  // The sites used to decide this themselves and throw the rest away before the app could
  // see it — which is why a video from a board was unreachable no matter what the app
  // learned. They now report the format and this decides, once, against the one list.
  //
  // ONL-015: a site that CANNOT state a format is not judged on it. Our own catalogue does
  // not carry one on a browse card, and it is ours — what is in it is our doing, so it
  // vouches for its content instead. Which of the two a site is, it declares; a site that
  // said it states formats and then sends a card without one is refused, not excused.
  function usableCard(item, descriptor) {
    if (!item) return false;
    const states = !descriptor || !descriptor.capabilities || descriptor.capabilities.cardFormat !== false;
    return states ? mediaFormats.isWallpaperFormat(item.format) : true;
  }

  // What a site's `search` is handed: the round's parameters plus the one format list. The
  // tag-limit check counts the words of exactly this, so what is counted is what is sent
  // (LIB-014 stage 3).
  function providerSearchParams(params) {
    return { ...(params || {}), formats: ACCEPTED_FORMAT_LIST };
  }

  async function searchOneProvider(descriptor, params) {
    if (!descriptor) return { provider: '', items: [], meta: {}, error: 'unsupported' };
    const blank = { provider: descriptor.id, items: [], meta: {}, error: null };
    if (typeof descriptor.search !== 'function') return { ...blank, error: 'unsupported' };
    const credentials = providers.credentials(descriptor);
    if (descriptor.credentials && descriptor.credentials.required && !credentials) {
      return { ...blank, error: 'unavailable' };
    }
    let res;
    try {
      // The format rule travels WITH the request. A site that can narrow its own reply
      // does so; one that cannot simply ignores it and is filtered below instead.
      res = await descriptor.search(
        providerSearchParams(params),
        providers.context(descriptor, credentials),
      );
    } catch (err) {
      log.error(`${descriptor.id} search:`, err);
      return { ...blank, error: 'network' };
    }
    if (credentials && typeof credentials.isCurrent === 'function' && !credentials.isCurrent()) {
      return { ...blank, error: 'session_changed' };
    }
    if (!res || res.error) return { ...blank, error: (res && res.error) || 'network' };
    return {
      provider: descriptor.id,
      // The one thing a window has to know about a site: whether it may load the image
      // itself. Some hosts refuse a request that does not say where it came from, and a
      // window cannot send that — so those go through main. Carried ON THE CARD, so the
      // windows never have to hold the registry or name a site.
      items: (Array.isArray(res.items) ? res.items : []).filter((item) => usableCard(item, descriptor))
        .map((item) => ({
          ...item,
          loadsDirectly: !!descriptor.loadsDirectly,
          // ONL-014c. What KIND of card this is: one with a lasting page and file, or one
          // whose file is minted on demand. Declared by the site, carried on the card, so
          // no window has to ask which site a picture came from.
          cardKind: descriptor.cardKind || 'internet',
        })),
      meta: res.meta || {},
      error: null,
    };
  }

  // Sites in one group are ALTERNATIVES — the same kind of pictures from a different
  // place — so they are asked in order until one answers, and only the answer is used.
  // This is what the hardwired Gelbooru→Danbooru pair became; a third alternative is now
  // a row in the registry rather than another branch here.
  // ONL-005: SEARCH no longer uses this. `searchRound` gives every chosen site its own
  // group, because a site the user switched off must not return as somebody's replacement.
  // The mechanism stays for a caller that does want alternatives; today none does.
  // ONL-014b. `attempts` collects every member that was actually ASKED, with the exact
  // parameters it was asked with. Alternatives page independently of one another, so the
  // one that answered this round has to carry on from where IT got to — a single "the
  // group is on page N" would put the fallback back at the beginning the moment the
  // primary recovered.
  async function searchProviderGroup(members, buildParams, attempts) {
    let carried = null;
    for (const descriptor of members) {
      const params = buildParams(descriptor);
      const result = await searchOneProvider(descriptor, params);
      if (attempts) attempts.push({ descriptor, params, result });
      if (!online.providerFailed(result)) {
        if (carried) log.warn(`${carried.provider} unavailable (${carried.error}); using ${descriptor.id} instead`);
        return carried ? online.resolveFallback(carried, result) : result;
      }
      carried = carried ? online.resolveFallback(carried, result) : result;
    }
    return carried || { provider: '', items: [], meta: {}, error: 'network' };
  }

  // Every group that can answer this kind of request, in registry order. Retired sites are
  // absent; a site that declares it cannot browse is absent too.
  function searchableGroups(list) {
    const groups = new Map();
    for (const descriptor of Array.isArray(list) ? list : []) {
      if (!descriptor) continue;
      // Checked HERE and not only by whoever assembled the list: "a retired site is never
      // asked for new pictures" has to hold however the list was put together.
      if (descriptor.status === 'retired') continue;
      if (!descriptor.capabilities || !descriptor.capabilities.browse) continue;
      const key = descriptor.group || descriptor.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(descriptor);
    }
    return Array.from(groups.values());
  }

  // The list is passed in rather than fetched here: a wrapper that quietly reaches for
  // the wrong list is exactly the kind of wiring a test cannot see, and this way there is
  // no wrapper to get wrong.
  // Returns the answers AND a record of who was asked what, because "carry on from here"
  // is decided per site and cannot be reconstructed from the merged answer.
  async function searchAllProviders(buildParams, list) {
    const members = Array.isArray(list) ? list : registry.active();
    const attempts = [];
    const results = await Promise.all(
      searchableGroups(members).map((group) => searchProviderGroup(group, buildParams, attempts)),
    );
    return { results, attempts };
  }

  // ONL-014b. Where such a site STARTS, chosen once. It used to be re-rolled on every
  // press of "show more", which meant a second press could ask for a slice already seen —
  // the grid drops what it already has, so the button did the work and added nothing.
  // Now the dice are thrown when the site has no bookmark yet, and from then on it simply
  // walks forward (owner's decision, 2026-08-27).
  function browseTopStartPage() {
    return 1 + Math.floor(browseRandom() * BROWSE_TOP_SLICES);
  }

  // Where this site should carry on from, for this ordering.
  // ONL-005 task 3: the random slice is front-page curation only. A search is the user's
  // question and starts at the top of its answer — sliced, a rare tag with a page or two of
  // results started past its end and read as "nothing found" on Top.
  function positionFor(token, descriptor, sorting, browsing = false) {
    const key = onlineResume.slotKey(descriptor.id, sorting);
    const at = onlineResume.positionOf(token, key);
    if (at !== undefined) return at;                    // null means finished
    return browsing && sorting === 'toplist' && descriptor.capabilities && descriptor.capabilities.topIsAllTime
      ? browseTopStartPage()
      : 1;
  }

  // One round of asking, for one ordering. Sites that have already said "nothing more" are
  // not asked at all — the measured waste this whole change is about.
  // The list is a parameter for the same reason it is everywhere else in this file: the
  // wiring between a stored bookmark and the parameters a site is handed cannot be proved
  // with the shipped sites alone, and a wrapper that quietly reaches for the wrong list is
  // exactly the kind of thing a test cannot see.
  async function searchRound(token, sorting, extra, list, browsing = false) {
    const live = (Array.isArray(list) ? list : registry.active())
      .filter(sourceEnabled)
      .filter((descriptor) => !onlineResume.isFinished(token, onlineResume.slotKey(descriptor.id, sorting)));
    // LIB-014 stage 3. A site this query does not fit is not asked at all: it sits this search
    // out and is named in `paused`. Nothing about it is recorded — it did not fail, so its
    // bookmark, the failure notice and the user's choice of sites all stay as they were. The
    // check needs no page, so it is not given one: on the front page `positionFor` throws the
    // dice for Gelbooru's slice, and a second throw here would move it.
    const paused = {};
    const asked = live.filter((descriptor) => {
      if (descriptor.status === 'retired' || !descriptor.capabilities || !descriptor.capabilities.browse) return true;
      const answer = onlineTagLimit.verdict(descriptor, providerSearchParams({ ...extra, sort: sorting }));
      if (answer.fits) return true;
      paused[descriptor.id] = { max: answer.max, sortHelps: !!answer.sortHelps };
      return false;
    });
    if (!asked.length) return { results: [], attempts: [], paused };
    const round = await searchAllProviders((descriptor) => {
      const at = positionFor(token, descriptor, sorting, browsing);
      return {
        ...extra,
        // ONL-017. Ask for MORE, not more often. A site that cannot narrow by shape sends a
        // page that is mostly discarded here, so while the filter is on it is asked for its
        // biggest page — one request instead of several. Which sites those are is read from
        // their own declarations, never from their names; a site that narrows properly gets
        // the ordinary page it always got.
        limit: extra && extra.sizeHints
          ? sizeFilter.pageSizeFor(extra.limit, (descriptor.capabilities || {}).sizeFilter)
          : extra && extra.limit,
        sort: sorting,
        // ONL-014c. A bookmark is whatever the site said it was. Sites that count pages
        // read `page`; the one that hands back an opaque marker reads `cursor`. Which of
        // the two it is, is the shape of the value, not a question about which site it is.
        page: typeof at === 'number' ? at : 1,
        cursor: typeof at === 'string' ? at : '',
      };
    // ONL-005: chosen sites are independent search sources. Group alternatives remain
    // a lower-level mechanism for other callers, but cannot silently replace a choice.
    }, asked.map((descriptor) => ({ ...descriptor, group: descriptor.id })));
    return { ...round, paused };
  }

  // Write down where everyone got to. A site that failed keeps its bookmark and is asked
  // the same piece again next time; only MAX_FAILS in a row finishes it.
  function recordRound(token, attempts) {
    for (const attempt of attempts) {
      const key = onlineResume.slotKey(attempt.descriptor.id, attempt.params.sort);
      const asked = attempt.params.cursor || attempt.params.page;
      if (online.providerFailed(attempt.result)) {
        onlineResume.record(token, key, asked, { failed: true });
      } else {
        onlineResume.record(token, key, asked, { next: onlineResume.nextFrom(attempt.result, asked) });
      }
    }
  }

  /** @returns {Promise<SearchReply>} */
  async function searchBrowseFeed(o, token) {
    const rounds = await Promise.all(BROWSE_SORTS.map((sorting) => searchRound(token, sorting, {
      ...o,
      q: '',
      categories: BROWSE_CATEGORIES,
      limit: BROWSE_PAGE_SIZE,
    }, undefined, true)));
    const results = rounds.flatMap((round) => round.results);
    rounds.forEach((round) => recordRound(token, round.attempts));
    const paused = Object.assign({}, ...rounds.map((round) => round.paused));
    if (!rounds.some((round) => round.attempts.length)) return { ...nobodyLeft(), paused };
    // mergeSearchResults does the deduplication — a picture that is both new and well
    // rated must appear once — and the shuffle then removes the two orderings' rhythm.
    const merged = online.mergeSearchResults(results);
    return { ...merged, items: online.shuffle(merged.items, browseRandom), paused };
  }

  /** @returns {Promise<SearchReply>} */
  async function searchQueryFeed(o, token) {
    const sorting = String(o.sort || 'date_added');
    const round = await searchRound(token, sorting, { ...o, categories: SEARCH_CATEGORIES });
    recordRound(token, round.attempts);
    // LIB-014 stage 3. Nobody asked because every site left was paused: an empty answer that
    // is neither "nothing found" nor a failure, and the window says why.
    if (!round.attempts.length) {
      return { ...nobodyLeft(), paused: round.paused, allPaused: Object.keys(round.paused).length > 0 };
    }
    return { ...online.mergeSearchResults(round.results), paused: round.paused };
  }

  // Everyone has already said "nothing more". That is not a failure and must not be
  // dressed as one: "no answers" means the same thing as "everybody refused" to
  // mergeSearchResults, and only the caller knows which of the two actually happened.
  /** @returns {SearchReply} */
  function nobodyLeft() {
    return { items: [], meta: {}, error: null, providerErrors: {} };
  }

  // The filter, applied. Sites are asked to narrow what they can — measured per site, in
  // their own declarations — and then EVERY card is judged here, because a server given
  // the loosest bound that covers several targets cannot decide the exact one, and one
  // site (Gelbooru) cannot judge shape at all.
  /** @returns {Promise<SearchReply>} */
  async function searchFiltered(o, token, browsing) {
    const targets = sizeFilter.effectiveTargets(getConfig().onlineSizeFilter, getMonitors());
    const run = (extra) => (browsing
      ? searchBrowseFeed({ ...o, ...extra }, token)
      : searchQueryFeed({ ...o, ...extra }, token));
    if (!targets.length) return run({});

    const hints = sizeFilter.serverHints(targets);
    const keep = (items) => (Array.isArray(items) ? items : [])
      .filter((item) => sizeFilter.matches(item, targets));

    const first = await run({ sizeHints: hints });
    // ONL-004: `sizeFiltered` because a site's own count only knows the size floor it was sent,
    // not the shape judged below — so with this filter the window shows no number at all.
    let merged = { ...first, items: keep(first.items), sizeFiltered: true };
    // Ask for more of the same rather than more often: a wider page is one request, and a
    // site that filters on its own side will simply return a full one.
    for (let round = 0; round < SIZE_FILTER_EXTRA_ROUNDS; round++) {
      if (o.sourcesKey !== sourcesSignature()) break;
      if (merged.items.length >= SIZE_FILTER_MIN_CARDS) break;
      const next = await run({ sizeHints: hints });
      const gained = keep(next.items);
      // Nobody left to ask, or nobody has anything that fits. Stop quietly and show the
      // shorter page — the owner's instruction was that the user must not be shown a
      // problem, not that the page must always be full.
      if (!gained.length && !(next.items || []).length) break;
      merged = {
        ...merged,
        items: online.mergeSearchResults([{ items: merged.items }, { items: gained }]).items,
        providerErrors: { ...(merged.providerErrors || {}), ...(next.providerErrors || {}) },
        totals: { ...(merged.totals || {}), ...(next.totals || {}) },
        paused: { ...(merged.paused || {}), ...(next.paused || {}) },
      };
    }
    return merged;
  }

  // The `internet-search` channel. The window's flag alone never decides curation.
  async function search(opts) {
    const o = { ...(opts || {}), sourcesKey: sourcesSignature() };
    // Both conditions, not just the renderer's flag: curation must never be able to
    // silently narrow a real search, whatever the renderer believes it asked for.
    const browsing = o.browse === true && !String(o.q || '').trim();
    // ONL-014b. The bookmarks travel with the request. They are the window's to carry and
    // nobody's to read — including the window's, which passes them back untouched. A token
    // that does not belong to this exact question is discarded rather than repaired.
    const token = onlineResume.parse(o.resume, onlineResume.signatureOf({ ...o, browse: browsing }));
    const merged = await searchFiltered(o, token, browsing);
    if (o.sourcesKey !== sourcesSignature()) return { ...nobodyLeft(), resume: null };
    return {
      ...merged,
      browsing,
      // ONL-004. How many each site found — for a question the user asked. The front page is
      // our selection, not an answer, and a count of it would describe nothing.
      totals: browsing ? {} : (merged.totals || {}),
      sizeFiltered: !browsing && !!merged.sizeFiltered,
      // LIB-014 stage 3. Which sites sat this search out because it has more words than they
      // take, and whether nobody was left to ask because of it.
      paused: merged.paused || {},
      allPaused: !!merged.allPaused,
      resume: onlineResume.forReply(token),
      nsfwAvailable: providers.explicitContentReachableIn(registry.active().filter(sourceEnabled)),
    };
  }

  return Object.freeze({
    status,
    suggestTags,
    search,
    // The pieces below are what the tests drive directly through main's `__test`, with
    // sites the shipped registry cannot produce (one that throws, one with no key, ...).
    searchOneProvider,
    searchAllProviders,
    searchRound,
    recordRound,
    suggestTagsFromProviders,
    suggestTagProviders,
    acceptedFormats: () => ACCEPTED_FORMAT_LIST,
    // BUG-020. The browse feed is deliberately shuffled, which is untestable against a
    // real clock; pinning the generator makes the order exact.
    setRandom: (fn) => { browseRandom = typeof fn === 'function' ? fn : Math.random; },
  });
}

module.exports = {
  create,
  // Exported for the module test: the bounds of a size-filtered top-up are a decision
  // (ONL-010), and a test should say the number it is checking against.
  SIZE_FILTER_MIN_CARDS,
  SIZE_FILTER_EXTRA_ROUNDS,
};
