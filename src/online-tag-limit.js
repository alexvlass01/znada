'use strict';

// LIB-014 stage 3. Does this query fit what a site can take?
//
// Some sites accept only so many words in one search. Danbooru without an account takes two,
// and counts its own sort among them, so two typed tags with "Top" were sent anyway and came
// back as a refusal that the window called "could not load" (BUG-051). The boards also used to
// keep only the first two typed tags and drop the rest without a word.
//
// The owner's decision (2026-09-28): such a site sits that search out — "paused" — and the
// user's choice of sites stays as it is. So the question is asked BEFORE the request, here.
//
// What is counted is exactly what the adapter would send — its own `searchTerms(params)`, the
// list the address is built from — not "typed tags plus a guess about the sort": what a site
// adds itself depends on the sort, the content setting and the size filter, and a guess drifts.
// A site states the limit as data (`capabilities.tagLimit`): the number, the search commands it
// does not count, and the date it was measured. `null` means measured and unlimited.
//
// Pure: no network, no settings, nothing remembered between calls.

// The order every site understands without spending a word on it ("Latest").
const PLAIN_SORT = 'date_added';

// `rating:g` → `rating`, `-rating:general` → `rating`, `order:score` → `order`; a plain tag
// has no name. A tag whose own name holds a colon inside a qualifier (`beatrice_(re:zero)`)
// is not a command: its "name" is not a command name, so it is counted like any tag.
function commandName(word) {
  const text = String(word || '').replace(/^[-~]+/, '');
  const colon = text.indexOf(':');
  return colon > 0 ? text.slice(0, colon).toLowerCase() : '';
}

// How many of these words the site counts against its limit.
function countWords(words, free) {
  const notCounted = new Set((Array.isArray(free) ? free : []).map((name) => String(name).toLowerCase()));
  let used = 0;
  for (const word of Array.isArray(words) ? words : []) {
    const name = commandName(word);
    if (!(name && notCounted.has(name))) used += 1;
  }
  return used;
}

function limitOf(descriptor) {
  const limit = descriptor && descriptor.capabilities && descriptor.capabilities.tagLimit;
  return limit && Number.isFinite(Number(limit.max)) && Number(limit.max) > 0 ? limit : null;
}

// The answer for one site and one request:
//   { fits: true }                                  — ask it;
//   { fits: false, used, max, sortHelps }           — do not; it is paused for this search.
// `sortHelps` says whether the same search with "Latest" would fit: two tags and "Top" on a
// site that counts its sort. The window tells the user so instead of "too many tags", which
// would make no sense for two.
function verdict(descriptor, params) {
  const limit = limitOf(descriptor);
  if (!limit || typeof descriptor.searchTerms !== 'function') return { fits: true };
  const max = Number(limit.max);
  const used = countWords(descriptor.searchTerms(params || {}), limit.free);
  if (used <= max) return { fits: true, used, max };
  const sort = params && (params.sort || params.sorting);
  let sortHelps = false;
  if (sort && sort !== PLAIN_SORT) {
    const plain = { ...params, sort: PLAIN_SORT, sorting: PLAIN_SORT };
    sortHelps = countWords(descriptor.searchTerms(plain), limit.free) <= max;
  }
  return { fits: false, used, max, sortHelps };
}

module.exports = { PLAIN_SORT, commandName, countWords, verdict };
