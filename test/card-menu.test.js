'use strict';

// ONL-009: the three pieces the card menu is built from, all shared between the main
// window and the fullscreen viewer. Only their decision-making is covered here — where
// the menu goes, which item the keyboard lands on, which message an outcome earns, and
// which monitor slots exist. The DOM around those is exercised by running both windows.

const assert = require('assert');
const CardMenu = require('../renderer/card-menu');
const CardTransfer = require('../renderer/card-transfer');
const AssignRows = require('../renderer/assign-rows');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

// --- where the menu goes ----------------------------------------------------
{
  const view = { width: 1000, height: 700 };
  ok('a menu opens exactly where the pointer was, when there is room',
    JSON.stringify(CardMenu.placeAt({ x: 120, y: 80 }, { width: 200, height: 240 }, view))
      === JSON.stringify({ left: 120, top: 80 }));

  const corner = CardMenu.placeAt({ x: 990, y: 690 }, { width: 200, height: 240 }, view);
  ok('a right-click near the bottom-right corner is pulled fully back on screen',
    corner.left + 200 <= view.width - 8 && corner.top + 240 <= view.height - 8);

  const topLeft = CardMenu.placeAt({ x: -50, y: -50 }, { width: 200, height: 240 }, view);
  ok('and never placed past the top-left margin either',
    topLeft.left === 8 && topLeft.top === 8);

  // A window smaller than the menu must still show the menu's top-left corner rather
  // than pushing it off to negative coordinates where nothing is reachable.
  const tiny = CardMenu.placeAt({ x: 10, y: 10 }, { width: 400, height: 400 }, { width: 200, height: 200 });
  ok('in a window smaller than the menu it stays anchored at the margin',
    tiny.left === 8 && tiny.top === 8);
}

// --- which item the keyboard lands on ---------------------------------------
{
  ok('opening with nothing focused starts at the first item',
    CardMenu.nextIndex(4, -1, 'ArrowDown') === 0);
  ok('Up from nothing starts at the last, so the bottom item is one key away',
    CardMenu.nextIndex(4, -1, 'ArrowUp') === 3);
  // A context menu is short, so it cycles — unlike the settings dropdown, which clamps
  // the way the platform's own lists do.
  ok('Down past the end wraps to the top',
    CardMenu.nextIndex(4, 3, 'ArrowDown') === 0);
  ok('Up past the start wraps to the bottom',
    CardMenu.nextIndex(4, 0, 'ArrowUp') === 3);
  ok('Home and End jump to the ends',
    CardMenu.nextIndex(4, 2, 'Home') === 0 && CardMenu.nextIndex(4, 2, 'End') === 3);
  ok('keys that are not navigation are left alone',
    CardMenu.nextIndex(4, 1, 'a') === -1 && CardMenu.nextIndex(4, 1, 'Enter') === -1);
  ok('an empty menu answers "nowhere" rather than throwing',
    CardMenu.nextIndex(0, 0, 'ArrowDown') === -1 && CardMenu.nextIndex(null, 0, 'ArrowDown') === -1);

  ok('Escape and Tab both close the menu, so it can never trap focus',
    CardMenu.closesMenu('Escape') && CardMenu.closesMenu('Esc') && CardMenu.closesMenu('Tab'));
  ok('ordinary keys do not close it',
    !CardMenu.closesMenu('ArrowDown') && !CardMenu.closesMenu('a') && !CardMenu.closesMenu('Enter'));
}

// --- exactly one row is ever "current" --------------------------------------
// Reported from a real screenshot: the menu opened with the first row highlighted, the
// pointer landed on the second, and BOTH lit up as one block. Two different states were
// painting the same thing — the focused row and the hovered row — so any moment where
// they were different rows showed two selections.
//
// The rule now: pointing at a row focuses it, and only the focused row is painted. That
// also covers the case a pointer-only fix would miss — mouse resting on one row while
// the arrow keys move to another.
{
  const fs = require('fs');
  const path = require('path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const menuJs = read('renderer', 'card-menu.js');
  const itemRules = (css) => (css.match(/[^\n}]*\.lib-context-item[^{]*\{/g) || []).map((r) => r.trim());

  ok('pointing at a menu row makes it the focused row',
    menuJs.includes("button.addEventListener('mouseenter', () => button.focus({ preventScroll: true }));"));
  ok('neither window paints a menu row on hover, so hover and focus can never both light up',
    itemRules(read('renderer', 'styles.css')).every((r) => !r.includes(':hover'))
    && itemRules(read('renderer', 'viewer.css')).every((r) => !r.includes(':hover')));
  ok('the current row is painted from focus in both windows',
    itemRules(read('renderer', 'styles.css')).some((r) => /\.lib-context-item:focus\s*\{/.test(r))
    && itemRules(read('renderer', 'viewer.css')).some((r) => /\.lib-context-item:focus\s*\{/.test(r)));
}

// --- which message an outcome earns -----------------------------------------
{
  ok('a successful copy or save says so',
    CardTransfer.outcomeMessage('copyLink', { ok: true }) === 'card.copiedLink'
    && CardTransfer.outcomeMessage('copyFile', { ok: true }) === 'card.copiedFile'
    && CardTransfer.outcomeMessage('saveAs', { ok: true }) === 'card.saved');

  // The point of this table: a failure must never be reported with the success text.
  ok('every failure gets a failure message, never the success one',
    CardTransfer.outcomeMessage('copyLink', { ok: false }) === 'card.linkFailed'
    && CardTransfer.outcomeMessage('copyFile', null) === 'card.copyFailed'
    && CardTransfer.outcomeMessage('saveAs', { ok: false }) === 'card.saveFailed');

  ok('opening a source page says nothing when it worked — the browser is the feedback',
    CardTransfer.outcomeMessage('openSource', { ok: true }) === '');
  ok('a card with no source page is told exactly that, not a generic failure',
    CardTransfer.outcomeMessage('openSource', { ok: false, error: 'noSource' }) === 'card.noSource'
    && CardTransfer.outcomeMessage('openSource', { ok: false, error: 'open' }) === 'details.openFailed');

  ok('only the two that may have to fetch the picture announce themselves first',
    CardTransfer.pendingMessage('copyFile') === 'card.copyingFile'
    && CardTransfer.pendingMessage('saveAs') === 'card.saving'
    && CardTransfer.pendingMessage('copyLink') === ''
    && CardTransfer.pendingMessage('openSource') === '');
}

// --- running an action against a bridge -------------------------------------
{
  const said = [];
  const notify = (n) => said.push(n);
  const ctx = (bridge, extra = {}) => ({
    bridge, descriptor: { kind: 'internet', id: '', item: {} }, t: (k) => k, notify, ...extra,
  });

  (async () => {
    said.length = 0;
    await CardTransfer.run('copyFile', ctx({ cardCopyFile: async () => ({ ok: true }) }));
    ok('a copy announces that it started and then that it finished',
      said.length === 2 && said[0].message === 'card.copyingFile' && said[1].message === 'card.copiedFile');

    said.length = 0;
    await CardTransfer.run('copyLink', ctx({ cardCopyLink: async () => { throw new Error('offline'); } }));
    ok('a bridge that throws is reported as a failure, not swallowed',
      said.length === 1 && said[0].message === 'card.linkFailed');

    said.length = 0;
    const res = await CardTransfer.run('saveAs', ctx({ cardSaveAs: async () => ({ canceled: true }) }));
    ok('a cancelled save dialog is not announced as a failure',
      res.canceled === true && said.length === 1 && said[0].message === 'card.saving');

    said.length = 0;
    let added = 0;
    await CardTransfer.run('saveAs', ctx(
      { cardSaveAs: async () => ({ ok: true, path: 'C:/out/a.jpg' }) },
      { onAddToLibrary: () => { added += 1; } },
    ));
    const offer = said[said.length - 1];
    ok('a successful save offers adding to the library instead of doing it silently',
      offer.message === 'card.saved' && offer.actionLabel === 'card.addToLibrary'
      && typeof offer.onAction === 'function' && added === 0);
    offer.onAction();
    ok('and only adds it when that offer is actually taken', added === 1);

    said.length = 0;
    const bad = await CardTransfer.run('copyFile', ctx(null));
    ok('a missing bridge fails cleanly rather than throwing at the call site',
      bad.ok === false && bad.error === 'unsupported' && said.length === 0);
    const unknown = await CardTransfer.run('nonsense', ctx({}));
    ok('an unknown action does nothing at all', unknown.ok === false);

    console.log('\nAll ' + passed + ' card-menu tests passed.');
  })().catch((err) => { console.error(err); process.exitCode = 1; });
}

// --- which monitor slots exist ----------------------------------------------
{
  const two = AssignRows.rowsFor([{ id: 'M1', primary: true }, { id: 'M2' }], true);
  ok('with separate day and night wallpapers each monitor offers two slots',
    two.length === 2 && two.every((r) => r.slots.length === 2)
    && JSON.stringify(two[0].slots.map((s) => s.theme)) === JSON.stringify(['light', 'dark']));
  ok('the primary monitor is marked, and monitors are numbered from one',
    two[0].primary === true && two[1].primary === false
    && two[0].number === 1 && two[1].number === 2);

  const single = AssignRows.rowsFor([{ id: 'M1' }], false);
  ok('with one wallpaper for both themes a monitor offers a single slot, and no theme icon',
    single[0].slots.length === 1 && single[0].slots[0].theme === 'light'
    && single[0].slots[0].themeIcon === '');

  // The monitor list arrives asynchronously; an empty menu would look broken.
  const none = AssignRows.rowsFor([], true);
  ok('before the monitor list arrives the primary slot is still offered',
    none.length === 1 && none[0].id === null && none[0].primary === true);
  ok('rubbish is treated the same way rather than throwing',
    AssignRows.rowsFor(null, true).length === 1 && AssignRows.rowsFor(undefined, false).length === 1);
}
