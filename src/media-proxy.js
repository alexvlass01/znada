(function initMediaProxy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZnadaMediaProxy = api;
}(typeof self !== 'undefined' ? self : globalThis, function mediaProxyFactory() {
  'use strict';


  /*
   * media-proxy.js — адресация потокового прокси картинок (PERF-008).
   *
   * ЗАЧЕМ ОН ЕСТЬ. Картинки booru появлялись примерно на 1.5 с позже, чем могли бы. Замер
   * 2026-09-03 показал, что время съедает НЕ вес файла (загрузка 30–120 мс), а путь: главный
   * процесс скачивал файл целиком, кодировал в base64 и отдавал одной строкой через IPC.
   * Пока не проехало всё — окно не рисовало ничего, а 173 КБ превращались в ~231 КБ строки,
   * которая потом оседала в памяти просмотрщика.
   *
   * ПОЧЕМУ НЕ УБРАТЬ ПРОКСИ ВОВСЕ. Очевидный путь — пусть окно грузит напрямую, как оно
   * грузит Wallhaven, — закрыт замером 2026-09-09. Настоящее окно Electron получает от
   * `cdn.donmai.us` отказ за 151 мс. Дело не в `Referer`, как считалось раньше: Danbooru его
   * вообще не шлёт и получает 200. Отсекает бот-защита Cloudflare, реагирующая на браузерную
   * ФОРМУ запроса (`Accept`, `Sec-Fetch-*`), а её окно изменить не может — эти заголовки
   * ставит сам Chromium. Значит маршрут остаётся, меняется только форма: байты идут потоком.
   *
   * ЧТО ЗДЕСЬ, А ЧЕГО НЕТ. Здесь чистая часть: как называется картинка в собственном адресе,
   * как этот адрес разобрать обратно и какой потолок размера у какой ступени. Сама загрузка,
   * заголовки и проверка принадлежности хоста провайдеру остаются в главном процессе — там,
   * где они стоят сейчас. Это и есть главное достоинство такого среза: ни одна проверка
   * никуда не переезжает.
   *
   * ГРАНИЦА БЕЗОПАСНОСТИ НЕ МЕНЯЕТСЯ. Окно и раньше передавало адрес картинки (в карточке),
   * а главный процесс сверял его с объявленными хостами провайдера. Здесь ровно то же самое:
   * адрес едет в собственном URL, и главный процесс сверяет его теми же функциями. Этот
   * модуль НИЧЕГО не разрешает сам — он только разбирает строку и обязан быть придирчивым
   * к мусору, потому что строку составляет окно.
   */

  const SCHEME = 'znada-media';

  /*
   * Ступень → поле карточки. Список ЗАКРЫТЫЙ, и это не формальность: ступень приходит из
   * окна, а «любое поле» здесь означало бы «любой адрес из карточки», то есть дыру в той
   * самой проверке, ради сохранения которой всё и затевалось.
   */
  const TIER_FIELD = Object.freeze({
    thumb: 'thumb',
    sample: 'sample',
    full: 'full',
  });

  /*
   * Потолки те же, что были на прежнем пути: миниатюра — 2 МБ, остальное — 30 МБ (обои
   * бывают большими). Разведены по ступеням намеренно: миниатюра в 30 МБ означает, что
   * что-то не то отдал сайт, и молча тащить это в сетку не надо.
   */
  const THUMB_MAX_BYTES = 2 * 1024 * 1024;
  const FULL_MAX_BYTES = 30 * 1024 * 1024;

  function tierField(tier) {
    return Object.prototype.hasOwnProperty.call(TIER_FIELD, tier) ? TIER_FIELD[tier] : '';
  }

  function limitFor(tier) {
    if (!tierField(tier)) return 0;
    return tier === 'thumb' ? THUMB_MAX_BYTES : FULL_MAX_BYTES;
  }

  /*
   * Превышен ли потолок. Отдельной функцией, потому что на потоке это проверяется по мере
   * чтения, а не после: смысл потоковой отдачи в том, что «после» не наступает, пока файл
   * не доехал, а рвать соединение надо раньше. `limit` 0 означает «ступень неизвестна» —
   * тогда не пропускается ничего.
   */
  function overLimit(seenBytes, limit) {
    if (!Number.isFinite(seenBytes) || seenBytes < 0) return true;
    if (!Number.isFinite(limit) || limit <= 0) return true;
    return seenBytes > limit;
  }

  /*
   * Собрать собственный адрес. Возвращает пустую строку на любом мусоре: пустой адрес окно
   * просто не покажет, а исключение в момент отрисовки уронило бы кадр.
   */
  function buildUrl(descriptor) {
    const d = descriptor || {};
    const provider = String(d.provider || '').trim();
    const tier = String(d.tier || '').trim();
    const url = String(d.url || '').trim();
    if (!provider || !tierField(tier) || !url) return '';
    // Адрес целиком уезжает в параметр: так одна и та же картинка всегда даёт одну и ту же
    // строку, и кэш браузера работает сам, без нашего словаря data-URL в памяти.
    const params = new URLSearchParams({ t: tier, p: provider, u: url });
    return `${SCHEME}://media/?${params.toString()}`;
  }

  /*
   * Разобрать обратно. Придирчиво: строку составляет окно, поэтому всё, что не совпало
   * с ожидаемой формой, — отказ, а не попытка догадаться.
   */
  function parseUrl(href) {
    const text = String(href || '');
    if (!text.startsWith(`${SCHEME}://`)) return null;
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    // Хост фиксированный: он ничего не выбирает, но его подмена — признак, что адрес
    // собрали не мы, и разбирать такое дальше незачем.
    if (parsed.host !== 'media') return null;
    const tier = parsed.searchParams.get('t') || '';
    const provider = (parsed.searchParams.get('p') || '').trim();
    const url = parsed.searchParams.get('u') || '';
    if (!tierField(tier) || !provider || !url) return null;
    return { tier, provider, url, field: tierField(tier), limit: limitFor(tier) };
  }

  return {
    SCHEME,
    TIER_FIELD,
    THUMB_MAX_BYTES,
    FULL_MAX_BYTES,
    tierField,
    limitFor,
    overLimit,
    buildUrl,
    parseUrl,
  };
}));
