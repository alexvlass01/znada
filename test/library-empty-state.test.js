'use strict';

// BUG-049. What the local library says when a view comes out empty, through the REAL
// renderer code: the three loaders run whole with synthetic IPC replies, and the
// Favorites/Folders branch of renderLibrary is cut out by its markers.
//
// The defect: a search with no matches over a full library said "Your library is empty —
// drop images here", which reads like the photos are gone.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const catalogues = Object.fromEntries(['en', 'ru', 'uk'].map((lang) => [
  lang, JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8')),
]));

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

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

function sectionConstant(source, name) {
  const line = source.split(/\r?\n/).find((text) => text.startsWith(`const ${name} = `));
  assert.ok(line, `missing const ${name}`);
  return line;
}

// The Favorites/Folders branch lives inside renderLibrary; take exactly that part.
function plainBranchSource(source) {
  const start = source.indexOf('  const items = libList();');
  const end = source.indexOf('  setLibViewHeader(items.length);', start);
  assert.ok(start >= 0 && end > start, 'the Favorites/Folders branch of renderLibrary moved');
  return `function renderPlainEmpty() {\n${source.slice(start, end)}\n}`;
}

const photo = (id, extra = {}) => ({ id, type: 'image', path: `C:/photos/${id}.png`, tags: [], ...extra });

(async () => {
  const empty = {};
  const reply = { expand: [], folder: { folders: [], images: [] }, removed: [] };
  const ctx = {
    LIB: { filter: 'all', tag: '', q: '', sort: 'name', folderPath: null, crumbs: [], shuffleRank: {} },
    config: { library: {} },
    allViewToken: 1,
    $: (selector) => ({ '#libGrid': {}, '#libEmpty': empty })[selector],
    baseName: (value) => value.split('/').pop(),
    normPathKey: require('../src/path-key').pathKey,
    assignedIds: () => new Set(), entrySize: () => 0, scheduleSizeReorder() {},
    setLibEmptyText: (key) => { ctx.emptyKey = key; },
    setLibViewHeader: (count) => { ctx.count = count; },
    renderEntriesLazily() {},
    inRemovedView: () => ctx.LIB.filter === 'removed',
    window: { api: {
      expandFolders: async () => ({ images: reply.expand }),
      folderEntries: async () => reply.folder,
      libraryHiddenList: async () => ({ images: reply.removed }),
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(sectionConstant(renderer, 'LIB_SECTION_EMPTY'), ctx);
  for (const name of ['libMatchesTag', 'sortItems', 'poolImageMap', 'libSectionItems', 'libList', 'libEmptyKey']) {
    vm.runInContext(functionSource(renderer, name), ctx);
  }
  for (const name of ['renderAllView', 'renderFolderView', 'renderRemovedView']) {
    vm.runInContext('async ' + functionSource(renderer, name), ctx);
  }
  vm.runInContext(plainBranchSource(renderer), ctx);

  const reset = ({ filter = 'all', q = '', tag = '', library = {} } = {}) => {
    Object.assign(ctx.LIB, { filter, q, tag, folderPath: filter === 'folder-open' ? 'C:/photos' : null });
    if (filter === 'folder-open') ctx.LIB.filter = 'folder';
    ctx.config.library = library;
    ctx.emptyKey = undefined;
    empty.hidden = undefined;
  };
  const full = { a: photo('a', { tags: ['nature'], favorite: true }), b: photo('b') };

  // --- All ------------------------------------------------------------------------
  reset({ q: 'no-such-name', library: full });
  await ctx.renderAllView(ctx.allViewToken);
  ok('All: a search with no matches over a full library says nothing matched',
    empty.hidden === false && ctx.emptyKey === 'library.noMatches');

  reset({ tag: 'absent', library: full });
  await ctx.renderAllView(ctx.allViewToken);
  ok('All: a tag with no matches says nothing matched', ctx.emptyKey === 'library.noMatches');

  reset({ library: {} });
  reply.expand = [{ id: 'watched', path: 'C:/watched/w.png' }];
  ctx.LIB.q = 'no-such-name';
  await ctx.renderAllView(ctx.allViewToken);
  ok('All: photos only from watched folders still count as a full library', ctx.emptyKey === 'library.noMatches');
  reply.expand = [];

  reset({ library: {} });
  await ctx.renderAllView(ctx.allViewToken);
  ok('All: a truly empty library keeps "your library is empty"', ctx.emptyKey === 'library.empty');

  reset({ q: 'anything', library: {} });
  await ctx.renderAllView(ctx.allViewToken);
  ok('All: searching an empty library still says it is empty, not "no matches"', ctx.emptyKey === 'library.empty');

  reset({ library: full });
  await ctx.renderAllView(ctx.allViewToken);
  ok('All: a library with photos shows no empty state at all', empty.hidden === true && ctx.emptyKey === undefined);

  // --- an open folder -------------------------------------------------------------
  reset({ filter: 'folder-open', q: 'no-such-name', library: full });
  reply.folder = { folders: [], images: [{ path: 'C:/photos/x.png' }] };
  await ctx.renderFolderView(ctx.allViewToken);
  ok('Folder: a search with no matches in a folder with photos says nothing matched', ctx.emptyKey === 'library.noMatches');

  reset({ filter: 'folder-open', library: full });
  reply.folder = { folders: [], images: [] };
  await ctx.renderFolderView(ctx.allViewToken);
  ok('Folder: a folder without images keeps "this folder has no images"', ctx.emptyKey === 'library.emptyFolder');

  reset({ filter: 'folder-open', q: 'x', library: full });
  await ctx.renderFolderView(ctx.allViewToken);
  ok('Folder: searching an empty folder still says the folder is empty', ctx.emptyKey === 'library.emptyFolder');

  // --- removed --------------------------------------------------------------------
  reset({ filter: 'removed', q: 'no-such-name', library: full });
  reply.removed = [{ path: 'C:/photos/gone.png', type: 'image' }];
  await ctx.renderRemovedView(ctx.allViewToken);
  ok('Removed: a search with no matches among removed photos says nothing matched', ctx.emptyKey === 'library.noMatches');

  reset({ filter: 'removed', library: full });
  reply.removed = [];
  await ctx.renderRemovedView(ctx.allViewToken);
  ok('Removed: nothing removed keeps its own explanation', ctx.emptyKey === 'library.removedEmpty');

  // --- Favorites and Folders ------------------------------------------------------
  reset({ filter: 'favorite', library: { b: photo('b') } });
  ctx.renderPlainEmpty();
  ok('Favorites: none marked says so, not that the library is empty', ctx.emptyKey === 'library.emptyFavorites');

  reset({ filter: 'favorite', q: 'no-such-name', library: full });
  ctx.renderPlainEmpty();
  ok('Favorites: a search with no matches among favorites says nothing matched', ctx.emptyKey === 'library.noMatches');

  reset({ filter: 'folder', library: full });
  ctx.renderPlainEmpty();
  ok('Folders: none added says so, not that the library is empty', ctx.emptyKey === 'library.emptyFolders');

  reset({ filter: 'folder', tag: 'absent', library: { f: { id: 'f', type: 'folder', path: 'C:/watched', tags: [] } } });
  ctx.renderPlainEmpty();
  ok('Folders: a tag with no matches among folders says nothing matched', ctx.emptyKey === 'library.noMatches');

  // --- every caption a view can choose exists in the reference catalogues --------
  const keys = ['empty', 'emptyFolder', 'removedEmpty', 'noMatches', 'emptyFavorites', 'emptyFolders'];
  const missing = [];
  for (const [lang, data] of Object.entries(catalogues)) {
    for (const key of keys) if (typeof data.library[key] !== 'string' || !data.library[key].trim()) missing.push(`${lang}:${key}`);
  }
  ok('every empty-state caption exists in en, ru and uk', missing.length === 0);

  console.log(`Library empty state PASS: ${passed} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
