'use strict';

// Tiny state machine for a resize burst. The first logical scroll anchor must
// survive every window.resize / ResizeObserver relayout until the final width is
// stable. Revisions make delayed settle callbacks harmless after a newer change.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ResizeAnchor = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function createSession() {
    let anchor = null;
    let revision = 0;

    const snapshot = () => ({ anchor, revision });

    return {
      begin(candidate) {
        if (!anchor && candidate) anchor = candidate;
        if (anchor) revision += 1;
        return snapshot();
      },

      touch() {
        if (anchor) revision += 1;
        return snapshot();
      },

      current() {
        return anchor;
      },

      snapshot,

      finish(expectedRevision) {
        if (!anchor || revision !== expectedRevision) return null;
        const finished = anchor;
        anchor = null;
        revision += 1;
        return finished;
      },

      cancel() {
        const cancelled = anchor;
        anchor = null;
        revision += 1;
        return cancelled;
      },
    };
  }

  return { createSession };
});
