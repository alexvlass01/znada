'use strict';

// DESIGN-012. «О программе»: дата выхода версии и окно «Что нового».
//
// Две независимые половины, обе чистые:
//
//   * Текст окна живёт в `src/whats-new.json`: по записи на версию, внутри — список
//     пунктов на каждом языке, для которого он написан. Обязательны `en` и `ru` (как
//     для строк интерфейса); остальные языки по желанию, без них окно показывает
//     английский. Это пользовательский текст, а не release notes для GitHub: внутренние
//     документы в сборку не попадают, поэтому файл отдельный. Подготовка выпуска
//     (`scripts/review-gate.js`) не пускает к проверке версию без своей записи.
//
//   * Дату выхода вшивает ТОЛЬКО официальная сборка: `scripts/package-app.js --official`
//     кладёт рядом с app.asar `release-info.json` = {version, date}. Дата одна у всех,
//     потому что её пишет одна сборка, а не компьютер пользователя; у DEV и обычной
//     сборки файла нет — и даты нет. Метка чужой версии не принимается: дата 1.7.7 под
//     номером 1.8.0 была бы враньём.
//
// Окно само после обновления не открывается (решение владельца) — только по кнопке.
// Файл грузится и через require (main, сборка, гейт, тесты), и тегом <script>
// (renderer), поэтому экспорт двойной, как у next-change.js.

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WhatsNew = api;
})(typeof window !== 'undefined' ? window : null, function factory() {
  const REQUIRED_LANGS = Object.freeze(['en', 'ru']);
  const STAMP_FILE = 'release-info.json';
  const VERSION_RE = /^\d+\.\d+\.\d+$/;
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isItem(item) {
    return isPlainObject(item)
      && typeof item.title === 'string' && item.title.trim() !== ''
      && typeof item.text === 'string' && item.text.trim() !== '';
  }

  // Что не так с файлом целиком — словами, для теста и для гейта. Пустой список = годен.
  function validate(data) {
    if (!isPlainObject(data)) return ['файл должен быть объектом { "<версия>": { "<язык>": [...] } }'];
    const problems = [];
    for (const [version, entry] of Object.entries(data)) {
      if (!VERSION_RE.test(version)) problems.push(`«${version}» — не номер версии`);
      if (!isPlainObject(entry)) { problems.push(`${version}: запись должна быть объектом языков`); continue; }
      for (const [lang, items] of Object.entries(entry)) {
        if (!Array.isArray(items) || !items.length) problems.push(`${version}/${lang}: пустой список`);
        else if (!items.every(isItem)) problems.push(`${version}/${lang}: у пункта нужны непустые title и text`);
      }
    }
    return problems;
  }

  // Чего не хватает версии, которую собираются выпускать.
  function versionGaps(data, version) {
    const entry = isPlainObject(data) ? data[version] : null;
    if (!isPlainObject(entry)) return [`нет записи ${version}`];
    return REQUIRED_LANGS
      .filter((lang) => !Array.isArray(entry[lang]) || !entry[lang].length || !entry[lang].every(isItem))
      .map((lang) => `нет текста ${version} на языке ${lang}`);
  }

  // Пункты для окна: язык интерфейса, иначе английский; null — показывать нечего,
  // и кнопки «Что нового» нет. Плохой пункт выбрасывается, а не ломает окно.
  function pick(data, version, lang) {
    const entry = isPlainObject(data) ? data[version] : null;
    if (!isPlainObject(entry)) return null;
    for (const code of [lang, 'en']) {
      const items = Array.isArray(entry[code]) ? entry[code].filter(isItem) : [];
      if (items.length) return { lang: code, items: items.map(({ title, text }) => ({ title, text })) };
    }
    return null;
  }

  function parseDate(value) {
    const m = DATE_RE.exec(String(value || ''));
    if (!m) return null;
    const [y, mo, d] = m.slice(1).map(Number);
    const date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date;
  }

  // Метка официальной сборки: местный календарный день сборки, без времени и зоны.
  function makeStamp(version, now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return {
      version: String(version),
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    };
  }

  // Дата из метки или null: нет файла, не JSON, чужая версия, не настоящий день.
  function stampDate(raw, version) {
    let stamp;
    try { stamp = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    if (!isPlainObject(stamp) || stamp.version !== version) return null;
    return parseDate(stamp.date) ? stamp.date : null;
  }

  // «10 октября 2026» на языке интерфейса — форматирует сам Intl, переводить нечего.
  function formatDate(value, locale) {
    const date = parseDate(value);
    if (!date) return '';
    try { return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'long' }).format(date); }
    catch { return new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(date); }
  }

  return { REQUIRED_LANGS, STAMP_FILE, validate, versionGaps, pick, makeStamp, stampDate, formatDate };
});
