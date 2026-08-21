#!/usr/bin/env node
'use strict';

/**
 * Translation freshness state and reporting CLI.
 *
 *   node scripts/i18n-state.js report            состояние всех языков
 *   node scripts/i18n-state.js report de fr      только указанные
 *   node scripts/i18n-state.js keys de           что именно нужно перевести/пересмотреть
 *   node scripts/i18n-state.js baseline de --reviewed
 *                                                зафиксировать реально сверенный перевод
 *
 * Отпечаток берётся с ПАРЫ en+ru: английский — технический базис, русский — эталон
 * смысла и тона, поэтому изменение любого из них требует пересмотра перевода.
 *
 * Состояние живёт в locales/state/<lang>.json — это sidecar, приложение его не читает
 * и в сборку он не попадает (см. ignore-список `npm run package`).
 */

const fs = require('fs');
const path = require('path');
const state = require('../src/i18n-state');

const ROOT = path.join(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'locales');
const STATE_DIR = path.join(LOCALES_DIR, 'state');

// Уровень 0 — эталон, правится руками;
// 1 — популярные, обновляются каждый релиз; 2 — остальные, реже.
const TIERS = {
  0: ['en', 'ru'],
  1: ['uk', 'de', 'fr', 'es', 'pt', 'pl', 'zh', 'ja', 'it', 'tr'],
};
const LEVEL = { reference: 'эталон', reviewed: 'сверено', mechanical: 'механика' };
const tierOf = (lang) => (TIERS[0].includes(lang) ? 0 : TIERS[1].includes(lang) ? 1 : 2);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function localeCodes() {
  return fs.readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'))
    .sort();
}

function loadSources() {
  const enDict = readJson(path.join(LOCALES_DIR, 'en.json'));
  const ruDict = readJson(path.join(LOCALES_DIR, 'ru.json'));
  if (!enDict) { console.error('locales/en.json не читается — без него состояние не посчитать.'); process.exit(1); }
  if (!ruDict) { console.error('locales/ru.json не читается — отпечаток обязан учитывать en + ru.'); process.exit(1); }
  const en = state.flatten(enDict);
  const ru = state.flatten(ruDict);
  const invalidRu = Object.keys(en).filter((key) => typeof ru[key] !== 'string');
  if (invalidRu.length) {
    console.error(
      `locales/ru.json не содержит ${invalidRu.length} строк(и) из en.json; `
      + 'неполный эталон нельзя использовать для baseline.',
    );
    process.exit(1);
  }
  return { enDict, ruDict };
}

function statePath(lang) {
  const file = path.resolve(STATE_DIR, `${lang}.json`);
  if (path.dirname(file) !== path.resolve(STATE_DIR)) {
    throw new Error(`Недопустимый код языка: ${lang}`);
  }
  return file;
}

function validateLangs(langs, { allowEmpty = false } = {}) {
  if (!langs.length && allowEmpty) return [];
  if (!langs.length) {
    console.error('Укажи язык.');
    process.exit(1);
  }
  const available = new Set(localeCodes());
  const invalid = langs.filter((lang) => !/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(lang) || !available.has(lang));
  if (invalid.length) {
    console.error(`Неизвестный или недопустимый язык: ${invalid.join(', ')}`);
    process.exit(1);
  }
  return langs;
}

function loadLanguage(lang) {
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  const langDict = readJson(file);
  if (!langDict) {
    console.error(`locales/${lang}.json не читается — команда не выполнена.`);
    process.exit(1);
  }
  return langDict;
}

function auditOne(lang, sources) {
  const langDict = loadLanguage(lang);
  return state.auditLanguage({ ...sources, langDict, state: readJson(statePath(lang)), lang });
}

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

function cmdReport(langs) {
  const sources = loadSources();
  const codes = langs.length ? validateLangs(langs) : localeCodes();
  const rows = [];
  for (const lang of codes) {
    const audit = auditOne(lang, sources);
    rows.push({ lang, tier: tierOf(lang), ...audit });
  }
  rows.sort((a, b) => a.tier - b.tier || b.needsWork - a.needsWork || a.lang.localeCompare(b.lang));

  const total = rows.length ? rows[0].total : 0;
  console.log(`\nСостояние переводов — ${total} ключей, ${rows.length} языков`);
  console.log('Эталон: en (технический базис) + ru (смысл и тон)\n');
  console.log(`  ${pad('язык', 6)}${pad('ур.', 5)}${padL('свежих', 8)}${padL('устар.', 8)}${padL('не свер.', 10)}${padL('нет', 6)}${padL('к работе', 10)}   основание`);
  console.log(`  ${'-'.repeat(68)}`);

  let lastTier = -1;
  for (const r of rows) {
    if (r.tier !== lastTier) { lastTier = r.tier; }
    const c = r.counts;
    console.log(
      `  ${pad(r.lang, 6)}${pad(r.tier, 5)}${padL(c.fresh, 8)}${padL(c.stale, 8)}${padL(c.unverified, 10)}${padL(c.missing, 6)}${padL(r.needsWork, 10)}   ${LEVEL[r.verification] || '—'}`,
    );
  }

  const byTier = (t) => rows.filter((r) => r.tier === t);
  console.log('');
  for (const t of [0, 1, 2]) {
    const group = byTier(t);
    if (!group.length) continue;
    const work = group.reduce((n, r) => n + r.needsWork, 0);
    const fresh = group.reduce((n, r) => n + r.counts.fresh, 0);
    const label = t === 0 ? 'эталон' : t === 1 ? 'популярные' : 'остальные';
    console.log(`  Уровень ${t} (${label}): ${group.length} яз., подтверждённо свежих ключей ${fresh}, к работе ${work}`);
  }
  const unverified = rows.reduce((n, r) => n + r.counts.unverified, 0);
  if (unverified > 0) {
    console.log(`\n  «не сверено» = перевод есть, но нет доказательства, что он сделан с текущего текста.`);
    console.log(`  Это честное «неизвестно», а не «плохо». После реального прохода: node scripts/i18n-state.js baseline <lang> --reviewed`);
  }
  console.log('');
}

function cmdKeys(langs) {
  validateLangs(langs);
  const sources = loadSources();
  for (const lang of langs) {
    const audit = auditOne(lang, sources);
    const keys = state.keysNeedingWork(audit);
    console.log(`\n${lang}: к работе ${keys.length} из ${audit.total}`);
    for (const key of keys) console.log(`  ${pad(audit.byKey[key], 12)}${key}`);
  }
  console.log('');
}

function cmdBaseline(langs, { reviewed = false, mechanical = false } = {}) {
  validateLangs(langs);
  const nonReference = langs.filter((lang) => lang !== 'en' && lang !== 'ru');
  if (nonReference.length && !reviewed && !mechanical) {
    console.error(
      `Нельзя объявить ${nonReference.join(', ')} свежим без указания основания.\n`
      + '  --reviewed    перевод сверил тот, кто читает этот язык\n'
      + '  --mechanical  прошли только автопроверки (подстановки, термины, многоточия)',
    );
    process.exit(1);
  }
  const sources = loadSources();
  const dictionaries = new Map(langs.map((lang) => [lang, loadLanguage(lang)]));
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const lang of langs) {
    const langDict = dictionaries.get(lang);
    const verification = reviewed ? state.VERIFICATION.REVIEWED : state.VERIFICATION.MECHANICAL;
    const next = state.buildState({ ...sources, langDict, lang, verification });
    fs.writeFileSync(statePath(lang), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`✓ ${lang}: ${Object.keys(next.keys).length} ключей, основание: ${LEVEL[next.verification]}`);
  }
}

const [command, ...rawArgs] = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--reviewed', '--mechanical']);
const unknownFlags = rawArgs.filter((arg) => arg.startsWith('--') && !KNOWN_FLAGS.has(arg));
if (unknownFlags.length) {
  console.error(`Неизвестный параметр: ${unknownFlags.join(', ')}`);
  process.exit(1);
}
const reviewed = rawArgs.includes('--reviewed');
const mechanical = rawArgs.includes('--mechanical');
if (reviewed && mechanical) { console.error('Укажи одно основание: --reviewed или --mechanical.'); process.exit(1); }
const args = rawArgs.filter((arg) => !arg.startsWith('--'));
if ((reviewed || mechanical) && command !== 'baseline') {
  console.error('Основание (--reviewed/--mechanical) допустимо только для команды baseline.');
  process.exit(1);
}
switch (command) {
  case 'report': case undefined: cmdReport(args); break;
  case 'keys': cmdKeys(args); break;
  case 'baseline': cmdBaseline(args, { reviewed, mechanical }); break;
  default:
    console.error(`Неизвестная команда: ${command}\n  report [langs…] | keys <lang> | baseline <lang> [--reviewed]`);
    process.exit(1);
}
