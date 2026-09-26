'use strict';

// DESIGN-007. A second press on the tab or Library section that is already open takes the
// list back to the top and changes nothing else. The REAL renderer functions run here
// against a stand-in scroll container; opening another tab or section must still go
// through showPage/selectLibrarySection exactly as before.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8').split('\r\n').join('\n');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

function functionSource(name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function topLevel(prefix) {
  const line = source.split('\n').find((text) => text.startsWith(prefix));
  assert.ok(line, `missing ${prefix}`);
  return line.replace(/^(const|let) /, 'var ');
}

// A scroll container with the two ways to get to the top recorded apart.
const page = {
  scrollTop: 0, clientHeight: 800, smooth: 0,
  scrollTo(opts) { if (opts && opts.behavior === 'smooth') this.smooth++; this.scrollTop = opts.top; },
};
const calls = { showPage: [], selectLibrarySection: [], setLibraryTag: [] };
let reduceMotion = false;

const ctx = {
  document: { querySelector: (selector) => (selector === '.page' ? page : null) },
  window: { matchMedia: () => ({ matches: reduceMotion }) },
  showPage: (name) => calls.showPage.push(name),
  selectLibrarySection: (filter) => calls.selectLibrarySection.push(filter),
  setLibraryTag: (tag) => calls.setLibraryTag.push(tag),
  LIB: { filter: 'all', folderPath: null, q: '', sort: 'name', tag: '' },
  ONLINE: { view: 'search', entries: [] },
};
vm.createContext(ctx);
vm.runInContext(topLevel('const pageScroll = '), ctx);
vm.runInContext(topLevel('let pendingLibraryScroll = '), ctx);
vm.runInContext(topLevel("let activePage = 'home';"), ctx);
vm.runInContext(topLevel('const SCROLL_TOP_SMOOTH_SCREENS = '), ctx);
for (const name of ['cancelPendingLibraryScroll', 'scrollOpenViewToTop', 'openPageOrTop',
  'libOpenSection', 'openLibrarySectionOrTop', 'openLibraryTagOrTop']) {
  vm.runInContext(functionSource(name), ctx);
}

const reset = ({ activePage = 'library', top = 1200, filter = 'all', view = 'search' } = {}) => {
  ctx.activePage = activePage;
  page.scrollTop = top;
  ctx.pageScroll[activePage] = top;
  page.smooth = 0;
  calls.showPage.length = 0;
  calls.selectLibrarySection.length = 0;
  calls.setLibraryTag.length = 0;
  ctx.LIB.filter = filter;
  ctx.ONLINE.view = view;
  reduceMotion = false;
};

// --- top tabs -------------------------------------------------------------------
reset({ activePage: 'home', top: 900 });
ctx.openPageOrTop('home');
ok('the open tab pressed again goes to the top, smoothly for a short way, and is not reopened',
  page.scrollTop === 0 && page.smooth === 1 && calls.showPage.length === 0 && ctx.pageScroll.home === 0);

reset({ activePage: 'library', top: 800 * 10 });
ctx.openPageOrTop('library');
ok('a long way up is a jump, not an animation through the whole grid',
  page.scrollTop === 0 && page.smooth === 0 && calls.showPage.length === 0);

reset({ activePage: 'design', top: 900 });
reduceMotion = true;
ctx.openPageOrTop('design');
ok('with reduced motion asked for, even a short way is a jump', page.scrollTop === 0 && page.smooth === 0);

reset({ activePage: 'home', top: 900 });
ctx.openPageOrTop('library');
ok('another tab opens as before, and the page is left for showPage to restore',
  calls.showPage.join() === 'library' && page.scrollTop === 900);

reset({ activePage: 'library', top: 3000 });
ctx.pendingLibraryScroll = { top: 5000, until: Date.now() + 60000 };
ctx.openPageOrTop('library');
ok('a restore still in flight is dropped, or it would pull the list back down',
  ctx.pendingLibraryScroll === null && page.scrollTop === 0);

// --- Library sections -----------------------------------------------------------
reset({ filter: 'all', top: 2000 });
Object.assign(ctx.LIB, { folderPath: 'C:/photos/trip', q: 'sea', sort: 'added', tag: 'beach' });
ctx.openLibrarySectionOrTop('all');
ok('the open section pressed again goes to the top and keeps the folder, search, sort and tag',
  page.scrollTop === 0 && calls.selectLibrarySection.length === 0
  && ctx.LIB.folderPath === 'C:/photos/trip' && ctx.LIB.q === 'sea' && ctx.LIB.sort === 'added' && ctx.LIB.tag === 'beach');
Object.assign(ctx.LIB, { folderPath: null, q: '', sort: 'name', tag: '' });

reset({ filter: 'online', top: 2000 });
ctx.ONLINE.entries = [{ key: 'a' }, { key: 'b' }];
ctx.openLibrarySectionOrTop('online');
ok('Online pressed again goes to the top without reloading the feed',
  page.scrollTop === 0 && calls.selectLibrarySection.length === 0 && ctx.ONLINE.entries.length === 2);

reset({ filter: 'online', view: 'favorites', top: 2000 });
ctx.openLibrarySectionOrTop('favorite');
ok('Favorites lit for the cloud favourites goes to the top and stays there, not on this device',
  page.scrollTop === 0 && calls.selectLibrarySection.length === 0 && ctx.ONLINE.view === 'favorites');

reset({ filter: 'online', view: 'favorites', top: 2000 });
ctx.openLibrarySectionOrTop('online');
ok('Online from the cloud favourites is another section and opens as before',
  calls.selectLibrarySection.join() === 'online' && page.scrollTop === 2000);

reset({ filter: 'all', top: 2000 });
ctx.openLibrarySectionOrTop('folder');
ok('another section opens as before', calls.selectLibrarySection.join() === 'folder' && page.scrollTop === 2000);

reset({ filter: 'all', top: 2000 });
ctx.LIB.tag = 'beach';
ctx.openLibraryTagOrTop('beach');
ok('the lit tag pressed again goes to the top and stays chosen',
  page.scrollTop === 0 && calls.setLibraryTag.length === 0 && ctx.LIB.tag === 'beach');

reset({ filter: 'all', top: 2000 });
ctx.openLibraryTagOrTop('forest');
ok('another tag is chosen as before', calls.setLibraryTag.join() === 'forest' && page.scrollTop === 2000);
ctx.LIB.tag = '';

// --- wiring ---------------------------------------------------------------------
ok('the top tabs and the rail both go through the new decision',
  source.includes("b.addEventListener('click', () => { openPageOrTop(b.dataset.page); b.blur(); });")
  && source.includes('openLibrarySectionOrTop(btn.dataset.filter);')
  && source.includes('openLibraryTagOrTop(btn.dataset.tag);')
  && !source.includes('showPage(b.dataset.page); b.blur();'));
ok('the rail lights the open section by the same rule a second press uses',
  (source.match(/b\.dataset\.filter === libOpenSection\(\)/g) || []).length === 2);

console.log(`Re-click to top PASS: ${passed} checks`);
