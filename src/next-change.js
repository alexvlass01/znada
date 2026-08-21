'use strict';

// «Когда сменятся обои» для карточки на Главной.
//
// Правило задачи HOME-001: источник истины — main process. Renderer НЕ решает сам,
// есть ли честное время: он получает отсюда либо абсолютный момент срабатывания
// (`dueAt`), либо явное «времени нет». Поэтому в модуле две половины одной логики:
//
//   describe() — main: сырое состояние планировщика → что интерфейсу РАЗРЕШЕНО обещать;
//   label()    — renderer: то же состояние + текущее время → ключ i18n и параметры.
//
// Обе половины чистые и живут в одном файле специально: если бы renderer считал вид
// подписи по своим правилам, «через N минут» рано или поздно разошлось бы с реальным
// таймером — ровно то, что задача запрещает. Файл грузится и через require (main,
// тесты), и тегом <script> (renderer), поэтому экспорт двойной.

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NextChange = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  const MINUTE_MS = 60000;
  const HOUR_MIN = 60;

  // Причины, по которым честного времени НЕТ. Игровой режим и «невидимая смена» ждут
  // внешнего события (конца игры, полноэкранного окна), а не таймера, поэтому у них
  // нет момента, который можно показать.
  const HOLD_REASONS = new Set(['gamemode', 'stealth']);

  // main: сырые факты планировщика → состояние для интерфейса.
  //   slideshowEnabled — слайд-шоу включено вообще;
  //   intervalEnabled  — включён именно интервальный триггер;
  //   dueAt            — epoch ms взведённого таймера (0/нет — таймера нет);
  //   hold             — 'gamemode' | 'stealth' | null.
  function describe(state = {}) {
    if (!state.slideshowEnabled) return { kind: 'off' };
    if (!state.intervalEnabled) return { kind: 'events' };
    // Блокировка важнее взведённого таймера: при игровом режиме таймер тоже стоит,
    // но он лишь перепроверяет через минуту и обещать по нему смену нельзя.
    if (HOLD_REASONS.has(state.hold)) return { kind: 'held', reason: state.hold };
    const dueAt = Number(state.dueAt);
    if (Number.isFinite(dueAt) && dueAt > 0) return { kind: 'due', dueAt };
    // Интервал включён, но таймера нет: смена прямо сейчас применяется или
    // перепланируется. Это короткое состояние, и оно тоже не врёт про время.
    return { kind: 'soon' };
  }

  // renderer: состояние + «сейчас» → { key, params } для t().
  // null означает «эта карточка не про смену обоев» — Главная покажет свой прежний
  // текст про расписание темы или ручной режим.
  function label(state, nowMs = Date.now()) {
    if (!state || !state.kind) return null;
    switch (state.kind) {
      case 'events':
        return { key: 'home.eventTriggers', params: {} };
      case 'held':
        return state.reason === 'gamemode'
          ? { key: 'home.nextHeldGame', params: {} }
          : { key: 'home.nextHeldStealth', params: {} };
      case 'due':
        return remainingLabel(Number(state.dueAt) - Number(nowMs));
      case 'soon':
        return { key: 'home.nextSoon', params: {} };
      default:
        return null;
    }
  }

  // Меньше минуты не округляем до «через 1 мин»: отдельная подпись честнее и не
  // залипает на «1 мин» на всё последнее мгновение ожидания.
  function remainingLabel(remainingMs) {
    if (!Number.isFinite(remainingMs) || remainingMs < MINUTE_MS) {
      return { key: 'home.nextSoon', params: {} };
    }
    const minutes = Math.max(1, Math.round(remainingMs / MINUTE_MS));
    if (minutes < HOUR_MIN) return { key: 'home.nextIn', params: { n: minutes } };
    const h = Math.floor(minutes / HOUR_MIN);
    const n = minutes % HOUR_MIN;
    return n === 0
      ? { key: 'home.nextInHoursExact', params: { h } }
      : { key: 'home.nextInHours', params: { h, n } };
  }

  // Как часто renderer должен перерисовывать подпись. Далеко от конца минуты меняются
  // редко, поэтому чаще всего хватает редкого тика; у самого конца шаг мельче, чтобы
  // «через 1 мин» вовремя сменилось на «меньше минуты».
  function tickMs(state, nowMs = Date.now()) {
    if (!state || state.kind !== 'due') return 0;
    const remaining = Number(state.dueAt) - Number(nowMs);
    if (!Number.isFinite(remaining)) return 0;
    if (remaining <= 2 * MINUTE_MS) return 5000;
    return 20000;
  }

  return { describe, label, tickMs };
});
