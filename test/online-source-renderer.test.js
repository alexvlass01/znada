'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OnlineSources = require('../src/online-sources');
const OnlineIdentity = require('../src/online-identity');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function bind(name, ctx) {
  const match = source.match(new RegExp('(async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(match, name);
  return vm.runInNewContext('(' + match[0] + ')', ctx);
}
function element() {
  return {
    hidden: false, value: '', dataset: {}, children: [], attrs: {},
    classList: { toggle() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); },
    set innerHTML(_value) { this.children = []; },
  };
}

(async () => {
  // R1: provider failures must survive publication/finalization, not become noResults.
  const errorNote = { textContent: '' };
  let reply = { error: 'unavailable', providerErrors: { gelbooru: 'unavailable' }, items: [], resume: null };
  let current = true;
  const errorCtx = {
    INTERNET: { providerNames: { gelbooru: 'Gelbooru' }, resume: null },
    ONLINE: { entries: [] }, OnlineBrowse: { isBrowse: () => false },
    window: { api: { internetSearch: async () => reply } },
    onlineSearchIsCurrent: () => current, updatePurityToggle() {},
    onlineGridDescriptor: (_kind, item) => item, setLibViewHeader() {},
    $: (id) => id === '#whNote' ? errorNote : null,
    t: (key, args) => key + (args ? ':' + Object.values(args).join(',') : ''),
  };
  const load = bind('loadInternetResults', errorCtx);
  const finish = bind('finalizeOnlineFeed', errorCtx);
  await load(1); finish();
  assert.strictEqual(errorNote.textContent, 'online.sourcesFailed:Gelbooru');
  reply = { items: [{ id: 'd:1' }], error: null, providerErrors: {} };
  errorCtx.ONLINE.entries = await load(1); finish();
  assert.strictEqual(errorCtx.ONLINE.entries.length, 1, 'error notice does not discard successful cards');
  assert.strictEqual(errorNote.textContent, 'online.sourcesFailed:Gelbooru', 'paging cannot hide an earlier failed source');
  current = false; errorCtx.INTERNET.searchError = 'newer search';
  reply = { error: 'network', providerErrors: { gelbooru: 'network' } };
  await load(1);
  assert.strictEqual(errorCtx.INTERNET.searchError, 'newer search', 'stale failure does not overwrite current search');
  current = true; errorCtx.INTERNET.searchError = ''; errorCtx.ONLINE.entries = [];
  reply = { items: [], error: null, providerErrors: {} };
  await load(2); finish();
  assert.strictEqual(errorNote.textContent, 'online.noResults', 'genuine empty success remains noResults');

  // Execute real rail rendering. ONL-005 task 6: every tag, most used first, in a section
  // that opens and closes; search runs over all of them.
  const nodes = Object.fromEntries(['libTags', 'libTagSection', 'libTagEmpty', 'libTagSearch', 'libActiveTag', 'onlineSourcesSection'].map((id) => ['#' + id, element()]));
  const headClasses = new Set();
  nodes['#libTagsToggle'] = { classList: { toggle(name, on) { if (on) headClasses.add(name); else headClasses.delete(name); } } };
  let tags = [':/', ':3', 'a', 'd', 'long-selected-tag'];
  const uses = { ':/': 1, ':3': 1, a: 5, d: 2, 'long-selected-tag': 9 };
  const LIB = { filter: 'all', tagQuery: '' };
  const opened = [];
  const railCtx = {
    LIB, $: (id) => nodes[id], t: (key) => key,
    config: { libraryTagsExpanded: false },
    document: { createElement: element, querySelectorAll: () => [] },
    libAllTags: () => tags.slice().sort((x, y) => x.localeCompare(y)),
    libTagCounts: () => uses,
    setLibTagsOpen: (open, options) => opened.push({ open, persist: !!(options && options.persist) }),
    fitRailSectionHeads() {},
  };
  railCtx.filterLibRailTags = bind('filterLibRailTags', railCtx);
  railCtx.sortTagsByUse = bind('sortTagsByUse', railCtx);
  const rail = bind('renderLibRailTags', railCtx);
  const shownTags = () => nodes['#libTags'].children.map((b) => b.dataset.filter.slice(4));
  rail();
  assert.strictEqual(nodes['#onlineSourcesSection'].hidden, true, 'the site list belongs to Online only');
  assert.strictEqual(nodes['#libTagSection'].hidden, false);
  assert.deepStrictEqual(shownTags(), ['long-selected-tag', 'a', 'd', ':/', ':3'],
    'every tag is listed, most used first, ties alphabetical');
  assert.strictEqual(headClasses.has('active'), false, 'the head is not lit while no tag is chosen');
  assert.strictEqual(JSON.stringify(opened[opened.length - 1]), '{"open":false,"persist":false}',
    'a render shows the stored state (collapsed by default) and writes nothing');
  railCtx.config.libraryTagsExpanded = true; rail();
  assert.strictEqual(opened[opened.length - 1].open, true, 'an opened section stays open on the next render');
  LIB.tagQuery = 'long'; rail();
  assert.deepStrictEqual(shownTags(), ['long-selected-tag'], 'search narrows the whole list');
  LIB.tagQuery = ''; rail();
  assert.strictEqual(nodes['#libActiveTag'].hidden, true, 'no chip while nothing is chosen');
  LIB.filter = 'tag:d'; LIB.tagQuery = 'no-match'; rail();
  assert.strictEqual(LIB.filter, 'tag:d');
  assert.strictEqual(nodes['#libActiveTag'].hidden, false, 'the chosen tag is shown above the body');
  assert.strictEqual(nodes['#libActiveTag'].textContent, 'd ×');
  assert.strictEqual(headClasses.has('active'), true, 'a chosen tag lights the head like a chosen rail row');
  assert.strictEqual(nodes['#libTagEmpty'].hidden, false);
  LIB.filter = 'online'; rail();
  assert.strictEqual(nodes['#libTagSection'].hidden, true);
  assert.strictEqual(nodes['#onlineSourcesSection'].hidden, false, 'Online shows its site list');
  assert.strictEqual(LIB.tagQuery, 'no-match', 'online does not destroy the local tag query');
  LIB.filter = 'all'; rail();
  assert.strictEqual(headClasses.has('active'), false, 'back to All, the head goes dark again');
  tags = []; rail();
  assert.strictEqual(nodes['#libTagSection'].hidden, true, 'no tags, no section');
  assert.strictEqual(LIB.tagQuery, '', 'and no leftover search');

  // Across pages, the first visible card wins; same post URL alone is not identity.
  const hash = 'a'.repeat(32);
  const old = { key: 'g:1', item: { provider: 'gelbooru', id: 1, md5: hash, source: 'same-post' } };
  const ONLINE = { entries: [old] };
  const append = bind('appendOnlineEntries', { ONLINE, OnlineIdentity, renderOnlineEntries() {} });
  assert.strictEqual(append([
    { key: 'd:2', item: { provider: 'danbooru', id: 2, md5: hash } },
    { key: 'd:3', item: { provider: 'danbooru', id: 3, md5: 'b'.repeat(32), source: 'same-post' } },
  ]), 1);
  assert.strictEqual(ONLINE.entries[0], old);
  assert.strictEqual(append([ONLINE.entries[1]]), 0);

  // Persist-before-research, rollback on failed write, and one in-flight patch only.
  const providers = [
    { id: 'one', name: 'One', browse: true },
    { id: 'two', name: 'Two', browse: true },
  ];
  const config = { onlineSources: OnlineSources.normalize({ internet: true }, providers) };
  const INTERNET = { providers, q: 'sky', sort: 'toplist', purity: { sfw: true }, resume: { old: true } };
  const feed = { generation: 2, loading: true, loaded: true };
  let writes = 0, searches = 0, notices = 0, hide = 0, release;
  const ctx = {
    config, INTERNET, ONLINE: feed, LIB: { filter: 'online' }, OnlineSources,
    INTERNET_TAG_SUGGEST: { cache: new Map([['old', []]]) },
    onlineSources: () => config.onlineSources,
    applyOnlineSourceUI() {}, hideOnlineTagSuggest() { hide++; },
    renderOnline() { searches++; }, toast() { notices++; }, t: (key) => key,
    window: { api: { setConfig: async () => { writes++; return new Promise((resolve) => { release = resolve; }); } } },
  };
  const toggle = bind('toggleOnlineSource', ctx);
  const first = toggle('one');
  await toggle('two');
  assert.strictEqual(writes, 1);
  assert.strictEqual(searches, 0);
  release({ onlineSources: OnlineSources.patch({ providers: { one: false } }, config.onlineSources, providers) });
  await first;
  assert.strictEqual(searches, 1);
  assert.strictEqual(feed.generation, 3);
  assert.strictEqual(INTERNET.resume, null);
  assert.strictEqual(hide, 1);
  assert.strictEqual(ctx.INTERNET_TAG_SUGGEST.cache.size, 0);
  assert.strictEqual(INTERNET.q, 'sky');
  assert.strictEqual(INTERNET.sort, 'toplist');
  assert.deepStrictEqual(INTERNET.purity, { sfw: true });
  await toggle('two');
  assert.strictEqual(writes, 1, 'last enabled source is not disabled');
  ctx.window.api.setConfig = async () => ({ onlineSources: config.onlineSources });
  await toggle('one');
  assert.strictEqual(notices, 1);
  assert.strictEqual(config.onlineSources.providers.one, false);
  assert.strictEqual(searches, 1);
  assert.strictEqual(INTERNET.sourcePending, false);
  // ONL-005 task 5: the site list as a rail section — collapsed by default, remembered only
  // when the user opens or closes it, and still telling which sites are on while collapsed.
  {
    const classes = new Set();
    const section = { hidden: false, classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } };
    const head = element();
    const hint = element();
    const host = element();
    host.replaceChildren = () => { host.children = []; };
    host.querySelectorAll = () => host.children.map((row) => row.children[0]);
    const make = (tag) => {
      const node = element();
      node.tag = tag;
      node.closest = () => node.parent || null;
      node.append = (...items) => { items.forEach((item) => { item.parent = node; }); node.children.push(...items); };
      return node;
    };
    const writes = [];
    const railConfig = { onlineSources: OnlineSources.normalize({ internet: true }, providers), onlineSourcesExpanded: false };
    const sectionCtx = {
      config: railConfig, OnlineSources,
      INTERNET: { providers, sourcePending: false },
      document: { createElement: make },
      t: (key) => key,
      hideOnlineTagSuggest() {},
      fitRailSectionHeads() { sectionCtx.fitted = (sectionCtx.fitted || 0) + 1; },
      Promise,
      window: { api: { setConfig: async (patch) => { writes.push(patch); return {}; } } },
      $: (id) => ({
        '#onlineSourcesSection': section, '#onlineSourcesToggle': head, '#onlineSourcesHint': hint,
        '#onlineSourceOptions': host,
      })[id] || null,
    };
    sectionCtx.setRailSectionOpen = bind('setRailSectionOpen', sectionCtx);
    sectionCtx.setOnlineSourcesOpen = bind('setOnlineSourcesOpen', sectionCtx);
    const apply = bind('applyOnlineSourceUI', sectionCtx);

    apply(railConfig.onlineSources);
    assert.strictEqual(host.children.length, 2, 'one row per site');
    assert.strictEqual(head.title, 'One, Two', 'collapsed, the head still names the sites that are on');
    assert.strictEqual(classes.has('open'), false, 'collapsed by default');
    assert.strictEqual(head.attrs['aria-expanded'], 'false');
    assert.strictEqual(hint.hidden, true, 'the keep-one rule is quiet while it holds nothing back');
    assert.strictEqual(writes.length, 0, 'showing the section writes nothing');
    assert.ok(sectionCtx.fitted >= 1, 'a render refits the head to its title');

    sectionCtx.setOnlineSourcesOpen(true, { persist: true });
    assert.strictEqual(classes.has('open'), true);
    assert.strictEqual(head.attrs['aria-expanded'], 'true');
    // Compared as JSON: the patch object is built inside the vm context, another realm.
    assert.strictEqual(JSON.stringify(writes), '[{"onlineSourcesExpanded":true}]', 'the user opening it is remembered');
    apply(railConfig.onlineSources);
    assert.strictEqual(classes.has('open'), true, 'a later render keeps it open');
    assert.strictEqual(writes.length, 1, 'a render does not write the state again');

    const oneLeft = OnlineSources.patch({ providers: { two: false } }, railConfig.onlineSources, providers);
    apply(oneLeft);
    assert.strictEqual(head.title, 'One');
    assert.strictEqual(hint.hidden, false, 'with one site left the rule is shown');
    const [first, second] = host.children.map((row) => row.children[0]);
    assert.strictEqual(first.disabled, true, 'the last site cannot be unticked');
    assert.strictEqual(first.parent.title, 'online.sourcesHint', 'and its row says why');
    assert.strictEqual(second.disabled, false);
    assert.strictEqual(second.parent.title, '');

    sectionCtx.setOnlineSourcesOpen(false, { persist: true });
    sectionCtx.setOnlineSourcesOpen(false, { persist: true });
    assert.strictEqual(JSON.stringify(writes[1]), '{"onlineSourcesExpanded":false}');
    assert.strictEqual(writes.length, 2, 'closing an already closed section writes nothing');
    assert.strictEqual(classes.has('open'), false);

    // The tag section goes through the same mechanism with its own setting.
    const tagClasses = new Set();
    const tagSection = { classList: { toggle(name, on) { if (on) tagClasses.add(name); else tagClasses.delete(name); } } };
    const tagHead = element();
    const tagCtx = {
      config: { libraryTagsExpanded: false }, Promise,
      window: { api: { setConfig: async (patch) => { writes.push(patch); return {}; } } },
      $: (id) => ({ '#libTagSection': tagSection, '#libTagsToggle': tagHead })[id] || null,
    };
    tagCtx.setRailSectionOpen = bind('setRailSectionOpen', tagCtx);
    const openTags = bind('setLibTagsOpen', tagCtx);
    openTags(false);
    assert.strictEqual(writes.length, 2, 'showing the tag section writes nothing');
    openTags(true, { persist: true });
    assert.strictEqual(tagClasses.has('open'), true);
    assert.strictEqual(tagHead.attrs['aria-expanded'], 'true');
    assert.strictEqual(tagCtx.config.libraryTagsExpanded, true);
    assert.strictEqual(JSON.stringify(writes[2]), '{"libraryTagsExpanded":true}', 'the tag section remembers its own state');
    assert.strictEqual(railConfig.onlineSourcesExpanded, false, 'and leaves the site list alone');
  }
  // A section title is never cut (owner, 2026-09-17). The head is measured in its normal
  // state every time: a title that fits stays on one line, one that does not makes the head
  // `tight` (it wraps), and a title that got shorter (another language) goes back to one line.
  {
    const head = (label, room) => {
      const classes = new Set(['tight']);
      const title = {
        get clientWidth() { return classes.has('tight') ? room + 26 : room; },
        get scrollWidth() { return Math.max(label, this.clientWidth); },
      };
      return {
        classes, title,
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
        querySelector: (sel) => (sel === '.lib-rail-section-title' ? title : null),
      };
    };
    const fitsNow = head(56, 99);      // Ukrainian in the narrow rail
    const tooLong = head(130, 99);     // a title longer than the narrow rail allows
    const fit = bind('fitRailSectionHeads', { document: null });
    fit({ querySelectorAll: () => [fitsNow, tooLong] });
    assert.strictEqual(fitsNow.classes.has('tight'), false, 'a title that fits stays on one line');
    assert.strictEqual(tooLong.classes.has('tight'), true, 'a title that does not fit wraps instead of being cut');
    const shorter = head(46, 99);      // the same head after switching to a shorter language
    shorter.classes.add('tight');
    fit({ querySelectorAll: () => [shorter] });
    assert.strictEqual(shorter.classes.has('tight'), false, 'a shorter title goes back to one line');
  }
  console.log('PASS: compact rail, MD5 across pages, source save/race/rollback, preserved filters, the collapsible site list and uncut titles');
})().catch((error) => { console.error(error); process.exitCode = 1; });
