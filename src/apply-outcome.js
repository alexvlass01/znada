'use strict';

// Why a slot produced nothing, and whether that is a state or a breakage.
//
// These were reported as the same event and are not. A slot the user emptied on
// purpose and a slot whose photos sit on a disk that is no longer plugged in both
// ended as 'no-wallpaper' — and 'no-wallpaper' is deliberately silent, because an
// empty slot is nobody's problem. So an unplugged disk said nothing at all: no
// notification, no line in the journal (BUG-014).
//
// What tells them apart was always right there in the loop that builds the list:
// an empty slot resolves to no path, while a vanished source resolves to a path
// with nothing behind it.

const APPLIED = 'ok';
const EMPTY = 'empty';
const MISSING = 'missing';

function describeTarget(target) {
  if (!target || !target.path) return EMPTY;
  return target.exists ? APPLIED : MISSING;
}

function classifyApplyTargets(targets) {
  const applied = [];
  const missing = [];
  const empty = [];
  for (const target of (Array.isArray(targets) ? targets : [])) {
    const state = describeTarget(target);
    if (state === APPLIED) applied.push(target);
    else if (state === MISSING) missing.push(target);
    else empty.push(target);
  }
  return {
    applied,
    missing,
    empty,
    // Nothing went up. WHICH of the two decides whether anyone hears about it.
    reason: applied.length ? '' : (missing.length ? 'wallpaper-missing' : 'no-wallpaper'),
    // A partly missing apply still SUCCEEDS — every monitor that can be set is set —
    // and the vanished source is still a breakage that has to be reported. Fixing
    // only the all-or-nothing outcome would have left this half silent: with two
    // monitors and one broken source, the desktop still changes and nobody is told.
    hasMissing: missing.length > 0,
    missingPaths: missing.map((target) => target.path),
  };
}

module.exports = { APPLIED, EMPTY, MISSING, describeTarget, classifyApplyTargets };
