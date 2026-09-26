'use strict';

// DESIGN-002. The quick online filter row: which buttons, how many fit, what "Filters"
// counts. Pure module, plus the two places that must read it the same way: config
// normalization and the set-config boundary's rule.
const assert = require('assert');
const Q = require('../src/online-quick-filters');
const config = require('../src/config');

// Pins: canonical order, known keys only, and an empty list is a real choice.
assert.deepStrictEqual(Q.normalizePins(undefined), ['screen', 'purity', 'sources'], 'a missing setting pins everything');
assert.deepStrictEqual(Q.normalizePins('screen'), ['screen', 'purity', 'sources'], 'a non-list is a missing setting');
assert.deepStrictEqual(Q.normalizePins([]), [], 'nothing pinned stays nothing pinned');
assert.deepStrictEqual(Q.normalizePins(['sources', 'screen', 'sources', 'video', 7]), ['screen', 'sources'],
  'order is fixed, repeats and unknown keys are dropped');
assert.deepStrictEqual(Q.normalizePins(['purity']), ['purity']);

// The boundary refuses instead of repairing, so a window bug is not hidden.
assert.strictEqual(Q.isValidPins(['screen', 'sources']), true);
assert.strictEqual(Q.isValidPins([]), true);
assert.strictEqual(Q.isValidPins(['screen', 'screen']), false, 'a repeated key is refused');
assert.strictEqual(Q.isValidPins(['media']), false, 'a filter that does not exist is refused');
assert.strictEqual(Q.isValidPins('screen'), false);
assert.strictEqual(Q.isValidPins([null]), false);

// Fitting: buttons leave the row from the end, as a group.
assert.strictEqual(Q.fitCount([120, 60, 100], 400, 8), 3);
assert.strictEqual(Q.fitCount([120, 60, 100], 296, 8), 3, 'exactly full still fits');
assert.strictEqual(Q.fitCount([120, 60, 100], 295.6, 8), 3, 'half a pixel of rounding does not push one out');
assert.strictEqual(Q.fitCount([120, 60, 100], 295, 8), 2);
assert.strictEqual(Q.fitCount([120, 60, 100], 150, 8), 1);
assert.strictEqual(Q.fitCount([120, 60, 100], 100, 8), 0, 'a first button that does not fit takes the rest with it');
assert.strictEqual(Q.fitCount([120, 10], 125, 8), 1, 'a later small button does not jump over a gap');
assert.strictEqual(Q.fitCount([], 300, 8), 0);
assert.strictEqual(Q.fitCount([50], 0, 8), 0, 'a row out of sight fits nothing');

// Labels say the current value, in the fixed order of the checkboxes.
assert.strictEqual(Q.purityLabel({ sfw: true, sketchy: false, nsfw: false }), 'SFW');
assert.strictEqual(Q.purityLabel({ nsfw: true, sfw: true }), 'SFW · NSFW');
assert.strictEqual(Q.purityLabel({ sfw: true, sketchy: true, nsfw: true }), 'SFW · Sketchy · NSFW');
assert.strictEqual(Q.purityLabel({}), 'SFW', 'an empty selection is repaired to SFW elsewhere; the label agrees');

// "Changed" means different from a fresh install, never merely "set".
const fresh = { sizeEnabled: false, purity: { sfw: true, sketchy: false, nsfw: false }, sourcesNarrowed: false };
assert.deepStrictEqual(Q.activeKeys(fresh), [], 'a fresh profile has nothing to count');
assert.deepStrictEqual(Q.activeKeys({ ...fresh, sizeEnabled: true }), ['screen']);
assert.deepStrictEqual(Q.activeKeys({ ...fresh, purity: { sfw: true, sketchy: true } }), ['purity'],
  'widening the content purity is a change the user should be able to see');
assert.deepStrictEqual(Q.activeKeys({ ...fresh, purity: { sketchy: true } }), ['purity']);
assert.deepStrictEqual(Q.activeKeys({ ...fresh, sourcesNarrowed: true }), ['sources']);
assert.deepStrictEqual(Q.activeKeys(undefined), ['purity'], 'unknown purity is not assumed to be the default');

// The count on "Filters": changed settings the row does not show, pinned or not.
assert.strictEqual(Q.hiddenActiveCount(['screen', 'purity'], ['screen', 'purity', 'sources']), 0);
assert.strictEqual(Q.hiddenActiveCount(['screen', 'purity'], ['screen']), 1, 'an overflowed changed button is counted');
assert.strictEqual(Q.hiddenActiveCount(['sources'], []), 1, 'so is an unpinned one');
assert.strictEqual(Q.hiddenActiveCount([], []), 0, 'unchanged hidden buttons are not counted');

// Config and the settings file agree with the module.
assert.deepStrictEqual(config.DEFAULT_CONFIG.onlineQuickFilters, ['screen', 'purity', 'sources']);
assert.deepStrictEqual(config.normalize({}).onlineQuickFilters, ['screen', 'purity', 'sources']);
assert.deepStrictEqual(config.normalize({ onlineQuickFilters: [] }).onlineQuickFilters, [], 'an emptied row survives a restart');
assert.deepStrictEqual(config.normalize({ onlineQuickFilters: ['sources', 'bogus'] }).onlineQuickFilters, ['sources']);
assert.ok(!('onlineSourcesExpanded' in config.DEFAULT_CONFIG), 'the old inline source list is gone with its setting');

console.log('Online quick filters PASS: pins, fit, labels, changed-state count, config');

// ---- the window's own path: real renderer functions under a small fake DOM ----------
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OnlineSources = require('../src/online-sources');
const SizeFilter = require('../src/size-filter');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function code(name) {
  const match = source.match(new RegExp('(async )?function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(match, name);
  return match[0];
}
function button(quick, width) {
  const classes = new Set();
  return {
    dataset: { quick }, hidden: false, attrs: {}, listeners: {},
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, has: (name) => classes.has(name) },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    // A hidden button measures nothing, like the real one.
    getBoundingClientRect() { return { width: this.hidden ? 0 : width }; },
  };
}

(async () => {
  const providers = [
    { id: 'wallhaven', name: 'Wallhaven', browse: true },
    { id: 'gelbooru', name: 'Gelbooru', browse: true },
  ];
  const buttons = [button('screen', 130), button('purity', 70), button('sources', 110)];
  const pins = ['screen', 'purity', 'sources'].map((pin) => ({ dataset: { pin }, checked: false }));
  const row = { clientWidth: 600 };
  const badge = { hidden: true, textContent: '' };
  const label = { textContent: '' };
  const filters = { title: '' };
  const saved = [];
  const ctx = {
    OnlineQuickFilters: Q, OnlineSources, SizeFilter,
    config: {
      onlineQuickFilters: ['screen', 'purity', 'sources'],
      onlineSources: OnlineSources.normalize({ internet: true }, providers),
      onlineSizeFilter: { enabled: false, mode: 'auto', targets: [] },
    },
    INTERNET: { purity: { sfw: true, sketchy: false, nsfw: false }, providers },
    t: (key, params) => (params ? `${key}:${params.n}` : key),
    getComputedStyle: () => ({ columnGap: '8px' }),
    window: { api: { setConfig: async (patch) => { saved.push(JSON.stringify(patch)); return { ...ctx.config, ...patch }; } } },
    $: (id) => ({
      '#onlineQuickFilters': row, '#onlineFilterCount': badge,
      '#onlineQuickPurityLabel': label, '#whFilterToggle': filters,
    })[id] || null,
    document: {
      querySelectorAll: (sel) => (sel === '#onlineQuickFilters [data-quick]' ? buttons
        : sel === '#onlineQuickPins input[data-pin]' ? pins : []),
    },
  };
  row.querySelectorAll = () => buttons;
  vm.createContext(ctx);
  for (const name of ['sizeFilterState', 'onlineQuickFilterState', 'renderOnlineQuickFilters',
    'fitOnlineQuickFilters', 'toggleOnlineQuickPin']) vm.runInContext(code(name), ctx);
  const visible = () => buttons.filter((b) => !b.hidden).map((b) => b.dataset.quick).join(',');

  ctx.renderOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen,purity,sources', 'a wide row shows every pinned button');
  assert.strictEqual(badge.hidden, true, 'nothing changed, nothing to count');
  assert.strictEqual(label.textContent, 'SFW');
  assert.strictEqual(buttons[0].attrs['aria-pressed'], 'false');
  assert.ok(pins.every((pin) => pin.checked), 'the pin checkboxes show the stored row');

  ctx.config.onlineSizeFilter = { enabled: true, mode: 'auto', targets: [] };
  ctx.INTERNET.purity = { sfw: true, sketchy: true, nsfw: false };
  ctx.renderOnlineQuickFilters();
  assert.strictEqual(buttons[0].attrs['aria-pressed'], 'true', 'the screen button reads the real size filter');
  assert.ok(buttons[0].classList.has('active') && buttons[1].classList.has('active'));
  assert.strictEqual(label.textContent, 'SFW · Sketchy', 'the purity button says the current value');
  assert.strictEqual(badge.hidden, true, 'changed but visible: no count');

  row.clientWidth = 220; // screen 130 + 8 + purity 70 = 208; sources does not fit
  ctx.fitOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen,purity', 'the last button leaves a narrow row');
  assert.strictEqual(badge.hidden, true, 'an unchanged button out of sight is not counted');
  row.clientWidth = 150;
  ctx.fitOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen');
  assert.strictEqual(badge.textContent, '1', 'the changed purity out of sight is counted');
  assert.strictEqual(filters.title, 'online.filtersHidden:1');
  row.clientWidth = 600;
  ctx.fitOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen,purity,sources', 'a wider row brings them back');

  // Unpinning: the button leaves, its checkbox clears, a changed setting is counted.
  await ctx.toggleOnlineQuickPin('purity', false);
  assert.strictEqual(saved.at(-1), '{"onlineQuickFilters":["screen","sources"]}');
  assert.strictEqual(visible(), 'screen,sources');
  assert.strictEqual(pins[1].checked, false);
  assert.strictEqual(badge.textContent, '1', 'an unpinned but changed filter is still reported');
  await ctx.toggleOnlineQuickPin('purity', true);
  assert.strictEqual(saved.at(-1), '{"onlineQuickFilters":["screen","purity","sources"]}', 'repinned into its fixed place');
  assert.strictEqual(badge.hidden, true);

  // A refused write leaves the row as it is stored, not as it was clicked.
  ctx.window.api.setConfig = async () => { throw new Error('E_SETTINGS_REJECTED'); };
  await ctx.toggleOnlineQuickPin('screen', false);
  assert.strictEqual(visible(), 'screen,purity,sources');
  assert.strictEqual(pins[0].checked, true);

  // The row's padding only holds the keyboard focus ring; buttons fit inside it.
  ctx.getComputedStyle = () => ({ columnGap: '8px', paddingLeft: '4px', paddingRight: '4px' });
  row.clientWidth = 216; // 4 + screen 130 + 8 + purity 70 + 4
  ctx.fitOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen,purity', 'padding is not counted as room for buttons');
  row.clientWidth = 215;
  ctx.fitOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/styles.css'), 'utf8');
  const quickRule = css.match(/\.online-quick \{([^}]+)\}/)[1];
  assert.ok(/overflow: hidden/.test(quickRule) && /padding: 4px; margin: -4px;/.test(quickRule),
    'the clipped row keeps room for the 2px outline + 2px offset focus ring');
  ctx.getComputedStyle = () => ({ columnGap: '8px' });

  // A row out of sight keeps every pinned button and is measured when it appears.
  row.clientWidth = 0;
  ctx.fitOnlineQuickFilters();
  assert.strictEqual(visible(), 'screen,purity,sources');

  // The one menu: a second button while it is open switches it in place.
  const popover = { open: false, dataset: { scope: 'all' }, matches: () => popover.open };
  let placed = null;
  const invokers = ['purity', 'sources', 'all'].map((scope) => ({ dataset: { scope }, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; } }));
  const menuCtx = {
    ONLINE_FILTER_MENU: { invoker: null },
    $: (id) => (id === '#onlineFilterPopover' ? popover : null),
    document: { querySelectorAll: () => invokers },
    bindAnchoredPopover() {}, placeAnchoredPopover: (_pop, trigger) => { placed = trigger; },
    renderOnlineQuickFilters() {}, sizeFilterState: () => ({ enabled: false }),
  };
  vm.createContext(menuCtx);
  vm.runInContext(code('initOnlineFilterMenu'), menuCtx);
  menuCtx.initOnlineFilterMenu();
  const click = (invoker) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    invoker.listeners.click(event);
    return event;
  };
  let event = click(invokers[0]);
  assert.strictEqual(popover.dataset.scope, 'purity', 'a quick button opens only its own section');
  assert.strictEqual(event.prevented, false, 'a closed menu is opened by the native toggle');
  popover.open = true;
  event = click(invokers[1]);
  assert.strictEqual(event.prevented, true, 'another button does not close the open menu');
  assert.strictEqual(popover.dataset.scope, 'sources');
  assert.strictEqual(placed, invokers[1], 'and the menu moves to it');
  event = click(invokers[1]);
  assert.strictEqual(event.prevented, false, 'the same button again closes it natively');

  console.log('Online quick filters PASS: window row fit, count, pins, refused write, one menu for every button');
})().catch((error) => { console.error(error); process.exitCode = 1; });
