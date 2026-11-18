'use strict';

// BUG-066: exercise the actual disclosure controller and actual renderer listeners.
// Only the DOM and unrelated rendering/I/O are replaced. No copy of the policy here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const espree = require('espree');
const { create } = require('../renderer/content-blur');
const policy = require('../src/content-rating');
const { pathKey } = require('../src/path-key');
const { document } = require('./helpers/content-blur-dom');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', range: true });
const init = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'initLibrary');
const ratingBinding = init.body.body.find(n => n.type === 'ExpressionStatement'
  && source.slice(...n.range).startsWith("document.querySelectorAll('.wh-purity-cb').forEach"));
assert.ok(ratingBinding, 'the real initLibrary must install the rating listener');
const functionText = name => {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, name);
  return source.slice(...node.range);
};
let passed = 0;
async function check(name, run) { await run(); passed++; console.log('  PASS ' + name); }
function harness() {
  const doc = document();
  const cfg = { contentBlur: { sketchy: true, nsfw: true }, library: {
    a: { type: 'image', path: 'C:/a.png', source: 'https://example.test/local', rating: 'explicit' },
    b: { type: 'image', path: 'C:/b.png', source: 'https://example.test/local', rating: 'explicit' },
  } };
  const blur = create({ document: doc, policy, pathKey, getConfig: () => cfg });
  const card = item => { const host = doc.createElement('div'); blur.bind(host, { item }); return host; };
  const local = p => { const host = doc.createElement('div'); blur.bind(host, { path: p }); return host; };
  return { doc, cfg, blur, card, local };
}
const post = (provider, id, more = {}) => ({ provider, id, source: 'https://example.test/author',
  page: `https://example.test/${provider}/${id}`, purity: 'sketchy', ...more });
const hidden = host => host.dataset.contentBlurred === 'true';

(async () => {
  for (const provider of ['wallhaven', 'gelbooru', 'danbooru', 'znada']) {
    await check(provider + ': one post reveals; siblings and late arrivals stay covered', async () => {
      const h = harness();
      const a = h.card(post(provider, 'a')), b = h.card(post(provider, 'b'));
      assert.ok(hidden(a) && hidden(b));
      await a.click();
      assert.ok(!hidden(a));
      assert.ok(hidden(b), 'another post with the same source must stay concealed');
      assert.ok(hidden(h.card(post(provider, 'late'))), 'late page must not inherit another post disclosure');
      assert.ok(!hidden(h.card(post(provider, 'a', { source: 'https://example.test/new-author-url' }))),
        'recreated same post keeps disclosure even if attribution changes');
      assert.ok(hidden(h.card(post('other-site', 'a'))), 'same id at another site stays concealed');
      assert.ok(hidden(h.card(post(provider, 'a', { purity: 'nsfw' }))), 'a changed rating stays concealed');
    });
  }
  // Every way a Cloud card can name its site must keep sharing with the downloaded copy,
  // whose only link to the card is the canonical source znada:<id>.
  for (const provider of ['znada', 'cloud', undefined]) {
    await check(`Cloud card (provider ${provider}) shares disclosure with its downloaded copy only`, async () => {
      const h = harness();
      h.cfg.library.c = { type: 'image', path: 'C:/cloud.png', source: 'znada:cloud-a', rating: 'explicit' };
      const card = h.card({ provider, id: 'cloud-a', purity: 'nsfw' }), copy = h.local('C:/cloud.png');
      const other = h.card({ provider, id: 'cloud-b', purity: 'nsfw' });
      assert.ok(hidden(card) && hidden(copy) && hidden(other));
      await card.click();
      assert.ok(!hidden(copy), 'the downloaded copy of this Cloud post opens with it');
      assert.ok(hidden(other), 'another Cloud post stays concealed');
    });
  }
  await check('missing post ids use the page, never the author; local source identity stays intact', async () => {
    const h = harness();
    const a = h.card(post('wallhaven', '', { page: 'https://example.test/post/a' }));
    const b = h.card(post('wallhaven', '', { page: 'https://example.test/post/b' }));
    await a.click(); assert.ok(hidden(b));
    const first = h.local('c:/A.png'), sameSource = h.local('C:/b.png');
    await first.click(); assert.ok(!hidden(sameSource), 'existing local source identity is unchanged');
  });
  await check('actual rating listener resets existing and recreated cards before search, preserving access gates', async () => {
    const h = harness();
    const a = h.card(post('wallhaven', 'a'));
    const boxes = ['sfw', 'sketchy', 'nsfw'].map(p => ({ dataset: { purity: p }, checked: p === 'sketchy',
      addEventListener(name, fn) { assert.strictEqual(name, 'change'); this.change = fn; } }));
    const events = [];
    const ctx = { document: { querySelectorAll(selector) { assert.strictEqual(selector, '.wh-purity-cb'); return boxes; } },
      INTERNET: { purity: { sfw: false, sketchy: true, nsfw: false }, nsfwAvailable: false }, ONLINE: { loaded: true },
      contentBlur: { reset() { h.blur.reset(); events.push('reset'); } },
      renderOnlineQuickFilters() { events.push('render'); }, persistOnlineParams() { events.push('persist'); },
      doOnlineSearch(reset) { assert.strictEqual(reset, true); assert.ok(hidden(a), 'covered before request'); events.push('search'); },
      toast() { events.push('toast'); }, t: key => key };
    vm.runInNewContext(source.slice(...ratingBinding.range), ctx);
    await a.click(); boxes[0].checked = true; boxes[0].change();
    assert.ok(hidden(a)); assert.ok(hidden(h.card(post('wallhaven', 'a'))));
    assert.deepStrictEqual(events, ['reset', 'render', 'persist', 'search']);
    events.length = 0; await a.click();
    boxes[2].checked = true; boxes[2].change();
    assert.strictEqual(boxes[2].checked, false); assert.strictEqual(ctx.INTERNET.purity.nsfw, false);
    assert.ok(!hidden(a)); assert.deepStrictEqual(events, ['toast'], 'unavailable explicit tier must stay rejected');
    events.length = 0;
    ctx.INTERNET.purity.sfw = false; boxes[1].checked = false; boxes[1].change();
    assert.ok(boxes[1].checked && ctx.INTERNET.purity.sketchy);
    assert.ok(!hidden(a)); assert.deepStrictEqual(events, [], 'rejected last category change keeps disclosure');
    ctx.ONLINE.loaded = false; boxes[0].checked = true; boxes[0].change();
    assert.ok(hidden(a)); assert.deepStrictEqual(events, ['reset', 'render', 'persist'], 'reset also applies before first search');
  });
  await check('actual page and library section handlers reset only when leaving the current section', async () => {
    const h = harness(), a = h.card(post('wallhaven', 'a'));
    const noop = () => {};
    const ctx = { contentBlur: h.blur, activePage: 'library', LIB: { filter: 'online', folderPath: '' },
      ONLINE: { view: 'search' }, document: { querySelector: () => null, querySelectorAll: () => [] }, $: () => null,
      pageScroll: {}, deferredLiveRefresh: new Set(), diagSpan: () => noop, renderHome: noop,
      renderLibrary: noop, scheduleAllLibraryLayouts: noop, syncHomeCountdownTimer: noop,
      closeLibPopup: noop, clearSelection: noop, syncSelectionUI: noop, exitFolderState: noop };
    vm.createContext(ctx);
    vm.runInContext(functionText('showPage') + '\n' + functionText('selectLibrarySection'), ctx);
    await a.click(); ctx.showPage('library'); assert.ok(!hidden(a));
    ctx.showPage('home'); assert.ok(hidden(a));
    await a.click(); ctx.selectLibrarySection('online'); assert.ok(!hidden(a));
    ctx.selectLibrarySection('favorite'); assert.ok(hidden(a));
    await a.click(); ctx.LIB.folderPath = 'C:/folder'; ctx.selectLibrarySection('favorite'); assert.ok(hidden(a));
  });
  console.log(`PASS content-blur-online: ${passed} scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
