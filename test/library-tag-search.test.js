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
const manualContexts = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'context', 'manual.json'), 'utf8'));

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

// Execute the real card-search binding independently of the rest of initLibrary.
// Toolbar changes must preserve instant filtering, including native search clearing.
const searchHandlers = {};
const cardSearch = { value: '', addEventListener: (event, fn) => { searchHandlers[event] = fn; } };
const searchState = { q: '', filter: 'favorite', sort: 'name' };
let cardRenders = 0;
const searchBindingStart = renderer.indexOf("const searchEl = $('#libSearch')");
const searchBindingEnd = renderer.indexOf("const tagSearchEl = $('#libTagSearch')", searchBindingStart);
assert.ok(searchBindingStart >= 0 && searchBindingEnd > searchBindingStart);
vm.runInNewContext(renderer.slice(searchBindingStart, searchBindingEnd), {
  $: (selector) => ({ '#libSearch': cardSearch })[selector],
  LIB: searchState,
  renderLibrary: () => { cardRenders++; },
});
cardSearch.value = 'beatrice_(rezero)';
searchHandlers.input();
ok('card query filters immediately without a submit click', searchState.q === cardSearch.value && cardRenders === 1);
ok('typing preserves current section and sort', searchState.filter === 'favorite' && searchState.sort === 'name');
cardSearch.value = '';
searchHandlers.input();
ok('clearing the card query restores the unfiltered query immediately', searchState.q === '' && cardRenders === 2);
cardSearch.value = 'sameko_saba';
searchHandlers.input();
ok('typing preserves exact tag syntax', searchState.q === 'sameko_saba' && cardRenders === 3);
searchHandlers.input();
ok('unchanged input does not reset the grid', cardRenders === 3);
cardSearch.value = '';
searchHandlers.search();
searchHandlers.input();
ok('native clear/search and input events apply once', searchState.q === '' && cardRenders === 4);
ok('submit and clear preserve section and sort', searchState.filter === 'favorite' && searchState.sort === 'name');
const localQueryRow = html.match(/<div class="lib-local-query-row">([\s\S]*?)<\/div>/)?.[1] || '';
ok('local query row contains only search controls, not import actions',
  localQueryRow.includes('id="libSearch"') && !html.includes('id="libSearchSubmit"')
  && !localQueryRow.includes('libAddPhotos') && !localQueryRow.includes('libAddFolder'));
ok('import actions remain below the complete local search row',
  html.indexOf('id="libAddPhotos"') > html.indexOf(localQueryRow) + localQueryRow.length
  && html.indexOf('id="libAddFolder"') > html.indexOf('id="libAddPhotos"'));
for (const id of ['libTagsToggle', 'libActiveTag', 'onlineQuickScreen', 'onlineQuickPurity', 'onlineQuickSources', 'whFilterToggle']) {
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

const filterTags = vm.runInNewContext(`(${functionSource(renderer, 'filterLibRailTags')})`);
// A tag is an additional predicate, not a destination replacing Favorites.
const localFilterContext = {
  LIB: { filter: 'favorite', tag: 'sameko_saba', q: '' },
  config: { library: {
    a: { id: 'a', path: 'a.png', favorite: true, tags: ['sameko_saba'] },
    b: { id: 'b', path: 'b.png', favorite: true, tags: ['nature'] },
    c: { id: 'c', path: 'c.png', favorite: false, tags: ['sameko_saba'] },
  } },
  baseName: (value) => value, sortItems() {},
};
vm.createContext(localFilterContext);
vm.runInContext(functionSource(renderer, 'libMatchesTag') + functionSource(renderer, 'libSectionItems')
  + functionSource(renderer, 'libList'), localFilterContext);
ok('Favorites intersects with the selected tag instead of showing all favorites',
  localFilterContext.libList().map((item) => item.id).join(',') === 'a');
localFilterContext.LIB.q = 'b.png';
ok('filename search intersects with favorite and tag predicates', localFilterContext.libList().length === 0);
localFilterContext.LIB.tag = '';
ok('clearing only the tag preserves filename search and Favorites', localFilterContext.libList()[0]?.id === 'b');
localFilterContext.LIB.q = '';
ok('unfiltered Favorites still excludes non-favorites', localFilterContext.libList().map((item) => item.id).join(',') === 'a,b');
localFilterContext.config.library.d = { id: 'd', path: 'folder', type: 'folder', tags: ['sameko_saba'] };
localFilterContext.LIB.filter = 'folder';
localFilterContext.LIB.tag = 'sameko_saba';
ok('Folders combines its type predicate with the tag', localFilterContext.libList().map((item) => item.id).join(',') === 'd');
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
const navState = { filter: 'all', tag: '' };
const navStart = renderer.indexOf("const rail = document.querySelector('#viewLibrary');");
const navEnd = renderer.indexOf('// Click on empty space', navStart);
assert.ok(navStart >= 0 && navEnd > navStart);
// DESIGN-007: the rail decides "another section" or "the open one again" through these.
let toTop = 0;
const navContext = {
  document: { querySelector: () => ({ addEventListener: (_event, fn) => { navClick = fn; } }) },
  $: () => null, LIB: navState, ONLINE: { view: 'search' }, closeLibPopup() {}, clearSelection() {}, syncSelectionUI() {},
  selectLibrarySection: (filter) => { navState.filter = filter; navRenders++; exits++; },
  setLibraryTag: (tag) => { navState.tag = tag; },
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
navClick({ target: { closest: () => ({ dataset: { tag: 'sameko_saba' } }) } });
ok('tag button delegates to filtering without section navigation', navState.tag === 'sameko_saba' && navState.filter === 'all');
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
const tags = ['architecture', 'Nature', 'space art'];

ok('empty query preserves the complete sorted input', JSON.stringify(filterTags(tags, '')) === JSON.stringify(tags));
ok('query is trimmed and case-insensitive', JSON.stringify(filterTags(tags, '  NAT  ')) === JSON.stringify(['Nature']));
ok('query matches inside a multi-word tag', JSON.stringify(filterTags(tags, 'art')) === JSON.stringify(['space art']));
ok('zero-result query returns an empty list', filterTags(tags, 'portrait').length === 0);
ok('filtering never mutates the source tag list', JSON.stringify(tags) === JSON.stringify(['architecture', 'Nature', 'space art']));

const sectionAt = html.indexOf('id="libTagSection"');
const searchAt = html.indexOf('id="libTagSearch"');
const listAt = html.indexOf('id="libTags"');
const emptyAt = html.indexOf('id="libTagEmpty"');
ok('tag search is a static control before the dynamic result list', sectionAt >= 0 && sectionAt < searchAt && searchAt < listAt && listAt < emptyAt);
ok('tag search has separate semantics from the card search', html.includes('data-i18n-ph="library.tagSearchPh"') && html.includes('data-i18n="library.noTagsFound"'));
ok('tag search exposes its result list to assistive technology', html.includes('aria-controls="libTags"'));

const renderTags = functionSource(renderer, 'renderLibRailTags');
ok('tag list rendering never replaces the current section', !/LIB\.filter\s*=(?!=)/.test(renderTags));
// ONL-005 task 6: the list is ordered by use before it is searched.
ok('query creates a separate matches list', /const matches = filterLibRailTags\(sortTagsByUse\(tags, [^)]*\)\), LIB\.tagQuery\)/.test(renderTags));

const listenerStart = renderer.indexOf("const tagSearchEl = $('#libTagSearch')");
const listenerEnd = renderer.indexOf("const refreshBtn = $('#libRefresh')", listenerStart);
const listener = renderer.slice(listenerStart, listenerEnd);
ok('typing rerenders only rail tags', listenerStart >= 0 && listener.includes('renderLibRailTags()') && !listener.includes('renderLibrary()'));
ok('typing never substitutes the card filename query', !listener.includes('LIB.q'));
ok('tag query is not part of the card-grid render identity', !functionSource(renderer, 'libRenderKey').includes('tagQuery'));

// The bounded tag panel shrinks its list, not the search field or the navigation.
ok('nested tag list can shrink inside the bounded search panel',
  /\.lib-tags-section\s*\{[^}]*min-height:\s*0/s.test(css)
  && /\.lib-tags-section \.lib-rail-section-body\s*\{[^}]*min-height:\s*0/s.test(css)
  && /\.lib-tags-section \.lib-rail-section-inner\s*\{[^}]*min-height:\s*0/s.test(css)
  && /\.lib-rail-section-inner\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s.test(css));
ok('only the tag result list owns vertical scrolling', /\.lib-railtags\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s.test(css));
ok('tag list has a bounded height under the search toolbar', css.includes('max-height: 190px'));

ok('reference locales distinguish tag search from card search',
  en.library.tagSearchPh === 'Search tags'
  && ru.library.tagSearchPh === 'Поиск тегов');
ok('Ukrainian locale translates tag search separately from card search',
  uk.library.tagSearchPh === 'Пошук тегів');
ok('reference locales include a zero-result explanation',
  en.library.noTagsFound === 'No matching tags'
  && ru.library.noTagsFound === 'Подходящие теги не найдены');
ok('Ukrainian locale translates the zero-result explanation',
  uk.library.noTagsFound === 'Відповідних тегів не знайдено');
ok('generated semantic context records placeholder and empty-state roles',
  contexts.entries['library.tagSearchPh']
  && contexts.entries['library.noTagsFound']
  && contexts.entries['library.tagSearchPh'].contexts.some((x) => x.type === 'placeholder' && x.area === 'library')
  && contexts.entries['library.noTagsFound'].contexts.some((x) => x.area === 'library'));
ok('manual semantic context distinguishes the rail filter from the card grid',
  manualContexts.keys['library.tagSearchPh']?.note.includes('Не ищет карточки')
  && manualContexts.keys['library.noTagsFound']?.note.includes('сетка карточек'));

// Execute the actual local loaders with synthetic IPC replies. This tests the data
// handed TO the gallery; its layout, virtualization and card builders are not changed.
(async () => {
  const nodes = { '#libGrid': {}, '#libEmpty': {} };
  const pool = {
    a: { id: 'a', type: 'image', path: 'C:/photos/nested/a.png', tags: ['sameko_saba'], favorite: true },
    b: { id: 'b', type: 'image', path: 'C:/photos/nested/b.png', tags: ['nature'] },
    c: { id: 'c', type: 'image', path: 'C:/elsewhere/c.png', tags: ['sameko_saba'] },
  };
  const originalPool = JSON.stringify(pool);
  const ctx = {
    LIB: { filter: 'all', tag: '', q: '', sort: 'name', folderPath: null, crumbs: [], shuffleRank: {} },
    ONLINE: { view: 'search', entries: [], generation: 0, renderEpoch: 0 },
    config: { library: pool }, allViewToken: 1,
    $: (sel) => nodes[sel],
    baseName: (value) => value.split('/').pop(),
    normPathKey: require('../src/path-key').pathKey,
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
  for (const name of ['libMatchesTag', 'setLibraryTag', 'sortItems', 'poolImageMap', 'libViewKey', 'libRenderKey', 'selectLibrarySection', 'libEmptyKey']) {
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
  const rendersBeforeRepeat = ctx.renders;
  ctx.setLibraryTag('sameko_saba');
  ok('reselecting the same tag does not rebuild the list', ctx.renders === rendersBeforeRepeat);
  // Use the real clear-chip binding, not just the setter, to guard against redirects.
  let clearTag;
  const clearStart = renderer.indexOf("  $('#libActiveTag')?.addEventListener('click'");
  const clearEnd = renderer.indexOf('  if (refreshBtn)', clearStart);
  assert.ok(clearStart >= 0 && clearEnd > clearStart);
  vm.runInNewContext(renderer.slice(clearStart, clearEnd), {
    $: () => ({ addEventListener: (_type, fn) => { clearTag = fn; } }), setLibraryTag: ctx.setLibraryTag,
  });
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
  ok('explicit section navigation clears the previous section tag', ctx.LIB.filter === 'favorite' && ctx.LIB.tag === '' && ctx.LIB.folderPath === null);
  ctx.setLibraryTag('sameko_saba');
  clearTag();
  ok('select and clear keep Favorites selected', ctx.LIB.filter === 'favorite' && ctx.LIB.tag === '');
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
    ok(`${section} ignores local tag commands`, ctx.LIB.tag === '' && ctx.renders === before);
  }
  ok('tag selection never writes or changes library metadata', JSON.stringify(pool) === originalPool && ctx.selectionClears > 0);
  console.log(`\nAll ${passed} library tag-search tests passed.`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
