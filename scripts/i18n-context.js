#!/usr/bin/env node
'use strict';

/**
 * I18N-SEM step 2 — deterministic context derived from production UI code.
 *
 *   node scripts/i18n-context.js report
 *   node scripts/i18n-context.js write
 *   node scripts/i18n-context.js check
 *   node scripts/i18n-context.js show library.addPhotos
 *
 * The generated artifact is maintenance input for translation tooling. Lumina does
 * not read it at runtime, and package.json excludes the whole locales/context folder.
 */

const fs = require('fs');
const path = require('path');
const context = require('../src/i18n-context');

const ROOT = path.join(__dirname, '..');
const EN_FILE = path.join(ROOT, 'locales', 'en.json');
const OUTPUT_FILE = path.join(ROOT, 'locales', 'context', 'generated.json');
const MANUAL_FILE = path.join(ROOT, 'locales', 'context', 'manual.json');
const MIN_COVERAGE_PCT = 80;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Не удалось прочитать ${path.relative(ROOT, file)}: ${error.message}`);
    process.exit(1);
  }
}

function loadInputs() {
  const reference = readJson(EN_FILE);
  const manual = readJson(MANUAL_FILE);
  const sources = context.DEFAULT_SOURCE_FILES.map((file) => {
    const absolute = path.join(ROOT, ...file.split('/'));
    if (!fs.existsSync(absolute)) {
      console.error(`Не найден production source: ${file}`);
      process.exit(1);
    }
    return { file, content: fs.readFileSync(absolute, 'utf8') };
  });
  return {
    reference,
    manual,
    catalog: context.buildContextCatalog({ reference, sources }),
  };
}

function printReport(catalog, manual) {
  const stats = catalog.stats;
  console.log(
    `Контекст переводов: ${stats.contextualized}/${stats.total} ключей `
    + `(${stats.coveragePct}%), без автоконтекста ${stats.unresolved}.`,
  );
  console.log(`Источники: ${catalog.sources.join(', ')}`);
  if (catalog.danglingReferences.length) {
    console.log(`Ссылки без ключа en.json: ${catalog.danglingReferences.join(', ')}`);
  }
  if (catalog.unresolved.length) {
    const byNamespace = {};
    for (const key of catalog.unresolved) {
      const namespace = key.split('.')[0];
      byNamespace[namespace] = (byNamespace[namespace] || 0) + 1;
    }
    const summary = Object.entries(byNamespace)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name}:${count}`)
      .join(', ');
    console.log(`Остаток по разделам: ${summary}`);
  }
  const manualKeys = Object.keys((manual && manual.keys) || {});
  const combined = context.combinedCoverage(catalog, manual);
  console.log(
    `Ручной sidecar: ${manualKeys.length} ключ(а/ей); `
    + `итоговое покрытие ${combined.contextualized}/${combined.total} (${combined.coveragePct}%).`,
  );
}

function assertHealthy(catalog, manual, reference) {
  const manualErrors = context.validateManualCatalog(manual, reference);
  if (manualErrors.length) {
    for (const error of manualErrors) console.error(`Некорректный manual context: ${error}`);
    return false;
  }
  if (catalog.danglingReferences.length) {
    console.error(`Найдены ссылки на отсутствующие ключи: ${catalog.danglingReferences.join(', ')}`);
    return false;
  }
  if (catalog.stats.coveragePct < MIN_COVERAGE_PCT) {
    console.error(
      `Автоконтекст покрывает ${catalog.stats.coveragePct}% — ниже контракта ${MIN_COVERAGE_PCT}%.`,
    );
    return false;
  }
  return true;
}

const [command = 'report', ...args] = process.argv.slice(2);
if (command === 'show' ? args.length !== 1 : args.length !== 0) {
  console.error(`Неверные аргументы.\n  report | write | check | show <key>`);
  process.exit(1);
}
const { reference, manual, catalog } = loadInputs();

switch (command) {
  case 'report':
    if (!assertHealthy(catalog, manual, reference)) process.exit(1);
    printReport(catalog, manual);
    break;
  case 'write':
    if (!assertHealthy(catalog, manual, reference)) process.exit(1);
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, context.stableJson(catalog), 'utf8');
    printReport(catalog, manual);
    console.log(`Записано: ${path.relative(ROOT, OUTPUT_FILE)}`);
    break;
  case 'check': {
    if (!assertHealthy(catalog, manual, reference)) process.exit(1);
    const expected = context.stableJson(catalog);
    const actual = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
    if (context.normalizeEol(actual) !== expected) {
      console.error('Производный context-артефакт отсутствует или устарел.');
      console.error('Обнови: node scripts/i18n-context.js write');
      process.exit(1);
    }
    printReport(catalog, manual);
    console.log('Context-артефакт актуален.');
    break;
  }
  case 'show': {
    const key = args[0];
    if (!key || !Object.prototype.hasOwnProperty.call(catalog.entries, key)) {
      console.error(`Неизвестный ключ: ${key || '(не указан)'}`);
      process.exit(1);
    }
    console.log(context.stableJson({
      key,
      autoContexts: catalog.entries[key].contexts,
      manual: context.manualEntry(manual, key),
    }).trimEnd());
    break;
  }
  default:
    console.error(`Неизвестная команда: ${command}\n  report | write | check | show <key>`);
    process.exit(1);
}
