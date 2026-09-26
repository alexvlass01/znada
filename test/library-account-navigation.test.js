'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
function code(name) {
  const match = source.match(new RegExp('(async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(match, name);
  return match[0];
}
function node() {
  return {
    children: [], attrs: {}, dataset: {}, hidden: false, textContent: '', listeners: {}, markup: '',
    classList: {
      names: new Set(),
      toggle(name, force) { if (force ?? !this.names.has(name)) this.names.add(name); else this.names.delete(name); },
      contains(name) { return this.names.has(name); },
    },
    set innerHTML(value) { this.children = []; this.markup = value; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, fn) { this.listeners[key] = fn; },
  };
}
function context() {
  const nodes = {};
  const ctx = {
    $: (sel) => nodes[sel] ||= node(), nodes,
    document: { createElement: node },
    CLOUDAUTH: { state: { signedIn: false }, fetched: true },
    CLOUDFAV: { ids: new Set(), fetched: false },
    CLOUD: { fetched: true, cap: { available: true, environment: 'staging' } },
    LIB: { filter: 'online' },
    ONLINE: { generation: 0, renderEpoch: 0, loading: false, loaded: true, view: 'favorites', entries: [] },
    t: (key) => key, cloudAvailable: () => true,
    cloudSignedIn: () => !!ctx.CLOUDAUTH.state?.signedIn,
    renderLibraryAccountTrigger() {}, applyFavToggleUI() {},
    doCloudSignin() {}, doCloudSignout() {},
    window: { api: { cloudFavorites: async () => ({ items: [{ id: 'one' }] }) } },
    replaceOnlineEntries: (entries) => { ctx.ONLINE.entries = entries; },
    setLibViewHeader: (count) => { ctx.count = count; },
    onlineGridDescriptor: (kind, item) => ({ kind, item }),
    CardTransfer: { errorMessage: (_t, error) => error },
    closeLibPopup() {}, clearSelection() {}, syncSelectionUI() {}, exitFolderState() {},
    renderLibrary: () => { ctx.renders = (ctx.renders || 0) + 1; },
  };
  vm.createContext(ctx);
  return ctx;
}
function bind(ctx, ...names) { for (const name of names) vm.runInContext(code(name), ctx); }

(async () => {
  const railRule = css.match(/\.lib-rail\s*\{([^}]+)\}/)[1];
  const navRule = css.match(/\.lib-navigation\s*\{([^}]+)\}/)[1];
  assert.ok(!/background:|box-shadow:|border:/.test(railRule), 'full-height rail is a transparent positioning container');
  assert.ok(/background: var\(--sidebar-bg\)/.test(navRule), 'only the compact navigation owns its card surface');
  // The real native-popover bindings must attach only while open and reuse the
  // existing tested menu-placement utility. No OAuth or live app is involved here.
  const pop = node(), trigger = node();
  let opened = false, hideCalls = 0;
  pop.style = {}; pop.offsetWidth = 280; pop.scrollHeight = 150;
  pop.matches = () => opened; pop.contains = (target) => target === pop;
  pop.hidePopover = () => { opened = false; hideCalls++; };
  trigger.isConnected = true; trigger.offsetParent = {};
  trigger.getBoundingClientRect = () => ({ left: 780, top: 560, bottom: 610, width: 174 });
  const windowEvents = new Map(), documentEvents = new Map(), observed = new Set();
  let observerCallback;
  const positionCtx = {
    $: (sel) => sel === '#libAccountPopover' ? pop : trigger,
    window: {
      innerHeight: 660, SelectPopup: require('../renderer/select-popup'),
      addEventListener: (name, fn) => windowEvents.set(name, fn),
      removeEventListener: (name) => windowEvents.delete(name),
    },
    document: {
      documentElement: { clientWidth: 940 },
      addEventListener: (name, fn) => documentEvents.set(name, fn),
      removeEventListener: (name) => documentEvents.delete(name),
    },
    ResizeObserver: class {
      constructor(fn) { observerCallback = fn; }
      observe(target) { observed.add(target); }
      disconnect() { observed.clear(); }
    },
  };
  vm.createContext(positionCtx);
  bind(positionCtx, 'placeAnchoredPopover', 'bindAnchoredPopover', 'initLibraryAccountPopover');
  positionCtx.initLibraryAccountPopover();
  assert.strictEqual(windowEvents.size + documentEvents.size + observed.size, 0);
  for (let cycle = 0; cycle < 3; cycle++) {
    pop.listeners.beforetoggle({ newState: 'open' });
    assert.strictEqual(pop.style.visibility, 'hidden', 'opening never flashes at a fixed unrelated point');
    opened = true; pop.listeners.toggle();
    assert.strictEqual(pop.style.left, '652px', 'right edge is clamped');
    assert.strictEqual(pop.style.top, '400px', 'near the bottom the menu opens above its anchor');
    assert.strictEqual(pop.style.visibility, '');
    assert.strictEqual(windowEvents.size + documentEvents.size + observed.size, 4);
    pop.listeners.beforetoggle({ newState: 'closed' });
    opened = false; pop.listeners.toggle();
    assert.strictEqual(windowEvents.size + documentEvents.size + observed.size, 0, 'closed menu leaves no active observers or window/scroll handlers');
  }
  opened = true; trigger.offsetParent = null; observerCallback();
  assert.strictEqual(hideCalls, 1, 'leaving Library closes the detached top-layer surface');
  trigger.offsetParent = {}; opened = true;
  trigger.getBoundingClientRect = () => ({ left: 14, top: 50, bottom: 86, width: 40 });
  positionCtx.placeAnchoredPopover(pop, trigger);
  assert.strictEqual(pop.style.top, '94px', 'a compact top rail opens the menu below the button');
  const ctx = context();
  bind(ctx, 'accountInitials', 'paintAccountAvatar', 'renderCloudAccount');
  // GNOME-style initials: first and last word, letters/digits only, any script.
  assert.strictEqual(ctx.accountInitials('Alexander Vlasenko'), 'AV');
  assert.strictEqual(ctx.accountInitials('олександр петрович власенко'), 'ОВ');
  assert.strictEqual(ctx.accountInitials('Madonna'), 'M');
  assert.strictEqual(ctx.accountInitials('test@example.invalid'), 'T');
  assert.strictEqual(ctx.accountInitials('  (—) '), '', 'punctuation alone falls back to the guest icon');
  assert.strictEqual(ctx.accountInitials(undefined), '');
  ctx.renderCloudAccount();
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children.at(-1).textContent, 'online.signIn');
  ctx.CLOUDAUTH.state = { signedIn: true, user: { id: 'a', display_name: '<img onerror=bad>', email: 'test@example.invalid' } };
  ctx.renderCloudAccount();
  const info = ctx.nodes['#libCloudAccount'].children[0];
  const [avatar, text] = info.children;
  assert.strictEqual(avatar.className, 'lib-avatar');
  assert.strictEqual(avatar.textContent, 'IO', 'initials come from the name as text');
  assert.strictEqual(avatar.markup, '', 'a named account never falls back to the icon markup');
  assert.strictEqual(text.children[0].textContent, '<img onerror=bad>', 'user data is text, never markup');
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children.at(-1).textContent, 'online.signOut');
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children.at(-1).className, 'menu-item');
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children[1].className, 'menu-sep');
  assert.strictEqual(text.children[0].className, 'row-title');
  assert.strictEqual(text.children[1].className, 'row-sub');
  assert.strictEqual(text.children[1].title, 'test@example.invalid', 'a clipped address stays readable');
  ctx.CLOUDAUTH.state = { signedIn: true, user: { id: 'a', email: 'only@example.invalid' } };
  ctx.renderCloudAccount();
  const [, onlyText] = ctx.nodes['#libCloudAccount'].children[0].children;
  assert.strictEqual(onlyText.children.length, 1, 'without a display name the address is not printed twice');
  assert.strictEqual(onlyText.children[0].textContent, 'only@example.invalid');
  ctx.CLOUDAUTH.state = { signingIn: true, signinCancellable: true };
  ctx.renderCloudAccount();
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children.at(-1).textContent, 'online.signinCancel');
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children.at(-1).className, 'menu-item');
  ctx.CLOUDAUTH.state = { signingIn: true, signinCancellable: false };
  ctx.renderCloudAccount();
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children.length, 1, 'uncancellable exchange still has no fake Cancel');
  ctx.CLOUDAUTH.state = { signedIn: true, user: { id: 'a' } };

  bind(ctx, 'loadFavoritesFeed');
  let reply;
  ctx.window.api.cloudFavorites = () => new Promise((resolve) => { reply = resolve; });
  const pending = ctx.loadFavoritesFeed();
  ctx.LIB.filter = 'all';
  reply({ items: [{ id: 'stale' }] });
  await pending;
  assert.strictEqual(ctx.ONLINE.entries.length, 0, 'late favorite response cannot paint a local section');

  bind(ctx, 'applyFavToggleUI', 'selectLibrarySection', 'handleCloudSessionChange');
  ctx.LIB.q = 'local query';
  ctx.ONLINE.view = 'search';
  ctx.selectLibrarySection('favorite', 'cloud');
  ctx.applyFavToggleUI();
  assert.strictEqual(ctx.LIB.filter, 'online', 'reuse the existing Cloud grid, not local records');
  assert.strictEqual(ctx.ONLINE.view, 'favorites');
  assert.strictEqual(ctx.nodes['#libFavoriteViews'].hidden, false);
  assert.strictEqual(ctx.nodes['#libFavoriteCloud'].attrs['aria-pressed'], 'true');
  assert.strictEqual(ctx.LIB.q, 'local query');
  const generation = ctx.ONLINE.generation;
  ctx.selectLibrarySection('online');
  ctx.applyFavToggleUI();
  assert.strictEqual(ctx.ONLINE.view, 'search', 'Online must never secretly display favorites');
  assert.strictEqual(ctx.ONLINE.loaded, false);
  assert.ok(ctx.ONLINE.generation > generation);
  assert.strictEqual(ctx.nodes['#libFavoriteViews'].hidden, true);
  ctx.selectLibrarySection('favorite');
  ctx.applyFavToggleUI();
  assert.strictEqual(ctx.LIB.filter, 'favorite');
  assert.strictEqual(ctx.nodes['#libFavoriteLocal'].attrs['aria-pressed'], 'true');

  // A guest stays in Favorites with an honest sign-in state, not a random search feed.
  ctx.selectLibrarySection('favorite', 'cloud');
  ctx.CLOUDAUTH.state = { signedIn: false };
  let requests = 0;
  ctx.window.api.cloudFavorites = async () => { requests++; return { items: [] }; };
  ctx.applyFavToggleUI();
  await ctx.loadFavoritesFeed();
  assert.strictEqual(requests, 0);
  assert.strictEqual(ctx.ONLINE.view, 'favorites');
  assert.strictEqual(ctx.ONLINE.loading, false);
  assert.strictEqual(ctx.nodes['#whNote'].textContent, 'online.favSignin');
  assert.strictEqual(ctx.nodes['#libFavoriteSignin'].hidden, false);

  ctx.cloudAvailable = () => false;
  ctx.applyFavToggleUI();
  ctx.renderCloudAccount();
  await ctx.loadFavoritesFeed();
  assert.strictEqual(ctx.nodes['#libFavoriteSignin'].hidden, true);
  assert.strictEqual(ctx.nodes['#libCloudAccount'].children[0].textContent, 'online.accountUnavailable');
  assert.strictEqual(ctx.nodes['#whNote'].textContent, 'online.accountUnavailable');
  assert.strictEqual(requests, 0);

  // Expiry invalidates a still-pending response before it can resurrect account data.
  ctx.cloudAvailable = () => true;
  ctx.CLOUDAUTH.state = { signedIn: true, user: { id: 'a' } };
  ctx.CLOUDFAV.ids.add('private');
  ctx.window.api.cloudFavorites = () => new Promise((resolve) => { reply = resolve; });
  const beforeExpiry = ctx.loadFavoritesFeed();
  ctx.handleCloudSessionChange({ signedIn: false, expired: true, user: null });
  assert.strictEqual(ctx.CLOUDFAV.ids.size, 0);
  assert.strictEqual(ctx.count, 0);
  reply({ items: [{ id: 'must-not-reappear' }] });
  await beforeExpiry;
  assert.strictEqual(ctx.ONLINE.entries.length, 0);
  assert.strictEqual(ctx.nodes['#whNote'].textContent, 'online.favSignin');

  // Account availability is independent of the external-search source settings.
  let sessions = 0;
  ctx.LIB.filter = 'all';
  ctx.ensureCloudCapability = async () => {};
  ctx.ensureCloudSession = async () => { sessions++; };
  bind(ctx, 'refreshLibraryAccount', 'renderLibraryAccountTrigger');
  await ctx.refreshLibraryAccount();
  assert.strictEqual(sessions, 1, 'the account must initialize even from a local section');
  assert.strictEqual(ctx.nodes['#libAccountName'].textContent, 'online.account');
  // The sidebar row: guest icon, no second line unless something is running,
  // and a mark only for the expired session the user has to act on.
  assert.ok(ctx.nodes['#libAccountToggle'].classList.contains('needs-attention'), 'the expiry above is still unresolved');
  ctx.CLOUDAUTH.state = { signedIn: false };
  ctx.renderLibraryAccountTrigger();
  assert.ok(ctx.nodes['#libAccountAvatar'].classList.contains('is-guest'));
  assert.ok(ctx.nodes['#libAccountAvatar'].markup.startsWith('<svg'));
  assert.strictEqual(ctx.nodes['#libAccountStatus'].hidden, true);
  assert.ok(!ctx.nodes['#libAccountToggle'].classList.contains('needs-attention'));
  ctx.CLOUDAUTH.state = { signedIn: false, expired: true };
  ctx.renderLibraryAccountTrigger();
  assert.ok(ctx.nodes['#libAccountToggle'].classList.contains('needs-attention'));
  ctx.CLOUDAUTH.state = { signedIn: false, signingIn: true };
  ctx.renderLibraryAccountTrigger();
  assert.strictEqual(ctx.nodes['#libAccountStatus'].hidden, false);
  assert.strictEqual(ctx.nodes['#libAccountStatus'].textContent, 'online.signingIn');
  assert.ok(!ctx.nodes['#libAccountToggle'].classList.contains('needs-attention'));
  ctx.CLOUDAUTH.state = { signedIn: true, user: { id: 'a', display_name: 'Signed User' } };
  ctx.renderLibraryAccountTrigger();
  assert.strictEqual(ctx.nodes['#libAccountStatus'].hidden, true, 'being signed in is shown by the avatar, not a line');
  assert.strictEqual(ctx.nodes['#libAccountAvatar'].textContent, 'SU');
  assert.ok(!ctx.nodes['#libAccountAvatar'].classList.contains('is-guest'));
  bind(ctx, 'ensureCloudFavorites');
  ctx.CLOUDAUTH.state = { signedIn: true, user: { id: 'old-account' } };
  const staleCache = ctx.ensureCloudFavorites();
  ctx.handleCloudSessionChange({ signedIn: true, user: { id: 'new-account', display_name: 'New user' } });
  reply({ items: [{ id: 'old-heart' }] });
  await staleCache;
  assert.strictEqual(ctx.CLOUDFAV.ids.size, 0, 'a pending heart-state request must not cross accounts');
  assert.strictEqual(ctx.CLOUDFAV.fetched, false);
  assert.strictEqual(ctx.nodes['#libAccountName'].textContent, 'New user');
  assert.strictEqual(ctx.nodes['#libAccountAvatar'].textContent, 'NU', 'the avatar follows the new account');
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.strictEqual((html.match(/id="libCloudAccount"/g) || []).length, 1);
  assert.ok(!html.includes('id="onlineFavToggle"'), 'do not keep competing favorites navigation in Online');
  assert.ok(/id="libAccountPopover" popover="auto"/.test(html), 'native popover owns Escape/outside click/focus');
  console.log('Library account/navigation PASS: guest, signed-in text, sources-independent access, collections, late response and expiry');
})().catch((error) => { console.error(error); process.exitCode = 1; });
