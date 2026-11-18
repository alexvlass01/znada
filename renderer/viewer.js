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
const VIEWER = { items: [], index: 0, token: 0, payloadEpoch: 0, closed: false };
const POINTER = { x: 0, y: 0, t: 0, button: -1, blocked: false };
const PAN = { active: false, x: 0, y: 0, moved: false };
let VIDEO = null;
let viewerVideoDownloads;
function isVideoEntry(entry) {
  if (entry?.kind === 'internet') return window.MediaKind?.isOnlineVideo?.(entry.raw) === true;
  return !!(entry && (entry.kind === 'library' || entry.kind === 'path') && window.MediaKind && window.MediaKind.isVideoPath(entry.path));
}

// Resolved image sources keyed by item index, so prefetched neighbours show
// instantly on navigation. The budget covers the encoded source strings retained
// here, including inline data URLs. Chromium owns the network and decoded caches.
const IMG_CACHE = new Map();
const PREFETCHING = new Map();
const IMG_CACHE_MAX_BYTES = 32 * 1024 * 1024;
let imageCacheBytes = 0;
// PERF-011. Раскодированные соседи, которых держим готовыми: index → {img, bytes}.
// Порядок, глубина и бюджет — `renderer/viewer-prefetch.js`.
const WARM = new Map();
// `hold`: пока у текущего фото нет кадра, новые запросы предзагрузки не начинаются —
// текущее важнее. `direction` — куда листали последним.
const PREFETCH = { center: -1, direction: 1, hold: true };

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
// («2560x1280» или «1920 × 1080»), тем же шаблоном, который читает updateResolutionInSubtitle.
function knownAspect(entry) {
  if (!entry) return 0;
  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {};
  const w = Number(raw.width) || 0;
  const h = Number(raw.height) || 0;
  if (w > 0 && h > 0) return w / h;
  const text = `${entry.title || ''} ${entry.subtitle || ''}`;
  const m = text.match(/(\d{2,6})\s*[x×]\s*(\d{2,6})/);
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
  if (VIDEO) VIDEO.zoom(ZOOM);
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

// Same lookup as the main window. Forms of a count live in renderer/plural.js.
function t(key, params) {
  return ZnadaPlural.format(key, params, I18N.dict, I18N.fallback, document.documentElement.lang);
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
  if (VIEWER.closed) return;
  resetPayloadWork();
  const next = normalizePayload(payload);
  VIEWER.items = next.items;
  VIEWER.index = next.index;
  if (payload && payload.background) applyBackgroundMode(payload.background);
  render();
}

function resetPayloadWork() {
  ++VIEWER.payloadEpoch;
  ++VIEWER.token;
  dismissViewerNotice();
  closeViewerPopup();
  clearLoadingTimer();
  for (const job of PREFETCHING.values()) job.warm?.removeAttribute('src');
  PREFETCHING.clear();
  for (const held of WARM.values()) held.img.removeAttribute('src');
  WARM.clear();
  PREFETCH.center = -1;
  PREFETCH.hold = true;
  PREFETCH_DONE.clear();
  IMG_CACHE.clear();
  imageCacheBytes = 0;
}

function destroyViewer() {
  if (VIEWER.closed) return;
  VIEWER.closed = true;
  resetPayloadWork();
  VIEWER.items = [];
}

function closeViewer() {
  destroyViewer();
  window.viewerApi.close();
}

function currentEntry() {
  return VIEWER.items[VIEWER.index] || null;
}

// A fit-to-screen image closes on a background click. Interactive controls and the
// whole Undo notice are not background: clicking its text or padding must not close
// the viewer while the user is aiming for the action.
function blocksViewerClose(target) {
  return !!(target && typeof target.closest === 'function'
    && target.closest('button, input, .media-video-controls, .video-guard, .media-notice'));
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
  if (isVideoEntry(entry)) return ''; // native video is never prefetched as an <img>
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
  if (!src || src.length > IMG_CACHE_MAX_BYTES) return;
  // Most sources are ASCII, including base64. Avoid copying large data URLs
  // just to measure them.
  const bytes = /[\u0080-\uFFFF]/.test(src) ? new TextEncoder().encode(src).byteLength : src.length;
  if (bytes > IMG_CACHE_MAX_BYTES) return;
  const entry = IMG_CACHE.get(index) || {};
  const weight = `${tier}Bytes`;
  imageCacheBytes += bytes - (entry[weight] || 0);
  entry[tier] = src;
  entry[weight] = bytes;
  IMG_CACHE.set(index, entry);
  if (imageCacheBytes <= IMG_CACHE_MAX_BYTES) return;
  const n = VIEWER.items.length || 1;
  const dist = (i) => { const d = Math.abs(i - index); return Math.min(d, n - d); };
  // Keep the tiers closest to the inserted source, evicting cyclically as before.
  const order = [...IMG_CACHE.keys()].sort((a, b) => dist(b) - dist(a));
  for (const key of order) {
    if (imageCacheBytes <= IMG_CACHE_MAX_BYTES) break;
    if (key === index) {
      dropCachedTier(index, tier === 'full' ? 'sample' : 'full', entry);
    } else {
      const dropped = IMG_CACHE.get(key);
      imageCacheBytes -= (dropped.sampleBytes || 0) + (dropped.fullBytes || 0);
      IMG_CACHE.delete(key);
    }
  }
}

function dropCachedTier(index, tier, entry) {
  if (IMG_CACHE.get(index) !== entry) return;
  const weight = `${tier}Bytes`;
  imageCacheBytes -= entry[weight] || 0;
  delete entry[weight];
  delete entry[tier];
  if (!entry.full && !entry.sample) IMG_CACHE.delete(index);
}

// PERF-011. Кадры, за которыми уже ходили в нынешнем окне вокруг текущего — удачно или нет.
// Без этой отметки кадр, не влезший в бюджет памяти, раскодировался бы снова и снова:
// подготовили → вытеснили → снова в очереди. Отметка снимается, только когда кадр выходит
// из окна, — вернётся в окно, будет готовиться заново.
const PREFETCH_DONE = new Set();

function prefetchOrder(center) {
  return ZnadaViewerPrefetch.plan(center, VIEWER.items.length, PREFETCH.direction);
}

async function prefetchIndex(index) {
  if (VIEWER.closed) return;
  if (WARM.has(index) || PREFETCHING.has(index)) return;
  const entry = VIEWER.items[index];
  if (!entry || isVideoEntry(entry)) return;
  const epoch = VIEWER.payloadEpoch;
  const job = { warm: null };
  // The normalized entry object is stable for the payload, even if its action
  // state changes. An index or provider ID alone can be reused by a new gallery.
  const active = () => epoch === VIEWER.payloadEpoch && VIEWER.items[index] === entry
    && PREFETCHING.get(index) === job;
  PREFETCHING.set(index, job);
  try {
    // PERF-011. Адрес уже известен (кадр видели или готовили раньше) — берём его: тот же
    // файл придёт из кеша браузера, и останется только раскодировать. Иначе — дешёвая
    // промежуточная ступень (booru), а без неё оригинал (Wallhaven, свои файлы).
    const cached = IMG_CACHE.get(index) || {};
    let tier = cached.full ? 'full' : (cached.sample ? 'sample' : '');
    let src = tier ? cached[tier] : '';
    if (!src) {
      tier = 'sample';
      src = await sampleSource(entry);
      if (!active()) return;
      if (!src) { tier = 'full'; src = await fullSource(entry, ''); }
      if (!active() || !src) return;
      cacheTier(index, tier, src);
      if (IMG_CACHE.get(index)?.[tier] !== src) return;
    }
    const warm = job.warm = new Image();
    warm.src = src;
    if (warm.decode) await warm.decode();
    if (!active()) return;
    // Раскодированный кадр держим, только если он недорог: исполин в сотни мегабайт
    // вытеснил бы всех соседей. Тогда остаётся файл в кеше браузера — тоже выигрыш.
    const bytes = ZnadaViewerPrefetch.decodedBytes(warm.naturalWidth, warm.naturalHeight);
    job.warm = null;
    if (ZnadaViewerPrefetch.worthKeeping(bytes)) {
      WARM.set(index, { img: warm, bytes });
      trimWarm();
    } else {
      warm.removeAttribute('src');
    }
  } catch {
    // Prefetch is best-effort; failures just mean a normal load on navigation.
  } finally {
    if (active()) {
      PREFETCHING.delete(index);
      pumpPrefetch();
    }
  }
}

// Выбросить готовые кадры вне окна и сверх бюджета; текущий — первым по приоритету.
function trimWarm() {
  const order = PREFETCH.center < 0 ? [] : [PREFETCH.center, ...prefetchOrder(PREFETCH.center)];
  const held = [...WARM].map(([index, item]) => ({ index, bytes: item.bytes }));
  for (const index of ZnadaViewerPrefetch.evict(held, order)) {
    WARM.get(index)?.img.removeAttribute('src');
    WARM.delete(index);
  }
}

// Новое текущее фото. Запросы вне нового окна отменяются (их уход обрывает загрузку, как в
// BUG-027), готовые вне окна выбрасываются, новые запросы ждут, пока у текущего не будет кадра.
function retargetPrefetch(center) {
  PREFETCH.center = center;
  PREFETCH.hold = true;
  const keep = new Set([center, ...prefetchOrder(center)]);
  for (const [index, job] of [...PREFETCHING]) {
    if (keep.has(index)) continue;
    job.warm?.removeAttribute('src');
    PREFETCHING.delete(index);
  }
  for (const index of [...PREFETCH_DONE]) {
    if (!keep.has(index)) PREFETCH_DONE.delete(index);
  }
  trimWarm();
}

// Ставить в работу следующих по очереди, пока не занято PARALLEL мест.
function pumpPrefetch() {
  if (VIEWER.closed || PREFETCH.hold || PREFETCH.center < 0) return;
  for (const index of prefetchOrder(PREFETCH.center)) {
    if (PREFETCHING.size >= ZnadaViewerPrefetch.PARALLEL) return;
    if (PREFETCH_DONE.has(index) || PREFETCHING.has(index) || WARM.has(index)) continue;
    PREFETCH_DONE.add(index);
    prefetchIndex(index);
  }
}

// У текущего фото есть кадр — можно готовить соседей.
function prefetchNeighbors(center) {
  if (center !== PREFETCH.center) return;
  PREFETCH.hold = false;
  pumpPrefetch();
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
  // DESIGN-008. A download takes seconds, and a button that merely went grey for that
  // long read as a frozen app. While this picture is being added — however the add was
  // started: the button, the menu or "Assign" — the button says so and takes no second
  // click. Numbers are not shown: the download is read in one piece, nothing counts it.
  const adding = !!entry.adding && !entry.added;
  add.classList.toggle('busy', adding);
  add.setAttribute('aria-busy', adding ? 'true' : 'false');
  if (adding) {
    add.textContent = '';
    const spin = document.createElement('span');
    spin.className = 'spin';
    spin.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = t('online.adding');
    add.appendChild(spin);
    add.appendChild(label);
  } else {
    // Added but unidentifiable: an honest dead end is better than a button that would
    // remove the wrong thing. In practice this only happens if the add reported no record.
    add.textContent = t(entry.added ? (removable ? 'online.remove' : 'online.added') : 'online.add');
  }
  add.classList.toggle('suggested', !entry.added);
  add.classList.toggle('danger', removable);
  add.disabled = adding || (!!entry.added && !removable);
}

// The Library tab already offers Undo in its toast. The fullscreen viewer is a
// separate document, so it needs its own small, transient notice rather than trying
// to reach into the main window's DOM. Only one notice is live at a time because main
// intentionally keeps only the latest removal snapshot.
// `deadline` is the clock of an Undo notice (LIB-021); a plain notice uses `timer`.
const VIEWER_NOTICE = { element: null, timer: null, deadline: null };

function stopViewerNoticeClock() {
  clearTimeout(VIEWER_NOTICE.timer);
  VIEWER_NOTICE.timer = null;
  if (VIEWER_NOTICE.deadline) VIEWER_NOTICE.deadline.cancel();
  VIEWER_NOTICE.deadline = null;
}

function dismissViewerNotice() {
  stopViewerNoticeClock();
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
  // Ordinary/action notices share layout with persistent operation notices. Their
  // replacement/Undo clocks still own only VIEWER_NOTICE, never the lookup rows.
  const target = $('#notificationStack') || root;
  target.appendChild(element);
  VIEWER_NOTICE.element = element;
  return { element, text };
}

function finishViewerNotice(notice, message, delay = 2400) {
  if (!notice || VIEWER_NOTICE.element !== notice.element) return;
  notice.element.textContent = '';
  notice.text = document.createElement('span');
  notice.text.textContent = message;
  notice.element.appendChild(notice.text);
  stopViewerNoticeClock();
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
    stopViewerNoticeClock();

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
  // LIB-021: 8 seconds with a line the cursor or focus pauses (renderer/undo-deadline.js).
  VIEWER_NOTICE.deadline = UndoDeadline.attach(notice.element, document, {
    onExpire: () => {
      if (VIEWER_NOTICE.element !== notice.element) return;
      VIEWER_NOTICE.deadline = null;
      dismissViewerNotice();
    },
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id),
  });
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
const VIEWER_ACTIONS = ['add', 'assign', 'favorite', 'lookupMeta', 'saveAs', 'copyFile', 'copyLink', 'openSource', 'remove'];

function viewerSubjectFor(entry) {
  if (!entry) return null;
  const pooled = entry.added && entry.pooled ? entry.pooled : null;
  if (entry.kind === 'internet') return CardActions.internetSubject(entry.raw, pooled);
  if (entry.kind === 'cloud') return CardActions.cloudSubject(entry.raw, pooled);
  // A local picture: the pool record if the payload carried one, otherwise just a file.
  return CardActions.localSubject({ path: entry.path, type: 'image', id: pooled ? pooled.id : '' }, pooled);
}

// BUG-035. The viewer is where a moving picture is actually seen moving, so it is where
// "the desktop will show its first frame" matters most. A site card says so itself; a
// file on the disk is asked of main, which reads it under the same authority that gives
// this window the file's address.
async function viewerEntryMoves(entry) {
  if (!entry || !window.MotionBadge) return false;
  if (entry.kind === 'internet') return !!window.MotionBadge.fromSite(entry.raw);
  if ((entry.kind === 'library' || entry.kind === 'path') && entry.path) {
    try { return !!window.MotionBadge.fromLocal(await window.viewerApi.mediaMotion(entry.path)); }
    catch { return false; }
  }
  return false;
}

// The monitor chooser, drawn by the same module the main window uses. Its data comes
// from main because this window holds no config of its own.
async function openViewerAssign(entry, descriptor, point) {
  const token = VIEWER.token;
  // Asked side by side, so the chooser opens no later than it did before.
  const [targets, moving] = await Promise.all([
    Promise.resolve().then(() => window.viewerApi.cardAssignTargets()).catch(() => null),
    viewerEntryMoves(entry),
  ]);
  if (VIEWER.closed || token !== VIEWER.token || currentEntry() !== entry) return;
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
      if (!id && (entry.kind === 'library' || entry.kind === 'path' || (entry.pooled && entry.pooled.path))) {
        // A local photo needs a record, not a download. Sending it down the online add
        // path asked main to fetch a file already on the disk, and main answered
        // 'badItem' over a picture the user was looking at full-screen.
        const made = await ensureViewerRecord(entry);
        id = made.id;
        if (!id) { showViewerMessage(viewerFailureText(made.error, 'library.assignMissingToast')); return; }
      }
      if (!id) {
        showViewerMessage(t('card.downloading'), 20000);
        id = await addViewerCardToLibrary(entry, descriptor);
        if (!id) return;   // the add reports its own failure
      }
      let res;
      try { res = await window.viewerApi.libraryAssign(id, monitorId, theme); }
      catch { res = null; }
      showViewerMessage(res && res.ok !== false
        ? t('library.assignedToast')
        : viewerFailureText(res && res.error, 'library.assignMissingToast'));
    },
  });
  if (moving) window.MotionBadge.appendFirstFrameNote(pop, t);

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
  VIEWER_POPUP.timer = setTimeout(() => {
    VIEWER_POPUP.timer = null;
    document.addEventListener('mousedown', dismiss, true);
  }, 0);
}

const VIEWER_POPUP = { element: null, dismiss: null, timer: null };

function closeViewerPopup() {
  if (VIEWER_POPUP.timer !== null) clearTimeout(VIEWER_POPUP.timer);
  VIEWER_POPUP.timer = null;
  if (VIEWER_POPUP.dismiss) document.removeEventListener('mousedown', VIEWER_POPUP.dismiss, true);
  VIEWER_POPUP.dismiss = null;
  if (VIEWER_POPUP.element) VIEWER_POPUP.element.remove();
  VIEWER_POPUP.element = null;
}

// One place this window turns an online card into a library record, so the menu and
// the action button cannot disagree about what "added" means.
//
// DESIGN-008. The add belongs to the picture, not to the button. The button is rebuilt on
// every step through the gallery, so a download started here must still show, and still
// refuse a second click, when the user comes back to this picture. The menu's "Add" or
// "Assign" pressed meanwhile waits for the same download instead of starting another.
function addViewerCardToLibrary(entry, descriptor) {
  if (entry.adding) return entry.adding;
  const run = (async () => {
    try { return await downloadViewerCard(entry, descriptor); }
    finally {
      entry.adding = null;
      syncCurrentAddAction(entry);
    }
  })();
  entry.adding = run;
  syncCurrentAddAction(entry);
  return run;
}

async function downloadViewerCard(entry, descriptor) {
  let res;
  try {
    if (descriptor.kind === 'internet' && isVideoEntry(entry)) {
      res = await getViewerVideoDownloads().download(entry.raw, entry.query || '', () => {
        if (currentEntry() === entry) viewerVideoDownloads.sync($('#viewerActions'), entry.raw);
      });
    } else {
      res = descriptor.kind === 'cloud'
        ? await window.viewerApi.cloudAdd(entry.raw)
        : await window.viewerApi.internetAdd(entry.raw, entry.query || '');
    }
  } catch { res = { error: 'download' }; }
  if (res?.error === 'cancelled') return '';
  if (!res || res.error) {
    showViewerMessage(CardTransfer.errorMessage(t, res && res.error));
    return '';
  }
  entry.added = true;
  entry.pooled = res.id ? { id: res.id, path: '', type: 'image' } : null;
  // On screen the button itself turns into "Remove". If the user has moved on to another
  // picture, nothing on screen would say that this one made it.
  if (currentEntry() !== entry) showViewerMessage(t('online.added'));
  return res.id || '';
}

async function openViewerCardMenu(entry, point) {
  const subject = viewerSubjectFor(entry);
  if (!subject) return;
  const descriptor = CardActions.descriptorFor(subject);
  let favorite;
  try { favorite = await window.viewerApi.favoriteState(descriptor); } catch { favorite = { on: false }; }
  if (currentEntry() !== entry) return;
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
    favorite: async () => {
      if (subject.kind === 'local' && !subject.id) {
        const ensured = await ensureViewerRecord(entry);
        if (!ensured.id) { showViewerMessage(viewerFailureText(ensured.error, 'library.assignMissingToast')); return; }
      }
      const card = CardActions.descriptorFor(viewerSubjectFor(entry));
      try {
        const state = await window.viewerApi.favoriteState(card);
        const result = await window.viewerApi.favoriteSet({ ...card, owner: state.owner }, !state.on);
        if (result?.error) showViewerMessage(CardTransfer.errorMessage(t, result.error));
      } catch { showViewerMessage(t('bookmarks.writeFailed')); }
    },
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
    labelFor: (action) => t(action.id === 'favorite' && favorite.on ? 'library.favoriteRemove' : action.labelKey),
    onPick: (action) => { const run = handlers[action.id]; if (run) run(); },
  });
}

// The viewer's equivalent of ensurePoolItemForRecord in the main window: the pool record
// if there is one, and otherwise one made NOW, because the user has actually asked. The
// registry offers lookup and remove for a local photo whether or not it has a record
// (card-actions.js, and the comment above `lookupMeta` says why); this is what makes that
// true here instead of only in the grid.
//
// Answers `{ id, error }`: with no id, the caller needs to know whether main refused
// (DATA-009, a move is running) or there simply is no record to make.
async function ensureViewerRecord(entry) {
  const none = { id: '', error: '' };
  if (!entry) return none;
  if (entry.pooled && entry.pooled.id) return { id: entry.pooled.id, error: '' };
  // LIB-031. An online card the user already has as a file in their folder: that file is
  // the photo, and it gets its record the way the same photo in the Library would.
  const own = entry.pooled && entry.pooled.path ? entry.pooled.path : '';
  if (!own && entry.kind !== 'library' && entry.kind !== 'path') return none;
  const filePath = own || entry.path;
  if (!filePath) return none;
  let res;
  try { res = await window.viewerApi.cardEnsureRecord(filePath, 'image'); }
  catch { return none; }
  const id = (res && res.id) || '';
  // The same bookkeeping addViewerCardToLibrary does after an add, so the menu and the
  // action button cannot disagree about what this entry now is.
  if (id) { entry.added = true; entry.pooled = { id, path: filePath, type: 'image' }; }
  return { id, error: (res && res.error) || '' };
}

// DATA-009. While Znada moves its files the main window sits behind its own modal, but
// this window keeps taking clicks. A refusal met then says why, rather than "file is no
// longer available" or "could not check" over a photo that is perfectly fine.
function viewerFailureText(error, fallbackKey) {
  return error === 'media_move_running' ? CardTransfer.errorMessage(t, error) : t(fallbackKey);
}

// META-001 from the fullscreen view. The same shared operation the main window runs —
// the picture on screen is the same picture, so looking it up must be the same act and
// not a second implementation that drifts.
//
// Nothing on this screen displays tags, so there is nothing to redraw afterwards; the
// updated record reaches the library grid through the ordinary config broadcast.
async function lookupViewerCardMetadata(entry) {
  const made = await ensureViewerRecord(entry);
  // Never a bare return. card-metadata.js exists because a lookup that answers with
  // silence is one the user concludes is broken, and this was the one path in the app
  // that bypassed it entirely: the menu offered the action and the click did nothing.
  if (!made.id) { showViewerMessage(viewerFailureText(made.error, 'card.lookupFailed')); return null; }
  return CardMetadata.run({
    bridge: window.viewerApi,
    id: made.id,
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

function getViewerVideoDownloads() {
  return viewerVideoDownloads ||= window.createOnlineVideoDownloads(window.viewerApi, t);
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
    if (!entry.added) {
      // Re-adding is a new decision. Leaving an older Undo action on screen would make
      // it unclear whether the user is undoing the removal or the fresh add.
      dismissViewerNotice();
      // The add keeps its own state on the entry (see addViewerCardToLibrary): this
      // button may be rebuilt several times before the download is done.
      await addViewerCardToLibrary(entry, CardActions.descriptorFor(viewerSubjectFor(entry)));
      return;
    }
    add.disabled = true;
    await removeViewerCard(entry);
    add.disabled = false;
    syncAddAction(entry, add);
  });
  actions.appendChild(add);
  if (entry.kind === 'internet' && isVideoEntry(entry)) getViewerVideoDownloads().sync(actions, entry.raw);
}

function updateResolutionInSubtitle(width, height, entry) {
  if (!width || !height || !entry) return;

  const resStr = `${width}x${height}`;
  const titleText = (entry.title || '').trim();
  const baseSubtitle = (entry.subtitle || '').trim();

  // If the title or the original base subtitle already contains a resolution pattern,
  // we do not need to append any temporary or loaded resolutions.
  const hasOriginalRes = /\d+\s*[x×]\s*\d+/.test(titleText) || /\d+\s*[x×]\s*\d+/.test(baseSubtitle);

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
  PREFETCH.direction = ZnadaViewerPrefetch.direction(delta); // PERF-011: больше готовим по ходу
  render();
}

/*
 * BUG-065. The sample tier of a moving picture is a still JPEG. The viewer used to drop
 * "loading full quality" as soon as the sample was up, which is right for a photo (the
 * sample already looks like the photo) and wrong for a GIF: the picture stood still with
 * no word that the moving original was still on its way, and it read as "stopped loading".
 * For a picture the site declares moving, the note stays until the original is up.
 */
function sampleIsStillStandIn(entry) {
  return !!(entry && entry.kind === 'internet' && window.MotionBadge
    && window.MotionBadge.fromSite(entry.raw));
}

async function render() {
  const endNavigate = diagSpan('viewer', 'navigate'); // budget span #15
  try { return await renderCore(); } finally { endNavigate(); }
}

async function renderCore() {
  if (VIEWER.closed) return;
  const entry = currentEntry();
  const token = ++VIEWER.token;
  if (VIDEO) VIDEO.stop(token - 1);
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
  retargetPrefetch(VIEWER.index); // PERF-011

  if (!STAGE.front) return;
  const idx = VIEWER.index;
  const hadImage = stageHasImage();
  resetZoom(); // each photo opens fit-to-screen; showImage re-applies on the new layer
  setStageAlt(entry && entry.title);
  setHd(false);
  if (isVideoEntry(entry)) {
    clearStage(); applyStageAspect(entry); clearLoadingTimer(); setState(t('video.loading'));
    for (const layer of [BG.front, BG.back]) { if (layer) layer.removeAttribute('src'); }
    if ($('#viewerBg')) $('#viewerBg').style.background = '';
    if (!VIDEO) VIDEO = window.ZnadaViewerVideo({ window, document, api: window.viewerApi, t,
      onFirstFrame(width, height, poster) {
        clearLoadingTimer(); setState('');
        if (poster) updateBackgroundFromSrc(poster);
        applyStageAspect({ ...currentEntry(), raw: { width, height } });
        updateResolutionInSubtitle(width, height, currentEntry());
        if (renderFirstFrameEnd) { renderFirstFrameEnd(); renderFirstFrameEnd = null; }
        if (renderFullEnd) { renderFullEnd(); renderFullEnd = null; }
      },
      onError() {
        clearLoadingTimer(); setLoadError(t('video.playbackFailed'), () => render());
        if (currentEntry()?.kind === 'internet') return;
        const external = document.createElement('button'); external.type = 'button'; external.className = 'media-action';
        external.textContent = t('video.openExternal');
        external.addEventListener('click', async () => { const result = await VIDEO.external(); if (!result?.ok) setState(t('video.openFailed')); });
        $('#viewerState').appendChild(external);
      },
    });
    VIDEO.show(VIEWER.index, token);
    return;
  }
  // Keep the previous frame on screen while the next one decodes (no black flash),
  // and only surface the "Loading…" pill if the load is actually slow. On first
  // open there is nothing to keep, so show it immediately.
  scheduleLoadingPill(token, hadImage ? LOADING_PILL_DELAY : 0);

  const cached = IMG_CACHE.get(idx) || {};
  let shown = false; // is a sample-or-better frame already on screen?

  // 1) Show the best cached tier instantly (full preferred, else the sample).
  if (cached.full) {
    const full = cached.full;
    const presented = await present(full, token, entry);
    if (token !== VIEWER.token) return;
    if (presented) {
      if (renderFullEnd) { renderFullEnd({ status: 'cached' }); renderFullEnd = null; } // budget span #14
      prefetchNeighbors(idx);
      return;
    }
    if (cached.full === full) dropCachedTier(idx, 'full', cached);
  }
  if (cached.sample) {
    const sample = cached.sample;
    const presented = await present(sample, token, entry);
    if (token !== VIEWER.token) return;
    if (presented) {
      shown = true;
      if (token === VIEWER.token && sampleIsStillStandIn(entry)) setHd(true); // BUG-065
      // PERF-011. Кадр уже на экране — соседей готовим, не дожидаясь оригинала. Прежде
      // предзагрузка ждала полного качества и при быстром листании не начиналась вовсе.
      prefetchNeighbors(idx);
    } else if (cached.sample === sample) { dropCachedTier(idx, 'sample', cached); }
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
      if (token !== VIEWER.token) return;
      cacheTier(idx, 'sample', sample);
      shown = true;
      // BUG-065: a moving picture's sample is a still; keep the note until the original.
      if (token === VIEWER.token) setHd(sampleIsStillStandIn(entry));
      prefetchNeighbors(idx); // PERF-011
    }
    if (token !== VIEWER.token) return;
  }

  // 3) Upgrade to the original full in the background — silent (crossfade hides it).
  let full = '';
  try { full = await fullSource(entry, ''); } catch {}
  if (token !== VIEWER.token) return;
  const currentSrc = STAGE.front && STAGE.front.getAttribute('src');
  if (full && full !== currentSrc && await present(full, token, entry)) {
    if (token !== VIEWER.token) return;
    cacheTier(idx, 'full', full);
    if (renderFullEnd) { renderFullEnd({ status: 'upgraded' }); renderFullEnd = null; } // budget span #14
  }
  if (token !== VIEWER.token) return;
  setHd(false);
  // Все источники испробованы. Если на сцене так ничего и нет — это настоящая ошибка,
  // и о ней надо сказать. Раньше об этом сообщал провал показа миниатюры, но теперь
  // пропуск миниатюры законен, и единственный честный признак — пустая сцена.
  if (!stageHasImage()) {
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
  window.addEventListener('pagehide', destroyViewer, { once: true });
  const close = $('#viewerClose');
  if (close) close.addEventListener('click', closeViewer);
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
  const toggleFullscreen = async () => {
    const r = await window.viewerApi.toggleFullscreen();
    if (r && typeof r.fullscreen === 'boolean') setFullscreenUi(r.fullscreen);
  };
  if (fullscreen) fullscreen.addEventListener('click', () => {
    // Drop focus so the next arrow-key press doesn't paint a focus ring on the button.
    fullscreen.blur();
    void toggleFullscreen();
  });
  const prev = $('#viewerPrev');
  if (prev) prev.addEventListener('click', () => { step(-1); prev.blur(); });
  const next = $('#viewerNext');
  if (next) next.addEventListener('click', () => { step(1); next.blur(); });
  if (root) {
    root.addEventListener('wheel', (e) => {
      if (e.target.closest('.media-video-controls')) return;
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
        // MEDIA-008: a press on the moving picture is play/pause, as in every player.
        // The backdrop around it still closes the viewer, as it does for a photo.
        if (VIDEO && VIDEO.click(e.target)) return;
        if (ZOOM.scale > 1) { resetZoom(); applyZoom(); } // click while zoomed → fit
        else closeViewer();                               // click while fit → close
      }
    });
    // MEDIA-008: the two presses already toggled play/pause there and back, so the
    // video keeps doing what it did and only the window changes.
    root.addEventListener('dblclick', (e) => {
      if (VIDEO && VIDEO.owns(e.target)) void toggleFullscreen();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (VIDEO && VIDEO.key(e)) return;
    if (e.key !== 'Escape' && e.target && e.target.closest('input,select,textarea')) return;
    // MEDIA-008: F is fullscreen for whatever is open. By physical key, so it works on
    // any keyboard layout; never with a modifier and never while a menu is open.
    if (e.code === 'KeyF' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat
      && !document.querySelector('.lib-popup') && !(e.target && e.target.closest('button'))) {
      e.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeViewer();
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
  const epoch = VIEWER.payloadEpoch;
  const payload = await window.viewerApi.getPayload();
  if (epoch === VIEWER.payloadEpoch) setPayload(payload);
}

init();
