#!/usr/bin/env node
'use strict';

/**
 * Translation kit generator.
 *
 *   node scripts/i18n-kit.js de              что нужно перевести/пересмотреть в de
 *   node scripts/i18n-kit.js de --out kit.json   сохранить набор в файл
 *   node scripts/i18n-kit.js de --limit 50   первые N ключей (проход по частям)
 *   node scripts/i18n-kit.js de --all        ВЕСЬ каталог — для сверки, а не перевода
 *
 * `--all` нужен для второй половины цикла. Перевод смотрит только на «к работе»,
 * но сверка обязана видеть и свежие строки: отпечаток доказывает, что перевод сделан
 * с текущего текста, и ничего не говорит о том, хорош ли он. Именно так через
 * `--reviewed` однажды проехали лишний эмодзи и потерянное многоточие.
 *
 * Собирает ровно то, что нужно ИИ-переводчику, и ничего лишнего:
 *   — по умолчанию ТОЛЬКО устаревшие и непереведённые ключи (свежие не трогаем);
 *   — английский (базис) и русский (эталон смысла и тона) как образцы;
 *   — выведенный из кода контекст: что это за элемент, где он живёт, чем управляет;
 *   — глоссарий терминов и правила речи;
 *   — текущий перевод, если он есть и просто устарел.
 *
 * Это и есть ответ на «ИИ должен хорошо понимать, что переводит»: голая строка
 * порождает кальку, строка с ролью и смыслом — живую фразу.
 */

const fs = require('fs');
const path = require('path');
const state = require('../src/i18n-state');

const ROOT = path.join(__dirname, '..');
const LOCALES = path.join(ROOT, 'locales');
const CONTEXT_DIR = path.join(LOCALES, 'context');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--out' || arg === '--limit') { flags[arg.slice(2)] = args[++i]; continue; }
  if (arg === '--all') { flags.all = true; continue; }
  if (arg.startsWith('--')) fail(`Неизвестный параметр: ${arg}`);
  positional.push(arg);
}
if (positional.length !== 1) fail('Укажи ровно один язык: node scripts/i18n-kit.js de');

const lang = positional[0];
if (!/^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(lang)) fail(`Недопустимый код языка: ${lang}`);
if (lang === 'en' || lang === 'ru') fail(`${lang} — эталонный язык, он правится вручную, а не переводится набором.`);

const enDict = readJson(path.join(LOCALES, 'en.json')) || fail('locales/en.json не читается');
const ruDict = readJson(path.join(LOCALES, 'ru.json')) || fail('locales/ru.json не читается');
const langDict = readJson(path.join(LOCALES, `${lang}.json`));
if (!langDict) fail(`locales/${lang}.json не читается — сначала создай файл языка (можно пустой {}).`);

const context = readJson(path.join(CONTEXT_DIR, 'generated.json'));
if (!context) fail('Нет locales/context/generated.json — сначала: node scripts/i18n-context.js write');
const manual = readJson(path.join(CONTEXT_DIR, 'manual.json')) || {};
const glossary = readJson(path.join(CONTEXT_DIR, 'glossary.json'));
if (!glossary) fail('Нет locales/context/glossary.json');

const audit = state.auditLanguage({
  enDict, ruDict, langDict, lang, state: readJson(path.join(LOCALES, 'state', `${lang}.json`)),
});
// Сверка идёт по ВСЕМУ каталогу в порядке эталона: соседние ключи — обычно соседние
// элементы одного экрана, и разнобой между ними виден только рядом.
let keys = flags.all
  ? Object.keys(state.flatten(enDict))
  : state.keysNeedingWork(audit);
const limit = flags.limit ? Number(flags.limit) : 0;
if (limit > 0) keys = keys.slice(0, limit);

const en = state.flatten(enDict);
const ru = state.flatten(ruDict);
const current = state.flatten(langDict);
// Файл ручного контекста хранит записи в keys (схема Codex); entries — на случай старой формы.
const manualEntries = (manual && (manual.keys || manual.entries)) || {};

// Контекст — самое ценное для переводчика, но он многословен: оставляем роль,
// место и «через что», а координаты файла в набор не тащим.
function contextFor(key) {
  const entry = (context.entries || {})[key];
  const contexts = ((entry && entry.contexts) || []).map((c) => ({
    type: c.type,
    area: c.area,
    ...(c.function ? { where: c.function } : {}),
    ...(c.element ? { element: c.element } : {}),
  }));
  const seen = new Set();
  const unique = contexts.filter((c) => {
    const id = JSON.stringify(c);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const note = manualEntries[key] && manualEntries[key].note;
  return { ...(unique.length ? { usedAs: unique } : {}), ...(note ? { note } : {}) };
}

const items = keys.map((key) => ({
  key,
  status: audit.byKey[key],
  en: en[key],
  ru: ru[key],
  // Не называем это «устаревшим»: при статусе unverified перевод может быть верным,
  // мы лишь не можем этого доказать. Что с ним не так — говорит status.
  ...(typeof current[key] === 'string' && current[key] ? { currentTranslation: current[key] } : {}),
  ...contextFor(key),
}));

const kit = {
  language: lang,
  generatedAt: new Date().toISOString(),
  task: flags.all
    ? 'СВЕРКА, не перевод. Прочитай каждую строку так, как её увидит носитель языка в живом интерфейсе, и найди то, что автопроверки не ловят: кальку с английского вместо родной формулировки, неверный смысл, чужой регистр и тон, потерянную или лишнюю типографику (многоточие «…» значит «откроется диалог»), лишние эмодзи, термин не по глоссарию, форму слова не по роли элемента (кнопка — действие, заголовок — существительное). Верни JSON только с теми ключами, которые надо ИСПРАВИТЬ, вида {"ключ": "новый перевод"}. Строку, которая хороша, не трогай.'
    : 'Переведи строки интерфейса Znada на указанный язык. Английский — технический базис, русский — эталон смысла и тона. Переводи СМЫСЛ так, как это сказал бы носитель языка в родном интерфейсе, а не слово в слово. Соблюдай правила из style и глоссарий из terms. Строки со статусом stale уже переведены, но исходный текст с тех пор изменился — перепиши их под новый смысл. Верни JSON вида {"ключ": "перевод"} без пояснений.',
  references: glossary.references,
  style: glossary.style,
  terms: glossary.terms,
  totals: {
    keysInApp: audit.total,
    needsWork: audit.needsWork,
    inThisKit: items.length,
    byStatus: {
      missing: items.filter((i) => i.status === 'missing').length,
      stale: items.filter((i) => i.status === 'stale').length,
      unverified: items.filter((i) => i.status === 'unverified').length,
    },
  },
  items,
};

if (flags.out) {
  const out = path.resolve(ROOT, flags.out);
  fs.writeFileSync(out, `${JSON.stringify(kit, null, 2)}\n`, 'utf8');
  console.log(`Набор для ${lang}: ${items.length} ключ(а/ей) → ${path.relative(ROOT, out)}`);
  if (flags.all) {
    console.log('  Режим сверки: весь каталог, включая свежие строки.');
    console.log(`  После настоящей сверки: node scripts/i18n-state.js baseline ${lang} --reviewed`);
  } else {
    console.log(`  нет перевода ${kit.totals.byStatus.missing}, устарело ${kit.totals.byStatus.stale}, не сверено ${kit.totals.byStatus.unverified}`);
    console.log(`  Перевод без сверки закрепляется как: node scripts/i18n-state.js baseline ${lang} --mechanical`);
  }
} else {
  process.stdout.write(`${JSON.stringify(kit, null, 2)}\n`);
}
