'use strict';

// One policy for feed cards and local metadata. Unknown is deliberately distinct
// from SFW: LIB-016 leaves it visible, without pretending it has been classified.
(function initContentRating(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ContentRating = api;
}(globalThis, function contentRatingFactory() {
  function normalize(value) {
    const rating = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (['general', 'safe', 'sfw', 'g'].includes(rating)) return 'sfw';
    if (['sensitive', 'questionable', 'suggestive', 'sketchy', 's', 'q'].includes(rating)) return 'sketchy';
    if (['explicit', 'nsfw', 'e'].includes(rating)) return 'nsfw';
    return '';
  }

  function of(item) {
    return item && typeof item === 'object' ? normalize(item.rating) || normalize(item.purity) : '';
  }

  function hidden(rating, settings) {
    const group = normalize(rating);
    return !!(settings && (group === 'nsfw' || group === 'sketchy') && settings[group] === true);
  }

  // Stored metadata uses the existing library vocabulary; no new inference or
  // network request. An absent rating must not erase an earlier known one.
  function patch(item) {
    const group = of(item);
    if (!group) return {};
    const raw = typeof item.rating === 'string' ? item.rating.trim().toLowerCase() : '';
    const rating = ['general', 'safe', 'sensitive', 'questionable', 'explicit'].includes(raw)
      ? raw : { sfw: 'general', sketchy: 'sensitive', nsfw: 'explicit' }[group];
    return { rating };
  }

  return { normalize, of, hidden, patch };
}));
