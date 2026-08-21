'use strict';

// Translation freshness accounting shared by the maintenance CLI and tests.
//
// The i18n linter only knows whether a key EXISTS. It cannot see that a translation
// went stale: rewording an English string leaves every other language holding a
// translation of the old text while still reporting "100% translated". That makes
// "refresh the popular languages every release" impossible — nothing knows what
// changed, so every pass would have to redo the whole language.
//
// So we record, per language and key, a fingerprint of the SOURCE strings the
// translation was made from. Comparing it with today's sources yields an honest
// status. Русский — эталон смысла и тона, английский — технический базис, поэтому
// отпечаток берётся с ПАРЫ значений: изменение любого из них требует пересмотра.
//
// Pure module: no filesystem here. Callers load the dictionaries and pass them in.

const crypto = require('crypto');

const STATUS = {
  FRESH: 'fresh',             // fingerprint matches the current sources
  STALE: 'stale',             // sources changed after this translation was recorded
  UNVERIFIED: 'unverified',   // translated, but we have no record of the source it came from
  MISSING: 'missing',         // key absent in this language
  ORPHAN: 'orphan',           // language has a key the reference no longer defines
};

// Flatten a nested dictionary into "a.b.c" -> string. Arrays are descended into by
// index ("smart.tips.0"), because Znada translates list content too (the Home tips)
// and each entry has to be trackable on its own. Non-string leaves are kept as their
// raw value so a type mismatch is still visible to the caller.
function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

// Short, stable fingerprint of the source pair. Truncated to 12 hex chars: collisions
// are irrelevant here (we compare a known key against its own previous value) and a
// short string keeps the state files readable in a diff.
function fingerprint(enValue, ruValue) {
  const payload = JSON.stringify([
    typeof enValue === 'string' ? enValue : null,
    typeof ruValue === 'string' ? ruValue : null,
  ]);
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 12);
}

// A verified entry must be bound to the translation as well as to its sources.
// Otherwise any later edit of the target string (including accidental garbage)
// would still report as fresh. Include the language code too, so copying a state
// file from one locale to another cannot manufacture a false fresh result.
function translationFingerprint(lang, value) {
  const payload = JSON.stringify([
    typeof lang === 'string' ? lang : '',
    typeof value === 'string' ? value : null,
  ]);
  return crypto.createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, 12);
}

function encodeRecord(sourceHash, translationHash) {
  return `${sourceHash}:${translationHash}`;
}

function decodeRecord(record) {
  if (typeof record !== 'string') return null;
  const match = /^([0-9a-f]{12}):([0-9a-f]{12})$/.exec(record);
  if (match) return { sourceHash: match[1], translationHash: match[2], legacy: false };
  if (/^[0-9a-f]{12}$/.test(record)) {
    return { sourceHash: record, translationHash: '', legacy: true };
  }
  return null;
}

// Build the fingerprint map for every key the reference defines.
function sourceFingerprints(enDict, ruDict) {
  const en = flatten(enDict);
  const ru = flatten(ruDict);
  const out = {};
  for (const key of Object.keys(en)) out[key] = fingerprint(en[key], ru[key]);
  return out;
}

/**
 * Compare one language against the current sources.
 * @param {object} opts.enDict   reference dictionary (defines the key set)
 * @param {object} opts.ruDict   meaning/tone reference
 * @param {object} opts.langDict the language being audited
 * @param {string} opts.lang     language code being audited
 * @param {object} opts.state    previously recorded state file
 * @returns {{ byKey: object, counts: object, total: number, translatedPct: number, freshPct: number }}
 */
function auditLanguage({ enDict, ruDict, langDict, state, lang } = {}) {
  const sources = sourceFingerprints(enDict, ruDict);
  const translations = flatten(langDict);
  const recorded = (state && typeof state === 'object' && state.keys && typeof state.keys === 'object')
    ? state.keys
    : (state && typeof state === 'object' ? state : {});
  const expectedLang = typeof lang === 'string' ? lang : '';
  const wrongLanguage = Boolean(
    state
    && state.keys
    && (
      !expectedLang
      || typeof state.lang !== 'string'
      || !state.lang
      || state.lang !== expectedLang
    ),
  );

  const byKey = {};
  const counts = {
    [STATUS.FRESH]: 0,
    [STATUS.STALE]: 0,
    [STATUS.UNVERIFIED]: 0,
    [STATUS.MISSING]: 0,
    [STATUS.ORPHAN]: 0,
  };

  for (const [key, sourceHash] of Object.entries(sources)) {
    let status;
    const value = translations[key];
    const record = decodeRecord(recorded[key]);
    if (typeof value !== 'string' || value === '') status = STATUS.MISSING;
    else if (wrongLanguage || !record) status = STATUS.UNVERIFIED;
    else if (record.sourceHash !== sourceHash) status = STATUS.STALE;
    // Legacy v1 records only contain the source hash. They remain useful for
    // detecting a stale source, but cannot honestly prove the target text fresh.
    else if (record.legacy) status = STATUS.UNVERIFIED;
    else if (record.translationHash !== translationFingerprint(expectedLang, value)) status = STATUS.UNVERIFIED;
    else status = STATUS.FRESH;
    byKey[key] = status;
    counts[status]++;
  }

  // Keys the language still carries after the reference dropped them.
  for (const key of Object.keys(translations)) {
    if (key in sources) continue;
    byKey[key] = STATUS.ORPHAN;
    counts[STATUS.ORPHAN]++;
  }

  const total = Object.keys(sources).length;
  const translated = total - counts[STATUS.MISSING];
  const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 100);
  return {
    byKey,
    counts,
    total,
    // On what basis the fresh keys are fresh — see VERIFICATION. Absent state means
    // nobody has vouched for this language at all.
    verification: state && state.keys && !wrongLanguage
      ? normalizeVerification(state.verification, expectedLang) : null,
    translatedPct: pct(translated),
    freshPct: pct(counts[STATUS.FRESH]),
    // What an update pass actually has to touch.
    needsWork: counts[STATUS.STALE] + counts[STATUS.MISSING] + counts[STATUS.UNVERIFIED],
  };
}

// Record the language's current translations as verified against today's sources.
// Only keys that are actually translated are recorded — baselining a missing key
// would claim work that was never done.
// Freshness and confidence are different questions. The fingerprint proves a
// translation was made from today's source; it says nothing about whether anyone who
// reads the language ever looked at it. Recording only "verified" let a batch that
// merely passed the linter claim the same standing as a language someone actually
// reviewed — and two real defects (a stray emoji, a dropped ellipsis) survived exactly
// that claim. So the basis is stored alongside the keys and reported separately.
const VERIFICATION = {
  REFERENCE: 'reference',   // en/ru: hand-maintained sources, not translations
  REVIEWED: 'reviewed',     // someone who reads the language checked it
  MECHANICAL: 'mechanical', // automated checks only: placeholders, terms, ellipses
};

function normalizeVerification(value, lang) {
  if (lang === 'en' || lang === 'ru') return VERIFICATION.REFERENCE;
  return value === VERIFICATION.REVIEWED ? VERIFICATION.REVIEWED : VERIFICATION.MECHANICAL;
}

function buildState({ enDict, ruDict, langDict, lang, at, verification } = {}) {
  const sources = sourceFingerprints(enDict, ruDict);
  const translated = flatten(langDict);
  const keys = {};
  for (const [key, hash] of Object.entries(sources)) {
    if (typeof translated[key] === 'string' && translated[key] !== '') {
      keys[key] = encodeRecord(hash, translationFingerprint(lang, translated[key]));
    }
  }
  return {
    version: 2,
    lang: lang || '',
    verification: normalizeVerification(verification, lang),
    verifiedAt: at || new Date().toISOString(),
    keys,
  };
}

// Strings a language left in English.
//
// This is the one defect class every other check is blind to. A missing key falls back
// visibly and the linter reports it; English *committed as the translation* looks
// complete to every completeness check, matches its own fingerprint, and still shows
// Latin text to a Greek or Arabic reader. The release gate caught it twice: an English
// Online-search placeholder in 19 catalogues, and "remove from library" — the costliest
// string in the app — sitting untranslated in six.
//
// Comparison is case-insensitive on purpose: the six broken values were lowercase, so
// they did not even match English exactly.
//
// Plenty of matches are legitimate — brand names, loanwords, and words a language
// genuinely shares with English ("Monitor", "Internet", "Position" in German). Those
// belong in `allow`, keyed by string, so the report stays worth reading. Short values
// are skipped because single letters and units collide by nature.
function sameAsEnglish(enDict, langDict, { allow = [], minLength = 4 } = {}) {
  const en = flatten(enDict);
  const target = flatten(langDict);
  const allowed = new Set(allow);
  const out = [];
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string' || value.length < minLength) continue;
    if (allowed.has(key)) continue;
    const got = target[key];
    if (typeof got !== 'string') continue;
    if (got.toLowerCase() === value.toLowerCase()) out.push({ key, en: value, value: got });
  }
  return out;
}

// The same leak wearing a disguise: a value copied from a DIFFERENT English key.
//
// sameAsEnglish cannot see this one, because the string does not match the English of
// its own key. The release gate found five catalogues whose local Library search box
// held the Online booru prompt — `library.searchPh` carrying English `online.searchPh`.
// Key counts, placeholders and fingerprints were all satisfied; the user just saw the
// wrong prompt, in the wrong language, on the wrong screen.
//
// Coincidences exist (Indonesian "Folder", Romanian "Favorite" are simply those words),
// so this reports rather than judges.
function borrowedFromEnglishKey(enDict, langDict, { minLength = 4 } = {}) {
  const en = flatten(enDict);
  const target = flatten(langDict);
  const owners = new Map();
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string' || value.length < minLength) continue;
    const k = value.toLowerCase();
    if (!owners.has(k)) owners.set(k, []);
    owners.get(k).push(key);
  }
  const out = [];
  for (const [key, value] of Object.entries(target)) {
    if (typeof value !== 'string' || value.length < minLength) continue;
    const from = owners.get(value.toLowerCase());
    if (from && !from.includes(key)) out.push({ key, value, englishKeys: from.slice() });
  }
  return out;
}

// Keys an update pass must send to the translator, in reference order.
function keysNeedingWork(audit) {
  if (!audit || !audit.byKey) return [];
  return Object.entries(audit.byKey)
    .filter(([, status]) => status === STATUS.STALE || status === STATUS.MISSING || status === STATUS.UNVERIFIED)
    .map(([key]) => key);
}

// Leaf-accurate coverage for the legacy linter summary. A wholly absent or
// wrong-type subtree must count every missing string, not one parent property.
function countMissingLeaves(reference, target) {
  const expected = flatten(reference);
  const actual = flatten(target);
  let missing = 0;
  for (const [key, value] of Object.entries(expected)) {
    if (
      typeof actual[key] !== typeof value
      || (typeof value === 'string' && actual[key] === '')
    ) missing++;
  }
  return missing;
}

module.exports = {
  STATUS,
  VERIFICATION,
  normalizeVerification,
  flatten,
  fingerprint,
  translationFingerprint,
  encodeRecord,
  decodeRecord,
  sourceFingerprints,
  sameAsEnglish,
  borrowedFromEnglishKey,
  auditLanguage,
  buildState,
  keysNeedingWork,
  countMissingLeaves,
};
