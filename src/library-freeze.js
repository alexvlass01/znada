'use strict';

// DATA-006 / DATA-009. What a library edit answers while a move rewrites every path in the
// library. WHICH channels are refused stays in main.js, at the door (LIBRARY_EDIT_CHANNELS),
// where every call passes; this is only the shape of the refusal. It differs by channel
// because the callers read different fields, and a refusal a caller misreads is worse than
// none: the viewer read a refused assignment as a done one and said "Assigned".

const MOVE_RUNNING = 'media_move_running';

// Callers read `ok`, `added`, `removed`, `restored` and more; every one of them means
// "nothing happened" here.
/**
 * @param {unknown} config the main window keeps its view in sync with the one it is handed
 */
function genericRefusal(config) {
  return {
    config, ok: false, error: MOVE_RUNNING,
    added: 0, removed: 0, restored: 0, deleted: 0, hidden: 0, warning: null, undo: null,
  };
}

// Channels whose callers read a shape of their own. Every refusal still carries `error`,
// so one test (test/media-move-freeze.test.js) holds the whole list to the same promise.
/** @type {Record<string, () => object>} */
const OWN_SHAPES = {
  'favorite-set': () => ({ error: MOVE_RUNNING }),
  // The viewer holds no config at all, so it is told the one thing it asked for: there is
  // no record. Handing it the generic reply would hand it the whole config.
  'card-ensure-record': () => ({ id: '', error: MOVE_RUNNING }),
  // A lookup ending, read like any other by renderer/card-metadata.js (status, reason and
  // addedTags), so both windows say "files are being moved" instead of "could not check".
  'item-lookup-metadata': () => ({ status: 'error', reason: MOVE_RUNNING, addedTags: 0, error: MOVE_RUNNING }),
};

/**
 * @param {string} channel the IPC channel that was refused
 * @param {unknown} config passed through to the callers that expect it
 */
function refusal(channel, config) {
  const own = OWN_SHAPES[channel];
  return own ? own() : genericRefusal(config);
}

module.exports = { MOVE_RUNNING, refusal };
