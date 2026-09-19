'use strict';

const $ = (sel) => document.querySelector(sel);

// Optional dev-diagnostics span bridge (window.znadaDiag injected by the viewer preload
// only under the diagnostics gate; a no-op end() otherwise).
function diagSpan(category, name) {
  return (window.znadaDiag && window.znadaDiag.span(category, name)) || (() => {});
}
// Set at the start of each render(); present() fires first-frame on the first shown
// tier, and the full-tier call sites fire full-quality. Superseded renders just leave
// the previous closures unfired (idempotent, nothing recorded).
let renderFirstFrameEnd = null;
let renderFullEnd = null;

const I18N = { dict: {}, fallback: {} };
const VIEWER = { items: [], index: 0, token: 0 };
const POINTER = { x: 0, y: 0, t: 0, button: -1, blocked: false };
const PAN = { active: false, x: 0, y: 0, moved: false };

// Resolved image sources keyed by item index, so prefetched neighbours show
// instantly on navigation. Each entry holds { sample?, full? } (data: URLs for
// booru). Prefetch grabs the cheap tier (sample where available), so we keep a
// small radius and cap the cache, evicting the entries farthest from the current.
const IMG_CACHE = new Map();
const PREFETCHING = new Set();
const PREFETCH_RADIUS = 2;
const IMG_CACHE_MAX = 7;

function setHd(on) {
  const hd = $('#viewerHd');
  if (hd) hd.hidden = !on;
}

const LOADING_PILL_DELAY = 350;
// BUG-042. Две попытки, не больше: третья уже не про «сорвалось», а про «его нет».
const RETRY_ATTEMPTS = 2;
const RETRY_PAUSE_MS = 450;
let loadingTimer = null;

function clearLoadingTimer() {
  if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
}

// Show the "Loading…" pill only if the load is actually slow, so quick swaps
// (and prefetched neighbours) never flash the text. delay <= 0 shows it at once
// (used on first open, where there is no previous frame to keep on screen).
function scheduleLoadingPill(token, delay) {
  clearLoadingTimer();
  if (delay <= 0) {
    if (token === VIEWER.token) setState(t('viewer.loading'));
    return;
  }
  loadingTimer = setTimeout(() => {
    loadingTimer = null;
    if (token === VIEWER.token) setState(t('viewer.loading'));
  }, delay);
}

// Two crossfading <img> layers. We only ever set src on the hidden (back) layer,
// then fade it in over the visible (front) one, so frames dissolve smoothly
// instead of popping — both between photos and on the preview->full upgrade.
const STAGE = { front: null, back: null };
// The ambient backdrop uses its own pair of crossfading layers (slower, calmer).
const BG = { front: null, back: null };

function initStage() {
  STAGE.front = $('#viewerImageA');
  STAGE.back = $('#viewerImageB');
  BG.front = $('#viewerBgImgA');
  BG.back = $('#viewerBgImgB');
}

function stageHasImage() {
  return !!(STAGE.front && STAGE.front.getAttribute('src'));
}

function setStageAlt(text) {
  if (STAGE.front) STAGE.front.alt = text || '';
  if (STAGE.back) STAGE.back.alt = text || '';
}

// BUG-039. Пропорции фотографии, известные ДО загрузки: карточки сайтов несут ширину и
// высоту, а если их нет — разрешение обычно записано текстом в заголовке или подписи
// («2560x1280»), тем же шаблоном, который читает updateResolutionInSubtitle.
function knownAspect(entry) {
  if (!entry) return 0;
  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {};
  const w = Number(raw.width) || 0;
  const h = Number(raw.height) || 0;
  if (w > 0 && h > 0) return w / h;
  const text = `${entry.title || ''} ${entry.subtitle || ''}`;
  const m = text.match(/(\d{2,6})x(\d{2,6})/);
  if (!m) return 0;
  const tw = Number(m[1]);
  const th = Number(m[2]);
  return tw > 0 && th > 0 ? tw / th : 0;
}

// Изменится ли прямоугольник сцены при переходе от прежних пропорций к новым.
// Отдельно от DOM, потому что от этого ответа зависит, можно ли плавно уводить старый
// слой: если коробка меняет форму, плавный уход показывает, как старое фото в ней
// сплющивается. Именно это я и сделал первой попыткой — замер поймал расхождение до 400%.
function stageAspectChanged(had, before, next) {
  if (!had) return next > 0;
  if (!(next > 0)) return true;
  // Округление размеров у провайдеров даёт микроразличия, при которых коробка стоит.
  return Math.abs(before - next) / next > 0.001;
}

// Возвращает true, если прямоугольник сцены ИЗМЕНИЛСЯ.
function applyStageAspect(entry) {
  const stage = $('#viewerStage');
  if (!stage) return false;
  const aspect = knownAspect(entry);
  const changed = stageAspectChanged(
    stage.classList.contains('has-aspect'),
    Number(stage.style.getPropertyValue('--photo-aspect')) || 0,
    aspect,
  );
  if (aspect > 0) {
    stage.style.setProperty('--photo-aspect', String(aspect));
    stage.classList.add('has-aspect');
  } else {
    stage.style.removeProperty('--photo-aspect');
    stage.classList.remove('has-aspect');
  }
  return changed;
}

// Crossfade a {front, back} layer pair to a new (already-decoded) src. The NEW
// image is placed at the bottom at full opacity instantly; the OLD one fades OUT
// on top to reveal it. So coverage is always 100% (no mid-fade dim), AND the old
// image is gone the instant its fade-out ends — it can never linger in the new
// image's letterbox margins. (The earlier "fade the new in on top" approach left
// the old fully opaque underneath, showing through the margins until it was
// hidden/reused — that was the lingering-previous-image bug.)
function crossfadeTo(pair, src, hardSwap) {
  const incoming = pair.back;   // new image — revealed instantly at the bottom
  const outgoing = pair.front;  // current image — fades out on top to uncover the new
  if (!incoming) return;
  incoming.style.transition = 'none';
  incoming.style.zIndex = '1';
  incoming.src = src;
  incoming.style.opacity = '1';
  if (outgoing) {
    if (hardSwap) {
      // Прямоугольник сцены меняется вместе с картинкой, а уходящий слой живёт в той же
      // сцене — за 70 мс плавного ухода его успевало сплющить в новую коробку, и это
      // читалось как рывок. Новый слой к этому моменту уже полностью виден под старым,
      // поэтому снять старый можно мгновенно: провала в яркости не будет.
      outgoing.style.transition = 'none';
      outgoing.style.zIndex = '0';
      outgoing.style.opacity = '0';
    } else {
      outgoing.style.transition = ''; // CSS opacity transition drives the fade-out
      outgoing.style.zIndex = '2';
      void outgoing.offsetWidth;      // commit current opacity/transition before fading
      outgoing.style.opacity = '0';
    }
  }
  pair.front = incoming;
  pair.back = outgoing;
}

// --- Zoom & pan (applies to the currently shown photo layer only) ---
const ZOOM = { scale: 1, x: 0, y: 0 };
const ZOOM_MAX = 6;

function applyZoom() {
  if (STAGE.front) STAGE.front.style.transform = `translate(${ZOOM.x}px, ${ZOOM.y}px) scale(${ZOOM.scale})`;
  const stage = $('#viewerStage');
  if (stage) stage.style.cursor = ZOOM.scale > 1 ? 'grab' : '';
}

function resetZoom() {
  ZOOM.scale = 1;
  ZOOM.x = 0;
  ZOOM.y = 0;
}

// Keep the (scaled) image from being dragged past its own edges.
function clampPan() {
  const stage = $('#viewerStage');
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  const maxX = Math.max(0, (r.width * ZOOM.scale - r.width) / 2);
  const maxY = Math.max(0, (r.height * ZOOM.scale - r.height) / 2);
  ZOOM.x = Math.max(-maxX, Math.min(maxX, ZOOM.x));
  ZOOM.y = Math.max(-maxY, Math.min(maxY, ZOOM.y));
}

// Zoom by `factor`, keeping the point under (clientX, clientY) fixed on screen.
function zoomAt(clientX, clientY, factor) {
  const stage = $('#viewerStage');
  if (!stage) return;
  const prev = ZOOM.scale;
  const next = Math.max(1, Math.min(ZOOM_MAX, prev * factor));
  if (next === prev) return;
  if (next === 1) { resetZoom(); applyZoom(); return; }
  const r = stage.getBoundingClientRect();
  const cx = clientX - r.left - r.width / 2;
  const cy = clientY - r.top - r.height / 2;
  const ratio = next / prev;
  ZOOM.x = cx * (1 - ratio) + ZOOM.x * ratio;
  ZOOM.y = cy * (1 - ratio) + ZOOM.y * ratio;
  ZOOM.scale = next;
  clampPan();
  applyZoom();
}

// Дальше нужно передать ровно `hardSwap`: своего `fit` у crossfadeTo нет и не было никогда
// (CODE-003). Прежняя подпись несла мёртвый `fit`, и признак мгновенной смены доезжал лишь
// потому, что совпадали позиции аргументов — выравнивание арности молча вернуло бы BUG-039.
function showImage(src, hardSwap) {
  crossfadeTo(STAGE, src, hardSwap);
  applyZoom(); // carry the current zoom/pan onto the freshly shown layer
  updateBackgroundFromSrc(src);
}

// Совпадает ли форма этого кадра с формой самой фотографии.
//
// Предварительный кадр имеет смысл только если он — уменьшенная копия. Wallhaven же
// отдаёт ВСЕМ фотографиям превью 300x200, обрезанное под фиксированную рамку: у высокой
// картинки это середина крупным планом, а не она сама. Замер 2026-09-02: у Wallhaven не
// совпало 21 из 21, расхождение до 144%; у Gelbooru миниатюра уменьшена без обрезки и
// совпадает всегда. Отсюда и «некоторые фото дёргаются, некоторые нет».
//
// Показать такой кадр честно нельзя ничем: вписать — прыгнет размер, заполнить — прыгнет
// содержимое. Поэтому его не показывают вовсе и ждут кадр правильной формы; полная
// картинка всегда правильной формы, так что ждать есть чего.
function frameShapeMatches(loadedWidth, loadedHeight, aspect) {
  if (!(aspect > 0) || !(loadedWidth > 0) || !(loadedHeight > 0)) return true; // не с чем сравнивать
  const own = loadedWidth / loadedHeight;
  // Допуск: округление размеров у провайдеров даёт расхождение в доли процента.
  return Math.abs(own - aspect) / aspect <= 0.02;
}

function clearStage() {
  for (const layer of [STAGE.front, STAGE.back]) {
    if (!layer) continue;
    layer.style.opacity = '0';
    layer.removeAttribute('src');
  }
}

// Backdrop behind the photo. 'ambient'/'color' derive from the current image;
// 'charcoal'/'aurora' are pure CSS (set by the bg-* class on the viewer root).
const BG_MODES = ['ambient', 'charcoal', 'aurora', 'color'];
let bgMode = 'ambient';

function applyBackgroundMode(mode) {
  bgMode = BG_MODES.includes(mode) ? mode : 'ambient';
  const root = $('#viewerRoot');
  if (root) for (const m of BG_MODES) root.classList.toggle('bg-' + m, m === bgMode);
  const bg = $('#viewerBg');
  if (bg) bg.style.background = '';            // drop any inline color-mode gradient
  if (bgMode !== 'ambient') {
    for (const layer of [BG.front, BG.back]) {
      if (!layer) continue;
      layer.style.opacity = '0';
      layer.removeAttribute('src');
    }
  }
  const current = STAGE.front && STAGE.front.getAttribute('src');
  if (current) updateBackgroundFromSrc(current); // live switch while a photo is shown
}

function updateBackgroundFromSrc(src) {
  if (!src) return;
  if (bgMode === 'ambient') {
    crossfadeTo(BG, src);
  } else if (bgMode === 'color') {
    applyDominantColor(src);
  }
}

function applyDominantColor(src) {
  const bg = $('#viewerBg');
  if (!bg) return;
  const probe = new Image();
  probe.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 16;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(probe, 0, 0, 16, 16);
      const { data } = ctx.getImageData(0, 0, 16, 16);
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 16) continue;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      if (!n) return;
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      bg.style.background = `radial-gradient(circle at 50% 38%, rgba(${r}, ${g}, ${b}, 0.55), #060608 72%)`;
    } catch {
      // Tainted canvas (cross-origin direct image, e.g. Wallhaven) — neutral dark fallback.
      bg.style.background = 'radial-gradient(circle at 50% 42%, #16161c 0%, #0b0b0e 56%, #050506 100%)';
    }
  };
  probe.src = src;
}

function setFullscreenUi(on) {
  const root = $('#viewerRoot');
  if (root) root.classList.toggle('is-fullscreen', !!on);
  const btn = $('#viewerFullscreen');
  if (btn) {
    const label = t(on ? 'viewer.windowed' : 'viewer.fullscreen');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
}

function tPath(obj, key) {
  return key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
}

function t(key, params) {
  let value = tPath(I18N.dict, key);
  if (value == null) value = tPath(I18N.fallback, key);
  if (value == null) value = key;
  if (params) for (const k in params) value = value.split('{' + k + '}').join(params[k]);
  return value;
}

async function loadI18n() {
  const info = await window.viewerApi.getI18n();
  I18N.dict = info.dict || {};
  I18N.fallback = info.fallback || {};
  if (info.locale) document.documentElement.lang = info.locale;
  const close = $('#viewerClose');
  if (close) {
    close.title = t('viewer.close');
    close.setAttribute('aria-label', t('viewer.close'));
  }
  const prev = $('#viewerPrev');
  if (prev) {
    prev.title = t('viewer.previous');
    prev.setAttribute('aria-label', t('viewer.previous'));
  }
  const next = $('#viewerNext');
  if (next) {
    next.title = t('viewer.next');
    next.setAttribute('aria-label', t('viewer.next'));
  }
  const hdText = $('#viewerHdText');
  if (hdText) hdText.textContent = t('viewer.loadingFull');
  setFullscreenUi(false);
}

function normalizePayload(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items.filter(Boolean) : [];
  const rawIndex = Number(payload && payload.index);
  return {
    items,
    index: items.length ? Math.max(0, Math.min(items.length - 1, Number.isFinite(rawIndex) ? Math.floor(rawIndex) : 0)) : 0,
  };
}

function setPayload(payload) {
  // Reusing the viewer window for a different gallery is a new context. An Undo from
  // the previous payload must not remain floating over (and appear to belong to) the
  // newly opened card.
  dismissViewerNotice();
  const next = normalizePayload(payload);
  VIEWER.items = next.items;
  VIEWER.index = next.index;
  IMG_CACHE.clear();
  PREFETCHING.clear();
  if (payload && payload.background) applyBackgroundMode(payload.background);
  render();
}

function currentEntry() {
  return VIEWER.items[VIEWER.index] || null;
}

// A fit-to-screen image closes on a background click. Interactive controls and the
// whole Undo notice are not background: clicking its text or padding must not close
// the viewer while the user is aiming for the action.
function blocksViewerClose(target) {
  return !!(target && typeof target.closest === 'function'
    && target.closest('button, .media-notice'));
}

function setState(message, hidden = false) {
  const state = $('#viewerState');
  if (!state) return;
  state.textContent = message || '';
  state.hidden = hidden || !message;
}

/*
 * BUG-042. «Не удалось открыть это изображение» было тупиком: ни повторной попытки,
 * ни способа попросить ещё раз. Здесь у сообщения появляется выход. Разметка строится
 * узлами, а не строкой: в сообщение попадает текст перевода, и собирать его в innerHTML
 * означало бы завести дыру там, где её сейчас нет.
 */
function setLoadError(message, onRetry) {
  const state = $('#viewerState');
  if (!state) return;
  state.textContent = '';
  state.classList.remove('has-action');
  const text = document.createElement('span');
  text.textContent = message || '';
  state.appendChild(text);
  if (typeof onRetry === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-state-retry';
    button.textContent = t('viewer.retry');
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      onRetry();
    });
    state.appendChild(button);
    state.classList.add('has-action');
  }
  state.hidden = false;
}

// PERF-008. Ступень → поле карточки. Само правило живёт в `src/media-proxy.js`; здесь только
// выбор поля, потому что карточку знает окно, а не модуль.
// BUG-046. A site whose pictures the window loads itself declares no proxy hosts, so main
// refuses such a request (403). The builder, not each caller, says "not through the proxy":
// previewSource once skipped the check and a Wallhaven preview never appeared.
function mediaProxyUrl(item, tier) {
  if (!item || !item.provider || item.loadsDirectly) return '';
  const url = String(item[tier === 'thumb' ? 'thumb' : tier] || '');
  if (!url) return '';
  return ZnadaMediaProxy.buildUrl({ provider: item.provider, tier, url }) || '';
}

async function previewSource(entry) {
  if (!entry) return '';
  if ((entry.kind === 'library' || entry.kind === 'path') && entry.path) {
    return window.viewerApi.fileUrl(entry.path);
  }
  if (entry.kind === 'cloud') {
    return entry.previewUrl || '';
  }
  if (entry.kind === 'internet') {
    const item = entry.raw || {};
    const thumb = String(item.thumb || entry.previewUrl || '');
    if (thumb.startsWith('data:image/')) return thumb;
    // PERF-008. Прежде здесь ждали, пока главный процесс скачает файл целиком и вернёт
    // его строкой base64: до конца загрузки не рисовалось ничего. Теперь окно получает
    // адрес и рисует с первых байт, а маршрут и все проверки остались прежними.
    const proxied = mediaProxyUrl(item, 'thumb');
    return proxied || thumb || '';
  }
  return entry.previewUrl || '';
}

async function fullSource(entry, fallback = '') {
  if (!entry) return fallback;
  if ((entry.kind === 'library' || entry.kind === 'path') && entry.path) {
    return window.viewerApi.fileUrl(entry.path);
  }
  if (entry.kind === 'internet') {
    const item = entry.raw || {};
    const direct = String(item.full || '');
    // ONL-012: some image hosts refuse a request that does not say where it came from,
    // and this window cannot send that header — so those are fetched through main as a
    // data URL. The card carries the answer; this file names no site.
    if (item.provider && !item.loadsDirectly) {
      const proxied = mediaProxyUrl(item, 'full');
      if (proxied) return proxied;
    }
    return direct || fallback;
  }
  return fallback || entry.previewUrl || '';
}

// Intermediate "sample" tier — carried only by sites that keep a same-host downscale,
// which are the same ones whose images main has to fetch for us.
async function sampleSource(entry) {
  if (!entry || entry.kind !== 'internet') return '';
  const item = entry.raw || {};
  if (!item.sample || !item.provider || item.loadsDirectly) return '';
  return mediaProxyUrl(item, 'sample');
}

/*
 * BUG-042. Одна сорвавшаяся загрузка не должна становиться приговором: владелец получил
 * «не удалось открыть» на кадре 96 из 115, а замер потом показал, что сама картинка
 * грузится и раскодируется за 0.6 с. Отказал не размер, а сеть, и повторить было некому —
 * в просмотрщике не было ни одной повторной попытки.
 *
 * Но слепой повтор здесь опаснее, чем кажется. Главная гипотеза причины — всплеск запросов
 * к сайту при быстром листании вместе с предзагрузкой соседей; повторы этот всплеск
 * УСИЛИВАЮТ. Поэтому политика такая:
 *
 *   - число попыток ограничено, бесконечности нет ни при каких входных данных;
 *   - повтор отменяется, как только человек ушёл на другое фото (`active`), иначе
 *     брошенные загрузки продолжают долбить сайт как раз в тот момент, когда ему тяжело;
 *   - пауза растёт с номером попытки, чтобы вторая не легла в ту же секунду, что первая.
 *
 * Возвращает паузу в миллисекундах или -1 = больше не пробовать.
 */
function retryDelayMs(attempt, maxAttempts, basePauseMs, active) {
  if (!active) return -1;
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts)) return -1;
  if (attempt < 1 || maxAttempts < 1) return -1;
  if (attempt >= maxAttempts) return -1;
  const base = Number.isFinite(basePauseMs) && basePauseMs > 0 ? basePauseMs : 0;
  return base * attempt;
}

function loadOnce(src) {
  return new Promise((resolve, reject) => {
    if (!src) { reject(new Error('empty')); return; }
    const probe = new Image();
    probe.onload = () => resolve({ src, width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => reject(new Error('load'));
    probe.src = src;
  });
}

// BUG-042. Повторяет попытку по политике `retryDelayMs`. Пустой `src` не повторяется:
// это не сетевой отказ, а отсутствие адреса, и второй раз он не появится.
async function loadImage(src, options) {
  const opts = options || {};
  const maxAttempts = Number.isFinite(opts.attempts) ? opts.attempts : 1;
  const pause = Number.isFinite(opts.pauseMs) ? opts.pauseMs : RETRY_PAUSE_MS;
  const active = typeof opts.active === 'function' ? opts.active : () => true;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await loadOnce(src);
    } catch (err) {
      const delay = src ? retryDelayMs(attempt, maxAttempts, pause, active()) : -1;
      if (delay < 0) throw err;
      await new Promise((done) => { setTimeout(done, delay); });
      if (!active()) throw err;
    }
  }
}

// Decode then crossfade a resolved src onto the stage. Returns false on failure
// or if the render was superseded (token changed), so callers can react.
// `requireShape` — не показывать кадр, если его форма расходится с формой фотографии.
// Ставится на предварительные кадры: правильный по форме всё равно придёт следом.
async function present(src, token, entry, requireShape) {
  try {
    // BUG-042. `active` — не оптимизация, а защита: брошенные повторы при быстром
    // листании усиливали бы тот самый всплеск запросов, который и подозревается причиной.
    const loaded = await loadImage(src, {
      attempts: RETRY_ATTEMPTS,
      pauseMs: RETRY_PAUSE_MS,
      active: () => token === VIEWER.token,
    });
    if (token !== VIEWER.token) return false;
    if (requireShape && !frameShapeMatches(loaded.width, loaded.height, knownAspect(entry))) return false;
    // BUG-039. Прямоугольник меняется РОВНО ТОГДА, когда меняется картинка, и ни секундой
    // раньше. Первая попытка ставила его в начале отрисовки — и при переходе к следующему
    // фото коробка успевала принять новые пропорции, пока на экране ещё висело старое:
    // оно на мгновение сплющивалось. Замер показал расхождение до 400%, то есть я починил
    // редкий случай (обрезанное превью) и создал частый.
    const reshaped = applyStageAspect(entry);
    showImage(loaded.src, reshaped);
    if (renderFirstFrameEnd) { renderFirstFrameEnd(); renderFirstFrameEnd = null; } // budget span #13
    clearLoadingTimer();
    setState('', true);
    updateResolutionInSubtitle(loaded.width, loaded.height, entry);
    return true;
  } catch {
    return false;
  }
}

function cacheTier(index, tier, src) {
  if (!src) return;
  const entry = IMG_CACHE.get(index) || {};
  entry[tier] = src;
  IMG_CACHE.set(index, entry);
  if (IMG_CACHE.size <= IMG_CACHE_MAX) return;
  const n = VIEWER.items.length || 1;
  const dist = (i) => { const d = Math.abs(i - index); return Math.min(d, n - d); };
  // Drop the entries farthest (cyclically) from the current index first.
  const order = [...IMG_CACHE.keys()].sort((a, b) => dist(b) - dist(a));
  for (const key of order) {
    if (IMG_CACHE.size <= IMG_CACHE_MAX) break;
    if (key !== index) IMG_CACHE.delete(key);
  }
}

async function prefetchIndex(index) {
  const cached = IMG_CACHE.get(index);
  if ((cached && (cached.full || cached.sample)) || PREFETCHING.has(index)) return;
  const entry = VIEWER.items[index];
  if (!entry) return;
  PREFETCHING.add(index);
  try {
    // Prefer the cheap sample tier (booru); fall back to full (Wallhaven/local).
    let tier = 'sample';
    let src = await sampleSource(entry);
    if (!src) { tier = 'full'; src = await fullSource(entry, ''); }
    if (!src) return;
    cacheTier(index, tier, src);
    const warm = new Image();
    warm.src = src;
    if (warm.decode) { try { await warm.decode(); } catch {} }
  } catch {
    // Prefetch is best-effort; failures just mean a normal load on navigation.
  } finally {
    PREFETCHING.delete(index);
  }
}

function prefetchNeighbors(center) {
  const n = VIEWER.items.length;
  if (n <= 1) return;
  for (let d = 1; d <= PREFETCH_RADIUS && d * 2 < n + 1; d++) {
    prefetchIndex((center + d) % n);
    prefetchIndex((center - d + n) % n);
  }
}

// ONL-008. The viewer's button used to latch exactly the way the grid's did: add once
// and it sat there disabled, with the only way back through the Library tab. It is a
// two-way control now, and it removes through the same `library-remove-many` everything
// else uses — trash, Undo, nothing deleted from disk.
//
// The viewer has no pool of its own, so "which record is this photo" comes from the
// payload (`entry.pooled`, already in the shape the removal IPC takes) and is kept up to
// date here as the user adds and removes.
function syncAddAction(entry, add) {
  if (!entry || !add) return;
  const removable = !!(entry.added && entry.pooled && (entry.pooled.id || entry.pooled.path));
  // Added but unidentifiable: an honest dead end is better than a button that would
  // remove the wrong thing. In practice this only happens if the add reported no record.
  add.textContent = t(entry.added ? (removable ? 'online.remove' : 'online.added') : 'online.add');
  add.classList.toggle('suggested', !entry.added);
  add.classList.toggle('danger', removable);
  add.disabled = !!entry.added && !removable;
}

// The Library tab already offers Undo in its toast. The fullscreen viewer is a
// separate document, so it needs its own small, transient notice rather than trying
// to reach into the main window's DOM. Only one notice is live at a time because main
// intentionally keeps only the latest removal snapshot.
const VIEWER_NOTICE = { element: null, timer: null };

function dismissViewerNotice() {
  clearTimeout(VIEWER_NOTICE.timer);
  VIEWER_NOTICE.timer = null;
  const element = VIEWER_NOTICE.element;
  VIEWER_NOTICE.element = null;
  if (element) element.remove();
}

// `wrap` lets a notice take more than one line. Notices are one line with an ellipsis by
// default, which is right for short statuses and wrong for one whose end is the point —
// LIB-009's eviction warning was cut exactly at «уже не вернуть».
function createViewerNotice(message, { wrap = false } = {}) {
  const root = $('#viewerRoot');
  if (!root) return null;
  dismissViewerNotice();
  const element = document.createElement('div');
  element.className = wrap ? 'media-notice media-notice-wrap' : 'media-notice';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  const text = document.createElement('span');
  text.textContent = message;
  element.appendChild(text);
  root.appendChild(element);
  VIEWER_NOTICE.element = element;
  return { element, text };
}

function finishViewerNotice(notice, message, delay = 2400) {
  if (!notice || VIEWER_NOTICE.element !== notice.element) return;
  notice.element.textContent = '';
  notice.text = document.createElement('span');
  notice.text.textContent = message;
  notice.element.appendChild(notice.text);
  clearTimeout(VIEWER_NOTICE.timer);
  VIEWER_NOTICE.timer = setTimeout(() => {
    if (VIEWER_NOTICE.element === notice.element) dismissViewerNotice();
  }, delay);
}

function showViewerMessage(message, delay = 2400, options = {}) {
  const notice = createViewerNotice(message, options);
  if (!notice) return;
  VIEWER_NOTICE.timer = setTimeout(() => {
    if (VIEWER_NOTICE.element === notice.element) dismissViewerNotice();
  }, delay);
}

// A notice with something to press — the viewer's equivalent of the main window's
// toast-with-an-action, used after a save to offer adding the picture to the library.
function showViewerAction(message, actionLabel, onAction, delay = 6000) {
  const notice = createViewerNotice(message);
  if (!notice) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'media-notice-action';
  button.textContent = actionLabel;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    await onAction();
    // The notice may already have been replaced by whatever the action itself said.
    if (VIEWER_NOTICE.element === notice.element) dismissViewerNotice();
  });
  notice.element.appendChild(button);
  VIEWER_NOTICE.timer = setTimeout(() => {
    if (VIEWER_NOTICE.element === notice.element) dismissViewerNotice();
  }, delay);
}

// Keep the state transition separate and small enough to test directly. A transport
// success is not enough: main must report that something was actually restored. On
// every error/empty result the viewer remains honestly in its post-removal state.
function applyViewerUndoResult(entry, pooled, res) {
  if (!entry || !res || res.error || !(Number(res.restored) > 0)) return false;
  entry.added = true;
  entry.pooled = pooled;
  return true;
}

// Navigation rebuilds #viewerActions. Never keep using the button captured before an
// IPC await: it may have been detached while the user stepped away and back. Resolve
// the currently mounted action only after the result is known.
function syncCurrentAddAction(entry) {
  if (currentEntry() !== entry) return false;
  const add = $('#viewerActions [data-action="add"]');
  if (!add) return false;
  syncAddAction(entry, add);
  return true;
}

// LIB-009. `evicted` — сколько записей выпало из корзины насовсем: вернуть их одним
// нажатием уже нельзя. Уведомление здесь тоже одно за раз, поэтому текст склеивается,
// а не вытесняет кнопку «Отменить» вторым сообщением.
function removalNoticeText(evicted) {
  return [
    t('library.removedToast'),
    evicted > 0 ? t('library.trashEvictedN', { n: evicted }) : '',
  ].filter(Boolean).join(' · ');
}

function showRemovalUndo(entry, pooled, token, evicted) {
  const notice = createViewerNotice(removalNoticeText(evicted), { wrap: evicted > 0 });
  if (!notice) return;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'media-notice-action';
  undo.textContent = t('library.undo');
  notice.element.appendChild(undo);
  undo.addEventListener('click', async () => {
    if (undo.disabled) return;
    undo.disabled = true;
    clearTimeout(VIEWER_NOTICE.timer);
    VIEWER_NOTICE.timer = null;

    const currentAdd = currentEntry() === entry
      ? $('#viewerActions [data-action="add"]')
      : null;
    if (currentAdd) currentAdd.disabled = true;

    let res;
    try { res = await window.viewerApi.libraryUndoRemove(token); }
    catch { res = null; }
    // A newer removal replaces both main's one-level snapshot and this notice. Do not
    // let the older asynchronous callback repaint or mutate a now-unrelated card.
    if (VIEWER_NOTICE.element !== notice.element) return;

    const restored = applyViewerUndoResult(entry, pooled, res);
    syncCurrentAddAction(entry);
    finishViewerNotice(notice, t(restored ? 'library.undoneToast' : 'library.undoFailed'), 3000);
  });
  VIEWER_NOTICE.timer = setTimeout(() => {
    if (VIEWER_NOTICE.element === notice.element) dismissViewerNotice();
  }, 6000);
}

// What the viewer says after a removal. Without Undo the notice would vanish after the
// usual 2.4 s; a warning about entries that are gone for good gets the same time to be
// read as the notice with Undo, and room to wrap.
function showRemovalResult(entry, pooled, res) {
  if (res.undo) showRemovalUndo(entry, pooled, res.undo.token, res.evicted);
  else if (res.evicted > 0) showViewerMessage(removalNoticeText(res.evicted), 6000, { wrap: true });
  else showViewerMessage(removalNoticeText(res.evicted));
}

// ONL-009. The same right-click menu the grid has. The viewer is where a picture is
// actually being looked at full size, which is where "save this one" and "put it on
// that monitor" get decided — so it gets the menu rather than a reduced imitation.
//
// What it CANNOT do is a separate question from what the picture can: there is no tag
// editor, favourites list or details sheet in this window, so those are left out by
// naming what this surface implements. Everything named here is genuinely wired.
const VIEWER_ACTIONS = ['add', 'assign', 'lookupMeta', 'saveAs', 'copyFile', 'copyLink', 'openSource', 'remove'];

function viewerSubjectFor(entry) {
  if (!entry) return null;
  const pooled = entry.added && entry.pooled ? entry.pooled : null;
  if (entry.kind === 'internet') return CardActions.internetSubject(entry.raw, pooled);
  if (entry.kind === 'cloud') return CardActions.cloudSubject(entry.raw, pooled);
  // A local picture: the pool record if the payload carried one, otherwise just a file.
  return CardActions.localSubject({ path: entry.path, type: 'image', id: pooled ? pooled.id : '' }, pooled);
}

// The monitor chooser, drawn by the same module the main window uses. Its data comes
// from main because this window holds no config of its own.
async function openViewerAssign(entry, descriptor, point) {
  let targets;
  try { targets = await window.viewerApi.cardAssignTargets(); }
  catch { targets = null; }
  const root = $('#viewerRoot');
  if (!root) return;
  closeViewerPopup();

  const pop = document.createElement('div');
  pop.className = 'lib-popup card-menu viewer-popup';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('library.assignTo'));
  const title = document.createElement('div');
  title.className = 'lib-popup-title';
  title.textContent = t('library.assignTo');
  pop.appendChild(title);

  AssignRows.build(pop, targets && targets.monitors, targets && targets.separateThemes, {
    idPrefix: 'viewerAssignMonitor',
    monitorLabel: (row) => t('monitor.label', { n: row.number }),
    slotLabel: (slot) => (slot.themeIcon
      ? t(slot.theme === 'dark' ? 'design.darkTheme' : 'design.lightTheme')
      : t('library.assignAction')),
    // BUG-037. The same truth the main window shows: how many pictures are already in
    // each spot, and whether this one is among them. A picture that has not been
    // downloaded yet has no pool id, so only the counts apply to it — which is correct,
    // it cannot already be in a slot.
    occupancy: {
      slots: (targets && targets.slots) || {},
      itemId: (entry && entry.added && entry.pooled && entry.pooled.id) || '',
    },
    slotHint: (slot) => {
      if (slot.hasThis) return t('library.slotHasThis');
      return slot.count > 0 ? t('library.slotFilled', { n: slot.count }) : '';
    },
    onPick: async (monitorId, theme) => {
      // Close FIRST. The picture may still have to be downloaded, and a chooser that
      // lingers for seconds while that happens reads as a frozen app — the exact
      // complaint this behaviour drew in the main window.
      closeViewerPopup();
      let id = entry.added && entry.pooled ? entry.pooled.id : '';
      if (!id && (entry.kind === 'library' || entry.kind === 'path')) {
        // A local photo needs a record, not a download. Sending it down the online add
        // path asked main to fetch a file already on the disk, and main answered
        // 'badItem' over a picture the user was looking at full-screen.
        id = await ensureViewerPoolId(entry);
        if (!id) { showViewerMessage(t('library.assignMissingToast')); return; }
      }
      if (!id) {
        showViewerMessage(t('card.downloading'), 20000);
        id = await addViewerCardToLibrary(entry, descriptor);
        if (!id) return;   // the add reports its own failure
      }
      let res;
      try { res = await window.viewerApi.libraryAssign(id, monitorId, theme); }
      catch { res = null; }
      showViewerMessage(t(res && res.ok !== false ? 'library.assignedToast' : 'library.assignMissingToast'));
    },
  });

  root.appendChild(pop);
  const spot = CardMenu.placeAt(
    point || { x: 40, y: 40 },
    { width: pop.offsetWidth, height: pop.offsetHeight },
    { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
  );
  pop.style.left = `${spot.left}px`;
  pop.style.top = `${spot.top}px`;
  VIEWER_POPUP.element = pop;
  const dismiss = (e) => { if (!pop.contains(e.target)) closeViewerPopup(); };
  VIEWER_POPUP.dismiss = dismiss;
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
}

const VIEWER_POPUP = { element: null, dismiss: null };

function closeViewerPopup() {
  if (VIEWER_POPUP.dismiss) document.removeEventListener('mousedown', VIEWER_POPUP.dismiss, true);
  VIEWER_POPUP.dismiss = null;
  if (VIEWER_POPUP.element) VIEWER_POPUP.element.remove();
  VIEWER_POPUP.element = null;
}

// One place this window turns an online card into a library record, so the menu and
// the action button cannot disagree about what "added" means.
async function addViewerCardToLibrary(entry, descriptor) {
  let res;
  try {
    res = descriptor.kind === 'cloud'
      ? await window.viewerApi.cloudAdd(entry.raw)
      : await window.viewerApi.internetAdd(entry.raw, entry.query || '');
  } catch { res = { error: 'download' }; }
  if (!res || res.error) {
    showViewerMessage(CardTransfer.errorMessage(t, res && res.error));
    return '';
  }
  entry.added = true;
  entry.pooled = res.id ? { id: res.id, path: '', type: 'image' } : null;
  syncCurrentAddAction(entry);
  return res.id || '';
}

function openViewerCardMenu(entry, point) {
  const subject = viewerSubjectFor(entry);
  if (!subject) return;
  const descriptor = CardActions.descriptorFor(subject);
  const groups = CardActions.menuGroupsFor(subject, { only: VIEWER_ACTIONS });
  if (!groups.length) return;

  const transfer = (action) => CardTransfer.run(action, {
    bridge: window.viewerApi,
    descriptor,
    t,
    notify: ({ message, actionLabel, onAction }) => {
      if (!message) return;
      if (actionLabel && onAction) showViewerAction(message, actionLabel, onAction);
      else showViewerMessage(message);
    },
    onAddToLibrary: () => addViewerCardToLibrary(entry, descriptor),
  });

  const handlers = {
    add: () => addViewerCardToLibrary(entry, descriptor),
    assign: () => openViewerAssign(entry, descriptor, point),
    remove: () => removeViewerCard(entry),
    saveAs: () => transfer('saveAs'),
    copyFile: () => transfer('copyFile'),
    copyLink: () => transfer('copyLink'),
    openSource: () => transfer('openSource'),
    lookupMeta: () => lookupViewerCardMetadata(entry),
  };

  CardMenu.openMenu({
    groups,
    point,
    ariaLabel: t('library.cardActions'),
    root: $('#viewerRoot') || document.body,
    labelFor: (action) => t(action.labelKey),
    onPick: (action) => { const run = handlers[action.id]; if (run) run(); },
  });
}

// The viewer's equivalent of ensurePoolItemForRecord in the main window: the pool record
// if there is one, and otherwise one made NOW, because the user has actually asked. The
// registry offers lookup and remove for a local photo whether or not it has a record
// (card-actions.js, and the comment above `lookupMeta` says why); this is what makes that
// true here instead of only in the grid.
async function ensureViewerPoolId(entry) {
  if (!entry) return '';
  if (entry.pooled && entry.pooled.id) return entry.pooled.id;
  if (entry.kind !== 'library' && entry.kind !== 'path') return '';
  if (!entry.path) return '';
  let res;
  try { res = await window.viewerApi.cardEnsureRecord(entry.path, 'image'); }
  catch { return ''; }
  const id = (res && res.id) || '';
  // The same bookkeeping addViewerCardToLibrary does after an add, so the menu and the
  // action button cannot disagree about what this entry now is.
  if (id) { entry.added = true; entry.pooled = { id, path: entry.path, type: 'image' }; }
  return id;
}

// META-001 from the fullscreen view. The same shared operation the main window runs —
// the picture on screen is the same picture, so looking it up must be the same act and
// not a second implementation that drifts.
//
// Nothing on this screen displays tags, so there is nothing to redraw afterwards; the
// updated record reaches the library grid through the ordinary config broadcast.
async function lookupViewerCardMetadata(entry) {
  const id = await ensureViewerPoolId(entry);
  // Never a bare return. card-metadata.js exists because a lookup that answers with
  // silence is one the user concludes is broken, and this was the one path in the app
  // that bypassed it entirely: the menu offered the action and the click did nothing.
  if (!id) { showViewerMessage(t('card.lookupFailed')); return null; }
  return CardMetadata.run({
    bridge: window.viewerApi,
    id,
    t,
    notify: (message) => { if (message) showViewerMessage(message); },
  });
}

// Taking the picture back out. Shared by the action button and the menu, so the two
// cannot drift into removing it in different ways.
async function removeViewerCard(entry) {
  if (!entry) return false;
  // Every card knows its path; only some have a pool id. `library-remove-many` takes
  // exactly that pair — which is why a photo inside a watched folder is removable from
  // the grid, and why requiring a record here left the menu item dead and silent.
  const pooled = entry.pooled || null;
  const payload = {
    id: (pooled && pooled.id) || '',
    path: (pooled && pooled.path) || entry.path || '',
    type: 'image',
  };
  if (!payload.id && !payload.path) { setState(t('library.massDeleteFailed')); return false; }
  const removedPoolRecord = { ...payload };
  let res;
  try { res = await window.viewerApi.libraryRemoveMany([payload]); }
  catch { res = { error: 'remove' }; }
  if (!res || res.error || !res.affected) {
    // A removal that came back having changed nothing has no error code to report, and
    // "Error: ?" says nothing. Use the same wording the Library tab uses for it.
    setState(res && !res.error
      ? t('library.massDeleteFailed')
      : CardTransfer.errorMessage(t, res && res.error));
    return false;
  }
  entry.added = false;
  entry.pooled = null;
  showRemovalResult(entry, removedPoolRecord, res);
  syncCurrentAddAction(entry);
  return true;
}

function renderActions(entry) {
  const actions = $('#viewerActions');
  if (!actions) return;
  actions.innerHTML = '';
  if (!entry || (entry.kind !== 'cloud' && entry.kind !== 'internet')) return;

  const add = document.createElement('button');
  add.className = 'media-action';
  add.dataset.action = 'add';
  syncAddAction(entry, add);
  add.addEventListener('click', async () => {
    if (add.disabled) return;
    const removing = !!entry.added;
    // Re-adding is a new decision. Leaving an older Undo action on screen would make
    // it unclear whether the user is undoing the removal or the fresh add.
    if (!removing) dismissViewerNotice();
    add.disabled = true;
    if (removing) await removeViewerCard(entry);
    else await addViewerCardToLibrary(entry, CardActions.descriptorFor(viewerSubjectFor(entry)));
    add.disabled = false;
    syncAddAction(entry, add);
  });
  actions.appendChild(add);
}

function updateResolutionInSubtitle(width, height, entry) {
  if (!width || !height || !entry) return;

  const resStr = `${width}x${height}`;
  const titleText = (entry.title || '').trim();
  const baseSubtitle = (entry.subtitle || '').trim();

  // If the title or the original base subtitle already contains a resolution pattern,
  // we do not need to append any temporary or loaded resolutions.
  const hasOriginalRes = /\d+x\d+/.test(titleText) || /\d+x\d+/.test(baseSubtitle);

  const subtitle = $('#viewerSubtitle');
  if (subtitle) {
    if (hasOriginalRes) {
      subtitle.textContent = baseSubtitle;
    } else {
      const separator = baseSubtitle ? ' - ' : '';
      subtitle.textContent = `${baseSubtitle}${separator}${resStr}`;
    }
  }
}

function step(delta) {
  if (VIEWER.items.length <= 1) return;
  VIEWER.index = (VIEWER.index + delta + VIEWER.items.length) % VIEWER.items.length;
  render();
}

async function render() {
  const endNavigate = diagSpan('viewer', 'navigate'); // budget span #15
  try { return await renderCore(); } finally { endNavigate(); }
}

async function renderCore() {
  const entry = currentEntry();
  const token = ++VIEWER.token;
  renderFirstFrameEnd = diagSpan('viewer', 'first-frame'); // fired by present() on first show
  renderFullEnd = diagSpan('viewer', 'full-quality'); // fired when the full tier is shown
  const title = $('#viewerTitle');
  const subtitle = $('#viewerSubtitle');
  const footer = $('#viewerFooter');
  const prev = $('#viewerPrev');
  const next = $('#viewerNext');

  if (title) title.textContent = (entry && entry.title) || t('viewer.title');
  if (subtitle) subtitle.textContent = (entry && entry.subtitle) || '';
  if (footer) footer.textContent = VIEWER.items.length
    ? t('viewer.counter', { current: VIEWER.index + 1, total: VIEWER.items.length })
    : '';
  if (prev) prev.disabled = VIEWER.items.length <= 1;
  if (next) next.disabled = VIEWER.items.length <= 1;
  renderActions(entry);

  if (!STAGE.front) return;
  const idx = VIEWER.index;
  const hadImage = stageHasImage();
  resetZoom(); // each photo opens fit-to-screen; showImage re-applies on the new layer
  setStageAlt(entry && entry.title);
  setHd(false);
  // Keep the previous frame on screen while the next one decodes (no black flash),
  // and only surface the "Loading…" pill if the load is actually slow. On first
  // open there is nothing to keep, so show it immediately.
  scheduleLoadingPill(token, hadImage ? LOADING_PILL_DELAY : 0);

  const cached = IMG_CACHE.get(idx) || {};
  let shown = false; // is a sample-or-better frame already on screen?

  // 1) Show the best cached tier instantly (full preferred, else the sample).
  if (cached.full) {
    if (await present(cached.full, token, entry)) {
      if (renderFullEnd) { renderFullEnd({ status: 'cached' }); renderFullEnd = null; } // budget span #14
      prefetchNeighbors(idx);
      return;
    }
    if (token !== VIEWER.token) return;
    delete cached.full; // stale/broken — fall through and reload
  }
  if (cached.sample) {
    if (await present(cached.sample, token, entry)) shown = true;
    else { if (token !== VIEWER.token) return; delete cached.sample; }
  }

  // 2) Nothing decent cached: show the quick thumbnail, then the sample tier (booru).
  if (!shown) {
    let preview = '';
    try { preview = await previewSource(entry); } catch {}
    if (token !== VIEWER.token) return;
    // BUG-039. Предварительный кадр показывается, только если его форма совпадает с
    // формой фотографии. Пропущенный кадр — не ошибка: следом придёт правильный, и
    // «показать нечего» проверяется в самом конце, когда испробованы все источники.
    const previewShown = preview ? await present(preview, token, entry, true) : false;
    if (token !== VIEWER.token) return;
    // Обрезанную миниатюру нельзя выдавать за фотографию, но размытым фоном она годится:
    // формы там нет, а экран не остаётся пустым, пока едет кадр правильной формы.
    if (preview && !previewShown) updateBackgroundFromSrc(preview);
    // Badge only while we're still on the low-res thumbnail; hide it once the
    // sample (already good quality) is up — no badge during the sample->full swap.
    if (entry.kind === 'internet') setHd(true);
    let sample = '';
    try { sample = await sampleSource(entry); } catch {}
    if (token !== VIEWER.token) return;
    if (sample && await present(sample, token, entry, true)) {
      cacheTier(idx, 'sample', sample);
      shown = true;
      if (token === VIEWER.token) setHd(false);
    }
    if (token !== VIEWER.token) return;
  }

  // 3) Upgrade to the original full in the background — silent (crossfade hides it).
  let full = '';
  try { full = await fullSource(entry, ''); } catch {}
  if (token !== VIEWER.token) return;
  const currentSrc = STAGE.front && STAGE.front.getAttribute('src');
  if (full && full !== currentSrc && await present(full, token, entry)) {
    cacheTier(idx, 'full', full);
    if (renderFullEnd) { renderFullEnd({ status: 'upgraded' }); renderFullEnd = null; } // budget span #14
  }
  if (token === VIEWER.token) setHd(false);
  // Все источники испробованы. Если на сцене так ничего и нет — это настоящая ошибка,
  // и о ней надо сказать. Раньше об этом сообщал провал показа миниатюры, но теперь
  // пропуск миниатюры законен, и единственный честный признак — пустая сцена.
  if (token === VIEWER.token && !stageHasImage()) {
    clearLoadingTimer();
    clearStage();
    // BUG-042. Повтор перезапускает показ того же кадра целиком: источники пробуются
    // заново, включая те, что отказали. Это и есть «попросить ещё раз» руками.
    setLoadError(t('viewer.loadError'), () => { render(); });
    return;
  }
  prefetchNeighbors(idx);
}

function initEvents() {
  const close = $('#viewerClose');
  if (close) close.addEventListener('click', () => window.viewerApi.close());
  const root = $('#viewerRoot');

  // ONL-009. Right-click anywhere on the picture opens the same menu the grid has.
  // Bound to the stage rather than to a card, because here there is only ever the one
  // picture being looked at.
  const stage = $('#viewerStage');
  if (stage) {
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openViewerCardMenu(currentEntry(), { x: e.clientX, y: e.clientY });
    });
  }
  // The keyboard route, the same two keys the grid answers to.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
    e.preventDefault();
    openViewerCardMenu(currentEntry(), null);
  });
  const fullscreen = $('#viewerFullscreen');
  if (fullscreen) fullscreen.addEventListener('click', async () => {
    // Drop focus so the next arrow-key press doesn't paint a focus ring on the button.
    fullscreen.blur();
    const r = await window.viewerApi.toggleFullscreen();
    if (r && typeof r.fullscreen === 'boolean') setFullscreenUi(r.fullscreen);
  });
  const prev = $('#viewerPrev');
  if (prev) prev.addEventListener('click', () => { step(-1); prev.blur(); });
  const next = $('#viewerNext');
  if (next) next.addEventListener('click', () => { step(1); next.blur(); });
  if (root) {
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18);
    }, { passive: false });
    root.addEventListener('pointerdown', (e) => {
      POINTER.x = e.clientX;
      POINTER.y = e.clientY;
      POINTER.t = Date.now();
      POINTER.button = e.button;
      POINTER.blocked = blocksViewerClose(e.target);
      // Start panning when the photo is zoomed in (but not when pressing a control).
      if (e.button === 0 && !POINTER.blocked && ZOOM.scale > 1) {
        PAN.active = true;
        PAN.x = e.clientX;
        PAN.y = e.clientY;
        PAN.moved = false;
        const stage = $('#viewerStage');
        if (stage) stage.style.cursor = 'grabbing';
        try { root.setPointerCapture(e.pointerId); } catch {}
      }
    });
    root.addEventListener('pointermove', (e) => {
      if (!PAN.active) return;
      const dx = e.clientX - PAN.x;
      const dy = e.clientY - PAN.y;
      PAN.x = e.clientX;
      PAN.y = e.clientY;
      if (dx || dy) PAN.moved = true;
      ZOOM.x += dx;
      ZOOM.y += dy;
      clampPan();
      applyZoom();
    });
    root.addEventListener('pointercancel', () => {
      if (!PAN.active) return;
      PAN.active = false;
      const stage = $('#viewerStage');
      if (stage) stage.style.cursor = ZOOM.scale > 1 ? 'grab' : '';
    });
    root.addEventListener('pointerup', (e) => {
      const panned = PAN.active && PAN.moved;
      if (PAN.active) {
        PAN.active = false;
        try { root.releasePointerCapture(e.pointerId); } catch {}
        const stage = $('#viewerStage');
        if (stage) stage.style.cursor = ZOOM.scale > 1 ? 'grab' : '';
      }
      if (POINTER.button !== 0 || POINTER.blocked || e.button !== 0 || blocksViewerClose(e.target)) return;
      const dx = Math.abs(e.clientX - POINTER.x);
      const dy = Math.abs(e.clientY - POINTER.y);
      const dt = Date.now() - POINTER.t;
      if (dx <= 4 && dy <= 4 && dt < 350 && !panned) {
        if (ZOOM.scale > 1) { resetZoom(); applyZoom(); } // click while zoomed → fit
        else window.viewerApi.close();                    // click while fit → close
      }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      window.viewerApi.close();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    }
  });
  window.viewerApi.onPayload((payload) => setPayload(payload));
  window.viewerApi.onFullscreenChanged(setFullscreenUi);
  window.viewerApi.onBackgroundChanged(applyBackgroundMode);
}

async function init() {
  initStage();
  await loadI18n();
  initEvents();
  setPayload(await window.viewerApi.getPayload());
}

init();
