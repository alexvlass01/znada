'use strict';

/*
 * PERF-011. Какие соседние фото просмотрщик готовит заранее и сколько держит готовыми.
 *
 * Было: по два соседа в обе стороны, все запросы разом, и только ПОСЛЕ того, как текущее
 * фото дошло до полного качества. При быстром листании до полного качества не доходило ни
 * одно фото, поэтому впереди не было готово ничего (так и записано в замере PERF-009:
 * «при таком темпе она не начинается»). А готовое держалось только до конца раскодирования:
 * объект картинки выбрасывался, и кадр «назад» снова раскодировался с нуля.
 *
 * Теперь:
 *   - вперёд по ходу листания готовится больше, чем назад, и ближние раньше дальних;
 *   - одновременно идёт не больше PARALLEL запросов, остальное ждёт в очереди;
 *   - раскодированные кадры держатся, пока они в окне вокруг текущего и пока их сумма
 *     укладывается в бюджет памяти; ближние вытесняют дальние, а не наоборот.
 *
 * Здесь только решение, без DOM и без сети: что готовить, в каком порядке и что выбросить.
 * Сами загрузки, отмена устаревших (BUG-027) и повторы остаются в `viewer.js`.
 */
(function initViewerPrefetch(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ZnadaViewerPrefetch = api;
}(typeof window !== 'undefined' ? window : globalThis, function viewerPrefetchFactory() {
  // Глубина по ходу листания и против него. Назад — те, что человек только что видел:
  // смена направления чаще всего — «вернуться на одно-два».
  const AHEAD = 4;
  const BEHIND = 2;
  // Сколько запросов предзагрузки идёт одновременно. Текущее фото к этому не относится.
  const PARALLEL = 2;
  // Сколько раскодированных точек держать готовыми: 4 байта на точку. 256 МиБ — это
  // примерно семь кадров 3840×2160, то есть всё окно целиком для обычных обоев.
  const DECODED_BUDGET = 256 * 1024 * 1024;
  // Один кадр не может занять больше половины бюджета: исполин в 14204×10652 (605 МиБ
  // раскодированным) вытеснил бы всех соседей ради себя одного.
  const DECODED_MAX_ONE = DECODED_BUDGET / 2;

  function direction(delta) {
    return Number(delta) < 0 ? -1 : 1;
  }

  /*
   * Порядок подготовки вокруг `center` в галерее из `n` кадров. Сам `center` не входит.
   * Ранг по ходу листания — расстояние d, против хода — 2d − 0.5: первый «назад» идёт
   * сразу за первым «вперёд», второй — после третьего «вперёд». Галерея закольцована,
   * как и сами стрелки; в маленькой галерее кадр, попавший в обе стороны, берётся один раз.
   */
  function plan(center, n, dir, ahead = AHEAD, behind = BEHIND) {
    const count = Math.floor(Number(n));
    const c = Math.floor(Number(center));
    if (!(count > 1) || !(c >= 0) || c >= count) return [];
    const step = direction(dir);
    const ranked = [];
    const forward = Math.max(0, Math.floor(ahead) || 0);
    const backward = Math.max(0, Math.floor(behind) || 0);
    for (let d = 1; d <= forward; d++) ranked.push({ d, rank: d, sign: step });
    for (let d = 1; d <= backward; d++) ranked.push({ d, rank: 2 * d - 0.5, sign: -step });
    ranked.sort((a, b) => a.rank - b.rank);
    const out = [];
    const seen = new Set([c]);
    for (const { d, sign } of ranked) {
      const index = (((c + sign * d) % count) + count) % count;
      if (seen.has(index)) continue;
      seen.add(index);
      out.push(index);
    }
    return out;
  }

  function decodedBytes(width, height) {
    const w = Math.floor(Number(width));
    const h = Math.floor(Number(height));
    return w > 0 && h > 0 ? w * h * 4 : 0;
  }

  // Стоит ли держать кадр раскодированным. Неизвестный размер — нет: не знаем, сколько он стоит.
  function worthKeeping(bytes, maxOne = DECODED_MAX_ONE) {
    return bytes > 0 && bytes <= maxOne;
  }

  /*
   * Что выбросить из готовых. `held` — пары {index, bytes}; `order` — приоритет (текущий
   * первым, затем `plan`). Всё вне `order` выбрасывается; внутри — держим по порядку,
   * пока сумма в бюджете. Возвращает индексы на выброс.
   */
  function evict(held, order, budget = DECODED_BUDGET) {
    const rank = new Map();
    (order || []).forEach((index, i) => { if (!rank.has(index)) rank.set(index, i); });
    const drop = [];
    const kept = [];
    for (const item of held || []) {
      if (rank.has(item.index)) kept.push(item);
      else drop.push(item.index);
    }
    kept.sort((a, b) => rank.get(a.index) - rank.get(b.index));
    let total = 0;
    for (const item of kept) {
      const bytes = Math.max(0, Number(item.bytes) || 0);
      if (total + bytes <= budget) total += bytes;
      else drop.push(item.index);
    }
    return drop;
  }

  return Object.freeze({
    AHEAD, BEHIND, PARALLEL, DECODED_BUDGET, DECODED_MAX_ONE,
    direction, plan, decodedBytes, worthKeeping, evict,
  });
}));
