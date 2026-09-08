'use strict';

// Plain Node test: `node test/design-card-menu.test.js`.
//
// DESIGN-004 (the owner's idea, 2026-09-03): the thumbnails in the Appearance strip were
// the only pictures in the app with no menu at all. They now get the same one the library
// has, plus one command the library has no use for — "remove from this spot".
//
// SLIDE-001, first slice: the big preview gets it too, because it is the only surface
// that honestly knows which picture is on the desktop right now.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CardActions = require('../renderer/card-actions');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const spot = (over = {}) => ({ monitorId: 'MON-1', theme: 'light', itemId: 'b', index: 1, ...over });
const slot = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// ---------------------------------------------------------------------------
// Which entry of the slot a placement means. This is where the money is: the strip
// captures an index when it draws, and the slot can change before the click lands.
// ---------------------------------------------------------------------------
ok('the ordinary case uses the captured index', CardActions.resolveSlotIndex(slot, spot()) === 1);

// Something was taken out ahead of it, so everything after shifted up by one. Trusting
// the captured index here removes the neighbour — the bug this app already shipped once.
ok('a shifted slot is re-resolved by item, not by the stale index',
  CardActions.resolveSlotIndex([{ id: 'b' }, { id: 'c' }], spot()) === 0);

ok('an item that is no longer in the slot resolves to nothing',
  CardActions.resolveSlotIndex([{ id: 'a' }, { id: 'c' }], spot()) === -1);

// The same picture can sit in one slot twice. Looking it up by id alone would always
// answer "the first one", so right-clicking the second tile would remove the first.
ok('with the same picture twice, the tile you clicked is the one that goes',
  CardActions.resolveSlotIndex([{ id: 'b' }, { id: 'b' }], spot({ index: 1 })) === 1
  && CardActions.resolveSlotIndex([{ id: 'b' }, { id: 'b' }], spot({ index: 0 })) === 0);

ok('an index past the end falls back to the lookup instead of throwing',
  CardActions.resolveSlotIndex(slot, spot({ index: 99 })) === 1);

ok('a placement that names no spot resolves to nothing, whatever the index says',
  CardActions.resolveSlotIndex(slot, { itemId: 'b', index: 1 }) === -1
  && CardActions.resolveSlotIndex(slot, null) === -1);

ok('junk in place of a slot is answered, not thrown at',
  CardActions.resolveSlotIndex(null, spot()) === -1
  && CardActions.resolveSlotIndex([null, undefined], spot()) === -1);

// ---------------------------------------------------------------------------
// The wiring. A rule that lives in a module nobody calls has not been applied.
// ---------------------------------------------------------------------------
ok('the strip tiles get the shared card menu', renderer.includes('bindSlotCardContextMenu(el, it, theme, idx);'));
ok('a tile is bound as an ordinary subject that also knows its placement',
  renderer.includes("record.slot = { monitorId: editTargetId(), theme, itemId: item.id, index };")
  && renderer.includes('openCardMenu(CardActions.localSubject(record, poolItemForRecord(record)), el, point);'));

// The × and the menu entry must not be two implementations of the same idea; the whole
// point of the entry is that it does exactly what the × does.
ok('the × and the menu entry go through one function',
  renderer.includes('takeOutOfSlot(theme, { monitorId: editTargetId(), theme, itemId: it.id, index: idx });')
  && renderer.includes('removeFromSlot: () => (subject.slot'));
ok('removal resolves the index against the slot as it is now',
  renderer.includes('const at = CardActions.resolveSlotIndex(slotItems(theme), placement);')
  && renderer.includes('if (at < 0) return;'));
// Taking a picture out of a spot must never reach into the pool: that is the other
// command, one line below it in the same menu.
ok('taking it out of a spot touches the slot only',
  /async function takeOutOfSlot[\s\S]*?\n}/.test(renderer)
  && !/async function takeOutOfSlot[\s\S]*?\n}/.exec(renderer)[0].includes('libraryRemove'));

ok('the big preview gets the menu too, bound once rather than on every redraw',
  renderer.includes("bindPreviewContextMenu(el, sel === '#previewDark' ? 'dark' : 'light');"));
// The element outlives redraws and only its path attribute changes, so the menu has to
// read the picture at the moment it opens.
ok('the preview menu reads the current picture when it opens',
  renderer.includes("const path = el.dataset.bgPath || '';"));
// A photo coming out of a watched folder is not an item of the slot. Offering to remove
// it "from this spot" would remove the entire folder — far more than was meant.
ok('the preview offers the spot command only when that photo IS an item of the slot',
  renderer.includes("const at = items.findIndex((item) => item && item.type === 'image' && normPathKey(item.path) === key);")
  && renderer.includes('if (at >= 0) record.slot = {'));

const en = require('../locales/en.json');
const ru = require('../locales/ru.json');
ok('both reference languages name the new command', !!en.card.removeFromSlot && !!ru.card.removeFromSlot);
// Two commands three words apart sit next to each other. They must at least not be the
// same words: the confirmation that will protect them is LIB-012, still to come.
ok('it does not read the same as removing from the library',
  en.card.removeFromSlot !== en.library.remove && ru.card.removeFromSlot !== ru.library.remove);

console.log('\nAll ' + passed + ' design-card-menu tests passed.');
