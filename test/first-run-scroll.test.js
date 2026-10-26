'use strict';

// BUG-053, the owner's report of 2026-10-21: the welcome screen can be taller than the
// window, so it is scrolled down to reach the start button, and Home then opened scrolled
// down too. The welcome screen and every tab share one .page scroll container. The REAL
// showPage/enterFirstRun/exitFirstRun run here against stand-in views and container.

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

const classList = () => ({ toggle() {}, add() {}, remove() {} });
const page = { scrollTop: 0, classList: classList() };
const views = ['viewWelcome', 'viewHome', 'viewLibrary', 'viewDesign', 'viewPrefs']
  .map((id) => ({ id, hidden: id !== 'viewHome' }));
const byId = Object.fromEntries(views.map((v) => [v.id, v]));
const visible = () => views.filter((v) => !v.hidden).map((v) => v.id).join();
const stub = { value: '', addEventListener() {}, classList: classList() };

const ctx = {
  document: {
    body: { classList: classList() },
    querySelector: (selector) => (selector === '.page' ? page : null),
    querySelectorAll: (selector) => (selector === '.view' ? views : []),
  },
  $: (selector) => byId[selector.replace(/^#/, '')] || stub,
  config: { language: 'system', autostart: false },
  setSwitch() {},
  updateShortcutButtons() {},
  contentBlur: { reset() {} },
  diagSpan: () => () => {},
  renderHome() {}, renderPreviews() {}, layoutMonitors() {},
  renderLibrary() {}, scheduleAllLibraryLayouts() {},
  deferredLiveRefresh: new Set(), LIB: { filter: 'all' }, libRenderKey: () => '', lastLibRenderKey: '',
  renderEventLog() {}, renderMediaFolderRow() {}, syncHomeCountdownTimer() {},
};
vm.createContext(ctx);
vm.runInContext(topLevel('const pageScroll = '), ctx);
vm.runInContext(topLevel("let activePage = 'home';"), ctx);
for (const name of ['showPage', 'enterFirstRun', 'exitFirstRun']) {
  vm.runInContext(functionSource(name), ctx);
}

// --- first launch: the welcome screen comes up over Home ------------------------
ctx.enterFirstRun();
ok('the welcome screen is shown alone', visible() === 'viewWelcome');
page.scrollTop = 1400; // scrolled down to reach the start button
ctx.exitFirstRun();
ok('Home after the welcome screen opens at the very top',
  visible() === 'viewHome' && page.scrollTop === 0 && ctx.activePage === 'home');
ok('and the welcome screen\'s scroll is not remembered as Home\'s', ctx.pageScroll.home === 0);

// --- "Show welcome" from Settings, which the user had scrolled ------------------
page.scrollTop = 450; // Home has a remembered position of its own now
ctx.showPage('prefs');
page.scrollTop = 500;
ctx.showPage('library');
page.scrollTop = 2500;
ctx.showPage('prefs');
ok('Settings comes back where it was before the welcome is reopened', page.scrollTop === 500);
page.scrollTop = 600; // and is scrolled a little further right before the button

ctx.enterFirstRun();
ok('the welcome screen opens at the top, not at Settings\' position', page.scrollTop === 0);
page.scrollTop = 1400;
ctx.exitFirstRun();
ok('Home is at the top after it', page.scrollTop === 0 && visible() === 'viewHome');

ctx.showPage('prefs');
ok('Settings keeps its own position instead of the welcome screen\'s', page.scrollTop === 600);
ctx.showPage('library');
ok('and another tab\'s position is untouched', page.scrollTop === 2500);

// --- ordinary tab switching is unchanged ----------------------------------------
page.scrollTop = 300;
ctx.showPage('home');
page.scrollTop = 120;
ctx.showPage('library');
ok('a tab still remembers its scroll between ordinary switches', page.scrollTop === 300);
ctx.showPage('home');
ok('Home remembered outside the welcome flow is restored as before', page.scrollTop === 120);

console.log(`\nfirst-run-scroll: ${passed} passed`);
