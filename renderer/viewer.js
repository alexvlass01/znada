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

// Crossfade a {front, back} layer pair to a new (already-decoded) src. The NEW
// image is placed at the bottom at full opacity instantly; the OLD one fades OUT
// on top to reveal it. So coverage is always 100% (no mid-fade dim), AND the old
// image is gone the instant its fade-out ends — it can never linger in the new
// image's letterbox margins. (The earlier "fade the new in on top" approach left
// the old fully opaque underneath, showing through the margins until it was
// hidden/reused — that was the lingering-previous-image bug.)
function crossfadeTo(pair, src) {
  const incoming = pair.back;   // new image — revealed instantly at the bottom
  const outgoing = pair.front;  // current image — fades out on top to uncover the new
  if (!incoming) return;
  incoming.style.transition = 'none';
  incoming.style.zIndex = '1';
  incoming.src = src;
  incoming.style.opacity = '1';
  if (outgoing) {
    outgoing.style.transition = ''; // CSS opacity transition drives the fade-out
    outgoing.style.zIndex = '2';
    void outgoing.offsetWidth;      // commit current opacity/transition before fading
    outgoing.style.opacity = '0';
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

function showImage(src) {
  crossfadeTo(STAGE, src);
  applyZoom(); // carry the current zoom/pan onto the freshly shown layer
  updateBackgroundFromSrc(src);
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

function setState(message, hidden = false) {
  const state = $('#viewerState');
  if (!state) return;
  state.textContent = message || '';
  state.hidden = hidden || !message;
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
    try {
      const result = await window.viewerApi.internetThumbnail(item);
      if (result && result.dataUrl) return result.dataUrl;
    } catch {}
    return thumb || '';
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
    // Wallhaven loads directly; booru hosts (e.g. Gelbooru hotlink.php) need a Referer
    // the renderer can't send, so fetch the full image through main as a data URL.
    if (item.provider && item.provider !== 'wallhaven') {
      try {
        const r = await window.viewerApi.internetFull(item);
        if (r && r.dataUrl) return r.dataUrl;
      } catch {}
    }
    return direct || fallback;
  }
  return fallback || entry.previewUrl || '';
}

// Intermediate "sample" tier — only booru items carry a same-host downscale.
// Fetched through main (referer-gated) as a data URL, like the full image.
async function sampleSource(entry) {
  if (!entry || entry.kind !== 'internet') return '';
  const item = entry.raw || {};
  if (!item.sample || !item.provider || item.provider === 'wallhaven') return '';
  try {
    const r = await window.viewerApi.internetSample(item);
    if (r && r.dataUrl) return r.dataUrl;
  } catch {}
  return '';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) { reject(new Error('empty')); return; }
    const probe = new Image();
    probe.onload = () => resolve({ src, width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => reject(new Error('load'));
    probe.src = src;
  });
}

// Decode then crossfade a resolved src onto the stage. Returns false on failure
// or if the render was superseded (token changed), so callers can react.
async function present(src, token, entry) {
  try {
    const loaded = await loadImage(src);
    if (token !== VIEWER.token) return false;
    showImage(loaded.src);
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

function markAdded(entry) {
  if (!entry) return;
  entry.added = true;
  const actions = $('#viewerActions');
  const add = actions && actions.querySelector('[data-action="add"]');
  if (add) {
    add.textContent = t('online.added');
    add.disabled = true;
  }
}

function renderActions(entry) {
  const actions = $('#viewerActions');
  if (!actions) return;
  actions.innerHTML = '';
  if (!entry || (entry.kind !== 'cloud' && entry.kind !== 'internet')) return;

  const add = document.createElement('button');
  add.className = 'media-action suggested';
  add.dataset.action = 'add';
  add.textContent = entry.added ? t('online.added') : t('online.add');
  add.disabled = !!entry.added;
  add.addEventListener('click', async () => {
    if (add.disabled) return;
    add.disabled = true;
    let res;
    try {
      res = entry.kind === 'cloud'
        ? await window.viewerApi.cloudAdd(entry.raw)
        : await window.viewerApi.internetAdd(entry.raw, entry.query || '');
    } catch {
      res = { error: 'download' };
    }
    if (res && !res.error) {
      markAdded(entry);
    } else {
      add.disabled = false;
      add.textContent = t('online.add');
      setState(t('online.error', { e: (res && res.error) || '?' }));
    }
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
    if (!preview || !(await present(preview, token, entry))) {
      if (token !== VIEWER.token) return;
      clearLoadingTimer();
      clearStage();
      setState(t('viewer.loadError'));
      return;
    }
    // Badge only while we're still on the low-res thumbnail; hide it once the
    // sample (already good quality) is up — no badge during the sample->full swap.
    if (entry.kind === 'internet') setHd(true);
    let sample = '';
    try { sample = await sampleSource(entry); } catch {}
    if (token !== VIEWER.token) return;
    if (sample && await present(sample, token, entry)) {
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
  prefetchNeighbors(idx);
}

function initEvents() {
  const close = $('#viewerClose');
  if (close) close.addEventListener('click', () => window.viewerApi.close());
  const root = $('#viewerRoot');
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
      POINTER.blocked = !!e.target.closest('button');
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
      if (POINTER.button !== 0 || POINTER.blocked || e.button !== 0 || e.target.closest('button')) return;
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
