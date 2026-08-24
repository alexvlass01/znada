'use strict';

// BUG-021: the app draws its own dropdown list, because the popup of a native <select>
// is drawn by Windows and ignores every style on the page. These tests cover the parts
// that decide WHERE the list goes and WHICH row is active — the two things that actually
// break in a hand-written dropdown (a list clipped by the bottom of the window, or a
// keyboard that lands on a row the eye is not on).

const assert = require('assert');
const SelectPopup = require('../renderer/select-popup');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const VIEW = { width: 1000, height: 700 };

// --- where the list goes ---------------------------------------------------
{
  const anchor = rect(200, 100, 160, 34);
  const spot = SelectPopup.placeMenu(anchor, { width: 160, height: 120 }, VIEW);
  ok('with room below, the list hangs under the control and lines up with its left edge',
    spot.above === false && spot.top === anchor.bottom + 6 && spot.left === 200);

  // A control near the bottom: dropping below would leave a sliver.
  const low = rect(200, 640, 160, 34);
  const flipped = SelectPopup.placeMenu(low, { width: 160, height: 220 }, VIEW);
  ok('a control near the bottom opens upward instead of into a sliver',
    flipped.above === true && flipped.top + 220 <= low.top - 6 + 1);

  // Cramped both ways: stay below rather than flip to something equally bad.
  const middle = rect(200, 330, 160, 34);
  const squeezed = SelectPopup.placeMenu(middle, { width: 160, height: 600 }, VIEW);
  ok('squeezed both ways it stays below and simply gets a scrollbar',
    squeezed.above === false && squeezed.maxHeight === VIEW.height - middle.bottom - 6 - 8);

  ok('the list is never taller than the room it has',
    SelectPopup.placeMenu(rect(0, 690, 100, 8), { width: 100, height: 400 }, VIEW).maxHeight >= 0);

  // A control scrolled out of sight reports a huge amount of "room above". Without a
  // clamp the list is placed off the bottom of the window — found by opening a control
  // that had scrolled below the fold.
  const offscreen = SelectPopup.placeMenu(rect(200, 839, 233, 34), { width: 233, height: 194 }, VIEW);
  ok('a control scrolled past the bottom still gets a list that is on screen',
    offscreen.top >= 8 && offscreen.top + 194 <= VIEW.height - 8);
  ok('and its list is never taller than the window itself',
    offscreen.maxHeight <= VIEW.height - 16);

  const offTop = SelectPopup.placeMenu(rect(200, -400, 233, 34), { width: 233, height: 194 }, VIEW);
  ok('the same holds for a control scrolled past the top',
    offTop.top >= 8 && offTop.top + Math.min(194, offTop.maxHeight) <= VIEW.height - 8);
}

{
  const anchor = rect(100, 100, 220, 34);
  ok('a list narrower than the control is widened to match it — it drops from that control',
    SelectPopup.placeMenu(anchor, { width: 90, height: 100 }, VIEW).width === 220);
  ok('a list wider than the control keeps its own width',
    SelectPopup.placeMenu(anchor, { width: 340, height: 100 }, VIEW).width === 340);
  ok('a list wider than the window is cut down to fit inside the margins',
    SelectPopup.placeMenu(anchor, { width: 5000, height: 100 }, VIEW).width === VIEW.width - 16);
}

{
  // The language list sits on the right-hand side of the Settings page.
  const nearRight = rect(940, 200, 50, 34);
  const spot = SelectPopup.placeMenu(nearRight, { width: 260, height: 200 }, VIEW);
  ok('a control near the right edge pulls its list back on screen',
    spot.left + spot.width <= VIEW.width - 8 && spot.left === VIEW.width - 8 - 260);

  const nearLeft = rect(2, 200, 50, 34);
  ok('a control at the left edge never puts its list past the margin',
    SelectPopup.placeMenu(nearLeft, { width: 260, height: 200 }, VIEW).left === 8);

  // A window narrower than the list itself: clamping must not push it off to the left.
  const tiny = { width: 200, height: 400 };
  const cramped = SelectPopup.placeMenu(rect(150, 100, 40, 30), { width: 400, height: 100 }, tiny);
  ok('even in a window narrower than the list, the left edge stays inside',
    cramped.left === 8 && cramped.width === tiny.width - 16);
}

// --- which row the keyboard lands on ---------------------------------------
{
  //                    0     1      2      3      4
  const enabled = [true, false, true, true, false];

  ok('opening with nothing chosen puts the highlight on the first usable row',
    SelectPopup.moveIndex(enabled, -1, 'ArrowDown') === 0);
  ok('opening upward puts it on the last usable row',
    SelectPopup.moveIndex(enabled, -1, 'ArrowUp') === 3);
  ok('a disabled row is stepped over, not landed on',
    SelectPopup.moveIndex(enabled, 0, 'ArrowDown') === 2);
  ok('and stepped over going the other way too',
    SelectPopup.moveIndex(enabled, 2, 'ArrowUp') === 0);

  // "Coming soon" sits last in the viewer-background list and must not be reachable.
  ok('holding Down at the end stays put instead of wrapping to the top',
    SelectPopup.moveIndex(enabled, 3, 'ArrowDown') === 3);
  ok('holding Up at the start stays put instead of wrapping to the bottom',
    SelectPopup.moveIndex(enabled, 0, 'ArrowUp') === 0);

  ok('Home and End go to the usable ends, not to a disabled row',
    SelectPopup.moveIndex(enabled, 2, 'Home') === 0 && SelectPopup.moveIndex(enabled, 2, 'End') === 3);
  // A disabled row FIRST as well as last — otherwise "Home" would look correct while
  // simply returning 0, and a leading placeholder row would be selectable.
  const fenced = [false, true, true, false];
  ok('Home skips a disabled row at the very top too',
    SelectPopup.moveIndex(fenced, 2, 'Home') === 1 && SelectPopup.moveIndex(fenced, 1, 'End') === 2);
  ok('opening a list that starts with a disabled row lands past it',
    SelectPopup.moveIndex(fenced, -1, 'ArrowDown') === 1
    && SelectPopup.moveIndex(fenced, -1, 'ArrowUp') === 2);

  const long = Array.from({ length: 30 }, () => true);
  ok('Page Down moves a screenful and Page Up comes back',
    SelectPopup.moveIndex(long, 0, 'PageDown') === 10
    && SelectPopup.moveIndex(long, 10, 'PageUp') === 0);
  ok('Page Down near the end clamps instead of running off',
    SelectPopup.moveIndex(long, 25, 'PageDown') === 29);

  ok('keys that are not navigation are left alone',
    SelectPopup.moveIndex(enabled, 0, 'a') === -1
    && SelectPopup.moveIndex(enabled, 0, 'Enter') === -1
    && SelectPopup.moveIndex(enabled, 0, 'Escape') === -1);

  ok('an empty list answers "nowhere to go" rather than throwing',
    SelectPopup.moveIndex([], 0, 'ArrowDown') === -1 && SelectPopup.moveIndex(null, 0, 'ArrowDown') === -1);

  // The trap this exists to close: with nothing selectable, moveIndex has no answer,
  // and treating "no answer" as "not my key" would let the arrow reach the <select>
  // underneath and change its value behind the open list.
  ok('a list with nothing usable still claims the arrow keys',
    SelectPopup.moveIndex([false, false], -1, 'ArrowDown') === -1
    && SelectPopup.moveIndex([false, false], -1, 'End') === -1
    && SelectPopup.isNavigationKey('ArrowDown') === true
    && SelectPopup.isNavigationKey('End') === true);
  ok('navigation keys are named exactly, so letters and Enter still fall through',
    ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].every(SelectPopup.isNavigationKey)
    && !SelectPopup.isNavigationKey('Enter') && !SelectPopup.isNavigationKey('a')
    && !SelectPopup.isNavigationKey(' ') && !SelectPopup.isNavigationKey('Escape'));
}

// --- typing to jump ---------------------------------------------------------
{
  const labels = ['Системный', 'Українська', 'Русский', 'English', 'Español', 'Eesti'];
  const enabled = labels.map(() => true);

  ok('one letter jumps to the first option starting with it',
    SelectPopup.typeaheadIndex(labels, enabled, 'e', -1) === 3);
  ok('the same letter again moves to the NEXT one, so repeats cycle',
    SelectPopup.typeaheadIndex(labels, enabled, 'ee', 3) === 4
    && SelectPopup.typeaheadIndex(labels, enabled, 'eee', 4) === 5);
  ok('cycling wraps back to the first match rather than stopping',
    SelectPopup.typeaheadIndex(labels, enabled, 'ee', 5) === 3);
  ok('a growing word refines without skipping the option already highlighted',
    SelectPopup.typeaheadIndex(labels, enabled, 'es', 3) === 4);
  ok('matching ignores case',
    SelectPopup.typeaheadIndex(labels, enabled, 'ENG', -1) === 3);
  ok('non-Latin labels are matched the same way',
    SelectPopup.typeaheadIndex(labels, enabled, 'рус', -1) === 2);
  ok('no match leaves the highlight where it is',
    SelectPopup.typeaheadIndex(labels, enabled, 'zz', 2) === -1);
  ok('an empty buffer matches nothing instead of the first row',
    SelectPopup.typeaheadIndex(labels, enabled, '', 2) === -1);
  ok('a disabled option is never the answer',
    SelectPopup.typeaheadIndex(['Ambient', 'Amber (soon)'], [true, false], 'amb', 0) === 0
    && SelectPopup.typeaheadIndex(['Ambient', 'Amber (soon)'], [false, false], 'amb', -1) === -1);
}

// --- the keys that used to open the Windows popup ---------------------------
{
  const key = (k, mods = {}) => Object.assign({ key: k, altKey: false, ctrlKey: false, metaKey: false }, mods);

  ok('F4 opens our list, the way it opened the system one',
    SelectPopup.opensNativePopup(key('F4')) === true);
  ok('Alt+Down and Alt+Up open it too',
    SelectPopup.opensNativePopup(key('ArrowDown', { altKey: true })) === true
    && SelectPopup.opensNativePopup(key('ArrowUp', { altKey: true })) === true);
  ok('Enter and Space open it',
    SelectPopup.opensNativePopup(key('Enter')) === true
    && SelectPopup.opensNativePopup(key(' ')) === true);
  ok('a bare arrow does NOT open it — on a closed control it steps the value, as it always did',
    SelectPopup.opensNativePopup(key('ArrowDown')) === false);
  ok('modifier combinations that belong to the app are not swallowed',
    SelectPopup.opensNativePopup(key('Enter', { ctrlKey: true })) === false
    && SelectPopup.opensNativePopup(key('Enter', { metaKey: true })) === false);
  ok('ordinary typing does not open it',
    SelectPopup.opensNativePopup(key('a')) === false && SelectPopup.opensNativePopup(null) === false);
}

console.log('\nAll ' + passed + ' select-popup tests passed.');
