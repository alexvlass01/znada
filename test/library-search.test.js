'use strict';

// LIB-014 stage 1. The Library search box finds file names AND tags; several words mean all
// of them; every Library view narrows through one function. Checked three ways:
//   * the pure rule (src/library-search.js) on the examples the owner was shown;
//   * that its words are the words the sites already make of the same text;
//   * through the REAL renderer code: the three view loaders, the Favorites/Folders list,
//     the content signature and the config-broadcast handler run whole in a vm with
//     synthetic IPC replies.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const LibrarySearch = require('../src/library-search');
const TagSuggest = require('../src/tag-suggest');
const gelbooru = require('../src/gelbooru');
const danbooru = require('../src/danbooru');
const { pathKey } = require('../src/path-key');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}
function same(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

// Brace-matched source of one renderer function, the way the other renderer tests take it.
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

// The whole `window.api.onConfig(...)` registration, cut out by its own braces.
function onConfigSource(source) {
  const start = source.indexOf('window.api.onConfig((cfg) => {');
  assert.ok(start >= 0, 'the config-broadcast handler moved');
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1) + ');';
    }
  }
  throw new Error('unterminated onConfig handler');
}

// Arrays made inside the vm belong to its realm; copy them into this one before comparing.
const names = (entries) => Array.from(entries, (entry) => (entry.item ? entry.item.path : entry.path).split('/').pop()).sort();

(async () => {
  // --- the rule itself ------------------------------------------------------------------
  same('empty text narrows nothing', LibrarySearch.parse('   '), []);
  same('separators alone narrow nothing', LibrarySearch.parse(' , , '), []);
  same('spaces separate words, case does not matter', LibrarySearch.parse('Sky  MOUNTAIN'), ['sky', 'mountain']);
  same('with a comma, a space stays inside a word', LibrarySearch.parse('blue sky, mountain'), ['blue sky', 'mountain']);
  same('an underscore reads as a space', LibrarySearch.parse('blue_sky'), ['blue sky']);
  same('a repeated word is one word', LibrarySearch.parse('sky sky'), ['sky']);
  same('a colon inside a name is kept — the Library has no search commands to refuse',
    LibrarySearch.parse('beatrice_(re:zero)'), ['beatrice (re:zero)']);
  same('Cyrillic words are lowercased like any other', LibrarySearch.parse('Небо Гори'), ['небо', 'гори']);

  const match = (text, name, tags) => LibrarySearch.matches(LibrarySearch.parse(text), name, tags);
  ok('no words: everything answers', match('', undefined, undefined));
  ok('a word is found in the file name', match('sun', 'Sunset.jpg', []));
  ok('a word is found in a tag, as a part of it', match('sky', 'IMG_0001.png', ['blue_sky']));
  ok('every word must be found — one missing word keeps the photo out', !match('sky mountain', 'IMG_0001.png', ['blue_sky']));
  ok('different words may be found in different tags', match('sky mountain', 'IMG_0001.png', ['blue_sky', 'mountain']));
  ok('…or one in the name and one in a tag', match('sky mountain', 'mountain.png', ['blue_sky']));
  ok('a typed underscore finds the spaced name and the underscored tag alike',
    match('blue_sky', 'blue sky.png', []) && match('blue_sky', 'x.png', ['blue_sky']) && match('blue sky,', 'blue_sky.png', []));
  ok('separate words may sit in different tags, a phrase may not',
    match('blue sky', 'x.png', ['blue_hair', 'sky']) && !match('blue sky,', 'x.png', ['blue_hair', 'sky']));
  ok('a phrase is not found in the wrong order, even where both of its words are',
    !match('blue sky,', 'sky blue.png', []) && !match('long_hair', 'x.png', ['hair_long']) && match('Long_Hair', 'x.png', ['LONG_HAIR']));
  ok('case does not matter in names or tags', match('sky', 'x.png', ['SKY']) && match('SKY', 'Skyline.JPG', []));
  ok('a photo without tags can only be found by its name', match('lake', 'lake.jpg', null) && !match('sky', 'lake.jpg', null));
  ok('Cyrillic names are found', match('гори', 'Гори взимку.jpg', []));

  // Nothing the old box found is lost. It looked for the whole trimmed text in the file name;
  // every word the rule looks for now is a piece of that text, so a name that held the text
  // holds each word as well. What changed is only that MORE photos answer: words apart, or in tags.
  const oldFound = (text, name) => name.toLowerCase().includes(text.trim().toLowerCase());
  const oldNames = ['Blue_Sky over sea.png', 'IMG_0001.png', 'a__b, c.jpg', 'Mountain Lake.jpg', 'sky blue.webp',
    'x  y.png', 'Гори взимку.jpg'];
  const oldTexts = ['sky', 'SKY', ' lake ', 'blue_sky', 'Blue_Sky over', 'over sea', 'img_0001', '_0001', 'sky_',
    'a__b', 'a__b, c', 'b, c', 'mountain lake', 'x  y', 'sky blue', 'гори взимку'];
  const oldPairs = [];
  for (const name of oldNames) for (const text of oldTexts) if (oldFound(text, name)) oldPairs.push([text, name]);
  ok('the examples cover what the old name search found', oldPairs.length >= 15);
  same('every photo the old name search found is still found', oldPairs.filter(([text, name]) => !match(text, name, [])), []);
  ok('…and more answers now: words apart in the name, or in the tags',
    !oldFound('lake mountain', 'Mountain Lake.jpg') && match('lake mountain', 'Mountain Lake.jpg', [])
    && !oldFound('blue sky', 'IMG_0001.png') && match('blue sky', 'IMG_0001.png', ['blue_sky']));

  // --- the same words the sites make of the same text -------------------------------------
  // Stage 3 moved the sites onto `TagSuggest.siteTags`, built on the same `splitTerms`, so the
  // text in the box means the same words on both tabs. Read back from what each site sends.
  const corpus = ['', 'sky', 'Sky Mountain', 'blue sky, mountain', ' a ,, b ', 'beatrice_(re:zero) 1girl',
    'rating:explicit sky', '-1girl sky', 'x,y,z', 'a\tb\nc', 'Небо гори', 'long hair,  blue   eyes '];
  for (const site of [gelbooru, danbooru]) {
    const disagree = corpus.filter((text) => {
      const words = TagSuggest.splitTerms(text).map((word) => word.replace(/\s+/g, '_'))
        .filter((word) => !TagSuggest.hasMetatag(word));
      const sent = site.buildSearchTags({ q: text }).split(' ');
      return JSON.stringify(TagSuggest.siteTags(text)) !== JSON.stringify(words)
        || JSON.stringify(sent.slice(0, words.length)) !== JSON.stringify(words);
    });
    same(`${site === gelbooru ? 'Gelbooru' : 'Danbooru'} splits the text into the same words`, disagree, []);
  }

  // --- the page loads the rule before the code that uses it -------------------------------
  const at = (file) => html.indexOf(`<script src="${file}"></script>`);
  ok('index.html loads tag-suggest, then library-search, then renderer',
    at('../src/tag-suggest.js') >= 0 && at('../src/tag-suggest.js') < at('../src/library-search.js')
    && at('../src/library-search.js') < at('renderer.js'));
  // In the page there is no `require`: the two files find each other through `window`.
  const tagSuggestSource = fs.readFileSync(path.join(ROOT, 'src', 'tag-suggest.js'), 'utf8');
  const librarySearchSource = fs.readFileSync(path.join(ROOT, 'src', 'library-search.js'), 'utf8');
  const page = {};
  page.window = page;
  vm.createContext(page);
  vm.runInContext(tagSuggestSource, page);
  vm.runInContext(librarySearchSource, page);
  ok('in the page, the rule publishes itself as window.LibrarySearch and uses the page TagSuggest',
    !!page.LibrarySearch && Array.from(page.LibrarySearch.parse('Blue_Sky sea')).join('|') === 'blue sky|sea');
  const bare = {};
  bare.window = bare;
  vm.createContext(bare);
  assert.throws(() => vm.runInContext(librarySearchSource, bare), /tag-suggest/,
    'loaded before tag-suggest.js, the rule must fail loudly instead of searching wrongly');
  ok('loaded before tag-suggest.js, the rule fails loudly', true);

  // --- the real renderer views --------------------------------------------------------------
  const empty = {};
  const reply = { expand: [], folder: { folders: [], images: [] }, removed: [] };
  const ctx = {
    LIB: { filter: 'all', tags: [], q: '', sort: 'name', folderPath: null, crumbs: [], shuffleRank: {} },
    config: { library: {} },
    allViewToken: 1,
    LibrarySearch,
    $: (selector) => ({ '#libGrid': {}, '#libEmpty': empty })[selector],
    normPathKey: pathKey,
    updateLibAvailableTags() {},
    assignedIds: () => new Set(), entrySize: () => 0, scheduleSizeReorder() {},
    setLibEmptyText: (key) => { ctx.emptyKey = key; },
    setLibViewHeader: (count) => { ctx.count = count; },
    renderEntriesLazily: (_grid, entries) => { ctx.shown = entries; },
    inRemovedView: () => ctx.LIB.filter === 'removed',
    window: { api: {
      expandFolders: async () => ({ images: reply.expand }),
      folderEntries: async () => reply.folder,
      libraryHiddenList: async () => ({ images: reply.removed }),
    } },
  };
  vm.createContext(ctx);
  for (const name of ['baseName', 'libMatchesTag', 'libNarrow', 'sortItems', 'poolImageMap', 'libSectionItems',
    'libList', 'libEmptyKey', 'libraryContentSig', 'libSearchMembershipChanged']) {
    vm.runInContext(functionSource(renderer, name), ctx);
  }
  for (const name of ['renderAllView', 'renderFolderView', 'renderRemovedView']) {
    vm.runInContext('async ' + functionSource(renderer, name), ctx);
  }

  const img = (id, where, tags = [], extra = {}) => ({ id, type: 'image', path: where, tags, addedAt: 1, ...extra });
  const library = () => ({
    a: img('a', 'C:/lib/IMG_0001.png', ['blue_sky', 'mountain']),
    b: img('b', 'C:/lib/sunset over sea.png', ['sea']),
    c: img('c', 'C:/lib/Mountain Lake.jpg'),
    d: img('d', 'C:/lib/city.png', ['night_sky'], { favorite: true }),
    e: img('e', 'C:/watched/IMG_0042.png', ['clear_sky']),
    g: img('g', 'C:/lib/portrait.png', ['blue_hair', 'sky']),
    f: { id: 'f', type: 'folder', path: 'C:/watched', tags: ['trip'], addedAt: 1 },
  });
  const all = async (q, tag = '') => {
    Object.assign(ctx.LIB, { filter: 'all', q, tags: tag ? [tag] : [], folderPath: null });
    ctx.config.library = library();
    ctx.emptyKey = undefined;
    ctx.shown = null;
    reply.expand = [{ id: 'x1', path: 'C:/watched/skyline.jpg' }, { id: 'x2', path: 'C:/watched/beach.jpg' }];
    await ctx.renderAllView(ctx.allViewToken);
    return names(ctx.shown);
  };

  same('All: an empty box shows everything', (await all('')).length, 8);
  same('All: a word finds photos by tag as well as by name — the three tagged "…sky" and skyline.jpg',
    await all('sky'), ['IMG_0001.png', 'IMG_0042.png', 'city.png', 'portrait.png', 'skyline.jpg']);
  same('All: two words keep only photos that have both', await all('sky mountain'), ['IMG_0001.png']);
  same('All: separate words may come from different tags', await all('blue sky'), ['IMG_0001.png', 'portrait.png']);
  same('All: an underscored tag is one phrase', await all('blue_sky'), ['IMG_0001.png']);
  same('All: so is a phrase ended by a comma', await all('blue sky,'), ['IMG_0001.png']);
  same('All: the name search works as before, whatever the case', await all('MOUNTAIN'), ['IMG_0001.png', 'Mountain Lake.jpg']);
  same('All: a name found by two of its words', await all('sunset sea'), ['sunset over sea.png']);
  same('All: a file name typed in full is still found', await all('img_0001.png'), ['IMG_0001.png']);
  same('All: the side-panel tag and the words both apply', await all('sky', 'mountain'), ['IMG_0001.png']);
  same('All: nothing found says so', [await all('zzz'), ctx.emptyKey], [[], 'library.noMatches']);
  same('All: separators alone narrow nothing', (await all(',')).length, 8);

  // An open folder: its subfolders stay navigable whatever the box says; photos in it are
  // found by name, and those that have a record also by their tags.
  const inFolder = async (q, tag = '') => {
    Object.assign(ctx.LIB, { filter: 'folder', q, tags: tag ? [tag] : [], folderPath: 'C:/watched' });
    ctx.config.library = library();
    ctx.shown = null;
    reply.folder = {
      folders: [{ path: 'C:/watched/2024', name: '2024' }],
      images: [{ path: 'C:/watched/skyline.jpg' }, { path: 'C:/watched/beach.jpg' }, { path: 'C:/watched/IMG_0042.png' }],
    };
    await ctx.renderFolderView(ctx.allViewToken);
    return names(ctx.shown);
  };
  same('Folder: a word finds a photo by name and a recorded one by its tag; the subfolder stays',
    await inFolder('sky'), ['2024', 'IMG_0042.png', 'skyline.jpg']);
  same('Folder: a photo without a record is found by its name only', await inFolder('beach'), ['2024', 'beach.jpg']);
  same('Folder: the side-panel tag still narrows the photos', await inFolder('', 'clear_sky'), ['2024', 'IMG_0042.png']);

  // The trash lists paths, not records: names only, and a tag chosen before cannot empty it.
  const trash = async (q, tag = '') => {
    Object.assign(ctx.LIB, { filter: 'removed', q, tags: tag ? [tag] : [], folderPath: null });
    ctx.shown = null;
    reply.removed = [{ path: 'C:/old/gone sky.png', type: 'image' }, { path: 'C:/old/old.png' }];
    await ctx.renderRemovedView(ctx.allViewToken);
    return names(ctx.shown);
  };
  same('Trash: the box finds names', await trash('sky'), ['gone sky.png']);
  same('Trash: a stray side-panel tag does not empty it', await trash('', 'mountain'), ['gone sky.png', 'old.png']);
  same('Trash: nor does it narrow a search', await trash('sky', 'mountain'), ['gone sky.png']);

  // Favorites and Folders: the plain list of records.
  const plain = (filter, q, tag = '') => {
    Object.assign(ctx.LIB, { filter, q, tags: tag ? [tag] : [], folderPath: null });
    ctx.config.library = library();
    return Array.from(ctx.libList(), (it) => it.id).sort();
  };
  same('Favorites: found by tag among favorites only', plain('favorite', 'sky'), ['d']);
  same('Favorites: a word no favorite has finds none', plain('favorite', 'mountain'), []);
  same('Folders: a folder record is found by its own tag', plain('folder', 'trip'), ['f']);
  same('Folders: and by its name', plain('folder', 'watched'), ['f']);

  // --- the grid notices when an edited tag changes what the search finds ---------------------
  const sig = (q, edit) => {
    ctx.LIB.q = q;
    ctx.LIB.tags = [];
    ctx.config.library = library();
    const before = ctx.libraryContentSig();
    edit(ctx.config.library);
    return before !== ctx.libraryContentSig();
  };
  ok('with words in the box, a tag that takes a photo into the results changes the content',
    sig('sky', (lib) => { lib.c.tags = ['sky']; }));
  ok('a tag that changes nothing for the search does not (no needless rebuild)',
    !sig('sky', (lib) => { lib.c.tags = ['lake']; }));
  ok('with an empty box, tags do not touch the content signature, as before',
    !sig('', (lib) => { lib.c.tags = ['sky']; }));

  const membership = (q, edit) => {
    ctx.LIB.q = q;
    const prev = library();
    ctx.config.library = library();
    edit(ctx.config.library);
    return ctx.libSearchMembershipChanged(prev);
  };
  ok('membership: a record that starts answering the search counts', membership('sky', (lib) => { lib.c.tags = ['sky']; }));
  ok('membership: a record that stops answering counts', membership('sky', (lib) => { lib.a.tags = []; }));
  ok('membership: an unrelated tag does not', !membership('sky', (lib) => { lib.c.tags = ['lake']; }));
  ok('membership: a newly materialized record alone does not', !membership('sky', (lib) => { lib.h = img('h', 'C:/watched/beach.jpg'); }));
  ok('membership: nothing counts while the box is empty', !membership('', (lib) => { lib.c.tags = ['sky']; }));

  // --- the real config-broadcast handler decides between a rebuild and the in-place upgrade ---
  const calls = { render: 0, upgrade: 0 };
  const hctx = {
    LIB: { filter: 'all', q: 'sky', tags: [] },
    config: { library: library(), monitors: {} },
    LibrarySearch,
    renderConfig() {}, renderHome() {}, refreshOnlineAddedState() {}, refreshAssignedHighlights() {},
    refreshFavoriteHighlights() {}, applyThemeToUI() {},
    $: (selector) => (selector === '#viewLibrary' ? { hidden: false } : null),
    document: { hidden: false },
    deferredLiveRefresh: { mark() {} },
    tryUpgradeMaterializedCards: () => { calls.upgrade++; return true; },
    renderLibrary: () => { calls.render++; },
    currentTheme: 'light', currentWallpaperTheme: 'light',
    window: { api: {
      onConfig: (fn) => { hctx.handler = fn; },
      getWallpaperTheme: () => new Promise(() => {}),
    } },
  };
  vm.createContext(hctx);
  for (const name of ['baseName', 'libMatchesTag', 'libraryContentSig', 'libSearchMembershipChanged', 'assignedIds',
    'assignedSig', 'sameTags', 'isFavoriteOnlyLibraryChange']) {
    vm.runInContext(functionSource(renderer, name), hctx);
  }
  vm.runInContext(onConfigSource(renderer), hctx);
  assert.ok(typeof hctx.handler === 'function', 'the handler was not registered');
  const broadcast = (q, edit) => {
    hctx.LIB.q = q;
    hctx.config = { library: library(), monitors: {} };
    calls.render = 0;
    calls.upgrade = 0;
    const next = { library: library(), monitors: {} };
    edit(next.library);
    hctx.handler(next);
    return { ...calls };
  };
  const materialize = (lib) => { lib.h = img('h', 'C:/watched/beach.jpg'); };
  same('broadcast: a photo materialized alone is upgraded in place, even while searching',
    broadcast('sky', materialize), { render: 0, upgrade: 1 });
  same('broadcast: the same broadcast that also takes another photo into the results rebuilds',
    broadcast('sky', (lib) => { materialize(lib); lib.c.tags = ['sky']; }), { render: 1, upgrade: 0 });
  same('broadcast: without words that combination keeps the in-place upgrade, as before',
    broadcast('', (lib) => { materialize(lib); lib.c.tags = ['sky']; }), { render: 0, upgrade: 1 });
  same('broadcast: a tag edit alone that changes the results rebuilds',
    broadcast('sky', (lib) => { lib.c.tags = ['sky']; }), { render: 1, upgrade: 0 });
  same('broadcast: a tag edit that changes nothing for the search leaves the grid alone',
    broadcast('sky', (lib) => { lib.c.tags = ['lake']; }), { render: 0, upgrade: 0 });

  console.log(`Library search PASS: ${passed} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
