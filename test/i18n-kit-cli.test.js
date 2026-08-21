'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'i18n-kit.js');
let passed = 0;

function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  OK ${name}`);
  passed++;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
}

// Pinning a language here was a mistake: the test used de and expected pending work,
// then de got fully translated and verified, so the payload legitimately became empty.
// Pick whichever tier-1 language still has work, and skip the payload assertions
// honestly if every language is done rather than inventing a failure.
const fs = require('fs');
const state = require('../src/i18n-state');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const enDict = readJson('locales', 'en.json');
const ruDict = readJson('locales', 'ru.json');
const pendingLang = ['fr', 'es', 'pt', 'pl', 'zh', 'ja', 'it', 'tr', 'de', 'uk'].find((lang) => {
  let langDict; let langState = null;
  try { langDict = readJson('locales', `${lang}.json`); } catch { return false; }
  try { langState = readJson('locales', 'state', `${lang}.json`); } catch { langState = null; }
  return state.auditLanguage({ enDict, ruDict, langDict, lang, state: langState }).needsWork > 0;
});

if (!pendingLang) {
  console.log('  SKIP payload checks — every tier-1 language is fully verified');
} else {
  const res = run([pendingLang, '--limit', '5']);
  let kit = null;
  try { kit = JSON.parse(res.stdout); } catch { kit = null; }
  ok('kit for a real language is valid JSON', res.status === 0 && kit !== null);
  ok('kit carries the task, both references, style rules and the glossary', Boolean(
    kit && kit.task && kit.references && kit.references.ru && kit.references.en
    && kit.style && kit.style.button && Array.isArray(kit.terms) && kit.terms.length > 5,
  ));
  ok('the removal rule travels with every kit', Boolean(
    kit && kit.terms.some((t) => /remove/i.test(t.en) && t.doesNotMean && t.avoid),
  ));
  // A language may legitimately have fewer than five keys left, so bound rather than pin.
  ok('--limit bounds the payload', Boolean(
    kit && kit.items.length > 0 && kit.items.length <= 5 && kit.totals.inThisKit === kit.items.length,
  ));
  ok('every item gives the translator base, reference and status', Boolean(
    kit && kit.items.every((i) => i.key && typeof i.en === 'string' && typeof i.ru === 'string' && i.status),
  ));
  ok('items are limited to work that is actually needed', Boolean(
    kit && kit.items.every((i) => ['missing', 'stale', 'unverified'].includes(i.status)),
  ));
  ok('at least one item explains where the string is used', Boolean(
    kit && kit.items.some((i) => Array.isArray(i.usedAs) && i.usedAs.length && i.usedAs[0].type),
  ));
  // "outdated" would be a lie for an unverified string: it may well be correct.
  // Only meaningful when the picked language actually has previous translations.
  const hasPrevious = Boolean(kit && kit.items.some((i) => typeof i.currentTranslation === 'string'));
  ok('an existing translation is passed without calling it outdated', Boolean(
    kit && (!hasPrevious || JSON.stringify(kit.items).includes('currentTranslation'))
    && !JSON.stringify(kit.items).includes('currentOutdated'),
  ));
}

// Review mode. The default kit hides everything already fresh, which is right for
// translating and wrong for checking: a fingerprint proves a translation was made from
// today's source, not that it is any good. So --all has to hand over the whole catalogue
// with the current text attached, or a review pass has nothing to read.
{
  const res = run(['fr', '--all']);
  let kit = null;
  try { kit = JSON.parse(res.stdout); } catch { kit = null; }
  ok('--all returns every key the reference defines', Boolean(
    kit && kit.items.length === kit.totals.keysInApp && kit.items.length > 300,
  ));
  ok('--all keeps fresh keys, which the default kit drops', Boolean(
    kit && kit.items.some((i) => i.status === 'fresh'),
  ));
  ok('--all carries the existing translation to be judged', Boolean(
    kit && kit.items.filter((i) => typeof i.currentTranslation === 'string').length > 300,
  ));
  ok('--all asks for a review and not for a fresh translation', Boolean(
    kit && /СВЕРКА/.test(kit.task) && /ИСПРАВИТЬ/.test(kit.task),
  ));
  ok('--all still respects --limit for a pass in parts', Boolean(
    (() => { const r = run(['fr', '--all', '--limit', '7']);
      try { return JSON.parse(r.stdout).items.length === 7; } catch { return false; } })(),
  ));
}

{
  const res = run(['ru']);
  ok('reference languages are refused: they are edited by hand, not translated',
    res.status !== 0 && /эталон/i.test(res.stderr));
}

{
  const res = run(['de', 'fr']);
  ok('exactly one language is required', res.status !== 0);
}

{
  const res = run(['../evil']);
  ok('a path-like language code is rejected', res.status !== 0);
}

{
  const res = run(['de', '--bogus']);
  ok('unknown flags are rejected instead of silently ignored', res.status !== 0 && /Неизвестный параметр/.test(res.stderr));
}

console.log('\nAll ' + passed + ' i18n-kit CLI tests passed.');
