'use strict';

/**
 * i18n Linter — проверка синхронности файлов переводов с en.json.
 *
 * Языки делятся на два уровня:
 *
 *   CORE_LANGS  — обязательные языки (en, ru).
 *                 ИИ-ассистент ОБЯЗАН переводить новые ключи на них сразу.
 *                 Линтер СТРОГО проверяет их: несовпадение ломает `npm test`.
 *
 *   Всё остальное — дополнительные языки (uk, de, fr, es, zh, ja, …).
 *                 ИИ-ассистент НЕ переводит на них автоматически.
 *                 Переводы добавляются ТОЛЬКО по явному запросу пользователя.
 *                 Пропущенный ключ, пустая строка и неверный тип — мягкое
 *                 предупреждение, сборку не ломает.
 *                 Подстановки уже переведённой строки (`{n}`, `{name}`) сверяются
 *                 с en.json так же строго: опечатка или лишнее имя ломает `npm test`.
 *
 * Чтобы добавить язык в обязательные — добавь код в CORE_LANGS ниже.
 */

const fs = require('fs');
const path = require('path');
const i18nContext = require('../src/i18n-context');
const i18nState = require('../src/i18n-state');

// ── Обязательные языки (AI переводит сразу) ────────────────────────
// `uk` сознательно НЕ входит в CORE: решение владельца 2026-07-27 —
// украинский переводится периодическими проходами, как остальные языки
// уровня 1 и одновременно служит
// пробником качества машинных переводов (владелец знает uk и по нему
// оценивает, что ИИ наделал в языках, которых не понимает). Не возвращать
// `uk` в CORE без нового явного решения владельца.
const CORE_LANGS = ['en', 'ru'];
// ───────────────────────────────────────────────────────────────────

// ── Уровни языков ──────────────────────────────────────────────────────────
// Уровень задаёт ЧАСТОТУ обновления, а не строгость сборки: с 2026-07-27
// `uk` — обычный язык уровня 1 (решение владельца, см. выше). Уровни нужны,
// чтобы в отчёте было видно, какие языки пора обновлять в ближайшем релизе,
// а какие могут подождать.
const TIER_1 = ['uk', 'de', 'fr', 'es', 'pt', 'pl', 'zh', 'ja', 'it', 'tr'];
const tierOf = (lang) => (lang === 'en' || lang === 'ru' ? 0 : TIER_1.includes(lang) ? 1 : 2);
const TIER_LABEL = { 0: 'эталон', 1: 'популярный', 2: 'редкий' };

const defaultLocalesDir = path.join(__dirname, '..', 'locales');

function getParams(str) {
  const matches = str.match(/\{[^}]+\}/g) || [];
  return new Set(matches.map(m => m.slice(1, -1)));
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function lintObject(ref, target, filePath, currentPath = '') {
  let errors = 0;

  // 1. Check for missing keys in target, type mismatches, and parameter mismatches
  for (const key of Object.keys(ref)) {
    const keyPath = currentPath ? `${currentPath}.${key}` : key;
    if (!(key in target)) {
      console.error(`[FAIL] ${filePath}: Missing key "${keyPath}"`);
      errors++;
      continue;
    }

    const refType = typeof ref[key];
    const targetType = typeof target[key];

    if (refType !== targetType) {
      console.error(`[FAIL] ${filePath}: Type mismatch for "${keyPath}" (expected ${refType}, got ${targetType})`);
      errors++;
      continue;
    }

    if (refType === 'object' && ref[key] !== null && target[key] !== null) {
      errors += lintObject(ref[key], target[key], filePath, keyPath);
    } else if (refType === 'string') {
      const refParams = getParams(ref[key]);
      const targetParams = getParams(target[key]);
      if (!setsEqual(refParams, targetParams)) {
        const expected = Array.from(refParams).join(', ');
        const got = Array.from(targetParams).join(', ');
        console.error(`[FAIL] ${filePath}: Parameter mismatch for "${keyPath}" (expected params: {${expected}}, got: {${got}})`);
        errors++;
      }
    }
  }

  // 2. Check for extra/orphaned keys in target
  for (const key of Object.keys(target)) {
    const keyPath = currentPath ? `${currentPath}.${key}` : key;
    if (!(key in ref)) {
      console.error(`[FAIL] ${filePath}: Orphaned key "${keyPath}" (not present in en.json)`);
      errors++;
    }
  }

  return errors;
}

// Placeholder names of a string that is already translated. A missing key, an empty
// string and a wrong type stay a coverage warning: the catalogue is incomplete, and
// I18N-004 must not turn that into a build failure. Order does not matter.
function placeholderMismatches(ref, target, currentPath = '') {
  const found = [];
  if (!ref || typeof ref !== 'object') return found;
  const actual = (target && typeof target === 'object') ? target : {};
  for (const key of Object.keys(ref)) {
    const keyPath = currentPath ? `${currentPath}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(actual, key)) continue;
    const expected = ref[key];
    const got = actual[key];
    if (expected && typeof expected === 'object') {
      if (got && typeof got === 'object') found.push(...placeholderMismatches(expected, got, keyPath));
      continue;
    }
    if (typeof expected !== 'string' || typeof got !== 'string' || got === '') continue;
    const expectedParams = getParams(expected);
    const gotParams = getParams(got);
    if (setsEqual(expectedParams, gotParams)) continue;
    found.push({
      keyPath,
      expected: Array.from(expectedParams).join(', '),
      got: Array.from(gotParams).join(', '),
    });
  }
  return found;
}

/** Count missing keys (flat, recursive) for summary */
function countMissing(ref, target) {
  return i18nState.countMissingLeaves(ref, target);
}

/** Count total leaf keys in ref */
function countKeys(obj) {
  let n = 0;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      n += countKeys(obj[key]);
    } else {
      n++;
    }
  }
  return n;
}

function main(options = {}) {
  const log = options.log || console.log.bind(console);
  const error = options.error || console.error.bind(console);
  const localesDir = options.localesDir || defaultLocalesDir;
  const checkReferences = options.checkReferences !== false;
  const refFile = path.join(localesDir, 'en.json');

  if (!fs.existsSync(refFile)) {
    error('Error: Reference file en.json not found!');
    return 1;
  }

  let refData;
  try {
    refData = JSON.parse(fs.readFileSync(refFile, 'utf8'));
  } catch (e) {
    error('Error parsing en.json:', e.message);
    return 1;
  }

  const targetFiles = fs.readdirSync(localesDir)
    .filter(f => f.endsWith('.json') && f !== 'en.json');

  let hasErrors = false;

  log('Running i18n keys and parameters linter...');
  log(`Reference file: ${refFile}`);
  log(`Core languages: ${CORE_LANGS.join(', ')}\n`);

  const totalKeys = countKeys(refData);
  let extraWarnings = 0;
  // Сколько ключей ждёт работы в языках уровня 1 — тех, что обновляются каждый релиз.
  let tierOneWork = 0;

  function readReference(lang) {
    try { return JSON.parse(fs.readFileSync(path.join(localesDir, `${lang}.json`), 'utf8')); } catch { return {}; }
  }
  function readState(lang) {
    try { return JSON.parse(fs.readFileSync(path.join(localesDir, 'state', `${lang}.json`), 'utf8')); } catch { return null; }
  }

  for (const file of targetFiles) {
    const lang = file.replace('.json', '');
    const isCore = CORE_LANGS.includes(lang);
    const fullPath = path.join(localesDir, file);
    const relativePath = path.relative(path.join(__dirname, '..'), fullPath);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (e) {
      error(`[ERROR] Failed to parse JSON file ${relativePath}: ${e.message}`);
      if (isCore) hasErrors = true;
      continue;
    }

    if (isCore) {
      // ── Обязательный язык: строгая проверка ──
      log(`Linting ${relativePath} (core)...`);
      const errorsCount = lintObject(refData, data, relativePath);
      if (errorsCount > 0) {
        error(`Linting FAILED for ${relativePath} with ${errorsCount} errors.\n`);
        hasErrors = true;
      } else {
        log(`✓ ${relativePath} is in sync with en.json.\n`);
      }
    } else {
      // ── Дополнительный язык: полнота мягкая, подстановки уже переведённого — нет ──
      const missing = countMissing(refData, data);
      const mismatches = placeholderMismatches(refData, data);
      const tier = tierOf(lang);
      // Свежесть важнее полноты: язык может быть переведён на 100% и при этом весь
      // состоять из переводов давно переписанных строк. Отчёт показывает и то, и другое.
      const audit = i18nState.auditLanguage({
        enDict: refData,
        ruDict: readReference('ru'),
        langDict: data,
        lang,
        state: readState(lang),
      });
      const label = `${TIER_LABEL[tier]}, ур. ${tier}`;
      if (missing > 0 || audit.counts.stale > 0) {
        const pct = Math.round(((totalKeys - missing) / totalKeys) * 100);
        const stale = audit.counts.stale > 0 ? `, устарело ${audit.counts.stale}` : '';
        // A missing key is still only a coverage warning. A wrong placeholder in the
        // same file fails the build, so that line must not say the file is safe.
        const coverage = mismatches.length === 0 ? ' — OK, not blocking build' : '';
        log(`⚠ ${relativePath} (${label}): ${missing} missing keys (${pct}% translated)${stale}${coverage}.\n`);
        extraWarnings++;
        if (tier === 1) tierOneWork += audit.needsWork;
      } else if (mismatches.length === 0) {
        log(`✓ ${relativePath} (${label}) is fully in sync with en.json.\n`);
      }
      for (const mismatch of mismatches) {
        error(`[FAIL] ${relativePath}: Parameter mismatch for "${mismatch.keyPath}" (expected params: {${mismatch.expected}}, got: {${mismatch.got}})`);
      }
      if (mismatches.length > 0) {
        error(`Linting FAILED for ${relativePath} with ${mismatches.length} parameter error(s).\n`);
        hasErrors = true;
      }
    }
  }

  // ── Ключи, на которые ссылается код, но которых нет в en.json ───────
  // `tMain`/`t` при отсутствии ключа возвращают САМ КЛЮЧ, и он молча уезжает в интерфейс:
  // заголовок диалога выбора файлов буквально показывал строку «design.addPhotos», потому
  // что ключ когда-то убрали из словарей, а вызов в main.js остался. Переиспользуем
  // scanner I18N-SEM, чтобы граница включала viewer/tray, разные кавычки и HTML-атрибуты,
  // а не расходилась со вторым неполным набором regex.
  if (checkReferences) {
    const contextSources = i18nContext.DEFAULT_SOURCE_FILES.map((relPath) => {
      const file = path.join(__dirname, '..', ...relPath.split('/'));
      if (!fs.existsSync(file)) {
        error(`✗ Не найден production source для i18n-проверки: ${relPath}`);
        hasErrors = true;
        return { file: relPath, content: '' };
      }
      return { file: relPath, content: fs.readFileSync(file, 'utf8') };
    });
    const contextCatalog = i18nContext.buildContextCatalog({
      reference: refData,
      sources: contextSources,
    });
    for (const key of contextCatalog.danglingReferences) {
      error(`✗ ключ "${key}" используется в production-коде, но отсутствует в en.json`);
    }
    if (contextCatalog.danglingReferences.length > 0) {
      error(
        `\ni18n Linting failed: ${contextCatalog.danglingReferences.length} `
        + 'ссыл(ка/ки) на несуществующие ключи.',
      );
      return 1;
    }
  }

  if (hasErrors) {
    error('i18n Linting failed.');
    return 1;
  }
  let msg = 'All core i18n translation files are in sync with en.json!';
  if (extraWarnings > 0) {
    msg += ` (${extraWarnings} extra language(s) need translation or freshness review)`;
  }
  log(msg);
  if (tierOneWork > 0) {
    log(`Уровень 1 (обновляется каждый релиз): ${tierOneWork} ключ(а/ей) ждут работы.`);
    log('Набор для перевода: node scripts/i18n-kit.js <lang> --out kit.json');
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main, placeholderMismatches, getParams };
