'use strict';

// Edge-triggered failure state per background channel (plan: error_notifications T2).
// The owner's rule: notify ONCE when something goes from "working" to "broken", then
// stay silent while it keeps failing; a success resets the channel (and reports the
// recovery exactly once). This module is the pure state machine — main.js decides what
// an edge means (system notification, journal entry) based on the returned booleans.
function createFailureNotifier() {
  const failed = new Set(); // channels currently in the "broken" state

  return {
    // Returns true only on the working→broken edge (the caller should notify/log now).
    fail(channel) {
      const key = String(channel || '');
      if (!key || failed.has(key)) return false;
      failed.add(key);
      return true;
    },

    // Returns true only on the broken→working edge (the caller may log the recovery).
    success(channel) {
      const key = String(channel || '');
      if (!key || !failed.has(key)) return false;
      failed.delete(key);
      return true;
    },

    isFailed(channel) {
      return failed.has(String(channel || ''));
    },

    reset() {
      failed.clear();
    },
  };
}

module.exports = { createFailureNotifier };
