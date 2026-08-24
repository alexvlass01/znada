'use strict';

// Do the settings and the pool still agree about what exists?
//
// DATA-005, second half. The two files are each written atomically — temp file plus
// rename, so neither can be caught half-written — but they are not written TOGETHER.
// saveConfig() now flushes the pool FIRST and writes settings second. That makes its
// ordinary crash outcome safe: an unreferenced pool row rather than a slot naming a
// row that never reached disk. If an older build/profile or an external interruption
// still leaves a dangling id, startup runs this repair as the explicit fallback.
//
// It fails quietly, which is what makes it worth code. The slot looks filled in the
// interface, resolves to no path, and a slot that resolves to nothing is deliberately
// silent — the same silence BUG-014 was about, one step further back.
//
// No epoch counter here, deliberately. The plan proposed writing a monotonic number
// into both files to show which one is behind, and it would work — but it changes no
// decision: a reference with no record behind it is repaired the same way whatever the
// reason, and the check for one needs no counter. A field in both files that alters
// nothing is machinery, not safety.

// Slot references live under monitors[id][theme].itemIds. The legacy single-wallpaper
// fields are PATHS, not references into the pool, and are none of this function's
// business — treating one as a reference would clear a perfectly good wallpaper.
const THEMES = ['light', 'dark'];

function findDanglingSlots(monitors, library) {
  const pool = library && typeof library === 'object' ? library : {};
  const found = [];
  for (const [monitorId, slots] of Object.entries(monitors && typeof monitors === 'object' ? monitors : {})) {
    if (!slots || typeof slots !== 'object') continue;
    for (const theme of THEMES) {
      const slot = slots[theme];
      const ids = slot && Array.isArray(slot.itemIds) ? slot.itemIds : [];
      for (const itemId of ids) {
        if (itemId && !pool[itemId]) found.push({ monitorId, theme, itemId });
      }
    }
  }
  return found;
}

// Clears references that lead nowhere and reports how many. Photos are never touched:
// a repair that deletes a file to make the books balance is worse than the imbalance.
// The record itself cannot be brought back — nothing on disk still knows its path — so
// honesty is the most that can be offered, and the caller says so in the journal.
function repairDanglingSlots(monitors, library) {
  const dangling = findDanglingSlots(monitors, library);
  if (!dangling.length) return 0;
  const dead = new Set(dangling.map((entry) => entry.monitorId + '\0' + entry.theme + '\0' + entry.itemId));
  for (const [monitorId, slots] of Object.entries(monitors)) {
    for (const theme of THEMES) {
      const slot = slots && slots[theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      slot.itemIds = slot.itemIds.filter(
        (itemId) => !dead.has(monitorId + '\0' + theme + '\0' + itemId),
      );
    }
  }
  return dangling.length;
}

module.exports = { THEMES, findDanglingSlots, repairDanglingSlots };
