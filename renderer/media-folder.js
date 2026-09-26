'use strict';

// DATA-006 step 3. The visible half of moving the folder Znada keeps its own copies in.
//
// One window for all three states, by the owner's decision (2026-09-09): ask before
// starting, show the work while it runs, say how it ended. It cannot be hidden while the
// move is under way — a person who wanders off into the library mid-move would be editing
// exactly what is being rewritten — but "Stop" is always there, because a stalled network
// drive must never turn the window into a trap.
//
// The window is an EXPLANATION, not the protection. What actually stops library edits is
// the main process (see LIBRARY_EDIT_CHANNELS in main.js): a modal cannot stop the tray,
// a hotkey or a second window, and a restart mid-move would drop a window-side guard
// entirely.
//
// What to show is decided in pure functions here and tested without a DOM. The drawing
// underneath them does nothing but put those answers on screen.

(function initMediaFolder(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MediaFolder = api;
}(typeof window !== 'undefined' ? window : globalThis, function mediaFolderFactory() {
  const BLOCKER_KEYS = {
    nested: 'mediaFolder.blockedNested',
    'no-space': 'mediaFolder.blockedNoSpace',
    'source-missing': 'mediaFolder.blockedSourceMissing',
    'destination-missing': 'mediaFolder.blockedDestinationMissing',
    system: 'mediaFolder.blockedSystem',
    profile: 'mediaFolder.blockedProfile',
    relative: 'mediaFolder.blockedRelative',
    'library-degraded': 'mediaFolder.blockedDegraded',
    'source-invalid': 'mediaFolder.blockedSourceInvalid',
  };

  const PHASE_KEYS = {
    copying: 'mediaFolder.phaseCopying',
    committing: 'mediaFolder.phaseCommitting',
    cleaning: 'mediaFolder.phaseCleaning',
    done: 'mediaFolder.phaseCleaning',
  };

  // An unknown code must still say something true rather than nothing at all.
  function blockerKey(code) {
    return BLOCKER_KEYS[code] || 'mediaFolder.blockedRelative';
  }

  // The settings row: where the files are right now.
  function pathLabel(state) {
    if (!state || !state.custom) return { key: 'mediaFolder.inProfile', text: '' };
    return { key: '', text: String(state.root || state.folder || '') };
  }

  /**
   * The question the user is asked before anything moves: how much, where to, and what
   * stands in the way. `canStart` is false whenever there is a blocker, so a window that
   * forgets to check still cannot start an impossible move.
   */
  function confirmModel(plan, { removable = false } = {}) {
    const blockers = (plan && plan.blockers) || [];
    if (blockers.length) {
      return {
        canStart: false,
        blockers: blockers.map((blocker) => ({ key: blockerKey(blocker.code), params: blocker })),
        notes: [],
      };
    }
    const count = Number(plan && plan.count) || 0;
    const notes = [];
    // The count includes the sweeper's own recovery folder, which the library never shows.
    // Without this line 180 files for a library of six reads like a mistake (review of #34).
    const trash = Math.min(Number(plan && plan.trashCount) || 0, count);
    if (trash > 0) notes.push({ key: 'mediaFolder.confirmTrash', params: { trash } });
    if (plan && Number.isFinite(plan.free)) notes.push({ key: 'mediaFolder.confirmFree', params: { free: plan.free } });
    if (removable) notes.push({ key: 'mediaFolder.confirmRemovable', params: {} });
    return {
      canStart: true,
      // Nothing to carry is not an error: the setting still changes where new pictures go.
      bodyKey: count ? 'mediaFolder.confirmBody' : 'mediaFolder.confirmNothing',
      params: { count, bytes: Number(plan && plan.bytes) || 0, path: (plan && plan.to) || '' },
      blockers: [],
      notes,
    };
  }

  /** What the window shows while the work runs. */
  function progressModel(progress) {
    const total = Number(progress && progress.total) || 0;
    const done = Math.min(Number(progress && progress.done) || 0, total || Infinity);
    const bytesTotal = Number(progress && progress.bytesTotal) || 0;
    const bytesDone = Number(progress && progress.bytesDone) || 0;
    // Bytes make a smoother bar than file count when sizes differ wildly, which they do:
    // a folder of wallpapers is a few huge files among many small ones.
    const percent = bytesTotal > 0
      ? Math.max(0, Math.min(100, Math.round((bytesDone / bytesTotal) * 100)))
      : (total > 0 ? Math.round((done / total) * 100) : 0);
    return {
      phaseKey: PHASE_KEYS[progress && progress.phase] || 'mediaFolder.phaseCopying',
      countParams: { done, total },
      percent,
      // The commit is a single atomic write and the cleanup cannot be undone; offering
      // "Stop" there would be a button that lies.
      canStop: (progress && progress.phase) === 'copying',
    };
  }

  /** How it ended, in the user's terms. */
  function resultModel(report) {
    const status = (report && report.status) || 'failed';
    if (status === 'done') {
      const count = (report.copied || 0) + (report.alreadyThere || 0);
      const where = (report.folder && report.folder.root) || '';
      // BUG-050. A profile that never kept a picture of its own moves nothing, and
      // "0 files are now in … the old folder is cleared" would describe a move that did
      // not happen. What did happen: new pictures go to the new place.
      if (!count) {
        return { tone: 'done', titleKey: 'mediaFolder.doneNothingTitle', bodyKey: 'mediaFolder.doneNothingBody', params: { count, path: where }, blockers: [] };
      }
      return { tone: 'done', titleKey: 'mediaFolder.doneTitle', bodyKey: 'mediaFolder.doneBody', params: { count, path: where }, blockers: [] };
    }
    if (status === 'stopped') {
      return { tone: 'stopped', titleKey: 'mediaFolder.stoppedTitle', bodyKey: 'mediaFolder.stoppedBody', params: {}, blockers: [] };
    }
    if (status === 'blocked' || status === 'busy') {
      const blockers = status === 'busy'
        ? [{ key: 'mediaFolder.blockedBusy', params: {} }]
        : ((report && report.blockers) || []).map((blocker) => ({ key: blockerKey(blocker.code), params: blocker }));
      return { tone: 'blocked', titleKey: 'mediaFolder.failedTitle', bodyKey: '', params: {}, blockers };
    }
    return { tone: 'failed', titleKey: 'mediaFolder.failedTitle', bodyKey: 'mediaFolder.failedBody', params: {}, blockers: [] };
  }

  // --- drawing ------------------------------------------------------------------
  // Everything below only puts the answers above on screen. `deps` carries the window's
  // own helpers so this file needs nothing global: t, formatSize, api and toast.

  function createDialog(deps) {
    const { t } = deps;
    const backdrop = document.createElement('div');
    backdrop.className = 'lib-modal-backdrop';
    backdrop.id = 'mediaMoveBackdrop';

    const modal = document.createElement('div');
    modal.className = 'lib-modal media-move-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'mediaMoveTitle');
    modal.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'lib-modal-head';
    const title = document.createElement('strong');
    title.id = 'mediaMoveTitle';
    head.appendChild(title);

    const body = document.createElement('div');
    body.className = 'lib-modal-body media-move-body';
    const text = document.createElement('p');
    text.className = 'media-move-text';
    const notes = document.createElement('div');
    notes.className = 'media-move-notes';
    const bar = document.createElement('div');
    bar.className = 'media-move-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('div');
    fill.className = 'media-move-fill';
    bar.appendChild(fill);
    const count = document.createElement('p');
    count.className = 'media-move-count';
    body.append(text, notes, bar, count);

    const foot = document.createElement('div');
    foot.className = 'lib-modal-foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pill';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'pill suggested';
    confirm.textContent = t('mediaFolder.start');
    foot.append(cancel, confirm);

    modal.append(head, body, foot);
    backdrop.appendChild(modal);
    return { backdrop, modal, title, text, notes, bar, fill, count, cancel, confirm };
  }

  function renderNotes(container, list, deps) {
    container.textContent = '';
    for (const note of list) {
      const line = document.createElement('p');
      line.className = 'media-move-note';
      line.textContent = deps.t(note.key, noteParams(note.params, deps));
      container.appendChild(line);
    }
    container.hidden = !list.length;
  }

  function noteParams(params, deps) {
    const out = { ...(params || {}) };
    for (const key of ['free', 'needed', 'bytes', 'size']) {
      if (Number.isFinite(out[key])) out[key] = deps.formatSize(out[key]);
    }
    return out;
  }

  // Where the move goes: the folder the user picks, or — for the way back — the app's own
  // folder, named by its own word so that no picker answer can ever mean it.
  async function chooseTarget(deps) {
    if (deps.appFolder) return { appFolder: true };
    const picked = await deps.api.mediaFolderPick();
    if (!picked || picked.canceled || !picked.folder) {
      if (picked && picked.error) deps.toast(deps.t('mediaFolder.blockedBusy'));
      return null;
    }
    return picked.folder;
  }

  /**
   * The whole flow: pick a folder (or go back to the app's own), ask, move, report.
   * Returns once the window is on screen, or null when nothing was picked; the window
   * then runs on its own until the user closes it.
   *
   * `deps`: { t, formatSize, api, toast, onState, appFolder }
   */
  async function openMoveDialog(deps) {
    const target = await chooseTarget(deps);
    if (!target) return null;
    const plan = await deps.api.mediaFolderPlan(target);
    const ui = createDialog(deps);
    document.body.appendChild(ui.backdrop);
    ui.modal.focus();

    let running = false;
    let finished = null;
    // Set once the window listens for progress. Every way out drops it — Cancel, Esc and
    // a click outside included — not only a finished move: a window closed without
    // moving used to leave its listener behind for good (release gate 1.7.6).
    let offProgress = null;
    const stopListening = () => {
      if (typeof offProgress === 'function') offProgress();
      offProgress = null;
    };

    const close = () => {
      if (running) return;              // the window cannot be dismissed mid-move
      if (ui.backdrop.isConnected) ui.backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      stopListening();
    };
    const onKey = (event) => {
      if (event.key === 'Escape' && !running) { event.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    ui.backdrop.addEventListener('mousedown', (event) => { if (event.target === ui.backdrop) close(); });

    const showConfirm = () => {
      const model = confirmModel(plan);
      ui.title.textContent = deps.t('mediaFolder.confirmTitle');
      ui.bar.hidden = true;
      ui.count.hidden = true;
      ui.text.textContent = model.canStart
        ? deps.t(model.bodyKey, {
          count: model.params.count,
          size: deps.formatSize(model.params.bytes),
          path: model.params.path,
        })
        : '';
      renderNotes(ui.notes, model.canStart ? model.notes : model.blockers, deps);
      ui.cancel.textContent = deps.t('mediaFolder.cancel');
      ui.confirm.hidden = !model.canStart;
      ui.confirm.textContent = deps.t('mediaFolder.start');
    };

    const showProgress = (progress) => {
      const model = progressModel(progress);
      ui.title.textContent = deps.t('mediaFolder.progressTitle');
      ui.text.textContent = deps.t(model.phaseKey);
      renderNotes(ui.notes, [{ key: 'mediaFolder.dontClose', params: {} }], deps);
      ui.bar.hidden = false;
      ui.bar.setAttribute('aria-valuenow', String(model.percent));
      ui.fill.style.width = `${model.percent}%`;
      ui.count.hidden = false;
      ui.count.textContent = deps.t('mediaFolder.progressCount', model.countParams);
      ui.confirm.hidden = true;
      ui.cancel.textContent = deps.t('mediaFolder.stop');
      ui.cancel.disabled = !model.canStop;
    };

    const showResult = (report) => {
      const model = resultModel(report);
      ui.title.textContent = deps.t(model.titleKey);
      ui.bar.hidden = true;
      ui.count.hidden = true;
      ui.text.textContent = model.bodyKey
        ? deps.t(model.bodyKey, { count: model.params.count, path: model.params.path })
        : '';
      renderNotes(ui.notes, model.blockers, deps);
      ui.confirm.hidden = true;
      ui.cancel.disabled = false;
      ui.cancel.textContent = deps.t('mediaFolder.close');
    };

    offProgress = deps.api.onMediaMoveProgress((progress) => {
      if (!running || !progress || progress.phase === 'finished') return;
      showProgress(progress);
    });

    ui.cancel.addEventListener('click', async () => {
      if (running) {
        ui.cancel.disabled = true;
        ui.cancel.textContent = deps.t('mediaFolder.stopping');
        await deps.api.mediaFolderStop();
        return;
      }
      close();
    });

    ui.confirm.addEventListener('click', async () => {
      running = true;
      showProgress({ phase: 'copying', done: 0, total: plan.count, bytesDone: 0, bytesTotal: plan.bytes });
      let report;
      try {
        report = await deps.api.mediaFolderMove(target);
      } catch (err) {
        report = { status: 'failed' };
      }
      running = false;
      finished = report;
      showResult(report);
      if (typeof deps.onState === 'function' && report && report.folder) deps.onState(report.folder);
      stopListening();
    });

    showConfirm();
    return { close: () => { running = false; close(); }, result: () => finished };
  }

  return { blockerKey, pathLabel, confirmModel, progressModel, resultModel, chooseTarget, openMoveDialog };
}));
