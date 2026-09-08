'use strict';

// Plain Node test: `node test/assign-slots.test.js`.
//
// BUG-037 (the owner's complaint, 2026-09-02): "Assign to monitor" drew the identical
// button for an empty spot and for one already holding photos — and pressing it does not
// replace what is there, it adds alongside. So people set a wallpaper and got a
// slideshow, and the window said "Assigned" either way.
//
// Plus the owner's decision of 2026-09-03: a tick that also SHOWS the picture at once,
// instead of changing what the buttons mean.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AssignRows = require('../renderer/assign-rows');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

const MONITORS = [{ id: 'M1', primary: true }, { id: 'M2' }];
const OCC = {
  slots: {
    M1: { light: ['a', 'b'], dark: ['a'] },
    M2: { light: [], dark: ['c'] },
  },
  itemId: 'a',
};
const slotOf = (rows, monitorIndex, theme) => rows[monitorIndex].slots.find((s) => s.theme === theme);

// ---------------------------------------------------------------------------
// What each spot holds.
// ---------------------------------------------------------------------------
{
  const rows = AssignRows.rowsFor(MONITORS, true, OCC);
  ok('a spot reports how many pictures are in it', slotOf(rows, 0, 'light').count === 2);
  ok('an empty spot reports nothing in it, and is therefore distinguishable',
    slotOf(rows, 1, 'light').count === 0 && slotOf(rows, 1, 'light').hasThis === false);
  ok('a spot says when THIS picture is one of the ones already there',
    slotOf(rows, 0, 'light').hasThis === true && slotOf(rows, 0, 'dark').hasThis === true);
  ok('a spot holding other pictures is not confused with holding this one',
    slotOf(rows, 1, 'dark').count === 1 && slotOf(rows, 1, 'dark').hasThis === false);

  // A bulk assignment has no single picture. Counts still mean something; "already
  // here" does not, and must not be claimed.
  const bulk = AssignRows.rowsFor(MONITORS, true, { slots: OCC.slots, itemId: '' });
  ok('with no picture named, counts still show and "already here" never does',
    slotOf(bulk, 0, 'light').count === 2 && bulk.every((r) => r.slots.every((s) => !s.hasThis)));

  // With one wallpaper for both themes there is a single slot, and it IS the light one.
  const single = AssignRows.rowsFor(MONITORS, false, OCC);
  ok('a single-slot monitor reports the light spot rather than nothing',
    single[0].slots.length === 1 && single[0].slots[0].count === 2 && single[0].slots[0].hasThis === true);
}

// The chooser is drawn before anything is known, and from a config that may be missing
// pieces. None of that may throw or invent occupancy.
{
  const bare = AssignRows.rowsFor(MONITORS, true);
  ok('with no occupancy at all every spot reads as empty',
    bare.every((r) => r.slots.every((s) => s.count === 0 && s.hasThis === false)));
  ok('junk occupancy is treated as none', (() => {
    for (const junk of [null, 'x', 42, {}, { slots: null }, { slots: { M1: null } }, { slots: { M1: { light: 'no' } } }]) {
      const rows = AssignRows.rowsFor(MONITORS, true, junk);
      if (!rows.every((r) => r.slots.every((s) => s.count === 0 && !s.hasThis))) return false;
    }
    return true;
  })());
  ok('the placeholder row shown before monitors arrive reads as empty rather than throwing',
    AssignRows.rowsFor([], true, OCC)[0].slots.every((s) => s.count === 0));
  ok('slotState answers directly too, for a monitor nobody has heard of',
    AssignRows.slotState(OCC, 'M9', 'light').count === 0
    && AssignRows.slotState(OCC, 'M1', 'light').count === 2);
}

// ---------------------------------------------------------------------------
// What the window SAYS afterwards. It used to say "Assigned" to all four of these.
// ---------------------------------------------------------------------------
{
  const key = (o) => AssignRows.outcomeKey(o).key;
  ok('the first picture in an empty spot is plainly assigned',
    key({ countAfter: 1 }) === 'library.assignedToast');
  ok('a second one is named as ADDED, with the number, because a rotation now exists',
    key({ countAfter: 3 }) === 'library.assignedAdded'
    && AssignRows.outcomeKey({ countAfter: 3 }).params.n === 3);
  // The lie that mattered most: pressing on a picture already in the slot does nothing
  // whatsoever, and the window still reported success.
  ok('a picture that was already there is told so, not congratulated',
    key({ alreadyThere: true, countAfter: 2 }) === 'library.assignedAlready');
  ok('with "show it right away" ticked the outcome is that it is showing',
    key({ appliedNow: true, countAfter: 3 }) === 'toast.applied'
    && key({ appliedNow: true, alreadyThere: true, countAfter: 2 }) === 'toast.applied');
  ok('a nonsense count does not produce the "added" wording',
    key({ countAfter: 0 }) === 'library.assignedToast'
    && key({ countAfter: 'many' }) === 'library.assignedToast'
    && key({}) === 'library.assignedToast' && key() === 'library.assignedToast');
}

// ---------------------------------------------------------------------------
// Wiring: a rule nothing calls has not been applied.
// ---------------------------------------------------------------------------
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const viewer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'viewer.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

// --- what `build` actually DRAWS -------------------------------------------
// Checked by building the rows against a stand-in document rather than by reading the
// source: a first attempt asserted only that `rowsFor` can count and that the renderer
// passes occupancy in, and `build` quietly dropping it on the way through survived both.
function fakeDoc() {
  const make = (tag) => ({
    tag, className: '', type: '', title: '', id: '', textContent: '',
    attrs: {}, children: [], html: '',
    appendChild(child) { this.children.push(child); return child; },
    append(...kids) { kids.forEach((k) => this.children.push(k)); },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener() {},
    insertAdjacentHTML(_where, html) { this.html += html; },
  });
  return { createElement: make, createTextNode: (text) => ({ tag: '#text', textContent: text, children: [] }) };
}
function drawn(monitors, separateThemes, occupancy, ctx = {}) {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  AssignRows.build(container, monitors, separateThemes, { doc, occupancy, ...ctx });
  const buttons = [];
  const walk = (node) => {
    if (node.tag === 'button') buttons.push(node);
    (node.children || []).forEach(walk);
  };
  walk(container);
  return buttons;
}
function badgeOf(button) {
  const badge = (button.children || []).find((c) => c.className === 'lib-popup-count');
  return badge ? badge.textContent : null;
}

{
  const buttons = drawn(MONITORS, true, OCC, {
    slotLabel: (slot) => slot.theme,
    slotHint: (slot) => (slot.hasThis ? 'уже здесь это' : (slot.count ? 'занято ' + slot.count : '')),
  });
  ok('four buttons are drawn for two monitors with separate themes', buttons.length === 4);
  ok('the count reaches the button — occupancy is not dropped on the way through',
    badgeOf(buttons[0]) === '2' && badgeOf(buttons[1]) === '1' && badgeOf(buttons[3]) === '1');
  ok('an empty spot carries no badge at all, rather than a nought',
    badgeOf(buttons[2]) === null);
  ok('the button holding this very picture is marked',
    buttons[0].className.includes('is-here') && !buttons[2].className.includes('is-here'));
  ok('and says so in words, for a screen reader and a tooltip',
    buttons[0].attrs['aria-label'].includes('уже здесь это') && buttons[0].title === 'уже здесь это'
    && !buttons[2].attrs['aria-label'].includes('занято'));
  const bare = drawn(MONITORS, true, null, { slotLabel: (s) => s.theme });
  ok('with nothing known the buttons look exactly as they always did',
    bare.every((b) => badgeOf(b) === null && !b.className.includes('is-here')));
}

ok('the main window feeds the chooser what the slots hold',
  renderer.includes('occupancy: slotOccupancy(options.itemId),'));
// Said with the badge's colour rather than with an outline: the window focuses its first
// button on open, and that focus ring is an accent outline too — the first real
// screenshot showed the two meanings drawn identically.
ok('"already here" is drawn, and not as something the focus ring already means',
  /\.lib-popup-btn\.is-here\s+\.lib-popup-count\s*\{[^}]*background:\s*var\(--accent\)/.test(css)
  && !/\.lib-popup-btn\.is-here\s*\{/.test(css)
  && /\.lib-popup-count\s*\{/.test(css));

// The tick, and the promise that it does the same thing clicking the Appearance
// thumbnail does rather than a similar thing.
ok('the window offers "show it right away"', renderer.includes('applyNowInput = appendApplyNowToggle(pop);'));
// The read must EXIST and come first. Written as `< indexOf(...)` alone, a missing line
// scores -1 and passes — which is exactly what let a mutation blanking the read survive.
ok('the tick is read, and read before the window closes', (() => {
  const read = renderer.indexOf('const setNow = !!(applyNowInput && applyNowInput.checked);');
  const close = renderer.indexOf('      closeLibPopup();\n      // `options.pending` marks a source');
  return read >= 0 && close > read;
})());
ok('showing it right away goes through the existing "move to this frame" call',
  renderer.includes('const moved = await window.api.setSlideshowToPath(monitorId, th, state.item.path);'));
ok('what was in the slot BEFORE is captured, or "added" and "was already there" cannot be told apart',
  renderer.includes('const idsBefore = slotItemIds((config.monitors || {})[monitorId], th);'));
ok('the wording is decided by the tested rule, not written out again at the call site',
  renderer.includes('const outcome = AssignRows.outcomeKey({'));

ok('the fullscreen viewer is told the same thing', main.includes('slots[id] = { light: ids(\'light\'), dark: ids(\'dark\') };')
  && viewer.includes('slots: (targets && targets.slots) || {},'));

// BUG-038 — the window's size must stop depending on how many tags a photo has.
ok('the window has a width ceiling', /\.lib-popup\s*\{[^}]*max-width:\s*380px/.test(css));
ok('the tag list is capped and scrolls instead of growing the window',
  /\.lib-chips\s*\{[^}]*max-height:\s*52px[^}]*overflow-y:\s*auto/.test(css));
ok('tag suggestions hang over the window rather than pushing the red button down',
  /\.lib-tag-suggest\s*\{[^}]*position:\s*absolute/.test(css)
  && /\.lib-popup-tags\s*\{[^}]*position:\s*relative/.test(css));
// The single largest cause of the destructive button moving was not the height at all:
// a window that no longer fitted below the card jumped to the OTHER SIDE of it, turning
// an 84-point height difference into a 264-point difference on screen.
ok('a window that does not fit slides up instead of flipping to the other side',
  renderer.includes('const lowest = window.innerHeight - 8 - pop.offsetHeight;')
  && renderer.includes('if (top > lowest) top = lowest;')
  && !renderer.includes('top = r.top - pop.offsetHeight - 6;'));

const en = require('../locales/en.json');
const ru = require('../locales/ru.json');
ok('both reference languages carry the new wording',
  ['assignedAdded', 'assignedAlready', 'applyNow', 'slotFilled', 'slotHasThis']
    .every((k) => en.library[k] && ru.library[k]));
ok('the counted messages actually carry the number',
  en.library.assignedAdded.includes('{n}') && ru.library.assignedAdded.includes('{n}')
  && en.library.slotFilled.includes('{n}') && ru.library.slotFilled.includes('{n}'));

console.log('\nAll ' + passed + ' assign-slots tests passed.');
