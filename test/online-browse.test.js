'use strict';

// BUG-020: "is this our front page or the user's search?" as a state machine.
//
// The interesting case is the exception — changing the ordering with nothing typed — and
// specifically that it EXPIRES. A version of this that quietly persisted would pin the
// front page to one ordering after a single curious click, which is the exact state this
// task exists to undo.

const assert = require('assert');
const OnlineBrowse = require('../renderer/online-browse');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

// --- the ordinary two cases -----------------------------------------------
ok('nothing typed means the curated front page', OnlineBrowse.isBrowse({ q: '', sortTouched: false }));
ok('whitespace is still nothing typed', OnlineBrowse.isBrowse({ q: '   ', sortTouched: false }));
ok('a typed word means a search', !OnlineBrowse.isBrowse({ q: 'landscape', sortTouched: false }));
ok('a typed word wins even over the exception', !OnlineBrowse.isBrowse({ q: 'landscape', sortTouched: true }));
ok('missing state is treated as the front page',
  OnlineBrowse.isBrowse({}) && OnlineBrowse.isBrowse(null) && OnlineBrowse.isBrowse({ q: null }));

// --- the exception --------------------------------------------------------
ok('changing the ordering with nothing typed takes effect',
  OnlineBrowse.sortTouchedAfterChange('', false) === true);
ok('changing it with something typed is an ordinary search setting',
  OnlineBrowse.sortTouchedAfterChange('cats', false) === false);
ok('and does not clear an exception that was already standing',
  OnlineBrowse.sortTouchedAfterChange('cats', true) === true);
ok('once it is set, the request is no longer curated',
  !OnlineBrowse.isBrowse({ q: '', sortTouched: OnlineBrowse.sortTouchedAfterChange('', false) }));

// --- and it expires -------------------------------------------------------
ok('a real search ends the exception', OnlineBrowse.sortTouchedAfterSearch('cats', true) === false);
ok('so clearing the box afterwards returns to the curated front page', (() => {
  let touched = false;
  touched = OnlineBrowse.sortTouchedAfterChange('', touched);        // fiddled with the ordering
  touched = OnlineBrowse.sortTouchedAfterSearch('cats', touched);    // then actually searched
  return OnlineBrowse.isBrowse({ q: '', sortTouched: touched });     // then cleared the box
})());
ok('a front-page reload does not clear it on its own — the control must keep working',
  OnlineBrowse.sortTouchedAfterSearch('', true) === true);
ok('and it never invents itself out of nothing',
  OnlineBrowse.sortTouchedAfterSearch('', false) === false
  && OnlineBrowse.sortTouchedAfterSearch('cats', false) === false);

console.log(`\nAll ${passed} online-browse tests passed.`);
