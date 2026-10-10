'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'ru.json'), 'utf8'));
const uk = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'uk.json'), 'utf8'));
const contexts = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'context', 'generated.json'), 'utf8'));


let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

const localQueryRow = html.slice(html.indexOf('<div class="lib-local-query-row">'), html.indexOf('<button id="libRefresh"'));
ok('local query row contains only search controls, not import actions',
  localQueryRow.includes('id="libSearch"') && !html.includes('id="libSearchSubmit"')
  && !localQueryRow.includes('libAddPhotos') && !localQueryRow.includes('libAddFolder'));
ok('import actions remain in a separate action group beside the query',
  html.indexOf('id="libAddPhotos"') > html.indexOf(localQueryRow) + localQueryRow.length
  && html.indexOf('id="libAddFolder"') > html.indexOf('id="libAddPhotos"'));
for (const id of ['onlineQuickScreen', 'onlineQuickPurity', 'onlineQuickSources', 'whFilterToggle']) {
  const classes = html.match(new RegExp('<button[^>]*class="([^"]+)"[^>]*id="' + id + '"'))?.[1].split(' ') || [];
  ok(`${id} reuses the standard pill and shared toolbar button sizing`, classes.includes('pill') && classes.includes('lib-filter-btn'));
}
ok('Online retains its explicit localized query action',
  /id="whSearch"[^>]*data-i18n="online.search"/.test(html));
ok('local field can shrink beside its button despite narrow-window flex overrides',
  /\.lib-local-query-row > \.lib-searchbox,[\s\S]*?\{\s*flex: 1 1 0; min-width: 0;/.test(css));
const actionsStart = renderer.indexOf('const canAddLocalSources = !LIB.folderPath;');
const actionsEnd = renderer.indexOf("if (LIB.filter === 'online')", actionsStart);
assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
for (const [filter, folderPath, photoVisible, folderVisible] of [
  ['all', '', true, true], ['favorite', '', false, false],
  ['folder', '', false, true], ['online', '', false, false], ['folder', 'nested', false, false],
]) {
  const photo = { hidden: false, classList: { toggle: () => assert.fail('import must not compete with Search as a suggested action') } };
  const folder = { hidden: false, classList: photo.classList };
  vm.runInNewContext(renderer.slice(actionsStart, actionsEnd), {
    LIB: { filter, folderPath }, $: (selector) => selector === '#libAddPhotos' ? photo : folder,
  });
  ok(`import visibility is preserved in ${filter}${folderPath ? '/nested' : ''}`,
    photo.hidden === !photoVisible && folder.hidden === !folderVisible);
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


// A tag is an additional predicate, not a destination replacing Favorites.
const localFilterContext = {
  LIB: { filter: 'favorite', tags: ['sameko_saba'], q: '' },
  config: { library: {
    a: { id: 'a', path: 'a.png', favorite: true, tags: ['sameko_saba', 'nature'] },
    b: { id: 'b', path: 'b.png', favorite: true, tags: ['nature'] },
    c: { id: 'c', path: 'c.png', favorite: false, tags: ['sameko_saba'] },
  } },
  baseName: (value) => value, sortItems() {},
  LibrarySearch: require('../src/library-search'),
};
vm.createContext(localFilterContext);
vm.runInContext(functionSource(renderer, 'libMatchesTag') + functionSource(renderer, 'libNarrow') + functionSource(renderer, 'libSectionItems')
  + functionSource(renderer, 'libList'), localFilterContext);
ok('Favorites intersects with the selected tag instead of showing all favorites',
  localFilterContext.libList().map((item) => item.id).join(',') === 'a');
localFilterContext.LIB.tags.push('nature');
ok('Favorites requires both chosen tags', localFilterContext.libList().map((item) => item.id).join(',') === 'a');
localFilterContext.LIB.q = 'b.png';
ok('filename search intersects with favorite and tag predicates', localFilterContext.libList().length === 0);
localFilterContext.LIB.tags = [];
ok('clearing only the tag preserves filename search and Favorites', localFilterContext.libList()[0]?.id === 'b');
localFilterContext.LIB.q = '';
ok('unfiltered Favorites still excludes non-favorites', localFilterContext.libList().map((item) => item.id).join(',') === 'a,b');
localFilterContext.config.library.d = { id: 'd', path: 'folder', type: 'folder', tags: ['sameko_saba'] };
localFilterContext.LIB.filter = 'folder';
localFilterContext.LIB.tags = ['sameko_saba'];
ok('Folders combines its type predicate with the tag', localFilterContext.libList().map((item) => item.id).join(',') === 'd');
localFilterContext.config.library.d.tags.push('nature');
localFilterContext.config.library.e = { id: 'e', path: 'other-folder', type: 'folder', tags: ['sameko_saba'] };
localFilterContext.LIB.tags.push('nature');
ok('Folders requires both chosen tags on each folder record', localFilterContext.libList().map((item) => item.id).join(',') === 'd');
vm.runInContext(functionSource(renderer, 'libraryContentSig'), localFilterContext);
const beforeTagEdit = localFilterContext.libraryContentSig();
localFilterContext.config.library.a.tags = [];
ok('an active tag membership change invalidates cached content', localFilterContext.libraryContentSig() !== beforeTagEdit);
const railRule = css.match(/\.lib-rail\s*\{([^}]+)\}/)?.[1] || '';
ok('account text cannot expand the rail beyond its explicit flex width',
  /min-width:\s*0\s*;/.test(railRule));
// A width preference must not reload data or restart Online queries.
const sidebarClasses = {};
const sidebarAttrs = {};
const sidebarWrites = [];
const sidebarButton = { dataset: {}, setAttribute: (k, v) => { sidebarAttrs[k] = v; } };
const sidebarConfig = { librarySidebarCollapsed: false };
const sidebarResizeEvents = [];
let sidebarGrid = null;
const sidebarView = { classList: {
  contains: (key) => !!sidebarClasses[key],
  toggle: (key, value) => {
    const changed = !!sidebarClasses[key] !== value;
    sidebarClasses[key] = value;
    if (changed && sidebarGrid) {
      sidebarGrid.clientWidth = value ? 840 : 720;
      sidebarResizeEvents.push(`width:${sidebarGrid.clientWidth}`);
    }
  },
} };
const sidebarContext = {
  config: sidebarConfig, Promise, t: (key) => key,
  $: (sel) => sel === '#viewLibrary' ? sidebarView : sidebarButton,
  activeLibraryGrid: () => sidebarGrid,
  beginLibraryResizeAnchor: (grid) => { sidebarResizeEvents.push(`capture:${grid.clientWidth}`); },
  layoutLibGrid: (grid) => {
    sidebarResizeEvents.push(`layout:${grid.clientWidth}`);
    grid.layoutWidth = grid.clientWidth;
  },
  scheduleLibraryResizeFinish: (grid) => {
    assert.strictEqual(grid.layoutWidth, grid.clientWidth, 'settle starts only after synchronous layout');
    sidebarResizeEvents.push(`finish:${grid.clientWidth}`);
  },
  window: { api: { setConfig: (patch) => { sidebarWrites.push(patch); return Promise.resolve(); } } },
};
const sidebarStart = renderer.indexOf('function setLibrarySidebarCollapsed(');
const sidebarEnd = renderer.indexOf('function initLibrary()', sidebarStart);
vm.createContext(sidebarContext);
vm.runInContext(renderer.slice(sidebarStart, sidebarEnd), sidebarContext);
sidebarContext.setLibrarySidebarCollapsed(true);
ok('restoring icon rail updates accessibility without a config write',
  sidebarClasses['sidebar-collapsed'] && sidebarAttrs['aria-expanded'] === 'false'
  && sidebarAttrs['aria-label'] === 'library.expandSidebar' && sidebarWrites.length === 0);
sidebarContext.setLibrarySidebarCollapsed(true, { persist: true });
sidebarContext.setLibrarySidebarCollapsed(true, { persist: true });
ok('collapse saves only changed preference', sidebarWrites.length === 1 && sidebarConfig.librarySidebarCollapsed === true);
sidebarContext.setLibrarySidebarCollapsed(false, { persist: true });
ok('expansion restores labels and toggle meaning',
  !sidebarClasses['sidebar-collapsed'] && sidebarAttrs['aria-expanded'] === 'true'
  && sidebarAttrs['aria-label'] === 'library.collapseSidebar' && sidebarWrites.length === 2);

// A sidebar resize is not a window resize. Capture the old geometry before the CSS
// change and use the existing layout lifecycle before returning to the browser.
// This is a handler-order regression, not a substitute for native visual QA.
for (const id of ['libGrid', 'whGrid']) {
  sidebarGrid = { id, clientWidth: 720, layoutWidth: 720, isConnected: true, offsetParent: {}, entries: [] };
  const originalEntries = sidebarGrid.entries;
  for (let cycle = 0; cycle < 2; cycle++) {
    sidebarResizeEvents.length = 0;
    sidebarContext.setLibrarySidebarCollapsed(true, { persist: true });
    ok(`${id}: collapse captures before widening and settles the existing layout`,
      sidebarResizeEvents.join('|') === 'capture:720|width:840|layout:840|finish:840');
    sidebarResizeEvents.length = 0;
    sidebarContext.setLibrarySidebarCollapsed(true);
    ok(`${id}: unchanged restored state does not start another layout`, sidebarResizeEvents.length === 0);
    sidebarContext.setLibrarySidebarCollapsed(false, { persist: true });
    ok(`${id}: expansion commits shrink before yielding to paint`,
      sidebarResizeEvents.join('|') === 'capture:840|width:720|layout:720|finish:720');
  }
  ok(`${id}: toggles retain the same feed model`, sidebarGrid.entries === originalEntries);
}
for (const hiddenGrid of [
  { isConnected: true, offsetParent: null },
  { isConnected: false, offsetParent: {} },
]) {
  sidebarGrid = hiddenGrid;
  sidebarResizeEvents.length = 0;
  sidebarContext.setLibrarySidebarCollapsed(true);
  sidebarContext.setLibrarySidebarCollapsed(false);
  ok('hidden/detached gallery never starts a resize session',
    sidebarResizeEvents.every((event) => event.startsWith('width:')));
}
sidebarGrid = null;
sidebarContext.setLibrarySidebarCollapsed(true);
sidebarContext.setLibrarySidebarCollapsed(false);
ok('a not-yet-mounted gallery can restore its sidebar state', !sidebarClasses['sidebar-collapsed']);

// Real delegated binding must still reach tags after moving them out of the rail.
let navClick;
let navRenders = 0;
let exits = 0;
const navState = { filter: 'all', tags: [] };
const navStart = renderer.indexOf("const rail = document.querySelector('#viewLibrary');");
const navEnd = renderer.indexOf('// Click on empty space', navStart);
assert.ok(navStart >= 0 && navEnd > navStart);
// DESIGN-007: the rail decides "another section" or "the open one again" through these.
let toTop = 0;
const navContext = {
  document: { querySelector: () => ({ addEventListener: (_event, fn) => { navClick = fn; } }) },
  $: () => null, LIB: navState, ONLINE: { view: 'search' }, closeLibPopup() {}, clearSelection() {}, syncSelectionUI() {},
  selectLibrarySection: (filter) => { navState.filter = filter; navRenders++; exits++; },
  setLibraryTag: (tag) => { navState.tags = tag ? [tag] : []; },
  exitFolderState: () => { exits++; }, renderLibrary: () => { navRenders++; },
  scrollOpenViewToTop: () => { toTop++; },
};
vm.createContext(navContext);
vm.runInContext(['libOpenSection', 'openLibrarySectionOrTop', 'openLibraryTagOrTop']
  .map((name) => functionSource(renderer, name)).join('\n'), navContext);
vm.runInContext(renderer.slice(navStart, navEnd), navContext);
for (const filter of ['online', 'favorite', 'folder', 'all']) {
  navClick({ target: { closest: () => ({ dataset: { filter } }) } });
  ok('delegation selects ' + filter, navState.filter === filter);
}
navClick({ target: { closest: () => ({ dataset: { tag: 'sameko_saba' }, closest: () => null }) } });
ok('tag button delegates to filtering without section navigation', navState.tags.join(',') === 'sameko_saba' && navState.filter === 'all');
navClick({ target: { closest: () => ({ dataset: { filter: 'all' } }) } });
ok('the open section pressed again goes to the top instead of opening it again', toTop === 1 && navRenders === 4);
navClick({ target: { closest: () => null } });
ok('non-navigation controls do not reset the section', navRenders === 4 && exits === 4);
const railMarkup = html.slice(html.indexOf('<aside class="lib-rail">'), html.indexOf('</aside>', html.indexOf('<aside class="lib-rail">')));
ok('only permanent destinations live in the rail',
  !railMarkup.includes('libTagSection') && !railMarkup.includes('onlineQuickFilters') && !railMarkup.includes('onlineFilterPopover')
  && ['all', 'favorite', 'folder', 'online'].every((id) => railMarkup.includes('data-filter="' + id + '"')));
ok('context filters live with the corresponding search, never Home or Appearance',
  html.indexOf('id="libTagSection"') > html.indexOf('id="libLocal"')
  && html.indexOf('id="libTagSection"') < html.indexOf('id="libOnline"')
  && html.indexOf('id="onlineQuickFilters"') > html.indexOf('id="onlineSearchBar"')
  && html.indexOf('id="onlineFilterPopover"') > html.indexOf('id="onlineQuickFilters"'));
ok('one search field contains the selected tags, with no separate tag search', html.includes('id="libActiveTags"') && html.includes('id="libQueryClear"') && !html.includes('id="libTagSearch"'));
ok('tag picker belongs to the query without a separate Tags toggle', localQueryRow.includes('id="libTagsPanel"') && !html.includes('id="libTagsToggle"'));
ok('tag picker has bounded overlay and a scrolling list', css.includes('.lib-tag-picker') && css.includes('max-height: 244px') && /\.lib-railtags\s*\{[^}]*overflow-y:\s*auto/s.test(css));
ok('locales explain the unified query and modifier', en.library.searchOrTagPh && ru.library.searchOrTagPh && uk.library.searchOrTagPh && en.library.tagToggleHint && ru.library.tagToggleHint);
ok('context records the unified placeholder and empty-state roles', contexts.entries['library.searchOrTagPh']?.contexts.some((x) => x.type === 'placeholder') && contexts.entries['library.noTagsFound']);

// Execute the actual local loaders with synthetic IPC replies. This tests the data
// handed TO the gallery; its layout, virtualization and card builders are not changed.
(async () => {
  const nodes = { '#libGrid': {}, '#libEmpty': {} };
  const pool = {
    a: { id: 'a', type: 'image', path: 'C:/photos/nested/a.png', tags: ['sameko_saba', 'nature'], favorite: true },
    b: { id: 'b', type: 'image', path: 'C:/photos/nested/b.png', tags: ['nature'] },
    c: { id: 'c', type: 'image', path: 'C:/elsewhere/c.png', tags: ['sameko_saba'] },
  };
  const originalPool = JSON.stringify(pool);
  const ctx = {
    LIB: { filter: 'all', tags: [], q: '', sort: 'name', folderPath: null, crumbs: [], shuffleRank: {} },
    ONLINE: { view: 'search', entries: [], generation: 0, renderEpoch: 0 },
    config: { library: pool }, allViewToken: 1,
    $: (sel) => nodes[sel],
    baseName: (value) => value.split('/').pop(),
    normPathKey: require('../src/path-key').pathKey,
    updateLibAvailableTags() {},
    assignedIds: () => new Set(), entrySize: () => 0, scheduleSizeReorder() {},
    setLibEmptyText: (value) => { ctx.emptyText = value; },
    setLibViewHeader: (value) => { ctx.count = value; },
    renderEntriesLazily: (_grid, entries) => { ctx.entries = entries; },
    closeLibPopup() {}, clearSelection() { ctx.selectionClears++; }, syncSelectionUI() {},
    selectionClears: 0, renders: 0,
    renderLibrary() { ctx.renders++; ctx.allViewToken++; },
    exitFolderState() { ctx.LIB.folderPath = null; ctx.LIB.crumbs = []; },
    inRemovedView: () => ctx.LIB.filter === 'removed',
    librarySignature: () => 'unchanged',
    window: { api: {
      expandFolders: async () => ({ images: [{ id: 'ephemeral', path: 'C:/photos/nested/e.png' }] }),
      folderEntries: async () => ({
        folders: [{ name: 'child', path: 'C:/photos/nested/child' }],
        images: ['A', 'b', 'e'].map((name) => ({ path: `C:/photos/nested/${name}.png` })),
      }),
    } },
  };
  vm.createContext(ctx);
  ctx.LibrarySearch = require('../src/library-search');
  for (const name of ['libMatchesTag', 'libNarrow', 'setLibraryTag', 'sortItems', 'poolImageMap', 'libViewKey', 'libRenderKey', 'selectLibrarySection', 'libEmptyKey']) {
    vm.runInContext(functionSource(renderer, name), ctx);
  }
  for (const name of ['renderAllView', 'renderFolderView']) {
    vm.runInContext('async ' + functionSource(renderer, name), ctx);
  }
  await ctx.renderAllView(ctx.allViewToken);
  ok('All without a tag keeps pooled and ephemeral images', ctx.count === 4);
  const unfilteredView = ctx.libViewKey(), unfilteredRender = ctx.libRenderKey();
  ctx.setLibraryTag('sameko_saba');
  ok('selecting a tag invalidates view and render identities', ctx.libViewKey() !== unfilteredView && ctx.libRenderKey() !== unfilteredRender);
  await ctx.renderAllView(ctx.allViewToken);
  ok('All applies tags before handing entries to the gallery', ctx.entries.map((en) => en.id).join(',') === 'a,c');
  ctx.setLibraryTag('nature', 'toggle');
  await ctx.renderAllView(ctx.allViewToken);
  ok('All requires both selected tags and excludes untagged folder photos', ctx.entries.map((en) => en.id).join(',') === 'a');
  const orderedKey = ctx.libViewKey();
  ctx.LIB.tags.reverse();
  ok('view identity ignores tag selection order', ctx.libViewKey() === orderedKey);
  ctx.setLibraryTag('sameko_saba');
  ctx.LIB.q = 'c.png';
  await ctx.renderAllView(ctx.allViewToken);
  ok('All combines the filename query with the tag', ctx.count === 1 && ctx.entries[0].id === 'c');
  ctx.setLibraryTag('absent');
  await ctx.renderAllView(ctx.allViewToken);
  ok('an unmatched tag has honest empty results', ctx.count === 0 && nodes['#libEmpty'].hidden === false
    && ctx.emptyText === 'library.noMatches');
  ctx.LIB.q = '';
  ctx.setLibraryTag('');
  await ctx.renderAllView(ctx.allViewToken);
  ok('clearing the tag restores all images including ephemeral ones', ctx.count === 4 && ctx.libViewKey() === unfilteredView);

  ctx.LIB.filter = 'folder'; ctx.LIB.folderPath = 'C:/photos/nested';
  ctx.LIB.crumbs = [{ path: 'C:/photos' }, { path: ctx.LIB.folderPath }];
  const folderContext = JSON.stringify([ctx.LIB.filter, ctx.LIB.folderPath, ctx.LIB.crumbs]);
  ctx.setLibraryTag('sameko_saba');
  ok('tag selection preserves nested folder path and breadcrumbs', JSON.stringify([ctx.LIB.filter, ctx.LIB.folderPath, ctx.LIB.crumbs]) === folderContext);
  await ctx.renderFolderView(ctx.allViewToken);
  ok('folder tag filtering uses canonical path metadata, not other folders', ctx.count === 2 && ctx.entries[0].kind === 'subfolder' && ctx.entries[1].id === 'a');
  ctx.setLibraryTag('nature', 'toggle');
  await ctx.renderFolderView(ctx.allViewToken);
  ok('an open folder requires both selected tags while keeping child folders navigable', ctx.count === 2 && ctx.entries[1].id === 'a');
  ctx.setLibraryTag('sameko_saba');
  const rendersBeforeRepeat = ctx.renders;
  ctx.setLibraryTag('sameko_saba');
  ok('reselecting the same tag does not rebuild the list', ctx.renders === rendersBeforeRepeat);
  // The real per-chip event binding is exercised in library-multi-tags.test.js.
  const clearTag = () => ctx.setLibraryTag('');
  clearTag();
  await ctx.renderFolderView(ctx.allViewToken);
  ok('clear chip restores the same nested folder including untagged files', ctx.count === 4 && JSON.stringify([ctx.LIB.filter, ctx.LIB.folderPath, ctx.LIB.crumbs]) === folderContext);
  ctx.LIB.q = 'b.png'; ctx.setLibraryTag('sameko_saba');
  await ctx.renderFolderView(ctx.allViewToken);
  ok('folder filename and tag predicates intersect; subfolders remain navigable', ctx.count === 1 && ctx.entries[0].kind === 'subfolder');

  let resolveFolder;
  ctx.window.api.folderEntries = () => new Promise((resolve) => { resolveFolder = resolve; });
  const beforeLate = ctx.entries;
  const pending = ctx.renderFolderView(ctx.allViewToken);
  ctx.setLibraryTag('nature');
  resolveFolder({ images: [{ path: pool.a.path }] });
  await pending;
  ok('a late folder response cannot replace a newer tag selection', ctx.entries === beforeLate);
  ctx.selectLibrarySection('favorite');
  ok('explicit section navigation clears the previous section tag', ctx.LIB.filter === 'favorite' && ctx.LIB.tags.join(',') === '' && ctx.LIB.folderPath === null);
  ctx.setLibraryTag('sameko_saba');
  clearTag();
  ok('select and clear keep Favorites selected', ctx.LIB.filter === 'favorite' && ctx.LIB.tags.join(',') === '');
  ctx.selectLibrarySection('all');
  let resolveAll;
  ctx.window.api.expandFolders = () => new Promise((resolve) => { resolveAll = resolve; });
  const pendingAll = ctx.renderAllView(ctx.allViewToken);
  ctx.setLibraryTag('nature');
  resolveAll({ images: [] });
  await pendingAll;
  ok('a late All response cannot replace a newer tag selection', ctx.entries === beforeLate);
  clearTag();
  for (const section of ['online', 'removed']) {
    ctx.LIB.filter = section;
    const before = ctx.renders;
    ctx.setLibraryTag('sameko_saba');
    ok(`${section} ignores local tag commands`, ctx.LIB.tags.join(',') === '' && ctx.renders === before);
  }
  ok('tag selection never writes or changes library metadata', JSON.stringify(pool) === originalPool && ctx.selectionClears > 0);
  console.log(`\nAll ${passed} library tag-search tests passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
