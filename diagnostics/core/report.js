'use strict';

// Pure report builders: raw events + meta → a summary object, a human-readable text
// block, and a self-contained HTML page. The centrepiece is the OVER-TIME trend — it
// compares the first third of the session with the last third for both smoothness and
// resource use, because "the longer it's open, the more it lags" is a growth signature,
// not a single slow render. Wording is split into facts / correlations / hypotheses so
// a correlation is never dressed up as a proven cause.

const stats = require('./stats');
const { buildTimelineSvg } = require('./svg-timeline');

const GROWTH_FLAG = 1.3; // a metric this many× larger late vs early counts as "grew"
const SMOOTH_FLAG = 1.5; // late frame gaps this many× the early ones = degraded over time

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function attr(e, key) {
  return e && e.attributes ? e.attributes[key] : undefined;
}

function durationOf(events, meta) {
  if (meta && Number.isFinite(meta.stoppedAtMs) && Number.isFinite(meta.startedAtMs)) {
    const d = meta.stoppedAtMs - meta.startedAtMs;
    if (d > 0) return d;
  }
  let max = 0;
  for (const e of events) max = Math.max(max, (e.timestampMs || 0) + (e.durationMs || 0));
  return Math.max(1, max);
}

// Mean of a metric over frame-window samples inside a [lo, hi) time window.
function windowMean(events, lo, hi, match, valueOf) {
  let sum = 0;
  let n = 0;
  for (const e of events) {
    const t = e.timestampMs || 0;
    if (t < lo || t >= hi) continue;
    if (!match(e)) continue;
    const v = valueOf(e);
    if (Number.isFinite(v)) { sum += v; n += 1; }
  }
  return n ? { mean: stats.round2(sum / n), samples: n } : { mean: null, samples: 0 };
}

function windowSum(events, lo, hi, match, valueOf) {
  let sum = 0;
  for (const e of events) {
    const t = e.timestampMs || 0;
    if (t < lo || t >= hi) continue;
    if (match(e)) { const v = valueOf(e); if (Number.isFinite(v)) sum += v; }
  }
  return sum;
}

// First and last value of a sampled metric (for cumulative-ish resources).
function firstLast(events, match, valueOf) {
  let first = null;
  let last = null;
  for (const e of events) {
    if (!match(e)) continue;
    const v = valueOf(e);
    if (!Number.isFinite(v)) continue;
    if (first === null) first = v;
    last = v;
  }
  return { first, last, growth: stats.growthRatio(first, last) };
}

function buildSummary(events = [], meta = {}) {
  const list = Array.isArray(events) ? events : [];
  const durationMs = durationOf(list, meta);
  const third = durationMs / 3;
  const isFrame = (e) => e.category === 'renderer' && e.name === 'frame-window';
  const isLoop = (e) => e.category === 'main' && e.name === 'event-loop';

  const frameMaxAll = list.filter(isFrame).map((e) => attr(e, 'maxMs')).filter(Number.isFinite);
  const longFramesTotal = list.filter(isFrame).reduce((a, e) => a + (Number(attr(e, 'longFrames')) || 0), 0);

  const frameEarly = windowMean(list, 0, third, isFrame, (e) => attr(e, 'maxMs'));
  const frameLate = windowMean(list, durationMs - third, durationMs + 1, isFrame, (e) => attr(e, 'maxMs'));
  const longEarly = windowSum(list, 0, third, isFrame, (e) => attr(e, 'longFrames'));
  const longLate = windowSum(list, durationMs - third, durationMs + 1, isFrame, (e) => attr(e, 'longFrames'));
  const smoothGrowth = stats.growthRatio(frameEarly.mean, frameLate.mean);
  const degradedOverTime = (Number.isFinite(smoothGrowth) && smoothGrowth >= SMOOTH_FLAG && frameLate.samples >= 2)
    || (longLate > longEarly * SMOOTH_FLAG && longLate >= 3);

  const loopEarly = windowMean(list, 0, third, isLoop, (e) => attr(e, 'maxMs'));
  const loopLate = windowMean(list, durationMs - third, durationMs + 1, isLoop, (e) => attr(e, 'maxMs'));

  const resources = {
    heapMB: firstLast(list, (e) => e.name === 'resources', (e) => attr(e, 'heapMB')),
    nodes: firstLast(list, (e) => e.name === 'resources', (e) => attr(e, 'nodes')),
    cards: firstLast(list, (e) => e.name === 'resources', (e) => attr(e, 'cards')),
    rendererMemMB: firstLast(list,
      (e) => e.category === 'process' && attr(e, 'role') === 'renderer-main',
      (e) => attr(e, 'memoryMB')),
  };
  const grew = Object.entries(resources)
    .filter(([, r]) => Number.isFinite(r.growth) && r.growth >= GROWTH_FLAG)
    .map(([k]) => k);

  const longTasks = list.filter((e) => e.name === 'long-task' && Number.isFinite(e.durationMs));
  const spanMap = new Map();
  for (const e of list) {
    if (e.kind !== 'span' || !Number.isFinite(e.durationMs)) continue;
    const key = `${e.category}/${e.name}`;
    if (!spanMap.has(key)) spanMap.set(key, []);
    spanMap.get(key).push(e.durationMs);
  }
  const spans = [...spanMap.entries()].map(([key, durs]) => {
    const s = stats.summarize(durs);
    return { name: key, count: s.count, p50: s.p50, p95: s.p95, max: s.max };
  }).sort((a, b) => (b.max || 0) - (a.max || 0));

  const marks = list.filter((e) => e.kind === 'mark').map((e) => {
    const lo = Number(attr(e, 'windowStartMs'));
    const hi = Number(attr(e, 'windowEndMs'));
    const from = Number.isFinite(lo) ? lo : (e.timestampMs || 0) - 3000;
    const to = Number.isFinite(hi) ? hi : (e.timestampMs || 0);
    let worst = null;
    for (const f of list) {
      if (!isFrame(f)) continue;
      const t = f.timestampMs || 0;
      if (t < from - 500 || t > to + 500) continue;
      const v = attr(f, 'maxMs');
      if (Number.isFinite(v) && (worst === null || v > worst)) worst = v;
    }
    return { atMs: e.timestampMs || 0, label: attr(e, 'label') || 'lag', worstFrameNearbyMs: worst };
  });

  const facts = [];
  facts.push(`Сессия ${Math.round(durationMs / 1000)} сек, событий ${list.length}.`);
  if (frameMaxAll.length) {
    const s = stats.summarize(frameMaxAll);
    facts.push(`Плавность (renderer frame gap): p95 ${s.p95} ms, max ${s.max} ms; длинных кадров (>50ms) ${longFramesTotal}.`);
  } else {
    facts.push('Данных о плавности (frame gap) в этой записи нет — окно, вероятно, было свёрнуто/скрыто.');
  }
  if (loopLate.mean !== null || loopEarly.mean !== null) {
    facts.push(`Event-loop main: рано ~${loopEarly.mean} ms, поздно ~${loopLate.mean} ms (worst per sample).`);
  }
  for (const [k, r] of Object.entries(resources)) {
    if (Number.isFinite(r.first) && Number.isFinite(r.last)) {
      facts.push(`${k}: ${r.first} → ${r.last} (×${r.growth ?? '—'} за сессию).`);
    }
  }

  const correlations = [];
  if (degradedOverTime && grew.length) {
    correlations.push(`Плавность ухудшалась к концу сессии (frame gap ×${smoothGrowth ?? '—'}), и ОДНОВРЕМЕННО росли: ${grew.join(', ')}.`);
  } else if (degradedOverTime) {
    correlations.push(`Плавность ухудшалась к концу (frame gap ×${smoothGrowth ?? '—'}), но заметного роста памяти/DOM в этой записи не зафиксировано.`);
  } else if (grew.length) {
    correlations.push(`Память/DOM росли (${grew.join(', ')}), но явной деградации плавности в этой записи не видно.`);
  }

  const hypotheses = [];
  if (degradedOverTime && grew.length) {
    hypotheses.push(`ГИПОТЕЗА (требует подтверждения): постепенное накопление/утечка — «${grew.join(', ')}» растёт со временем, а плавность падает. Типичные причины: не снимаемые обработчики событий/наблюдатели (IntersectionObserver, resize/scroll), неограниченно растущий DOM при подгрузке, растущий кэш миниатюр. Следующий шаг — сопоставить рост с конкретным действием (скролл большой папки) и проверить снятие слушателей при ре-рендере.`);
  } else if (degradedOverTime) {
    hypotheses.push('ГИПОТЕЗА: деградация во времени есть, но без роста памяти/DOM в этой записи — возможно, дело в накоплении таймеров/повторной подписке или во внешней нагрузке. Записать дольше и повторить.');
  } else if (!frameMaxAll.length) {
    hypotheses.push('Плавность не измерена (окно было скрыто). Для замера лагов запись должна идти при видимом окне и активной прокрутке.');
  } else {
    hypotheses.push('Явной деградации во времени в этой записи не видно. Если лаг был — записать дольше и активнее (прокрутка большой папки до низа).');
  }

  return {
    session: {
      id: meta.sessionId || '',
      durationMs,
      startedAtIso: meta.startedAtIso || '',
      state: meta.state || '',
      degradedReason: meta.degradedReason || '',
    },
    smoothness: {
      overall: stats.summarize(frameMaxAll),
      longFramesTotal,
      early: { meanMaxMs: frameEarly.mean, longFrames: longEarly, samples: frameEarly.samples },
      late: { meanMaxMs: frameLate.mean, longFrames: longLate, samples: frameLate.samples },
      growth: smoothGrowth,
      degradedOverTime,
    },
    mainLoop: { early: loopEarly.mean, late: loopLate.mean },
    resources,
    resourcesGrew: grew,
    longTasks: {
      count: longTasks.length,
      totalMs: stats.round2(stats.sum(longTasks.map((e) => e.durationMs))),
      max: longTasks.length ? stats.round2(Math.max(...longTasks.map((e) => e.durationMs))) : null,
    },
    spans,
    marks,
    writer: meta.writer || null,
    facts,
    correlations,
    hypotheses,
  };
}

function renderHumanText(summary) {
  const lines = [];
  lines.push(`Znada Diagnostics — сессия ${summary.session.id}`);
  lines.push('');
  lines.push('ЧТО ВИДНО:');
  for (const f of summary.facts) lines.push('  • ' + f);
  if (summary.correlations.length) {
    lines.push('');
    lines.push('СВЯЗИ:');
    for (const c of summary.correlations) lines.push('  • ' + c);
  }
  lines.push('');
  lines.push('ГИПОТЕЗЫ:');
  for (const h of summary.hypotheses) lines.push('  • ' + h);
  if (summary.marks.length) {
    lines.push('');
    lines.push('РУЧНЫЕ МЕТКИ «лагнуло»:');
    for (const m of summary.marks) lines.push(`  • на ${Math.round(m.atMs / 1000)}s — worst frame рядом ${m.worstFrameNearbyMs ?? '—'} ms`);
  }
  return lines.join('\n');
}

function rows(pairs) {
  return pairs.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v == null ? '—' : v)}</td></tr>`).join('');
}

function renderSummaryHtml(summary, events = [], meta = {}) {
  const svg = buildTimelineSvg(events, { durationMs: summary.session.durationMs });
  const sm = summary.smoothness;
  const res = summary.resources;
  const spanRows = summary.spans.map((s) =>
    `<tr><td>${esc(s.name)}</td><td>${s.count}</td><td>${s.p50 ?? '—'}</td><td>${s.p95 ?? '—'}</td><td>${s.max ?? '—'}</td></tr>`).join('') || '<tr><td colspan="5">нет spans</td></tr>';
  const resRows = Object.entries(res).map(([k, r]) =>
    `<tr><td>${esc(k)}</td><td>${r.first ?? '—'}</td><td>${r.last ?? '—'}</td><td>${r.growth == null ? '—' : '×' + r.growth}</td></tr>`).join('');
  const markRows = summary.marks.map((m) =>
    `<tr><td>${Math.round(m.atMs / 1000)}s</td><td>${esc(m.label)}</td><td>${m.worstFrameNearbyMs ?? '—'} ms</td></tr>`).join('') || '<tr><td colspan="3">меток нет</td></tr>';
  const verdict = sm.degradedOverTime
    ? '<span class="bad">Плавность ухудшалась к концу сессии</span>'
    : '<span class="ok">Явной деградации во времени не видно</span>';
  const warn = summary.session.state === 'degraded' || (summary.writer && summary.writer.degraded)
    ? `<p class="warn">⚠ Запись неполная (degraded${summary.session.degradedReason ? ': ' + esc(summary.session.degradedReason) : ''}). Часть событий могла быть отброшена.</p>`
    : '';

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Znada Diagnostics — ${esc(summary.session.id)}</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:20px;background:#1b1b1b;color:#e6e6e6;font-family:system-ui,Segoe UI,sans-serif;font-size:14px;line-height:1.5}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px;color:#bcbcbc;text-transform:uppercase;letter-spacing:.04em}
.sub{color:#8a8a8a;font-size:12px;margin-bottom:16px}
.verdict{font-size:16px;margin:8px 0 4px}.ok{color:#33d17a}.bad{color:#ff7800}
.warn{color:#f5c211}
ul{margin:0;padding-left:18px}li{margin:4px 0}
.hyp li{color:#d7d7d7}
table{border-collapse:collapse;width:100%;max-width:760px;margin:6px 0}
td,th{border:1px solid #333;padding:4px 8px;text-align:left;font-variant-numeric:tabular-nums}
th{color:#9aa0a6;font-weight:600}
.scroll{overflow-x:auto;max-width:100%}
.mono{font-family:ui-monospace,Consolas,monospace}
</style></head><body>
<h1>Znada Diagnostics</h1>
<div class="sub mono">${esc(summary.session.id)} · ${Math.round(summary.session.durationMs / 1000)}s · ${esc(summary.session.startedAtIso)}</div>
<div class="verdict">${verdict}</div>
${warn}
<h2>Что видно (факты)</h2><ul>${summary.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
${summary.correlations.length ? `<h2>Связи</h2><ul>${summary.correlations.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
<h2>Гипотезы</h2><ul class="hyp">${summary.hypotheses.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>
<h2>Таймлайн</h2><div class="scroll">${svg}</div>
<h2>Плавность (frame gap, ms)</h2>
<table><tr><th>окно</th><th>mean maxMs</th><th>long frames</th><th>samples</th></tr>
<tr><td>рано (1/3)</td><td>${sm.early.meanMaxMs ?? '—'}</td><td>${sm.early.longFrames}</td><td>${sm.early.samples}</td></tr>
<tr><td>поздно (3/3)</td><td>${sm.late.meanMaxMs ?? '—'}</td><td>${sm.late.longFrames}</td><td>${sm.late.samples}</td></tr>
<tr><td>рост</td><td>${sm.growth == null ? '—' : '×' + sm.growth}</td><td>overall max ${sm.overall.max ?? '—'}</td><td>p95 ${sm.overall.p95 ?? '—'}</td></tr></table>
<h2>Ресурсы (рост за сессию)</h2>
<table><tr><th>метрика</th><th>начало</th><th>конец</th><th>рост</th></tr>${resRows}</table>
<h2>Действия (spans, ms)</h2>
<div class="scroll"><table><tr><th>span</th><th>count</th><th>p50</th><th>p95</th><th>max</th></tr>${spanRows}</table></div>
<h2>Ручные метки «лагнуло»</h2>
<table><tr><th>время</th><th>label</th><th>worst frame рядом</th></tr>${markRows}</table>
<h2>Длинные задачи</h2><ul><li>long-tasks: ${summary.longTasks.count}, сумма ${summary.longTasks.totalMs ?? '—'} ms, max ${summary.longTasks.max ?? '—'} ms</li></ul>
</body></html>`;
}

module.exports = {
  GROWTH_FLAG,
  SMOOTH_FLAG,
  buildSummary,
  renderHumanText,
  renderSummaryHtml,
};
