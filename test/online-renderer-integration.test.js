'use strict';

// ONL-014b/c. Main owns the opaque resume token, but the renderer carries it between
// clicks. Even an error response can contain an UPDATED token: that is how consecutive
// failures reach MAX_FAILS instead of making “Show more” retry forever.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8')
  .split('\r\n').join('\n');
const match = renderer.match(/async function loadInternetResults\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(match, 'loadInternetResults must remain an explicit renderer boundary');

const firstToken = { sig: 's', slots: { site: { at: 'cursor-2', fails: 0 } } };
const failedOnce = { sig: 's', slots: { site: { at: 'cursor-2', fails: 1 } } };
const INTERNET = {
  q: 'sky', sort: 'date_added', purity: { sfw: true }, resume: firstToken,
  nsfwAvailable: false, searched: false,
};
const sent = [];
const replies = [
  { items: [], error: 'network', resume: failedOnce, nsfwAvailable: false },
  { items: [], error: 'network', resume: null, nsfwAvailable: false },
];
const context = {
  INTERNET,
  t: (key) => key,
  OnlineBrowse: { isBrowse: () => false },
  window: { api: { internetSearch: async (opts) => { sent.push(opts.resume); return replies.shift(); } } },
  onlineSearchIsCurrent: () => true,
  updatePurityToggle: () => {},
  onlineGridDescriptor: () => { throw new Error('an error reply must not build cards'); },
};
const loadInternetResults = vm.runInNewContext(`(${match[0]})`, context);

(async () => {
  assert.strictEqual((await loadInternetResults(1)).length, 0);
  assert.strictEqual(sent[0], firstToken, 'the first request starts from the original token');
  assert.strictEqual(INTERNET.resume, failedOnce, 'the first failure token must be carried to the next click');

  assert.strictEqual((await loadInternetResults(1)).length, 0);
  assert.strictEqual(sent[1], failedOnce, 'the second request must include the first recorded failure');
  assert.strictEqual(INTERNET.resume, null, 'a source finished by MAX_FAILS must hide Show more');

  const transportToken = { sig: 'transport', slots: { site: { at: 3, fails: 0 } } };
  INTERNET.resume = transportToken;
  context.window.api.internetSearch = async () => { throw new Error('IPC transport'); };
  assert.strictEqual((await loadInternetResults(1)).length, 0);
  assert.strictEqual(INTERNET.resume, transportToken, 'an IPC exception with no replacement token keeps the old place');

  // -------------------------------------------------------------------------
  // Who is allowed to clear `ONLINE.loading`, and what happens when the page that
  // owns it throws.
  //
  // The flag gates "Show more" and nothing else clears it on its own, so a search
  // that leaves it set makes the tab look permanently busy — and `ONLINE.loaded` is
  // already true by then, so returning to the tab does not search again either.
  //
  // Two of these are CHARACTERIZATION: they record handoffs that already work, so a
  // later "fix" cannot quietly remove them. The third is the defect.
  // -------------------------------------------------------------------------
  const fnSrc = (name) => {
    const m = renderer.match(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name} must remain an explicit renderer boundary`);
    return m[0];
  };

  const makeOnlineCtx = (reply) => {
    const note = { textContent: '' };
    const more = { disabled: false, hidden: false };
    const ctx = {
      LIB: { filter: 'online' },
      ONLINE: { generation: 0, loading: false, loaded: false, view: 'search', entries: [] },
      INTERNET: { q: '', sort: 'date_added', purity: {}, resume: { tok: 1 }, sortTouched: false },
      OnlineBrowse: { isBrowse: () => false, sortTouchedAfterSearch: (q, touched) => touched },
      console: { error: () => {} },
      t: (k) => k,
      $: (sel) => ({ '#whNote': note, '#whMore': more, '#whQuery': { value: '' } }[sel] || null),
      hideOnlineTagSuggest: () => {},
      applyFavToggleUI: () => {},
      replaceOnlineEntries: () => {},
      appendOnlineEntries: () => {},
      setLibViewHeader: () => {},
      updatePurityToggle: () => {},
      onlineGridDescriptor: (kind, item) => ({ kind, item }),
      // ONL-003. The real loader now also reports each round to the scroll guard. It is a
      // real one rather than a stub, so these cases keep exercising the same decisions
      // the app makes — its own behaviour is covered in test/auto-load.test.js.
      onlineAutoLoad: require('../renderer/auto-load').createAutoLoader(),
      window: { api: { internetSearch: () => reply } },
    };
    vm.createContext(ctx);
    for (const n of ['onlineSearchIsCurrent', 'loadInternetResults', 'publishOnlineBatch',
      'finalizeOnlineFeed', 'doOnlineSearch', 'loadMoreOnline']) {
      vm.runInContext(fnSrc(n), ctx);
    }
    ctx.note = note; ctx.more = more;
    return ctx;
  };

  {
    const ctx = makeOnlineCtx(Promise.resolve({ items: [], error: null, resume: null }));
    ctx.INTERNET.searchError = 'previous failed source';
    await ctx.doOnlineSearch(true);
    assert.strictEqual(ctx.note.textContent, 'online.noResults', 'fresh successful search clears stale source error');
  }

  // Characterization 1. Switching to a local rail already clears the flag by hand, in
  // renderLibraryCore's non-online branch. The simulation below reproduces that reset,
  // so it proves nothing about the real one — this assertion is what pins it. Delete the
  // reset and this case genuinely does strand.
  {
    const coreStart = renderer.indexOf('function renderLibraryCore()');
    const coreEnd = renderer.indexOf('\nfunction ', coreStart + 1);
    const leaveBranch = renderer.slice(renderer.indexOf('if (online) online.hidden = true;', coreStart), coreEnd);
    assert.ok(leaveBranch.includes('ONLINE.loading = false;'),
      'leaving Online for a local rail no longer releases the tab, so a reply still in '
      + 'flight leaves "Show more" dead until the app restarts');
  }

  {
    let release;
    const ctx = makeOnlineCtx(new Promise((r) => { release = r; }));
    const search = ctx.doOnlineSearch(true);
    await new Promise((r) => { setTimeout(r, 5); });
    assert.strictEqual(ctx.ONLINE.loading, true, 'a search in flight must mark the tab busy');
    ctx.ONLINE.generation += 1; ctx.ONLINE.loading = false; ctx.ONLINE.loaded = false;
    ctx.LIB.filter = 'all'; // <- the leave path
    release({ items: [], resume: null });
    await search;
    assert.strictEqual(ctx.ONLINE.loading, false,
      'a reply arriving after the user left the tab re-marked it busy');
  }

  // Characterization 2. A newer search owns the flag; the older one must NOT clear it
  // on its way out, or the newer one would look finished before it is.
  {
    let releaseOld; let releaseNew;
    const ctx = makeOnlineCtx(new Promise((r) => { releaseOld = r; }));
    const first = ctx.doOnlineSearch(true);
    await new Promise((r) => { setTimeout(r, 5); });
    ctx.window.api.internetSearch = () => new Promise((r) => { releaseNew = r; });
    const second = ctx.doOnlineSearch(true);
    await new Promise((r) => { setTimeout(r, 5); });
    releaseOld({ items: [], resume: null });
    await first;
    assert.strictEqual(ctx.ONLINE.loading, true,
      'the superseded search cleared a flag the newer one owns');
    releaseNew({ items: [], resume: null });
    await second;
    assert.strictEqual(ctx.ONLINE.loading, false, 'the newest search never released the tab');
  }

  // The defect. Publishing a page touches the grid, the header and the note; any of
  // them throwing used to skip the release entirely and kill the tab for the session.
  {
    const ctx = makeOnlineCtx(Promise.resolve({ items: [{ cardKind: 'internet' }], resume: { tok: 9 } }));
    ctx.appendOnlineEntries = () => { throw new Error('render blew up'); };
    vm.runInContext(fnSrc('publishOnlineBatch'), ctx); // rebind to the throwing helper
    await ctx.doOnlineSearch(true); // must NOT reject
    assert.strictEqual(ctx.ONLINE.loading, false,
      'a search that threw while drawing left the tab busy forever');
    assert.strictEqual(ctx.more.disabled, false, '"Show more" stayed disabled after a failed page');
    // NOT `ok(textContent)`: the note already says "loading" from before the await, so a
    // truthiness check here passes even when the failure is never reported. Mutation
    // caught exactly that.
    assert.strictEqual(ctx.note.textContent, 'online.error',
      'a search that failed while drawing left the tab saying it was still loading');
  }

  // The same for "Show more", which is the control that would have to clear it.
  {
    const ctx = makeOnlineCtx(Promise.resolve({ items: [{ cardKind: 'internet' }], resume: { tok: 9 } }));
    ctx.appendOnlineEntries = () => { throw new Error('render blew up'); };
    vm.runInContext(fnSrc('publishOnlineBatch'), ctx);
    await ctx.loadMoreOnline();
    assert.strictEqual(ctx.ONLINE.loading, false, '"Show more" that threw left the tab busy forever');
    assert.strictEqual(ctx.more.disabled, false, '"Show more" disabled itself permanently');
  }

  // BUG-030. "No internet connection" sends the user to check the wrong thing when the
  // browser plainly works and it is the server that went quiet. The client tells the two
  // apart now; the feed has to as well, or the distinction dies one layer above it.
  {
    const say = async (error) => {
      const note = { textContent: '' };
      const ctx = {
        LIB: { filter: 'online' },
        ONLINE: { generation: 0, loading: false, loaded: false, view: 'favorites', entries: [] },
        CLOUDFAV: { ids: new Set(), fetched: false },
        console: { error: () => {} },
        t: (k) => k,
        $: (sel) => ({ '#whNote': note, '#whMore': { hidden: false, disabled: false } }[sel] || null),
        replaceOnlineEntries: () => {},
        setLibViewHeader: () => {},
        onlineGridDescriptor: () => ({}),
        // The real one: which words a code gets is decided in a single place shared by
        // both windows, and a stub here would let that mapping rot unnoticed.
        CardTransfer: require('../renderer/card-transfer'),
        window: { api: { cloudFavorites: async () => ({ items: [], error }) } },
      };
      vm.createContext(ctx);
      vm.runInContext(fnSrc('loadFavoritesFeed'), ctx);
      await ctx.loadFavoritesFeed();
      return note.textContent;
    };
    assert.strictEqual(await say('session_changed'), 'online.sessionChanged',
      'a code only a machine understands was shown to the user in English');
    assert.strictEqual(await say('timeout'), 'online.timeout',
      'a server that went quiet was reported as the user having no internet');
    assert.strictEqual(await say('network'), 'online.offline',
      'a genuinely dead connection stopped saying so');
    assert.strictEqual(await say('429'), 'online.error',
      'an ordinary server error lost its own wording');
  }

  console.log('Online renderer resume integration OK across provider failures.');
})().catch((err) => { console.error(err); process.exit(1); });
