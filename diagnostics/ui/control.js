'use strict';

// Logic for the dev-only diagnostics control window. Polls status once a second (elapsed
// time + state only — deliberately no live FPS/charts, per the agreed design) and wires
// the buttons to the diagnostics IPC exposed on window.diag by control-preload.js.
//
// NB: window.diag is exposed by contextBridge as a NON-CONFIGURABLE global property, so a
// top-level `const diag` would throw "Identifier 'diag' has already been declared" and kill
// the whole script (buttons dead). Read it under a different local name.
const $ = (sel) => document.querySelector(sel);
const api = window.diag || null;

const el = {
  dot: $('#dot'), stateText: $('#stateText'), timer: $('#timer'),
  mark: $('#btnMark'), stop: $('#btnStop'), start: $('#btnStart'),
  testNotification: $('#btnTestNotification'), notificationStatus: $('#notificationStatus'),
  after: $('#after'), report: $('#btnReport'), folder: $('#btnFolder'),
  export: $('#btnExport'), clear: $('#btnClear'), warn: $('#warn'),
};

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function show(node, on) { if (node) node.classList.toggle('hidden', !on); }

function render(status) {
  const recording = status.state === 'recording';
  const degraded = status.state === 'degraded' || (status.writer && status.writer.degraded);

  el.dot.className = recording ? 'rec' : (degraded ? 'bad' : 'done');
  el.stateText.textContent = recording ? 'Идёт запись'
    : degraded ? 'Запись остановлена (неполная)'
    : status.state === 'complete' ? 'Запись остановлена' : 'Готово к записи';

  if (recording && Number.isFinite(status.startedAtMs)) {
    el.timer.textContent = fmtElapsed(Date.now() - status.startedAtMs);
  } else if (Number.isFinite(status.startedAtMs) && Number.isFinite(status.stoppedAtMs) && status.stoppedAtMs > 0) {
    el.timer.textContent = `длительность ${fmtElapsed(status.stoppedAtMs - status.startedAtMs)}`;
  } else {
    el.timer.textContent = '—';
  }

  show(el.mark, recording);
  show(el.stop, recording);
  show(el.start, !recording);
  show(el.after, !recording && !!status.sessionId);
  el.mark.disabled = !recording;

  const drops = status.writer && status.writer.dropped;
  if (degraded) {
    el.warn.textContent = `⚠ Запись неполная${status.degradedReason ? ' (' + status.degradedReason + ')' : ''}. Часть данных могла быть отброшена.`;
    show(el.warn, true);
  } else if (drops) {
    el.warn.textContent = `⚠ Отброшено событий: ${drops} (буфер был переполнен).`;
    show(el.warn, true);
  } else {
    show(el.warn, false);
  }
}

async function refresh() {
  if (!api) { el.stateText.textContent = 'Недоступно вне Electron'; return; }
  try { render(await api.status()); } catch { /* transient */ }
}

function bind(node, fn) {
  if (!node) return;
  node.addEventListener('click', async () => {
    if (!api) return;
    node.disabled = true;
    try { await fn(); } catch {}
    node.disabled = false;
    refresh();
  });
}

// Marking must feel instant and give a flash of confirmation.
if (el.mark && api) {
  el.mark.addEventListener('click', async () => {
    try { await api.mark('lag'); } catch {}
    const original = el.mark.textContent;
    el.mark.textContent = '✓ Помечено';
    setTimeout(() => { el.mark.textContent = original; }, 900);
  });
}

// Stop → build the report, then open it automatically so the user never has to hunt for
// the file. The manual "open report" button stays available too.
if (el.stop && api) {
  el.stop.addEventListener('click', async () => {
    el.stop.disabled = true;
    const original = el.stop.textContent;
    el.stop.textContent = 'Останавливаю…';
    try {
      await api.stop();
      await api.openReport();
    } catch {}
    el.stop.textContent = original;
    el.stop.disabled = false;
    refresh();
  });
}

bind(el.start, () => api.start());
if (el.testNotification && api) {
  el.testNotification.addEventListener('click', async () => {
    el.testNotification.disabled = true;
    try {
      const result = await api.testNotification();
      el.notificationStatus.textContent = result && result.ok
        ? '✓ Запрос отправлен Windows. Проверьте появившийся баннер.'
        : `⚠ Не удалось показать уведомление (${(result && result.reason) || 'unknown'}).`;
    } catch {
      el.notificationStatus.textContent = '⚠ IPC-проверка уведомления не сработала.';
    }
    el.testNotification.disabled = false;
  });
}
bind(el.report, () => api.openReport());
bind(el.folder, () => api.openFolder());
bind(el.export, () => api.exportSanitized());
bind(el.clear, () => api.clearSessions());

refresh();
setInterval(refresh, 1000);
console.log('[control] ready; diag=' + !!api);
