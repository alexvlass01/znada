'use strict';

// HOME-001: живой отсчёт до следующей интервальной смены обоев.
//
// Главное, что здесь проверяется, — не форматирование, а ЗАПРЕТ обещать время там,
// где его нет: игровой режим и ожидание «невидимой смены» ждут внешнего события, а
// не таймера. Отдельно проверяется, что каждый выдаваемый ключ реально существует в
// обоих эталонных словарях с теми же placeholders — иначе интерфейс покажет сырой ключ.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const nextChange = require('../src/next-change');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function ok(name, fn) {
  fn();
  console.log(`  OK ${name}`);
  passed++;
}

const NOW = 1_700_000_000_000;
const on = (extra) => ({ slideshowEnabled: true, intervalEnabled: true, ...extra });

// ── describe(): какое состояние вообще разрешено показать ────────────────────

ok('slideshow off → карточка не про смену обоев', () => {
  assert.deepStrictEqual(nextChange.describe({ slideshowEnabled: false, dueAt: NOW + 60000 }), { kind: 'off' });
});

ok('интервальный триггер выключен → отдельная честная подпись про события', () => {
  assert.deepStrictEqual(
    nextChange.describe({ slideshowEnabled: true, intervalEnabled: false, dueAt: NOW + 60000 }),
    { kind: 'events' },
  );
});

ok('взведённый таймер отдаёт абсолютный момент, а не посчитанный остаток', () => {
  assert.deepStrictEqual(nextChange.describe(on({ dueAt: NOW + 900000 })), { kind: 'due', dueAt: NOW + 900000 });
});

ok('интервал включён, но таймера нет → «вот-вот», а не выдуманное время', () => {
  assert.deepStrictEqual(nextChange.describe(on({ dueAt: 0 })), { kind: 'soon' });
  assert.deepStrictEqual(nextChange.describe(on({})), { kind: 'soon' });
});

ok('игровой режим важнее взведённого таймера перепроверки', () => {
  // Game Mode тоже держит таймер (перепроверка через минуту), но обещать по нему смену нельзя.
  assert.deepStrictEqual(
    nextChange.describe(on({ dueAt: NOW + 60000, hold: 'gamemode' })),
    { kind: 'held', reason: 'gamemode' },
  );
});

ok('ожидание «невидимой смены» тоже снимает обещание времени', () => {
  assert.deepStrictEqual(
    nextChange.describe(on({ dueAt: NOW + 600000, hold: 'stealth' })),
    { kind: 'held', reason: 'stealth' },
  );
});

ok('незнакомая причина блокировки не подменяет собой отсчёт', () => {
  assert.deepStrictEqual(nextChange.describe(on({ dueAt: NOW + 300000, hold: 'whatever' })), { kind: 'due', dueAt: NOW + 300000 });
});

// ── label(): что именно увидит пользователь ──────────────────────────────────

const labelKey = (state, now = NOW) => {
  const out = nextChange.label(state, now);
  return out && out.key;
};

ok('обычный остаток показывается в минутах', () => {
  assert.deepStrictEqual(
    nextChange.label({ kind: 'due', dueAt: NOW + 12 * 60000 }, NOW),
    { key: 'home.nextIn', params: { n: 12 } },
  );
});

ok('остаток округляется к ближайшей минуте', () => {
  assert.strictEqual(nextChange.label({ kind: 'due', dueAt: NOW + 1_799_000 }, NOW).params.n, 30);
  assert.strictEqual(nextChange.label({ kind: 'due', dueAt: NOW + 90_000 }, NOW).params.n, 2);
  assert.strictEqual(nextChange.label({ kind: 'due', dueAt: NOW + 61_000 }, NOW).params.n, 1);
});

ok('меньше минуты и просроченный таймер не превращаются в «через 1 мин»', () => {
  assert.strictEqual(labelKey({ kind: 'due', dueAt: NOW + 59_000 }), 'home.nextSoon');
  assert.strictEqual(labelKey({ kind: 'due', dueAt: NOW - 5000 }), 'home.nextSoon');
  assert.strictEqual(labelKey({ kind: 'soon' }), 'home.nextSoon');
});

ok('длинные интервалы показываются часами', () => {
  assert.deepStrictEqual(
    nextChange.label({ kind: 'due', dueAt: NOW + 125 * 60000 }, NOW),
    { key: 'home.nextInHours', params: { h: 2, n: 5 } },
  );
  assert.deepStrictEqual(
    nextChange.label({ kind: 'due', dueAt: NOW + 120 * 60000 }, NOW),
    { key: 'home.nextInHoursExact', params: { h: 2 } },
  );
  // ровно на границе часа не должно остаться «через 60 мин»
  assert.strictEqual(labelKey({ kind: 'due', dueAt: NOW + 60 * 60000 }), 'home.nextInHoursExact');
});

ok('у блокировок своя подпись, без единой цифры времени', () => {
  assert.deepStrictEqual(nextChange.label({ kind: 'held', reason: 'gamemode' }, NOW), { key: 'home.nextHeldGame', params: {} });
  assert.deepStrictEqual(nextChange.label({ kind: 'held', reason: 'stealth' }, NOW), { key: 'home.nextHeldStealth', params: {} });
});

ok('«выключено» и мусор не дают подписи вовсе', () => {
  assert.strictEqual(nextChange.label({ kind: 'off' }, NOW), null);
  assert.strictEqual(nextChange.label(null, NOW), null);
  assert.strictEqual(nextChange.label({}, NOW), null);
});

ok('событийный режим переиспользует существующую подпись', () => {
  assert.strictEqual(labelKey({ kind: 'events' }), 'home.eventTriggers');
});

// ── tickMs(): как часто renderer перерисовывает подпись ──────────────────────

ok('перерисовка нужна только когда идёт отсчёт', () => {
  assert.strictEqual(nextChange.tickMs({ kind: 'held', reason: 'gamemode' }, NOW), 0);
  assert.strictEqual(nextChange.tickMs({ kind: 'events' }, NOW), 0);
  assert.strictEqual(nextChange.tickMs({ kind: 'off' }, NOW), 0);
  assert.ok(nextChange.tickMs({ kind: 'due', dueAt: NOW + 1800000 }, NOW) > 0);
});

ok('у конца отсчёта шаг мельче', () => {
  const far = nextChange.tickMs({ kind: 'due', dueAt: NOW + 30 * 60000 }, NOW);
  const near = nextChange.tickMs({ kind: 'due', dueAt: NOW + 40000 }, NOW);
  assert.ok(near < far, `${near} должен быть меньше ${far}`);
});

// ── ключи существуют в обоих эталонах с теми же placeholders ─────────────────

ok('каждый выдаваемый ключ есть в en и ru с теми же placeholders', () => {
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
  const ru = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'ru.json'), 'utf8'));
  const lookup = (dict, key) => key.split('.').reduce((cursor, part) => (cursor == null ? cursor : cursor[part]), dict);
  const placeholders = (s) => (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');

  const states = [
    { kind: 'events' },
    { kind: 'soon' },
    { kind: 'held', reason: 'gamemode' },
    { kind: 'held', reason: 'stealth' },
    { kind: 'due', dueAt: NOW + 30_000 },
    { kind: 'due', dueAt: NOW + 12 * 60000 },
    { kind: 'due', dueAt: NOW + 125 * 60000 },
    { kind: 'due', dueAt: NOW + 120 * 60000 },
  ];

  for (const state of states) {
    const out = nextChange.label(state, NOW);
    assert.ok(out && out.key, `нет подписи для ${JSON.stringify(state)}`);
    const enText = lookup(en, out.key);
    const ruText = lookup(ru, out.key);
    assert.strictEqual(typeof enText, 'string', `${out.key} отсутствует в en.json`);
    assert.strictEqual(typeof ruText, 'string', `${out.key} отсутствует в ru.json`);
    assert.strictEqual(placeholders(enText), placeholders(ruText), `${out.key}: placeholders en/ru разошлись`);
    const wanted = Object.keys(out.params).map((p) => `{${p}}`).sort().join(',');
    assert.strictEqual(placeholders(enText), wanted, `${out.key}: строка ждёт не те подстановки`);
  }
});

console.log(`\nAll ${passed} next-change tests passed.`);
