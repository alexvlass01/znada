'use strict';

/*
 * MEDIA-008. Everything the person sees and presses while a video is open in the viewer.
 * Playback itself (decoder, its process, frame transport) is MEDIA-003 and is not decided
 * here: this file only sends the same four commands (pause, seek, volume, stop) and paints
 * what the decoder reports back.
 *
 * The rules that are easy to break:
 *  - a reported position or volume may be OLDER than what the person just asked for, so a
 *    request is held on screen until the decoder confirms it (or a deadline passes);
 *  - the panel hides only while the video is actually playing and nobody is using it;
 *  - plain Left/Right stay "previous/next file", as for photos: the viewer is a gallery.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.ZnadaViewerVideo = factory;
}(typeof window === 'object' ? window : globalThis, function createViewerVideo({ window, document, api, t, onFirstFrame, onError,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const IDLE_MS = 2600;        // the panel leaves this long after the last movement
  const SEEK_GAP_MS = 120;     // while dragging, at most one seek per this interval
  const SEEK_HOLD_MS = 1500;   // how long a requested position outranks a reported one
  const VOLUME_RETRY_MS = 400; // a volume sent before the decoder was ready is sent again
  const THUMB = 14;            // px, the timeline handle: its centre stops this/2 short of each end
  const TIP_EDGE = 12;         // px the time label may reach past the timeline's own ends
  const SOUND_KEY = 'znada.viewer.videoSound';
  // Anything here under the pointer (or holding focus) keeps the panel on screen.
  const CHROME = '.media-video-controls, .media-topbar, .media-nav, .media-fullscreen, .media-notice, .lib-popup';
  const svg = body => `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  const line = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  const ICON_PLAY = '<path class="i-play" d="M5.1 3.3v9.4a.7.7 0 0 0 1.07.6l7.2-4.7a.7.7 0 0 0 0-1.2l-7.2-4.7a.7.7 0 0 0-1.07.6Z" fill="currentColor"/>';
  const ICON_PAUSE = '<path class="i-pause" d="M4.6 2.9h1.5a.8.8 0 0 1 .8.8v8.6a.8.8 0 0 1-.8.8H4.6a.8.8 0 0 1-.8-.8V3.7a.8.8 0 0 1 .8-.8Zm5.3 0h1.5a.8.8 0 0 1 .8.8v8.6a.8.8 0 0 1-.8.8H9.9a.8.8 0 0 1-.8-.8V3.7a.8.8 0 0 1 .8-.8Z" fill="currentColor"/>';
  const ICON_REPLAY = `<g class="i-replay" ${line}><path d="M3.4 8.6a4.7 4.7 0 1 0 1.2-3.7"/><path d="M3.1 2.5v2.9H6"/></g>`;
  const ICON_SOUND = '<path d="M2.4 6.3h1.9l2.9-2.5a.5.5 0 0 1 .8.4v7.6a.5.5 0 0 1-.8.4L4.3 9.7H2.4a.6.6 0 0 1-.6-.6V6.9a.6.6 0 0 1 .6-.6Z" fill="currentColor"/>'
    + `<path class="i-wave1" d="M10.1 6.2a2.6 2.6 0 0 1 0 3.6" ${line}/><path class="i-wave2" d="M11.9 4.4a5.1 5.1 0 0 1 0 7.2" ${line}/>`
    + `<path class="i-muted" d="m10.4 6.3 3.4 3.4m0-3.4-3.4 3.4" ${line}/>`;

  let generation = 0, canvas = null, controls = null, guard = null, flash = null, first = false, failed = false;
  let play, seek, tip, clock, sound, level;
  let paused = false, ended = false, duration = 0, position = 0;
  let seeking = false, seekHold = null, seekSent = 0, seekTimer = null;
  let volume = 100, lastVolume = 100, muted = false, volumeWanted = false, volumeTried = 0;
  let idleTimer = null, overChrome = false, pointerX = -1, pointerY = -1;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const viewer = () => document.querySelector('#viewerRoot');
  const time = value => {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const tail = `${Math.floor(seconds / 60) % 60}:${String(seconds % 60).padStart(2, '0')}`;
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${tail.padStart(5, '0')}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  // The level the person left is theirs to keep: without it every video starts at full
  // volume again. Window storage, not config: it is a convenience of this one window, and
  // losing it costs nothing — the player then opens with sound, as on first use.
  try {
    const saved = JSON.parse(window.localStorage.getItem(SOUND_KEY) || 'null');
    if (saved && Number.isFinite(saved.level)) { lastVolume = clamp(Math.round(saved.level), 1, 100); muted = saved.muted === true; }
  } catch { /* no storage: defaults */ }
  function saveSound() {
    try { window.localStorage.setItem(SOUND_KEY, JSON.stringify({ level: lastVolume, muted })); } catch { /* optional */ }
  }

  function command(action, value) {
    if (!generation) return Promise.resolve({ ok: false });
    const request = { action, generation };
    if (value !== undefined) request.value = value;
    return Promise.resolve(api.videoCommand(request)).catch(() => ({ ok: false }));
  }
  const live = () => !!generation && first && !failed;

  // ---- the panel comes and goes ------------------------------------------------------------
  function busy() {
    const active = document.activeElement;
    return seeking || overChrome || !!document.querySelector('.lib-popup')
      || !!(active && active.closest && active.closest(`${CHROME}, input, textarea, select`));
  }
  function wake() {
    viewer().classList.remove('video-idle');
    clearTimer(idleTimer); idleTimer = null;
    if (live() && !paused) idleTimer = setTimer(sleep, IDLE_MS);
  }
  function sleep() {
    idleTimer = null;
    if (!live() || paused) return;
    if (busy()) { idleTimer = setTimer(sleep, IDLE_MS); return; }
    viewer().classList.add('video-idle');
  }
  function pointer(event) {
    // Chromium re-sends a move when the layout under a still pointer changes; only a real
    // movement may bring the panel back, or it would never stay hidden.
    if (event.type === 'pointermove' && event.clientX === pointerX && event.clientY === pointerY) return;
    pointerX = event.clientX; pointerY = event.clientY;
    overChrome = !!(event.target && event.target.closest && event.target.closest(CHROME));
    wake();
  }
  document.addEventListener('pointermove', pointer);
  document.addEventListener('pointerdown', pointer);
  document.addEventListener('wheel', () => wake(), { passive: true });
  document.addEventListener('keydown', () => wake(), true);
  document.documentElement.addEventListener('pointerleave', () => { overChrome = false; });

  // ---- painting ----------------------------------------------------------------------------
  function paint() {
    if (!controls) return;
    play.setAttribute('data-state', ended ? 'ended' : paused ? 'paused' : 'playing');
    play.title = t(paused ? 'video.play' : 'video.pause'); play.setAttribute('aria-label', play.title);
    seek.max = String(duration); seek.disabled = !(duration > 0);
    seek.value = String(position);
    seek.style.setProperty('--p', duration > 0 ? (position / duration).toFixed(4) : '0');
    clock.textContent = `${time(position)} / ${time(duration)}`;
    seek.setAttribute('aria-valuetext', clock.textContent);
    level.value = String(volume);
    level.style.setProperty('--p', (volume / 100).toFixed(2));
    sound.setAttribute('data-level', volume === 0 ? 'off' : volume < 50 ? 'low' : 'high');
    sound.title = t(volume ? 'video.mute' : 'video.unmute'); sound.setAttribute('aria-label', sound.title);
  }
  function pulse(icon) {
    if (!flash) return;
    flash.setAttribute('data-icon', icon);
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on'); // restart the animation
  }

  // ---- what the person can do ----------------------------------------------------------------
  function togglePlay(show) {
    if (show) pulse(paused ? 'play' : 'pause');
    void command('pause');
  }
  function sendVolume() { volumeWanted = true; volumeTried = now(); void command('volume', volume); }
  function setVolume(value) {
    volume = clamp(Math.round(Number(value) || 0), 0, 100);
    muted = volume === 0; if (volume) lastVolume = volume;
    sendVolume(); saveSound(); paint();
  }
  function toggleMute() { setVolume(volume ? 0 : lastVolume); }
  function seekTo(value, final) {
    if (!(duration > 0)) return;
    position = clamp(Number(value) || 0, 0, duration);
    seekHold = { value: position, until: now() + SEEK_HOLD_MS };
    const send = () => { seekTimer = null; if (generation) { seekSent = now(); void command('seek', position); } };
    if (final || now() - seekSent >= SEEK_GAP_MS) { clearTimer(seekTimer); send(); }
    else if (!seekTimer) seekTimer = setTimer(send, SEEK_GAP_MS);
    paint();
  }
  const nudge = seconds => seekTo((seekHold ? seekHold.value : position) + seconds, true);

  function showTip(fraction) {
    const width = seek.getBoundingClientRect().width, span = Math.max(1, width - THUMB);
    tip.textContent = time(fraction * duration);
    // Over the pointer, but never past the window edge: the timeline starts TIP_EDGE
    // from it, and a label like 1:01:47 is wider than that.
    const half = (tip.offsetWidth || 0) / 2 - TIP_EDGE;
    tip.style.left = `${clamp(THUMB / 2 + fraction * span, Math.min(half, width / 2), Math.max(width - half, width / 2))}px`;
    tip.classList.add('on');
    seek.style.setProperty('--h', fraction.toFixed(4));
  }
  function hideTip() { tip.classList.remove('on'); seek.style.setProperty('--h', '0'); }
  function hover(event) {
    if (seeking || !(duration > 0)) return;
    const rect = seek.getBoundingClientRect();
    showTip(clamp((event.clientX - rect.left - THUMB / 2) / Math.max(1, rect.width - THUMB), 0, 1));
  }

  function error() {
    if (!generation || failed) return;
    failed = true;
    for (const node of [canvas, controls, guard, flash]) { if (node) node.hidden = true; }
    // Without a picture there is no player: the viewer looks as it does for a photo.
    clearTimer(idleTimer); idleTimer = null; viewer().classList.remove('has-video', 'video-idle');
    // A canvas failure happens after Electron's transfer promise resolved. Stop sound/
    // decoding explicitly while retaining the authorized entry for the manual fallback.
    void command('abort');
    onError();
  }
  function setPlaybackState(state) {
    play.disabled = sound.disabled = level.disabled = false;
    const wasPaused = paused;
    ended = !!state.ended; paused = !!(state.paused || state.ended);
    duration = Math.max(0, Number(state.duration) || 0);
    const reported = Math.min(duration, state.ended ? duration : Math.max(0, Number(state.time) || 0));
    if (seekHold && (Math.abs(reported - seekHold.value) < 0.35 || now() > seekHold.until)) seekHold = null;
    if (!seeking && !seekHold) position = reported;
    if (Number.isFinite(state.volume)) {
      const actual = clamp(state.volume, 0, 100);
      if (!volumeWanted) { volume = actual; if (volume) lastVolume = volume; }
      else if (Math.abs(actual - volume) < 0.5) volumeWanted = false;
      else if (now() - volumeTried > VOLUME_RETRY_MS) sendVolume();
    }
    paint();
    if (wasPaused !== paused) wake();
  }
  api.onVideoState(state => {
    if (!generation || state.generation !== generation || failed) return;
    if (state.type === 'error') error();
    else if (state.type === 'state') setPlaybackState(state);
  });
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'znada-video-frame') return;
    const { frame, info } = event.data;
    if (!frame || typeof frame.close !== 'function') return;
    try {
      if (!canvas || failed || info?.generation !== generation) return;
      if (canvas.width !== info.width || canvas.height !== info.height) { canvas.width = info.width; canvas.height = info.height; }
      canvas.getContext('2d', { alpha: false }).drawImage(frame, 0, 0);
      canvas.hidden = false;
      if (!first) {
        first = true;
        // One small poster preserves the viewer's ambient/color backdrop. Never read
        // pixels per frame, and a poster failure must not stop playback.
        let poster = '';
        try {
          const preview = document.createElement('canvas'), scale = 96 / Math.max(info.width, info.height);
          preview.width = Math.max(1, Math.round(info.width * scale)); preview.height = Math.max(1, Math.round(info.height * scale));
          preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
          poster = preview.toDataURL('image/jpeg', 0.65);
        } catch { /* optional background only */ }
        onFirstFrame(info.width, info.height, poster);
        wake();
      }
    } catch { error(); }
    finally { frame.close(); }
  });

  function stop(barrier) {
    const old = generation;
    generation = 0; failed = false; first = false; seeking = false; seekHold = null; volumeWanted = false;
    clearTimer(seekTimer); seekTimer = null; clearTimer(idleTimer); idleTimer = null;
    for (const node of [canvas, controls, guard, flash]) { if (node) node.remove(); }
    canvas = controls = guard = flash = null;
    viewer().classList.remove('has-video', 'video-idle');
    const stopGeneration = Math.max(old, Number(barrier) || 0);
    if (stopGeneration > 0) Promise.resolve(api.videoCommand({ action: 'stop', generation: stopGeneration })).catch(() => {});
  }
  function element(tag, className) { const node = document.createElement(tag); node.className = className; return node; }
  function button(className, label, icon, action) {
    const node = element('button', `video-btn ${className}`); node.type = 'button'; node.innerHTML = svg(icon);
    node.title = label; node.setAttribute('aria-label', label); node.disabled = true;
    // Focus goes back to the viewer, or the next Space would press this button again.
    node.addEventListener('click', () => { action(); if (node.blur) node.blur(); });
    return node;
  }
  function range(className, label, max, step) {
    const node = element('input', className); node.type = 'range'; node.min = '0'; node.max = max; node.step = step; node.value = '0';
    node.setAttribute('aria-label', label); node.disabled = true;
    return node;
  }
  function show(index, nextGeneration) {
    generation = nextGeneration; first = false; failed = false;
    paused = ended = false; duration = position = 0; seeking = false; seekHold = null; seekSent = 0;
    volume = muted ? 0 : lastVolume;
    canvas = element('canvas', 'media-image media-video'); canvas.hidden = true;
    canvas.setAttribute('aria-label', t('video.playback')); document.querySelector('#viewerStage').prepend(canvas);

    controls = element('div', 'media-video-controls');
    controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', t('video.controls'));
    const timeline = element('div', 'video-timeline');
    seek = range('video-seek', t('video.seek'), '0', 'any');
    tip = element('div', 'video-tip'); tip.setAttribute('aria-hidden', 'true');
    seek.addEventListener('pointerdown', () => { seeking = true; });
    seek.addEventListener('input', () => {
      seeking = true; seekTo(seek.value, false);
      if (duration > 0) showTip(position / duration);
    });
    seek.addEventListener('change', () => { seeking = false; seekTo(seek.value, true); hideTip(); if (seek.blur) seek.blur(); });
    for (const type of ['pointerup', 'pointercancel', 'blur']) seek.addEventListener(type, () => { seeking = false; });
    seek.addEventListener('pointermove', hover);
    seek.addEventListener('pointerleave', () => { if (!seeking) hideTip(); });
    // A focused slider steps by seconds a person can use, not by its pixel-fine mouse step.
    seek.addEventListener('keydown', event => {
      const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -30, PageUp: 30 }[event.key];
      if (step) nudge(step); else if (event.key === 'Home') seekTo(0, true); else if (event.key === 'End') seekTo(duration, true); else return;
      event.preventDefault(); event.stopPropagation();
    });
    timeline.append(seek, tip);

    const row = element('div', 'video-row');
    play = button('video-play', t('video.pause'), ICON_PLAY + ICON_PAUSE + ICON_REPLAY, () => togglePlay(false));
    const soundBox = element('div', 'video-sound');
    sound = button('video-mute', t('video.mute'), ICON_SOUND, toggleMute);
    level = range('video-volume', t('video.volume'), '100', '1');
    level.addEventListener('input', () => setVolume(level.value));
    level.addEventListener('change', () => { if (level.blur) level.blur(); });
    soundBox.addEventListener('wheel', event => { event.preventDefault(); setVolume(volume + (event.deltaY < 0 ? 5 : -5)); }, { passive: false });
    soundBox.append(sound, level);
    clock = element('span', 'video-time'); clock.textContent = '0:00 / 0:00';
    row.append(play, soundBox, clock);
    controls.append(timeline, row);

    // The strip under the panel: a press that misses a control by a few pixels must not
    // close the viewer or pause the video.
    guard = element('div', 'video-guard');
    flash = element('div', 'video-flash'); flash.setAttribute('aria-hidden', 'true'); flash.innerHTML = svg(ICON_PLAY + ICON_PAUSE);
    const rootNode = viewer();
    rootNode.append(guard, controls, flash);
    rootNode.classList.add('has-video');
    paint();
    const opening = generation;
    Promise.resolve(api.videoCommand({ action: 'open', index, generation })).then(result => {
      if (generation !== opening) return;
      if (!result?.ok) error();
      // The decoder starts at full volume. Ask for the remembered level before the first
      // sound; if the decoder was not ready to listen, the first report asks again.
      else if (volume !== 100 && !failed) sendVolume();
    }).catch(() => { if (generation === opening) error(); });
  }
  window.addEventListener('beforeunload', () => stop(generation));
  return {
    show, stop,
    zoom(value) { if (canvas) canvas.style.transform = `translate(${value.x}px, ${value.y}px) scale(${value.scale})`; },
    // The picture itself: the viewer asks before treating a press as "close" or "fit".
    owns(target) { return live() && !!target && target === canvas; },
    click(target) {
      if (!this.owns(target)) return false;
      togglePlay(true); return true;
    },
    key(event) {
      if (!live() || event.ctrlKey || event.altKey || event.metaKey) return false;
      if (event.target?.closest?.('button,input,select,textarea') || document.querySelector('.lib-popup')) return false;
      const code = event.code;
      if (code === 'Space' || code === 'KeyK') togglePlay(true);
      else if (code === 'KeyM') toggleMute();
      else if (code === 'ArrowUp') setVolume(volume + 5);
      else if (code === 'ArrowDown') setVolume(volume - 5);
      else if (code === 'KeyJ') nudge(-10);
      else if (code === 'KeyL') nudge(10);
      else if (event.shiftKey && code === 'ArrowLeft') nudge(-5);
      else if (event.shiftKey && code === 'ArrowRight') nudge(5);
      else if (code === 'Home') seekTo(0, true);
      else if (!event.shiftKey && /^Digit\d$/.test(code)) seekTo(duration * Number(code.slice(5)) / 10, true);
      else return false;
      event.preventDefault(); return true;
    },
    external() { return command('external'); },
  };
}));
