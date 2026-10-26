'use strict';

// I18N-003. Which catalogue string to fill in when the text contains a count.
//
// t() used to drop the number into one string, so English said "1 photos" and a
// language with three forms had nowhere to put them. The forms are sibling keys
// with a CLDR category suffix: library.photosCount_one, _few, _many, _other.
// Intl.PluralRules(the current language).select(n) names the category.
//
// Search order, and it matters: a language that has not been given forms yet must
// keep its own unsuffixed string. English is only the last resort, otherwise a
// German reader would see English. The unsuffixed key stays in every catalogue
// as that spare.
//
// en and ru list the same suffixes because the two reference catalogues have to
// match key for key. English only ever selects one or other; its few and many
// strings repeat the plural, so a category it does not use still reads correctly.
//
// A fraction or anything that is not an integer keeps the old lookup. Strings
// such as "Selected: {n}" are not given forms, so they hit the unsuffixed key.

(function initPlural(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZnadaPlural = api;
}(typeof window !== 'undefined' ? window : globalThis, function pluralFactory() {
  function lookup(dict, key) {
    if (!dict || typeof key !== 'string') return undefined;
    const value = key.split('.').reduce((node, part) => (
      node && node[part] != null ? node[part] : undefined
    ), dict);
    return typeof value === 'string' ? value : undefined;
  }

  function integerOrNull(value) {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }

  // params.n always counts. params.count counts only when this string is written
  // with {count}: a stray count on "Selected: {n}" must not switch forms.
  // A present n that is not an integer keeps the old lookup even if count is.
  function pluralNumber(key, params, dict, fallback) {
    if (!params || typeof params !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(params, 'n')) return integerOrNull(params.n);
    if (!Object.prototype.hasOwnProperty.call(params, 'count')) return null;
    const count = integerOrNull(params.count);
    if (count === null) return null;
    const template = lookup(dict, key) || lookup(fallback, key);
    return typeof template === 'string' && template.indexOf('{count}') !== -1 ? count : null;
  }

  // An unknown language tag is not a reason to show the raw key. The caller
  // keeps the unsuffixed string of the current language.
  function category(lang, n) {
    try {
      return new Intl.PluralRules(lang).select(n);
    } catch {
      return null;
    }
  }

  function plain(dict, fallback, key) {
    const own = lookup(dict, key);
    if (own != null) return own;
    return lookup(fallback, key);
  }

  // The catalogue string before {n} and {count} are filled in. undefined means
  // nothing matched, and format() then shows the key, as t() already did.
  function templateFor(key, params, dict, fallback, lang) {
    const n = pluralNumber(key, params, dict, fallback);
    const ownCategory = n !== null && typeof lang === 'string' && lang ? category(lang, n) : null;
    if (n === null || !ownCategory) return plain(dict, fallback, key);
    const englishCategory = category('en', n) || 'other';
    const candidates = [
      [dict, key + '_' + ownCategory],
      [dict, key + '_other'],
      [dict, key],
      [fallback, key + '_' + englishCategory],
      [fallback, key],
    ];
    for (const [source, candidate] of candidates) {
      const value = lookup(source, candidate);
      if (value != null) return value;
    }
    return undefined;
  }

  function format(key, params, dict, fallback, lang) {
    let value = templateFor(key, params, dict, fallback, lang);
    if (value == null) value = key;
    if (params) {
      for (const name in params) value = value.split('{' + name + '}').join(params[name]);
    }
    return value;
  }

  return { templateFor, format };
}));
