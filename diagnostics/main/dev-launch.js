'use strict';

// COLLAB-003. What a DEV or DIAG check window says about the code it runs, and the hour
// after which it closes on its own.
//
// This is not part of the profiler. It lives under diagnostics/ because that is the one
// directory every user package leaves out as a whole, and the package verifier already
// accepts a guarded require of it as a dev-only dependency. src/dev-launch-gate.js decides
// whether main.js may require this file at all; a packaged build never does.
//
// The owner's decisions behind it (COLLAB-003):
//  - the window has to say which code it runs: a change is looked at in DEV before it is
//    merged, and one revision must not be mistaken for another;
//  - it closes an hour after start, always. Not an idle timer, no warning, no extension, no
//    switch. Opening the window again does not restart the hour, and neither does a sleep.

const SESSION_LIMIT_MS = 60 * 60 * 1000;
// How often the hour is re-read while the app runs. The last wait is cut to what is left,
// so an awake machine closes on time; this only bounds how late it closes after a sleep
// that no 'resume' event reported.
const CHECK_EVERY_MS = 30 * 1000;
// The hour does not cut a library change in half: one already under way may finish.
// Bounded, so a change that never finishes cannot turn the hour into more.
const SETTLE_LIMIT_MS = 15 * 1000;
// A hung git must not hold the launch; past this the revision is simply unknown.
const GIT_TIMEOUT_MS = 5 * 1000;
const RENDERER_ARG = '--znada-dev-launch=';
const MODE_LABELS = Object.freeze({ dev: 'DEV', diag: 'DIAG' });
const BADGE_BRANCH_MAX = 32;
const TRAY_TOOLTIP_MAX = 127;   // what the Windows notification area shows of a tooltip

const UNKNOWN_REVISION = Object.freeze({ known: false, sha: '', branch: '', detached: false, dirty: false });

const REFUSAL_MESSAGES = Object.freeze({
  dev_without_profile: [
    'DEV-запуск задан (ZNADA_CLOUD=staging), но его профиль не указан (ZNADA_DEV_USER_DATA).',
    'Без него запуск открыл бы рабочий профиль %APPDATA%\\znada с настоящими данными.',
    'Запускайте DEV через Znada-DEV.bat или npm run dev:cloud.',
  ].join('\n'),
  diag_incomplete: [
    'DIAG-запуск задан наполовину: нужны и переменная ZNADA_DIAGNOSTICS=1, и аргумент --diagnostics.',
    'Без одного из них запуск стал бы обычным и открыл рабочий профиль %APPDATA%\\znada.',
    'Запускайте DIAG через Znada-DIAG.bat или npm run dev:diagnostics.',
  ].join('\n'),
  diag_without_profile: [
    'DIAG-запуск задан, но папку его профиля определить не удалось:',
    'нет ни ZNADA_DIAGNOSTICS_USER_DATA, ни LOCALAPPDATA.',
    'Запускайте DIAG через Znada-DIAG.bat или npm run dev:diagnostics.',
  ].join('\n'),
});

function refusalMessage(reason) {
  return REFUSAL_MESSAGES[reason] || `Проверочный запуск отклонён (${reason}).`;
}

// `git status --porcelain=v2 --branch` answers all three questions in one call: which
// commit, which branch, and whether the working copy still IS that commit. Every line that
// is not a header is a changed or untracked file — code that runs without being committed.
function parseRevision(text) {
  let sha = '';
  let branch = '';
  let detached = false;
  let dirty = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(oid)) sha = oid.toLowerCase();
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') detached = true;
      else branch = head;
    } else if (!line.startsWith('#')) {
      dirty = true;
    }
  }
  // Without a commit there is nothing to name, whatever else the output said.
  if (!sha) return { ...UNKNOWN_REVISION };
  return { known: true, sha, branch, detached, dirty };
}

// Read from the folder the running main.js was loaded from — that is the code on screen.
// `--no-optional-locks` keeps a status call from refreshing the index under another git
// command an agent may be running in the same working copy.
function readRevision({ root, execFileSync, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    const text = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRevision(text);
  } catch {
    return { ...UNKNOWN_REVISION };
  }
}

// Task ids are written into branch names by convention (claude/BUG-031-..., codex/<login>/LIB-009-...).
function taskFromBranch(branch) {
  const match = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9]*-\d+)(?![0-9])/.exec(String(branch || ''));
  return match ? match[1] : '';
}

function clip(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function describeLaunch({
  mode,
  userDataPath = '',
  revision = null,
  startedAt = Date.now(),
  limitMs = SESSION_LIMIT_MS,
} = {}) {
  const modeLabel = MODE_LABELS[mode];
  if (!modeLabel) throw new Error(`describeLaunch: unknown mode '${mode}'`);
  const rev = revision && revision.known ? revision : UNKNOWN_REVISION;
  const task = taskFromBranch(rev.branch);
  const where = task || (rev.detached ? 'без ветки' : clip(rev.branch, BADGE_BRANCH_MAX));

  const parts = [modeLabel];
  if (rev.known) {
    if (where) parts.push(where);
    parts.push(`${rev.sha.slice(0, 7)}${rev.dirty ? ' + правки' : ''}`);
  } else {
    parts.push('версия не определена');
  }
  const badgeText = parts.join(' · ');
  const closesAt = startedAt + limitMs;
  const details = [
    `Проверочный запуск Znada · ${modeLabel}`,
    rev.known ? `Коммит: ${rev.sha}` : 'Коммит: не удалось прочитать git',
    rev.known ? `Ветка: ${rev.detached ? 'без ветки (detached HEAD)' : (rev.branch || '—')}` : '',
    rev.dirty ? 'В рабочей копии есть незакоммиченные правки: запущенный код не совпадает с коммитом.' : '',
    `Профиль: ${userDataPath}`,
    `Запущен в ${formatClock(startedAt)}, закроется сам в ${formatClock(closesAt)}.`,
  ].filter(Boolean).join('\n');

  return {
    mode,
    modeLabel,
    task,
    branch: rev.branch,
    detached: rev.detached,
    sha: rev.sha,
    dirty: rev.dirty,
    known: rev.known,
    profilePath: userDataPath,
    startedAt,
    closesAt,
    badgeText,
    windowTitle: `Znada · ${badgeText}`,
    viewerTitle: `Znada Media Viewer · ${badgeText}`,
    trayTooltip: clip(`Znada · ${badgeText}`, TRAY_TOOLTIP_MAX),
    details,
  };
}

// What a second launch tells the running one through the single-instance lock. Only what
// the refusal shows: no path, nothing about the machine.
function identityOf(info) {
  return {
    mode: info.mode,
    known: !!info.known,
    sha: info.sha || '',
    dirty: !!info.dirty,
    badgeText: info.badgeText,
  };
}

// Whether a second launch carries the same code as this one. Unknown or uncommitted code on
// either side is never the same: a window must not vouch for code it cannot name.
function sameCode(info, other) {
  if (!info || !info.known || info.dirty) return false;
  if (!other || typeof other !== 'object') return false;
  return other.known === true && other.dirty === false && other.mode === info.mode && other.sha === info.sha;
}

// Printed by the SECOND launch, which cannot know what the running one carries: it only
// hands over its identity and closes. The running window decides and says it on screen.
function busyProfileMessage(info) {
  return [
    `Профиль ${info.profilePath} уже открыт работающей Znada, поэтому этот запуск (${info.badgeText}) закрывается.`,
    'Он передал ей свою подпись: при том же коде она просто покажет окно, при другом скажет об этом.',
  ].join('\n');
}

function busyProfileDialog(info, other) {
  const incoming = other && typeof other.badgeText === 'string' && other.badgeText
    ? clip(other.badgeText, 200)
    : 'код не назван (запуск без подписи)';
  return {
    type: 'warning',
    title: 'Znada: профиль уже занят',
    message: 'Этот профиль уже открыт другим кодом, поэтому второй запуск не открыт.',
    detail: [
      `Открыт сейчас: ${info.badgeText}`,
      `Пытался открыться: ${incoming}`,
      `Профиль: ${info.profilePath}`,
      'Чтобы посмотреть другой код, сначала закройте это окно: трей → «Выйти».',
    ].join('\n'),
    buttons: ['OK'],
    noLink: true,
  };
}

// The label travels to the page as a command-line argument of the renderer, which is how
// the diagnostics probe is switched on too. Encoded, because a branch may hold anything.
function rendererArg(info) {
  const label = {
    mode: info.mode,
    badgeText: info.badgeText,
    details: info.details,
    dirty: !!info.dirty,
    known: !!info.known,
  };
  return RENDERER_ARG + encodeURIComponent(JSON.stringify(label));
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  // Outside Electron — which here means only the node test suite loading main.js under a
  // stub — a pending check must not keep the test process alive. Inside Electron the app,
  // not the event loop, decides when the process ends, so the timer stays referenced.
  if (!process.versions.electron && handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

function defaultClearTimer(handle) {
  clearTimeout(handle);
}

function createSessionLimit({
  limitMs = SESSION_LIMIT_MS,
  checkEveryMs = CHECK_EVERY_MS,
  wallNow = () => Date.now(),
  monoNow = () => performance.now(),
  setTimer = defaultSetTimer,
  clearTimer = defaultClearTimer,
  onExpire,
} = {}) {
  if (typeof onExpire !== 'function') throw new TypeError('createSessionLimit: onExpire is required');
  const startedWall = wallNow();
  const startedMono = monoNow();
  let timer = null;
  let expired = false;
  let disposed = false;

  // Elapsed by BOTH clocks, and the larger one wins. The wall clock keeps running through a
  // sleep that a monotonic clock may not count; the monotonic clock does not move when the
  // wall clock is set back. Either alone could stretch the hour. Together they can only
  // close early, after the wall clock jumps forward — and early is allowed, later is not.
  const elapsed = () => Math.max(wallNow() - startedWall, monoNow() - startedMono);

  function disarm() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function arm() {
    disarm();
    if (expired || disposed) return;
    const left = limitMs - elapsed();
    timer = setTimer(check, Math.max(0, Math.min(left, checkEveryMs)));
  }

  function check() {
    if (expired || disposed) return false;
    if (elapsed() < limitMs) {
      arm();
      return false;
    }
    disarm();
    expired = true;
    try {
      onExpire();
    } catch (err) {
      console.error('[DEV] the hour ran out, but closing failed:', err);
    }
    return true;
  }

  const api = {
    // Arms the check. Calling it again changes nothing about when the hour ends.
    start() {
      arm();
      return api;
    },
    // Re-reads the clocks now; main calls it on resume from sleep.
    check,
    // The app is quitting by itself: nothing may fire after this.
    dispose() {
      disposed = true;
      disarm();
    },
    state: () => ({
      limitMs,
      startedAt: startedWall,
      deadline: startedWall + limitMs,
      expired,
      disposed,
      armed: timer !== null,
    }),
  };
  return api;
}

// Waits for `promise` to settle either way, or for `ms`, whichever comes first.
function settleWithin(promise, ms, { setTimer = defaultSetTimer, clearTimer = defaultClearTimer } = {}) {
  return new Promise((resolve) => {
    let handle = null;
    let done = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      if (handle !== null) clearTimer(handle);
      resolve(outcome);
    };
    handle = setTimer(() => finish('timeout'), ms);
    Promise.resolve(promise).then(() => finish('settled'), () => finish('settled'));
  });
}

module.exports = {
  SESSION_LIMIT_MS,
  CHECK_EVERY_MS,
  SETTLE_LIMIT_MS,
  RENDERER_ARG,
  refusalMessage,
  parseRevision,
  readRevision,
  taskFromBranch,
  describeLaunch,
  identityOf,
  sameCode,
  busyProfileMessage,
  busyProfileDialog,
  rendererArg,
  createSessionLimit,
  settleWithin,
};
